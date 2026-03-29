// vitest.config.js
import { defineConfig } from 'vitest/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@helpers': path.resolve(__dirname, 'tests/helpers')
    }
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: ['src/**/*.js'],
      exclude: ['src/index.js'] // entry point difícil de testar em unit tests
    }
  }
})
