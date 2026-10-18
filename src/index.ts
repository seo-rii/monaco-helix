/**
 * Lifecycle integration informed by zixiao-labs/logos editor-keymap.ts.
 * Copyright (c) 2026 Zixiao Laboratories and Seohyun Lee. MIT.
 * See THIRD_PARTY_NOTICES.md for the pinned source and original license.
 */
import * as monaco from "monaco-editor";
import { HelixController, createSession } from "./controller.js";
import { createHostController, HOST_COMMAND_IDS } from "./host-controller.js";
import { createHostPicker } from "./picker.js";
import type { HelixBinding, HelixMode, HelixOptions, KeyHint, ModalUI } from "./types.js";
export { KeymapEngine, normalizeKey, decodeKeys, encodeKeys } from "./keymap.js";
export type { Keymaps, KeymapTree, KeymapUpdate, KeymapDiagnostic } from "./keymap.js";

export type { CommandInfo, CommandArguments } from "./commands.js";
export type { ClipboardAdapter, HelixBinding, HelixMode, HelixOptions } from "./types.js";
export { createWorkerSearchEngine, findSearchMatches, SearchHistory, SearchPreviewSession } from "./search.js";
export type { SearchConfiguration, SearchEngine, SearchOptions, SearchResult } from "./search.js";
export { MacroEngine, MacroError } from "./macros.js";
export type { MacroEvent, MacroOptions, MacroExecutionContext, MacroPlayOptions, MacroState } from "./macros.js";

const bindings = new WeakMap<monaco.editor.IStandaloneCodeEditor, HelixBinding>();

/** Attach Helix editing to an existing Monaco editor. Dispose before destroying the host UI. */
export function initHelixMode(
  editor: monaco.editor.IStandaloneCodeEditor,
  statusElement?: HTMLElement,
  options: HelixOptions = {},
): HelixBinding {
  options = { ...options };
  bindings.get(editor)?.dispose();
  const root = editor.getDomNode();
  if (!root) throw new Error("monaco-helix requires a mounted editor");
  const document = root.ownerDocument;
  const original = editor.getRawOptions();
  const defaults: monaco.editor.IEditorOptions = {
    cursorStyle: original.cursorStyle ?? "line",
    cursorBlinking: original.cursorBlinking ?? "blink",
    domReadOnly: original.domReadOnly ?? false,
    editContext: original.editContext ?? true,
  };
  const session = createSession();
  const listeners = new Set<(mode: HelixMode) => void>();
  let disposed = false;
  let mode: HelixMode = "normal";
  let controller: HelixController | undefined;
  let hostController: ReturnType<typeof createHostController> | undefined;
  let generation = 0;
  let constructing = 0;
  let initialNotification = false;
  let cancelPrompt: (() => void) | undefined;
  let activePrompt: { prefix: string; finish: (accept: boolean, focus: boolean, value?: string) => Promise<void> } | undefined;
  let commandKeys = "";
  const node = document.createElement("div");
  node.className = "monaco-helix-status";
  const label = document.createElement("span");
  label.dataset.role = "mode";
  const content = document.createElement("span");
  content.dataset.role = "command";
  const message = document.createElement("span");
  message.dataset.role = "message";
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  message.id = `monaco-helix-message-${editor.getId()}`;
  const hints = document.createElement("div");
  hints.className = "monaco-helix-hints";
  hints.dataset.role = "key-hints";
  hints.setAttribute("role", "region");
  hints.setAttribute("aria-label", "Available Helix commands");
  hints.hidden = true;
  let hintItems: KeyHint[] = [];
  const renderHints = () => { hints.hidden = !hintItems.length || !!activePrompt || !commandKeys; };
  node.append(label, content, message, hints);
  const widget: monaco.editor.IOverlayWidget = {
    getId: () => `monaco-helix.${editor.getId()}`,
    getDomNode: () => node,
    getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.BOTTOM_RIGHT_CORNER }),
  };
  if (statusElement) statusElement.append(node);
  else editor.addOverlayWidget(widget);

  const notify = (value: string) => { if (!disposed) message.textContent = value; };
  const report = (error: unknown) => {
    if (disposed) return;
    const normalized = error instanceof Error ? error : new Error(String(error));
    notify(normalized.message);
    try { options.onError?.(normalized); } catch { /* Host error handlers must not break editing. */ }
  };
  const syncInput = () => {
    if (disposed) return;
    const input = root.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    if (input) input.readOnly = mode !== "insert" || editor.getOption(monaco.editor.EditorOption.readOnly) || !!defaults.domReadOnly;
  };
  const emitMode = (next: HelixMode) => {
    const current = generation;
    try { options.onModeChange?.(next); } catch (error) { report(error); }
    for (const listener of [...listeners]) {
      // A host callback may switch models, dispose this binding or unsubscribe.
      if (disposed || generation !== current || mode !== next) break;
      if (listeners.has(listener)) {
        try { listener(next); } catch (error) { report(error); }
      }
    }
  };
  const runApplicationCommand = (value: string, signal?: AbortSignal): void | Promise<void> => {
    const command = value.trim();
    if (!command) return;
    if (/^\d+$/.test(command)) {
      const model = editor.getModel();
      if (!model) return;
      hostController?.record();
      const lineNumber = Math.min(model.getLineCount(), Math.max(1, Number(command)));
      editor.setPosition({ lineNumber, column: 1 });
      editor.revealPositionInCenter({ lineNumber, column: 1 });
      hostController?.record();
      return;
    }
    if (options.onCommand) return Promise.resolve(options.onCommand(command));
    if (options.host?.executeCommand) return hostController?.execute("host_command", { command }, signal);
    throw new Error(`No handler for :${command}`);
  };
  const ui: ModalUI = {
    mode(next, pending = "") {
      const changed = next !== mode;
      mode = next;
      commandKeys = pending;
      node.dataset.mode = next;
      label.textContent = next.toUpperCase();
      if (!cancelPrompt) content.textContent = pending;
      renderHints();
      syncInput();
      // A reset is also the initial notification for the attached model.
      if (changed || !controller) {
        if (constructing) initialNotification = true;
        else emitMode(next);
      }
    },
    notify,
    error: report,
    hostCommand(id, args, signal) {
      if (id === "host_command") return runApplicationCommand(String(args.command ?? ""), signal);
      if (!hostController) throw new Error("Host navigation is not initialized");
      return hostController.execute(id, args, signal);
    },
    recordJump: () => hostController?.record(),
    hints(items) {
      hintItems = [...items];
      const list = document.createElement("div");
      list.setAttribute("role", "list");
      for (const item of hintItems.slice(0, 100)) {
        const row = document.createElement("div");
        row.setAttribute("role", "listitem");
        const key = document.createElement("kbd");
        key.textContent = item.key;
        const description = document.createElement("span");
        description.textContent = item.description ?? item.command ?? "More commands";
        row.append(key, description);
        list.append(row);
      }
      if (hintItems.length > 100) {
        const remaining = document.createElement("div");
        remaining.textContent = `${hintItems.length - 100} more bindings`;
        list.append(remaining);
      }
      hints.replaceChildren(list);
      renderHints();
    },
    promptActive: () => !!activePrompt,
    async submitPrompt(value, prefix, cancel = false) {
      const prompt = activePrompt;
      if (!prompt) throw new Error("No active Helix prompt");
      if (prefix !== undefined && prefix !== prompt.prefix) throw new Error(`Expected ${prefix} prompt, got ${prompt.prefix}`);
      await prompt.finish(!cancel, true, value);
    },
    command: value => runApplicationCommand(value),
    prompt(prefix, submit, initial = "", config = {}) {
      cancelPrompt?.();
      notify("");
      const current = generation;
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.setAttribute("aria-label", prefix === ":" ? "Helix command" : `Helix ${prefix}`);
      input.setAttribute("aria-describedby", message.id);
      input.autocomplete = "off";
      input.value = initial;
      const prefixNode = document.createElement("span");
      prefixNode.textContent = prefix;
      content.replaceChildren(prefixNode, input);
      let finished = false;
      let composing = false;
      let previewTimer: ReturnType<typeof setTimeout> | undefined;
      let previewController: AbortController | undefined;
      const stopPreview = () => {
        if (previewTimer !== undefined) clearTimeout(previewTimer);
        previewTimer = undefined;
        previewController?.abort();
        previewController = undefined;
      };
      const fail = (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        if (!disposed && current === generation) report(error);
      };
      const preview = () => {
        stopPreview();
        if (!config.onChange || finished || composing) return;
        previewTimer = setTimeout(() => {
          previewTimer = undefined;
          if (finished || composing || disposed || generation !== current) return;
          const request = new AbortController();
          previewController = request;
          try {
            void Promise.resolve(config.onChange!(input.value, request.signal)).catch(error => {
              if (!request.signal.aborted && !finished) fail(error);
            });
          } catch (error) { if (!request.signal.aborted && !finished) fail(error); }
        }, 100);
      };
      const finish = async (accept: boolean, focus: boolean, override?: string) => {
        if (finished) return;
        finished = true;
        stopPreview();
        cancelPrompt = undefined;
        activePrompt = undefined;
        input.removeEventListener("keydown", keydown);
        input.removeEventListener("blur", blur);
        input.removeEventListener("input", change);
        input.removeEventListener("compositionstart", compositionStart);
        input.removeEventListener("compositionend", compositionEnd);
        const value = override ?? input.value;
        content.textContent = commandKeys;
        renderHints();
        if (disposed || generation !== current) return;
        if (focus) editor.focus();
        if (disposed || generation !== current) return;
        if (config.record !== false) ui.recordPrompt?.(value, prefix, !accept);
        try {
          if (accept) {
            config.history?.record(value);
            await submit(value);
          } else config.onCancel?.();
        } catch (error) {
          await ui.promptSettled?.(false, error);
          throw error;
        }
        if (disposed || generation !== current) return;
        await ui.promptSettled?.(accept);
      };
      const keydown = (event: KeyboardEvent) => {
        event.stopPropagation();
        if (event.isComposing || composing) return;
        if ((event.key === "ArrowUp" || event.key === "ArrowDown") && config.history) {
          event.preventDefault();
          input.value = (event.key === "ArrowUp" ? config.history.previous(input.value) : config.history.next()) ?? "";
          input.setSelectionRange(input.value.length, input.value.length);
          preview();
          return;
        }
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          void finish(event.key === "Enter", true).catch(fail);
        }
      };
      const blur = () => { void finish(false, false).catch(fail); };
      const change = (event: Event) => {
        if (composing || (event as InputEvent).isComposing) return;
        config.history?.reset();
        preview();
      };
      const compositionStart = () => { composing = true; stopPreview(); };
      const compositionEnd = () => { composing = false; preview(); };
      activePrompt = { prefix, finish };
      cancelPrompt = () => { void finish(false, false).catch(fail); };
      config.history?.reset();
      input.addEventListener("keydown", keydown);
      input.addEventListener("blur", blur);
      input.addEventListener("input", change);
      input.addEventListener("compositionstart", compositionStart);
      input.addEventListener("compositionend", compositionEnd);
      renderHints();
      input.focus();
      if (disposed || generation !== current) return;
      ui.promptOpened?.();
      if (initial) preview();
    },
  };
  hostController = createHostController(editor, options.host ?? {}, {
    pick: createHostPicker(ui, node, { isReplaying: () => session.macros.isPlaying }), notify,
  }, options.navigation);

  // EditContext can bypass textarea readOnly. Keep Monaco's supported textarea
  // path while modal editing is active, including on a model attached later.
  editor.updateOptions({ editContext: false });
  const guardInput = (event: Event) => {
    if (mode === "insert" && !editor.getOption(monaco.editor.EditorOption.readOnly) && !defaults.domReadOnly) return;
    const target = event.target as HTMLElement | null;
    if (!target?.classList?.contains("inputarea")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const name of ["beforeinput", "paste", "cut", "drop"]) root.addEventListener(name, guardInput, true);
  const reset = () => {
    if (disposed) return;
    const current = ++generation;
    hostController?.onModelChange();
    session.macros.cancel("model changed");
    session.macros.discard();
    cancelPrompt?.();
    controller?.dispose();
    controller = undefined;
    notify("");
    ui.hints?.([]);
    // Controllers are model-specific; pending promises cannot cross this boundary.
    let next: HelixController | undefined;
    constructing++;
    try {
      if (editor.getModel()) next = new HelixController(editor, ui, session, !!defaults.domReadOnly, options);
      else ui.mode("normal");
    } finally { constructing--; }
    if (disposed || generation !== current) { next?.dispose(false); return; }
    controller = next;
    syncInput();
    // Publish only after assignment: initial callbacks are allowed to call
    // setModel(), initHelixMode() or dispose() synchronously.
    if (!constructing && initialNotification) {
      initialNotification = false;
      emitMode(mode);
    }
  };
  const modelListener = editor.onDidChangeModel(reset);
  const configListener = editor.onDidChangeConfiguration(syncInput);
  let lifetime: monaco.IDisposable | undefined;
  const binding: HelixBinding = {
    macros: session.macros,
    getMode: () => mode,
    execute(id, args) {
      if (disposed) return Promise.reject(new DOMException("Binding disposed", "AbortError"));
      if ((HOST_COMMAND_IDS as readonly string[]).includes(id)) {
        try { return Promise.resolve(ui.hostCommand!(id, args ?? {})); }
        catch (error) { return Promise.reject(error); }
      }
      return controller?.execute(id, args) ?? Promise.reject(new Error("No active model"));
    },
    listCommands: () => controller?.listCommands() ?? [],
    cancel: () => { hostController?.cancel(); cancelPrompt?.(); controller?.cancel(); },
    feedKeys: (keys) => controller?.feedKeys(keys) ?? Promise.reject(new Error("No active model")),
    setKeymap(keymap) {
      const result = controller?.setKeymap(keymap) ?? {ok:false,diagnostics:[{severity:"error" as const,code:"no_model",path:"",message:"No active model"}]};
      if (result.ok) options.keymap = keymap;
      return result;
    },
    onDidChangeMode(listener) {
      if (!disposed) listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      session.macros.dispose();
      hostController?.dispose();
      generation++;
      modelListener.dispose();
      configListener.dispose();
      lifetime?.dispose();
      cancelPrompt?.();
      for (const name of ["beforeinput", "paste", "cut", "drop"]) root.removeEventListener(name, guardInput, true);
      if (!statusElement) editor.removeOverlayWidget(widget);
      node.remove();
      editor.updateOptions(defaults);
      const input = root.querySelector<HTMLTextAreaElement>("textarea.inputarea");
      if (input) input.readOnly = editor.getOption(monaco.editor.EditorOption.readOnly) || !!defaults.domReadOnly;
      // Collapse modal selections only after detaching and restoring options.
      // Host cursor listeners may synchronously switch models or attach again.
      controller?.dispose();
      controller = undefined;
      listeners.clear();
      if (bindings.get(editor) === binding) bindings.delete(editor);
    },
  };
  lifetime = editor.onDidDispose(() => binding.dispose());
  bindings.set(editor, binding);
  reset();
  return binding;
}
