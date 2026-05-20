// Phase 38 Plan 06 Task 1 — OntologyRegistry unit tests.
//
// Test layer verifying ALL FOUR Phase 38 success criteria + the D-26..D-29
// decision contracts + the Phase 37 BC-2 invariant preservation.
//
// SC mapping (also called out per-describe-block in comments):
//   SC#1 (auto-discovery) → describe('auto-discovery (ONTO-01)') + reload-add test
//   SC#2 (extends + property merging) → describe('extends + property merging (ONTO-02)')
//   SC#3 (B-shape coding-ontology fixture loads cleanly) → describe('coding-ontology fixture (SC#3 — B-shape proxy)')
//   SC#4 (stable programmatic API surface) → describe('public API (D-28 + canonical refs)') + named-export grep gate at top of file
//
// Decision contracts:
//   D-27 (last-loaded wins + stderr warning + alphabetical order) → describe('collision handling (D-27)')
//   D-29 (explicit reload + atomic rebuild) → describe('reload (D-29)')
//
// Fixtures (Plan 02): tests/fixtures/ontology/{upper,kpifw,business,raas,coding-ontology}.json
//   - upper.json (13 classes — 8 execution + 5 failure model)
//   - kpifw.json (5 classes, meta.extends:"upper", KPIPipeline extends Pipeline)
//   - business.json (5 classes, meta.extends:"upper")
//   - raas.json (6 classes, meta.extends:"upper", RPU extends Component, S3DataPath extends DataAsset)
//   - coding-ontology.json (7 L1 + 5 L2 = 12 classes — synthetic B-shape proxy for SC#3)
//
// Total classes in FIXTURE_DIR when ALL 5 fixtures load: 13 + 5 + 5 + 6 + 12 = 41
// But `Pipeline` collides between upper and coding-ontology → coding overwrites → final unique
// class count is 40 (one collision). The SC#3 test uses ISOLATED tmpdir (only upper + coding)
// to avoid kpifw/business/raas cross-contamination per PATTERNS.md landmine.
//
// no-console-log: tests use process.stderr spy via vitest's vi.spyOn — NO console.* calls
// are introduced in this file.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  OntologyRegistry,
  loadOntologyFile,
  type OntologyRegistryOptions,
  type OntologyFile,
  type OntologyClass,
  type ResolvedClass,
} from '../../src/index.js';

// Static-fixture directory — copied from OKM into km-core by Plan 02; immutable.
// import.meta.dirname is Node 22+ (km-core CI matrix is ['22.x'] per Phase 37).
const FIXTURE_DIR = path.join(import.meta.dirname, '../fixtures/ontology');

// Helper: assert at compile time that the exported types/values are reachable.
// Touching them at runtime forces the import to be retained even with strict
// TypeScript settings + tree-shaking. SC#4 (stable API surface) gate.
const _surfaceWitness: {
  ctor: typeof OntologyRegistry;
  loader: typeof loadOntologyFile;
  optsShape?: OntologyRegistryOptions;
  fileShape?: OntologyFile;
  classShape?: OntologyClass;
  resolvedShape?: ResolvedClass;
} = {
  ctor: OntologyRegistry,
  loader: loadOntologyFile,
};

describe('OntologyRegistry', () => {
  // SC#4 — verify the named exports are reachable from the root barrel.
  it('exposes the documented public API surface (SC#4)', () => {
    expect(typeof _surfaceWitness.ctor).toBe('function');
    expect(typeof _surfaceWitness.loader).toBe('function');
    // The class is constructable — this is the load-bearing SC#4 assertion.
    expect(_surfaceWitness.ctor.name).toBe('OntologyRegistry');
  });

  describe('auto-discovery (ONTO-01)', () => {
    // SC#1 — drop-in new ontology JSON yields new classes without code changes.
    // Verified here (static-fixture load) and in the reload-add test (D-29 path).

    let registry: OntologyRegistry;

    beforeAll(() => {
      // Single shared registry against the immutable static fixture dir.
      registry = new OntologyRegistry({ ontologyDir: FIXTURE_DIR });
    });

    it('loads upper.json + all sibling .json files dynamically', () => {
      // domains getter must include all 5 fixtures' meta.name values.
      expect(registry.domains.has('upper')).toBe(true);
      expect(registry.domains.has('kpifw')).toBe(true);
      expect(registry.domains.has('business')).toBe(true);
      expect(registry.domains.has('raas')).toBe(true);
      expect(registry.domains.has('coding')).toBe(true);
      expect(registry.domains.size).toBe(5);
    });

    it('alphabetical load order is deterministic (D-27)', () => {
      // Verify by tmpdir + two synthetic fixtures with identical class names
      // but distinct meta.name values. The alphabetically-later filename wins.
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-alpha-'));
      try {
        fs.copyFileSync(
          path.join(FIXTURE_DIR, 'upper.json'),
          path.join(tmpdir, 'upper.json'),
        );
        // a-onto.json declares class FooBar with source 'aaaa'
        fs.writeFileSync(
          path.join(tmpdir, 'a-onto.json'),
          JSON.stringify({
            meta: { name: 'aaaa', version: '1.0.0', description: 'alpha-test-a' },
            classes: { FooBar: { description: 'alpha', relationships: {} } },
          }),
        );
        // z-onto.json declares the SAME class FooBar with source 'zzzz'
        fs.writeFileSync(
          path.join(tmpdir, 'z-onto.json'),
          JSON.stringify({
            meta: { name: 'zzzz', version: '1.0.0', description: 'alpha-test-z' },
            classes: { FooBar: { description: 'zeta', relationships: {} } },
          }),
        );

        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const reg = new OntologyRegistry({ ontologyDir: tmpdir });
        // Later alphabetical file wins per D-27 alphabetical-sort contract.
        expect(reg.provenanceOf('FooBar')).toBe('zzzz');
        spy.mockRestore();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });

    it('throws if upper.json is missing', () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-noupper-'));
      try {
        // Empty dir: no upper.json → loader throws → constructor propagates.
        expect(() => new OntologyRegistry({ ontologyDir: tmpdir })).toThrow();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });

    it('skip+warn on malformed lower file (default non-strict)', () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-malformed-'));
      try {
        fs.copyFileSync(
          path.join(FIXTURE_DIR, 'upper.json'),
          path.join(tmpdir, 'upper.json'),
        );
        // Truncated JSON file — JSON.parse throws; loader rethrows.
        fs.writeFileSync(path.join(tmpdir, 'broken.json'), '{ "meta": { "name":');

        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        // Default non-strict → registry catches and warns; does NOT throw.
        const reg = new OntologyRegistry({ ontologyDir: tmpdir });
        // Upper still loaded; broken file skipped.
        expect(reg.isValidClass('Component')).toBe(true);
        // stderr warning must mention the malformed-skip prefix text.
        expect(spy).toHaveBeenCalledWith(
          expect.stringContaining('skipping malformed ontology file'),
        );
        spy.mockRestore();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });

    it('throw on malformed lower file (strict: true)', () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-strict-'));
      try {
        fs.copyFileSync(
          path.join(FIXTURE_DIR, 'upper.json'),
          path.join(tmpdir, 'upper.json'),
        );
        fs.writeFileSync(path.join(tmpdir, 'broken.json'), '{ "meta": { "name":');

        // strict: true → first malformed lower file throws out of the constructor.
        expect(
          () => new OntologyRegistry({ ontologyDir: tmpdir, strict: true }),
        ).toThrow();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });
  });

  describe('extends + property merging (ONTO-02)', () => {
    // SC#2 — per-class extends chains AND ontology-level meta.extends both
    // resolve at load time; child wins on relationship/property conflicts.

    let registry: OntologyRegistry;

    beforeAll(() => {
      registry = new OntologyRegistry({ ontologyDir: FIXTURE_DIR });
    });

    it('child class inherits parent relationships (kpifw.KPIPipeline extends upper.Pipeline)', () => {
      // KPIPipeline is a kpifw lower-ontology class that per-class-extends upper.Pipeline.
      // The merged ResolvedClass must include relationships from BOTH parent (upper.Pipeline)
      // AND child (kpifw.KPIPipeline).
      const kpiPipeline = registry.getClass('KPIPipeline');
      expect(kpiPipeline).toBeDefined();
      expect(kpiPipeline!.relationships).toBeDefined();

      // Parent (upper.Pipeline) relationships — preserved on the merged class.
      const upperPipeline = registry.getClass('Pipeline');
      expect(upperPipeline).toBeDefined();
      // At least one parent relationship key survives on the child.
      const parentRelKeys = Object.keys(upperPipeline!.relationships);
      expect(parentRelKeys.length).toBeGreaterThan(0);
      for (const k of parentRelKeys) {
        expect(kpiPipeline!.relationships).toHaveProperty(k);
      }
    });

    it('child properties override parent on conflict', () => {
      // Synthesize a conflict in tmpdir: parent declares prop X type:string;
      // child declares prop X type:number; child wins.
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-propmerge-'));
      try {
        // Minimal upper.json with a Parent class
        fs.writeFileSync(
          path.join(tmpdir, 'upper.json'),
          JSON.stringify({
            meta: { name: 'upper', version: '1.0.0', description: 'pm-test' },
            classes: {
              Parent: {
                description: 'p',
                relationships: { LINKS: ['Other'] },
                properties: {
                  conflictProp: { type: 'string' },
                  parentOnly: { type: 'string' },
                },
              },
            },
          }),
        );
        // Lower extends Parent and overrides conflictProp.
        fs.writeFileSync(
          path.join(tmpdir, 'child-onto.json'),
          JSON.stringify({
            meta: { name: 'childdom', version: '1.0.0', extends: 'upper', description: 'pm-test' },
            classes: {
              Child: {
                extends: 'Parent',
                description: 'c',
                relationships: {},
                properties: {
                  conflictProp: { type: 'number' },
                  childOnly: { type: 'number' },
                },
              },
            },
          }),
        );

        const reg = new OntologyRegistry({ ontologyDir: tmpdir });
        const child = reg.getClass('Child');
        expect(child).toBeDefined();
        // Child's conflictProp wins on type.
        expect(child!.properties?.conflictProp?.type).toBe('number');
        // Parent-only and child-only props both survive.
        expect(child!.properties?.parentOnly?.type).toBe('string');
        expect(child!.properties?.childOnly?.type).toBe('number');
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });

    it('per-class extends chain across upper→lower (kpifw.KPIPipeline → upper.Pipeline)', () => {
      // The parent-chain traversal exposes the per-class extends edge.
      const chain = registry.parentChainOf('KPIPipeline');
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain[0]!.name).toBe('Pipeline');
    });
  });

  describe('public API (D-28 + canonical refs)', () => {
    // SC#4 — accessor surface is stable and matches the 38-CONTEXT.md spec.

    let registry: OntologyRegistry;

    beforeAll(() => {
      registry = new OntologyRegistry({ ontologyDir: FIXTURE_DIR });
    });

    it('isValidClass / getClass / getAllClassNames round-trip', () => {
      expect(registry.isValidClass('Component')).toBe(true);
      expect(registry.isValidClass('NotAClassName')).toBe(false);
      const cls = registry.getClass('Component');
      expect(cls).toBeDefined();
      expect(cls!.name).toBe('Component');
      const names = registry.getAllClassNames();
      expect(names.includes('Component')).toBe(true);
      expect(names.length).toBeGreaterThan(0);
    });

    it('parentChainOf returns closest-first chain', () => {
      // raas.S3DataPath extends upper.DataAsset (one-step chain).
      const chain = registry.parentChainOf('S3DataPath');
      expect(chain.length).toBeGreaterThanOrEqual(1);
      expect(chain[0]!.name).toBe('DataAsset');
    });

    it('provenanceOf returns source domain', () => {
      // upper.Component → 'upper'
      expect(registry.provenanceOf('Component')).toBe('upper');
      // kpifw.KPIPipeline → 'kpifw'
      expect(registry.provenanceOf('KPIPipeline')).toBe('kpifw');
      // raas.RPU → 'raas'
      expect(registry.provenanceOf('RPU')).toBe('raas');
    });

    it('domains getter exposes loaded ontology names', () => {
      expect(registry.domains.has('upper')).toBe(true);
      expect(registry.domains.has('kpifw')).toBe(true);
      expect(registry.domains.has('business')).toBe(true);
      expect(registry.domains.has('raas')).toBe(true);
      expect(registry.domains.has('coding')).toBe(true);
    });

    it('classCatalog is a ReadonlyMap-shaped view', () => {
      const catalog = registry.classCatalog;
      // Map-shaped surface
      expect(catalog.size).toBeGreaterThan(0);
      expect(typeof catalog.get).toBe('function');
      expect(typeof catalog.has).toBe('function');
      expect(catalog.has('Component')).toBe(true);
      // TypeScript typedef enforces Readonly; at runtime the .set method exists on the
      // underlying Map, but consumers MUST NOT call it. We only assert the read-side
      // contract here — the type system is the enforcement layer.
    });
  });

  describe('collision handling (D-27)', () => {
    // D-27 contract: last-loaded wins + stderr warning text VERBATIM.

    it('last-loaded wins on duplicate class name', () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-coll-'));
      try {
        fs.copyFileSync(
          path.join(FIXTURE_DIR, 'upper.json'),
          path.join(tmpdir, 'upper.json'),
        );
        // a.json declares MyClass with source 'aaa'
        fs.writeFileSync(
          path.join(tmpdir, 'a.json'),
          JSON.stringify({
            meta: { name: 'aaa', version: '1.0.0', description: 'collision-a' },
            classes: { MyClass: { description: 'first', relationships: {} } },
          }),
        );
        // b.json declares MyClass with source 'bbb' — alphabetically later wins.
        fs.writeFileSync(
          path.join(tmpdir, 'b.json'),
          JSON.stringify({
            meta: { name: 'bbb', version: '1.0.0', description: 'collision-b' },
            classes: { MyClass: { description: 'second', relationships: {} } },
          }),
        );

        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        const reg = new OntologyRegistry({ ontologyDir: tmpdir });
        expect(reg.provenanceOf('MyClass')).toBe('bbb');
        spy.mockRestore();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });

    it('emits stderr warning on collision with verbatim D-27 text', () => {
      const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-collwarn-'));
      try {
        fs.copyFileSync(
          path.join(FIXTURE_DIR, 'upper.json'),
          path.join(tmpdir, 'upper.json'),
        );
        fs.writeFileSync(
          path.join(tmpdir, 'a.json'),
          JSON.stringify({
            meta: { name: 'aaa', version: '1.0.0', description: 'cw-a' },
            classes: { Widget: { description: 'first', relationships: {} } },
          }),
        );
        fs.writeFileSync(
          path.join(tmpdir, 'b.json'),
          JSON.stringify({
            meta: { name: 'bbb', version: '1.0.0', description: 'cw-b' },
            classes: { Widget: { description: 'second', relationships: {} } },
          }),
        );

        const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
        new OntologyRegistry({ ontologyDir: tmpdir });

        // Both verbatim substrings from the D-27 spec must appear in the warning.
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('redefined'));
        expect(spy).toHaveBeenCalledWith(expect.stringContaining('last-loaded wins'));

        // Stronger: assert the full collision warning text is emitted verbatim per
        // 38-PATTERNS §registry.ts delta 4 (the exact warning template).
        expect(spy).toHaveBeenCalledWith(
          "[km-core/ontology-registry] class 'Widget' redefined: aaa → bbb (last-loaded wins; see D-27 in 38-CONTEXT.md)\n",
        );

        spy.mockRestore();
      } finally {
        fs.rmSync(tmpdir, { recursive: true, force: true });
      }
    });
  });

  describe('reload (D-29)', () => {
    // SC#1 (no code changes to add a new ontology) → reload-add path.
    // D-29 (explicit reload; atomic rebuild) → contract assertions below.

    let tmpdir: string;

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-reload-'));
    });

    afterEach(() => {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    });

    it('reload() picks up newly-added ontology files', async () => {
      fs.copyFileSync(path.join(FIXTURE_DIR, 'upper.json'), path.join(tmpdir, 'upper.json'));
      const registry = new OntologyRegistry({ ontologyDir: tmpdir });

      // RPU is from raas.json — not loaded yet.
      expect(registry.isValidClass('RPU')).toBe(false);

      // Drop in raas.json — no code changes; explicit reload.
      fs.copyFileSync(path.join(FIXTURE_DIR, 'raas.json'), path.join(tmpdir, 'raas.json'));
      await registry.reload();

      expect(registry.isValidClass('RPU')).toBe(true);
      expect(registry.domains.has('raas')).toBe(true);
    });

    it('reload() forgets removed classes (D-29 last paragraph)', async () => {
      fs.copyFileSync(path.join(FIXTURE_DIR, 'upper.json'), path.join(tmpdir, 'upper.json'));
      fs.copyFileSync(path.join(FIXTURE_DIR, 'raas.json'), path.join(tmpdir, 'raas.json'));
      const registry = new OntologyRegistry({ ontologyDir: tmpdir });
      expect(registry.isValidClass('RPU')).toBe(true);

      // Remove raas.json and reload — registry forgets all raas classes.
      fs.rmSync(path.join(tmpdir, 'raas.json'));
      await registry.reload();

      expect(registry.isValidClass('RPU')).toBe(false);
      expect(registry.domains.has('raas')).toBe(false);
      // upper still loaded.
      expect(registry.isValidClass('Component')).toBe(true);
    });

    it('reload() is atomic — synchronous lookup after await sees fully-new state', async () => {
      // True concurrency under single-threaded JS is observable only via the
      // adjacent-assignment idiom. Assert the contract: immediately after `await
      // reload()` resolves, the registry MUST present the new state in full
      // (no half-built map). This is the D-29 atomic-build invariant.
      fs.copyFileSync(path.join(FIXTURE_DIR, 'upper.json'), path.join(tmpdir, 'upper.json'));
      const registry = new OntologyRegistry({ ontologyDir: tmpdir });
      expect(registry.isValidClass('RPU')).toBe(false);
      expect(registry.isValidClass('KPIPipeline')).toBe(false);

      // Add BOTH raas and kpifw in one filesystem step; reload once.
      fs.copyFileSync(path.join(FIXTURE_DIR, 'raas.json'), path.join(tmpdir, 'raas.json'));
      fs.copyFileSync(path.join(FIXTURE_DIR, 'kpifw.json'), path.join(tmpdir, 'kpifw.json'));
      await registry.reload();

      // Both classes are visible synchronously after the await resolves — the
      // atomic swap means we either see neither or both, never just one.
      expect(registry.isValidClass('RPU')).toBe(true);
      expect(registry.isValidClass('KPIPipeline')).toBe(true);
      expect(registry.domains.has('raas')).toBe(true);
      expect(registry.domains.has('kpifw')).toBe(true);
    });
  });

  describe('coding-ontology fixture (SC#3 — B-shape proxy)', () => {
    // SC#3 — Phase 38's synthetic coding-ontology.json (7 L1 + 5 L2 = 12 classes,
    // derived from B's component-manifest.yaml) loads cleanly against C's upper.json.
    //
    // CRITICAL (PATTERNS landmine + 38-PLAN-CHECK SC#3 carry-forward): use an ISOLATED
    // tmpdir — copy ONLY upper.json + coding-ontology.json. The FIXTURE_DIR contains
    // kpifw/business/raas siblings that would auto-load and pollute the assertions.

    let tmpdir: string;

    beforeEach(() => {
      tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'km-core-onto-sc3-'));
      fs.copyFileSync(path.join(FIXTURE_DIR, 'upper.json'), path.join(tmpdir, 'upper.json'));
      fs.copyFileSync(
        path.join(FIXTURE_DIR, 'coding-ontology.json'),
        path.join(tmpdir, 'coding-ontology.json'),
      );
    });

    afterEach(() => {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    });

    it('loads upper + coding-ontology and resolves 7 L1 + 5 L2 classes', () => {
      // The synthetic fixture redefines `Pipeline` (an upper class) as an L2
      // under SemanticAnalysis. Spy stderr so the collision warning does not
      // pollute test output but the registry still loads successfully.
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const reg = new OntologyRegistry({ ontologyDir: tmpdir });

      // Domains include both fixtures and nothing else.
      expect(reg.domains.has('upper')).toBe(true);
      expect(reg.domains.has('coding')).toBe(true);
      expect(reg.domains.size).toBe(2);

      // 7 L1 component names — all valid classes.
      const l1Names = [
        'LiveLoggingSystem',
        'LLMAbstraction',
        'DockerizedServices',
        'KnowledgeManagement',
        'CodingPatterns',
        'ConstraintSystem',
        'SemanticAnalysis',
      ];
      for (const n of l1Names) {
        expect(reg.isValidClass(n)).toBe(true);
        // Each L1 must come from the 'coding' fixture (not collide with upper).
        expect(reg.provenanceOf(n)).toBe('coding');
      }

      // 5 L2 sub-component names — all valid classes; each extends an L1 parent.
      const l2ToParent: Record<string, string> = {
        ManualLearning: 'KnowledgeManagement',
        OnlineLearning: 'KnowledgeManagement',
        Pipeline: 'SemanticAnalysis', // intentionally collides with upper.Pipeline
        Ontology: 'SemanticAnalysis',
        Insights: 'SemanticAnalysis',
      };
      for (const [child, parent] of Object.entries(l2ToParent)) {
        expect(reg.isValidClass(child)).toBe(true);
        const chain = reg.parentChainOf(child);
        expect(chain.length).toBeGreaterThanOrEqual(1);
        expect(chain[0]!.name).toBe(parent);
      }

      spy.mockRestore();
    });

    it('L1 classes inherit Component relationships via per-class extends "Component"', () => {
      const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const reg = new OntologyRegistry({ ontologyDir: tmpdir });

      const l1Names = [
        'LiveLoggingSystem',
        'LLMAbstraction',
        'DockerizedServices',
        'KnowledgeManagement',
        'CodingPatterns',
        'ConstraintSystem',
        'SemanticAnalysis',
      ];
      const upperComponent = reg.getClass('Component');
      expect(upperComponent).toBeDefined();
      const componentRelKeys = Object.keys(upperComponent!.relationships);
      expect(componentRelKeys.length).toBeGreaterThan(0);

      for (const n of l1Names) {
        const chain = reg.parentChainOf(n);
        expect(chain.length).toBeGreaterThanOrEqual(1);
        expect(chain[0]!.name).toBe('Component');

        // Inherited relationships are merged onto the L1 class.
        const cls = reg.getClass(n);
        expect(cls).toBeDefined();
        for (const k of componentRelKeys) {
          expect(cls!.relationships).toHaveProperty(k);
        }
      }

      spy.mockRestore();
    });
  });
});
