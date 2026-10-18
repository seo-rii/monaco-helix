import { expect, test, type Page } from "./fixtures.js";

test.beforeEach(async ({ page, request }) => {
  // Pre-discover the optional dependency so Vite does not reload a live test.
  expect((await request.get("/src/tree-sitter.ts")).ok()).toBe(true);
  await page.goto("/tests/fixture/");
  await page.waitForFunction(() => window.helix?.getMode() === "normal");
});

async function fakeSyntax(page: Page, text = "first second third") {
  await page.evaluate(text => {
    window.helix.dispose();
    // Models supplied through create({ value }) belong to the editor and are
    // disposed on setModel. Use an explicitly owned model for replacement tests.
    window.editor.setModel(window.monaco.editor.createModel(text, "plaintext"));
    window.editor.setPosition({ lineNumber: 1, column: 1 });
    const state = { requests: [] as any[], resolve: undefined as any, reject: undefined as any, released: [] as string[], disposed: 0 };
    const provider = {
      provide(request: any) {
        state.requests.push(request);
        return new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
      },
      release(id: string) { state.released.push(id); },
      dispose() { state.disposed++; },
    };
    (window as any).syntaxTest = state;
    (window as any).syntaxProvider = provider;
    window.helix = window.initHelixMode(window.editor, document.getElementById("status")!, {
      syntaxProvider: provider,
      onError(error: Error) { window.testState.errors.push(error.message); },
    } as any);
    window.editor.focus();
  }, text);
}

async function pendingRequest(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as any).syntaxTest.requests.length)).toBe(1);
}

test("an async syntax selection completes before a queued keyboard deletion", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifd");
  await pendingRequest(page);
  expect(await page.evaluate(() => window.editor.getValue())).toBe("first second third");
  await page.evaluate(() => {
    const state = (window as any).syntaxTest;
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
  });
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe("first  third");
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

for (const failure of ["reject", "null", "stale"] as const) {
  test(`a ${failure} syntax response cancels queued deletion`, async ({ page }) => {
    await fakeSyntax(page);
    await page.keyboard.type("mifd");
    await pendingRequest(page);
    await page.evaluate(failure => {
      const state = (window as any).syntaxTest;
      if (failure === "reject") state.reject(new Error("Parser unavailable"));
      else if (failure === "null") state.resolve(null);
      else state.resolve({ version: state.requests[0].document.version + 1, selections: [{ anchor: 6, head: 12 }] });
    }, failure);
    // A subsequent command runs after the failed operation, without releasing
    // the old queued destructive command onto the previous selection.
    await expect.poll(() => page.evaluate(() => window.helix.execute("move_char_right").then(() => true, () => false))).toBe(true);
    expect(await page.evaluate(() => window.editor.getValue())).toBe("first second third");
    expect(await page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!))).toBe("i");
  });
}

test("model replacement cancels pending syntax work and its queued edits", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifd"); await pendingRequest(page);
  await page.evaluate(() => {
    const state = (window as any).syntaxTest;
    const old = window.editor.getModel()!;
    const next = window.monaco.editor.createModel("replacement safe", "plaintext");
    window.editor.setModel(next);
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
    state.old = old;
  });
  await page.evaluate(() => window.helix.execute("move_char_right"));
  expect(await page.evaluate(() => window.editor.getValue())).toBe("replacement safe");
  expect(await page.evaluate(() => (window as any).syntaxTest.old.getValue())).toBe("first second third");
  expect(await page.evaluate(() => (window as any).syntaxTest.requests[0].signal.aborted)).toBe(true);
});

test("an external edit invalidates pending syntax selection and queued deletion", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifd"); await pendingRequest(page);
  await page.evaluate(() => {
    const state = (window as any).syntaxTest;
    window.editor.getModel()!.applyEdits([{ range: new window.monaco.Range(1, 1, 1, 1), text: "new " }]);
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
  });
  await expect.poll(() => page.evaluate(() => window.helix.execute("move_char_right").then(() => true, () => false))).toBe(true);
  expect(await page.evaluate(() => window.editor.getValue())).toBe("new first second third");
});

test("changing the language invalidates a response without requiring a document version change", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifd"); await pendingRequest(page);
  await page.evaluate(() => {
    const state = (window as any).syntaxTest;
    const model = window.editor.getModel()!;
    state.beforeVersion = model.getVersionId();
    window.monaco.editor.setModelLanguage(model, "python");
    state.afterVersion = model.getVersionId();
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
  });
  await expect.poll(() => page.evaluate(() => window.helix.execute("move_char_right").then(() => true, () => false))).toBe(true);
  expect(await page.evaluate(() => window.editor.getValue())).toBe("first second third");
  expect(await page.evaluate(() => (window as any).syntaxTest.beforeVersion === (window as any).syntaxTest.afterVersion)).toBe(true);
});

test("disposing a binding cancels pending work and releases its model without disposing a shared provider", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifd"); await pendingRequest(page);
  const result = await page.evaluate(async () => {
    const state = (window as any).syntaxTest;
    window.helix.dispose();
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
    await Promise.resolve(); await Promise.resolve();
    return { text: window.editor.getValue(), aborted: state.requests[0].signal.aborted, released: state.released, disposed: state.disposed };
  });
  expect(result.text).toBe("first second third"); expect(result.aborted).toBe(true);
  expect(result.released).toHaveLength(1); expect(result.disposed).toBe(0);
});

test("two editors sharing a model and provider receive independent syntax session IDs", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.helix.dispose();
    const ids: string[] = []; const releases: string[] = [];
    const provider = { provide: async (request: any) => {
      ids.push(request.document.id); return { version: request.document.version, selections: request.selections };
    }, release(id: string) { releases.push(id); } };
    const host = document.createElement("div"); host.style.cssText = "width:500px;height:200px"; document.body.append(host);
    const second = window.monaco.editor.create(host, { model: window.editor.getModel(), editContext: false });
    const firstBinding = window.initHelixMode(window.editor, undefined, { syntaxProvider: provider } as any);
    const secondBinding = window.initHelixMode(second, undefined, { syntaxProvider: provider } as any);
    await Promise.all([firstBinding.execute("select_textobject_inner", { character: "f" }), secondBinding.execute("select_textobject_inner", { character: "f" })]);
    firstBinding.dispose(); secondBinding.dispose(); second.dispose(); host.remove();
    return { ids, releases };
  });
  expect(result.ids).toHaveLength(2); expect(new Set(result.ids).size).toBe(2);
  expect(result.releases.sort()).toEqual(result.ids.sort());
});

for (const fixture of [
  { language: "python", text: "# 한글 👩‍💻\r\ndef solve(value):\r\n    return value", inside: "return value", around: "def solve(value):\r\n    return value" },
  { language: "cpp", text: "// 한글 👩‍💻\r\nint solve(int value) { return value; }", inside: " return value; ", around: "int solve(int value) { return value; }" },
  { language: "typescript", text: "// 한글 👩‍💻\r\nfunction solve(value: number) { return value; }", inside: " return value; ", around: "function solve(value: number) { return value; }" },
]) {
  test(`public binding uses real ${fixture.language} syntax objects through API and keyboard`, async ({ page }) => {
    await page.evaluate(async fixture => {
      const { createTreeSitterProvider } = await import(/* @vite-ignore */ "/src/tree-sitter.ts");
      window.helix.dispose(); window.editor.setValue(fixture.text);
      window.monaco.editor.setModelLanguage(window.editor.getModel()!, fixture.language);
      const delegate = createTreeSitterProvider({ assetBaseUrl: `${location.origin}/dist/syntax-assets/` });
      (window as any).realSyntax = delegate;
      const diagnostics: any[] = [];
      const cursor = window.editor.onDidChangeCursorSelection(event => diagnostics.push({ type: "cursor", source: event.source, reason: event.reason,
        selections: window.editor.getSelections()!.map(selection => [selection.selectionStartLineNumber, selection.selectionStartColumn, selection.positionLineNumber, selection.positionColumn]) }));
      const provider = { provide: async (request: any) => {
        const result = await delegate.provide(request);
        diagnostics.push({ type: "provider", aborted: request.signal.aborted, version: request.document.version, result });
        return result;
      }, release: (id: string) => delegate.release(id) };
      window.helix = window.initHelixMode(window.editor, document.getElementById("status")!, { syntaxProvider: provider } as any);
      const position = window.editor.getModel()!.getPositionAt(fixture.text.indexOf("solve"));
      window.editor.setPosition(position); window.editor.focus();
      try { await window.helix.execute("select_textobject_inner", { character: "f" }); }
      catch (error) {
        // Preserve whether a cooperative parser budget returned null or a host
        // cursor notification invalidated an otherwise valid syntax result.
        throw new Error(`${String(error)}; syntax diagnostics: ${JSON.stringify(diagnostics)}`);
      } finally { cursor.dispose(); }
    }, fixture);
    expect(await page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!))).toBe(fixture.inside);
    await page.keyboard.type("maf");
    await expect.poll(() => page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!))).toBe(fixture.around);
    await page.evaluate(() => { window.helix.dispose(); (window as any).realSyntax.dispose(); });
  });
}

test("public structured selection commands use provider operations and preserve order", async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.helix.dispose();
    const operations: any[] = [];
    const provider = { provide: async (request: any) => {
      operations.push(request.operation); return { version: request.document.version, selections: request.selections };
    } };
    window.helix = window.initHelixMode(window.editor, undefined, { syntaxProvider: provider } as any);
    for (const command of ["expand_selection", "shrink_selection", "goto_next_function", "select_next_sibling"]) await window.helix.execute(command);
    return operations;
  });
  expect(result.map((value: any) => value.kind)).toEqual(["parent", "child", "next", "nextSibling"]);
  expect(result[2].object).toBe("function");
});

test("buffers native change and its replacement text until async syntax selection commits", async ({ page }) => {
  await fakeSyntax(page);
  await page.keyboard.type("mifchello");
  await pendingRequest(page);
  expect(await page.evaluate(() => window.editor.getValue())).toBe("first second third");
  expect(await page.evaluate(() => window.helix.getMode())).toBe("normal");
  await page.evaluate(() => {
    const state = (window as any).syntaxTest;
    state.resolve({ version: state.requests[0].document.version, selections: [{ anchor: 6, head: 12 }] });
  });
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe("first hello third");
  expect(await page.evaluate(() => window.helix.getMode())).toBe("insert");
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});
