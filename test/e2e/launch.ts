import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/** Starts the built app (run `npm run build` first) with its data folder redirected to `userData`. */
export async function launchApp(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, GDCC_USER_DATA_DIR: userData, GDCC_TEST_NO_RELAUNCH: '1' },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The shell appears once the settings have loaded through IPC.
  await page.getByRole('navigation', { name: 'Main' }).waitFor();
  return { app, page };
}
