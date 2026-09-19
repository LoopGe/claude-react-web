import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend Vite config. Output goes to dist/client/ so the Node server can
// serve it as static assets after `npm run build`.
//
// Ports are env-overridable so several git worktrees can run `npm run dev`
// side by side: VITE_PORT picks this dev server's port, and CRW_PORT must
// match the API server's port (see server/cli/args.ts) since /api is proxied
// to it.
const apiPort = Number(process.env.CRW_PORT) || 3456

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.VITE_PORT) || 5174,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // `/api/ws` is a WebSocket upgrade; without ws:true Vite's proxy
        // treats it as plain HTTP and strips the Upgrade header.
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split vendor code into stable chunks that change rarely, so
        // browser caching works across deploys.  React + react-dom are
        // the biggest single slice and change least often; the markdown
        // pipeline and virtualiser are independent feature domains.
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (/[/\\]react-dom[/\\]/.test(id) || /[/\\]react[/\\]/.test(id)) return 'react-vendor'
            if (/[/\\](react-markdown|remark-gfm|remark-breaks|highlight\.js|lowlight|unified|micromark|mdast-util|hast-util|unist-util|bail|trough|vfile|property-information|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities|trim-lines|ccount|escape-string-regexp|markdown-table|zwitch|direction|is-plain-obj)[/\\]/.test(id)) return 'markdown-vendor'
            if (/[/\\]react-virtuoso[/\\]/.test(id)) return 'virtuoso-vendor'
          }
        },
      },
    },
  },
})
