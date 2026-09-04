// No tracked file may hardcode a real user's home directory.
//
// WHY THIS LIVES HERE AND NOT IN THE PARENT REPO
// ----------------------------------------------
// km-core is consumed as a git submodule of the `coding` repo, which has its own
// version of this guard (tests/integration/repo-path-portability.test.js). That one
// CANNOT cover this repository: `git grep` and `git ls-files` do not descend into a
// submodule, so km-core stayed invisible through four separate sweeps of the parent
// tree, and the parent guard explicitly skips `lib/km-core/` because a commit there
// cannot fix a different repository. Without this file, the path can come back here
// and nothing anywhere will notice.
//
// WHAT IT CAUGHT
// --------------
// Nine occurrences across five files, of which one was live code:
// `tests/integration/symlink-bc.sh` reads the PARENT repo's pre-commit hook to extract
// its KB_PATTERN — deliberately, so the test tracks the real hook — but named that hook
// by absolute path, so the test could only pass on one machine.
//
// A grep test rather than a behavioural one, deliberately: the failure mode is a literal
// string, it spreads by copying a neighbouring file, and on the machine that wrote it
// everything works, so nothing else can observe it.

import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** An absolute path into somebody's home directory. */
const HOME_PATH = /\/(Users|home)\/([A-Za-z0-9._-]+)\//;

/**
 * Names that are documentation rather than a machine.
 *
 * Comments and fixtures legitimately need to show the SHAPE of these paths — the
 * b-coding snapshot carries `absolutePath` fields that have to look like real paths,
 * and provenance comments cannot cite an outer-repo file without one. So the guard
 * separates "an example" from "a real account": placeholder names pass, every other
 * name fails.
 */
const PLACEHOLDERS = new Set([
  'you', 'me', 'x', 'dev', 'user', 'username', 'someone', 'staff-id',
]);

function offendingLines(file: string): string[] {
  let body: string;
  try {
    body = fs.readFileSync(file, 'utf-8');
  } catch {
    return [];   // unreadable or vanished — not this test's problem
  }
  return body.split('\n')
    .map((line, i): [number, string] => [i + 1, line])
    .filter(([, line]) => {
      const m = HOME_PATH.exec(line);
      if (!m) return false;
      if (PLACEHOLDERS.has(m[2])) return false;
      // `<staff-id>`, `/Users/.../coding` — explicitly elided, not a real account.
      if (/\/(Users|home)\/(<|\.\.\.)/.test(line)) return false;
      return true;
    })
    .map(([n, line]) => `${path.relative(REPO, file)}:${n}: ${line.trim()}`);
}

/** Tracked files only — keeps dist/, node_modules and scratch output out for free. */
function trackedFiles(): string[] {
  const r = spawnSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf-8' });
  return r.stdout.split('\n')
    .filter(Boolean)
    .map((f) => path.join(REPO, f))
    .filter((f) => fs.existsSync(f) && fs.statSync(f).isFile());
}

describe('no tracked file hardcodes a real home directory', () => {
  test('the whole repository is clean', () => {
    const hits = trackedFiles().flatMap(offendingLines);
    // Joined into one string so a failure prints file, line number and the line itself.
    // "somewhere in the repo" would not be actionable across 140+ files.
    expect(hits.join('\n')).toBe('');
  });

  test('the guard fires — it is not vacuously passing', () => {
    // A grep test that matches nothing is indistinguishable from a broken one.
    //
    // The offending path is ASSEMBLED rather than written out, so this file contains no
    // literal that would trip its own check. That is what lets the scan above cover
    // every tracked file including this one, instead of carrying a self-exemption that
    // would then be the one place the path could hide.
    const bad = ['', 'Users', 'somebody', 'Agentic', 'coding'].join('/');
    const tmp = path.join(REPO, 'node_modules', `.portable-paths-probe-${process.pid}.txt`);
    fs.writeFileSync(tmp, `const R = process.env.CODING_REPO || '${bad}';\n`);
    try {
      expect(offendingLines(tmp)).toHaveLength(1);
      expect(offendingLines(tmp)[0]).toContain('somebody');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  test('documentation placeholders are allowed', () => {
    const tmp = path.join(REPO, 'node_modules', `.portable-paths-doc-${process.pid}.txt`);
    fs.writeFileSync(tmp, [
      '// SOURCE: <coding-repo>/scripts/dedup-insights-by-embedding.js',
      '// `..\\..` lands at /Users/.../coding; the explicit walk-up tolerates any depth',
      '"absolutePath": "/Users/dev/Agentic/coding/knowledge-management/insights/x.md"',
      '// paths like /Users/<staff-id>/… leak the operator id',
    ].join('\n'));
    try {
      expect(offendingLines(tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });
});

describe('the one test that reaches into the parent repo derives its path', () => {
  // Absence of the literal is not the same as resolving correctly. symlink-bc.sh reads
  // <coding>/scripts/hooks/pre-commit-okb-guard.sh, so it has to locate a repository it
  // is nested inside — and the tempting rewrite (a relative path from the CWD) breaks the
  // moment the test is run from anywhere but its own directory.
  const script = path.join(REPO, 'tests', 'integration', 'symlink-bc.sh');
  const body = () => fs.readFileSync(script, 'utf-8');

  test('CODING_REPO wins when set', () => {
    // The only thing that works if km-core is checked out somewhere other than inside
    // the parent repo, and it is set in every wrapper-launched session.
    expect(body()).toMatch(/\$\{CODING_REPO:-/);
  });

  test('otherwise it walks up from its own location, not from the CWD', () => {
    expect(body()).toMatch(/dirname "\$\{BASH_SOURCE\[0\]\}"/);
    // tests/integration → tests → km-core → lib → the outer repo root.
    expect(body()).toContain('/../../../..');
  });

  test('the derived root is in fact four levels up', () => {
    const derived = path.resolve(path.dirname(script), '..', '..', '..', '..');
    expect(derived).toBe(path.resolve(REPO, '..', '..'));
  });
});
