import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { config as dotenvConfig } from 'dotenv'

// Load .env file (gitignored) for build-time credential injection
dotenvConfig()

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({
      exclude: ['@googleapis/calendar', '@googleapis/oauth2', 'express', 'ws', 'toml', 'uuid', 'electron-log', 'encoding']
    })],
    define: {
      'process.env.QUIETCLAW_GOOGLE_CLIENT_ID': JSON.stringify(process.env.QUIETCLAW_GOOGLE_CLIENT_ID ?? ''),
      'process.env.QUIETCLAW_GOOGLE_CLIENT_SECRET': JSON.stringify(process.env.QUIETCLAW_GOOGLE_CLIENT_SECRET ?? '')
    },
    build: {
      rollupOptions: {
        input: {
          index: 'src/main/index.ts',
          'audio-process': 'src/main/audio/audio-process.ts'
        },
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
