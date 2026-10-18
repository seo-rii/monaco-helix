import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createTreeSitterProvider, TreeSitterEngine } from "../src/tree-sitter.js";
import type { TreeSitterOptions } from "../src/tree-sitter.js";
import type { SyntaxObject, SyntaxOperation, SyntaxResult } from "../src/syntax.js";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../node_modules/tree-sitter-wasms/out/", import.meta.url));
const options: TreeSitterOptions = {
  execution: "inline", wasmUrl: require.resolve("web-tree-sitter/tree-sitter.wasm"),
  languages: Object.fromEntries(["python", "cpp", "typescript"].map(language => [language, { wasm: `${root}tree-sitter-${language}.wasm` }])),
  parseTimeoutMs: 1000,
};
// Keep default, original textobject queries while overriding only asset paths.
import { treeSitterQueries } from "../src/tree-sitter.js";
for (const [id, value] of Object.entries(options.languages!)) value!.query = treeSitterQueries[id];

const engines: TreeSitterEngine[] = [];
function engine(overrides: TreeSitterOptions = {}) { const value = new TreeSitterEngine({ ...options, ...overrides }); engines.push(value); return value; }
afterEach(() => { for (const value of engines.splice(0)) value.dispose(); });

async function select(value: TreeSitterEngine, languageId: string, text: string, offset: number, operation: SyntaxOperation, version = 1, id = "model"): Promise<SyntaxResult | null> {
  return value.provide({ document: { id, version, text, languageId }, selections: [{ anchor: offset, head: offset + 1 }], operation, signal: new AbortController().signal });
}
function slices(result: SyntaxResult | null, text: string) {
  return result?.selections.map(range => text.slice(Math.min(range.anchor, range.head), Math.max(range.anchor, range.head)));
}
const object = (kind: SyntaxObject, around = true): SyntaxOperation => ({ kind: "object", object: kind, around });

describe("real optional Tree-sitter WASM provider", () => {
  it("selects a C++ function body after Unicode and CRLF on the cold runtime's default budget", async () => {
    // Keep this first: the earlier regression only appeared when C++ was the
    // first grammar parsed, rather than sharing Python's already-warmed runtime.
    const text = "// 한글 👩‍💻\r\nint solve(int value) { return value; }";
    const value = engine({ parseTimeoutMs: undefined });
    expect(slices(await select(value, "cpp", text, text.indexOf("solve"), { kind: "object", object: "function", around: false, count: 1 }), text)).toEqual([" return value; "]);
  });

  it.each([
    ["python", "# 한글 👩‍💻\r\ndef 풀이(a, b):\r\n    return a + b\r\n", "풀이", "def 풀이(a, b):\r\n    return a + b"],
    ["cpp", "// 한글 👩‍💻\r\nint solve(int a, int b) { return a + b; }", "solve", "int solve(int a, int b) { return a + b; }"],
    ["typescript", "// 한글 👩‍💻\r\nfunction solve(a: number, b: number) { return a + b; }", "solve", "function solve(a: number, b: number) { return a + b; }"],
  ])("parses %s functions and returns UTF-16 coordinates after Unicode and CRLF", async (language, text, target, expected) => {
    expect(slices(await select(engine(), language, text, text.indexOf(target), object("function")), text)).toEqual([expected]);
  });

  it.each([
    ["python", "def f(a, b):\n    return a + b", "return a + b"],
    ["cpp", "int f(int a) { return a; }", " return a; "],
    ["typescript", "function f(a: number) { return a; }", " return a; "],
  ])("selects %s function contents from a cursor on its name", async (language, text, expected) => {
    expect(slices(await select(engine(), language, text, text.indexOf("f("), object("function", false)), text)).toEqual([expected]);
  });

  it.each([
    ["python", "compute = lambda first, second: first + second", "first + second", "lambda first, second: first + second"],
    ["python", "async def compute(value):\n    return value", "return", "async def compute(value):\n    return value"],
    ["cpp", "auto compute = [](int value) { return value; };", "return", "[](int value) { return value; }"],
    ["typescript", "function* compute() { yield 1; }", "yield", "function* compute() { yield 1; }"],
    ["typescript", "const compute = async (value: number) => value * 2;", "value *", "async (value: number) => value * 2"],
  ])("selects %s lambda/async/generator functions", async (language, text, target, expected) => {
    expect(slices(await select(engine(), language, text, text.indexOf(target), object("function")), text)).toEqual([expected]);
  });

  it.each([
    ["python", "class A:\n    def f(self):\n        pass", "def f(self):\n        pass"],
    ["cpp", "class A { int x; };", " int x; "],
    ["typescript", "interface A { x: number; }", " x: number; "],
  ])("selects %s type contents", async (language, text, expected) => {
    expect(slices(await select(engine(), language, text, text.indexOf("A"), object("type", false)), text)).toEqual([expected]);
  });

  it.each([
    ["python", "def f(first, second):\n    pass", "first", "first, "],
    ["cpp", "int f(int first, int second) { return 0; }", "first", "int first, "],
    ["typescript", "function f(first: number, second: number) {}", "first", "first: number, "],
  ])("selects %s parameters with their trailing comma", async (language, text, target, expected) => {
    expect(slices(await select(engine(), language, text, text.indexOf(target), object("parameter")), text)).toEqual([expected]);
  });

  it("supports default C++ parameters and the last argument's preceding comma", async () => {
    const text = "int f(int first, int last = 10) { return first; }";
    const value = engine();
    expect(slices(await select(value, "cpp", text, text.indexOf("last"), object("parameter", false)), text)).toEqual(["int last = 10"]);
    expect(slices(await select(value, "cpp", text, text.indexOf("last"), object("parameter")), text)).toEqual([", int last = 10"]);
  });

  it.each([
    ["python", "# 한글", " 한글"], ["cpp", "/* 한글 */", " 한글 "], ["typescript", "// 한글", " 한글"],
  ])("selects %s comment content", async (language, text, expected) => {
    expect(slices(await select(engine(), language, text, 3, object("comment", false)), text)).toEqual([expected]);
  });

  it("handles nested Python functions, counts, and multiple reversed selections", async () => {
    const text = "def outer():\n    def inner():\n        pass\n    return inner()\n";
    const value = engine();
    const offset = text.indexOf("pass");
    const inner = await select(value, "python", text, offset, object("function"));
    expect(slices(inner, text)).toEqual(["def inner():\n        pass"]);
    expect(slices(await select(value, "python", text, offset, { ...object("function"), count: 2 } as SyntaxOperation), text)).toEqual([text.trimEnd()]);
    const result = await value.provide({ document: { id: "model", version: 1, languageId: "python", text },
      selections: [{ anchor: offset + 1, head: offset }, { anchor: 0, head: 1 }], operation: object("function"), signal: new AbortController().signal });
    expect(result!.selections[0].anchor).toBeGreaterThan(result!.selections[0].head);
    expect(slices(result, text)).toEqual(["def inner():\n        pass", text.trimEnd()]);
  });

  it("navigates functions in both directions and leaves a missing target unchanged", async () => {
    const text = "def a():\n    pass\n\ndef b():\n    pass\n";
    const value = engine();
    const next = await select(value, "python", text, 0, { kind: "next", object: "function" });
    expect(next!.selections[0].anchor).toBe(text.indexOf("def b"));
    const previous = await select(value, "python", text, text.indexOf("def b"), { kind: "previous", object: "function" });
    expect(previous!.selections[0].anchor).toBe(0);
    const boundary = await select(value, "python", text, text.indexOf("def b"), { kind: "next", object: "function" });
    expect(boundary!.selections[0].anchor).toBe(text.indexOf("def b"));
  });

  it("fails semantic selection atomically when any cursor has no requested object", async () => {
    const value = engine();
    const text = "outside = 1\ndef f():\n    pass";
    expect(await select(value, "python", text, 0, object("function"))).toBeNull();
    expect(await value.provide({ document: { id: "model", version: 1, languageId: "python", text },
      selections: [{ anchor: 0, head: 1 }, { anchor: text.indexOf("pass"), head: text.indexOf("pass") + 1 }],
      operation: object("function"), signal: new AbortController().signal })).toBeNull();
  });

  it("restores exact selection direction and extent when shrinking parent expansions", async () => {
    const text = "const x = left + right;";
    const value = engine();
    const offset = text.indexOf("left");
    const initial = [{ anchor: offset + 2, head: offset }];
    const request = { document: { id: "model", version: 1, languageId: "typescript", text }, signal: new AbortController().signal };
    const parent = await value.provide({ ...request, selections: initial, operation: { kind: "parent" } });
    expect(parent!.selections).not.toEqual(initial);
    const child = await value.provide({ ...request, selections: parent!.selections, operation: { kind: "child" } });
    expect(child!.selections).toEqual(initial);
  });

  it("selects sibling and child syntax nodes", async () => {
    const text = "call(first, second, third);";
    const value = engine();
    expect(slices(await select(value, "typescript", text, text.indexOf("second"), { kind: "nextSibling" }), text)).toEqual(["third"]);
    expect(slices(await select(value, "typescript", text, text.indexOf("second"), { kind: "previousSibling" }), text)).toEqual(["first"]);
    expect(slices(await select(value, "typescript", text, text.indexOf("second"), { kind: "allSiblings" }), text)).toEqual(["first", "second", "third"]);
    expect(slices(await select(value, "typescript", text, text.indexOf("("), { kind: "allChildren" }), text)).toEqual(["first", "second", "third"]);
  });

  it.each([
    ["python", "def test_solver():\n    assert True", "test_solver"],
    ["typescript", "test('solver', () => true);", "solver"],
  ])("recognizes %s test objects through query predicates", async (language, text, target) => {
    expect(slices(await select(engine(), language, text, text.indexOf(target), object("test")), text)?.[0]).toContain("test");
  });

  it("honors movement capture priority in a host-provided language query", async () => {
    const value = engine({ languages: { python: { wasm: `${root}tree-sitter-python.wasm`, query: "(function_definition name: (identifier) @function.movement) @function.around" } } });
    const text = "def first(): pass\ndef second(): pass";
    const result = await select(value, "python", text, 0, { kind: "next", object: "function" });
    expect(result!.selections[0].anchor).toBe(text.indexOf("first"));
  });

  it("recovers after a cooperative parse time budget is exceeded", async () => {
    const value = engine({ parseTimeoutMs: Number.EPSILON });
    await expect(select(value, "python", "def f():\n    return 1", 4, object("function"))).rejects.toMatchObject({ name: "SyntaxBudgetError", phase: "parse" });
    value.release("model");
    // A separate normally budgeted provider still works with the shared runtime.
    expect(await select(engine(), "python", "def f():\n    return 1", 4, object("function"))).not.toBeNull();
  });

  it("incrementally handles disjoint multi-edits, emoji replacement, undo and model-language changes", async () => {
    const value = engine();
    const before = "# 😀 one\ndef first(a):\n    return a\n\ndef last(b):\n    return b\n";
    await select(value, "python", before, before.indexOf("last"), object("function"));
    const after = before.replace("😀 one", "👩‍💻 한글").replace("first(a)", "start(a, c)").replace("last(b)", "finish(b, d)");
    expect(slices(await select(value, "python", after, after.indexOf("finish"), object("function"), 2), after)).toEqual(["def finish(b, d):\n    return b"]);
    expect(slices(await select(value, "python", before, before.indexOf("last"), object("function"), 3), before)).toEqual(["def last(b):\n    return b"]);
    const ts = "function next() { return 1; }";
    expect(slices(await select(value, "typescript", ts, 10, object("function"), 1), ts)).toEqual([ts]);
  });

  it("rejects unsupported languages, oversized documents, canceled and disposed requests", async () => {
    const value = engine({ maxDocumentLength: 20 });
    expect(await select(value, "rust", "fn main() {}", 1, object("function"))).toBeNull();
    expect(await select(value, "python", "x".repeat(21), 0, object("function"))).toBeNull();
    const signal = new AbortController(); signal.abort();
    expect(await value.provide({ document: { id: "model", version: 1, text: "a", languageId: "python" }, selections: [{ anchor: 0, head: 1 }], operation: { kind: "parent" }, signal: signal.signal })).toBeNull();
    value.dispose();
    expect(await select(value, "python", "def f(): pass", 4, object("function"))).toBeNull();
  });

  it("bounds model sessions, releases parser/tree resources and recovers after release", async () => {
    const value = engine({ maxModels: 1 });
    const text = "def f():\n    pass";
    await select(value, "python", text, 4, object("function"), 1, "first");
    const first = (value as any).sessions.get("first");
    const parserDelete = vi.spyOn(first.parser, "delete"); const treeDelete = vi.spyOn(first.tree, "delete");
    await select(value, "python", text, 4, object("function"), 1, "second");
    expect(parserDelete).toHaveBeenCalledOnce(); expect(treeDelete).toHaveBeenCalledOnce();
    value.release("second");
    expect((value as any).sessions.size).toBe(0);
    expect(await select(value, "python", text, 4, object("function"), 2, "second")).not.toBeNull();
  });

  it("discards a queued request released before it runs", async () => {
    const value = engine();
    const result = select(value, "python", "def f(): pass", 4, object("function"));
    value.release("model");
    expect(await result).toBeNull();
    expect((value as any).requests.size).toBe(0);
  });
});

describe("lazy worker adapter lifecycle", () => {
  it("creates no worker until requested, cleans abort handlers, ignores late results and terminates", async () => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null as any, onerror: null as any, onmessageerror: null as any };
    const factory = vi.fn(() => worker as unknown as Worker);
    const provider = createTreeSitterProvider({ workerFactory: factory });
    expect(factory).not.toHaveBeenCalled();
    const signal = new AbortController();
    const pending = provider.provide({ document: { id: "x", version: 1, text: "x", languageId: "python" }, selections: [{ anchor: 0, head: 1 }], operation: { kind: "parent" }, signal: signal.signal });
    expect(factory).toHaveBeenCalledOnce();
    const config = worker.postMessage.mock.calls[0][0].config;
    expect(config.wasmUrl).toContain("/syntax-assets/tree-sitter.wasm");
    expect(config.languages.cpp.wasm).toContain("/syntax-assets/tree-sitter-cpp.wasm");
    expect(config.parseTimeoutMs).toBe(500);
    signal.abort(); expect(await pending).toBeNull();
    worker.onmessage({ data: { id: 1, result: { version: 1, selections: [] } } });
    provider.release?.("x");
    expect(worker.postMessage).toHaveBeenLastCalledWith({ id: 2, kind: "release", documentId: "x" });
    provider.dispose(); expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("terminates a worker exceeding its deadline and starts a fresh worker for retry", async () => {
    vi.useFakeTimers();
    const workers: any[] = [];
    const factory = vi.fn(() => {
      const worker = { postMessage: vi.fn(), terminate: vi.fn(), onmessage: null, onerror: null, onmessageerror: null };
      workers.push(worker); return worker as unknown as Worker;
    });
    const provider = createTreeSitterProvider({ workerFactory: factory, requestTimeoutMs: 5 });
    const request = { document: { id: "x", version: 1, text: "x", languageId: "python" }, selections: [{ anchor: 0, head: 1 }], operation: { kind: "parent" } as const, signal: new AbortController().signal };
    try {
      const pending = provider.provide(request);
      const rejection = expect(pending).rejects.toThrow("time budget");
      await vi.advanceTimersByTimeAsync(5); await rejection;
      expect(workers[0].terminate).toHaveBeenCalledOnce();
      const retry = provider.provide(request);
      workers[1].onmessage({ data: { id: 2, result: { version: 1, selections: request.selections } } });
      expect(await retry).toEqual({ version: 1, selections: request.selections });
      expect(factory).toHaveBeenCalledTimes(2);
    } finally { provider.dispose(); vi.useRealTimers(); }
  });
});
