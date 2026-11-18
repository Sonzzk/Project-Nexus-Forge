import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { net, protocol } from 'electron';
import { PREVIEW_SCHEME } from '@shared/assets';
import { buildCsp } from '@shared/csp';
import { APP_HOST, APP_SCHEME } from './navigation';
import { resolveRendererPath } from './renderer-path';

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/** Serves the built renderer from `app://renderer/` and nothing else. Run once the app is ready. */
export function serveRenderer(rendererRoot: string): void {
  const csp = buildCsp({ dev: false, meta: false });
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const file = url.host === APP_HOST ? resolveRendererPath(rendererRoot, url.pathname) : null;
    if (file === null) return new Response('Not found', { status: 404 });

    let upstream: Response;
    try {
      upstream = await net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 }); // a missing file, not a crash
    }
    const headers = new Headers(upstream.headers);
    headers.set('Content-Security-Policy', csp);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(upstream.body, { status: upstream.status, headers });
  });
}

export function rendererRootFor(mainDir: string): string {
  return join(mainDir, '../renderer');
}

/** What a preview request may reach: an image inside a registered project (`resolve` decides), and nothing else. */
export interface PreviewResolver {
  (requestUrl: string): { ok: true; fullPath: string; mime: string } | { ok: false };
}

/** Serves `gdcc-asset://preview/...` images (spec §17). Every refusal is the same plain 404, so a request learns nothing about other paths. */
export function servePreviews(resolve: PreviewResolver): void {
  protocol.handle(PREVIEW_SCHEME, async (request) => {
    const target = resolve(request.url);
    if (!target.ok) return new Response('Not found', { status: 404 });
    try {
      const body = await readFile(target.fullPath);
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'Content-Type': target.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'no-store' },
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}
