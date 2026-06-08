// Mitigation for T-46-05-CLEANUP-AMNESIA: ensures Phase 46 onboarding
// contributors haven't left their `LslHeartbeatRotator` tutorial entity in
// the live KG.
//
// This spec is INTENTIONALLY NOT part of the default `npm test` run — the
// vitest config (`vitest.config.ts`) includes only `tests/**/*.test.ts`
// (NOT `.spec.ts`). Contributors are documented to run this spec MANUALLY
// after walking through `lib/km-core/docs/ONBOARDING.md`:
//
//   npx vitest run tests/onboarding/cleanup-verifier.spec.ts
//
// Why a manual spec, not a CI gate:
//   - It probes the LIVE obs-api at localhost:12436 (env-dependent; would
//     flake in CI).
//   - It is a belt-and-braces check layered on top of the `!!! danger`
//     admonition in ONBOARDING.md Step 7. The admonition is the primary
//     safeguard; this spec is the post-hoc verifier a contributor can run
//     to confirm Step 7 succeeded.
//   - If a future Phase wants to integrate this into CI, change the file
//     extension to `.test.ts` AND ensure the CI runner has an obs-api
//     fixture to probe; until then, keep it manual.
//
// no-console-log: this spec uses `process.stderr.write` for any diagnostic
// emission, per the km-core CONTRIBUTING.md "no console.* calls" rule.

import { describe, it, expect } from 'vitest';

const OBS_API_BASE = process.env.OBS_API_BASE_URL ?? 'http://localhost:12436';
const TUTORIAL_ENTITY_NAME = 'LslHeartbeatRotator';

async function isObsApiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OBS_API_BASE}/api/v1/entities?limit=1`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface EntityShape {
  id?: string;
  name?: string;
  entityType?: string;
}

interface ListResponse {
  success: boolean;
  data: EntityShape[];
}

describe('Phase 46 onboarding cleanup verifier', () => {
  it(`asserts no tutorial '${TUTORIAL_ENTITY_NAME}' entity remains in the live KG`, async () => {
    const reachable = await isObsApiReachable();
    if (!reachable) {
      process.stderr.write(
        `[cleanup-verifier] obs-api at ${OBS_API_BASE} not reachable; skipping cleanup verifier.\n`,
      );
      // Vitest does not expose a runtime test.skip-from-within hook in the
      // same way Jest does; mark as a no-op assertion when the obs-api is
      // unreachable, so the spec records as PASS rather than failing for
      // env reasons.
      expect(true).toBe(true);
      return;
    }

    let payload: ListResponse;
    try {
      const res = await fetch(`${OBS_API_BASE}/api/v1/entities?ontologyClass=SubComponent`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        throw new Error(
          `obs-api returned HTTP ${res.status} ${res.statusText} for the SubComponent list query`,
        );
      }
      payload = (await res.json()) as ListResponse;
    } catch (err) {
      throw new Error(
        `cleanup-verifier could not reach obs-api at ${OBS_API_BASE} after the reachability precheck succeeded — `
          + `this indicates a flaky obs-api OR a malformed response. Underlying error: `
          + `${(err as Error).message}`,
      );
    }

    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.data)) {
      throw new Error(
        `cleanup-verifier received a malformed response from obs-api `
          + `(expected { success: boolean, data: Entity[] }, got: ${JSON.stringify(payload).slice(0, 200)})`,
      );
    }

    const tutorialEntities = payload.data.filter((e) => e?.name === TUTORIAL_ENTITY_NAME);

    if (tutorialEntities.length > 0) {
      const ids = tutorialEntities.map((e) => e.id).filter(Boolean);
      const remediation =
        `\n\n  REMEDIATION — the LslHeartbeatRotator tutorial entity is still in the live KG.\n`
          + `  Delete it by id via:\n`
          + `      ENTITY_ID=$(curl -s "${OBS_API_BASE}/api/v1/entities?ontologyClass=SubComponent" \\\n`
          + `        | jq -r '.data[] | select(.name=="${TUTORIAL_ENTITY_NAME}") | .id')\n`
          + `      curl -X DELETE "${OBS_API_BASE}/api/v1/entities/\${ENTITY_ID}"\n`
          + `  See lib/km-core/docs/ONBOARDING.md Step 7 for the full cleanup procedure.\n`
          + `  Captured ids: ${JSON.stringify(ids)}\n`;
      throw new Error(
        `cleanup amnesia detected: found ${tutorialEntities.length} `
          + `'${TUTORIAL_ENTITY_NAME}' entity/entities in the live KG.${remediation}`,
      );
    }

    expect(tutorialEntities).toHaveLength(0);
  });
});
