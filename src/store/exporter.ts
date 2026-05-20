// CORE-02: Exporter — event-driven 5s-debounced per-domain JSON writer.
//
// SOURCES (composite per 37-PATTERNS §"src/store/exporter.ts"):
//   1. OKM's _work/.../okm/src/store/persistence.ts:97-161 — the per-domain
//      bucketing logic (STANDARD_DOMAINS + nodeKey→domain index +
//      pre-bucket edges by source-node domain).
//   2. coding/src/knowledge-management/GraphKnowledgeExporter.js:35-123 —
//      the setTimeout-based debounce pattern (a single timer that gets
//      reset on every mutation, fires the export after the debounce
//      window elapses).
//
// DELTAS applied (per 37-PATTERNS §src/store/exporter.ts DELTAS):
//
//   1. TS conversion + types. Rewrite B's `.js` patterns as strict TS
//      with explicit types.
//
//   2. SINGLE-TIMER design. KM-Core exports the whole graph per tick
//      (NOT per team like B did). One `exportTimer` field, one debounce
//      window. Per-domain bucketing happens INSIDE the export call,
//      not via separate timers per domain.
//
//   3. Public API decoupled from EventEmitter. B's exporter directly
//      subscribed to its store's events (inversion of control). KM-Core's
//      Exporter EXPOSES a `scheduleExport(graph)` method that the
//      consumer (`GraphKMStore` in Plan 04) calls from its own event
//      handlers — `entity:put`, `entity:delete`, `relation:added`,
//      `relation:removed` (event names per D-16).
//
//   4. DEFAULT debounce window 5000ms per D-22.
//
//   5. NO `console.*` — use `process.stderr.write(...)` for any logging
//      (CLAUDE.md `no-console-log` constraint).
//
//   6. ATOMIC temp+rename for the per-domain write (RESEARCH §Pattern 3,
//      37-PATTERNS §"Shared Patterns: Atomic temp+rename"). Same
//      contract as `PersistenceManager.exportJson`.
//
// Threat-model mitigation (T-37-03-02): the constructor's `exportDir`
// crosses the library boundary. We `path.resolve` it; consumers in
// Plan 04 pass a constructor-vetted path. Atomic temp+rename means a
// half-written file is never visible to readers.
//
// Threat-model mitigation (T-37-03-03): the `writing` re-entry guard
// (37-PATTERNS §"Re-entry guard") returns early on overlapping calls,
// preventing torn double-writes if the debounce window is shorter than
// the disk-flush time.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SerializedGraph } from '../types/entity.js';

export interface ExporterOptions {
  /** Absolute or relative directory where per-domain JSON files land. */
  exportDir: string;
  /** Known domain names. Members get their own `${domain}.json` file;
   *  everything else falls through to `general.json`. Defaults to
   *  `['general']`. */
  domains?: readonly string[];
  /** Debounce window in ms. The export fires this long after the LAST
   *  call to `scheduleExport`. Default 5000ms per D-22. */
  debounceMs?: number;
}

/**
 * Event-driven debounced per-domain JSON exporter for KM-Core graphs.
 *
 * Wiring (Plan 04): `GraphKMStore` constructs an `Exporter`, and on each
 * of its EventEmitter mutation events (`entity:put`, `entity:delete`,
 * `relation:added`, `relation:removed`) calls
 * `exporter.scheduleExport(this.graph.export() as SerializedGraph)`.
 * On `close()`, `await exporter.flush()` to drain any pending timer.
 */
export class Exporter {
  private exportDir: string;
  private domains: readonly string[];
  private debounceMs: number;
  private exportTimer: NodeJS.Timeout | null = null;
  private pendingSnapshot: SerializedGraph | null = null;
  private writing = false;

  constructor(opts: ExporterOptions) {
    // Defense-in-depth (T-37-03-02): resolve `exportDir`. Consumers in
    // Plan 04 supply a vetted path; this is belt-and-braces.
    this.exportDir = path.resolve(opts.exportDir);
    this.domains = opts.domains ?? ['general'];
    this.debounceMs = opts.debounceMs ?? 5000;

    fs.mkdirSync(this.exportDir, { recursive: true });
  }

  /**
   * Called by the consumer on every mutation. Resets the debounce timer
   * and stashes the latest graph snapshot. After `debounceMs` ms of
   * inactivity, fires `exportJson(latest snapshot)` exactly once.
   *
   * D-22: 10 rapid mutations within the debounce window coalesce into
   * a single `exportJson` call.
   */
  scheduleExport(snapshot: SerializedGraph): void {
    this.pendingSnapshot = snapshot;
    if (this.exportTimer !== null) {
      clearTimeout(this.exportTimer);
    }
    this.exportTimer = setTimeout(() => {
      this.exportTimer = null;
      const pending = this.pendingSnapshot;
      this.pendingSnapshot = null;
      if (pending === null) return;
      // Fire-and-forget; on failure we surface via process.stderr.
      this.exportJson(pending).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[km-core/exporter] debounced export failed: ${msg}\n`,
        );
      });
    }, this.debounceMs);
  }

  /**
   * Force any pending debounced export to fire immediately, awaiting
   * completion. Called by `GraphKMStore.close()` to ensure a clean
   * shutdown — no orphan timer, no lost final mutation.
   */
  async flush(): Promise<void> {
    if (this.exportTimer !== null) {
      clearTimeout(this.exportTimer);
      this.exportTimer = null;
    }
    const pending = this.pendingSnapshot;
    this.pendingSnapshot = null;
    if (pending !== null) {
      await this.exportJson(pending);
    }
  }

  /**
   * Synchronously fire a per-domain JSON export of `data`.
   *
   * Behavior matches `PersistenceManager.exportJson`:
   *   - bucket nodes by `metadata.domain` (members of `this.domains` keep
   *     their own file; everything else falls into `general.json`),
   *   - bucket edges by source-node domain (each edge lands in exactly
   *     one file),
   *   - write each `${domain}.json` via `${path}.tmp.${pid}.${ts}` then
   *     `fs.promises.rename` (atomic on POSIX).
   *
   * Re-entry guard: a concurrent call returns early without throwing.
   * Returns `void` either way.
   */
  async exportJson(data: SerializedGraph): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
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

      // Global nodeKey→domain index for edge assignment.
      const nodeDomain = new Map<string, string>();
      for (const [domain, nodes] of domainNodes) {
        for (const n of nodes) {
          nodeDomain.set(n.key, domain);
        }
      }

      // Pre-bucket edges by source-node domain.
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

      // Write each domain file via atomic temp+rename.
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
   * Atomic temp+rename per RESEARCH §Pattern 3 / 37-PATTERNS §"Shared
   * Patterns: Atomic temp+rename". Identical contract to
   * `PersistenceManager.writeAtomic`.
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
}
