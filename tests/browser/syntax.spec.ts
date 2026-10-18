import { expect, test } from "./fixtures.js";

test.beforeEach(async ({ request }) => {
  // Discover the optional dependency before opening a page: otherwise Vite's
  // first dependency optimization can reload a running Monaco test document.
  expect((await request.get("/src/tree-sitter.ts")).ok()).toBe(true);
});

test("optional adapter parses all three languages in a real Chromium module worker", async ({ page }) => {
  await page.goto("/tests/fixture/");
  const result = await page.evaluate(async () => {
    const module = await import(/* @vite-ignore */ "/src/tree-sitter.ts");
    const provider = module.createTreeSitterProvider({ assetBaseUrl: `${location.origin}/dist/syntax-assets/` });
    const fixtures = [
      ["python", "# 한글 👩‍💻\r\ndef 풀이(a):\r\n    return a", "풀이"],
      ["cpp", "// 한글 👩‍💻\r\nint solve(int a) { return a; }", "solve"],
      ["typescript", "// 한글 👩‍💻\r\nfunction solve(a: number) { return a; }", "solve"],
    ];
    const result = [];
    try {
      for (const [languageId, text, name] of fixtures) {
        const offset = text.indexOf(name);
        const selected = await provider.provide({ document: { id: languageId, version: 1, languageId, text },
          selections: [{ anchor: offset, head: offset + 1 }], operation: { kind: "object", object: "function", around: true }, signal: new AbortController().signal });
        result.push(selected && text.slice(selected.selections[0].anchor, selected.selections[0].head));
        provider.release(languageId);
      }
      return result;
    } finally { provider.dispose(); }
  });
  expect(result).toEqual(["def 풀이(a):\r\n    return a", "int solve(int a) { return a; }", "function solve(a: number) { return a; }"]);
});

test("module worker handles concurrent models, cancellation, disjoint edits and disposal", async ({ page }) => {
  await page.goto("/tests/fixture/");
  const result = await page.evaluate(async () => {
    const module = await import(/* @vite-ignore */ "/src/tree-sitter.ts");
    const provider = module.createTreeSitterProvider({ assetBaseUrl: `${location.origin}/dist/syntax-assets/` });
    const request = (id: string, text: string, version: number, signal = new AbortController().signal) => provider.provide({
      document: { id, version, languageId: "python", text }, selections: [{ anchor: text.indexOf("return"), head: text.indexOf("return") + 1 }],
      operation: { kind: "object", object: "function", around: true }, signal,
    });
    const text = "# 😀\ndef first(a):\n    return a";
    const abort = new AbortController();
    const canceled = request("canceled", text, 1, abort.signal); abort.abort();
    const first = await Promise.all([request("one", text, 1), request("two", text, 1)]);
    const changed = text.replace("😀", "👩‍💻 한글").replace("first(a)", "second(a, b)").replace("return a", "return a + b");
    const selected = await request("one", changed, 2);
    const value = changed.slice(selected.selections[0].anchor, selected.selections[0].head);
    provider.release("one"); provider.release("two"); provider.dispose();
    return { canceled: await canceled, versions: first.map(value => value.version), value, disposed: await request("one", changed, 3) };
  });
  expect(result).toEqual({ canceled: null, versions: [1, 1], value: "def second(a, b):\n    return a + b", disposed: null });
});

test("built distribution resolves its default worker and WASM assets for all shipped languages", async ({ page, request }) => {
  expect((await request.get("/dist/tree-sitter.js")).ok()).toBe(true);
  await page.goto("/tests/fixture/");
  const result = await page.evaluate(async () => {
    const { createTreeSitterProvider } = await import(/* @vite-ignore */ "/dist/tree-sitter.js");
    // No asset or Worker overrides: these URLs must resolve from the emitted
    // module exactly as they do in the package's exported distribution.
    const provider = createTreeSitterProvider();
    const fixtures = [
      ["python", "# 👩‍💻 한글\r\ndef solve(value):\r\n    return value", "def solve(value):\r\n    return value"],
      ["cpp", "// 👩‍💻 한글\r\nint solve(int value) { return value; }", "int solve(int value) { return value; }"],
      ["typescript", "// 👩‍💻 한글\r\nfunction solve(value: number) { return value; }", "function solve(value: number) { return value; }"],
    ];
    const selected = [];
    try {
      for (const [languageId, text, expected] of fixtures) {
        const offset = text.indexOf("solve");
        const result = await provider.provide({ document: { id: languageId, version: 1, languageId, text },
          selections: [{ anchor: offset, head: offset + 1 }], operation: { kind: "object", object: "function", around: true }, signal: new AbortController().signal });
        selected.push({ actual: result ? text.slice(result.selections[0].anchor, result.selections[0].head) : null, expected });
        provider.release(languageId);
      }
      return selected;
    } finally { provider.dispose(); }
  });
  expect(result).toHaveLength(3);
  for (const value of result) expect(value.actual).toBe(value.expected);
});
