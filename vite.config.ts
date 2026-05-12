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
            // React core — changes least frequently
            if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor'
            // Markdown rendering pipeline (react-markdown + remark + rehype + highlight.js)
            if (
              id.includes('/react-markdown/') ||
              id.includes('/remark-gfm/') ||
              id.includes('/highlight.js/') ||
              id.includes('/lowlight/') ||
              id.includes('/unified/') ||
              id.includes('/micromark') ||
              id.includes('/mdast-util') ||
              id.includes('/hast-util') ||
              id.includes('/unist-util') ||
              id.includes('/bail/') ||
              id.includes('/trough/') ||
              id.includes('/vfile') ||
              id.includes('/property-information/') ||
              id.includes('/comma-separated-tokens/') ||
              id.includes('/space-separated-tokens/') ||
              id.includes('/decode-named-character-reference/') ||
              id.includes('/character-entities/') ||
              id.includes('/trim-lines/') ||
              id.includes('/ccount/') ||
              id.includes('/escape-string-regexp/') ||
              id.includes('/markdown-table/') ||
              id.includes('/zwitch/') ||
              id.includes('/direction/') ||
              id.includes('/is-plain-obj/')
            ) {
              return 'markdown-vendor'
            }
            // Virtualised list
            if (id.includes('/react-virtuoso/')) return 'virtuoso-vendor'
          }
        },
      },
    },
  },
})
