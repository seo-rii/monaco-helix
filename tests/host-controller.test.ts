import { describe, expect, it, vi } from "vitest";
import { createHostController, type HostControllerUI } from "../src/host-controller.js";
import type { HostAdapter, NavigationLocation } from "../src/navigation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(configure?: (state: ReturnType<typeof modelFixture>) => HostAdapter, picker?: HostControllerUI["pick"]) {
  const state = modelFixture();
  const host = configure?.(state) ?? {
    openLocation(target: NavigationLocation) {
      const model = state.models.get(target.uri);
      if (!model || model.isDisposed()) return false;
      state.setModel(model);
    },
  };
  const notify = vi.fn();
  const controller = createHostController(state.editor as never, host, { pick: picker ?? (async () => undefined), notify }, { pickerLimit: 2 });
  state.onSwitch = () => { controller.onModelChange(); };
  return Object.assign(state, { controller, notify, host });
}

function modelFixture() {
  const makeModel = (uri: string, value = "alpha") => {
    let disposed = false;
    return {
      uri: { toString: () => uri }, value, version: 1,
      getValue() { return this.value; }, getVersionId() { return this.version; },
      getOffsetAt(position: { column: number }) { return Math.max(0, Math.min(this.value.length, position.column - 1)); },
      getPositionAt(offset: number) { return { lineNumber: 1, column: Math.max(0, Math.min(this.value.length, offset)) + 1 }; },
      isDisposed: () => disposed, dispose() { disposed = true; },
    };
  };
  const models = new Map(["a", "b", "c"].map(uri => [uri, makeModel(uri)]));
  let model = models.get("a")!;
  let ranges = [{ anchor: 0, head: 1 }];
  let scroll = { scrollTop: 5, scrollLeft: 2 };
  const listeners = new Set<() => void>();
  const state = {
    models,
    onSwitch: () => {},
    setModel(next: typeof model) { model = next; ranges = [{ anchor: 0, head: 0 }]; state.onSwitch(); },
    select(anchor: number, head: number) { ranges = [{ anchor, head }]; for (const listener of listeners) listener(); },
    get ranges() { return ranges; },
    editor: {
      getModel: () => model,
      getSelections: () => ranges.map(range => ({
        getSelectionStart: () => model.getPositionAt(range.anchor), getPosition: () => model.getPositionAt(range.head),
      })),
      getScrollTop: () => scroll.scrollTop, getScrollLeft: () => scroll.scrollLeft,
      onDidChangeCursorSelection(callback: () => void) { listeners.add(callback); return { dispose() { listeners.delete(callback); } }; },
      onDidScrollChange: (_callback: () => void) => ({ dispose() {} }),
      setSelections(next: Array<{ selectionStartColumn: number; positionColumn: number }>) {
        ranges = next.map(range => ({ anchor: range.selectionStartColumn - 1, head: range.positionColumn - 1 }));
        for (const listener of listeners) listener();
      },
      setScrollPosition(next: typeof scroll) { scroll = next; },
      revealPositionInCenterIfOutsideViewport() {}, focus() {},
    },
  };
  return state;
}

describe("binding-owned host navigation", () => {
  it("preserves future jumps after ordinary local motion and honors traversal counts", async () => {
    const state = fixture(() => ({}));
    try {
      state.select(1, 2); state.controller.record();
      state.select(2, 3); state.controller.record();
      state.select(3, 4); state.controller.record();
      await state.controller.execute("jump_backward", { count: 2 });
      expect(state.ranges).toEqual([{ anchor: 1, head: 2 }]);
      state.select(4, 5);
      await state.controller.execute("jump_forward");
      expect(state.ranges).toEqual([{ anchor: 2, head: 3 }]);
      await state.controller.execute("jump_forward", { count: 100 });
      expect(state.ranges).toEqual([{ anchor: 3, head: 4 }]);
    } finally { state.controller.dispose(); }
  });

  it("records external model transitions and restores directional selections in both directions", async () => {
    const state = fixture();
    try {
      state.select(4, 1);
      state.setModel(state.models.get("b")!);
      await state.controller.execute("jump_backward");
      expect(state.editor.getModel().uri.toString()).toBe("a");
      expect(state.ranges).toEqual([{ anchor: 4, head: 1 }]);
      expect(state.controller.snapshot().index).toBe(1);
      await state.controller.execute("jump_forward");
      expect(state.editor.getModel().uri.toString()).toBe("b");
      expect(state.controller.snapshot().entries.map(entry => entry.uri)).toEqual(["a", "a", "b"]);
    } finally { state.controller.dispose(); }
  });

  it("commits its intended model switch even when disposal aborts the old controller", async () => {
    const old = new AbortController();
    const state = fixture();
    try {
      state.setModel(state.models.get("b")!);
      state.onSwitch = () => { state.controller.onModelChange(); old.abort(); };
      await state.controller.execute("jump_backward", {}, old.signal);
      expect(old.signal.aborted).toBe(true);
      expect(state.editor.getModel().uri.toString()).toBe("a");
      expect(state.controller.snapshot().index).toBe(0);
    } finally { state.controller.dispose(); }
  });

  it("retains history cursor when a host refuses a disposed destination", async () => {
    const state = fixture();
    try {
      state.setModel(state.models.get("b")!);
      state.models.get("a")!.dispose();
      const before = state.controller.snapshot();
      await state.controller.execute("jump_backward");
      expect(state.controller.snapshot().index).toBe(before.index);
      expect(state.editor.getModel().uri.toString()).toBe("b");
    } finally { state.controller.dispose(); }
  });

  it("cancels late opening when an unrelated external model replaces the editor", async () => {
    const pending = deferred<void>();
    let signal!: AbortSignal;
    const state = fixture(() => ({
      async openLocation(_target, context) { signal = context.signal; await pending.promise; },
    }));
    try {
      state.setModel(state.models.get("b")!);
      const travel = state.controller.execute("jump_backward");
      const rejection = expect(travel).rejects.toMatchObject({ name: "AbortError" });
      state.setModel(state.models.get("c")!);
      await rejection;
      expect(signal.aborted).toBe(true);
      pending.resolve();
      await Promise.resolve();
      expect(state.editor.getModel().uri.toString()).toBe("c");
      expect(state.controller.snapshot().entries.at(-1)!.uri).toBe("c");
    } finally { state.controller.dispose(); }
  });

  it("clamps remembered offsets to complete current graphemes without requiring a host for local jumps", async () => {
    const state = fixture(() => ({}));
    try {
      state.controller.record({ uri: "a", selections: [{ anchor: 2, head: 4 }] });
      state.select(0, 1);
      state.models.get("a")!.value = "👩‍💻";
      state.models.get("a")!.version++;
      state.controller.record();
      await state.controller.execute("jump_backward");
      expect(state.ranges).toEqual([{ anchor: 0, head: 5 }]);
    } finally { state.controller.dispose(); }
  });

  it("supersedes old picker queries, bounds duplicate results, and opens the selected item", async () => {
    const old = deferred<readonly { id: string; label: string }[]>();
    let oldSignal!: AbortSignal;
    const state = fixture(state => ({
      queryFiles(value, context) {
        if (value === "old") { oldSignal = context.signal; return old.promise; }
        return [
          { id: "b", label: "B", location: { uri: "b", selections: [{ anchor: 0, head: 1 }] } },
          { id: "b", label: "duplicate" }, { id: "c", label: "C" }, { id: "extra", label: "extra" },
        ];
      },
      openLocation(target) { state.setModel(state.models.get(target.uri)!); },
    }), async request => {
      const stale = request.query("old", new AbortController().signal);
      const latest = await request.query("new", new AbortController().signal);
      expect(latest.map(item => item.id)).toEqual(["b", "c"]);
      expect(await stale).toEqual([]);
      expect(oldSignal.aborted).toBe(true);
      old.resolve([{ id: "stale", label: "stale" }]);
      return latest[0];
    });
    try {
      await state.controller.execute("file_picker");
      expect(state.editor.getModel().uri.toString()).toBe("b");
    } finally { state.controller.dispose(); }
  });

  it("rejects cancellation/disposal and missing capabilities without writing models", async () => {
    const state = fixture(() => ({}), async request => new Promise(resolve => request.signal.addEventListener("abort", () => resolve(undefined), { once: true })));
    try {
      await expect(state.controller.execute("file_picker")).rejects.toThrow("does not support files");
      await expect(state.controller.execute("host_command", { command: "write" })).rejects.toThrow("does not support");
      state.host.queryFiles = () => [];
      const pending = state.controller.execute("file_picker");
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      state.controller.cancel();
      await rejected;
      expect(state.editor.getModel().uri.toString()).toBe("a");
      state.controller.dispose();
      await expect(state.controller.execute("host_command", { command: "write" })).rejects.toMatchObject({ name: "AbortError" });
    } finally { state.controller.dispose(); }
  });
});
