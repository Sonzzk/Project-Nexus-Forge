import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp } from './launch';

// Step 4: the app creates its database and log on first start, answers typed IPC, rejects bad input, and keeps its data
// across a restart. Every launch uses the same temp data folder, one after the other.

let userData: string;
test.beforeAll(() => {
  userData = mkdtempSync(join(tmpdir(), 'gdcc-e2e-core-'));
});
test.afterAll(() => {
  rmSync(userData, { recursive: true, force: true });
});

test.describe.configure({ mode: 'serial' });

test('first start creates the database and the log, and records app.started', async () => {
  const { app, page } = await launchApp(userData);
  try {
    expect(existsSync(join(userData, 'data', 'gdcc.db'))).toBe(true);
    expect(existsSync(join(userData, 'logs', 'main.log'))).toBe(true);
    expect(existsSync(join(userData, 'backups'))).toBe(false); // a brand-new database needs no backup

    const info = await page.evaluate(() => window.api.invoke('app:getInfo', {}));
    expect(info).toMatchObject({ ok: true, value: { schemaVersion: 1, platform: process.platform } });

    const activity = await page.evaluate(() => window.api.invoke('activity:list', { limit: 10 }));
    expect(activity.ok && activity.value.map((event) => event.kind)).toEqual(['app.started']);
  } finally {
    await app.close();
  }
});

test('IPC rejects malformed input and unknown channels, and rejected calls change nothing', async () => {
  const { app, page } = await launchApp(userData);
  try {
    const results = await page.evaluate(async () => {
      // Bypasses the typed signature, as a hostile or buggy page could.
      const loose = (channel: string, input: unknown): Promise<unknown> =>
        (window.api as unknown as { invoke(channel: string, input: unknown): Promise<unknown> }).invoke(
          channel,
          input,
        );
      let unknownChannel = '';
      try {
        await loose('fs:readFile', { path: 'C:\\Windows\\win.ini' });
      } catch (error) {
        unknownChannel = error instanceof Error ? error.message : String(error);
      }
      return {
        badValue: await loose('settings:set', { key: 'ui.density', value: 'enormous' }),
        badKey: await loose('settings:set', { key: 'not.a.setting', value: 'x' }),
        extraField: await loose('settings:set', { key: 'ui.density', value: 'compact', path: 'C:\\x' }),
        notAnObject: await loose('activity:list', 'everything'),
        unknownChannel,
      };
    });
    for (const key of ['badValue', 'badKey', 'extraField', 'notAnObject'] as const) {
      expect(results[key], key).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    }
    expect(results.unknownChannel).toContain('Unknown channel');

    const settings = await page.evaluate(() => window.api.invoke('settings:get', {}));
    expect(settings).toMatchObject({ ok: true, value: { 'ui.density': 'comfortable' } });
  } finally {
    await app.close();
  }
});

test('settings and activity survive a restart, a clean quit is recorded, and renderer errors reach the log redacted', async () => {
  const first = await launchApp(userData);
  try {
    const set = await first.page.evaluate(() =>
      window.api.invoke('settings:set', { key: 'ui.density', value: 'compact' }),
    );
    expect(set).toMatchObject({ ok: true, value: { 'ui.density': 'compact' } });
    const reported = await first.page.evaluate(() =>
      window.api.invoke('app:reportRendererError', {
        kind: 'error',
        message: 'e2e test report token=abc123456789',
      }),
    );
    expect(reported).toEqual({ ok: true, value: { accepted: true } });
  } finally {
    await first.app.close();
  }

  const second = await launchApp(userData);
  try {
    const settings = await second.page.evaluate(() => window.api.invoke('settings:get', {}));
    expect(settings).toMatchObject({ ok: true, value: { 'ui.density': 'compact' } });

    const activity = await second.page.evaluate(() => window.api.invoke('activity:list', { limit: 50 }));
    const kinds = activity.ok ? activity.value.map((event) => event.kind) : [];
    expect(kinds.filter((kind) => kind === 'app.started')).toHaveLength(4); // every launch so far
    expect(kinds).toContain('app.stopped'); // the shutdown path ran and wrote it before closing the database
  } finally {
    await second.app.close();
  }

  const log = readFileSync(join(userData, 'logs', 'main.log'), 'utf8');
  expect(log).toContain('e2e test report');
  expect(log).not.toContain('abc123456789');
});
