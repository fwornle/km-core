# Frozen Fixtures (Wave 0)

These four JSON snapshots are **frozen 2026-05-19** copies of current B (coding) and C (OKM / rapid-automations) production knowledge exports. They are reference **inputs** for the round-trip parity test, not outputs — **do not regenerate** them without intent.

## Files

| Fixture | Source path | Shape | Approx size |
|---------|-------------|-------|-------------|
| `b-coding-snapshot.json` | `coding/.data/knowledge-export/coding.json` | `{entities, relations, metadata}` (B's legacy semantic-analysis exporter shape) | 1.2 MB |
| `c-raas-snapshot.json` | `_work/rapid-automations/integrations/operational-knowledge-management/.data/exports/raas.json` | `{attributes, options, nodes, edges}` (Graphology `SerializedGraph`) | 8.8 MB |
| `c-kpifw-snapshot.json` | same dir, `kpifw.json` | Graphology `SerializedGraph` | 2.4 MB |
| `c-general-snapshot.json` | same dir, `general.json` | Graphology `SerializedGraph` | 1.5 MB |

**Total: ~14 MB** (the original RESEARCH §Validation Architecture estimate of ~400 KB / 600 KB was based on stale `general.json`-only assumptions; current production state of B+C is dominated by `c-raas-snapshot.json` at ~8.8 MB. The fixtures stay verbatim because parity is the contract and any normalisation here would mask real-world edge cases.)

## Shape mismatch (B vs C) and the one-time converter

The B fixture is in `{entities, relations, metadata}` shape — produced by `coding/src/knowledge-management/GraphKnowledgeExporter.js`, which builds a Graphology graph in-process but serialises it through a custom JSON shape. The 3 C fixtures are already in Graphology's native `SerializedGraph` shape (`{attributes, options, nodes, edges}`).

`./_convert-b.ts` normalises B's shape into Graphology shape so the round-trip parity test (`tests/integration/round-trip.test.ts`) can load all four through one code path. The converter:

- Maps each `entities[i]` to a Graphology node (`key = entity.id`, `attributes = entity`)
- Maps each `relations[i]` to a Graphology edge (`source = rel.from`, `target = rel.to`, `attributes.type = rel.relationType`, `attributes.metadata = rel.metadata`)
- Tags the result with `attributes._convertedFrom: 'b-snapshot-v1'` so downstream consumers can detect a converted graph if they ever need to

The converter is **disposable** — Phase 42 rewrites B's exporter against KM-Core, at which point B will natively emit Graphology shape and this file gets deleted.

## Parity contract

Per RESEARCH §Validation Architecture, the round-trip test asserts:

1. Load fixture → import into `GraphKMStore` → `exportJson()` to a temp dir.
2. Re-read the exported file.
3. Compute a **canonical-key-sort** (recursive alphabetical sort of all object keys) of both the original and the round-tripped graph.
4. `JSON.stringify(..., null, 0)` each → byte-equal comparison.
5. Every input node id survives the round-trip unchanged (CORE-03 ID survival).

Byte-equality after canonical sort proves the store does not lose, reorder, or rewrite anything.

## Security note

Per `37-RESEARCH.md` §Threat T-37-01-02 (Information Disclosure), these fixtures are committed to a **public** repo, so they must contain no secrets / PII / credentials. The fixtures DO contain plain-text mentions of the variable **names** `ANTHROPIC_API_KEY`, `BROWSERBASE_API_KEY` etc. in LLM-synthesized component descriptions — those are env-var identifiers, NOT secret values. A targeted scan for `sk-…`, `sk_(live|test)_…`, `ghp_…`, `Bearer …`, `AKIA…`, and `-----BEGIN [A-Z ]*PRIVATE KEY-----` patterns returned zero matches on 2026-05-19. No actual secret material is present.

The round-trip test treats all fixture bytes as **untrusted JSON**: it uses `JSON.parse` (never `eval` / `new Function`) and scopes all reads through `path.resolve(__dirname, '...-snapshot.json')` to prevent directory traversal (mitigates T-37-02).

## Do not regenerate

These bytes are the contract. Regenerating them would silently re-baseline whatever bug or shape drift currently exists in the source exporters. If a fixture must be refreshed (e.g., because Phase 42 rewires B's exporter), update the fixture AND the converter in the same commit AND re-run the round-trip test as the explicit gate.
