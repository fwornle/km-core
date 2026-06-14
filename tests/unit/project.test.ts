// Phase 57 Plan 01 Task 1 — Project type registry unit tests.
//
// Locks the closed-set vocabulary (Phase 57 D-03):
//   PROJECTS = ['coding', 'okm', 'cap'] as const
//   type Project = typeof PROJECTS[number]
//   isProject(x: unknown): x is Project
//
// Source of truth for the project dimension across every km-core writer
// (wave agents, canonical-mapper, km-core-adapter, online-mapper,
// legacy-ingest, backfill). Adding a new project = code change here +
// updating this test file's expectations.
//
// Style: mirrors tests/unit/ontology-registry.test.ts (describe/it
// blocks, expect().toBe(true) assertions). Vitest, ES-module imports.

import { describe, it, expect } from 'vitest';
import { PROJECTS, isProject, type Project } from '../../src/index.js';

// SC#4-style surface witness — touching the named exports at runtime
// forces the import to be retained even with strict tree-shaking and
// proves the root-barrel re-export landed.
const _surfaceWitness: {
  projects: typeof PROJECTS;
  guard: typeof isProject;
  literal?: Project;
} = {
  projects: PROJECTS,
  guard: isProject,
};

describe('Project type registry (Phase 57 D-03)', () => {
  describe('PROJECTS const tuple', () => {
    it('is a readonly tuple of length 3', () => {
      expect(_surfaceWitness.projects).toBeDefined();
      expect(Array.isArray(PROJECTS)).toBe(true);
      expect(PROJECTS.length).toBe(3);
    });

    it('contains exactly "coding", "okm", "cap" in declared order', () => {
      // Order is load-bearing: adding a new project = appending here +
      // updating any consumer that depends on positional indexing.
      expect(PROJECTS[0]).toBe('coding');
      expect(PROJECTS[1]).toBe('okm');
      expect(PROJECTS[2]).toBe('cap');
    });

    it('exposes all three known projects via includes()', () => {
      expect((PROJECTS as readonly string[]).includes('coding')).toBe(true);
      expect((PROJECTS as readonly string[]).includes('okm')).toBe(true);
      expect((PROJECTS as readonly string[]).includes('cap')).toBe(true);
    });
  });

  describe('isProject typeguard — accept-list', () => {
    it('returns true for "coding"', () => {
      expect(isProject('coding')).toBe(true);
    });

    it('returns true for "okm"', () => {
      expect(isProject('okm')).toBe(true);
    });

    it('returns true for "cap"', () => {
      expect(isProject('cap')).toBe(true);
    });
  });

  describe('isProject typeguard — reject-list', () => {
    it('returns false for "CODING" (case-sensitive — vocabulary is lowercase per D-03)', () => {
      expect(isProject('CODING')).toBe(false);
    });

    it('returns false for "Coding" (case-sensitive — vocabulary is lowercase per D-03)', () => {
      expect(isProject('Coding')).toBe(false);
    });

    it('returns false for an unknown project name "foo"', () => {
      expect(isProject('foo')).toBe(false);
    });

    it('returns false for an empty string', () => {
      expect(isProject('')).toBe(false);
    });

    it('returns false for undefined', () => {
      expect(isProject(undefined)).toBe(false);
    });

    it('returns false for null', () => {
      expect(isProject(null)).toBe(false);
    });

    it('returns false for a number (42)', () => {
      expect(isProject(42)).toBe(false);
    });

    it('returns false for an object literal ({})', () => {
      expect(isProject({})).toBe(false);
    });

    it('returns false for an array containing a valid project name', () => {
      // Defence: a typeguard MUST inspect the value's type, not just
      // membership in PROJECTS.
      expect(isProject(['coding'])).toBe(false);
    });
  });

  describe('compile-time Project literal type', () => {
    it('accepts assignments from PROJECTS members (compile-time witness)', () => {
      // If the Project literal-union type drifts away from the PROJECTS
      // tuple, this assignment line stops compiling — caught by `tsc`.
      const coding: Project = 'coding';
      const okm: Project = 'okm';
      const cap: Project = 'cap';
      expect(coding).toBe('coding');
      expect(okm).toBe('okm');
      expect(cap).toBe('cap');
    });
  });
});
