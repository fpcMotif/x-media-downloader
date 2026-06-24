import { defineConfig } from 'vitest/config'
import { WxtVitest } from 'wxt/testing/vitest-plugin'

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // The coverage gate measures the business logic — the pure reducers,
      // adapters, and ports under `src/core/**` plus the `src/lib/**` helpers,
      // which are fully unit-testable and held at 100%. Presentational UI
      // (`src/components/**`, vendored shadcn + icons) and the MV3 entrypoint
      // glue (`src/entrypoints/**`: the background service-worker lifecycle,
      // content scripts, offscreen document, and Preact views) are exercised by
      // the real extension, not unit tests, and are out of the gate by design.
      // The Convex backend has its own gate in `backend/` (also 100%).
      include: ['src/core/**/*.{ts,tsx}', 'src/lib/**/*.{ts,tsx}'],
      exclude: ['**/*.{test,spec}.{ts,tsx}', '**/*.d.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
    },
  },
})
