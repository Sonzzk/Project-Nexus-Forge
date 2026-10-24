// Content security policy for the renderer (ARCHITECTURE.md section 7). Shared so the main process
// (response header), the Vite build (meta tag) and the tests all read the same text.

export interface CspOptions {
  /** Development server: Vite needs inline scripts for hot reload and a websocket. Never true in a packaged app. */
  dev: boolean;
  /** `frame-ancestors` is ignored (and warned about) in a <meta> element, so the meta variant omits it. */
  meta: boolean;
}

export function buildCsp({ dev, meta }: CspOptions): string {
  const directives = [
    "default-src 'none'",
    dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'",
    dev ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    dev ? "connect-src 'self' ws://localhost:* http://localhost:*" : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (!meta) directives.push("frame-ancestors 'none'");
  return directives.join('; ');
}
