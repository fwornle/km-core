// Phase 45 Plan 04: per-class display-hints overlay loader.
// Phase 55 Plan 02: extended with borderStyle + pulseRule (UI-SPEC §14).
//
// SOURCE:
//   - 45-RESEARCH.md §Open Question #4 Example 4 — overlay file format +
//     fs.existsSync gate + JSON.parse with stderr-warn on malformed.
//   - 45-CONTEXT.md §D-45-03 — display block lives alongside each
//     ontology JSON as `.data/ontologies/{system}.display.json`.
//   - 45-UI-SPEC.md §Color "Ontology-driven node color contract" — the
//     consumer of `display.color` is SigmaCanvas (graph node fill).
//   - 55-UI-SPEC.md §14 — adds `borderStyle: 'solid'|'dashed'` and
//     `pulseRule: null | 'lastUpdatedWithin:60s' | 'lastUpdatedWithin:5m' |
//     'recentlyMerged:1h'`. Both optional — fallback rules in renderer.
//   - 55-02-PLAN.md Task 1 — Zod validation gates the two new fields.
//
// Contract:
//   - `ontologyDir` is REQUIRED (non-empty string). Throws on empty per
//     CLAUDE.md ontologyDir-invariant (Phase 41 lesson; T-45-04-06).
//   - Missing file is NOT an error — returns {} (operator may have not
//     authored a display.json for this system yet).
//   - Malformed JSON triggers a one-line stderr warning and returns {} —
//     graph render falls back to FNV-1a deterministic hue (45-UI-SPEC).
//   - Phase 55: when overlay entries include `borderStyle`/`pulseRule`, the
//     loader does NOT validate per-entry — that is `parseDisplayHint`'s job
//     (Zod-gated). The loader keeps its trust-the-operator stance so a
//     malformed entry warns once via parseDisplayHint at the call site rather
//     than 500-ing the whole route.
//
// no-console-log: stderr only. JSDoc prose, no fenced code blocks (matches
// km-core repo discipline per registry.ts:27).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Zod schema gating a single class's display block.
 *
 * Phase 55 adds two optional fields:
 *   - `borderStyle: 'solid'|'dashed'` (T-55-02-01 — enum rejects unknown).
 *   - `pulseRule: null | union-of-three-literals` (matches UI-SPEC §12+§14).
 *
 * Phase 45 fields stay optional and unchanged. The schema uses `.optional()`
 * everywhere so existing overlays without `borderStyle`/`pulseRule` continue
 * to parse — undefined stays undefined; we do NOT inject defaults (renderer
 * applies fallback rules per UI-SPEC §14).
 */
export const DisplayHintSchema = z.object({
  color: z.string().optional(),
  icon: z.string().optional(),
  shape: z.enum(['circle', 'diamond', 'square', 'triangle', 'hexagon']).optional(),
  borderStyle: z.enum(['solid', 'dashed']).optional(),
  pulseRule: z
    .union([
      z.null(),
      z.literal('lastUpdatedWithin:60s'),
      z.literal('lastUpdatedWithin:5m'),
      z.literal('recentlyMerged:1h'),
    ])
    .optional(),
});

/**
 * Per-class visual hint surfaced via /api/v1/ontology/classes?withDisplay=true.
 *
 * All fields are optional — the viewer falls back to deterministic FNV-1a
 * hue + 'circle' shape + no-icon + solid border + no pulse (UI-SPEC §14).
 */
export interface DisplayHint {
  /** Hex color string (#rrggbb) used as the node fill on the graph canvas. */
  color?: string;
  /** Lucide-react icon name OR an emoji (operator's choice). */
  icon?: string;
  /** Optional node-shape override (renderer default is 'circle'). */
  shape?: 'circle' | 'diamond' | 'square' | 'triangle' | 'hexagon';
  /**
   * Phase 55: optional border style. 'dashed' marks orphan / low-confidence
   * nodes. Falls back to 'solid' when undefined. (55-UI-SPEC §14.)
   */
  borderStyle?: 'solid' | 'dashed';
  /**
   * Phase 55: optional pulse expression evaluated per entity in the renderer.
   * `null` and `undefined` both mean "no pulse"; the three literals encode
   * UI-SPEC §12 LIVE-indicator rules. Falls back to null when undefined.
   */
  pulseRule?:
    | null
    | 'lastUpdatedWithin:60s'
    | 'lastUpdatedWithin:5m'
    | 'recentlyMerged:1h';
}

/**
 * Validate + parse a single display-hint object via {@link DisplayHintSchema}.
 *
 * Throws on unknown `borderStyle` / `pulseRule` literals so the operator gets
 * a loud error at boot rather than a silent fallback. Unknown extra fields are
 * stripped (Zod's default object behavior) — extras like `color2` are dropped
 * silently to keep wire-shape clean.
 *
 * @param input Untrusted overlay-entry object (typically from operator-authored
 *   `.data/ontologies/{system}.display.json`).
 * @returns Parsed {@link DisplayHint} (same shape, validated).
 * @throws ZodError when `borderStyle` or `pulseRule` violates the enum.
 */
export function parseDisplayHint(input: unknown): DisplayHint {
  return DisplayHintSchema.parse(input) as DisplayHint;
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
