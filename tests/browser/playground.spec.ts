import { expect, test } from './fixtures';

test('the usage playground displays modes and supports disabling and re-enabling Helix', async ({ page }) => {
  await page.goto('/');
  const mode = page.locator('#status .monaco-helix-status');
  const toggle = page.locator('#toggle');
  const input = page.locator('#editor textarea.inputarea');
  await expect(mode).toHaveAttribute('data-mode', 'normal');
  await page.keyboard.type('i');
  await expect(mode).toHaveAttribute('data-mode', 'insert');
  await page.keyboard.press('Escape');
  await expect(mode).toHaveAttribute('data-mode', 'normal');

  await toggle.click();
  await expect(toggle).toHaveText('Enable Helix');
  await expect(mode).toHaveCount(0);
  // Disposal restores Monaco's original input path, which can be EditContext.
  await expect(page.locator('#editor [role="textbox"]')).toBeFocused();
  await page.keyboard.type('!');
  await expect(page.locator('#editor .view-line').first()).toContainText('!//');
  await toggle.click();
  await expect(toggle).toHaveText('Disable Helix');
  await expect(mode).toHaveAttribute('data-mode', 'normal');
  await expect(input).toHaveAttribute('readonly');
  await page.keyboard.type('i');
  await expect(mode).toHaveAttribute('data-mode', 'insert');
});
