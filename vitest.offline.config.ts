import { defineConfig } from 'vitest/config'
import path from 'node:path'
export default defineConfig({
  test: { environment: 'node', include: ['tests/integration/offline-service.test.ts'], testTimeout: 60_000, hookTimeout: 60_000 },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
})
