// OntologyRegistry — Phase 38 ONTO-01 (auto-discovery) + ONTO-02 (extends + property merging).
//
// SOURCE: adopted from OKM's 86-line analog at
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ontology/registry.ts
// with the five Phase 38 deltas applied per 38-PATTERNS §src/ontology/registry.ts:
//   1. Options-object constructor (D-28) — `new OntologyRegistry({ ontologyDir, strict? })`
//      replaces OKM's free `.load(dir)` method; matches Phase 37 D-14 idiom.
//   2. Async atomic reload() (D-29) — builds new maps in local vars then assigns
//      in two adjacent statements. JS single-threaded execution + adjacent-assignment
//      idiom means a concurrent isValidClass / findByOntologyClass either sees the
//      old map or the new map, never a half-built one. No locks; no Mutex.
//   3. stderr warn + strict-mode rethrow on malformed lower files (D-27 + repo-wide
//      no-console-log constraint). OKM's silent catch is the bug; Phase 38 fixes it.
//   4. Collision warning on overwriting (D-27) — when two ontology files declare the
//      same class name, the second one wins AND a stderr warning names the previous
//      source, the new source, and points operators to D-27 in 38-CONTEXT.md.
//   5. Provenance / parent-chain accessors + readonly views — parentChainOf(),
//      provenanceOf(), classCatalog getter (ReadonlyMap), domains getter (ReadonlySet).
//
// All 6 of OKM's public lookup methods (isValidClass, getClass, getAllClassNames,
// getDefaultLayer, getValidRelationships, getLoadedDomains) plus the LLM-context
// formatter getClassesForPrompt() are preserved verbatim — Phase 40/42 consumers
// depend on these signatures.
//
// JSDoc prose only; no fenced code blocks (so the no-console-log grep gate stays
// clean per 38-PLAN-CHECK FLAG-3).

import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { loadOntologyFile } from './loader.js';
import type { OntologyFile, ResolvedClass } from '../types/ontology.js';

export interface OntologyRegistryOptions {
  /** Directory containing upper.json + lower ontology JSON files (D-28). */
  ontologyDir: string;
  /**
   * When true, malformed lower-ontology files throw instead of warn+skip.
   * Default false: skip+warn per D-29 atomicity — one bad file does not block the
   * rest of the catalog. Production deployments that require partial loads to be
   * fatal opt in via `strict: true`.
   */
  strict?: boolean;
}

export class OntologyRegistry {
  private readonly ontologyDir: string;
  private readonly strict: boolean;
  private classes = new Map<string, ResolvedClass>();
  private loadedDomains = new Set<string>();

  constructor(opts: OntologyRegistryOptions) {
    this.ontologyDir = opts.ontologyDir;
    this.strict = opts.strict ?? false;
    this.loadFromDisk();
  }

  /**
   * Initial load — populates this.classes and this.loadedDomains directly.
   * Called once from the constructor. For atomic rebuild on an established
   * registry, see reload().
   */
  private loadFromDisk(): void {
    // upper.json is mandatory; missing-file throw from the loader propagates.
    const upper = loadOntologyFile(join(this.ontologyDir, 'upper.json'));
    this.registerClasses(this.classes, upper, 'upper');
    this.loadedDomains.add('upper');

    // Discover all other .json files; alphabetical sort is the D-27 deterministic
    // load-order contract — preserved verbatim from OKM.
    const files = readdirSync(this.ontologyDir).filter(
      (f) => f.endsWith('.json') && f !== 'upper.json',
    );
    for (const file of files.sort()) {
      try {
        const lower = loadOntologyFile(join(this.ontologyDir, file));
        this.registerClasses(this.classes, lower, lower.meta.name);
        this.loadedDomains.add(lower.meta.name);
      } catch (err: unknown) {
        if (this.strict) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[km-core/ontology-registry] skipping malformed ontology file '${file}': ${msg}\n`,
        );
      }
    }
  }

  /**
   * Re-scan ontologyDir and rebuild the class catalog atomically (D-29).
   *
   * Atomic-before-swap contract: new maps are built fully in local variables;
   * only after the loop completes do the two adjacent assignment statements swap
   * the internal references. A concurrent lookup either sees the old map or the
   * new map, never a half-built one. Relies on JS single-threaded execution —
   * no locks, no Mutex.
   *
   * Async signature matches Phase 37's store-API idiom (Pattern S4) even though
   * the underlying reads are synchronous; this leaves room for a v0.2 non-blocking
   * implementation without changing the public surface.
   */
  async reload(): Promise<void> {
    const newClasses = new Map<string, ResolvedClass>();
    const newDomains = new Set<string>();

    const upper = loadOntologyFile(join(this.ontologyDir, 'upper.json'));
    this.registerClasses(newClasses, upper, 'upper');
    newDomains.add('upper');

    const files = readdirSync(this.ontologyDir).filter(
      (f) => f.endsWith('.json') && f !== 'upper.json',
    );
    for (const file of files.sort()) {
      try {
        const lower = loadOntologyFile(join(this.ontologyDir, file));
        this.registerClasses(newClasses, lower, lower.meta.name);
        newDomains.add(lower.meta.name);
      } catch (err: unknown) {
        if (this.strict) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[km-core/ontology-registry] skipping malformed ontology file '${file}': ${msg}\n`,
        );
      }
    }

    // Atomic swap — two adjacent statements; no observable intermediate state.
    this.classes = newClasses;
    this.loadedDomains = newDomains;
  }

  /**
   * Register the classes from one ontology file into the supplied target map.
   *
   * ONTO-02 extends + property merging is preserved verbatim from OKM:
   * `{ ...classDef, relationships: { ...parent.relationships, ...classDef.relationships },
   *    properties: { ...parent.properties, ...classDef.properties } }` — child wins on
   * key conflicts.
   *
   * D-27 collision warning is emitted when this.classes.set would overwrite a
   * class registered by a different source.
   */
  private registerClasses(
    target: Map<string, ResolvedClass>,
    file: OntologyFile,
    source: string,
  ): void {
    for (const [name, classDef] of Object.entries(file.classes)) {
      let merged: typeof classDef = { ...classDef };

      if (classDef.extends) {
        const parent = target.get(classDef.extends);
        if (parent) {
          merged = {
            ...classDef,
            relationships: { ...parent.relationships, ...classDef.relationships },
            properties: { ...parent.properties, ...classDef.properties },
          };
        }
      }

      const prev = target.get(name);
      if (prev && prev.source !== source) {
        process.stderr.write(
          `[km-core/ontology-registry] class '${name}' redefined: ${prev.source} → ${source} (last-loaded wins; see D-27 in 38-CONTEXT.md)\n`,
        );
      }

      target.set(name, { ...merged, name, source });
    }
  }

  isValidClass(className: string): boolean {
    return this.classes.has(className);
  }

  getClass(className: string): ResolvedClass | undefined {
    return this.classes.get(className);
  }

  getAllClassNames(): string[] {
    return Array.from(this.classes.keys());
  }

  /**
   * LLM-context formatter — used by Phase 40/42 to render the class catalog
   * into a prompt. Preserved verbatim from OKM.
   */
  getClassesForPrompt(): string {
    return Array.from(this.classes.entries())
      .map(([name, c]) => {
        const rels = Object.entries(c.relationships)
          .map(([type, targets]) => `${type}->${targets.join('|')}`)
          .join(', ');
        const layer = c.defaultLayer ? ` [layer: ${c.defaultLayer}]` : '';
        return `${name}${c.extends ? ` (extends ${c.extends})` : ''}: ${c.description}${layer} [${rels}]`;
      })
      .join('\n');
  }

  getDefaultLayer(className: string): 'evidence' | 'pattern' | undefined {
    return this.classes.get(className)?.defaultLayer;
  }

  getValidRelationships(className: string): Record<string, string[]> | undefined {
    const cls = this.classes.get(className);
    return cls?.relationships;
  }

  /** Returns the set of domain names that were successfully loaded. */
  getLoadedDomains(): string[] {
    return Array.from(this.loadedDomains);
  }

  /**
   * Returns the chain of resolved-parent classes (closest parent first),
   * traversing the per-class `extends` field. Stops on a missing parent or
   * when the chain reaches a class with no `extends`.
   */
  parentChainOf(className: string): ResolvedClass[] {
    const chain: ResolvedClass[] = [];
    let cur = this.classes.get(className);
    while (cur?.extends) {
      const parent = this.classes.get(cur.extends);
      if (!parent) break;
      chain.push(parent);
      cur = parent;
    }
    return chain;
  }

  /**
   * Returns the source-domain name of the ontology file that registered the
   * given class — i.e. the value of `meta.name` for the winning loader pass.
   */
  provenanceOf(className: string): string | undefined {
    return this.classes.get(className)?.source;
  }

  /** Read-only view onto the resolved class catalog. */
  get classCatalog(): ReadonlyMap<string, ResolvedClass> {
    return this.classes;
  }

  /** Read-only view onto the set of loaded ontology domain names. */
  get domains(): ReadonlySet<string> {
    return this.loadedDomains;
  }
}
