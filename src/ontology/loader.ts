// Synchronous ontology JSON file reader.
//
// SOURCE: adopted verbatim (with `.js` import path) from OKM's
//   _work/rapid-automations/integrations/operational-knowledge-management/
//   src/ontology/loader.ts (13 lines)
//
// Loader is intentionally SYNCHRONOUS (38-PATTERNS §Pattern S4
// "Sync registry + async store API"): the calling GraphKMStore.open() is
// async, but the underlying file reads are sync because the OntologyRegistry
// is an in-memory map built once at construction and atomically swapped on
// reload(). Do NOT wrap in async / await.
//
// Throws on shape error (missing meta / meta.name / classes). The Plan 03
// registry catches this exception and either rethrows (strict mode) or
// emits a stderr warning and skips the file (default, per D-29 atomicity).
// Loader has no knowledge of strict-mode — registry owns that policy.

import { readFileSync } from 'node:fs';
import type { OntologyFile } from '../types/ontology.js';

export function loadOntologyFile(path: string): OntologyFile {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as OntologyFile;

  if (!parsed.meta || !parsed.meta.name || !parsed.classes) {
    throw new Error(`Invalid ontology file at ${path}: missing meta or classes`);
  }

  return parsed;
}
