import { defineConfig } from 'vitest/config'

// convex-test runs functions against an in-memory deployment. The edge-runtime
// environment mirrors Convex's real function runtime (catches Node-only APIs that
// would fail in production); convex-test must be inlined so Vite transforms it.
export default defineConfig({
  test: {
    environment: 'edge-runtime',
    include: ['convex/**/*.test.ts'],
    server: { deps: { inline: ['convex-test'] } },
  },
})
