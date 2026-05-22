import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Frontend Vite config. Output goes to dist/client/ so the Node server can
// serve it as static assets after `npm run build`.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3456',
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
            if (/[/\\](react-markdown|remark-gfm|highlight\.js|lowlight|unified|micromark|mdast-util|hast-util|unist-util|bail|trough|vfile|property-information|comma-separated-tokens|space-separated-tokens|decode-named-character-reference|character-entities|trim-lines|ccount|escape-string-regexp|markdown-table|zwitch|direction|is-plain-obj)[/\\]/.test(id)) return 'markdown-vendor'
            if (/[/\\]react-virtuoso[/\\]/.test(id)) return 'virtuoso-vendor'
          }
        },
      },
    },
  },
})
