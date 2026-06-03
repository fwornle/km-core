// Phase 44 Plan 05 (A-4): observation-view adapter — Entity → legacy reshape.
//
// SOURCE:
//   - 44-CONTEXT.md A-4 typed-view mandate: A's legacy /api/coding/observations|
//     digests|insights endpoints become typed views over km-core entities. The
//     reshape lives in km-core (single source of truth) and is consumed by A's
//     obs-api server in Plan 44-07.
//   - 44-RESEARCH.md §Pattern 3 (lines 282-315) — observationToLegacy skeleton.
//   - 44-PATTERNS.md §observation-view.ts — file-layout + reverse-direction
//     reshape template. File structure mirrors src/adapters/online/mapper.ts
//     (Phase 41 INT-01); this module is the REVERSE direction of that one.
//   - scripts/observations-api-server.mjs:466-549 (legacy observation SELECT),
//     :630-687 (legacy digest SELECT), :705-751 (legacy insight SELECT).
//
// CRITICAL — canonical legacyId placement (CF-D37, entity.ts:147):
//   - entity.legacyId is the TOP-LEVEL Entity field (NOT inside metadata).
//   - When present, legacyId.id WINS over entity.id — A-2 migration preserves
//     the SQLite rowid in legacyId so downstream consumers identify rows by
//     the SQLite id, not the UUIDv7 km-core entity id.
//
// CRITICAL — fallback chains (per plan frontmatter "truths"):
//   - id:        entity.legacyId?.id ?? entity.id
//   - content:   metadata.summary ?? metadata.content ?? entity.description ?? ''
//   - artifacts: Array.isArray(metadata.artifacts) ? metadata.artifacts : []
//   - agent:     metadata.agent ?? 'unknown'
//   - project:   metadata.project ?? 'unknown'
//   - timestamp: metadata.createdAt ?? entity.validFrom ?? ''
//   - quality:   metadata.quality ?? 'normal'
//
// no-console-log: this module is PURE — no I/O, no async, no side effects, no
// diagnostic emission. Any diagnostic logging lives in the caller (A's obs-api
// handler in Plan 44-07).
//
// NOT EXPORTED from src/index.ts in this plan — Plan 44-06 owns the root
// barrel update (mounts createKmCoreRouter + re-exports the reshape fns).
//
// Filename: EXACTLY `observation-view.ts` per km-core CLAUDE.md
// no-evolutionary-names global rule (no v2 / enhanced / new / etc. variants).

import type { Entity } from '../types/entity.js';

// ----------------------------------------------------------------------------
// Legacy shape interfaces.
//
// These mirror the EXACT field sets that A's pre-Phase-44 SQLite-backed
// endpoints return today; Pitfall 2 (44-RESEARCH.md) says missing fields equal
// blank cells on A's dashboard at :3032. Field names + types are derived from
// the SELECT projections in scripts/observations-api-server.mjs cited above.
// ----------------------------------------------------------------------------

/**
 * Legacy observation row shape — mirrors the response of
 * `GET /api/observations` per scripts/observations-api-server.mjs:466-549
 * (SELECT id, agent, project, content, artifacts, ...).
 */
export interface LegacyObservation {
  id: string;
  agent: string;
  project: string;
  /** Body text — `metadata.summary` is the post-Phase-41 canonical key. */
  content: string;
  /** Files referenced by the observation; always an array (never undefined). */
  artifacts: string[];
  /** ISO timestamp; derived from `metadata.createdAt` or `entity.validFrom`. */
  timestamp: string;
  session_id?: string;
  quality?: string;
}

/**
 * Legacy daily-digest row shape — mirrors the response of
 * `GET /api/digests` per scripts/observations-api-server.mjs:630-687
 * (SELECT id, date, theme, summary, observation_ids, agents, files_touched, project).
 *
 * Note: snake_case keys are deliberate — this is the legacy WIRE shape A's
 * dashboard reads today; renaming to camelCase would break the dashboard
 * (Pitfall 2).
 */
export interface LegacyDigest {
  id: string;
  date: string;
  theme: string;
  summary: string;
  observation_ids: string[];
  agents: string[];
  files_touched: string[];
  project: string;
}

/**
 * Legacy insight row shape — mirrors the response of
 * `GET /api/insights` per scripts/observations-api-server.mjs:705-751
 * (SELECT id, topic, summary, confidence, digest_ids, last_updated, project).
 *
 * Same snake_case rationale as `LegacyDigest`.
 */
export interface LegacyInsight {
  id: string;
  topic: string;
  summary: string;
  confidence: number;
  digest_ids: string[];
  last_updated: string;
  project: string;
}

// ----------------------------------------------------------------------------
// Reshape functions — pure, synchronous, side-effect-free.
//
// Each function reads ONLY the input Entity; it never touches a store, never
// hits the network, never logs. The legacyId.id-over-entity.id preference is
// applied uniformly so the three reshapes share idempotency semantics with the
// A-2 migration (Plan 44-07 / migrate-sqlite-to-kmcore.mjs).
// ----------------------------------------------------------------------------

/**
 * Reshape a km-core Entity (`ontologyClass === 'Observation'`) into the legacy
 * observation row shape A's dashboard at :3032 expects.
 *
 * Field source map (per scripts/observations-api-server.mjs:466-549 SELECT):
 *   - id        = entity.legacyId.id (preferred) or entity.id
 *   - agent     = metadata.agent or 'unknown'
 *   - project   = metadata.project or 'unknown'
 *   - content   = metadata.summary or metadata.content or entity.description or ''
 *   - artifacts = metadata.artifacts (when an array) or []
 *   - timestamp = metadata.createdAt or entity.validFrom or ''
 *   - session_id = metadata.session_id (passthrough; may be undefined)
 *   - quality   = metadata.quality or 'normal'
 */
export function observationToLegacy(entity: Entity): LegacyObservation {
  const m = (entity.metadata ?? {}) as Record<string, unknown>;
  const legacy: LegacyObservation = {
    id: entity.legacyId?.id ?? entity.id,
    agent: typeof m.agent === 'string' ? m.agent : 'unknown',
    project: typeof m.project === 'string' ? m.project : 'unknown',
    content:
      typeof m.summary === 'string'
        ? m.summary
        : typeof m.content === 'string'
          ? m.content
          : (entity.description ?? ''),
    artifacts: Array.isArray(m.artifacts) ? (m.artifacts as string[]) : [],
    timestamp:
      typeof m.createdAt === 'string'
        ? m.createdAt
        : (entity.validFrom ?? ''),
    quality: typeof m.quality === 'string' ? m.quality : 'normal',
  };
  if (typeof m.session_id === 'string') {
    legacy.session_id = m.session_id;
  }
  return legacy;
}

/**
 * Reshape a km-core Entity (`ontologyClass === 'Digest'`) into the legacy
 * daily-digest row shape A's dashboard at :3032 expects.
 *
 * Field source map (per scripts/observations-api-server.mjs:630-687 SELECT):
 *   - id              = entity.legacyId.id (preferred) or entity.id
 *   - date            = metadata.date or entity.validFrom or ''
 *   - theme           = metadata.theme or ''
 *   - summary         = metadata.summary or entity.description or ''
 *   - observation_ids = metadata.observation_ids (when an array) or []
 *   - agents          = metadata.agents (when an array) or []
 *   - files_touched   = metadata.files_touched (when an array) or []
 *   - project         = metadata.project or 'unknown'
 */
export function digestToLegacy(entity: Entity): LegacyDigest {
  const m = (entity.metadata ?? {}) as Record<string, unknown>;
  return {
    id: entity.legacyId?.id ?? entity.id,
    date:
      typeof m.date === 'string'
        ? m.date
        : (entity.validFrom ?? ''),
    theme: typeof m.theme === 'string' ? m.theme : '',
    summary:
      typeof m.summary === 'string'
        ? m.summary
        : (entity.description ?? ''),
    observation_ids: Array.isArray(m.observation_ids)
      ? (m.observation_ids as string[])
      : [],
    agents: Array.isArray(m.agents) ? (m.agents as string[]) : [],
    files_touched: Array.isArray(m.files_touched)
      ? (m.files_touched as string[])
      : [],
    project: typeof m.project === 'string' ? m.project : 'unknown',
  };
}

/**
 * Reshape a km-core Entity (`ontologyClass === 'Insight'`) into the legacy
 * insight row shape A's dashboard at :3032 expects.
 *
 * Field source map (per scripts/observations-api-server.mjs:705-751 SELECT):
 *   - id           = entity.legacyId.id (preferred) or entity.id
 *   - topic        = metadata.topic or entity.name
 *   - summary      = metadata.summary or entity.description or ''
 *   - confidence   = metadata.confidence (when a finite number) or 0
 *   - digest_ids   = metadata.digest_ids (when an array) or []
 *   - last_updated = metadata.last_updated or entity.validFrom or ''
 *   - project      = metadata.project or 'unknown'
 */
export function insightToLegacy(entity: Entity): LegacyInsight {
  const m = (entity.metadata ?? {}) as Record<string, unknown>;
  return {
    id: entity.legacyId?.id ?? entity.id,
    topic: typeof m.topic === 'string' ? m.topic : entity.name,
    summary:
      typeof m.summary === 'string'
        ? m.summary
        : (entity.description ?? ''),
    confidence: typeof m.confidence === 'number' ? m.confidence : 0,
    digest_ids: Array.isArray(m.digest_ids) ? (m.digest_ids as string[]) : [],
    last_updated:
      typeof m.last_updated === 'string'
        ? m.last_updated
        : (entity.validFrom ?? ''),
    project: typeof m.project === 'string' ? m.project : 'unknown',
  };
}
