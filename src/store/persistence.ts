// CORE-02: PersistenceManager — LevelDB lifecycle + hydrate-fallback + atomic persist.
//
// SOURCE: adopted VERBATIM (with the 4 deltas listed below) from OKM's
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/store/persistence.ts
//
// 37-PATTERNS.md §"src/store/persistence.ts" identifies OKM's persistence.ts
// as the EXACT analog — the LevelDB-first / JSON-fallback startup, the
// per-domain bucketing, the `writing` re-entry guard, and the LEVEL_NOT_FOUND
// error narrowing are all carried over verbatim.
//
// DELTAS applied (per 37-PATTERNS §src/store/persistence.ts DELTAS):
//
//   1. PARAMETRIZE THE DOMAIN LIST. OKM hard-codes `['raas','kpifw','general']`
//      twice (lines 61 + 113 of analog). KM-Core's constructor accepts a
//      `domains` option; sane default is `['general']` because KM-Core
//      consumers (B supplies `['coding']`; C supplies `['raas','kpifw','general']`)
//      bring their own domain list.
//
//   2. REPLACE `console.info` ON LINE 84. OKM logs the hydrate-from-JSON
//      event via `console.info(...)`. CLAUDE.md `no-console-log` constraint
//      forbids `console.*` in this repo's source files; we use
//      `process.stderr.write(...)` instead. See also MEMORY.md
//      "Constraint Violations = Real Issues".
//
//   3. PRESERVE the `writing = false` re-entry guard (line 9 of analog) and
//      the surrounding try/finally on `exportJson` (lines 98-99 of analog)
//      VERBATIM. CONTEXT D-22 requires this exact behavior — a slow disk +
//      a second `_scheduleExport()` mid-write would overlap without it.
//
//   4. UPGRADE the naive `fs.promises.writeFile` on line 152-154 of analog
//      to the atomic temp-file + rename pattern from RESEARCH §"Pattern 3":
//        - write to `${filePath}.tmp.${pid}.${ts}` first,
//        - then `fs.promises.rename(tempPath, filePath)` — atomic on POSIX.
//      This is the OKB-baseline-guard safety contract: the pre-commit hook
//      reads `.data/exports/*.json` from staged files, and a torn write
//      makes the staged file unparseable.
//
// Threat-model mitigation (T-37-03-01): the hydrate-from-JSON path treats
// JSON as data, not code. `JSON.parse` on Node 22 does NOT inflate
// `__proto__` / `constructor` keys into the prototype chain for plain
// object parsing — keys land on the parsed object's own properties only.
// No `eval`, no `Function` constructor, no recursive merge into a
// prototype-shared target.

import { ClassicLevel } from 'classic-level';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SerializedGraph } from '../types/entity.js';

export interface PersistenceManagerOptions {
  /** List of known domain names. Nodes whose `metadata.domain` matches a
   *  member of this list go to `${domain}.json`; everything else falls
   *  through to `general.json`. Defaults to `['general']`. */
  domains?: readonly string[];
}

export class PersistenceManager {
  private db: ClassicLevel<string, string>;
  private exportDir: string;
  private domains: readonly string[];
  private writing = false;

  constructor(
    dbPath: string,
    exportDir: string,
    opts?: PersistenceManagerOptions,
  ) {
    // Ensure directories exist
    fs.mkdirSync(dbPath, { recursive: true });
    fs.mkdirSync(exportDir, { recursive: true });

    this.db = new ClassicLevel(dbPath, { valueEncoding: 'utf8' });
    this.exportDir = exportDir;
    this.domains = opts?.domains ?? ['general'];
  }

  /**
   * Persist the full serialized graph to LevelDB under the `graph:state`
   * key. Cheap (~ms even at 10K-node scale) and idempotent.
   */
  async persistGraph(serialized: SerializedGraph): Promise<void> {
    await this.db.put('graph:state', JSON.stringify(serialized));
  }

  /**
   * Restore the in-memory graph from durable storage on `open()`.
   *
   * Strategy: LevelDB FIRST (the runtime cache, hot, low-latency), then
   * fall back to per-domain JSON exports if LevelDB has nothing
   * (LEVEL_NOT_FOUND). The fallback covers the cold-start case of cloning
   * the repo on a new machine where LevelDB doesn't exist yet but
   * `.data/exports/*.json` are git-tracked.
   *
   * @see hydrateFromJsonExports for the fallback path.
   */
  async hydrate(): Promise<SerializedGraph | null> {
    // Try LevelDB first (runtime cache)
    try {
      await this.db.open();
      const data = await this.db.get('graph:state');
      if (data !== undefined && data !== null) {
        return JSON.parse(data) as SerializedGraph;
      }
    } catch (err: unknown) {
      // classic-level does NOT export typed error classes — duck-typing on
      // `err.code === 'LEVEL_NOT_FOUND'` is the canonical pattern (37-PATTERNS
      // §Shared Patterns).
      if (
        !(err &&
          typeof err === 'object' &&
          'code' in err &&
          (err as { code: string }).code === 'LEVEL_NOT_FOUND')
      ) {
        throw err;
      }
    }

    // Fallback: merge per-domain JSON exports (git-tracked, may come from
    // colleagues' runs that arrived via git pull). Source of truth when
    // LevelDB is empty.
    return this.hydrateFromJsonExports();
  }

  /**
   * Reconstruct graph state from per-domain JSON exports.
   *
   * These files are git-tracked and may contain data from a colleague's
   * run that arrived via git pull. They serve as the master when LevelDB
   * is empty.
   *
   * Threat-model note (T-37-03-01): we treat the JSON as untrusted data.
   * `JSON.parse` does not pollute prototypes for plain-object parsing on
   * Node 22; keys land on the parsed object's own properties only. No
   * `Object.assign` into a prototype-shared object, no `lodash.merge`,
   * no `eval`.
   */
  private async hydrateFromJsonExports(): Promise<SerializedGraph | null> {
    const merged: SerializedGraph = {
      attributes: {},
      options: { type: 'directed', multi: true, allowSelfLoops: true },
      nodes: [],
      edges: [],
    };

    let found = false;
    for (const domain of this.domains) {
      const filePath = path.join(this.exportDir, `${domain}.json`);
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const domainGraph = JSON.parse(raw) as SerializedGraph;
        if (domainGraph.nodes.length > 0 || domainGraph.edges.length > 0) {
          found = true;
          merged.nodes.push(...domainGraph.nodes);
          // Deduplicate edges by key to handle cross-domain edges
          const existingKeys = new Set(merged.edges.map((e) => e.key));
          for (const edge of domainGraph.edges) {
            if (!existingKeys.has(edge.key)) {
              merged.edges.push(edge);
              existingKeys.add(edge.key);
            }
          }
        }
      } catch {
        // File doesn't exist or is invalid — skip
      }
    }

    // Always attempt the `general` fallback file too. Consumers may
    // configure `domains: ['coding']` but a colleague's machine may have
    // dumped unknown-domain nodes into `general.json` via Exporter's
    // fallthrough. Read it if we haven't already.
    if (!this.domains.includes('general')) {
      const filePath = path.join(this.exportDir, 'general.json');
      try {
        const raw = await fs.promises.readFile(filePath, 'utf-8');
        const domainGraph = JSON.parse(raw) as SerializedGraph;
        if (domainGraph.nodes.length > 0 || domainGraph.edges.length > 0) {
          found = true;
          merged.nodes.push(...domainGraph.nodes);
          const existingKeys = new Set(merged.edges.map((e) => e.key));
          for (const edge of domainGraph.edges) {
            if (!existingKeys.has(edge.key)) {
              merged.edges.push(edge);
              existingKeys.add(edge.key);
            }
          }
        }
      } catch {
        // skip
      }
    }

    if (found) {
      // DELTA 2: replaced `console.info(...)` with `process.stderr.write(...)`
      // to satisfy CLAUDE.md `no-console-log` constraint.
      process.stderr.write(
        `[km-core/persistence] LEVEL_NOT_FOUND, hydrated from JSON: ` +
          `${merged.nodes.length} nodes, ${merged.edges.length} edges\n`,
      );
    }

    return found ? merged : null;
  }

  /**
   * Export graph as per-domain JSON files — the git-tracked representation.
   *
   * One file per configured domain (e.g. `coding.json`, `raas.json`,
   * `general.json`). Each file contains only the nodes that belong to
   * that domain (by `attributes.metadata.domain`) plus the edges whose
   * source-node belongs to that domain (preventing cross-domain edges
   * from being duplicated across files).
   *
   * Atomicity: each file is written to `${path}.tmp.${pid}.${ts}` first
   * and then `fs.promises.rename`'d to its final path. On POSIX this is
   * atomic — readers never see a partial file. This is the OKB-baseline-
   * guard safety contract (RESEARCH §Pattern 3).
   *
   * Re-entry guard: the `writing` flag short-circuits a concurrent call.
   * D-22's 5s debounce alone is not enough — a slow disk plus a second
   * `_scheduleExport()` mid-write would overlap.
   */
  async exportJson(data: SerializedGraph): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      // Group nodes by domain. Members of `this.domains` get their own
      // file; everything else is bucketed into 'general' to prevent stale
      // per-topic files (matches OKM analog line 105).
      const STANDARD_DOMAINS = new Set(this.domains);
      const domainNodes = new Map<string, typeof data.nodes>();
      for (const node of data.nodes) {
        const rawDomain =
          (node.attributes?.metadata?.domain as string) || 'general';
        const domain = STANDARD_DOMAINS.has(rawDomain) ? rawDomain : 'general';
        if (!domainNodes.has(domain)) domainNodes.set(domain, []);
        domainNodes.get(domain)!.push(node);
      }

      // Ensure every configured domain has a file even if empty.
      for (const domain of this.domains) {
        if (!domainNodes.has(domain)) domainNodes.set(domain, []);
      }
      // Always materialize `general.json` as the catch-all (matches OKM).
      if (!domainNodes.has('general')) domainNodes.set('general', []);

      // Build a global nodeKey→domain index for edge assignment.
      const nodeDomain = new Map<string, string>();
      for (const [domain, nodes] of domainNodes) {
        for (const n of nodes) {
          nodeDomain.set(n.key, domain);
        }
      }

      // Pre-bucket edges by source-node domain (each edge lands in
      // exactly one domain file).
      const domainEdges = new Map<string, typeof data.edges>();
      for (const domain of domainNodes.keys()) {
        domainEdges.set(domain, []);
      }
      for (const e of data.edges) {
        const rawDomain = nodeDomain.get(e.source) ?? 'general';
        const srcDomain = STANDARD_DOMAINS.has(rawDomain)
          ? rawDomain
          : 'general';
        domainEdges.get(srcDomain)!.push(e);
      }

      // Write all domain files concurrently via temp+rename.
      const writes: Promise<void>[] = [];
      for (const [domain, nodes] of domainNodes) {
        const edges = domainEdges.get(domain) ?? [];

        const domainGraph: SerializedGraph = {
          attributes: data.attributes,
          options: data.options,
          nodes,
          edges,
        };

        const filePath = path.join(this.exportDir, `${domain}.json`);
        writes.push(this.writeAtomic(filePath, domainGraph));
      }

      await Promise.all(writes);
    } finally {
      this.writing = false;
    }
  }

  /**
   * DELTA 4: temp-file + rename for atomicity (RESEARCH §Pattern 3).
   *
   * Why: the pre-commit OKB-baseline-guard hook reads
   * `.data/exports/*.json` from staged files. A torn write makes the
   * staged file unparseable. `rename(2)` is atomic within a single
   * filesystem on POSIX, so readers either see the old file or the new
   * file, never an in-between.
   */
  private async writeAtomic(
    filePath: string,
    domainGraph: SerializedGraph,
  ): Promise<void> {
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(
      tempPath,
      JSON.stringify(domainGraph, null, 2),
      'utf-8',
    );
    await fs.promises.rename(tempPath, filePath); // atomic on POSIX
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
