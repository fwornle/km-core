# @fwornle/km-core

KM-Core is the SHARED CORE for cross-system knowledge-graph unification — canonical `Entity` / `Relation` / `Layer` / `ProvenanceStamp` types, a `GraphKMStore` adapter (Graphology in-memory + LevelDB durable + git-tracked per-domain JSON exports), an OntologyRegistry, a 4-stage IngestPipeline with layered deduplication, a framework-agnostic REST router at `/api/v1/`, git-tag-backed snapshots via `SnapshotManager`, and an ontology display-overlay surface for consumer-side rendering hints.

## Configurations Owned

KM-Core is the SHARED CORE — owns no per-system config. The four standard slots are externalized to each consumer:

- **Ontology:** — (owned per-system: `coding` reads `.data/ontologies/coding-ontology.json`; `mcp-server-semantic-analysis` reads the same coding ontology; `operational-knowledge-management` owns RaaS / KPI-FW / business lower ontologies under its own `ontology/*.json`)
- **LLM providers:** — (owned per-system: `coding` configures `_work/rapid-llm-proxy`; `mcp-server-semantic-analysis` owns `config/workflows/*.json` `processOverrides`; `operational-knowledge-management` owns its own `lib/llm/providers/`)
- **Ingest adapters:** — (owned per-system: `coding`'s `src/live-logging/ObservationWriter.js`; `mcp-server-semantic-analysis`'s `wave-controller`; `operational-knowledge-management`'s `src/ingest/adapters/` for MkDocs / Confluence / CodeBeamer)
- **Domain eval / dedup:** — (owned per-system: `coding`'s Jaccard 0.45 + 4-keyword floor in `ObservationWriter.js`; `operational-knowledge-management`'s `src/intelligence/dedup.ts`)

KM-Core PROVIDES the surfaces (types, store, registry, pipeline, dedup primitives, REST router, snapshot manager) but does NOT own any per-system data files or routing config — those live in each consumer.

## Architecture

![KM-Core architecture](../../docs/images/km-core-architecture.png)

The high-level architecture shows the SHARED CORE (Types & IDs, Store, Ontology Registry, Ingest Pipeline, REST + Snapshots) bounded against the PER-SYSTEM CONFIG zone (ontology files, LLM provider config, ingest adapters, domain dedup rules). Consumer systems invoke the REST router under `/api/v1/`; the pipeline threads `ProvenanceStamp` through dedup and store stages; the store emits `entity:put` / `entity:delete` / `relation:added` / `relation:removed` events plus debounced atomic JSON exports per ontology lower-domain.

![KM-Core ingest sequence](../../docs/images/km-core-ingest-sequence.png)

The ingest sequence shows the canonical write path: consumer calls `IngestPipeline.ingest(entity, opts)`, the pipeline runs `Dedup.check`, then either persists the new entity via `GraphKMStore.putEntity` (with `registryBackedValidator` + UUIDv7 stamping + Graphology + LevelDB write) or merges into a survivor via `mergeEntities` (close duplicate, SUPERSEDED_BY edge, edge rewire, segment fold). Both branches emit events and enqueue a 5-second-debounced atomic export flush.

## Where to Edit

| To add… | Edit… | Verify |
|---------|-------|--------|
| A new Entity type field | `src/types/entity.ts` | `cd lib/km-core && npm test` |
| A new REST endpoint | `src/api/handlers/<resource>.ts` + register in `src/api/router.ts` | `cd lib/km-core && npm test` (router tests cover the surface) |
| A new ingest stage | `src/pipeline/IngestPipeline.ts` + `src/pipeline/types.ts` | `cd lib/km-core && npm test -- pipeline` |
| Extend display overlay | `src/ontology/display-overlay.ts` | `cd lib/km-core && npm test -- display-overlay` |
| A new dedup layer | `src/dedup/<Layer>.ts` + register in `LayeredDeduplicator.ts` | `cd lib/km-core && npm test -- dedup` |
| A new snapshot operation | `src/snapshots/SnapshotManager.ts` | `cd lib/km-core && npm test -- snapshots` |

Every row above gives a file path AND a verification command — this table is the SC-1 (5-minute discoverability) enforcement surface for KM-Core.

## Related Systems

- [coding](../../README.md) — observation source, host runtime, obs-api at `localhost:12436`
- [mcp-server-semantic-analysis](../../integrations/mcp-server-semantic-analysis/README.md) — agent pipeline, wave-analysis workflow
- [operational-knowledge-management](https://bmw.ghe.com/adpnext-apps/operational-knowledge-management) — RCA + operational ingest ("OKM" for short, external BMW GHE repo)
- KM-Core is consumed by these systems as the shared persistence + contract layer; additional consumers can adopt the same pattern.

## Tests / Verify

```bash
cd lib/km-core
npm install
npm run build
npm test
```

Vitest 4.x with `environment: node`. Integration tests under `tests/integration/` exercise byte-equal round-trip parity against frozen fixtures in `tests/fixtures/`.

For a hands-on walkthrough of registering a new SubComponent, ingesting it via the obs-api, verifying it in the unified viewer, and cleaning up — see the [Onboarding guide](./docs/ONBOARDING.md).

## Install

KM-Core is currently consumed via git submodule, not npm:

```bash
cd path/to/your/repo
git submodule add git@github.com:fwornle/km-core.git lib/km-core
cd lib/km-core
npm install
npm run build
```

## Public API

```typescript
import {
  // Canonical types
  type Entity,
  type Relation,
  type Layer,
  type EntityId,
  type SerializedGraph,
  type BatchOp,
  type FilterObject,
  type ProvenanceStamp,
  type EntityProvenance,

  // Identifier helpers (UUIDv7)
  mintEntityId,
  parseEntityId,

  // Store
  GraphKMStore,
  type GraphKMStoreOptions,

  // Ontology Registry
  OntologyRegistry,
  type OntologyRegistryOptions,
  loadOntologyFile,
  defaultOntologyDir,
  noopOntologyValidator,
  registryBackedValidator,
  type OntologyValidator,
  type OntologyFile,
  type OntologyClass,
  type ResolvedClass,

  // Provenance segment merge
  mergeDescriptionSegment,
  backfillEntityDataModel,
  type BackfillOptions,
  type BackfillResult,

  // Ingest pipeline
  IngestPipeline,
  LayeredDeduplicator,
  JaccardNameMatcher,
  CosineEmbeddingMatcher,
  LLMSemanticMatcher,
  type IngestPipelineOpts,
  type IngestResult,

  // Online-learning adapter + post-hoc resolution
  reprojectFromOnlineStore,
  resolveEntities,
  mergeEntities,

  // Offline UKB / embedding default
  syncQdrantFromStore,
  FastembedEmbeddingClient,

  // REST router + Zod contracts + snapshots
  createKmCoreRouter,
  SnapshotManager,
  observationToLegacy,
  digestToLegacy,
  insightToLegacy,

  // Legacy-ingest adapter
  legacyObservationToEntity,
  legacyDigestToEntity,
  legacyInsightToEntity,
} from '@fwornle/km-core';
```

Sub-path imports are also supported:

```typescript
import { EntitySchema } from '@fwornle/km-core/api/contracts';
import { createKmCoreRouter } from '@fwornle/km-core/api';
import { SnapshotManager } from '@fwornle/km-core/snapshots';
import { FastembedEmbeddingClient } from '@fwornle/km-core/embeddings';
import { resolveEntities, mergeEntities } from '@fwornle/km-core/maintenance';
```

`GraphKMStore` extends Node's `EventEmitter` and fires `entity:put`, `entity:delete`, `relation:added`, `relation:removed` events for consumers (e.g. Redis pub/sub bridges) to subscribe to.

The `display-overlay` surface at `src/ontology/display-overlay.ts` lets consumers fetch ontology classes with `?withDisplay=true` to receive display hints (icons, colors, label positions) merged in. See `src/ontology/display-overlay.ts` for the overlay schema.

`SnapshotManager` provides git-tag-backed snapshots over `.data/exports/`: snapshot IDs are git tags of the form `snapshot/<label>-<timestamp>`, restore = `git checkout <tag> -- exportsRel/` + caller wipes LevelDB and restarts (hard-reset semantics, handler wraps with `restartRequired: true`).

## Per-domain Export Contract

The store writes one JSON file per ontology lower-domain into the configured `exportDir`:

```
exportDir/
  raas.json
  kpifw.json
  general.json
  coding.json
  ...
```

Each file mirrors Graphology's `SerializedGraph` shape and is written atomically (temp file + rename). Writes are debounced 5s after the last mutation.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Notable constraint: no `console.*` calls in source — use `process.stderr.write()` or a caller-supplied logger.
