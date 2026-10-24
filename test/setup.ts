/* eslint-disable @typescript-eslint/no-unnecessary-condition, @typescript-eslint/unbound-method, @typescript-eslint/no-deprecated -- polyfills for jsdom, guarded so a newer jsdom's own versions win */
import { afterEach } from 'vitest';

// Component tests run in jsdom, which lacks a few browser APIs that cmdk and the resizable panels expect.
if (typeof window !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);

  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  window.ResizeObserver ??= ResizeObserverStub;
  Element.prototype.scrollIntoView ??= () => {};
  window.matchMedia ??= ((query: string) =>
    ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}
