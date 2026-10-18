/**
 * Lifecycle integration informed by zixiao-labs/logos editor-keymap.ts.
 * Copyright (c) 2026 Zixiao Laboratories and Seohyun Lee. MIT.
 * See THIRD_PARTY_NOTICES.md for the pinned source and original license.
 */
import * as monaco from "monaco-editor";
import { HelixController, createSession } from "./controller.js";
import type { HelixBinding, HelixMode, HelixOptions, ModalUI } from "./types.js";

export type { CommandInfo, CommandArguments } from "./commands.js";
export type { ClipboardAdapter, HelixBinding, HelixMode, HelixOptions } from "./types.js";

const bindings = new WeakMap<monaco.editor.IStandaloneCodeEditor, HelixBinding>();

/** Attach Helix editing to an existing Monaco editor. Dispose before destroying the host UI. */
export function initHelixMode(
  editor: monaco.editor.IStandaloneCodeEditor,
  statusElement?: HTMLElement,
  options: HelixOptions = {},
): HelixBinding {
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
  let generation = 0;
  let constructing = 0;
  let initialNotification = false;
  let cancelPrompt: (() => void) | undefined;
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
  node.append(label, content, message);
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
  const ui: ModalUI = {
    mode(next, pending = "") {
      const changed = next !== mode;
      mode = next;
      commandKeys = pending;
      node.dataset.mode = next;
      label.textContent = next.toUpperCase();
      if (!cancelPrompt) content.textContent = pending;
      syncInput();
      // A reset is also the initial notification for the attached model.
      if (changed || !controller) {
        if (constructing) initialNotification = true;
        else emitMode(next);
      }
    },
    notify,
    error: report,
    command(value) {
      const command = value.trim();
      if (!command) return;
      if (/^\d+$/.test(command)) {
        const model = editor.getModel();
        if (!model) return;
        const lineNumber = Math.min(model.getLineCount(), Math.max(1, Number(command)));
        editor.setPosition({ lineNumber, column: 1 });
        editor.revealPositionInCenter({ lineNumber, column: 1 });
        return;
      }
      if (!options.onCommand) { notify(`No handler for :${command}`); return; }
      const current = generation;
      try {
        Promise.resolve(options.onCommand(command)).catch(error => {
          if (generation === current) report(error);
        });
      } catch (error) { report(error); }
    },
    prompt(prefix, submit, initial = "") {
      cancelPrompt?.();
      notify("");
      const current = generation;
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.setAttribute("aria-label", prefix === ":" ? "Helix command" : `Helix ${prefix}`);
      input.value = initial;
      const prefixNode = document.createElement("span");
      prefixNode.textContent = prefix;
      content.replaceChildren(prefixNode, input);
      let finished = false;
      const finish = (accept: boolean, focus: boolean) => {
        if (finished) return;
        finished = true;
        cancelPrompt = undefined;
        input.removeEventListener("keydown", keydown);
        input.removeEventListener("blur", blur);
        const value = input.value;
        content.textContent = commandKeys;
        if (disposed || generation !== current) return;
        if (focus) editor.focus();
        if (disposed || generation !== current) return;
        if (accept) {
          try { submit(value); } catch (error) { report(error); }
        }
      };
      const keydown = (event: KeyboardEvent) => {
        event.stopPropagation();
        if (event.isComposing) return;
        if (event.key === "Escape" || event.key === "Enter") {
          event.preventDefault();
          finish(event.key === "Enter", true);
        }
      };
      const blur = () => finish(false, false);
      cancelPrompt = () => finish(false, false);
      input.addEventListener("keydown", keydown);
      input.addEventListener("blur", blur);
      input.focus();
    },
  };

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
    cancelPrompt?.();
    controller?.dispose();
    controller = undefined;
    notify("");
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
    getMode: () => mode,
    execute: (id, args) => controller?.execute(id, args) ?? Promise.reject(new Error("No active model")),
    listCommands: () => controller?.listCommands() ?? [],
    cancel: () => { cancelPrompt?.(); controller?.cancel(); },
    onDidChangeMode(listener) {
      if (!disposed) listeners.add(listener);
      return { dispose: () => { listeners.delete(listener); } };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
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
