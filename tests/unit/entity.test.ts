// CORE-01: Entity / Relation / Layer / EntityId / SerializedGraph type exports
//
// Wave 0 RED state: imports resolve from '../../src/index.js' which currently
// only exports KM_CORE_VERSION. The missing symbols cause module-resolution
// failures — that IS the expected RED state. Plan 02 (CORE-01 implementation)
// makes these GREEN by adding src/types/entity.ts, src/ids/branded.ts,
// src/store/GraphKMStore.ts and the barrel re-exports in src/index.ts.

import { describe, test, expectTypeOf } from 'vitest';
import type {
  Entity,
  Relation,
  Layer,
  EntityId,
  SerializedGraph,
} from '../../src/index.js';

describe('Entity type', () => {
  test('exports Entity, Relation, Layer, EntityId, SerializedGraph as types', () => {
    // Type-level smoke test: if any of these are not exported as types, the
    // file fails to compile. expectTypeOf gives us a runtime hook so vitest
    // counts this as a test invocation (not just a type-check side-effect).
    expectTypeOf<Entity>().toBeObject();
    expectTypeOf<Relation>().toBeObject();
    expectTypeOf<Layer>().toBeString();
    expectTypeOf<EntityId>().toBeString();
    expectTypeOf<SerializedGraph>().toBeObject();
  });

  test('EntityId branded type rejects raw string at compile time', () => {
    // A plain string is NOT assignable to EntityId — the brand catches it.
    expectTypeOf<string>().not.toMatchTypeOf<EntityId>();

    // The compile-fail half of this check: the next line MUST be flagged
    // by the type-checker. Removing the @ts-expect-error directive should
    // surface a TS error, proving the brand is honored.
    // @ts-expect-error EntityId is branded; raw 'foo' is not assignable.
    const _id: EntityId = 'foo';
    void _id;
  });

  test('Entity shape contains all mandatory and optional fields', () => {
    expectTypeOf<Entity>().toHaveProperty('id');
    expectTypeOf<Entity>().toHaveProperty('name');
    expectTypeOf<Entity>().toHaveProperty('entityType');
    expectTypeOf<Entity>().toHaveProperty('layer');
    expectTypeOf<Entity>().toHaveProperty('description');
    expectTypeOf<Entity>().toHaveProperty('createdAt');
    expectTypeOf<Entity>().toHaveProperty('updatedAt');
    expectTypeOf<Entity>().toHaveProperty('metadata');
    // Optional fields per D-13 + 37-PATTERNS §src/types/entity.ts DELTAS
    expectTypeOf<Entity>().toHaveProperty('ontologyClass');
    expectTypeOf<Entity>().toHaveProperty('validFrom');
    expectTypeOf<Entity>().toHaveProperty('validUntil');
    expectTypeOf<Entity>().toHaveProperty('supersedes');
    expectTypeOf<Entity>().toHaveProperty('legacyId');
  });

  test('Relation has type, from: EntityId, to: EntityId, optional metadata + temporal fields', () => {
    expectTypeOf<Relation>().toHaveProperty('type');
    expectTypeOf<Relation>().toHaveProperty('from');
    expectTypeOf<Relation>().toHaveProperty('to');
    expectTypeOf<Relation>().toHaveProperty('metadata');
    expectTypeOf<Relation>().toHaveProperty('createdAt');
    expectTypeOf<Relation>().toHaveProperty('validFrom');
    expectTypeOf<Relation>().toHaveProperty('validUntil');
  });
});
