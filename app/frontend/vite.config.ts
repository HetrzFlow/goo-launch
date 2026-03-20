import { defineConfig } from 'vite'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    // @x402/extensions imports Node.js crypto (server-side code, never
    // called client-side). Polyfill so Vite/Rollup doesn't fail.
    nodePolyfills({ include: ['crypto'] }),
  ],
  build: {
    outDir: '../public',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        login: 'login.html',
        launch: 'launch.html',
        agent: 'agent.html',
        dashboard: 'dashboard.html',
        all: 'all.html',
        docs: 'docs.html',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ping': 'http://localhost:8787',
    },
  },
})
