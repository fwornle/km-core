<!--
OVERRIDE_CONSTRAINT: documentation-filename-format
Rationale: README-TEMPLATE.md is a canonical README skeleton. The uppercase
"TEMPLATE" suffix is deliberate and is consumed by the project's planning
record. Do not rename or lowercase the suffix without coordinating across the
shipped per-system READMEs that reference this file.
-->

# {System Name}

> One-sentence role in the KM unification — describe what this system OWNS (or, for the shared core, write "KM-Core is the SHARED CORE — owns no per-system config").

## Configurations Owned

- **Ontology:** `{path/to/ontology.json}` — {what classes live here, or "— (owned by `{other-system-name}`)"}
- **LLM providers:** `{path/to/llm-config}` — {which provider config files, or "— (owned by `{other-system-name}`)"}
- **Ingest adapters:** `{path/to/adapter}` — {which event sources / writers, or "— (owned by `{other-system-name}`)"}
- **Domain eval / dedup:** `{path/to/dedup-or-scoring}` — {system-specific scoring logic, or "— (owned by `{other-system-name}`)"}

For slots the system does NOT own: write `— (owned by {other-system-name})` rather than omitting the line, so the ownership contract is visible at a glance. Reference systems by their concrete repo/package name (e.g., `coding`, `mcp-server-semantic-analysis`, `operational-knowledge-management`), not by internal milestone shorthand. Likewise reference features by their concrete name (e.g., "the `/api/v1/` REST contract", "the `SnapshotManager` git-tag backend"), not by phase/plan/wave/version shorthand — these READMEs travel with their repos and must read sensibly to a future contributor with no project-internal planning context.

## Architecture

![{System Name} architecture]({relative/path/to/docs/images/system-architecture.png})

<!-- 3-5 sentence summary of the diagram boxes. NOT a long discussion. -->
{Brief box-level summary: which modules talk to which, what flows where, where the trust boundary sits. Keep it factual; deep narrative belongs in a linked companion doc (e.g., AGENTS.md).}

## Where to Edit

| To add… | Edit… | Verify |
|---------|-------|--------|
| A new ontology class | `{path/to/ontology.json}` | `{curl probe or npm test}` |
| A new LLM provider | `{path/to/llm-config}` | `{restart command + probe}` |
| A new ingest source | `{path/to/adapter}` | `{adapter test command}` |
| Domain-specific dedup rule | `{path/to/dedup.ts}` | `{unit test file}` |

Every row MUST give a path AND a verification command — this table is the SC-1 (5-minute discoverability) enforcement surface.

## Related Systems

- [KM-Core](../../lib/km-core/README.md) — shared types / store / REST / viewer
- [coding](../../README.md) — observation source, host runtime
- [mcp-server-semantic-analysis](../../integrations/mcp-server-semantic-analysis/README.md) — agent pipeline, wave-analysis workflow
- [operational-knowledge-management](https://bmw.ghe.com/adpnext-apps/operational-knowledge-management) — RCA / operational ingest (external BMW GHE; "OKM" for short)

## Tests / Verify

```bash
# system-specific verification snippet
{cd path/to/system && npm test}
```

<!-- KM-Core's README only: add a link to [Onboarding guide](./docs/ONBOARDING.md). -->
