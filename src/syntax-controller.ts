import type * as monaco from "monaco-editor";
import { cancellation } from "./commands.js";
import { cursorOf, moveSelection } from "./selection.js";
import type { HelixSelection } from "./selection.js";
import { SyntaxCoordinator } from "./syntax.js";
import type { SyntaxObject, SyntaxOperation, SyntaxProvider } from "./syntax.js";

export const syntaxTextObjects: Readonly<Record<string, SyntaxObject>> = {
  f: "function", t: "type", a: "parameter", c: "comment", T: "test",
};

export const syntaxCommands: Readonly<Record<string, SyntaxOperation>> = {
  expand_selection: { kind: "parent" },
  shrink_selection: { kind: "child" },
  select_prev_sibling: { kind: "previousSibling" },
  select_next_sibling: { kind: "nextSibling" },
  select_all_siblings: { kind: "allSiblings" },
  select_all_children: { kind: "allChildren" },
  move_parent_node_start: { kind: "parentStart" },
  move_parent_node_end: { kind: "parentEnd" },
  goto_next_function: { kind: "next", object: "function" },
  goto_prev_function: { kind: "previous", object: "function" },
  goto_next_class: { kind: "next", object: "type" },
  goto_prev_class: { kind: "previous", object: "type" },
  goto_next_parameter: { kind: "next", object: "parameter" },
  goto_prev_parameter: { kind: "previous", object: "parameter" },
  goto_next_comment: { kind: "next", object: "comment" },
  goto_prev_comment: { kind: "previous", object: "comment" },
  goto_next_test: { kind: "next", object: "test" },
  goto_prev_test: { kind: "previous", object: "test" },
};

let nextSession = 0;

/** Model-bound guards for the asynchronous provider; contains no parser dependency. */
export class SyntaxController {
  private readonly model: monaco.editor.ITextModel;
  private readonly coordinator: SyntaxCoordinator;
  private readonly documentId: string;
  private subscriptions: monaco.IDisposable[] = [];
  private revision = 0;
  private disposed = false;
  private applying = false;
  private applicationEvents = 0;
  private selectionKey: string;

  constructor(
    private readonly editor: monaco.editor.IStandaloneCodeEditor,
    provider: SyntaxProvider,
    private readonly applySelections: (selections: HelixSelection[]) => void,
  ) {
    const model = editor.getModel();
    if (!model) throw new Error("Syntax editing requires an active model");
    this.model = model;
    this.coordinator = new SyntaxCoordinator(provider);
    this.selectionKey = this.currentSelectionKey();
    // Separate expansion history and model releases even if two editors share
    // the same model/provider, or a keymap is detached and immediately attached.
    this.documentId = `${editor.getId()}:syntax-${++nextSession}:${model.id}`;
    const invalidate = () => this.cancel();
    this.subscriptions.push(
      model.onDidChangeContent(invalidate),
      model.onDidChangeLanguage(invalidate),
      model.onWillDispose(() => this.dispose()),
      editor.onDidChangeModel(() => this.dispose()),
      editor.onDidDispose(() => this.dispose()),
      editor.onDidChangeCursorSelection(() => {
        const key = this.currentSelectionKey();
        // Monaco can notify cursor state while loading language configuration
        // without changing any range. Such notifications are not new input.
        if (key === this.selectionKey) return;
        this.selectionKey = key;
        if (!this.applying) this.cancel();
        // setSelections emits one synchronous event. A reentrant host cursor
        // change during that notification must still invalidate queued edits.
        else if (++this.applicationEvents > 1) this.cancel();
      }),
    );
  }

  async execute(operation: SyntaxOperation, signal?: AbortSignal, extend = false): Promise<void> {
    if (!this.current() || signal?.aborted) throw cancellation();
    const model = this.model;
    const version = model.getVersionId();
    const languageId = model.getLanguageId();
    const text = model.getValue();
    const revision = this.revision;
    const selections = (this.editor.getSelections() ?? []).map(selection => ({
      anchor: model.getOffsetAt(selection.getSelectionStart()),
      head: model.getOffsetAt(selection.getPosition()),
    }));
    const result = await this.coordinator.query({ id: this.documentId, version, languageId, text }, selections, operation, signal);
    const valid = () => this.current() && !signal?.aborted && revision === this.revision
      && version === model.getVersionId() && languageId === model.getLanguageId();
    if (!result || !valid()) throw cancellation();
    const movement = ["next", "previous", "parentStart", "parentEnd"].includes(operation.kind);
    const target = extend && movement && result.length === selections.length
      ? result.map((range, index) => moveSelection(text, selections[index], cursorOf(text, range), true))
      : result;
    this.applying = true;
    this.applicationEvents = 0;
    try { this.applySelections(target); }
    finally { this.applying = false; }
    if (!valid()) throw cancellation();
  }

  private current(): boolean {
    return !this.disposed && !this.model.isDisposed() && this.editor.getModel() === this.model;
  }

  private currentSelectionKey(): string {
    return JSON.stringify((this.editor.getSelections() ?? []).map(selection => [
      this.model.getOffsetAt(selection.getSelectionStart()), this.model.getOffsetAt(selection.getPosition()),
    ]));
  }

  cancel(): void {
    this.revision++;
    this.coordinator.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.revision++;
    for (const subscription of this.subscriptions.splice(0)) subscription.dispose();
    this.coordinator.dispose();
  }
}
