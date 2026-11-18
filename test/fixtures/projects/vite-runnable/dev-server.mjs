// A stand-in for a Vite dev server, for tests that start a real process: it listens on a free loopback port, prints the same kind of
// "Local:" line Vite prints (with terminal colours), and keeps running until it is stopped.
import { createServer } from 'node:http';

const server = createServer((request, response) => response.end('ok'));
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`\u001b[32m  ➜  Local:\u001b[0m   http://localhost:${port}/`);
});
setInterval(() => undefined, 1 << 30);
