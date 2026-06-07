// Phase 45 Plan 04: per-class display-hints overlay loader.
//
// SOURCE:
//   - 45-RESEARCH.md §Open Question #4 Example 4 — overlay file format +
//     fs.existsSync gate + JSON.parse with stderr-warn on malformed.
//   - 45-CONTEXT.md §D-45-03 — display block lives alongside each
//     ontology JSON as `.data/ontologies/{system}.display.json`.
//   - 45-UI-SPEC.md §Color "Ontology-driven node color contract" — the
//     consumer of `display.color` is SigmaCanvas (graph node fill).
//
// Contract:
//   - `ontologyDir` is REQUIRED (non-empty string). Throws on empty per
//     CLAUDE.md ontologyDir-invariant (Phase 41 lesson; T-45-04-06).
//   - Missing file is NOT an error — returns {} (operator may have not
//     authored a display.json for this system yet).
//   - Malformed JSON triggers a one-line stderr warning and returns {} —
//     graph render falls back to FNV-1a deterministic hue (45-UI-SPEC).
//
// no-console-log: stderr only. JSDoc prose, no fenced code blocks (matches
// km-core repo discipline per registry.ts:27).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Per-class visual hint surfaced via /api/v1/ontology/classes?withDisplay=true.
 * All three fields are optional — the viewer falls back to the deterministic
 * FNV-1a hue formula (45-UI-SPEC.md §Color) when a field is absent.
 */
export interface DisplayHint {
  /** Hex color string (#rrggbb) used as the node fill on the graph canvas. */
  color?: string;
  /** Lucide-react icon name OR an emoji (operator's choice). */
  icon?: string;
  /** Optional node-shape override (renderer default is 'circle'). */
  shape?: 'circle' | 'square' | 'diamond';
}

/**
 * Load the display-hints overlay for the given system.
 *
 * Reads `${ontologyDir}/${system}.display.json` when it exists, JSON-parses
 * it, and returns the resulting Record<className, DisplayHint>. Missing file
 * returns {} silently. Malformed JSON returns {} with a stderr warning.
 *
 * @param ontologyDir Directory containing per-system overlay files. MUST be
 *   non-empty (CLAUDE.md ontologyDir-invariant — Phase 41 lesson). Empty
 *   string throws.
 * @param system The system / domain name (e.g. 'coding', 'okb', 'cap').
 *   Combined with the suffix `.display.json` to form the lookup path.
 */
export function loadDisplayOverlay(
  ontologyDir: string,
  system: string,
): Record<string, DisplayHint> {
  if (!ontologyDir || ontologyDir.length === 0) {
    // T-45-04-06 mitigation — same invariant the registry honors (registry.ts:53).
    throw new Error(
      '[km-core/display-overlay] ontologyDir is required (must be a non-empty string)',
    );
  }
  if (!system || system.length === 0) {
    // Defensive — empty system would resolve to '.display.json' (hidden file).
    throw new Error(
      '[km-core/display-overlay] system is required (must be a non-empty string)',
    );
  }

  const filePath = join(ontologyDir, `${system}.display.json`);
  if (!existsSync(filePath)) {
    // Missing file is the documented "no preferences authored yet" path —
    // RESEARCH spec §Open Question #4: NOT an error.
    return {};
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[km-core/display-overlay] failed to read '${filePath}': ${msg}\n`,
    );
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      process.stderr.write(
        `[km-core/display-overlay] '${filePath}' top-level value is not an object — ignoring\n`,
      );
      return {};
    }
    // Trust the operator-authored content; downstream consumers only read
    // color/icon/shape and treat any extras as opaque.
    return parsed as Record<string, DisplayHint>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[km-core/display-overlay] malformed JSON in '${filePath}': ${msg} — returning empty overlay\n`,
    );
    return {};
  }
}
