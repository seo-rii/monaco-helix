import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, defineConfig } from '@playwright/test';

const port = Number(process.env.HELIX_TEST_PORT ?? 45173);
const baseURL = `http://127.0.0.1:${port}`;

function chromiumExecutable(): string | undefined {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured) return configured;
  if (existsSync(chromium.executablePath())) return undefined;

  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  if (existsSync(cache)) {
    const builds = readdirSync(cache).filter(name => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const binary of ['chrome-linux64/chrome', 'chrome-linux/chrome']) {
        const path = join(cache, build, binary);
        if (existsSync(path)) return path;
      }
    }
  }
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser'].find(path => existsSync(path));
}

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    launchOptions: { executablePath: chromiumExecutable() },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${baseURL}/tests/fixture/`,
    reuseExistingServer: !process.env.CI,
  },
});
