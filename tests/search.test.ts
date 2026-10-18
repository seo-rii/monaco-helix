import { Worker as ThreadWorker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createWorkerSearchEngine, findSearchMatches, SearchHistory, SearchPreviewSession } from "../src/search.js";
import { createSearchController } from "../src/search-controller.js";
import type { ModalUI, PromptOptions } from "../src/types.js";

function threadedWorker(): Worker {
  const thread = new ThreadWorker(`const {parentPort} = require('node:worker_threads');const search=(${findSearchMatches.toString()});parentPort.on('message',args=>{try{parentPort.postMessage({result:search(...args)})}catch(error){parentPort.postMessage({error:{name:error.name,message:error.message}})}})`, { eval: true });
  const adapter = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage: (message: unknown) => thread.postMessage(message),
    terminate: () => { void thread.terminate(); },
  };
  thread.on("message", data => adapter.onmessage?.({ data } as MessageEvent));
  thread.on("error", error => adapter.onerror?.({ message: error.message, preventDefault() {} } as ErrorEvent));
  return adapter as unknown as Worker;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

describe("search match engine", () => {
  it("expands partial Unicode graphemes and coalesces matches within one character", () => {
    expect(findSearchMatches("é👩‍💻\r\n", ".").matches).toEqual([
      { anchor: 0, head: 2 }, { anchor: 2, head: 7 },
    ]);
    expect(findSearchMatches("é", "́").matches).toEqual([{ anchor: 0, head: 2 }]);
  });

  it("terminates zero-width searches including Unicode and EOF boundaries", () => {
    expect(findSearchMatches("👩‍💻x", "(?=.)|$").matches).toEqual([
      { anchor: 0, head: 0 }, { anchor: 5, head: 5 }, { anchor: 6, head: 6 },
    ]);
    expect(findSearchMatches("", "^").matches).toEqual([{ anchor: 0, head: 0 }]);
    expect(findSearchMatches("abc", "").matches).toEqual([]);
  });

  it("supports multiline/case flags and reports invalid patterns", () => {
    expect(findSearchMatches("Alpha\nalpha", "^alpha", { caseSensitive: false }).matches).toHaveLength(2);
    expect(findSearchMatches("Alpha\nalpha", "^alpha", { caseSensitive: false, multiline: false }).matches).toHaveLength(1);
    expect(() => findSearchMatches("abc", "[")).toThrow(SyntaxError);
  });

  it("bounds matches, documents and pattern length without silent truncation", () => {
    expect(findSearchMatches("x".repeat(50_000), "x", { maxMatches: 3 })).toEqual({
      matches: [{ anchor: 0, head: 1 }, { anchor: 1, head: 2 }, { anchor: 2, head: 3 }], truncated: true,
    });
    expect(findSearchMatches("xxx", "x", { maxMatches: 3 }).truncated).toBe(false);
    expect(() => findSearchMatches("long", "x", { maxDocumentLength: 3 })).toThrow("document exceeds");
    expect(() => findSearchMatches("x", "long", { maxPatternLength: 3 })).toThrow("pattern exceeds");
  });

  it("searches each selected substring in one batch and retains scope identity at shared empty boundaries", () => {
    const result = findSearchMatches("ab", "(?<=a)$", { ranges: [{ anchor: 0, head: 1 }, { anchor: 1, head: 2 }] });
    expect(result).toEqual({ matches: [{ anchor: 1, head: 1 }], truncated: false, groups: [[{ anchor: 1, head: 1 }], []] });
    expect(findSearchMatches("left RIGHT", "^.", { ranges: [{ anchor: 10, head: 5 }, { anchor: 0, head: 4 }] }).matches)
      .toEqual([{ anchor: 5, head: 6 }, { anchor: 0, head: 1 }]);
    expect(() => findSearchMatches("abc", ".", { ranges: [{ anchor: -1, head: 2 }] })).toThrow("valid document offsets");
  });
});

describe("worker search", () => {
  it("performs real worker searches and preserves regex errors", async () => {
    const engine = createWorkerSearchEngine({ workerFactory: threadedWorker, timeoutMs: 1500 });
    try {
      expect(await engine.search("a👩‍💻b", "👩")).toEqual({ matches: [{ anchor: 1, head: 6 }], truncated: false });
      await expect(engine.search("abc", "[")).rejects.toMatchObject({ name: "SyntaxError" });
    } finally { engine.dispose(); }
  });

  it("terminates catastrophic backtracking and accepts a later search", async () => {
    const engine = createWorkerSearchEngine({ workerFactory: threadedWorker, timeoutMs: 150 });
    try {
      await expect(engine.search("a".repeat(1000) + "!", "(a+)+$")).rejects.toThrow("budget");
      expect((await engine.search("fine", "fine")).matches).toEqual([{ anchor: 0, head: 4 }]);
    } finally { engine.dispose(); }
  });

  it("aborts outstanding and superseded work, and rejects use after disposal", async () => {
    const engine = createWorkerSearchEngine({ workerFactory: threadedWorker, timeoutMs: 1500 });
    const signal = new AbortController();
    const aborted = engine.search("a".repeat(1000) + "!", "(a+)+$", {}, signal.signal);
    const abortedAssertion = expect(aborted).rejects.toMatchObject({ name: "AbortError" });
    signal.abort();
    await abortedAssertion;
    const stale = engine.search("a".repeat(1000) + "!", "(a+)+$");
    const staleAssertion = expect(stale).rejects.toMatchObject({ name: "AbortError" });
    expect((await engine.search("new", "new")).matches).toHaveLength(1);
    await staleAssertion;
    engine.dispose();
    await expect(engine.search("closed", "closed")).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("search history", () => {
  it("bounds and deduplicates patterns and restores the current draft", () => {
    const history = new SearchHistory(2);
    for (const pattern of ["one", "two", "three", "two", ""]) history.record(pattern);
    expect(history.values()).toEqual(["three", "two"]);
    expect(history.previous("draft")).toBe("two");
    expect(history.previous()).toBe("three");
    expect(history.previous()).toBe("three");
    expect(history.next()).toBe("two");
    expect(history.next()).toBe("draft");
    expect(history.next()).toBe("draft");
    const copy = history.values();
    copy.push("external");
    expect(history.values()).toEqual(["three", "two"]);
  });
});

describe("search previews", () => {
  it("settles cancellation even if a preview provider ignores abort forever", async () => {
    const preview = new SearchPreviewSession({ snapshot: "original", restore: () => {} });
    const pending = preview.update(() => new Promise<never>(() => {}), () => {});
    preview.cancel();
    expect(await pending).toBe(false);
  });

  it("suppresses stale previews and restores the original snapshot once on cancel", async () => {
    const restore = vi.fn();
    const apply = vi.fn();
    const preview = new SearchPreviewSession({ snapshot: { selections: [1], scrollTop: 9 }, restore });
    const first = deferred<string>();
    let oldSignal!: AbortSignal;
    const old = preview.update(signal => { oldSignal = signal; return first.promise; }, apply);
    expect(await preview.update(() => "new", apply)).toBe(true);
    expect(oldSignal.aborted).toBe(true);
    first.resolve("old");
    expect(await old).toBe(false);
    expect(apply.mock.calls).toEqual([["new"]]);
    preview.cancel();
    preview.cancel();
    expect(restore.mock.calls).toEqual([[{ selections: [1], scrollTop: 9 }]]);
  });

  it("never restores across model changes, accept, or editor disposal", async () => {
    const restore = vi.fn();
    let current = true;
    const preview = new SearchPreviewSession({ snapshot: "old model", restore, isCurrent: () => current });
    const pending = deferred<string>();
    const apply = vi.fn();
    const result = preview.update(() => pending.promise, apply);
    current = false;
    pending.resolve("stale");
    expect(await result).toBe(false);
    preview.cancel();
    expect(restore).not.toHaveBeenCalled();
    const accepted = new SearchPreviewSession({ snapshot: "accepted", restore });
    accepted.accept();
    accepted.cancel();
    const disposed = new SearchPreviewSession({ snapshot: "disposed", restore });
    disposed.dispose();
    disposed.cancel();
    expect(restore).not.toHaveBeenCalled();
  });
});

function searchFixture(maxMatches = 1000) {
  let ranges = [{ anchor: 0, head: 1 }];
  let revision = 0;
  let version = 1;
  let pattern = "";
  let alive = true;
  let scroll = { scrollTop: 20, scrollLeft: 5 };
  const model = { getValue: () => "one two one", getVersionId: () => version, isDisposed: () => !alive };
  const editor = {
    getModel: () => model, getScrollTop: () => scroll.scrollTop, getScrollLeft: () => scroll.scrollLeft,
    setScrollPosition: (next: typeof scroll) => { scroll = next; },
  };
  let prompt!: { submit: (value: string) => void | Promise<void>; config: PromptOptions };
  const ui: ModalUI = {
    mode() {}, notify: vi.fn(), command() {}, error: vi.fn(),
    prompt(_label, submit, _initial, config = {}) { prompt = { submit, config }; },
  };
  const controller = createSearchController(editor as never, ui, {
    ranges: () => ranges,
    select: next => { ranges = next; revision++; scroll = { scrollTop: 100, scrollLeft: 0 }; },
    alive: () => alive, revision: () => revision, selectMode: () => false,
    getPattern: () => pattern, setPattern: next => { pattern = next; },
  }, { workerFactory: threadedWorker, timeoutMs: 1500, maxMatches });
  return {
    controller, ui, get prompt() { return prompt; }, get ranges() { return ranges; }, get scroll() { return scroll; },
    get pattern() { return pattern; }, setRanges(next: typeof ranges) { ranges = next; revision++; },
    edit() { version++; }, disposeModel() { alive = false; },
  };
}

describe("model-bound search coordination", () => {
  it("previews from the original cursor and restores selections and viewport on cancellation", async () => {
    const state = searchFixture();
    try {
      state.controller.open(false);
      await state.prompt.config.onChange!("two", new AbortController().signal);
      expect(state.ranges).toEqual([{ anchor: 4, head: 7 }]);
      await state.prompt.config.onChange!("one", new AbortController().signal);
      expect(state.ranges).toEqual([{ anchor: 8, head: 11 }]);
      state.prompt.config.onCancel!();
      expect(state.ranges).toEqual([{ anchor: 0, head: 1 }]);
      expect(state.scroll).toEqual({ scrollTop: 20, scrollLeft: 5 });
      expect(state.pattern).toBe("");
    } finally { state.controller.dispose(); }
  });

  it("commits a submitted pattern and filters selections through one worker request", async () => {
    const state = searchFixture();
    try {
      state.controller.open(false);
      await state.prompt.submit("two");
      expect(state.pattern).toBe("two");
      expect(state.ranges).toEqual([{ anchor: 4, head: 7 }]);
      state.setRanges([{ anchor: 0, head: 3 }, { anchor: 4, head: 7 }, { anchor: 8, head: 11 }]);
      state.controller.regex("remove");
      await state.prompt.submit("one");
      expect(state.ranges).toEqual([{ anchor: 4, head: 7 }]);
    } finally { state.controller.dispose(); }
  });

  it("rejects truncated selection operations so a macro cannot continue against an incomplete set", async () => {
    const state = searchFixture(1);
    try {
      state.setRanges([{ anchor: 0, head: 11 }]);
      state.controller.regex("s");
      await expect(state.prompt.submit("one")).rejects.toThrow("result limit");
      expect(state.ranges).toEqual([{ anchor: 0, head: 11 }]);
    } finally { state.controller.dispose(); }
  });

  it("does not apply or restore a stale preview after model content changes", async () => {
    const state = searchFixture();
    try {
      state.controller.open(false);
      const preview = state.prompt.config.onChange!("two", new AbortController().signal);
      state.edit();
      await preview;
      expect(state.ranges).toEqual([{ anchor: 0, head: 1 }]);
      state.prompt.config.onCancel!();
      expect(state.scroll).toEqual({ scrollTop: 20, scrollLeft: 5 });
    } finally { state.controller.dispose(); }
  });
});
