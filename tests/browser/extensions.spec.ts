import { expect, test, type Page } from './fixtures';

async function text(page: Page) { return page.evaluate(() => window.editor.getValue()); }
async function setDocument(page: Page, value: string) {
  await page.evaluate(next => {
    window.editor.setValue(next);
    window.editor.setPosition({ lineNumber: 1, column: 1 });
    window.editor.focus();
  }, value);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixture/');
  await page.waitForFunction(() => window.helix?.getMode() === 'normal');
});

test('executes discoverable public commands and rejects unknown commands without losing editing', async ({ page }) => {
  const commands = await page.evaluate(() => window.helix.listCommands());
  expect(new Set(commands.map(command => command.id)).size).toBe(commands.length);
  expect(commands.map(command => command.id)).toEqual(expect.arrayContaining([
    'move_next_word_end', 'delete_selection', 'surround_delete', 'surround_replace', 'merge_selections',
  ]));
  const result = await page.evaluate(async () => {
    await window.helix.execute('move_next_word_end');
    const selection = window.editor.getModel()!.getValueInRange(window.editor.getSelection()!);
    const unknown = await window.helix.execute('missing_command_for_test').then(() => '', error => String(error.message));
    await window.helix.execute('delete_selection');
    return { selection, unknown, mode: window.helix.getMode() };
  });
  expect(result).toMatchObject({ selection: 'alpha', mode: 'normal' });
  expect(result.unknown).toContain('Unknown command');
  expect(await text(page)).toBe(' beta\nsecond line\nthird');
});

test('preserves host shortcuts through shouldHandleKey and pass-through mappings', async ({ page }) => {
  await page.evaluate(async () => {
    const source = '/src/index.ts';
    const { initHelixMode } = await import(source);
    window.helix = initHelixMode(window.editor, document.getElementById('status')!, {
      shouldHandleKey: (event: KeyboardEvent) => event.key !== 'F6',
      keymap: { normal: { 'C-Enter': 'pass_through' } },
    });
    const received: string[] = [];
    Object.assign(window, { receivedHostKeys: received });
    window.editor.addAction({
      id: 'test.host.f6', label: 'Host F6', keybindings: [window.monaco.KeyCode.F6],
      run() { received.push('F6'); },
    });
    window.editor.addAction({
      id: 'test.host.ctrl-enter', label: 'Host Ctrl Enter',
      keybindings: [window.monaco.KeyMod.CtrlCmd | window.monaco.KeyCode.Enter],
      run() { received.push('Enter'); },
    });
    window.editor.focus();
  });
  await page.keyboard.press('F6');
  await page.keyboard.press('Control+Enter');
  expect(await page.evaluate(() => (window as unknown as { receivedHostKeys: unknown[] }).receivedHostKeys))
    .toEqual(['F6', 'Enter']);
  expect(await text(page)).toBe('alpha beta\nsecond line\nthird');
});

test('updates nested keymaps atomically and retains the previous map after invalid commands', async ({ page }) => {
  const update = await page.evaluate(() => window.helix.setKeymap({ normal: { x: 'no_op', z: { x: 'delete_selection' } } }));
  expect(update.ok).toBe(true);
  await page.keyboard.type('x');
  expect(await text(page)).toBe('alpha beta\nsecond line\nthird');
  const invalid = await page.evaluate(() => window.helix.setKeymap({ normal: { d: 'missing_command_for_test' } }));
  expect(invalid.ok).toBe(false);
  expect(invalid.diagnostics.length).toBeGreaterThan(0);
  await page.keyboard.type('x');
  expect(await text(page)).toBe('alpha beta\nsecond line\nthird');
  await page.keyboard.type('zx');
  expect(await text(page)).toBe('lpha beta\nsecond line\nthird');
});

test('uses an insert-mode prefix mapping without dropping unmatched typed characters', async ({ page }) => {
  await setDocument(page, 'body');
  expect((await page.evaluate(() => window.helix.setKeymap({ insert: { j: { k: 'normal_mode' } } }))).ok).toBe(true);
  await page.keyboard.type('i!jk');
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('normal');
  expect(await text(page)).toBe('!body');
  await setDocument(page, 'body');
  await page.keyboard.type('ija');
  expect(await text(page)).toBe('jabody');
  await page.keyboard.press('Escape');
});

test('replaces and removes surrounds with real key sequences and one-step undo', async ({ page }) => {
  await setDocument(page, '(👩‍💻é)\r\nnext');
  await page.keyboard.type('lmr([');
  expect(await text(page)).toBe('[👩‍💻é]\r\nnext');
  await page.keyboard.type('u');
  expect(await text(page)).toBe('(👩‍💻é)\r\nnext');
  await page.keyboard.type('md(');
  expect(await text(page)).toBe('👩‍💻é\r\nnext');
  await page.keyboard.type('u');
  expect(await text(page)).toBe('(👩‍💻é)\r\nnext');
});

test('replaces nested surrounds across selections as one edit and preserves the primary merge direction', async ({ page }) => {
  await setDocument(page, '((a)b)');
  await page.evaluate(async () => {
    window.editor.setSelections([
      new window.monaco.Selection(1, 3, 1, 4), new window.monaco.Selection(1, 5, 1, 6),
    ]);
    await window.helix.execute('surround_replace', { character: '(', replacement: '[' });
  });
  expect(await text(page)).toBe('[[a]b]');
  await page.evaluate(() => window.helix.execute('undo'));
  expect(await text(page)).toBe('((a)b)');
  await setDocument(page, '0123456789');
  const merged = await page.evaluate(async () => {
    window.editor.setSelections([
      new window.monaco.Selection(1, 9, 1, 7), new window.monaco.Selection(1, 2, 1, 4),
    ]);
    await window.helix.execute('merge_selections');
    const selection = window.editor.getSelection()!;
    return { count: window.editor.getSelections()!.length, anchor: selection.selectionStartColumn, head: selection.positionColumn };
  });
  expect(merged).toEqual({ count: 1, anchor: 9, head: 2 });
});

test('deletes without yanking while retaining the existing unnamed register', async ({ page }) => {
  await setDocument(page, 'keep drop');
  await page.evaluate(async () => {
    window.editor.setSelection(new window.monaco.Selection(1, 1, 1, 5));
    await window.helix.execute('yank');
    window.editor.setSelection(new window.monaco.Selection(1, 6, 1, 10));
    await window.helix.execute('delete_selection_noyank');
    window.editor.setSelection(new window.monaco.Selection(1, 1, 1, 5));
    await window.helix.execute('replace_with_yanked');
  });
  expect(await text(page)).toBe('keep ');
});

test('honors read-only changes for public edits while navigation remains available', async ({ page }) => {
  await setDocument(page, '(hello)');
  const result = await page.evaluate(async () => {
    window.editor.updateOptions({ readOnly: true });
    const error = await window.helix.execute('surround_delete', { character: '(' }).then(() => '', failure => String(failure.message));
    await window.helix.execute('move_char_right');
    return { error, column: window.editor.getPosition()!.column, mode: window.helix.getMode() };
  });
  expect(result.error).toContain('Read-only');
  expect(result.mode).toBe('normal');
  expect(result.column).toBeGreaterThan(1);
  expect(await text(page)).toBe('(hello)');
});

test('cancels a custom clipboard request before a delayed value can edit the next model', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const source = '/src/index.ts';
    const { initHelixMode } = await import(source);
    const previous = window.monaco.editor.createModel(window.editor.getValue());
    window.editor.setModel(previous);
    let resolve!: (value: string) => void;
    const pending = new Promise<string>(yes => { resolve = yes; });
    window.helix = initHelixMode(window.editor, document.getElementById('status')!, {
      clipboard: { readText: () => pending, writeText: async () => {} },
    });
    const paste = window.helix.execute('paste_clipboard_before').then(() => 'accepted', error => error.name);
    const next = window.monaco.editor.createModel('NEXT');
    window.editor.setModel(next);
    resolve('STALE');
    const outcome = await paste;
    const values = { outcome, old: previous.getValue(), current: next.getValue() };
    previous.dispose();
    return values;
  });
  expect(result).toEqual({ outcome: 'AbortError', old: 'alpha beta\nsecond line\nthird', current: 'NEXT' });
});
