// ExportLayout — where each part of the graph is persisted as JSON.
//
// km-core used to write one file per `metadata.domain` into one directory.
// A consumer that shares knowledge per repo (coding: every repo's learned
// data lives in that repo's own learning checkout) needs the graph split by
// a key of ITS choosing into files in directories of ITS choosing, and needs
// hydrate to read all of them back. The layout is that seam: km-core decides
// how to merge, the consumer decides where things live.

import * as path from 'node:path';

export interface ExportLayout {
  /** The bucket an entity is filed under, from its metadata. Also used for
   *  tombstones, which carry a copy of the deleted entity's metadata keys. */
  bucketOf(metadata: Record<string, unknown> | undefined): string;
  /** Absolute path of the JSON file a bucket is written to. */
  fileFor(bucket: string): string;
  /** Every file hydrate reads and merges. Missing files are skipped. */
  sources(): string[];
  /** Whether this machine may rewrite `file` with an empty graph once no
   *  bucket maps to it any more. A file in a SHARED place (another repo's
   *  learning checkout) must never be emptied just because this machine
   *  files that bucket elsewhere. Default: never. */
  owns?(file: string): boolean;
  /** Buckets written even when empty (the domain layout's fixed files). */
  alwaysWrite?: readonly string[];
  /** Sort nodes and edges by key in each file, so two machines holding the
   *  same graph write byte-identical files (git sees no change). */
  canonicalOrder?: boolean;
}

/** The metadata keys a tombstone keeps so a layout can file it. */
export const TOMBSTONE_META_KEYS = ['project', 'team', 'domain'] as const;

/**
 * The original layout: one `${domain}.json` per configured domain in one
 * directory, everything else in `general.json`. The default when a store is
 * given no layout.
 */
export function domainLayout(exportDir: string, domains: readonly string[] = ['general']): ExportLayout {
  const dir = path.resolve(exportDir);
  const known = new Set(domains);
  const fixed = [...new Set([...domains, 'general'])];
  return {
    bucketOf(metadata) {
      const d = (metadata?.domain as string) || 'general';
      return known.has(d) ? d : 'general';
    },
    fileFor: (bucket) => path.join(dir, `${bucket}.json`),
    sources: () => fixed.map((d) => path.join(dir, `${d}.json`)),
    owns: (file) => path.dirname(path.resolve(file)) === dir,
    alwaysWrite: fixed,
    canonicalOrder: false,
  };
}
