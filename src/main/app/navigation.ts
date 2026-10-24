export const APP_SCHEME = 'app';
export const APP_HOST = 'renderer';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/** True only for pages the window may show: our own `app://renderer` origin, or the dev server while developing. */
export function isAllowedUrl(url: string, devServerUrl: string | undefined): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === `${APP_SCHEME}:`) return parsed.host === APP_HOST;
  if (devServerUrl === undefined) return false;
  try {
    return parsed.origin === new URL(devServerUrl).origin;
  } catch {
    return false;
  }
}
