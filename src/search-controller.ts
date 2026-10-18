import type * as monaco from "monaco-editor";
import { cursorOf, selectionBounds, type HelixSelection } from "./selection.js";
import { createWorkerSearchEngine, SearchHistory, SearchPreviewSession, type SearchConfiguration, type SearchResult } from "./search.js";
import type { ModalUI } from "./types.js";

export interface SearchControllerAccess {
  ranges(): HelixSelection[];
  select(ranges: HelixSelection[]): void;
  alive(): boolean;
  revision(): number;
  selectMode(): boolean;
  getPattern(): string;
  setPattern(pattern: string): void;
  run(operation: (signal: AbortSignal) => Promise<void>): Promise<void>;
}

export type RegexPromptKind = "s" | "S" | "K" | "remove";

/** Model-bound search coordinator; the editor's controller supplies its selection semantics. */
export function createSearchController(
  editor: monaco.editor.IStandaloneCodeEditor,
  ui: ModalUI,
  access: SearchControllerAccess,
  configuration: SearchConfiguration = {},
  history = new SearchHistory(),
) {
  const engine = createWorkerSearchEngine(configuration);
  const { timeoutMs: _timeout, workerFactory: _factory, ...matchingOptions } = configuration;
  type Snapshot = {
    model: monaco.editor.ITextModel;
    version: number;
    ranges: HelixSelection[];
    scrollTop: number;
    scrollLeft: number;
  };
  let disposed = false;
  let preview: SearchPreviewSession<Snapshot> | undefined;
  const capture = (): Snapshot => {
    const model = editor.getModel();
    if (!model || !access.alive()) throw new DOMException("Search cancelled", "AbortError");
    return {
      model, version: model.getVersionId(), ranges: access.ranges().map(range => ({ ...range })),
      scrollTop: editor.getScrollTop(), scrollLeft: editor.getScrollLeft(),
    };
  };
  const current = (snapshot: Snapshot) => !disposed && access.alive() && !snapshot.model.isDisposed()
    && editor.getModel() === snapshot.model && snapshot.model.getVersionId() === snapshot.version;
  const restore = (snapshot: Snapshot) => {
    if (!current(snapshot)) return;
    access.select(snapshot.ranges.map(range => ({ ...range })));
    editor.setScrollPosition({ scrollTop: snapshot.scrollTop, scrollLeft: snapshot.scrollLeft });
  };
  const matches = async (snapshot: Snapshot, pattern: string, scoped: boolean, signals: readonly (AbortSignal | undefined)[] = []) => {
    if (!current(snapshot)) throw new DOMException("Search cancelled", "AbortError");
    const revision = access.revision();
    const controller = new AbortController();
    const abort = () => controller.abort();
    for (const signal of signals) {
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) controller.abort();
    }
    try {
      const result = await engine.search(snapshot.model.getValue(), pattern, {
        ...matchingOptions, ...(scoped ? { ranges: snapshot.ranges } : { ranges: undefined }),
      }, controller.signal);
      if (!current(snapshot) || revision !== access.revision()) throw new DOMException("Search cancelled", "AbortError");
      return result;
    } finally { for (const signal of signals) signal?.removeEventListener("abort", abort); }
  };
  const announce = (result: SearchResult) => ui.notify(result.matches.length
    ? `${result.matches.length}${result.truncated ? "+" : ""} matches` : "No matches");
  const choose = (snapshot: Snapshot, result: SearchResult, backwards: boolean, count: number, record = false) => {
    announce(result);
    if (!result.matches.length) { restore(snapshot); return; }
    const text = snapshot.model.getValue();
    const found = snapshot.ranges.map(range => {
      const cursor = cursorOf(text, range);
      let index = result.matches.findIndex(match => match.anchor > cursor);
      if (backwards) {
        const start = selectionBounds(range)[0];
        index = -1;
        for (let n = 0; n < result.matches.length && result.matches[n]!.anchor < start; n++) index = n;
      }
      if (index < 0) index = backwards ? result.matches.length - 1 : 0;
      const amount = Math.max(1, Math.min(10_000, Math.trunc(count) || 1));
      index = ((index + (backwards ? -1 : 1) * (amount - 1)) % result.matches.length + result.matches.length) % result.matches.length;
      return { ...result.matches[index]! };
    });
    if (record) { restore(snapshot); ui.recordJump?.(); }
    access.select(access.selectMode() ? [...snapshot.ranges.map(range => ({ ...range })), ...found] : found);
    if (record) ui.recordJump?.();
  };
  const transform = (snapshot: Snapshot, result: SearchResult, kind: RegexPromptKind): HelixSelection[] => {
    // Partial selection sets could cause a later edit to silently affect only some matches.
    if (result.truncated) throw new Error("Selection operation exceeds the search result limit");
    if (kind === "s") return result.matches;
    const groups = result.groups ?? snapshot.ranges.map(range => {
      const [start, end] = selectionBounds(range);
      return result.matches.filter(match => match.anchor >= start && match.head <= end);
    });
    if (kind === "K" || kind === "remove") return snapshot.ranges.filter((_range, index) => kind === "K"
      ? !!groups[index]?.length : !groups[index]?.length);
    const split: HelixSelection[] = [];
    snapshot.ranges.forEach((range, index) => {
      const [start, end] = selectionBounds(range);
      let previous = start;
      for (const match of groups[index] ?? []) {
        if (previous < match.anchor) split.push({ anchor: previous, head: match.anchor });
        previous = Math.max(previous, match.head);
      }
      if (previous < end) split.push({ anchor: previous, head: end });
    });
    return split;
  };
  const startPrompt = (label: string, snapshot: Snapshot, apply: (result: SearchResult) => void, commit: (pattern: string, result: SearchResult) => void) => {
    preview?.dispose();
    const session = new SearchPreviewSession({ snapshot, restore, isCurrent: () => current(snapshot) });
    preview = session;
    const scoped = label !== "/" && label !== "?";
    ui.prompt(label, async value => {
      session.accept();
      if (preview === session) preview = undefined;
      return access.run(async signal => {
        const pattern = value || (scoped ? "" : access.getPattern());
        if (!pattern) { restore(snapshot); return; }
        try {
          const result = await matches(snapshot, pattern, scoped, [signal]);
          commit(pattern, result);
        } catch (error) {
          if (current(snapshot) && !(error instanceof Error && error.name === "AbortError")) {
            restore(snapshot);
            ui.notify(error instanceof Error ? error.message : String(error));
          }
          throw error;
        }
      });
    }, "", {
      history,
      onCancel() { session.cancel(); if (preview === session) preview = undefined; },
      async onChange(value, signal) {
        if (signal.aborted) return;
        if (!value) {
          await session.update(() => undefined, () => { restore(snapshot); ui.notify(""); });
          return;
        }
        try {
          await session.update(internal => matches(snapshot, value, scoped, [signal, internal]), apply);
        } catch (error) {
          if (!signal.aborted && current(snapshot) && !(error instanceof Error && error.name === "AbortError")) {
            ui.notify(error instanceof Error ? error.message : String(error));
          }
        }
      },
    });
  };
  return {
    open(backwards: boolean, count = 1): void {
      const snapshot = capture();
      startPrompt(backwards ? "?" : "/", snapshot,
        result => choose(snapshot, result, backwards, count),
        (pattern, result) => { access.setPattern(pattern); choose(snapshot, result, backwards, count, true); });
    },
    async next(backwards: boolean, count = 1, signal?: AbortSignal): Promise<void> {
      const pattern = access.getPattern();
      if (!pattern) return;
      const snapshot = capture();
      choose(snapshot, await matches(snapshot, pattern, false, [signal]), backwards, count, true);
    },
    regex(kind: RegexPromptKind): void {
      const snapshot = capture();
      const apply = (result: SearchResult) => {
        const ranges = transform(snapshot, result, kind);
        if (ranges.length) access.select(ranges);
        ui.notify(ranges.length ? `${ranges.length} selections` : "No matches");
      };
      startPrompt(kind === "remove" ? "Alt-K" : kind, snapshot, apply, (_pattern, result) => apply(result));
    },
    cancel(): void { engine.cancel(); preview?.cancel(); preview = undefined; },
    dispose(): void { disposed = true; engine.dispose(); preview?.dispose(); preview = undefined; },
  };
}
