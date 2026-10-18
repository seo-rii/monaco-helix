import { expect, test, type Page } from './fixtures';
import type { editor as MonacoEditor } from 'monaco-editor';

declare global {
  interface Window {
    navigationTest: {
      models: Map<string, MonacoEditor.ITextModel>;
      opened: string[];
      commands: string[];
      queries: string[];
      staleSignal?: AbortSignal;
      resolveQuery?: (items: unknown[]) => void;
      resumeOpen?: () => void;
      pendingOpen?: Promise<void>;
      outcome?: string;
    };
  }
}

async function modelName(page: Page) {
  return page.evaluate(() => window.editor.getModel()!.uri.path.split('/').at(-1));
}
async function prepare(page: Page) {
  await page.evaluate(() => {
    window.helix.dispose();
    const models = new Map(['a', 'b', 'c'].map(name => {
      const model = window.monaco.editor.createModel(`${name}lpha\nsecond\nlast`, 'plaintext', window.monaco.Uri.parse(`inmemory://helix/navigation/${name}`));
      return [model.uri.toString(), model];
    }));
    window.navigationTest = { models, opened: [], commands: [], queries: [] };
    window.editor.setModel([...models.values()][0]!);
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      navigation: { historyLimit: 20, pickerLimit: 5 },
      host: {
        queryFiles(query) {
          window.navigationTest.queries.push(query);
          return [...models.values()].filter(model => model.uri.path.endsWith(query.toLowerCase())).map(model => ({
            id: model.uri.toString(), label: model.uri.path.split('/').at(-1)!.toUpperCase(),
            location: { uri: model.uri.toString(), selections: [{ anchor: 0, head: 1 }] },
          }));
        },
        listBuffers() { return [...models.values()].map(model => ({ id: model.uri.toString(), label: model.uri.path, location: { uri: model.uri.toString(), selections: [{ anchor: 0, head: 1 }] } })); },
        querySymbols() { return [{ id: 'last', label: 'Last line', location: { uri: window.editor.getModel()!.uri.toString(), selections: [{ anchor: 13, head: 14 }] } }]; },
        openLocation(location, context) {
          if (context.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
          const model = models.get(location.uri);
          if (!model || model.isDisposed()) return false;
          window.navigationTest.opened.push(location.uri);
          window.editor.setModel(model);
        },
        executeCommand(command) {
          if (window.editor.getOption(window.monaco.editor.EditorOption.readOnly)) throw new Error('Host rejected a read-only write');
          window.navigationTest.commands.push(command);
        },
      },
      onError(error) { window.testState.errors.push(error.message); },
    });
    window.editor.focus();
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixture/');
  await page.waitForFunction(() => window.helix?.getMode() === 'normal');
  await prepare(page);
});

test('keeps local large jumps useful without a host file change and retains forward history after ordinary motion', async ({ page }) => {
  await page.keyboard.type('ge');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(3);
  await page.keyboard.press('Control+o');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(1);
  await page.keyboard.type('l');
  await page.keyboard.press('Control+i');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(3);
  expect(await page.evaluate(() => window.navigationTest.opened)).toEqual([]);
});

test('restores reverse selections across models and travels forward with real key events', async ({ page }) => {
  await page.evaluate(() => {
    window.editor.setSelection(new window.monaco.Selection(1, 5, 1, 2));
    window.editor.setModel([...window.navigationTest.models.values()][1]!);
    window.editor.focus();
  });
  await page.keyboard.press('Control+o');
  await expect.poll(() => modelName(page)).toBe('a');
  const selection = await page.evaluate(() => {
    const selection = window.editor.getSelection()!;
    return { anchor: selection.selectionStartColumn, head: selection.positionColumn };
  });
  expect(selection).toEqual({ anchor: 5, head: 2 });
  await page.keyboard.press('Control+i');
  await expect.poll(() => modelName(page)).toBe('b');
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('opens files and buffers through keyboard-accessible host pickers', async ({ page }) => {
  await page.keyboard.press('Space');
  await page.keyboard.type('f');
  const input = page.locator('#status input');
  await expect(input).toBeFocused();
  await input.fill('b');
  await expect(page.getByRole('option', { name: 'B', exact: true })).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => modelName(page)).toBe('b');
  await page.evaluate(() => { void window.helix.execute('buffer_picker').catch(error => { if (error.name !== 'AbortError') window.testState.errors.push(error.message); }); });
  await expect(input).toBeFocused();
  await expect(page.getByRole('listbox')).toBeVisible();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('discards out-of-order file query results and cancels without opening a file', async ({ page }) => {
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      host: {
        queryFiles(query, context) {
          window.navigationTest.queries.push(query);
          if (query === 'old') {
            window.navigationTest.staleSignal = context.signal;
            return new Promise(resolve => { window.navigationTest.resolveQuery = resolve; });
          }
          return query === 'new' ? [{ id: 'new', label: 'New result' }] : [];
        },
      },
      onError(error) { window.testState.errors.push(error.message); },
    });
    void window.helix.execute('file_picker').catch(error => { if (error.name !== 'AbortError') window.testState.errors.push(error.message); });
  });
  const input = page.locator('#status input');
  await input.fill('old');
  await expect.poll(() => page.evaluate(() => window.navigationTest.queries.includes('old'))).toBe(true);
  await input.fill('new');
  await expect(page.getByRole('option', { name: 'New result' })).toBeVisible();
  await page.evaluate(() => window.navigationTest.resolveQuery!([{ id: 'stale', label: 'Stale result' }]));
  await expect(page.getByRole('option', { name: 'Stale result' })).toHaveCount(0);
  expect(await page.evaluate(() => window.navigationTest.staleSignal!.aborted)).toBe(true);
  await input.press('Escape');
  expect(await modelName(page)).toBe('a');
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('cancels a delayed host open when an unrelated model is selected', async ({ page }) => {
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      host: {
        async openLocation(location, context) {
          window.navigationTest.opened.push(location.uri);
          window.navigationTest.staleSignal = context.signal;
          await new Promise<void>(resolve => { window.navigationTest.resumeOpen = resolve; });
          if (context.signal.aborted) return false;
          window.editor.setModel(window.navigationTest.models.get(location.uri)!);
        },
      },
    });
    window.editor.setModel([...window.navigationTest.models.values()][1]!);
    window.navigationTest.pendingOpen = window.helix.execute('jump_backward').then(() => { window.navigationTest.outcome = 'accepted'; }, error => { window.navigationTest.outcome = error.name; });
  });
  await expect.poll(() => page.evaluate(() => window.navigationTest.opened.length)).toBe(1);
  await page.evaluate(async () => {
    window.editor.setModel([...window.navigationTest.models.values()][2]!);
    await window.navigationTest.pendingOpen;
    window.navigationTest.resumeOpen!();
  });
  expect(await page.evaluate(() => window.navigationTest.outcome)).toBe('AbortError');
  expect(await page.evaluate(() => window.navigationTest.staleSignal!.aborted)).toBe(true);
  expect(await modelName(page)).toBe('c');
});

test('leaves disposed destinations to the host and preserves read-only command policy', async ({ page }) => {
  await page.evaluate(async () => {
    const models = [...window.navigationTest.models.values()];
    window.editor.setModel(models[1]!);
    models[0]!.dispose();
    await window.helix.execute('jump_backward');
  });
  expect(await modelName(page)).toBe('b');
  const error = await page.evaluate(async () => {
    window.editor.updateOptions({ readOnly: true });
    return window.helix.execute('host_command', { command: 'write' }).then(() => '', failure => failure.message);
  });
  expect(error).toContain('Host rejected');
  expect(await page.evaluate(() => window.navigationTest.commands)).toEqual([]);
  expect(await page.evaluate(() => window.editor.getValue())).toBe('blpha\nsecond\nlast');
});

test('records a picker query and stable selected ID and replays the same symbol before editing', async ({ page }) => {
  await page.evaluate(() => window.helix.macros.start('a'));
  await page.keyboard.press('Space');
  await page.keyboard.type('s');
  const input = page.locator('#status input');
  await input.fill('last');
  await expect(page.getByRole('option', { name: 'Last line' })).toBeVisible();
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => window.editor.getPosition()!.lineNumber)).toBe(3);
  const recorded = await page.evaluate(() => window.helix.macros.stop());
  const response = recorded.find(event => event.type === 'prompt');
  expect(response).toBeDefined();
  if (response?.type !== 'prompt') throw new Error('Picker response was not recorded');
  expect(JSON.parse(response.value)).toEqual({ query: 'last', selectedId: 'last' });
  await page.evaluate(async () => {
    window.editor.setPosition({ lineNumber: 1, column: 1 });
    const events = window.helix.macros.get('a')!;
    window.helix.macros.set('a', [...events, { type: 'key', key: 'd' }]);
    await window.helix.macros.play('a');
  });
  expect(await page.evaluate(() => window.editor.getValue())).toBe('alpha\nsecond\nast');
});

test('rejects a missing picker macro target before a later destructive command', async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    window.helix.macros.set('a', [
      { type: 'key', key: 'space' }, { type: 'key', key: 's' },
      { type: 'prompt', prefix: 'Symbols', value: JSON.stringify({ query: 'last', selectedId: 'missing' }) },
      { type: 'key', key: 'd' },
    ]);
    return window.helix.macros.play('a').then(() => '', error => error.message);
  });
  expect(outcome).toMatch(/not available|not found|missing/i);
  expect(await page.evaluate(() => window.editor.getValue())).toBe('alpha\nsecond\nlast');
  expect(await page.evaluate(() => window.navigationTest.opened)).toEqual([]);
});

test('cancels a picker command array on Escape and rejects unavailable destinations before deletion', async ({ page }) => {
  await page.evaluate(() => window.helix.setKeymap({ normal: { z: ['file_picker', 'delete_selection'] } }));
  await page.keyboard.type('z');
  const input = page.locator('#status input');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.editor.getValue())).toBe('alpha\nsecond\nlast');
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      keymap: { normal: { z: ['file_picker', 'delete_selection'] } },
      host: {
        queryFiles() { return [{ id: 'missing', label: 'Missing file', location: { uri: 'inmemory://missing', selections: [{ anchor: 0, head: 1 }] } }]; },
        openLocation() { return false; },
      },
      onError(error) { window.testState.errors.push(error.message); },
    });
    window.editor.focus();
  });
  await page.keyboard.type('z');
  await expect(page.getByRole('option', { name: 'Missing file' })).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.testState.errors.some(message => message.includes('unavailable')))).toBe(true);
  expect(await page.evaluate(() => window.editor.getValue())).toBe('alpha\nsecond\nlast');
});
