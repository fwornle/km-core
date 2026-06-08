<!--
OVERRIDE_CONSTRAINT: no-evolutionary-names
Rationale: `LslHeartbeatRotator` is a real architectural name for a tutorial
SubComponent — NOT an "Enhanced"/"v2" rename of an existing entity. The
no-evolutionary-names constraint regex may pattern-match the "Rotator" suffix
(or future contributors may want to rename to "LslHeartbeatRotatorV2" during
the exercise — which the constraint correctly blocks). This override applies
to the prose of this guide AND to any temporary edits a contributor makes
while walking through the exercise. The constraint stays ON for real source
code; this exception is scoped to a tutorial entity that is deleted at Step 7.
-->

# KM-Core Onboarding: The LslHeartbeatRotator Exercise

This guide walks a new KM-Core contributor through the seven verifiable steps that satisfy Phase 46 SC-3: clone the repo, build & test the shared core, inspect the live ontology, ingest a tutorial `SubComponent` entity through the canonical REST surface, verify it in both the API and the Phase 45 unified viewer, and clean it up. Each step has a runnable shell command and an **Expected output** assertion so a contributor knows whether the step worked without re-reading any source code.

For an overview of where KM-Core sits among the consumer systems (`coding`, `mcp-server-semantic-analysis`, `operational-knowledge-management`), see [../README.md](../README.md).

## Step 0 — Prerequisites

Clone the coding repository and initialise all submodules (KM-Core lives at `lib/km-core/`).

```bash
git clone git@github.com:fwornle/coding.git
cd coding
git submodule update --init --recursive
```

**Expected output:** working tree at the repo root with `lib/km-core/` populated (you should see `lib/km-core/src/`, `lib/km-core/tests/`, `lib/km-core/docs/`).

**If this fails:** check that you have SSH access to `github.com:fwornle/km-core.git`. The submodule's `.gitmodules` URL is SSH; if SSH is unavailable, switch to HTTPS with `git config --file .gitmodules submodule.lib/km-core.url https://github.com/fwornle/km-core.git` then re-run the `git submodule update` command.

## Step 1 — Build and test KM-Core

Install KM-Core's own dependencies, compile TypeScript to `dist/`, and run the vitest suite.

```bash
cd lib/km-core
npm install
npm run build
npm test
```

**Expected output:** vitest reports all tests GREEN. The test count varies by phase (≥ 100 tests after Phase 44; ≥ 130 after Phase 45) but the final line should read `Test Files <N> passed (<N>)` and `Tests <M> passed (<M>)` with **zero** failures.

**If this fails:** the most common cause is a stale `dist/` from a prior partial build. Run `npm run clean && npm run build` (if `clean` exists) or `rm -rf dist && npm run build` and retry `npm test`. If a specific test fails, read the test name — it tells you which Phase the regression belongs to.

## Step 2 — Inspect the ontology

KM-Core consumes per-system ontology files; the `coding` system's ontology lives at `.data/ontologies/coding-ontology.json` (relative to the repo root). The tutorial entity is a `SubComponent` instance, so let's look at the `SubComponent` class definition.

```bash
cd /Users/Q284340/Agentic/coding   # back to the outer repo root
cat .data/ontologies/coding-ontology.json | jq '.classes.SubComponent'
```

**Expected output:** a JSON object with a `description` field plus a `properties` object listing `componentName`, `parentComponent`, and `level`:

```json
{
  "description": "A named subsystem (L2) nested within a Component, ...",
  "relationships": {},
  "properties": {
    "componentName": { "type": "string", "description": "PascalCase sub-component name" },
    "parentComponent": { "type": "string", "description": "Name of the L1 parent component" },
    "level": { "type": "number", "description": "Hierarchy level (always 2 for SubComponent)" }
  }
}
```

> **Ontology canon (important):** `LiveLoggingSystem` is a `Component` **instance** in the live knowledge graph — it is NOT an ontology class. The ontology declares only the generic upper-level classes (`Component`, `SubComponent`, `Detail`, etc.); concrete component instances such as `LiveLoggingSystem` are data-instantiated and live in the per-domain export (`general.json`). Therefore the exercise registers a new `SubComponent` **instance** whose `componentName` property *references* `LiveLoggingSystem`. We are NOT adding a new class.

**If this fails:** if `jq` is missing, install it (`brew install jq` on macOS). If `.data/ontologies/coding-ontology.json` is absent, the working tree is incomplete — re-run `git submodule update --init --recursive` and re-clone if necessary.

## Step 3 — Inspect existing LSL SubComponents

The tutorial entity slots in alongside existing `LSL*` SubComponents in the live KG. Inspect them so you know the shape of a real `LiveLoggingSystem`-attached SubComponent before authoring the tutorial one.

```bash
cat .data/knowledge-graph/exports/general.json | \
  jq '.nodes[] | .attributes | select(.entityType == "SubComponent" and (.name | startswith("LSL"))) | {name, componentName, layer}' \
  | head -30
```

**Expected output:** five to eight entries (one per existing LSL* SubComponent) — names such as `LSLConverter`, `LSLConfigValidator`, `LSLFormatter`, `LSLConfigManager` — each with `entityType: "SubComponent"` in the live export.

**If this fails:** if the export file does not exist or `jq` returns nothing, the KG export pipeline has not run on this checkout yet. Start the obs-api (see Step 4) and let the wave-analysis workflow run once, OR start with a freshly-cloned `general.json` from a teammate.

## Step 4 — Ingest the tutorial entity via the obs-api

The canonical write endpoint for new entities (per the Phase 44 wire-shape lock at `lib/km-core/src/api/handlers/entities.ts:107-145`) is **`POST http://localhost:12436/api/v1/entities`** on the host-side obs-api port. Do NOT substitute any other entity write path — the entities handler is the contract.

Make sure the obs-api is running locally:

```bash
curl -s http://localhost:12436/api/v1/entities?limit=1 | jq '.success'
```

**Expected output:** `true` (or `null` if no entities exist yet). If the curl fails with `Connection refused`, the obs-api is not running — start it with `launchctl kickstart -k gui/$(id -u)/com.coding.obs-api` per `CLAUDE.md`.

Now ingest the tutorial entity. **Capture the returned `id` field** — you will need it for the Step 7 cleanup. The id is a UUIDv7 minted server-side.

```bash
INGEST_RESPONSE=$(curl -s -X POST http://localhost:12436/api/v1/entities \
  -H "Content-Type: application/json" \
  -d '{
    "name": "LslHeartbeatRotator",
    "entityType": "SubComponent",
    "ontologyClass": "SubComponent",
    "layer": "evidence",
    "componentName": "LiveLoggingSystem",
    "description": "Tutorial entity from the Phase 46 onboarding guide. Demonstrates rotating LSL heartbeat tokens. Safe to purge — see cleanup step."
  }')
echo "$INGEST_RESPONSE" | jq '.'
export TUTORIAL_ENTITY_ID=$(echo "$INGEST_RESPONSE" | jq -r '.data.id')
echo "Captured tutorial entity id: $TUTORIAL_ENTITY_ID"
```

**Expected output:** a JSON envelope of the form `{"success": true, "data": {"id": "019...", "name": "LslHeartbeatRotator", "entityType": "SubComponent", ...}}`. The `id` is a UUIDv7 starting with `019` (or higher). The final `echo` line should print `Captured tutorial entity id: 019...`. Note the id — you will need it in Step 7.

**If this fails:** a `400` with `name and entityType are required` means the JSON body was malformed (check the heredoc quoting). A `5xx` with `success: false` means the store rejected the entity — check that `componentName` is a string and `layer` is one of the canonical layer values (`evidence`, `assertion`, `hypothesis`).

## Step 5 — Verify via the REST API

Re-query the obs-api to confirm the tutorial entity is persisted and surfaces under the `SubComponent` ontology class filter.

```bash
curl -s 'http://localhost:12436/api/v1/entities?ontologyClass=SubComponent' | \
  jq '.data[] | select(.name == "LslHeartbeatRotator")'
```

**Expected output:** a single JSON object showing the tutorial entity with `id` (matching `$TUTORIAL_ENTITY_ID` from Step 4), `name: "LslHeartbeatRotator"`, `entityType: "SubComponent"`, `componentName: "LiveLoggingSystem"`, and the description from Step 4.

**If this fails:** if the result is empty, the entity is not in the `SubComponent` index. Re-fetch by id directly to see whether it is stored at all: `curl -s "http://localhost:12436/api/v1/entities/$TUTORIAL_ENTITY_ID" | jq '.'`. A `data: null` response means the POST in Step 4 silently failed; re-read its response body.

## Step 6 — Verify via the unified viewer (Phase 45)

The Phase 45 unified viewer surfaces entities visually so you can confirm the tutorial entity is also reachable through the dashboard. The viewer depends on the system-health-dashboard service.

**Precheck — confirm the dashboard is up:**

```bash
curl -s http://localhost:3032/api/health | jq '.status'
```

**Expected output:** `"healthy"` (or `"ok"` depending on the dashboard's contract). If the precheck fails, restart the dashboard service per the system-health-dashboard ops section in [../../CLAUDE.md](../../CLAUDE.md) (typically `docker-compose restart coding-services` after rebuilding the dashboard's `dist/`) before retrying this step. **Treat a failed precheck as an environment problem, not an exercise problem.**

**Open the viewer in your browser:**

```text
http://localhost:3032/viewer/coding
```

**Expected behaviour:**

1. The WebGL graph loads with the live `coding` knowledge graph.
2. Type `LslHeartbeatRotator` into the **FilterRail** search box (top of the left sidebar).
3. The graph highlights the tutorial entity; clicking it opens the `EntityDetailPanel` on the right.
4. The detail panel shows `name: LslHeartbeatRotator`, `entityType: SubComponent`, the description from Step 4, and `componentName: LiveLoggingSystem`.

**If this fails:** if the viewer loads but the tutorial entity is not visible, the viewer's export-watcher has not yet picked up the new entity. The store writes its per-domain JSON exports on a 5-second debounce (see `lib/km-core/docs/puml/km-core-ingest-sequence.puml` for the timing). Wait ~10 seconds and reload the viewer page.

## Step 7 — Cleanup (MANDATORY)

!!! danger "Cleanup is mandatory — DO NOT skip"

    **Skipping this step pollutes the live knowledge graph.** Subsequent
    wave-analysis runs may fuzzy-merge the tutorial entity into a real LSL
    component (the default dedup configuration uses Jaccard 0.45 / containment
    0.7 / 4-keyword floor), corrupting downstream evidence. **The cleanup is a
    surgical DELETE of the tutorial entity by id — NOT a bulk purge.**

    **Do NOT use `scripts/purge-knowledge-entities.js` for this cleanup.** That
    script filters by date + team only, NOT by entity name — running it would
    catastrophically sweep ALL entities created on the tutorial date, not just
    `LslHeartbeatRotator`. The correct cleanup uses the KM-Core REST
    `DELETE /api/v1/entities/{id}` endpoint (handler at
    `lib/km-core/src/api/handlers/entities.ts:186-201`) against the entity's
    UUIDv7 captured at ingest time.

**Step 7a — Preview what will be deleted (safe; no mutation):**

```bash
curl -s "http://localhost:12436/api/v1/entities?ontologyClass=SubComponent" \
  | jq '.data[] | select(.name == "LslHeartbeatRotator") | {id, name}'
```

**Expected output:** a single JSON object with the tutorial entity's UUIDv7 `id` and `name: "LslHeartbeatRotator"`. If the result is empty, the entity is already gone — skip to Step 7c (post-cleanup verification). If you see MORE than one such object, **stop and investigate** — that means a prior tutorial run was not cleaned up; delete each id one at a time.

**Step 7b — Delete by id:**

```bash
ENTITY_ID=$(curl -s "http://localhost:12436/api/v1/entities?ontologyClass=SubComponent" \
  | jq -r '.data[] | select(.name == "LslHeartbeatRotator") | .id')
echo "Deleting entity: $ENTITY_ID"
curl -s -X DELETE "http://localhost:12436/api/v1/entities/${ENTITY_ID}" | jq '.'
```

**Expected output:** `{"success": true, "data": {"deleted": true, "id": "019..."}}` (HTTP 200). If `deleted` is `false`, the id was not found — re-check the preview in Step 7a.

**Step 7c — Post-cleanup verification (mandatory):**

```bash
curl -s "http://localhost:12436/api/v1/entities?ontologyClass=SubComponent" \
  | jq '[.data[] | select(.name == "LslHeartbeatRotator")] | length'
```

**Expected output:** `0`. If the result is not `0`, the delete in Step 7b did not take effect — re-run Step 7b with the explicit `ENTITY_ID` shell variable and check the response body for an error.

**Belt-and-braces — run the cleanup-verifier spec:**

A standalone vitest spec exists to catch the exact failure mode where Step 7 is skipped (cleanup amnesia). Run it after the exercise:

```bash
cd lib/km-core
npx vitest run --config tests/onboarding/vitest.config.ts
```

**Expected output:** the test PASSES — confirming no `LslHeartbeatRotator` entity is present in the live KG. If it FAILS, follow the remediation hint printed in the failure message (which restates the Step 7b DELETE command for copy-paste convenience).

> The dedicated config is required because the default `vitest.config.ts` restricts `include` to `tests/**/*.test.ts` — keeping this `.spec.ts` out of the regular `npm test` run so the CI suite is not coupled to a live obs-api on `localhost:12436`.

## Caveats

These caveats apply to anyone running or amending this exercise. They are deliberately surfaced inline (not as a separate appendix) because each one has bitten a contributor at least once.

1. **Dedup overlap.** The name `LslHeartbeatRotator` was chosen so that the wave-analysis dedup thresholds (Jaccard 0.45 / containment 0.7 / 4-keyword floor) will **not** collapse it into an existing LSL* component. If you rename the tutorial entity (for example to `LSLHeartbeatRotator` — note the case change), re-verify dedup safety against `general.json` BEFORE running Step 4. A future planner amending this guide must repeat that check.

2. **Cleanup is mandatory.** Step 7 is wrapped in a `!!! danger` admonition for a reason: if you skip it, the next `wave-analysis` run will see your tutorial entity and may fuzzy-merge it into a real LSL* component, corrupting the evidence layer. The cleanup-verifier spec (Step 7 belt-and-braces) is a second safety net — run it.

3. **`no-evolutionary-names` override.** The `LslHeartbeatRotator` name will likely pattern-match the `no-evolutionary-names` constraint regex (the suffix `Rotator` and the proximity to LSL-versioning naming patterns are typical false-positive triggers). The HTML override comment at the top of this file (`OVERRIDE_CONSTRAINT: no-evolutionary-names`) documents the rationale. **Do NOT remove the override comment** when amending this guide — it is the operative documentation for downstream contributors who hit the same false positive when authoring or copying the entity.

4. **REST endpoint stability.** Step 4's `POST /api/v1/entities` is locked to the Phase 44 wire shape (see `lib/km-core/src/api/handlers/entities.ts:107-151` and Plan 44-16 SUMMARY). Do NOT substitute a different write path — that endpoint is the only contract this guide assumes. If a future km-core release renames the canonical write endpoint, this entire guide needs a coordinated update, not a one-line patch.

---

*Phase 46 / Plan 05 — Verifiable Onboarding Guide for KM-Core (D-46-04, SC-3)*
