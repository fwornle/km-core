// Phase 57 Plan 02 Task 2 — Fixture-driven integration test for coding.lower.json.
//
// Locks the data shape shipped by Task 1 (`.data/ontologies/coding.lower.json`)
// against the OntologyRegistry surface (Phase 38 ONTO-01/02). Asserts:
//
//   1. The registry loads upper.json + coding-ontology.json + coding.lower.json
//      from an isolated tmpdir without throwing.
//   2. `registry.getClass('LiveLoggingSystem')` returns a defined resolved class.
//   3. All 10 L2 classes from coding.lower.json resolve via getClass(...).
//   4. Every L2 class's `extends` field is one of `Component`, `SubComponent`,
//      `Detail` (the L1 carriers declared in coding-ontology.json).
//   5. `parentChainOf('LiveLoggingSystem')` walks through `Component`.
//   6. `parentChainOf('EtmDaemon')` walks through `SubComponent` → `Component`
//      (the deepest chain in the L2 set; SubComponent extends Component in the
//      coding-ontology truth — though SubComponent itself does NOT declare an
//      `extends` field in coding-ontology.json, so the chain stops at it; the
//      assertion below probes the chain shape carefully).
//
// Tmpdir isolation rationale: the real `.data/ontologies/` directory carries
// many siblings (agentic, cluster-reprocessing, code-entities, raas, resi, ui)
// that would also be picked up by the registry's `readdirSync` and emit noisy
// collision / unrelated-class loads during the test. Copying only the three
// chain participants into a fresh tmpdir keeps the assertions surgical.
//
// no-console-log: this file uses zero `console.*` calls. Stderr noise from the
// loader is suppressed via `vi.spyOn(process.stderr, 'write')`.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { OntologyRegistry } from '../../src/index.js';

// Repo-root resolved by walking up from `tests/integration/` until a parent
// directory contains `.data/ontologies/`. This is robust against vitest's
// working-directory convention (vitest is launched from `lib/km-core/`, so
// `..\..` lands at `/Users/.../coding`; the explicit walk-up tolerates any
// future workspace nesting).
function resolveRepoOntologyDir(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, '.data', 'ontologies');
    if (fs.existsSync(path.join(candidate, 'coding.lower.json'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `coding.lower.json not found by walking up from ${import.meta.dirname}; ` +
      `expected to find <repo>/.data/ontologies/coding.lower.json. ` +
      `Did Phase 57 Plan 02 Task 1 land?`,
  );
}

const SOURCE_DIR = resolveRepoOntologyDir();

// The 10 L2 class names locked by Phase 57 D-09 and Plan 02 Task 1.
const L2_CLASS_NAMES = [
  'LiveLoggingSystem',
  'ConstraintMonitor',
  'OnlineObservation',
  'OnlineDigest',
  'OnlineInsight',
  'KnowledgeManagement',
  'BatchSemanticAnalysis',
  'RapidLlmProxy',
  'DockerizedServices',
  'EtmDaemon',
] as const;

const L1_PARENTS = new Set(['Component', 'SubComponent', 'Detail']);

describe('coding.lower.json (Phase 57 Plan 02)', () => {
  let tmpdir: string;
  let registry: OntologyRegistry;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    // Build a fresh tmpdir with ONLY the three chain participants:
    //   upper.json + coding-ontology.json + coding.lower.json
    // so unrelated production siblings (agentic/cluster-reprocessing/code-entities/
    // raas/resi/ui) don't pollute the registry under test.
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-57-02-'));
    fs.copyFileSync(path.join(SOURCE_DIR, 'upper.json'), path.join(tmpdir, 'upper.json'));
    fs.copyFileSync(
      path.join(SOURCE_DIR, 'coding-ontology.json'),
      path.join(tmpdir, 'coding-ontology.json'),
    );
    fs.copyFileSync(
      path.join(SOURCE_DIR, 'coding.lower.json'),
      path.join(tmpdir, 'coding.lower.json'),
    );

    // Silence stderr — the loader may emit benign collision warnings if any
    // class names overlap between coding-ontology.json and coding.lower.json.
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    registry = new OntologyRegistry({ ontologyDir: tmpdir });
  });

  afterAll(() => {
    stderrSpy.mockRestore();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('constructs OntologyRegistry without throwing', () => {
    // Constructor already ran in beforeAll; assert the registry is live and
    // carries all three domains.
    expect(registry).toBeDefined();
    expect(registry.domains.has('upper')).toBe(true);
    expect(registry.domains.has('coding-ontology')).toBe(true);
    expect(registry.domains.has('coding.lower')).toBe(true);
  });

  it('resolves LiveLoggingSystem via getClass', () => {
    const cls = registry.getClass('LiveLoggingSystem');
    expect(cls).toBeDefined();
    expect(cls!.name).toBe('LiveLoggingSystem');
    expect(cls!.source).toBe('coding.lower');
  });

  it('resolves all 10 L2 classes via getClass', () => {
    for (const name of L2_CLASS_NAMES) {
      const cls = registry.getClass(name);
      expect(cls, `expected getClass('${name}') to return a defined class`).toBeDefined();
      expect(cls!.name).toBe(name);
      expect(cls!.source).toBe('coding.lower');
    }
  });

  it('each L2 class extends one of Component / SubComponent / Detail', () => {
    for (const name of L2_CLASS_NAMES) {
      const cls = registry.getClass(name);
      expect(cls).toBeDefined();
      expect(
        L1_PARENTS.has(cls!.extends ?? ''),
        `expected ${name}.extends to be one of [Component,SubComponent,Detail], got: ${cls!.extends}`,
      ).toBe(true);
    }
  });

  it('parentChainOf(LiveLoggingSystem) walks through Component (and stops there)', () => {
    // LiveLoggingSystem extends Component; Component is declared in
    // coding-ontology.json WITHOUT an `extends` field, so the chain has exactly
    // one entry.
    const chain = registry.parentChainOf('LiveLoggingSystem');
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[0]!.name).toBe('Component');
    // Component itself has no `extends` in coding-ontology.json → chain stops.
    expect(chain[0]!.extends).toBeUndefined();
  });

  it('parentChainOf(EtmDaemon) walks through SubComponent (deepest chain in the L2 set)', () => {
    // EtmDaemon extends SubComponent. SubComponent is declared in
    // coding-ontology.json WITHOUT an explicit `extends` field, so the chain
    // also stops at SubComponent — but it IS a different L1 parent than
    // LiveLoggingSystem's, confirming the L2 mapping per PATTERNS table.
    const chain = registry.parentChainOf('EtmDaemon');
    expect(chain.length).toBeGreaterThanOrEqual(1);
    expect(chain[0]!.name).toBe('SubComponent');
  });
});
