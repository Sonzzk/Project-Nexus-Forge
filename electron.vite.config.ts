import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { buildCsp } from './src/shared/csp';

const alias = { '@shared': resolve(__dirname, 'src/shared') };

// Puts the CSP into index.html: strict when building, loose enough for hot reload on the dev server.
function cspMetaTag(): Plugin {
  return {
    name: 'gdcc-csp-meta',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const csp = buildCsp({ dev: ctx.server !== undefined, meta: true });
        return html.replace(
          '</head>',
          `    <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
        );
      },
    },
  };
}

export default defineConfig({
  main: { resolve: { alias } },
  preload: { resolve: { alias } },
  renderer: {
    resolve: { alias },
    plugins: [react(), cspMetaTag()],
  },
});
