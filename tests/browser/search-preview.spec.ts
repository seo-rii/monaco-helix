import { expect, test, type Page } from './fixtures';

async function selected(page: Page) {
  return page.evaluate(() => window.editor.getModel()!.getValueInRange(window.editor.getSelection()!));
}
async function setDocument(page: Page, value: string) {
  await page.evaluate(next => {
    window.editor.setValue(next);
    window.editor.setPosition({ lineNumber: 1, column: 1 });
    window.editor.setScrollTop(0);
    window.editor.focus();
  }, value);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/fixture/');
  await page.waitForFunction(() => window.helix?.getMode() === 'normal');
});

test('shows accessible prefix hints and dismisses them after Escape', async ({ page }) => {
  const hints = page.getByRole('region', { name: 'Available Helix commands' });
  await expect(hints).toBeHidden();
  await page.keyboard.type('g');
  await expect(hints).toBeVisible();
  await expect(hints).toContainText('definition');
  await page.keyboard.press('Escape');
  await expect(hints).toBeHidden();
  expect((await page.evaluate(() => window.helix.setKeymap({ normal: { z: { x: 'no_op' } } }))).ok).toBe(true);
  await page.keyboard.type('z');
  await expect(hints).toBeVisible();
  await expect(hints.getByRole('listitem')).toContainText(['x']);
});

test('previews matches without moving prompt focus and restores the exact viewport on Escape', async ({ page }) => {
  await setDocument(page, 'start\n' + 'middle\n'.repeat(80) + 'needle');
  const original = await page.evaluate(() => ({ selection: window.editor.getSelection()!, scrollTop: window.editor.getScrollTop() }));
  await page.keyboard.type('/');
  const input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('needle');
  await expect.poll(() => selected(page)).toBe('needle');
  await expect(input).toBeFocused();
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect.poll(() => selected(page)).toBe('s');
  const restored = await page.evaluate(() => ({ selection: window.editor.getSelection()!, scrollTop: window.editor.getScrollTop() }));
  expect(restored).toEqual(original);
});

test('retains submitted search history across model changes and restores a recalled draft', async ({ page }) => {
  await setDocument(page, 'one two one');
  await page.keyboard.type('/');
  let input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('two');
  await input.press('Enter');
  await expect.poll(() => selected(page)).toBe('two');
  await page.evaluate(() => {
    window.editor.setModel(window.monaco.editor.createModel('two three two'));
    window.editor.focus();
  });
  await page.keyboard.type('/');
  input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('draft');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('two');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('draft');
  await input.press('Escape');
});

test('waits for IME composition before previewing or submitting a search', async ({ page }) => {
  await setDocument(page, '한글 other 한글');
  await page.keyboard.type('/');
  const input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    (element as HTMLInputElement).value = '한글';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }));
  });
  await expect(input).toBeFocused();
  expect(await selected(page)).toBe('한');
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await expect.poll(() => selected(page)).toBe('한글');
  await input.press('Enter');
  await expect(input).toHaveCount(0);
  expect(await page.evaluate(() => window.editor.getValue())).toBe('한글 other 한글');
});

test('recovers from invalid live regex input without reporting an application error', async ({ page }) => {
  await setDocument(page, 'one two one');
  await page.keyboard.type('/');
  const input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('[');
  await expect(page.locator('#status [data-role="message"]')).toContainText('Invalid regular expression');
  await input.fill('two');
  await expect.poll(() => selected(page)).toBe('two');
  await input.press('Enter');
  await expect.poll(() => selected(page)).toBe('two');
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('terminates an expensive browser regex and keeps later previews responsive', async ({ page }) => {
  await page.evaluate(() => {
    window.helix = window.initHelixMode(window.editor, document.getElementById('status')!, {
      search: { timeoutMs: 150 },
      onError(error) { window.testState.errors.push(error.message); },
    });
    window.editor.focus();
  });
  await setDocument(page, 'a'.repeat(1000) + '!');
  await page.keyboard.type('/');
  const input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('(a+)+$');
  await expect(page.locator('#status [data-role="message"]')).toContainText('budget');
  await input.fill('a');
  await expect.poll(() => selected(page)).toBe('a');
  await expect(page.locator('#status [data-role="message"]')).toContainText('matches');
  await expect(input).toBeFocused();
  await input.press('Escape');
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('discards preview work when the model changes and editing resumes on the new model', async ({ page }) => {
  await setDocument(page, 'a'.repeat(1000) + '!');
  await page.keyboard.type('/');
  const input = page.getByRole('textbox', { name: 'Helix /', exact: true });
  await input.fill('(a+)+$');
  await page.evaluate(() => {
    window.editor.setModel(window.monaco.editor.createModel('NEW'));
    window.editor.focus();
  });
  await expect(input).toHaveCount(0);
  await page.keyboard.type('i!');
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.editor.getValue())).toBe('!NEW');
  expect(await page.evaluate(() => window.testState.errors)).toEqual([]);
});

test('removes matching selections through the inverse regex prompt', async ({ page }) => {
  await setDocument(page, 'foo bar foo');
  await page.evaluate(async () => {
    window.editor.setSelections([
      new window.monaco.Selection(1, 1, 1, 4), new window.monaco.Selection(1, 5, 1, 8), new window.monaco.Selection(1, 9, 1, 12),
    ]);
    await window.helix.execute('remove_selections');
  });
  const input = page.getByRole('textbox', { name: 'Helix Alt-K', exact: true });
  await input.fill('foo');
  await input.press('Enter');
  await expect.poll(() => selected(page)).toBe('bar');
  expect(await page.evaluate(() => window.editor.getSelections()!.length)).toBe(1);
});
