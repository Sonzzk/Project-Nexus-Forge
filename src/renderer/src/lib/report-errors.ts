import type { Api } from '@shared/api';

// Sends uncaught renderer errors to main, which logs them redacted and rate-limited (ARCHITECTURE.md section 11).

const cut = (text: string, max: number): string => (text.length > max ? text.slice(0, max) : text);

export function installErrorReporting(api: Api, target: Window = window): void {
  const report = (
    kind: 'error' | 'unhandledrejection',
    message: string,
    stack?: string,
    source?: string,
  ): void => {
    void api.invoke('app:reportRendererError', {
      kind,
      message: cut(message || 'Unknown error', 2000),
      ...(stack === undefined ? {} : { stack: cut(stack, 8000) }),
      ...(source === undefined ? {} : { source: cut(source, 500) }),
    });
  };
  target.addEventListener('error', (event) => {
    report(
      'error',
      event.message,
      event.error instanceof Error ? event.error.stack : undefined,
      event.filename,
    );
  });
  target.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    report(
      'unhandledrejection',
      reason instanceof Error ? reason.message : String(reason),
      reason instanceof Error ? reason.stack : undefined,
    );
  });
}
