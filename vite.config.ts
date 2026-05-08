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
  },
})
