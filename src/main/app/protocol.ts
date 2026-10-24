import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { buildCsp } from '@shared/csp';
import { APP_HOST, APP_SCHEME } from './navigation';
import { resolveRendererPath } from './renderer-path';

/** Must run before the app is ready. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
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
