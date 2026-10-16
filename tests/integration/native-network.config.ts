import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Opt-in only: requires an isolated PostgreSQL socket, temporary TLS certificate
// and an Android instrumentation client. Never included in the ordinary suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/native-network-service.test.ts'],
    testTimeout: 660_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
  resolve: { alias: { '@': fileURLToPath(new URL('../../', import.meta.url)) } },
})
