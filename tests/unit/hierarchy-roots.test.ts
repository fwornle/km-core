// Phase 60 Plan 04 Task 1 — Hierarchy roots registry unit tests.
//
// Locks the closed-set vocabulary (Phase 60 D-14 + D-23):
//   HIERARCHY_ROOTS = ['CollectiveKnowledge', 'Coding', 'DynArch', 'Timeline', 'Normalisa'] as const
//   type HierarchyRoot = typeof HIERARCHY_ROOTS[number]
//   HIERARCHY_ROOT_CLASS: Record<HierarchyRoot, 'System' | 'Project'>
//   isHierarchyRoot(x: unknown): x is HierarchyRoot
//
// Single source of truth for the names that are hard-locked at the writer
// + LLM-classifier boundary. The re-classifier (Phase 60 D-14 guard in
// ontology-classification-agent.ts) AND the one-shot repair script
// (scripts/repair-ck-ontology-class.mjs) both consume this module so the
// truth lives once.
//
// Style: mirrors tests/unit/project.test.ts (describe/it blocks,
// expect().toBe(true) assertions). Vitest, ES-module imports.

import { describe, it, expect } from 'vitest';
// Task 1 imports the module directly to keep the test self-contained.
// Task 2 wires the per-module + root barrels and appends a
// root-barrel-reachability assertion to the bottom of this file.
import {
  HIERARCHY_ROOTS,
  HIERARCHY_ROOT_CLASS,
  isHierarchyRoot,
  type HierarchyRoot,
} from '../../src/types/hierarchy-roots.js';

// SC#4-style surface witness — touching the named exports at runtime
// forces the import to be retained even with strict tree-shaking and
// proves the module exports landed.
const _surfaceWitness: {
  roots: typeof HIERARCHY_ROOTS;
  classMap: typeof HIERARCHY_ROOT_CLASS;
  guard: typeof isHierarchyRoot;
  literal?: HierarchyRoot;
} = {
  roots: HIERARCHY_ROOTS,
  classMap: HIERARCHY_ROOT_CLASS,
  guard: isHierarchyRoot,
};

describe('Hierarchy roots registry (Phase 60 D-14 + D-23)', () => {
  describe('HIERARCHY_ROOTS const tuple', () => {
    it('is a readonly tuple of length 5', () => {
      expect(_surfaceWitness.roots).toBeDefined();
      expect(Array.isArray(HIERARCHY_ROOTS)).toBe(true);
      expect(HIERARCHY_ROOTS.length).toBe(5);
    });

    // Test 1 (plan): HIERARCHY_ROOTS contains exactly the 5 D-14 names.
    it('contains exactly ["CollectiveKnowledge", "Coding", "DynArch", "Timeline", "Normalisa"]', () => {
      expect(HIERARCHY_ROOTS[0]).toBe('CollectiveKnowledge');
      expect(HIERARCHY_ROOTS[1]).toBe('Coding');
      expect(HIERARCHY_ROOTS[2]).toBe('DynArch');
      expect(HIERARCHY_ROOTS[3]).toBe('Timeline');
      expect(HIERARCHY_ROOTS[4]).toBe('Normalisa');
    });
  });

  describe('HIERARCHY_ROOT_CLASS map', () => {
    // Test 2 (plan): CollectiveKnowledge -> System.
    it('maps "CollectiveKnowledge" to "System"', () => {
      expect(HIERARCHY_ROOT_CLASS.CollectiveKnowledge).toBe('System');
    });

    // Test 3 (plan): the 4 project anchors all map to Project.
    it('maps "Coding" to "Project"', () => {
      expect(HIERARCHY_ROOT_CLASS.Coding).toBe('Project');
    });

    it('maps "DynArch" to "Project"', () => {
      expect(HIERARCHY_ROOT_CLASS.DynArch).toBe('Project');
    });

    it('maps "Timeline" to "Project"', () => {
      expect(HIERARCHY_ROOT_CLASS.Timeline).toBe('Project');
    });

    it('maps "Normalisa" to "Project"', () => {
      expect(HIERARCHY_ROOT_CLASS.Normalisa).toBe('Project');
    });

    it('covers every HIERARCHY_ROOTS entry (no missing keys)', () => {
      for (const name of HIERARCHY_ROOTS) {
        expect(HIERARCHY_ROOT_CLASS[name]).toBeDefined();
      }
    });
  });

  describe('isHierarchyRoot typeguard — accept-list', () => {
    // Test 4 (plan): isHierarchyRoot('CollectiveKnowledge') === true.
    it('returns true for "CollectiveKnowledge"', () => {
      expect(isHierarchyRoot('CollectiveKnowledge')).toBe(true);
    });

    it('returns true for "Coding"', () => {
      expect(isHierarchyRoot('Coding')).toBe(true);
    });

    it('returns true for "DynArch"', () => {
      expect(isHierarchyRoot('DynArch')).toBe(true);
    });

    it('returns true for "Timeline"', () => {
      expect(isHierarchyRoot('Timeline')).toBe(true);
    });

    it('returns true for "Normalisa"', () => {
      expect(isHierarchyRoot('Normalisa')).toBe(true);
    });
  });

  describe('isHierarchyRoot typeguard — reject-list', () => {
    // Test 5 (plan): isHierarchyRoot('SomeRandomEntity') === false.
    it('returns false for "SomeRandomEntity"', () => {
      expect(isHierarchyRoot('SomeRandomEntity')).toBe(false);
    });

    it('returns false for "collectiveknowledge" (case-sensitive)', () => {
      expect(isHierarchyRoot('collectiveknowledge')).toBe(false);
    });

    it('returns false for "Ui" (Phase 57 team-anchor remnant, excluded per D-14)', () => {
      expect(isHierarchyRoot('Ui')).toBe(false);
    });

    it('returns false for "Resi"', () => {
      expect(isHierarchyRoot('Resi')).toBe(false);
    });

    it('returns false for "Raas"', () => {
      expect(isHierarchyRoot('Raas')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isHierarchyRoot('')).toBe(false);
    });

    // Test 6 (plan): isHierarchyRoot(null) === false (defensive against unknown input).
    it('returns false for null', () => {
      expect(isHierarchyRoot(null)).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isHierarchyRoot(undefined)).toBe(false);
    });

    it('returns false for a number (42)', () => {
      expect(isHierarchyRoot(42)).toBe(false);
    });

    it('returns false for an object literal ({})', () => {
      expect(isHierarchyRoot({})).toBe(false);
    });

    it('returns false for an array containing a valid root name', () => {
      // Defence: a typeguard MUST inspect the value's type, not just
      // membership in HIERARCHY_ROOTS.
      expect(isHierarchyRoot(['CollectiveKnowledge'])).toBe(false);
    });
  });

  describe('compile-time HierarchyRoot literal type', () => {
    // Test 7 (plan): HierarchyRoot literal-union equals the 5 names.
    // If the literal-union type drifts away from the HIERARCHY_ROOTS tuple,
    // these assignments stop compiling — caught by `tsc`.
    it('accepts assignments from HIERARCHY_ROOTS members (compile-time witness)', () => {
      const ck: HierarchyRoot = 'CollectiveKnowledge';
      const coding: HierarchyRoot = 'Coding';
      const dynarch: HierarchyRoot = 'DynArch';
      const timeline: HierarchyRoot = 'Timeline';
      const normalisa: HierarchyRoot = 'Normalisa';
      expect(ck).toBe('CollectiveKnowledge');
      expect(coding).toBe('Coding');
      expect(dynarch).toBe('DynArch');
      expect(timeline).toBe('Timeline');
      expect(normalisa).toBe('Normalisa');
    });
  });
});

// Root-barrel reachability gate.
// Verifies the Phase 60 D-14 surface is reachable via `@fwornle/km-core`
// (root barrel) AND `@fwornle/km-core/types` (sub-path), without going
// through src/types/hierarchy-roots.js directly. Locks the barrel wiring
// that downstream consumers (semantic-analysis writer guard, repair script)
// depend on.
import * as rootBarrel from '../../src/index.js';
import * as typesBarrel from '../../src/types/index.js';

describe('Hierarchy roots barrel re-exports (Phase 60 Plan 04 Task 1)', () => {
  it('exposes HIERARCHY_ROOTS + isHierarchyRoot via the root barrel @fwornle/km-core', () => {
    expect(rootBarrel.HIERARCHY_ROOTS).toBe(HIERARCHY_ROOTS);
    expect(rootBarrel.isHierarchyRoot).toBe(isHierarchyRoot);
    expect(rootBarrel.HIERARCHY_ROOT_CLASS).toBe(HIERARCHY_ROOT_CLASS);
  });

  it('exposes HIERARCHY_ROOTS + isHierarchyRoot via the types sub-barrel @fwornle/km-core/types', () => {
    expect(typesBarrel.HIERARCHY_ROOTS).toBe(HIERARCHY_ROOTS);
    expect(typesBarrel.isHierarchyRoot).toBe(isHierarchyRoot);
    expect(typesBarrel.HIERARCHY_ROOT_CLASS).toBe(HIERARCHY_ROOT_CLASS);
  });
});
