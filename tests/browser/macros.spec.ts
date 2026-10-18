import { expect, test, type Page } from './fixtures';

async function text(page: Page) { return page.evaluate(() => window.editor.getValue()); }
async function documentText(page: Page, value: string) {
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

test('records Q/q editing with native committed Unicode exactly once', async ({ page }) => {
  await documentText(page, 'one two');
  await page.keyboard.type('Qec');
  await page.keyboard.insertText('한글👩‍💻');
  await page.keyboard.press('Escape');
  await page.keyboard.type('Q');
  expect(await page.evaluate(() => window.helix.macros.isRecording)).toBe(false);
  const recorded = await page.evaluate(() => window.helix.macros.get());
  expect(recorded?.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('한글👩‍💻');
  expect(recorded?.some(event => event.type === 'key' && event.key === 'Q')).toBe(false);
  await page.evaluate(() => {
    window.editor.setPosition({ lineNumber: 1, column: window.editor.getValue().indexOf('two') + 1 });
    window.editor.focus();
  });
  await page.keyboard.type('q');
  await expect.poll(() => text(page)).toBe('한글👩‍💻 한글👩‍💻');
  await expect.poll(() => page.evaluate(() => window.helix.macros.isPlaying)).toBe(false);
});

test('records native Insert deletion and movement rather than duplicating typed keys', async ({ page }) => {
  await documentText(page, 'seed');
  await page.keyboard.type('Qiab');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('c');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.type('d');
  await page.keyboard.press('Escape');
  await page.keyboard.type('Q');
  expect(await text(page)).toBe('adcseed');
  await documentText(page, 'seed');
  await page.evaluate(() => window.helix.macros.play());
  expect(await text(page)).toBe('adcseed');
});

test('records a final composition value once and omits intermediate IME updates', async ({ page }) => {
  await documentText(page, 'seed');
  await page.keyboard.type('Qi');
  await page.evaluate(() => {
    const area = window.editor.getDomNode()!.querySelector('textarea.inputarea')!;
    area.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
    area.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: 'ㅎ' }));
    area.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: 'ㅎ', inputType: 'insertCompositionText', isComposing: true }));
    window.editor.executeEdits('test-ime-update', [{ range: new window.monaco.Range(1, 1, 1, 1), text: 'ㅎ' }]);
    area.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: '한' }));
    window.editor.executeEdits('test-ime-update', [{ range: new window.monaco.Range(1, 1, 1, 2), text: '한' }]);
    window.editor.setPosition({ lineNumber: 1, column: 2 });
    area.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '한' }));
    area.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, data: '한', inputType: 'insertText' }));
  });
  await page.keyboard.press('Escape'); await page.keyboard.type('Q');
  const recorded = await page.evaluate(() => window.helix.macros.get());
  expect(recorded?.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('한');
  await documentText(page, 'seed');
  await page.evaluate(() => window.helix.macros.play());
  expect(await text(page)).toBe('한seed');
});

test('preserves normal Insert undo boundaries and dot repeat while replaying a macro', async ({ page }) => {
  await documentText(page, 'seed');
  await page.evaluate(async () => {
    window.helix.macros.set('a', [{ type: 'key', key: 'i' }, { type: 'text', text: 'XY' }, { type: 'key', key: 'esc' }]);
    await window.helix.execute('replay_macro', { register: 'a' });
  });
  expect(await text(page)).toBe('XYseed');
  await page.keyboard.type('u');
  await expect.poll(() => text(page)).toBe('seed');
  await page.keyboard.type('U');
  await expect.poll(() => text(page)).toBe('XYseed');
  await page.keyboard.type('.');
  expect(await text(page)).toBe('XXYYseed');
});

test('uses selected registers and supports nested key and explicit register replays', async ({ page }) => {
  await documentText(page, 'abcd');
  await page.evaluate(() => {
    window.helix.macros.set('b', 'l');
    window.helix.macros.set('a', [{ type: 'replay', register: 'b', count: 2 }]);
  });
  await page.keyboard.type('"aq');
  await expect.poll(() => page.evaluate(() => window.editor.getSelection()!.startColumn)).toBe(3);
  const rejected = await page.evaluate(async () => {
    window.helix.macros.set('a', [{ type: 'replay', register: 'b' }]);
    window.helix.macros.set('b', [{ type: 'replay', register: 'a' }]);
    return window.helix.macros.play('a').then(() => '', error => error.code);
  });
  expect(rejected).toBe('recursive_macro');
});

test('awaits submitted search results before replaying a destructive next step', async ({ page }) => {
  await documentText(page, 'alpha beta');
  await page.evaluate(async () => {
    window.helix.macros.set('a', [
      { type: 'key', key: '/' }, { type: 'prompt', prefix: '/', value: 'beta' }, { type: 'key', key: 'd' },
    ]);
    await window.helix.macros.play('a');
  });
  expect(await text(page)).toBe('alpha ');
});

test('rejects a macro missing its prompt response before a destructive next step', async ({ page }) => {
  await documentText(page, 'alpha beta');
  const error = await page.evaluate(async () => {
    window.helix.macros.set('a', '/d');
    return window.helix.macros.play('a').then(() => '', failure => failure.message);
  });
  expect(error.toLowerCase()).toContain('prompt');
  expect(await text(page)).toBe('alpha beta');
});

test('cancels delayed clipboard playback on Escape and blocks following edits', async ({ page }) => {
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      clipboard: { readText: () => new Promise(resolve => { window.resolveClipboard = resolve; }), writeText: async () => {} },
    });
    window.helix.macros.set('a', '<space>pd');
    Object.assign(window, { macroOutcome: window.helix.macros.play('a').then(() => 'accepted', error => error.name) });
  });
  await page.waitForFunction(() => typeof window.resolveClipboard === 'function');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.resolveClipboard!('STALE'));
  const outcome = await page.evaluate(() => (window as unknown as { macroOutcome: Promise<string> }).macroOutcome);
  expect(outcome).toBe('AbortError');
  expect(await text(page)).toBe('alpha beta\nsecond line\nthird');
});

test('keeps completed registers across model switches but discards unfinished recording', async ({ page }) => {
  const result = await page.evaluate(async () => {
    window.helix.macros.set('a', [{ type: 'key', key: 'i' }, { type: 'text', text: 'A' }, { type: 'key', key: 'esc' }]);
    window.helix.macros.start('b');
    window.helix.macros.record({ type: 'text', text: 'unfinished' });
    const replacement = window.monaco.editor.createModel('NEXT');
    window.editor.setModel(replacement);
    const recording = window.helix.macros.isRecording;
    const unfinished = window.helix.macros.get('b');
    await window.helix.macros.play('a');
    return { recording, unfinished, text: replacement.getValue() };
  });
  expect(result).toEqual({ recording: false, unfinished: undefined, text: 'ANEXT' });
});

test('shares recursion guards between inline keymaps and named macros', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    window.helix.setKeymap({ normal: { z: '@z' } });
    return window.helix.feedKeys('z').then(() => '', failure => failure.code ?? failure.message);
  });
  expect(String(outcome)).toMatch(/recursive|recursion/);
  expect(await text(page)).toBe('alpha beta\nsecond line\nthird');
});

test('defers a keymap command array until its search prompt has successfully committed', async ({ page }) => {
  await documentText(page, 'alpha beta');
  await page.evaluate(() => window.helix.setKeymap({ normal: { z: ['search', 'delete_selection'] } }));
  await page.keyboard.type('z');
  expect(await text(page)).toBe('alpha beta');
  await page.locator('input[aria-label="Helix /"]').fill('beta');
  await page.keyboard.press('Enter');
  await expect.poll(() => text(page)).toBe('alpha ');
  await documentText(page, 'alpha beta');
  await page.keyboard.type('z');
  await page.locator('input[aria-label="Helix /"]').fill('beta');
  await page.keyboard.press('Escape');
  expect(await text(page)).toBe('alpha beta');
  await page.keyboard.type('z');
  await page.locator('input[aria-label="Helix /"]').fill('[');
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.testState.errors.length)).toBeGreaterThan(0);
  expect(await text(page)).toBe('alpha beta');
});

test('records a nested native q call once without expanding generated input', async ({ page }) => {
  await documentText(page, 'seed');
  await page.evaluate(() => window.helix.macros.set('b', [
    { type: 'key', key: 'i' }, { type: 'text', text: 'B' }, { type: 'key', key: 'esc' },
  ]));
  await page.keyboard.type('Q"bq');
  await expect.poll(() => page.evaluate(() => window.helix.macros.isPlaying)).toBe(false);
  await page.keyboard.type('Q');
  expect(await page.evaluate(() => window.helix.macros.get())).toEqual([
    { type: 'key', key: '"' }, { type: 'key', key: 'b' }, { type: 'key', key: 'q' },
  ]);
  expect(await text(page)).toBe('Bseed');
  await documentText(page, 'seed');
  await page.evaluate(() => window.helix.macros.play());
  expect(await text(page)).toBe('Bseed');
});

test('keeps noninteractive asynchronous host commands in sequence', async ({ page }) => {
  await documentText(page, 'seed');
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      onCommand: () => new Promise(resolve => { window.resolveClipboard = () => resolve(); }),
      keymap: { normal: { z: [':wait', 'delete_selection'] } },
    });
    window.helix.macros.set('a', 'z');
    Object.assign(window, { macroOutcome: window.helix.macros.play('a') });
  });
  await page.waitForFunction(() => typeof window.resolveClipboard === 'function');
  expect(await text(page)).toBe('seed');
  await page.evaluate(async () => {
    window.resolveClipboard!('');
    await (window as unknown as { macroOutcome: Promise<void> }).macroOutcome;
  });
  expect(await text(page)).toBe('eed');
});

test('allows a prompt response to release an asynchronous interactive command', async ({ page }) => {
  await documentText(page, 'alpha beta');
  const result = await page.evaluate(async () => {
    const { HelixController, createSession } = await import('/src/controller.ts');
    window.helix.dispose();
    let active = false;
    let submit: (() => void) | undefined;
    const ui = {
      mode() {}, notify() {}, error(error: unknown) { throw error; }, prompt() {},
      promptActive: () => active,
      promptOpened: undefined as (() => void) | undefined,
      promptSettled: undefined as ((accepted: boolean) => void | Promise<void>) | undefined,
      async command() {
        await Promise.resolve(); // Host pickers may open after async preparation.
        active = true;
        ui.promptOpened?.();
        await new Promise<void>(resolve => { submit = resolve; });
        await Promise.resolve();
        window.editor.setSelection(new window.monaco.Selection(1, 7, 1, 11));
      },
      async submitPrompt(value: string) {
        if (!active || value !== 'beta') throw new Error('Invalid picker response');
        active = false;
        submit!();
        await ui.promptSettled?.(true);
      },
    };
    const session = createSession();
    const controller = new HelixController(window.editor, ui, session, false, {
      keymap: { normal: { z: ['host_command', 'delete_selection'] } },
    });
    try {
      session.macros.set('a', [{ type: 'key', key: 'z' }, { type: 'prompt', value: 'beta' }]);
      await session.macros.play('a');
      return window.editor.getValue();
    } finally { controller.dispose(); }
  });
  expect(result).toBe('alpha ');
});
