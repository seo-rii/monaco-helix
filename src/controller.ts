/**
 * Adapted from zixiao-labs/logos (69e08e1397cd0831a624183c171f129c0e293f61).
 * Copyright (c) 2026 Zixiao Laboratories. MIT; see THIRD_PARTY_NOTICES.md.
 * Copyright (c) 2026 Seohyun Lee. MIT.
 */
import * as monaco from "monaco-editor";
import {
  characterSelection, cursorOf, moveSelection, nextChar, previousChar,
  regexSelections, selectionBounds, textObject, wordSelection,
  type HelixSelection,
} from "./selection.js";
import { CommandDispatcher, isCancellation } from "./commands.js";
import type { CommandArguments, CommandInfo } from "./commands.js";
import type { HelixOptions, HelixMode, ModalUI } from "./types.js";
import { surroundEdits, mergeSelections, mergeConsecutiveSelections } from "./editing.js";
import { decodeKeys, encodeKeys, KeymapEngine, KeymapError, keyFromEvent, normalizeKey } from "./keymap.js";
import type { KeyBinding, KeyEventLike, Keymaps, KeymapTree, KeymapUpdate } from "./keymap.js";
import type { KeyHint } from "./types.js";

interface InsertHistory {
  before: number;
  after: number;
  beforeSelections: HelixSelection[];
  afterSelections: HelixSelection[];
}
export function createSession() {
  return {
    registers: new Map<string, string[]>(),
    searchPattern: "",
    insertHistory: new WeakMap<monaco.editor.ITextModel, InsertHistory[]>(),
  };
}

type Session = ReturnType<typeof createSession>;

export class HelixController implements monaco.IDisposable {
  private dispatcher: CommandDispatcher;
  private keymap: KeymapEngine;
  private keyPrefix: string[] = [];
  private prefixMode: HelixMode | undefined;
  private prefixTimer: ReturnType<typeof setTimeout> | undefined;
  private commandWork: Promise<void> = Promise.resolve();
  private continuation: { commands: string[]; count: number; signal?: AbortSignal } | undefined;
  private keyMacroDepth = 0;
  private keyMacroSteps = 0;
  private clipboardWork: Promise<void> = Promise.resolve();
  private mode: HelixMode = "normal";
  private pending = "";
  private count = "";
  private register = '"';
  private changingSelection = false;
  private disposed = false;
  private revision = 0;
  private boundModel: monaco.editor.ITextModel;
  private subscriptions: monaco.IDisposable[] = [];
  private desiredColumns: number[] = [];
  private insertMarks: monaco.editor.IEditorDecorationsCollection;
  private cursorDecorations: monaco.editor.IEditorDecorationsCollection;
  private insertEntry = "i";
  private insertChanged = false;
  private insertVersion = 0;
  private insertSelections: HelixSelection[] = [];
  private historyQueue = Promise.resolve();
  private lastInsert: { entry: string; texts: string[] } | null = null;
  private lastFind: { command: string; character: string } | null = null;
  private textCache: { model: monaco.editor.ITextModel; value: string } | undefined;

  constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    private ui: ModalUI,
    private session: Session,
    private domReadOnly = false,
    private options: HelixOptions = {},
  ) {
    this.boundModel = editor.getModel()!;
    this.dispatcher = new CommandDispatcher(() => this.alive, () => this.readOnly);
    this.registerCommands();
    if (options.chordTimeoutMs !== undefined && (!Number.isFinite(options.chordTimeoutMs) || options.chordTimeoutMs < 0 || options.chordTimeoutMs > 60_000)) {
      throw new Error("chordTimeoutMs must be between 0 and 60000");
    }
    // Compile before subscriptions or decorations exist, so an invalid initial
    // map cannot leave an inaccessible, partially attached controller behind.
    this.keymap = new KeymapEngine(this.defaultKeymap(), { commands: this.listCommands().map(command => command.id) });
    const configured = this.keymap.replace(options.keymap ?? {});
    if (!configured.ok) throw new KeymapError(configured.diagnostics);
    this.insertMarks = editor.createDecorationsCollection();
    this.cursorDecorations = editor.createDecorationsCollection();
    this.subscriptions.push(
      editor.onKeyDown(event => {
        // Monaco may already have consumed Escape to dismiss a widget. It must
        // still leave Insert/Select and cancel incomplete Helix commands.
        if (event.browserEvent.isComposing) { this.clearKeyPrefix(true); return; }
        if (event.browserEvent.defaultPrevented && event.browserEvent.key !== "Escape") return;
        if (!this.alive || !editor.hasTextFocus()) return;
        try {
          if (event.browserEvent.key !== "Escape" && this.options.shouldHandleKey?.(event.browserEvent, this.mode) === false) return;
          const token = keyFromEvent(event.browserEvent);
          if (!token || !this.routeKey(token, event.browserEvent)) return;
        } catch (error) { this.ui.error(error); }
        event.preventDefault();
        event.stopPropagation();
      }),
      editor.onDidChangeCursorSelection(() => {
        this.revision++;
        if (!this.alive || this.changingSelection) return;
        this.desiredColumns = [];
        if (this.mode !== "insert") this.normalize();
      }),
      editor.onDidChangeModelContent(() => {
        this.textCache = undefined;
        if (this.mode === "insert") this.insertChanged = true;
        else if (this.alive) this.normalize();
      }),
    );
    const root = editor.getDomNode();
    if (root) {
      const flush = () => { if (this.mode === "insert") this.clearKeyPrefix(true); };
      root.addEventListener("compositionstart", flush, true);
      this.subscriptions.push({ dispose: () => root.removeEventListener("compositionstart", flush, true) });
    }
    this.setMode("normal");
    this.normalize();
  }

  private get alive() {
    return !this.disposed && !this.boundModel.isDisposed() && this.editor.getModel() === this.boundModel;
  }
  private get model() { return this.boundModel; }
  private get text() {
    const model = this.model;
    if (this.textCache?.model !== model) this.textCache = { model, value: model.getValue() };
    return this.textCache.value;
  }
  private get readOnly() { return this.domReadOnly || this.editor.getOption(monaco.editor.EditorOption.readOnly); }

  private ranges(): HelixSelection[] {
    return (this.editor.getSelections() ?? []).map(selection => ({
      anchor: this.model.getOffsetAt(selection.getSelectionStart()),
      head: this.model.getOffsetAt(selection.getPosition()),
    }));
  }

  private select(ranges: HelixSelection[], reveal = true) {
    if (!ranges.length || !this.alive) return;
    this.changingSelection = true;
    this.editor.setSelections(ranges.map(range => monaco.Selection.fromPositions(
      this.model.getPositionAt(range.anchor), this.model.getPositionAt(range.head),
    )));
    this.changingSelection = false;
    this.renderCursors();
    if (reveal) this.editor.revealPositionInCenterIfOutsideViewport(
      this.model.getPositionAt(cursorOf(this.text, ranges[0])),
    );
  }

  private normalize() {
    if (!this.alive) return;
    const text = this.text;
    this.select(this.ranges().map(range => range.anchor === range.head
      ? characterSelection(text, range.head) : range), false);
  }

  private setMode(mode: HelixMode) {
    if (mode !== this.mode) this.revision++;
    this.mode = mode;
    this.editor.updateOptions({
      cursorStyle: mode === "insert" ? "line" : "block",
      cursorBlinking: mode === "insert" ? "blink" : "solid",
      domReadOnly: this.readOnly || mode !== "insert",
    });
    this.editor.getDomNode()?.classList.toggle("monaco-helix-command", mode !== "insert");
    this.renderCursors();
    this.status();
  }

  private renderCursors() {
    if (this.mode === "insert") { this.cursorDecorations.clear(); return; }
    const text = this.text;
    this.cursorDecorations.set(this.ranges().map(range => {
      const offset = cursorOf(text, range);
      const position = this.model.getPositionAt(offset);
      const atEnd = position.column === this.model.getLineMaxColumn(position.lineNumber);
      return {
        range: monaco.Range.fromPositions(position, this.model.getPositionAt(atEnd ? offset : nextChar(text, offset))),
        options: {
          description: "helix-block-cursor",
          ...(atEnd ? { before: { content: " ", inlineClassName: "monaco-helix-cursor" } } : { inlineClassName: "monaco-helix-cursor" }),
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }));
  }

  private status() {
    if (!this.alive) return;
    this.ui.mode(this.mode, this.count + this.pending + encodeKeys(this.keyPrefix));
    this.ui.hints?.(this.keymapHints());
  }

  private writable() {
    if (!this.alive) return false;
    if (!this.readOnly) return true;
    this.ui.notify("Read-only editor");
    return false;
  }

  private action(id: string) { this.editor.trigger("helix", id, {}); }

  private edit(edits: { start: number; end: number; text: string }[], group = true, selectInserted = false) {
    if (!this.writable() || !edits.length) return;
    if (group) this.editor.pushUndoStop();
    this.changingSelection = true;
    this.editor.executeEdits("helix", edits.map(edit => ({
      range: monaco.Range.fromPositions(this.model.getPositionAt(edit.start), this.model.getPositionAt(edit.end)),
      text: edit.text,
      forceMoveMarkers: true,
    })), inverse => inverse.map(edit => selectInserted
      ? monaco.Selection.fromPositions(edit.range.getStartPosition(), edit.range.getEndPosition())
      : monaco.Selection.fromPositions(edit.range.getEndPosition())));
    this.changingSelection = false;
    if (group) this.editor.pushUndoStop();
    if (this.mode !== "insert") this.normalize();
  }

  private replace(texts: string[], group = true) {
    this.edit(this.ranges().map((range, index) => {
      const [start, end] = selectionBounds(range);
      return { start, end, text: texts[index % texts.length] ?? "" };
    }), group, this.mode !== "insert");
  }

  private yank() {
    const texts = this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      return this.text.slice(start, end);
    });
    this.session.registers.set(this.register, texts);
    if (this.register === "+" || this.register === "*") {
      const clipboard = this.options.clipboard ?? globalThis.navigator?.clipboard;
      if (!clipboard) this.ui.error(new Error("Clipboard is unavailable"));
      else this.clipboardWork = clipboard.writeText(texts.join("\n")).catch(error => {
        if (this.alive) this.ui.error(error);
      });
    }
    this.register = '"';
    return texts;
  }

  private paste(before: boolean, replace = false, count = 1) {
    if (!this.writable()) return;
    const register = this.register;
    this.register = '"';
    const perform = (texts: string[]) => {
      if (!this.alive || !texts.length || !this.writable()) return;
      if (replace) { this.replace(texts.map(text => text.repeat(count))); return; }
      const edits = this.ranges().map((range, index) => {
        const [start, end] = selectionBounds(range);
        const text = (texts[index % texts.length] ?? "").repeat(count);
        let point = before ? start : end;
        if (/\r?\n$/.test(text)) {
          const line = this.model.getPositionAt(before ? start : Math.max(start, previousChar(this.text, end))).lineNumber;
          point = before ? this.model.getOffsetAt({ lineNumber: line, column: 1 })
            : line < this.model.getLineCount() ? this.model.getOffsetAt({ lineNumber: line + 1, column: 1 }) : this.text.length;
          if (!before && line === this.model.getLineCount() && this.model.getLineContent(line)) {
            return { start: point, end: point, text: this.model.getEOL() + text.replace(/\r?\n$/, "") };
          }
        }
        return { start: point, end: point, text };
      });
      this.edit(edits, true, true);
    };
    if (register === "+" || register === "*") {
      const model = this.model;
      const version = model.getVersionId();
      const revision = this.revision;
      const clipboard = this.options.clipboard ?? globalThis.navigator?.clipboard;
      if (!clipboard) { this.ui.error(new Error("Clipboard is unavailable")); return; }
      return clipboard.readText().then(text => {
        // Identity, selection/mode revision and version are all significant:
        // two different models may have identical text, ranges and version IDs.
        if (this.alive && this.model === model && model.getVersionId() === version && this.revision === revision) perform([text]);
      }).catch(error => { if (this.alive) this.ui.error(error); });
    } else perform(this.session.registers.get(register) ?? []);
  }

  private enterInsert(entry: string, yank = true) {
    if (!this.writable()) return;
    this.editor.pushUndoStop();
    this.insertVersion = this.model.getAlternativeVersionId();
    this.insertSelections = this.ranges();
    this.insertEntry = entry;
    this.setMode("insert");
    if (entry === "c") { if (yank) this.yank(); this.replace([""], false); }
    else if (entry === "o" || entry === "O") {
      const seen = new Set<number>();
      const edits = this.ranges().flatMap(range => {
        const [from, to] = selectionBounds(range);
        const line = this.model.getPositionAt(entry === "O" ? from : previousChar(this.text, to)).lineNumber;
        if (seen.has(line)) return [];
        seen.add(line);
        const content = this.model.getLineContent(line);
        const indent = content.match(/^\s*/)?.[0] ?? "";
        const point = this.model.getOffsetAt({ lineNumber: line, column: entry === "O" ? 1 : content.length + 1 });
        return [{ start: point, end: point, text: entry === "O" ? indent + this.model.getEOL() : this.model.getEOL() + indent }];
      });
      this.edit(edits, false);
      if (entry === "O") this.select(this.ranges().map(range => {
        const position = this.model.getPositionAt(range.head);
        const line = Math.max(1, position.lineNumber - 1);
        const offset = this.model.getOffsetAt({ lineNumber: line, column: this.model.getLineMaxColumn(line) });
        return { anchor: offset, head: offset };
      }));
    } else {
      this.select(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        let offset = entry === "a" ? end : start;
        if (entry === "I" || entry === "A") {
          const line = this.model.getPositionAt(cursorOf(this.text, range)).lineNumber;
          offset = this.model.getOffsetAt({ lineNumber: line, column: entry === "I"
            ? this.model.getLineFirstNonWhitespaceColumn(line) || 1 : this.model.getLineMaxColumn(line) });
        }
        return { anchor: offset, head: offset };
      }));
    }
    this.insertChanged = entry === "c" || entry === "o" || entry === "O";
    this.insertMarks.set(this.ranges().map(range => ({
      range: monaco.Range.fromPositions(this.model.getPositionAt(range.head)),
      options: { description: "helix-insertion", stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    })));
  }

  private leaveInsert(record = true) {
    this.clearKeyPrefix(true);
    if (record && this.insertChanged) {
      this.lastInsert = { entry: this.insertEntry, texts: this.insertMarks.getRanges().map(range => this.model.getValueInRange(range)) };
    }
    this.insertMarks.clear();
    this.editor.pushUndoStop();
    const after = this.model.getAlternativeVersionId();
    this.setMode("normal");
    this.select(this.ranges().map(range => characterSelection(this.text,
      this.model.getPositionAt(range.head).column === 1 ? range.head : previousChar(this.text, range.head),
    )));
    if (after !== this.insertVersion) {
      const history = this.session.insertHistory.get(this.model) ?? [];
      history.push({ before: this.insertVersion, after, beforeSelections: this.insertSelections, afterSelections: this.ranges() });
      this.session.insertHistory.set(this.model, history.slice(-1000));
    }
    this.action("hideSuggestWidget");
  }

  private history(redo: boolean, count = 1) {
    if (!this.writable()) return;
    // Monaco inserts its own undo boundaries for whitespace, completion and
    // the first typed character after a change. A Helix insert session is one
    // modal history step, even when it spans several native undo elements.
    return this.historyQueue = this.historyQueue.then(async () => {
      for (let n = 0; n < count && this.alive; n++) {
        if (this.readOnly) return;
        this.editor.pushUndoStop();
        const version = this.model.getAlternativeVersionId();
        const history = this.session.insertHistory.get(this.model) ?? [];
        const group = [...history].reverse().find(item => (redo ? item.before : item.after) === version);
        const target = group && (redo ? group.after : group.before);
        const visited = new Set<number>();
        do {
          const before = this.model.getAlternativeVersionId();
          if (visited.has(before)) break;
          visited.add(before);
          this.action(redo ? "redo" : "undo");
          await Promise.resolve();
          if (!this.alive) return;
          if (this.model.getAlternativeVersionId() === before) break;
        } while (target !== undefined && this.model.getAlternativeVersionId() !== target);
        if (group && this.model.getAlternativeVersionId() === target) {
          this.select(redo ? group.afterSelections : group.beforeSelections);
        }
        this.normalize();
      }
    }).catch(error => { if (this.alive) this.ui.error(error); });
  }

  private move(key: string, count: number) {
    const text = this.text;
    const extend = this.mode === "select";
    const vertical = ["j", "k", "ArrowDown", "ArrowUp"].includes(key);
    this.select(this.ranges().map((range, index) => {
      if (/^[wbeWBE]$/.test(key)) return wordSelection(text, range, key, count, extend);
      let offset = cursorOf(text, range);
      const position = this.model.getPositionAt(offset);
      if (vertical) {
        const column = this.desiredColumns[index] ?? position.column;
        this.desiredColumns[index] = column;
        const line = Math.max(1, Math.min(this.model.getLineCount(), position.lineNumber + (key === "j" || key === "ArrowDown" ? count : -count)));
        offset = this.model.getOffsetAt({ lineNumber: line, column: Math.min(column, this.model.getLineMaxColumn(line)) });
      } else if (key === "Home" || key === "End") {
        offset = this.model.getOffsetAt({ lineNumber: position.lineNumber, column: key === "Home" ? 1 : this.model.getLineMaxColumn(position.lineNumber) });
      } else {
        for (let n = 0; n < count; n++) offset = key === "h" || key === "ArrowLeft" ? previousChar(text, offset) : nextChar(text, offset);
      }
      return moveSelection(text, range, offset, extend);
    }));
    if (!vertical) this.desiredColumns = [];
  }

  private lines(extend: boolean, count: number) {
    this.select(this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      const first = this.model.getPositionAt(start).lineNumber;
      let last = this.model.getPositionAt(Math.max(start, previousChar(this.text, end))).lineNumber;
      const fullEnd = last < this.model.getLineCount() ? this.model.getOffsetAt({ lineNumber: last + 1, column: 1 }) : this.text.length;
      if (extend && start === this.model.getOffsetAt({ lineNumber: first, column: 1 }) && end === fullEnd) last++;
      last = Math.min(this.model.getLineCount(), last + count - 1);
      return { anchor: this.model.getOffsetAt({ lineNumber: first, column: 1 }), head: last < this.model.getLineCount()
        ? this.model.getOffsetAt({ lineNumber: last + 1, column: 1 }) : this.text.length };
    }));
  }

  private find(command: string, character: string, count: number) {
    this.lastFind = { command, character };
    const forward = command === command.toLowerCase();
    const till = command.toLowerCase() === "t";
    const text = this.text;
    this.select(this.ranges().map(range => {
      const origin = cursorOf(text, range);
      let offset = origin;
      for (let n = 0; n < count; n++) {
        const found = forward ? text.indexOf(character, nextChar(text, offset)) : offset > 0 ? text.lastIndexOf(character, previousChar(text, offset)) : -1;
        if (found < 0) return range;
        offset = found;
      }
      if (till) offset = forward ? previousChar(text, offset) : nextChar(text, offset);
      return moveSelection(text, this.mode === "select" ? range : characterSelection(text, origin), offset, true);
    }));
  }

  private search(backwards: boolean, count = 1) {
    if (!this.session.searchPattern) return;
    try {
      const matches = regexSelections(this.text, [{ anchor: 0, head: this.text.length }], this.session.searchPattern, false);
      if (!matches.length) { this.ui.notify("No matches"); return; }
      const ranges = this.ranges();
      const next = ranges.map(range => {
        const cursor = cursorOf(this.text, range);
        let index = matches.findIndex(match => match.anchor > cursor);
        if (backwards) {
          const start = selectionBounds(range)[0];
          index = -1;
          for (let n = 0; n < matches.length && matches[n].anchor < start; n++) index = n;
        }
        if (index < 0) index = backwards ? matches.length - 1 : 0;
        index = ((index + (backwards ? -1 : 1) * (count - 1)) % matches.length + matches.length) % matches.length;
        return matches[index];
      });
      this.select(this.mode === "select" ? [...ranges, ...next] : next);
    } catch { this.ui.notify("Invalid regular expression"); }
  }

  private goto(key: string, count: number) {
    const actions: Record<string, string> = {
      d: "editor.action.revealDefinition", y: "editor.action.goToTypeDefinition",
      r: "editor.action.referenceSearch.trigger", i: "editor.action.goToImplementation",
    };
    if (actions[key]) { this.action(actions[key]); return; }
    if (!["g", "e", "h", "l", "s", "|"].includes(key)) return;
    this.select(this.ranges().map(range => {
      let { lineNumber, column } = this.model.getPositionAt(cursorOf(this.text, range));
      if (key === "g") { lineNumber = Math.min(count, this.model.getLineCount()); column = 1; }
      if (key === "e") { lineNumber = this.model.getLineCount(); column = 1; }
      if (key === "h") column = 1;
      if (key === "l") column = this.model.getLineMaxColumn(lineNumber);
      if (key === "s") column = this.model.getLineFirstNonWhitespaceColumn(lineNumber) || 1;
      if (key === "|") column = count;
      return moveSelection(this.text, range, this.model.getOffsetAt({ lineNumber, column }), this.mode === "select");
    }));
  }

  private regexPrompt(kind: string) {
    this.ui.prompt(kind, pattern => {
      try {
        if (kind === "s" || kind === "S") {
          const result = regexSelections(this.text, this.ranges(), pattern, kind === "S");
          if (result.length) this.select(result);
          else this.ui.notify("No matches");
        } else {
          const regex = new RegExp(pattern, "mu");
          const result = this.ranges().filter(range => {
            const [start, end] = selectionBounds(range);
            return regex.test(this.text.slice(start, end)) !== (kind === "Alt-K");
          });
          if (result.length) this.select(result);
          else this.ui.notify("No matches");
        }
      } catch { this.ui.notify("Invalid regular expression"); }
    });
  }

  execute(command: string, args: CommandArguments = {}, signal?: AbortSignal): Promise<void> {
    if (command.startsWith(":")) return this.execute("host_command", { ...args, command: command.slice(1) }, signal);
    return this.dispatcher.execute(command, { ...args, count: Math.max(1, Math.min(10000, Number(args.count) || 1)) }, signal);
  }
  listCommands(): CommandInfo[] { return this.dispatcher.list(); }
  setKeymap(keymap: Keymaps): KeymapUpdate {
    const result = this.keymap.replace(keymap);
    if (result.ok) {
      this.clearKeyPrefix(true);
      this.options.keymap = keymap;
      this.cancel();
    }
    return result;
  }
  /** Feed logical Helix tokens, using Monaco's supported typing commands in Insert. */
  async feedKey(key: string, signal?: AbortSignal): Promise<void> {
    if (!this.alive || signal?.aborted) throw new DOMException("Key input cancelled", "AbortError");
    const token = normalizeKey(key);
    const previous = this.commandWork;
    const handled = this.routeKey(token, undefined, signal);
    if (!handled && this.mode === "insert") this.insertUnbound(token);
    if (this.commandWork !== previous) await this.commandWork;
    await this.dispatcher.idle();
    if (!this.alive || signal?.aborted) throw new DOMException("Key input cancelled", "AbortError");
  }
  async feedKeys(keys: string, signal?: AbortSignal): Promise<void> {
    for (const key of decodeKeys(keys)) await this.feedKey(key, signal);
  }
  keymapHints(): KeyHint[] {
    const result = this.keymap.lookup(this.mode, this.keyPrefix);
    if (result.kind !== "pending") return [];
    const commands = new Map(this.listCommands().map(command => [command.id, command]));
    return result.next.map(key => {
      const binding = this.keymap.lookup(this.mode, [...this.keyPrefix, key]);
      if (binding.kind === "commands") {
        const id = binding.commands.join(", ");
        return { key, command: id, description: commands.get(binding.commands[0])?.description };
      }
      return { key, description: binding.kind === "pending" ? "More keys" : binding.kind === "macro" ? "Key macro" : binding.kind === "pass" ? "Pass through" : "Unbound" };
    });
  }
  cancel(): void {
    this.revision++;
    this.clearKeyPrefix(false);
    this.continuation = undefined;
    this.dispatcher.cancel();
    this.pending = this.count = "";
    this.status();
  }
  private dispatch(command: string, args: CommandArguments = {}): void {
    this.commandWork = this.execute(command, args);
    void this.commandWork.catch(error => { if (this.alive && !isCancellation(error)) this.ui.error(error); });
  }

  private clearKeyPrefix(flush: boolean): void {
    if (this.prefixTimer !== undefined) clearTimeout(this.prefixTimer);
    this.prefixTimer = undefined;
    const keys = this.keyPrefix;
    const insert = this.prefixMode === "insert";
    this.keyPrefix = [];
    this.prefixMode = undefined;
    if (flush && insert && this.alive && this.mode === "insert") for (const key of keys) this.insertUnbound(key);
  }

  private insertUnbound(key: string): void {
    if (!this.writable()) return;
    const input: Record<string, string> = { space: " ", ret: this.model.getEOL() };
    const actions: Record<string, string> = {
      tab: "tab", "S-tab": "outdent", backspace: "deleteLeft", del: "deleteRight",
      left: "cursorLeft", right: "cursorRight", up: "cursorUp", down: "cursorDown",
      home: "cursorHome", end: "cursorEnd", pageup: "cursorPageUp", pagedown: "cursorPageDown",
      "C-backspace": "deleteWordLeft", "A-backspace": "deleteWordLeft", "C-del": "deleteWordRight",
    };
    if (actions[key]) { this.action(actions[key]); return; }
    const text = input[key] ?? (nextChar(key, 0) === key.length && !key.includes("\n") ? key : undefined);
    if (text !== undefined) this.editor.trigger("helix", "type", { text });
  }

  private logicalEvent(token: string): KeyEventLike & { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean } {
    let value = token;
    const modifiers = new Set<string>();
    for (;;) {
      const separator = value.indexOf("-");
      const prefix = value.slice(0, separator);
      if (separator < 0 || !["C", "A", "S", "Cmd"].includes(prefix)) break;
      modifiers.add(prefix);
      value = value.slice(separator + 1);
    }
    const names: Record<string, string> = { esc: "Escape", ret: "Enter", space: " ", tab: "Tab", backspace: "Backspace", del: "Delete", ins: "Insert", left: "ArrowLeft", right: "ArrowRight", up: "ArrowUp", down: "ArrowDown", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", minus: "-" };
    let key = names[value] ?? (/^f\d+$/.test(value) ? value.toUpperCase() : value);
    if (modifiers.has("S") && /^[a-z]$/.test(key)) key = key.toUpperCase();
    const codes: Record<string, string> = { ";": "Semicolon", ":": "Semicolon", ".": "Period", "-": "Minus", "_": "Minus" };
    return {
      key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : codes[key] ?? key,
      ctrlKey: modifiers.has("C"), altKey: modifiers.has("A"), shiftKey: modifiers.has("S") || /^[A-Z]$/.test(key) || key === "_" || key === ":",
      metaKey: modifiers.has("Cmd"),
    };
  }

  private routeKey(token: string, event?: KeyboardEvent, signal?: AbortSignal): boolean {
    const logical = this.logicalEvent(token);
    if (token === "esc" || token === "C-[") {
      this.clearKeyPrefix(true);
      this.continuation = undefined;
      return this.keyLegacy(logical);
    }
    if (this.pending) {
      const handled = this.keyLegacy(event ?? logical);
      if (!this.pending && this.continuation) {
        const continuation = this.continuation;
        this.continuation = undefined;
        this.track(this.commandWork.then(() => this.runCommands(continuation.commands, continuation.count, continuation.signal)));
      }
      return handled;
    }
    if (this.prefixMode && this.prefixMode !== this.mode) this.clearKeyPrefix(false);
    const sequence = [...this.keyPrefix, token];
    const match = this.keymap.lookup(this.mode, sequence);
    if (match.kind === "pending") {
      this.keyPrefix = sequence;
      this.prefixMode = this.mode;
      if (this.prefixTimer !== undefined) clearTimeout(this.prefixTimer);
      if (this.mode === "insert") this.prefixTimer = setTimeout(() => {
        this.clearKeyPrefix(true);
        this.status();
      }, this.options.chordTimeoutMs ?? 500);
      this.status();
      return true;
    }
    if (match.kind === "unbound" && !match.explicit && this.keyPrefix.length) {
      const insert = this.prefixMode === "insert";
      this.clearKeyPrefix(insert);
      this.status();
      return insert ? this.routeKey(token, event, signal) : true;
    }
    this.clearKeyPrefix(false);
    if (match.kind === "pass") return false;
    if (match.kind === "unbound") {
      if (match.explicit) return this.mode !== "insert";
      return this.keyLegacy(event ?? logical);
    }
    const count = Math.max(1, Number(this.count) || 1);
    this.count = "";
    if (match.kind === "commands") {
      if (event && ["normal_mode", "select_mode", "insert_mode", "append_mode", "insert_at_line_start", "insert_at_line_end", "open_below", "open_above", "change_selection", "change_selection_noyank"].includes(match.commands[0])) {
        this.revision++;
        this.dispatcher.cancel();
      }
      this.track(this.runCommands(match.commands, count, signal));
    }
    else this.track(this.runKeyMacro(match.keys, signal));
    this.status();
    return true;
  }

  private track(work: Promise<void>): void {
    this.commandWork = work;
    void work.catch(error => { if (this.alive && !isCancellation(error)) this.ui.error(error); });
  }

  private async runCommands(commands: readonly string[], count: number, signal?: AbortSignal): Promise<void> {
    for (let index = 0; index < commands.length; index++) {
      if (!this.alive || signal?.aborted) throw new DOMException("Command sequence cancelled", "AbortError");
      await this.execute(commands[index], { count }, signal);
      if (this.pending && index < commands.length - 1) {
        this.continuation = { commands: commands.slice(index + 1), count, signal };
        return;
      }
    }
  }

  private async runKeyMacro(keys: readonly string[], signal?: AbortSignal): Promise<void> {
    if (this.keyMacroDepth >= 32) throw new Error("Key macro recursion exceeds 32 levels");
    const outer = this.keyMacroDepth++ === 0;
    if (outer) this.keyMacroSteps = 0;
    try {
      for (const key of keys) {
        if (++this.keyMacroSteps > 100_000) throw new Error("Key macro playback exceeds 100000 keys");
        if (this.keyMacroSteps % 128 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
        await this.feedKey(key, signal);
      }
    } finally { this.keyMacroDepth--; }
  }

  private defaultKeymap(): Keymaps {
    const normal: KeymapTree = {};
    const assign = (keys: string[], command: string) => {
      let current = normal;
      for (const key of keys.slice(0, -1)) {
        const branch = current[key];
        if (!branch || typeof branch !== "object" || Array.isArray(branch)) current[key] = {};
        current = current[key] as KeymapTree;
      }
      current[keys[keys.length - 1]] = command;
    };
    for (const command of this.listCommands()) for (const label of command.keys ?? []) {
      let keys: string[];
      if (label.startsWith("Space ")) keys = ["space", ...decodeKeys(label.slice(6))];
      else {
        try { keys = [normalizeKey(label)]; }
        catch { keys = decodeKeys(label); }
      }
      assign(keys, command.id);
    }
    const aliases: Record<string, string> = {
      left: "move_char_left", right: "move_char_right", down: "move_visual_line_down", up: "move_visual_line_up",
      "C-z": "undo", "C-S-z": "redo", "C-c": "toggle_comments", "C-b": "page_up", "C-f": "page_down",
      "C-u": "page_cursor_half_up", "C-d": "page_cursor_half_down", pageup: "page_up", pagedown: "page_down",
      "A-s": "split_selection_on_newline", "A-.": "repeat_last_motion",
      "(": "rotate_selections_backward", ")": "rotate_selections_forward", C: "copy_selection_on_next_line",
      ".": "repeat_insert", "~": "switch_case", "`": "switch_to_lowercase", _: "trim_selections",
      ">": "indent", "<": "unindent", "=": "format_selections", J: "join_selections",
      "/": "search", "?": "rsearch", "*": "search_selection_detect_word_boundaries", ":": "command_mode",
      r: "replace", G: "goto_line", '"': "select_register", esc: "normal_mode",
    };
    for (const [key, command] of Object.entries(aliases)) assign([normalizeKey(key)], command);
    for (const [key, command] of Object.entries({ h: "goto_line_start", l: "goto_line_end" })) assign(["g", key], command);
    for (const [key, command] of Object.entries({ i: "select_textobject_inner", a: "select_textobject_around", s: "surround_add", d: "surround_delete", r: "surround_replace", m: "match_brackets" })) assign(["m", key], command);
    for (const [key, command] of Object.entries({ y: "yank_to_clipboard", p: "paste_clipboard_after", P: "paste_clipboard_before", k: "hover", r: "rename_symbol", a: "code_action" })) assign(["space", key], command);
    return { normal, select: normal, insert: { esc: "normal_mode" } };
  }
  private registerCommands(): void {
    const add = (id: string, description: string, run: (args: CommandArguments) => void | Promise<void>, mutates = false, keys: string[] = []) =>
      this.dispatcher.register({ id, description, mutates, keys }, run);
    for (const [id, key] of Object.entries({ move_char_left: "h", move_char_right: "l", move_visual_line_down: "j", move_visual_line_up: "k", move_next_word_start: "w", move_prev_word_start: "b", move_next_word_end: "e", move_next_long_word_start: "W", move_prev_long_word_start: "B", move_next_long_word_end: "E", goto_line_start: "Home", goto_line_end: "End" }))
      add(id, id.replaceAll("_", " "), args => this.move(key, args.count!), false, [key]);
    for (const [id, key] of Object.entries({ insert_mode: "i", append_mode: "a", insert_at_line_start: "I", insert_at_line_end: "A", open_below: "o", open_above: "O", change_selection: "c" }))
      add(id, id.replaceAll("_", " "), () => this.enterInsert(key), true, [key]);
    add("normal_mode", "Return to Normal", () => {
      if (this.mode === "insert") this.leaveInsert(); else this.setMode("normal");
      this.pending = this.count = "";
    });
    add("select_mode", "Extend selections", () => {
      if (this.mode === "insert") this.leaveInsert();
      this.setMode(this.mode === "select" ? "normal" : "select");
    }, false, ["v"]);
    add("delete_selection", "Delete and yank selections", () => { this.yank(); this.replace([""]); }, true, ["d"]);
    add("yank", "Yank selections", () => { this.yank(); return this.clipboardWork; }, false, ["y"]);
    add("paste_after", "Paste after selections", args => this.paste(false, false, args.count), true, ["p"]);
    add("paste_before", "Paste before selections", args => this.paste(true, false, args.count), true, ["P"]);
    add("replace_with_yanked", "Replace with register", args => this.paste(false, true, args.count), true, ["R"]);
    add("select_register", "Choose register", args => {
      if (args.character === undefined) this.awaitCharacter('"', args.count!);
      else this.register = String(args.character);
    });
    add("yank_to_clipboard", "Yank to clipboard", () => { this.register = "+"; this.yank(); return this.clipboardWork; }, false, ["Space y"]);
    add("paste_clipboard_after", "Paste clipboard after", args => { this.register = "+"; return this.paste(false, false, args.count); }, true, ["Space p"]);
    add("paste_clipboard_before", "Paste clipboard before", args => { this.register = "+"; return this.paste(true, false, args.count); }, true, ["Space P"]);
    add("extend_line_below", "Select lines", args => this.lines(true, args.count!), false, ["x"]);
    add("extend_to_line_bounds", "Select line bounds", args => this.lines(false, args.count!), false, ["X"]);
    add("select_all", "Select document", () => this.select([{ anchor: 0, head: this.text.length }]), false, ["%"]);
    add("collapse_selection", "Collapse to cursor", () => this.select(this.ranges().map(range => characterSelection(this.text, cursorOf(this.text, range)))), false, [";"]);
    add("keep_primary_selection", "Keep primary selection", () => this.select(this.ranges().slice(0, 1)), false, [","]);
    add("flip_selections", "Reverse selections", () => this.select(this.ranges().map(range => ({ anchor: range.head, head: range.anchor }))), false, ["Alt-;"]);
    add("undo", "Undo", args => this.history(false, args.count), true, ["u"]);
    add("redo", "Redo", args => this.history(true, args.count), true, ["U"]);
    for (const [id, key] of Object.entries({ goto_file_start: "g", goto_last_line: "e", goto_first_nonwhitespace: "s", goto_column: "|", goto_definition: "d", goto_type_definition: "y", goto_reference: "r", goto_implementation: "i" }))
      add(id, id.replaceAll("_", " "), args => this.goto(key, args.count!), false, ["g" + key]);
    for (const [id, key] of Object.entries({ find_next_char: "f", find_till_char: "t", find_prev_char: "F", till_prev_char: "T" }))
      add(id, id.replaceAll("_", " "), args => {
        if (args.character === undefined) this.awaitCharacter(key, args.count!);
        else this.find(key, String(args.character), args.count!);
      }, false, [key]);
    add("select_textobject_inner", "Select inside object", args => {
      if (args.character === undefined) this.awaitCharacter("mi", args.count!);
      else this.select(this.ranges().map(range => textObject(this.text, range, String(args.character), false) ?? range));
    });
    add("select_textobject_around", "Select around object", args => {
      if (args.character === undefined) this.awaitCharacter("ma", args.count!);
      else this.select(this.ranges().map(range => textObject(this.text, range, String(args.character), true) ?? range));
    });
    add("search_next", "Next search match", args => this.search(false, args.count), false, ["n"]);
    add("search_prev", "Previous search match", args => this.search(true, args.count), false, ["N"]);
    add("select_regex", "Select regex matches", () => this.regexPrompt("s"), false, ["s"]);
    add("split_selection", "Split selections by regex", () => this.regexPrompt("S"), false, ["S"]);
    add("keep_selections", "Filter selections", () => this.regexPrompt("K"), false, ["K"]);
    for (const [id, action] of Object.entries({ indent: "editor.action.indentLines", unindent: "editor.action.outdentLines", format_selections: "editor.action.formatSelection", join_selections: "editor.action.joinLines", toggle_comments: "editor.action.commentLine", rename_symbol: "editor.action.rename" }))
      add(id, id.replaceAll("_", " "), () => this.action(action), true);
    for (const [id, action] of Object.entries({ hover: "editor.action.showHover", code_action: "editor.action.quickFix", match_brackets: "editor.action.jumpToBracket", page_up: "cursorPageUp", page_down: "cursorPageDown" }))
      add(id, id.replaceAll("_", " "), () => this.action(action));
    add("no_op", "Do nothing", () => {});
    add("delete_selection_noyank", "Delete without yanking", () => this.replace([""]), true, ["Alt-d"]);
    add("change_selection_noyank", "Change without yanking", () => this.enterInsert("c", false), true, ["Alt-c"]);
    add("surround_delete", "Remove surround", args => {
      if (args.character === undefined) this.awaitCharacter("md", args.count!);
      else this.edit(surroundEdits(this.text, this.ranges(), String(args.character)));
    }, true, ["md"]);
    add("surround_replace", "Replace surround", args => {
      if (args.character === undefined) this.awaitCharacter("mr", args.count!);
      else if (args.replacement === undefined) this.awaitCharacter("mr" + String(args.character), args.count!);
      else this.edit(surroundEdits(this.text, this.ranges(), String(args.character), String(args.replacement)));
    }, true, ["mr"]);
    add("merge_selections", "Merge selections", () => this.select(mergeSelections(this.ranges())), false, ["Alt-minus"]);
    add("merge_consecutive_selections", "Merge adjacent selections", () => this.select(mergeConsecutiveSelections(this.ranges())), false, ["Alt-_"]);
    add("remove_selections", "Remove regex matches", () => this.regexPrompt("Alt-K"), false, ["Alt-K"]);
    add("copy_selection_on_prev_line", "Add selection above", () => {
      this.select([...this.ranges(), ...this.ranges().flatMap(range => {
        const a = this.model.getPositionAt(range.anchor), b = this.model.getPositionAt(range.head);
        if (a.lineNumber === 1 || b.lineNumber === 1) return [];
        return [{anchor:this.model.getOffsetAt({lineNumber:a.lineNumber-1,column:a.column}),head:this.model.getOffsetAt({lineNumber:b.lineNumber-1,column:b.column})}];
      })]);
    }, false, ["Alt-C"]);
    add("copy_selection_on_next_line", "Add selection below", () => {
      this.select([...this.ranges(), ...this.ranges().flatMap(range => {
        const [start, end] = selectionBounds(range);
        const a = this.model.getPositionAt(start), b = this.model.getPositionAt(end);
        if (b.lineNumber >= this.model.getLineCount()) return [];
        return [{ anchor: this.model.getOffsetAt({ lineNumber: a.lineNumber + 1, column: a.column }), head: this.model.getOffsetAt({ lineNumber: b.lineNumber + 1, column: b.column }) }];
      })]);
    });
    add("rotate_selections_backward", "Previous primary selection", () => {
      const ranges = this.ranges();
      if (ranges.length) this.select([ranges[ranges.length - 1], ...ranges.slice(0, -1)]);
    });
    add("rotate_selections_forward", "Next primary selection", () => {
      const ranges = this.ranges();
      if (ranges.length) this.select([...ranges.slice(1), ranges[0]]);
    });
    add("split_selection_on_newline", "Split selections into lines", () => this.select(regexSelections(this.text, this.ranges(), "\\r?\\n", true)));
    add("repeat_last_motion", "Repeat the last character find", () => { if (this.lastFind) this.find(this.lastFind.command, this.lastFind.character, 1); });
    add("page_cursor_half_up", "Move half a page up", () => this.move("k", Math.max(1, Math.floor(this.editor.getLayoutInfo().height / this.editor.getOption(monaco.editor.EditorOption.lineHeight) / 2))));
    add("page_cursor_half_down", "Move half a page down", () => this.move("j", Math.max(1, Math.floor(this.editor.getLayoutInfo().height / this.editor.getOption(monaco.editor.EditorOption.lineHeight) / 2))));
    add("goto_line", "Go to line number", args => this.goto("g", args.count!));
    add("replace", "Replace selected characters", args => {
      if (args.character === undefined) this.awaitCharacter("r", args.count!);
      else this.replaceCharacters(String(args.character));
    }, true);
    add("surround_add", "Surround selections", args => {
      if (args.character === undefined) this.awaitCharacter("ms", args.count!);
      else this.addSurround(String(args.character));
    }, true);
    add("repeat_insert", "Repeat last insertion", args => {
      if (!this.lastInsert) return;
      const last = this.lastInsert;
      for (let n = 0; n < args.count! && this.alive; n++) {
        this.enterInsert(last.entry);
        this.replace(last.texts, false);
        this.leaveInsert(false);
      }
    }, true);
    add("switch_case", "Toggle selection case", () => this.replace(this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      return [...this.text.slice(start, end)].map(char => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join("");
    })), true);
    add("switch_to_lowercase", "Lowercase selections", () => this.replace(this.ranges().map(range => this.text.slice(...selectionBounds(range)).toLowerCase())), true);
    add("trim_selections", "Trim selection whitespace", () => this.select(this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      const value = this.text.slice(start, end);
      return value.trim() ? { anchor: start + value.length - value.trimStart().length, head: end - (value.length - value.trimEnd().length) } : range;
    })));
    for (const [id, backwards] of [["search", false], ["rsearch", true]] as const) add(id, "Search regular expression", args => {
      this.ui.prompt(backwards ? "?" : "/", pattern => {
        if (pattern) this.session.searchPattern = pattern;
        this.search(backwards, args.count);
      });
    });
    add("search_selection_detect_word_boundaries", "Search for the primary selection", () => {
      const range = this.ranges()[0];
      if (!range) return;
      const [start, end] = selectionBounds(range);
      this.session.searchPattern = this.text.slice(start, end).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (/\w/.test(this.text[start] ?? "") && !/\w/.test(this.text[start - 1] ?? "")) this.session.searchPattern = "\\b" + this.session.searchPattern;
      if (/\w/.test(this.text[end - 1] ?? "") && !/\w/.test(this.text[end] ?? "")) this.session.searchPattern += "\\b";
    });
    add("command_mode", "Open command prompt", () => this.ui.prompt(":", value => this.ui.command(value)));
    add("host_command", "Run a host application command", args => this.ui.command(String(args.command ?? "")));
  }

  private awaitCharacter(prefix: string, count: number): void {
    this.pending = prefix;
    this.count = count > 1 ? String(count) : "";
    this.status();
  }

  private replaceCharacters(character: string): void {
    if (!this.writable()) return;
    this.replace(this.ranges().map(range => {
      const [start, end] = selectionBounds(range);
      return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.text.slice(start, end)))
        .map(part => /\r?\n/.test(part.segment) ? part.segment : character === "Enter" ? this.model.getEOL() : character).join("");
    }));
  }

  private addSurround(character: string): void {
    if (!this.writable()) return;
    const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[character] ?? character;
    this.replace(this.ranges().map(range => character + this.text.slice(...selectionBounds(range)) + close));
  }

  private keyLegacy(event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey">): boolean {
    const key = event.key;
    if (event.metaKey || (event.ctrlKey && event.altKey)) return false;
    if (key === "Escape" || (event.ctrlKey && key === "[")) {
      // Escape cancels pending asynchronous work even when already in Normal.
      this.revision++;
      this.dispatcher.cancel();
      if (this.mode === "insert") this.leaveInsert();
      else this.setMode("normal");
      this.pending = this.count = "";
      this.register = '"';
      this.status();
      return true;
    }
    if (this.mode === "insert") return false;
    if (!this.pending && !event.ctrlKey && !event.altKey && ["i", "a", "I", "A", "o", "O", "c", "v"].includes(key)) {
      this.revision++;
      this.dispatcher.cancel();
    }
    if (event.ctrlKey) {
      if (key.toLowerCase() === "z") { this.history(event.shiftKey); return true; }
      const actions: Record<string, string> = { b: "cursorPageUp", f: "cursorPageDown", c: "editor.action.commentLine" };
      if (key === "u" || key === "d") {
        this.move(key === "u" ? "k" : "j", Math.max(1, Math.floor(this.editor.getLayoutInfo().height / this.editor.getOption(monaco.editor.EditorOption.lineHeight) / 2)));
        return true;
      }
      if (actions[key]) {
        if (key !== "c" || this.writable()) this.action(actions[key]);
        return true;
      }
      return key.toLowerCase() !== "s";
    }
    if (event.altKey) {
      const commands: Record<string,string> = { KeyD:"delete_selection_noyank", KeyC:event.shiftKey?"copy_selection_on_prev_line":"change_selection_noyank", KeyK:"remove_selections", Minus:event.shiftKey?"merge_consecutive_selections":"merge_selections" };
      if (commands[event.code]) { this.dispatch(commands[event.code]); return true; }
      if (event.code === "Semicolon") this.select(this.ranges().map(range => ({ anchor: range.head, head: range.anchor })));
      else if (event.code === "KeyS") this.select(regexSelections(this.text, this.ranges(), "\\r?\\n", true));
      else if (event.code === "Period" && this.lastFind) this.find(this.lastFind.command, this.lastFind.character, 1);
      else return true;
      return true;
    }
    if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(key)) return false;
    if (/^F\d+$/.test(key) && this.pending !== "r" && this.pending !== "ms") return false;
    if (!this.pending && /^\d$/.test(key)) {
      this.count = String(Math.min(10000, Number(this.count + key)));
      this.status();
      return true;
    }
    const count = Math.max(1, Number(this.count) || 1);
    if (this.pending) {
      const prefix = this.pending;
      this.pending = "";
      if ((["r", "ms", "f", "t", "F", "T"].includes(prefix)) && !(prefix === "r" && key === "Enter") && (!key || nextChar(key, 0) !== key.length)) {
        this.count = "";
        this.status();
        return true;
      }
      if (prefix === "m" && ["i", "a", "s", "d", "r"].includes(key)) this.pending = "m" + key;
      else if (prefix === "md") this.dispatch("surround_delete", {character:key});
      else if (prefix === "mr") this.pending = "mr" + key;
      else if (prefix.startsWith("mr") && prefix.length > 2) this.dispatch("surround_replace", {character:prefix.slice(2),replacement:key});
      else if (prefix === "g") {
        const ids: Record<string,string> = {g:"goto_file_start",e:"goto_last_line",s:"goto_first_nonwhitespace","|":"goto_column",d:"goto_definition",y:"goto_type_definition",r:"goto_reference",i:"goto_implementation",h:"goto_line_start",l:"goto_line_end"};
        if (ids[key]) this.dispatch(ids[key], {count});
      }
      else if (prefix === '"') this.dispatch("select_register", {character:key});
      else if (/^[ftFT]$/.test(prefix)) this.find(prefix, key, count);
      else if (prefix === "r") {
        if (this.writable()) this.replace(this.ranges().map(range => {
          const [start, end] = selectionBounds(range);
          return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(this.text.slice(start, end)))
            .map(part => /\r?\n/.test(part.segment) ? part.segment : key === "Enter" ? this.model.getEOL() : key).join("");
        }));
      } else if (prefix === "mi" || prefix === "ma") {
        this.select(this.ranges().map(range => textObject(this.text, range, key, prefix === "ma") ?? range));
      } else if (prefix === "ms" && this.writable()) {
        const close = ({ "(": ")", "[": "]", "{": "}", "<": ">" } as Record<string, string>)[key] ?? key;
        this.replace(this.ranges().map(range => {
          const [start, end] = selectionBounds(range);
          return key + this.text.slice(start, end) + close;
        }));
      } else if (prefix === "m" && key === "m") this.action("editor.action.jumpToBracket");
      else if (prefix === " ") {
        if (key === "y") this.dispatch("yank_to_clipboard");
        else if (key === "p" || key === "P") this.dispatch(key === "P" ? "paste_clipboard_before" : "paste_clipboard_after");
        else if (key === "k") this.action("editor.action.showHover");
        else if (key === "r" && this.writable()) this.action("editor.action.rename");
        else if (key === "a") this.action("editor.action.quickFix");
      }
      if (!this.pending) this.count = "";
      this.status();
      return true;
    }
    if (["g", "m", "f", "t", "F", "T", '"', "r", " "].includes(key)) {
      this.pending = key;
      this.status();
      return true;
    }
    this.count = "";
    if (["h", "j", "k", "l", "w", "e", "b", "W", "E", "B", "Home", "End", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) {
      const ids: Record<string,string> = { h:"move_char_left",ArrowLeft:"move_char_left",l:"move_char_right",ArrowRight:"move_char_right",j:"move_visual_line_down",ArrowDown:"move_visual_line_down",k:"move_visual_line_up",ArrowUp:"move_visual_line_up",w:"move_next_word_start",b:"move_prev_word_start",e:"move_next_word_end",W:"move_next_long_word_start",B:"move_prev_long_word_start",E:"move_next_long_word_end",Home:"goto_line_start",End:"goto_line_end" };
      this.dispatch(ids[key], {count});
    }
    else if (key === "v") this.setMode(this.mode === "select" ? "normal" : "select");
    else if (["i", "a", "I", "A", "o", "O", "c"].includes(key)) this.dispatch(({i:"insert_mode",a:"append_mode",I:"insert_at_line_start",A:"insert_at_line_end",o:"open_below",O:"open_above",c:"change_selection"} as Record<string,string>)[key]);
    else if (key === "d") this.dispatch("delete_selection");
    else if (key === "y") this.dispatch("yank");
    else if (key === "p" || key === "P" || key === "R") this.dispatch(key === "p" ? "paste_after" : key === "P" ? "paste_before" : "replace_with_yanked", {count});
    else if (key === "x" || key === "X") this.lines(key === "x", count);
    else if (key === "%") this.select([{ anchor: 0, head: this.text.length }]);
    else if (key === ";") this.select(this.ranges().map(range => characterSelection(this.text, cursorOf(this.text, range))));
    else if (key === ",") this.select(this.ranges().slice(0, 1));
    else if (key === "(" || key === ")") {
      const ranges = this.ranges();
      this.select(key === ")" ? [...ranges.slice(1), ranges[0]] : [ranges[ranges.length - 1], ...ranges.slice(0, -1)]);
    } else if (key === "C") {
      this.select([...this.ranges(), ...this.ranges().flatMap(range => {
        const [start, end] = selectionBounds(range);
        const a = this.model.getPositionAt(start);
        const b = this.model.getPositionAt(end);
        if (b.lineNumber >= this.model.getLineCount()) return [];
        return [{ anchor: this.model.getOffsetAt({ lineNumber: a.lineNumber + 1, column: a.column }), head: this.model.getOffsetAt({ lineNumber: b.lineNumber + 1, column: b.column }) }];
      })]);
    } else if (key === "u" || key === "U") {
      this.history(key === "U", count);
    } else if (key === "." && this.lastInsert && this.writable()) {
      const last = this.lastInsert;
      for (let n = 0; n < count; n++) {
        this.enterInsert(last.entry);
        this.replace(last.texts, false);
        this.leaveInsert(false);
      }
    } else if (key === "~" || key === "`") {
      if (this.writable()) this.replace(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        return [...this.text.slice(start, end)].map(char => key === "`" ? char.toLowerCase() : char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join("");
      }));
    } else if (key === "_") {
      this.select(this.ranges().map(range => {
        const [start, end] = selectionBounds(range);
        const value = this.text.slice(start, end);
        if (!value.trim()) return range;
        return { anchor: start + value.length - value.trimStart().length, head: end - (value.length - value.trimEnd().length) };
      }));
    } else if (key === ">" || key === "<" || key === "=" || key === "J") {
      if (this.writable()) this.action(({ ">": "editor.action.indentLines", "<": "editor.action.outdentLines", "=": "editor.action.formatSelection", J: "editor.action.joinLines" })[key]!);
    } else if (key === "s" || key === "S" || key === "K") this.regexPrompt(key);
    else if (key === "/" || key === "?") this.ui.prompt(key, pattern => {
      if (pattern) this.session.searchPattern = pattern;
      this.search(key === "?", count);
    });
    else if (key === "n" || key === "N") this.search(key === "N", count);
    else if (key === "*") {
      const range = this.ranges()[0];
      const [start, end] = selectionBounds(range);
      this.session.searchPattern = this.text.slice(start, end).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (/\w/.test(this.text[start] ?? "") && !/\w/.test(this.text[start - 1] ?? "")) this.session.searchPattern = "\\b" + this.session.searchPattern;
      if (/\w/.test(this.text[end - 1] ?? "") && !/\w/.test(this.text[end] ?? "")) this.session.searchPattern += "\\b";
    } else if (key === ":") this.ui.prompt(":", value => this.ui.command(value));
    else if (key === "G") this.goto("g", count);
    else if (key === "PageUp" || key === "PageDown") this.action(key === "PageUp" ? "cursorPageUp" : "cursorPageDown");
    // In normal/select mode all unbound text keys are consumed. They must never
    // fall through to Monaco's insertion, delete, or tab handlers.
    this.status();
    return true;
  }

  dispose(restoreEditor = true) {
    if (this.disposed) return;
    if (this.alive && this.mode === "insert") this.editor.pushUndoStop();
    const ranges = restoreEditor && this.alive && this.mode !== "insert" ? this.ranges() : undefined;
    this.disposed = true;
    this.clearKeyPrefix(false);
    this.continuation = undefined;
    this.dispatcher.dispose();
    this.subscriptions.forEach(subscription => subscription.dispose());
    this.insertMarks.clear();
    this.cursorDecorations.clear();
    if (restoreEditor) this.editor.getDomNode()?.classList.remove("monaco-helix-command");
    if (ranges && !this.boundModel.isDisposed() && this.editor.getModel() === this.boundModel) {
      this.editor.setSelections(ranges.map(range => monaco.Selection.fromPositions(
        this.boundModel.getPositionAt(cursorOf(this.text, range)),
      )));
    }
  }
}
