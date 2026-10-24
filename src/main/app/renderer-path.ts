import { isAbsolute, relative, resolve } from 'node:path';

/**
 * Maps the path of an `app://renderer/...` URL to a file inside the built renderer folder.
 * Returns null for anything that would leave that folder, so the protocol handler can answer 404.
 */
export function resolveRendererPath(rendererRoot: string, urlPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const requested = decoded.replace(/^[/\\]+/, '') || 'index.html';
  const root = resolve(rendererRoot);
  const file = resolve(root, requested);
  const fromRoot = relative(root, file);
  if (fromRoot === '' || fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  return file;
}
