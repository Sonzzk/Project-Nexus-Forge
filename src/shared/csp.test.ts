import { describe, expect, it } from 'vitest';
import { buildCsp } from './csp';

describe('buildCsp', () => {
  it('is strict in production: no inline scripts or styles, no network except itself', () => {
    const csp = buildCsp({ dev: false, meta: false });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    // Styles: our own files and the one fixed Radix scroll-lock style, by hash; never 'unsafe-inline'.
    expect(csp).toMatch(/style-src 'self' ('sha256-[A-Za-z0-9+/=]+' ?)+;/);
    expect(csp).toContain("connect-src 'self';");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe');
    expect(csp).not.toContain('ws:');
  });

  it('allows hot reload only in development', () => {
    const csp = buildCsp({ dev: true, meta: false });
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain('ws://localhost:*');
  });

  it('leaves out frame-ancestors for the meta tag, where browsers ignore it', () => {
    expect(buildCsp({ dev: false, meta: true })).not.toContain('frame-ancestors');
  });
});
