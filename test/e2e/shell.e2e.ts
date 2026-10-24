import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

// Step 5: the shell works in the real app, fits 1280x720, raises no CSP violation, and remembers its layout.

let userData: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-shell-'));
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});
test.describe.configure({ mode: 'serial' });

test('the palette opens from the keyboard, navigates, and the page raises no CSP violation or error', async () => {
  const { app, page } = await launchApp(userData);
  const problems: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || /Content Security Policy/i.test(message.text()))
      problems.push(message.text());
  });
  page.on('pageerror', (error) => problems.push(error.message));
  try {
    await page.keyboard.press('Control+K');
    const input = page.getByRole('combobox', { name: 'Command palette' });
    await input.fill('activity');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Activity and Logs' })).toBeVisible();
    await expect(page.getByText('GameDev Command Center 0.1.0 started.').first()).toBeVisible();

    await page.getByRole('button', { name: 'Project switcher' }).click();
    await expect(page.getByText('No projects registered yet')).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^Implementation Status/ }).click();
    await expect(page.getByRole('region', { name: 'This installation' })).toContainText('schema v');
    expect(problems.join('\n---\n')).toBe('');
  } finally {
    await app.close();
  }
});

test('the layout fits 1280x720 with the inspector open, on both densities', async () => {
  const { app, page } = await launchApp(userData);
  try {
    await app.evaluate(({ BrowserWindow }) => {
      const [window] = BrowserWindow.getAllWindows();
      window?.setSize(1280, 720);
    });
    await page.keyboard.press('Control+J');
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    for (const density of ['comfortable', 'compact']) {
      await page.getByRole('button', { name: /^Settings/ }).click();
      await page.getByLabel(/Interface density/).selectOption(density);
      const fit = await page.evaluate(() => {
        const root = document.documentElement;
        const search = document.querySelector('.topbar__search')?.getBoundingClientRect();
        return {
          overflowX: root.scrollWidth > root.clientWidth,
          overflowY: root.scrollHeight > root.clientHeight,
          width: window.innerWidth,
          height: window.innerHeight,
          searchRight: search?.right ?? Infinity,
        };
      });
      expect(fit.width).toBeLessThanOrEqual(1280);
      expect(fit.height).toBeLessThanOrEqual(720);
      expect(fit.overflowX).toBe(false);
      expect(fit.overflowY).toBe(false);
      expect(fit.searchRight).toBeLessThanOrEqual(fit.width);
    }
    await page.getByLabel(/Interface density/).selectOption('comfortable');
    await page.keyboard.press('Control+J');
  } finally {
    await app.close();
  }
});

test('sidebar, inspector and panel sizes persist across a restart', async () => {
  const first = await launchApp(userData);
  let sizes: string | null;
  try {
    await first.page.keyboard.press('Control+B');
    await first.page.keyboard.press('Control+J');
    const handle = first.page.getByRole('separator', { name: 'Resize inspector' });
    await expect(handle).toBeVisible();
    await handle.focus();
    for (let i = 0; i < 4; i++) await first.page.keyboard.press('ArrowLeft');
    await expect
      .poll(async () => {
        const result = await first.page.evaluate(() => window.api.invoke('settings:get', {}));
        return result.ok ? Object.keys(result.value['ui.layout']).length : 0;
      })
      .toBe(2);
    sizes = await handle.getAttribute('aria-valuenow');
    expect(sizes).not.toBeNull();
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    await expect(second.page.locator('.app')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(second.page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    const handle = second.page.getByRole('separator', { name: 'Resize inspector' });
    const restored = Number(await handle.getAttribute('aria-valuenow'));
    expect(Math.abs(restored - Number(sizes))).toBeLessThan(1);
  } finally {
    await second.app.close();
  }
});
