import { describe, expect, it } from 'vitest';
import { isAllowedUrl } from './navigation';

describe('isAllowedUrl', () => {
  it('allows our own pages', () => {
    expect(isAllowedUrl('app://renderer/index.html', undefined)).toBe(true);
    expect(isAllowedUrl('app://renderer/', undefined)).toBe(true);
  });

  it.each([
    'https://example.com/',
    'http://localhost:5173/',
    'file:///C:/Windows/win.ini',
    'app://other/index.html',
    'javascript:alert(1)',
    'data:text/html,<h1>x</h1>',
    'not a url',
    '',
  ])('refuses %s in a built app', (url) => {
    expect(isAllowedUrl(url, undefined)).toBe(false);
  });

  it('allows the dev server only when one is configured', () => {
    expect(isAllowedUrl('http://localhost:5173/index.html', 'http://localhost:5173/')).toBe(true);
    expect(isAllowedUrl('http://localhost:5174/', 'http://localhost:5173/')).toBe(false);
    expect(isAllowedUrl('https://example.com/', 'http://localhost:5173/')).toBe(false);
  });
});
