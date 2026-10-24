import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

// A real HTTP server on 127.0.0.1 that answers with recorded responses from test/fixtures/providers, so adapter tests exercise
// the real `fetch` path (streaming, abort, timeout) without any real provider. Lives under test/ only.

export interface Seen {
  method: string;
  path: string;
  body: unknown;
}

export interface FixtureServer {
  origin: string;
  seen: Seen[];
  /** Replaces the handler for one `METHOD /path`. */
  route(key: string, handler: (req: IncomingMessage, res: ServerResponse, body: unknown) => void): void;
  /** Number of connections the client has closed before the server finished (for cancellation tests). */
  closedEarly(): number;
  close(): Promise<void>;
}

export const fixture = (...parts: string[]): string => readFileSync(join('test', 'fixtures', 'providers', ...parts), 'utf8');

export const sendJson = (res: ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
};

/** Sends `ndjson` one line at a time with a short pause, so a client has time to cancel in the middle. */
export function sendLines(res: ServerResponse, ndjson: string, pauseMs = 5): void {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  const lines = ndjson.split('\n').filter(Boolean);
  let index = 0;
  const next = (): void => {
    if (res.destroyed || res.writableEnded) return;
    if (index >= lines.length) {
      res.end();
      return;
    }
    res.write(`${lines[index++]}\n`);
    setTimeout(next, pauseMs);
  };
  next();
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const seen: Seen[] = [];
  const routes = new Map<string, (req: IncomingMessage, res: ServerResponse, body: unknown) => void>();
  let early = 0;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('close', () => {
      if (!res.writableFinished) early++;
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown = raw === '' ? undefined : raw;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        // keep the raw text
      }
      const key = `${req.method ?? 'GET'} ${req.url ?? '/'}`;
      seen.push({ method: req.method ?? 'GET', path: req.url ?? '/', body });
      const handler = routes.get(key);
      if (handler === undefined) {
        sendJson(res, '{"error":"no such route"}', 404);
        return;
      }
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    route: (key, handler) => void routes.set(key, handler),
    closedEarly: () => early,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
