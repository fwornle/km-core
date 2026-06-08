// Standalone vitest config for the Phase 46 onboarding cleanup-verifier spec.
//
// The default `vitest.config.ts` at the km-core root restricts the test
// include glob to `tests/**/*.test.ts`. The cleanup-verifier intentionally
// uses the `.spec.ts` extension so it does NOT run during the default
// `npm test` invocation (which would probe a live obs-api at :12436 and
// flake in CI). Contributors invoke this config explicitly after walking
// through `lib/km-core/docs/ONBOARDING.md`:
//
//   npx vitest run --config tests/onboarding/vitest.config.ts
//
// See cleanup-verifier.spec.ts for the test body and remediation hints.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/onboarding/*.spec.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
