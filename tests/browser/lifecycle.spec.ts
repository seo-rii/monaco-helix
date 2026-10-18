import { expect, test } from './fixtures';

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixture/');
  await page.waitForFunction(() => window.helix?.getMode() === 'normal');
});

test('provides an overlay when no status element is supplied and removes it on disposal', async ({ page }) => {
  await page.evaluate(() => {
    window.helix.dispose();
    window.helix = window.initHelixMode(window.editor);
    window.editor.focus();
  });
  await expect(page.locator('#editor .monaco-helix-status')).toHaveCount(1);
  await page.keyboard.type('i');
  await expect(page.locator('#editor .monaco-helix-status')).toHaveAttribute('data-mode', 'insert');
  await page.evaluate(() => window.helix.dispose());
  await expect(page.locator('#editor .monaco-helix-status')).toHaveCount(0);
  await expect(page.locator('#editor textarea.inputarea')).not.toHaveAttribute('readonly');
});

test('preserves existing content in the supplied status container', async ({ page }) => {
  await page.evaluate(() => {
    window.helix.dispose();
    const status = document.getElementById('status')!;
    const existing = document.createElement('span');
    existing.id = 'existing-status-content';
    existing.textContent = 'Host status';
    status.append(existing);
    window.helix = window.initHelixMode(window.editor, status);
  });
  await expect(page.locator('#existing-status-content')).toHaveText('Host status');
  await expect(page.locator('#status .monaco-helix-status')).toHaveCount(1);
  await page.evaluate(() => window.helix.dispose());
  await expect(page.locator('#existing-status-content')).toHaveText('Host status');
  await expect(page.locator('#status')).toHaveText('Host status');
});

test('reattaching replaces the previous binding and its listeners', async ({ page }) => {
  await page.evaluate(() => {
    const old = window.helix;
    old.onDidChangeMode(mode => window.testState.modeChanges.push('old:' + mode));
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!);
    old.dispose();
    window.editor.focus();
  });
  await expect(page.locator('#status .monaco-helix-status')).toHaveCount(1);
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('!alpha beta\nsecond line\nthird');
  await expect.poll(() => page.evaluate(() => window.testState.modeChanges.filter(mode => mode.startsWith('old:')))).toEqual([]);
});

test('restores the original EditContext option after using the textarea input path', async ({ page }) => {
  const options = await page.evaluate(() => {
    window.helix.dispose();
    window.editor.updateOptions({ editContext: true });
    window.helix = window.initHelixMode(window.editor);
    const attached = window.editor.getRawOptions().editContext;
    window.helix.dispose();
    return { attached, restored: window.editor.getRawOptions().editContext };
  });
  expect(options).toEqual({ attached: false, restored: true });
});

test('keeps registers and search state independent between editor bindings', async ({ page }) => {
  await page.keyboard.type('ey/');
  const prompt = page.locator('#status input');
  await prompt.fill('second');
  await prompt.press('Enter');

  await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'second-editor';
    host.style.cssText = 'width:900px;height:200px';
    document.body.append(host);
    const editor = window.monaco.editor.create(host, {
      value: 'second gamma', editContext: false, minimap: { enabled: false },
      quickSuggestions: false, wordBasedSuggestions: 'off', accessibilitySupport: 'off',
    });
    const binding = window.initHelixMode(editor);
    Object.assign(window, { secondEditor: editor, secondHelix: binding });
    editor.focus();
  });
  await page.keyboard.type('pn');
  const result = await page.evaluate(() => {
    const second = (window as unknown as { secondEditor: typeof window.editor }).secondEditor;
    return {
      value: second.getValue(),
      selection: second.getModel()!.getValueInRange(second.getSelection()!),
    };
  });
  expect(result).toEqual({ value: 'second gamma', selection: 's' });

  await page.keyboard.type('ey');
  await page.evaluate(() => window.editor.focus());
  await page.keyboard.type('ggp');
  await expect.poll(() => page.evaluate(() => window.editor.getValue()))
    .toBe('aalphalpha beta\nsecond line\nthird');
});

test('cleans up every controller when the initial mode callback switches models', async ({ page }) => {
  await page.evaluate(() => {
    window.helix.dispose();
    let switched = false;
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      onModeChange(mode) {
        if (mode === 'normal' && !switched) {
          switched = true;
          window.editor.setModel(window.monaco.editor.createModel('SECOND'));
        }
      },
    });
  });
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('SECOND');
  await page.evaluate(() => {
    window.helix.dispose();
    window.editor.setSelection(new window.monaco.Selection(1, 1, 1, 1));
    window.editor.focus();
  });
  await expect(page.locator('.monaco-helix-status')).toHaveCount(0);
  await expect(page.locator('#editor textarea.inputarea')).not.toHaveAttribute('readonly');
  await page.keyboard.type('d');
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('dSECOND');
});

for (const action of ['model', 'dispose'] as const) {
  test(`stops stale mode notifications when a listener triggers ${action}`, async ({ page }) => {
    await page.evaluate(kind => {
      const binding = window.helix;
      binding.onDidChangeMode(mode => {
        if (mode !== 'insert') return;
        if (kind === 'model') window.editor.setModel(window.monaco.editor.createModel('SECOND'));
        else binding.dispose();
      });
      binding.onDidChangeMode(mode => window.testState.commands.push(mode));
    }, action);
    await page.keyboard.type('i');
    await expect.poll(() => page.evaluate(() => window.testState.commands))
      .toEqual(action === 'model' ? ['normal'] : []);
    if (action === 'model') {
      await expect.poll(() => page.evaluate(() => window.helix.getMode())).toBe('normal');
      await page.keyboard.type('e');
      await expect.poll(() => page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!)))
        .toBe('SECOND');
    } else {
      await page.evaluate(() => {
        window.editor.setSelection(new window.monaco.Selection(1, 1, 1, 1));
        window.editor.focus();
      });
      await page.keyboard.type('d');
      await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('dalpha beta\nsecond line\nthird');
    }
  });
}

test('cancels prompt submission when editor focus switches the model', async ({ page }) => {
  await page.keyboard.type(':');
  const input = page.locator('#status input');
  await expect(input).toBeFocused();
  await input.fill('write');
  await page.evaluate(() => {
    const listener = window.editor.onDidFocusEditorText(() => {
      listener.dispose();
      window.editor.setModel(window.monaco.editor.createModel('REPLACEMENT'));
    });
  });
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('REPLACEMENT');
  await expect.poll(() => page.evaluate(() => window.testState.commands)).toEqual([]);
});

test('prevents controller recreation when disposal triggers a host model switch', async ({ page }) => {
  await page.evaluate(() => {
    const replacement = window.monaco.editor.createModel('SECOND');
    let switched = false;
    const listener = window.editor.onDidChangeCursorSelection(() => {
      if (switched) return;
      switched = true;
      window.editor.setModel(replacement);
    });
    window.helix.dispose();
    listener.dispose();
    window.editor.focus();
  });
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('SECOND');
  await expect(page.locator('.monaco-helix-status')).toHaveCount(0);
  await page.keyboard.type('d');
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('dSECOND');
});

test('preserves a new binding when the host reinitializes during disposal', async ({ page }) => {
  await page.evaluate(() => {
    const old = window.helix;
    let rebound = false;
    const listener = window.editor.onDidChangeCursorSelection(() => {
      if (rebound) return;
      rebound = true;
      window.helix = window.initHelixMode(window.editor, document.getElementById('status')!);
    });
    old.dispose();
    listener.dispose();
    window.editor.focus();
  });
  await expect(page.locator('#status .monaco-helix-status')).toHaveCount(1);
  await expect(page.locator('#editor textarea.inputarea')).toHaveAttribute('readonly');
  await page.keyboard.type('q');
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('alpha beta\nsecond line\nthird');
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('!alpha beta\nsecond line\nthird');
});

for (const invalid of ['keymap', 'chord timeout'] as const) {
  test(`cleans up a failed initial ${invalid} configuration`, async ({ page }) => {
    const outcome = await page.evaluate(kind => {
      window.helix.dispose();
      window.editor.updateOptions({ editContext: true, cursorStyle: 'line' });
      let message = '';
      try {
        window.initHelixMode(window.editor, document.getElementById('status')!, kind === 'keymap'
          ? { keymap: { normal: { d: 'missing_command_for_test' } } }
          : { chordTimeoutMs: -1 });
      } catch (error) { message = (error as Error).message; }
      const result = {
        message,
        statuses: document.querySelectorAll('.monaco-helix-status').length,
        editContext: window.editor.getRawOptions().editContext,
        cursorStyle: window.editor.getRawOptions().cursorStyle,
      };
      // Exercise the textarea path after verifying the original option restoration.
      window.editor.updateOptions({ editContext: false });
      window.editor.setPosition({ lineNumber: 1, column: 1 });
      window.editor.focus();
      return result;
    }, invalid);
    expect(outcome.message).toMatch(invalid === 'keymap' ? /Unsupported command/ : /chordTimeoutMs/);
    expect(outcome).toMatchObject({ statuses: 0, editContext: true, cursorStyle: 'line' });
    await page.keyboard.insertText('Z');
    await expect.poll(() => page.evaluate(() => window.editor.getValue())).toBe('Zalpha beta\nsecond line\nthird');
  });
}
