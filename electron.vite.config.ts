import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: ['@googleapis/calendar', '@googleapis/oauth2', 'express', 'ws', 'toml', 'uuid', 'electron-log', 'encoding']
    })],
    build: {
      rollupOptions: {
        external: ['better-sqlite3', 'bufferutil', 'utf-8-validate']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: './src/renderer/index.html'
      }
    }
  }
})
