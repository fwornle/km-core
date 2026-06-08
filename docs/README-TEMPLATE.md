<!--
OVERRIDE_CONSTRAINT: documentation-filename-format
Rationale: README-TEMPLATE.md is a canonical README skeleton (locked by D-46-02 in
46-CONTEXT.md / P-1 in 46-PATTERNS.md). The uppercase "TEMPLATE" suffix is deliberate.
The Phase 46 plan's must_haves block explicitly requires this exact path.
-->

# {System Name}

> One-sentence role in the KM unification — describe what this system OWNS (or, for the shared core, write "KM-Core is the SHARED CORE — owns no per-system config").

## Configurations Owned

- **Ontology:** `{path/to/ontology.json}` — {what classes live here, or "— (owned by KM-Core / A / B / C)"}
- **LLM providers:** `{path/to/llm-config}` — {which provider config files, or "— (owned by …)"}
- **Ingest adapters:** `{path/to/adapter}` — {which event sources / writers, or "— (owned by …)"}
- **Domain eval / dedup:** `{path/to/dedup-or-scoring}` — {system-specific scoring logic, or "— (owned by …)"}

For slots the system does NOT own: write `— (owned by KM-Core / A / B / C)` rather than omitting the line, so the ownership contract is visible at a glance.

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
- [A: coding](../../README.md) — observation source, host runtime
- [B: mcp-server-semantic-analysis](../../integrations/mcp-server-semantic-analysis/README.md) — agent pipeline, wave-analysis workflow
- [C: OKM](https://bmw.ghe.com/adpnext-apps/operational-knowledge-management) — RCA / operational ingest (external BMW GHE)

## Tests / Verify

```bash
# system-specific verification snippet
{cd path/to/system && npm test}
```

<!-- KM-Core's README only: add a link to [Onboarding guide](./docs/ONBOARDING.md). -->
