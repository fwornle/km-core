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
import { type ExportLayout, domainLayout } from './layout.js';
import { TOMBSTONES_ATTR, relationKey, tombstonesOf, type Tombstones } from './merge.js';

type Node = SerializedGraph['nodes'][number];
type Edge = SerializedGraph['edges'][number];

export interface ExporterOptions {
  /** Absolute or relative directory where per-domain JSON files land.
   *  Ignored for placement when `layout` is given. */
  exportDir: string;
  /** Known domain names. Members get their own `${domain}.json` file;
   *  everything else falls through to `general.json`. Defaults to
   *  `['general']`. Ignored when `layout` is given. */
  domains?: readonly string[];
  /** Where each bucket is written. Default: `domainLayout(exportDir, domains)`. */
  layout?: ExportLayout;
  /** Debounce window in ms. The export fires this long after the LAST
   *  call to `scheduleExport`. Default 5000ms per D-22. */
  debounceMs?: number;
}

/**
 * Event-driven debounced JSON exporter for KM-Core graphs.
 *
 * Wiring (Plan 04): `GraphKMStore` constructs an `Exporter`, and on each
 * of its EventEmitter mutation events (`entity:put`, `entity:delete`,
 * `relation:added`, `relation:removed`) calls
 * `exporter.scheduleExport(this.graph.export() as SerializedGraph)`.
 * On `close()`, `await exporter.flush()` to drain any pending timer.
 */
export class Exporter {
  private layout: ExportLayout;
  private debounceMs: number;
  private exportTimer: NodeJS.Timeout | null = null;
  private pendingSnapshot: SerializedGraph | null = null;
  private writing = false;
  /** Last content written (or found) per file — an unchanged file is not
   *  rewritten, so a shared learning checkout only changes when the data does. */
  private lastContent = new Map<string, string>();
  /** Relations whose endpoint is not on this machine, per file they came from. */
  private dangling = new Map<string, Edge[]>();
  /** size+mtime of each file as this exporter last left it. */
  private lastStat = new Map<string, string>();
  /** Called (once per export) when a target file was changed by someone else
   *  since this exporter last wrote it — typically `git pull` / a merge in a
   *  learning checkout. That file is NOT overwritten: the store merges it
   *  into the live graph first (`reloadSources`), whose next export then
   *  writes the union. Without this, an export landing between a pull and the
   *  reload would overwrite the teammate's changes with the stale live graph,
   *  and the next commit would record their removal. */
  onExternalChange: ((files: string[]) => void) | null = null;

  constructor(opts: ExporterOptions) {
    // Defense-in-depth (T-37-03-02): resolve `exportDir`. Consumers in
    // Plan 04 supply a vetted path; this is belt-and-braces.
    const exportDir = path.resolve(opts.exportDir);
    this.layout = opts.layout ?? domainLayout(exportDir, opts.domains ?? ['general']);
    this.debounceMs = opts.debounceMs ?? 5000;

    if (!opts.layout) fs.mkdirSync(exportDir, { recursive: true });
  }

  /** Relations to carry through every export of the file they were read
   *  from, because the in-memory graph cannot hold them (see merge.ts). */
  setDangling(byFile: Map<string, Edge[]>): void {
    this.dangling = byFile;
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
   * Write `data` out through the layout:
   *   - nodes go to the file of their bucket (`layout.bucketOf(metadata)`),
   *   - edges go to the file of their SOURCE node (each edge lands in
   *     exactly one file),
   *   - tombstones go to the file their entity (or the relation's source)
   *     was filed in,
   *   - relations kept aside as dangling go back to the file they came from,
   *   - each file is written via `${path}.tmp.${pid}.${ts}` then
   *     `fs.promises.rename` (atomic on POSIX), and only when its content
   *     changed.
   *
   * Re-entry guard: a concurrent call returns early without throwing.
   * Returns `void` either way.
   */
  async exportJson(data: SerializedGraph): Promise<void> {
    if (this.writing) return;
    this.writing = true;
    try {
      const L = this.layout;
      const files = new Map<string, { nodes: Node[]; edges: Edge[]; stones: Tombstones }>();
      const slot = (file: string) => {
        let f = files.get(file);
        if (!f) files.set(file, (f = { nodes: [], edges: [], stones: { entities: {}, relations: {} } }));
        return f;
      };

      const nodeFile = new Map<string, string>();
      for (const node of data.nodes) {
        const file = L.fileFor(L.bucketOf(node.attributes?.metadata as Record<string, unknown> | undefined));
        nodeFile.set(node.key, file);
        slot(file).nodes.push(node);
      }
      for (const b of L.alwaysWrite ?? []) slot(L.fileFor(b));

      const live = new Set<string>();
      for (const e of data.edges) {
        const file = nodeFile.get(e.source) ?? L.fileFor(L.bucketOf(undefined));
        slot(file).edges.push(e);
        live.add(relationKey(e.source, String((e.attributes as { type?: string })?.type ?? ''), e.target));
      }

      const stones = tombstonesOf(data);
      for (const [id, t] of Object.entries(stones.entities)) {
        slot(L.fileFor(L.bucketOf(t.meta))).stones.entities[id] = t;
      }
      for (const [k, t] of Object.entries(stones.relations)) {
        slot(L.fileFor(L.bucketOf(t.meta))).stones.relations[k] = t;
      }

      for (const [file, edges] of this.dangling) {
        for (const e of edges) {
          const k = relationKey(e.source, String((e.attributes as { type?: string })?.type ?? ''), e.target);
          if (live.has(k) || stones.relations[k] || stones.entities[e.source] || stones.entities[e.target]) continue;
          slot(file).edges.push(e);
        }
      }

      // A file this machine wrote before (or owns) that no bucket maps to
      // any more is emptied, so what moved out of it does not linger there.
      for (const file of this.lastContent.keys()) {
        if (!files.has(file) && (L.owns?.(file) ?? false)) slot(file);
      }

      const { [TOMBSTONES_ATTR]: _omit, ...baseAttrs } = data.attributes ?? {};
      void _omit;
      const writes: Promise<void>[] = [];
      for (const [file, f] of files) {
        if (L.canonicalOrder) {
          f.nodes.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
          f.edges.sort((a, b) => {
            const ka = `${a.source}\u0000${(a.attributes as { type?: string })?.type ?? ''}\u0000${a.target}`;
            const kb = `${b.source}\u0000${(b.attributes as { type?: string })?.type ?? ''}\u0000${b.target}`;
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          });
        }
        const hasStones = Object.keys(f.stones.entities).length + Object.keys(f.stones.relations).length > 0;
        const graph: SerializedGraph = {
          attributes: hasStones ? { ...baseAttrs, [TOMBSTONES_ATTR]: f.stones } : baseAttrs,
          options: data.options,
          nodes: f.nodes,
          edges: f.edges,
        };
        writes.push(this.writeAtomic(file, graph));
      }
      this.externallyChanged = [];
      await Promise.all(writes);
      const changed = this.externallyChanged;
      this.externallyChanged = [];
      if (changed.length && this.onExternalChange) this.onExternalChange(changed);
    } finally {
      this.writing = false;
    }
  }

  private externallyChanged: string[] = [];

  private async statKey(filePath: string): Promise<string | null> {
    try {
      const st = await fs.promises.stat(filePath);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return null;
    }
  }

  /**
   * Atomic temp+rename per RESEARCH §Pattern 3 / 37-PATTERNS §"Shared
   * Patterns: Atomic temp+rename". Skips the write when the file already
   * holds exactly this content, and when someone else changed the file
   * since this exporter last wrote it (see `onExternalChange`).
   */
  private async writeAtomic(
    filePath: string,
    domainGraph: SerializedGraph,
  ): Promise<void> {
    const text = JSON.stringify(domainGraph, null, 2);
    const known = this.lastStat.get(filePath);
    const now = await this.statKey(filePath);
    if (!this.lastContent.has(filePath) || (known !== undefined && now !== known)) {
      let disk: string | undefined;
      try {
        disk = await fs.promises.readFile(filePath, 'utf-8');
      } catch {
        // not there yet
      }
      const external = known !== undefined && disk !== undefined && disk !== this.lastContent.get(filePath);
      if (disk !== undefined) this.lastContent.set(filePath, disk);
      if (now !== null) this.lastStat.set(filePath, now);
      if (external && disk !== text && this.onExternalChange) {
        this.externallyChanged.push(filePath);
        return;
      }
    }
    if (this.lastContent.get(filePath) === text) {
      if (now !== null) this.lastStat.set(filePath, now);
      return;
    }
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tempPath, text, 'utf-8');
    await fs.promises.rename(tempPath, filePath); // atomic on POSIX
    this.lastContent.set(filePath, text);
    const after = await this.statKey(filePath);
    if (after !== null) this.lastStat.set(filePath, after);
  }
}
