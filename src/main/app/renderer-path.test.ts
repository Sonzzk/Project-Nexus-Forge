import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRendererPath } from './renderer-path';

const root = resolve('/tmp/renderer-root');

describe('resolveRendererPath', () => {
  it('serves index.html for the root', () => {
    expect(resolveRendererPath(root, '/')).toBe(resolve(root, 'index.html'));
  });

  it('maps a nested asset into the renderer folder', () => {
    expect(resolveRendererPath(root, '/assets/index-abc.js')).toBe(resolve(root, 'assets/index-abc.js'));
  });

  it.each([
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/..%5csecret.txt',
    '/a%00b.js',
    '/%E0%A4%A',
    '/C:/Windows/win.ini',
  ])('refuses %s', (pathname) => {
    expect(resolveRendererPath(root, pathname)).toBeNull();
  });
});
