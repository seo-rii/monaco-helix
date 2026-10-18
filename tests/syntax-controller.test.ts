import { describe, expect, it, vi } from "vitest";
import { SyntaxController } from "../src/syntax-controller.js";
import type { SyntaxRequest, SyntaxResult } from "../src/syntax.js";

function event() {
  const listeners = new Set<() => void>();
  return { subscribe: (listener: () => void) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    emit: () => { for (const listener of [...listeners]) listener(); } };
}

function fixture() {
  const content = event(); const language = event(); const cursor = event(); const modelChange = event(); const editorDispose = event(); const modelDispose = event();
  const state = { text: "first second", version: 1, language: "python", ranges: [{ anchor: 0, head: 1 }], disposed: false };
  const model = { id: "shared-model", getValue: () => state.text, getVersionId: () => state.version, getLanguageId: () => state.language,
    isDisposed: () => state.disposed, getOffsetAt: (position: { column: number }) => position.column - 1,
    onDidChangeContent: content.subscribe, onDidChangeLanguage: language.subscribe, onWillDispose: modelDispose.subscribe };
  const editor = { getId: () => "editor", getModel: () => model,
    getSelections: () => state.ranges.map(range => ({ getSelectionStart: () => ({ column: range.anchor + 1 }), getPosition: () => ({ column: range.head + 1 }) })),
    onDidChangeModel: modelChange.subscribe, onDidDispose: editorDispose.subscribe, onDidChangeCursorSelection: cursor.subscribe };
  const requests: SyntaxRequest[] = []; const releases: string[] = [];
  let resolve!: (value: SyntaxResult | null) => void;
  let reject!: (error: Error) => void;
  const provider = { provide: (request: SyntaxRequest): Promise<SyntaxResult | null> => {
    requests.push(request); return new Promise((done, fail) => { resolve = done; reject = fail; });
  }, release: (id: string) => releases.push(id), dispose: vi.fn() };
  const apply = vi.fn(ranges => { state.ranges = ranges; cursor.emit(); });
  const controller = new SyntaxController(editor as any, provider, apply);
  return { controller, editor, provider, apply, state, requests, releases, content, language, cursor, modelChange, editorDispose, modelDispose,
    resolve: (result: SyntaxResult | null) => resolve(result), reject: (error: Error) => reject(error) };
}

describe("model-bound syntax selection guards", () => {
  it("applies a current result and permits its own cursor event", async () => {
    const value = fixture();
    const pending = value.controller.execute({ kind: "parent" });
    value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
    await pending;
    expect(value.state.ranges).toEqual([{ anchor: 6, head: 12 }]);
    value.controller.dispose();
    expect(value.releases).toEqual([value.requests[0].document.id]);
    expect(value.provider.dispose).not.toHaveBeenCalled();
  });

  it("extends navigation in Select mode while semantic objects replace the selection", async () => {
    const value = fixture();
    const movement = value.controller.execute({ kind: "next", object: "function" }, undefined, true);
    value.resolve({ version: 1, selections: [{ anchor: 6, head: 7 }] });
    await movement;
    expect(value.state.ranges).toEqual([{ anchor: 0, head: 7 }]);
    const object = value.controller.execute({ kind: "object", object: "function", around: false }, undefined, true);
    value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
    await object;
    expect(value.state.ranges).toEqual([{ anchor: 6, head: 12 }]);
    value.controller.dispose();
  });

  for (const name of ["content", "language", "cursor", "modelChange", "editorDispose", "modelDispose"] as const) {
    it(`cancels a pending request on ${name} without waiting for its provider`, async () => {
      const value = fixture();
      const pending = value.controller.execute({ kind: "parent" });
      if (name === "cursor") value.state.ranges = [{ anchor: 1, head: 2 }];
      value[name].emit();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(value.requests[0].signal.aborted).toBe(true);
      value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
      expect(value.apply).not.toHaveBeenCalled();
      value.controller.dispose();
    });
  }

  it("ignores a cursor-state notification that preserves all selection ranges", async () => {
    const value = fixture();
    const pending = value.controller.execute({ kind: "parent" });
    value.cursor.emit();
    expect(value.requests[0].signal.aborted).toBe(false);
    value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
    await pending;
    expect(value.state.ranges).toEqual([{ anchor: 6, head: 12 }]);
    value.controller.dispose();
  });

  it("checks the snapshot version and language even if a host omitted events", async () => {
    for (const field of ["version", "language"] as const) {
      const value = fixture(); const pending = value.controller.execute({ kind: "parent" });
      if (field === "version") value.state.version++;
      else value.state.language = "typescript";
      value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(value.apply).not.toHaveBeenCalled(); value.controller.dispose();
    }
  });

  it("turns a missing or stale result into command cancellation and forwards real errors", async () => {
    for (const result of [null, { version: 2, selections: [{ anchor: 6, head: 12 }] }]) {
      const value = fixture(); const pending = value.controller.execute({ kind: "parent" }); value.resolve(result);
      await expect(pending).rejects.toMatchObject({ name: "AbortError" }); value.controller.dispose();
    }
    const value = fixture(); const pending = value.controller.execute({ kind: "parent" }); value.reject(new Error("Parser unavailable"));
    await expect(pending).rejects.toThrow("Parser unavailable"); value.controller.dispose();
  });

  it("uses distinct session IDs for editors/controllers sharing one provider and model", async () => {
    const value = fixture();
    const other = new SyntaxController(value.editor as any, value.provider, value.apply);
    const first = value.controller.execute({ kind: "parent" });
    const second = other.execute({ kind: "parent" });
    expect(value.requests[0].document.id).not.toBe(value.requests[1].document.id);
    value.controller.dispose(); other.dispose();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(new Set(value.releases).size).toBe(2);
  });

  it("does not allow a reentrant host cursor change to release a queued edit", async () => {
    const value = fixture();
    value.apply.mockImplementation(ranges => { value.state.ranges = ranges; value.cursor.emit(); value.state.ranges = [{ anchor: 0, head: 1 }]; value.cursor.emit(); });
    const pending = value.controller.execute({ kind: "parent" }); value.resolve({ version: 1, selections: [{ anchor: 6, head: 12 }] });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); value.controller.dispose();
  });
});
