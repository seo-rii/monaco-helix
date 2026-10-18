import { expect, test, type Page } from './fixtures';

async function documentText(page: Page) {
  return page.evaluate(() => window.editor.getValue());
}

async function selectedText(page: Page) {
  return page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!));
}

async function setDocument(page: Page, text: string) {
  await page.evaluate(value => {
    window.editor.setValue(value);
    window.editor.setPosition({ lineNumber: 1, column: 1 });
    window.editor.focus();
  }, text);
}

async function expectText(page: Page, text: string) {
  await expect.poll(() => documentText(page)).toBe(text);
}

async function submitPrompt(page: Page, text: string) {
  const input = page.locator('#status input');
  await expect(input).toBeFocused();
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixture/');
  await page.waitForFunction(() => window.helix?.getMode() === 'normal');
});

test('selects before changing and groups a change with typed text for undo and redo', async ({ page }) => {
  await expect.poll(() => selectedText(page)).toBe('a');
  await page.keyboard.type('e');
  await expect.poll(() => selectedText(page)).toBe('alpha');
  await page.keyboard.type('c');
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('insert');
  await page.keyboard.type('hello');
  await page.keyboard.press('Escape');
  await expectText(page, 'hello beta\nsecond line\nthird');
  await page.keyboard.type('u');
  await expectText(page, 'alpha beta\nsecond line\nthird');
  await expect.poll(() => selectedText(page)).toBe('alpha');
  await page.keyboard.type('U');
  await expectText(page, 'hello beta\nsecond line\nthird');
});

test('extends selections with counts, cancels pending commands, and deletes selected lines', async ({ page }) => {
  await page.keyboard.type('v2l');
  await expect.poll(() => selectedText(page)).toBe('alp');
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('select');
  await page.keyboard.press('Escape');
  await page.keyboard.type('miw');
  await expect.poll(() => selectedText(page)).toBe('alpha');
  await page.keyboard.type('g');
  await page.keyboard.press('Escape');
  await page.keyboard.type('xx');
  await expect.poll(() => selectedText(page)).toBe('alpha beta\nsecond line\n');
  await page.keyboard.type('d');
  await expectText(page, 'third');
});

test('regex selections edit every match, undo together, and repeat inserted text', async ({ page }) => {
  await setDocument(page, 'foo bar foo');
  await page.keyboard.type('%s');
  await submitPrompt(page, 'foo');
  await expect.poll(() => page.evaluate(() => window.editor.getSelections()!.length)).toBe(2);
  await page.keyboard.type('cbaz');
  await page.keyboard.press('Escape');
  await expectText(page, 'baz bar baz');
  await page.keyboard.type('u');
  await expectText(page, 'foo bar foo');
  await page.keyboard.type(',miw.');
  await expectText(page, 'baz bar foo');
});

test('zero-width regex selections create insertions at both line starts', async ({ page }) => {
  await setDocument(page, 'one\ntwo');
  await page.keyboard.type('%s');
  await submitPrompt(page, '^');
  await expect.poll(() => page.evaluate(() => window.editor.getSelections()!.length)).toBe(2);
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  await expectText(page, '!one\n!two');
});

test('searches forward, repeats, and wraps backward without editing the document', async ({ page }) => {
  await setDocument(page, 'one two\nthree two');
  await page.keyboard.type('/');
  await submitPrompt(page, 'two');
  await expect.poll(() => selectedText(page)).toBe('two');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(1);
  await page.keyboard.type('n');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(2);
  await page.keyboard.type('N');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(1);
  await page.keyboard.type('N');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(2);
  await page.keyboard.type('n');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(1);
  await expectText(page, 'one two\nthree two');
});

test('recovers after an invalid regex and forwards host commands once', async ({ page }) => {
  await page.keyboard.type('%s');
  await submitPrompt(page, '[');
  await expectText(page, 'alpha beta\nsecond line\nthird');
  await page.keyboard.type(':');
  await submitPrompt(page, 'write');
  await expect.poll(() => page.evaluate(() => window.testState.commands)).toEqual(['write']);
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  await expectText(page, '!alpha beta\nsecond line\nthird');
});

test('moves and deletes complete graphemes and treats CRLF as one character', async ({ page }) => {
  await setDocument(page, '👩‍💻é\r\n中');
  await expect.poll(() => selectedText(page)).toBe('👩‍💻');
  await page.keyboard.type('d');
  await expectText(page, 'é\r\n中');
  await page.keyboard.type('f');
  // Playwright sends unmapped Unicode through insertText rather than keydown.
  // Supply the character key explicitly to exercise Helix's find argument.
  await page.evaluate(() => {
    document.querySelector('#editor textarea.inputarea')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: '中', bubbles: true, cancelable: true,
    }));
  });
  await expect.poll(() => selectedText(page)).toBe('é\r\n中');
});

test('replacement uses the document line ending and rejects nonprintable keys', async ({ page }) => {
  await setDocument(page, 'alpha\r\nbeta');
  for (const prefix of ['r', 'ms']) {
    for (const key of ['ArrowRight', 'Backspace', 'Delete', 'Home', 'F2', 'Tab']) {
      await page.keyboard.type('2' + prefix);
      await page.keyboard.press(key);
      await expectText(page, 'alpha\r\nbeta');
    }
  }
  await page.keyboard.type('r');
  await page.keyboard.press('Enter');
  await expectText(page, '\r\nlpha\r\nbeta');
});

test('opens an indented line and undoes the entire insertion', async ({ page }) => {
  await setDocument(page, '  one\n  two');
  await page.keyboard.type('o');
  await page.keyboard.type('below');
  await page.keyboard.press('Escape');
  await expectText(page, '  one\n  below\n  two');
  await page.keyboard.type('u');
  await expectText(page, '  one\n  two');
});

test('blocks unbound text and composition input outside insert mode', async ({ page }) => {
  await page.keyboard.type('qz');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Delete');
  await page.keyboard.press('Tab');
  await expectText(page, 'alpha beta\nsecond line\nthird');
  const composition = await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('#editor textarea.inputarea')!;
    const event = new InputEvent('beforeinput', {
      inputType: 'insertCompositionText', data: '한글', isComposing: true,
      bubbles: true, cancelable: true,
    });
    input.dispatchEvent(event);
    return { readOnly: input.readOnly, prevented: event.defaultPrevented };
  });
  expect(composition).toEqual({ readOnly: true, prevented: true });
  await page.keyboard.type('i');
  await expect(page.locator('#editor textarea.inputarea')).not.toHaveAttribute('readonly');
  await page.keyboard.insertText('한글');
  await page.keyboard.press('Escape');
  await expectText(page, '한글alpha beta\nsecond line\nthird');
  await expect(page.locator('#editor textarea.inputarea')).toHaveAttribute('readonly');
});

test('blocks native deletion and clipboard shortcuts in normal and select modes', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.evaluate(() => navigator.clipboard.writeText('UNEXPECTED'));
  for (const mode of ['normal', 'select']) {
    if (mode === 'select') await page.keyboard.type('v');
    await page.keyboard.press('Control+Backspace');
    await page.keyboard.press('Control+Delete');
    await page.keyboard.press('Control+v');
    await expectText(page, 'alpha beta\nsecond line\nthird');
  }
});

test('does not treat a composing key as a modal command', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('#editor textarea.inputarea')!.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'd', code: 'KeyD', keyCode: 68, isComposing: true, bubbles: true, cancelable: true,
    }));
  });
  await expectText(page, 'alpha beta\nsecond line\nthird');
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('normal');
});

test('read-only editors permit navigation but prevent changes, undo, and insertion', async ({ page }) => {
  await page.evaluate(() => {
    const { editor, monaco } = window;
    editor.executeEdits('test', [{ range: new monaco.Range(1, 1, 1, 1), text: 'kept ' }]);
    editor.pushUndoStop();
    editor.setPosition({ lineNumber: 1, column: 1 });
    editor.updateOptions({ readOnly: true });
  });
  await page.keyboard.type('e');
  await expect.poll(() => selectedText(page)).toBe('kept');
  await page.keyboard.type('dpciruU~');
  await page.keyboard.press('Control+z');
  await expectText(page, 'kept alpha beta\nsecond line\nthird');
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('normal');
});

test('responds to read-only changes while insert mode is active', async ({ page }) => {
  await page.keyboard.type('i');
  await page.evaluate(() => window.editor.updateOptions({ readOnly: true }));
  await expect(page.locator('#editor textarea.inputarea')).toHaveAttribute('readonly');
  await page.keyboard.insertText('blocked');
  await expectText(page, 'alpha beta\nsecond line\nthird');
  await page.evaluate(() => window.editor.updateOptions({ readOnly: false }));
  await page.keyboard.press('Escape');
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  await expectText(page, '!alpha beta\nsecond line\nthird');
});

test('resets mode and pending commands when switching models and tolerates an absent model', async ({ page }) => {
  await page.keyboard.type('i');
  await page.evaluate(() => window.editor.setModel(window.monaco.editor.createModel('other')));
  await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('normal');
  await expect.poll(() => selectedText(page)).toBe('o');
  await page.keyboard.type('m');
  await page.evaluate(() => window.editor.setModel(null));
  await page.keyboard.type('d');
  await page.evaluate(() => {
    window.editor.setModel(window.monaco.editor.createModel('fresh'));
    window.editor.focus();
  });
  await page.keyboard.type('e');
  await expect.poll(() => selectedText(page)).toBe('fresh');
  await expectText(page, 'fresh');
});

test('notifies mode subscribers and stops notifying disposed subscribers', async ({ page }) => {
  await page.evaluate(() => {
    const events = window.testState.modeChanges;
    const disposable = window.helix.onDidChangeMode(mode => events.push('event:' + mode));
    Object.assign(window, { stopModeListener: () => disposable.dispose() });
  });
  await page.keyboard.type('i');
  await page.keyboard.press('Escape');
  await page.keyboard.type('v');
  await expect.poll(() => page.evaluate(() => window.testState.modeChanges.filter(mode => mode.startsWith('event:'))))
    .toEqual(['event:insert', 'event:normal', 'event:select']);
  await page.evaluate(() => (window as unknown as { stopModeListener(): void }).stopModeListener());
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.testState.modeChanges.filter(mode => mode.startsWith('event:'))))
    .toEqual(['event:insert', 'event:normal', 'event:select']);
});

test('disposal restores editor options and native editing while preserving outside focus', async ({ page }) => {
  await page.locator('#outside').focus();
  const restored = await page.evaluate(() => {
    window.helix.dispose();
    window.helix.dispose();
    const { editor, monaco } = window;
    return {
      cursorStyle: editor.getOption(monaco.editor.EditorOption.cursorStyle),
      cursorBlinking: editor.getOption(monaco.editor.EditorOption.cursorBlinking),
      domReadOnly: editor.getOption(monaco.editor.EditorOption.domReadOnly),
      expectedStyle: monaco.editor.TextEditorCursorStyle.Line,
      expectedBlink: monaco.editor.TextEditorCursorBlinkingStyle.Blink,
    };
  });
  await expect(page.locator('#outside')).toBeFocused();
  expect(restored.cursorStyle).toBe(restored.expectedStyle);
  expect(restored.cursorBlinking).toBe(restored.expectedBlink);
  expect(restored.domReadOnly).toBe(false);
  await expect(page.locator('#status input')).toHaveCount(0);
  await page.evaluate(() => {
    window.editor.setSelection(new window.monaco.Selection(1, 1, 1, 1));
    window.editor.focus();
  });
  await page.keyboard.type('Z');
  await expectText(page, 'Zalpha beta\nsecond line\nthird');
});

for (const change of ['model', 'selection', 'content', 'dispose', 'escape', 'readonly', 'mode'] as const) {
  test(`ignores a delayed clipboard response after ${change} changes`, async ({ page }) => {
    await page.evaluate(() => {
      window.clipboardReads = 0;
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          readText() {
            window.clipboardReads!++;
            return new Promise<string>(resolve => { window.resolveClipboard = resolve; });
          },
        },
      });
    });
    await page.keyboard.press('Space');
    await page.keyboard.type('p');
    await expect.poll(() => page.evaluate(() => window.clipboardReads)).toBe(1);
    if (change === 'escape') await page.keyboard.press('Escape');
    if (change === 'mode') await page.keyboard.type('i');
    await page.evaluate(kind => {
      const { editor, monaco } = window;
      if (kind === 'model') editor.setModel(monaco.editor.createModel(editor.getValue()));
      else if (kind === 'selection') editor.setPosition({ lineNumber: 2, column: 1 });
      else if (kind === 'content') editor.executeEdits('test', [{ range: new monaco.Range(3, 1, 3, 1), text: 'edited ' }]);
      else if (kind === 'dispose') window.helix.dispose();
      else if (kind === 'readonly') editor.updateOptions({ readOnly: true });
      window.resolveClipboard!('UNEXPECTED');
    }, change);
    // Flush the clipboard promise and any editor work it scheduled.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expectText(page, change === 'content'
      ? 'alpha beta\nsecond line\nedited third'
      : 'alpha beta\nsecond line\nthird');
  });
}
