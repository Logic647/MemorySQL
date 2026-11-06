import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // CJS preload so the renderer can run sandboxed (ESM preload requires sandbox: false)
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    plugins: [react()],
    build: {
      // electron-vite defaults minify to false for every target; the renderer
      // ships to disk and is parsed on every cold start, so compress it
      minify: 'esbuild'
    }
  }
})
