import { _electron as electron } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';

/** Starts the built app (run `npm run build` first) with its data folder redirected to `userData`. */
export async function launchApp(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, GDCC_USER_DATA_DIR: userData },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The first paint asks main for app info; wait until the window shows the database line.
  await page.getByText('Database').waitFor();
  return { app, page };
}
