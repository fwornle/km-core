// Phase 44 Plan 04: Git-tag-backed snapshot/restore for KM graph exports.
//
// This module is the second cornerstone deliverable for km-core (after the
// REST contracts in Plan 03). It owns the mechanics for CONTEXT decisions:
//
//   S-1  Whole-directory atomic snapshot — every snapshot is one git commit
//        over the entire `.data/exports/` directory.
//   S-2  Hard reset on restore — restore checks out the tagged commit into the
//        export dir. This function does NOT call process.exit and does NOT
//        attempt in-process LevelDB re-hydration; the HTTP handler in Plan 06
//        wraps the response with `restartRequired: true` and the operator (or
//        a watchdog) issues the restart. See CONTEXT §S-2 revised and
//        RESEARCH §Pitfall 4 for the rationale.
//   S-4  Git tags as snapshot IDs — `snapshot/<label>-<UTC-ts>` is the wire
//        format and the storage key. Discovery is `git tag -l 'snapshot/*'`
//        sorted by creatordate. No parallel metadata index.
//
// Pitfall 1 (RESEARCH §Common Pitfalls): pre-commit hooks cannot inspect the
// pending commit message, so the OKB-baseline guard bypass mechanism is the
// `OKB_SNAPSHOT=1` env-var. Every git invocation issued by this manager sets
// that env-var (see execGit) — and the matching coding-side hook short-circuits
// on it (Plan 44-04 Task 2). The two halves of the bypass MUST stay in sync.
//
// No-console-log (CLAUDE.md): diagnostic output goes through process.stderr
// only on error paths, never on the happy path. Successful git invocations
// run under `stdio: 'pipe'` so git's chatter ("Switched to ...", etc.) does
// not leak into consumer logs.

import { execSync } from 'node:child_process';
import { existsSync, statSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface SnapshotEntry {
  /** Canonical S-4 ID: `snapshot/<label>-<UTC-ts-with-colons-replaced>`. */
  id: string;
  /** The original label passed to createSnapshot, e.g. "manual" or "pre-restore". */
  label: string;
  /** ISO-like timestamp embedded in the ID (colons replaced with `-`). */
  timestamp: string;
  /** Commit hash of the snapshot's underlying commit. */
  commit_sha: string;
  /** Commit subject: `chore(snapshot): <label>`. */
  message: string;
  /** Domain filenames present at the snapshot (without `.json`). */
  domains_present: string[];
}

export interface SnapshotManagerOptions {
  /** Absolute path to the exports directory tracked under git. */
  exportDir: string;
}

interface GitEnv {
  gitDir: string;
  workTree: string;
  exportsRel: string;
}

/**
 * Path-traversal-safe snapshot id regex (T-44-04-01 mitigation).
 *
 * Mirrors the canonical ID format produced by createSnapshot:
 *   `snapshot/<label-without-shell-chars>-<UTC-ISO-with-colons-and-dots-as-dashes>`
 *
 * Allowed character set in the trailing timestamp segment covers the output of
 * `new Date().toISOString().replace(/[:.]/g, '-')` (digits, `T`, `Z`, `-`).
 */
const SNAPSHOT_ID_REGEX = /^snapshot\/[a-zA-Z0-9._-]+-\d{4}-\d{2}-\d{2}T[\dTZ.\-]+$/;

/**
 * Label injection regex (T-44-04-02 mitigation). Restricted to a safe shell
 * character set; combined with `JSON.stringify` quoting on the commit message,
 * this gives defense-in-depth against command-injection via label.
 */
const LABEL_REGEX = /^[a-zA-Z0-9._-]+$/;

export class SnapshotManager {
  constructor(private readonly opts: SnapshotManagerOptions) {}

  /**
   * Walks up from `exportDir` to find the enclosing `.git` directory (plain
   * directory OR a gitlink file, the latter being the submodule case used by
   * the coding repo for lib/km-core).
   *
   * Pattern lifted verbatim from RESEARCH §Pattern 4 lines 368-397; the
   * equivalent OKM logic at `_work/.../okm/src/api/routes.ts:2081-2117`
   * uses the same shape.
   */
  private getGitEnv(): GitEnv {
    let dir = path.resolve(this.opts.exportDir, '..');
    for (let i = 0; i < 10; i++) {
      const dotGit = path.join(dir, '.git');
      if (existsSync(dotGit)) {
        const stat = statSync(dotGit);
        let gitDir: string;
        if (stat.isDirectory()) {
          gitDir = dotGit;
        } else {
          // gitlink file: contents are `gitdir: <relative-or-absolute-path>`.
          const content = readFileSync(dotGit, 'utf-8').trim();
          const match = content.match(/^gitdir:\s*(.+)$/);
          if (!match) {
            throw new Error(`Malformed .git file at ${dotGit}`);
          }
          gitDir = path.resolve(dir, match[1]);
        }
        return {
          gitDir,
          workTree: dir,
          exportsRel: path.relative(dir, this.opts.exportDir),
        };
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`No .git found walking up from ${this.opts.exportDir}`);
  }

  /**
   * Shells out to git with explicit GIT_DIR/GIT_WORK_TREE and the mandatory
   * OKB_SNAPSHOT=1 bypass env-var (Pitfall 1). Every git invocation issued by
   * this class flows through here; if any caller bypasses this wrapper they
   * will hit the OKB-baseline guard.
   */
  private execGit(args: string, env: GitEnv): string {
    return execSync(`git ${args}`, {
      encoding: 'utf-8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_DIR: env.gitDir,
        GIT_WORK_TREE: env.workTree,
        // Pitfall 1: pre-commit hooks fire BEFORE commit message exists.
        // The OKB-baseline guard short-circuits on this env-var.
        OKB_SNAPSHOT: '1',
      },
    }).trim();
  }

  /**
   * S-1 + S-4: stage everything under `<exportsRel>/`, commit as
   * `chore(snapshot): <label>`, tag `snapshot/<label>-<UTC-ts>`.
   *
   * Label is validated against LABEL_REGEX (T-44-04-02). The commit message
   * is JSON.stringify-quoted for defense-in-depth even though the regex
   * already rejects shell metacharacters.
   *
   * Caller is responsible for flushing pending debounced exports first
   * (typical pattern: `await store.exportJson()` before calling this).
   */
  async createSnapshot(label: string): Promise<SnapshotEntry> {
    if (!LABEL_REGEX.test(label)) {
      throw new Error(
        `Invalid label: must match ${LABEL_REGEX.source} (got ${JSON.stringify(label)})`,
      );
    }
    const env = this.getGitEnv();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const tagName = `snapshot/${label}-${ts}`;
    const commitMsg = `chore(snapshot): ${label}`;

    // Stage the entire exports dir (S-1 whole-dir atomic).
    this.execGit(`add -A -- ${JSON.stringify(env.exportsRel + '/')}`, env);
    // `--allow-empty` so two back-to-back snapshots with no changes still
    // produce a distinct commit (each snapshot ID must be unique).
    this.execGit(
      `commit -m ${JSON.stringify(commitMsg)} --allow-empty`,
      env,
    );
    this.execGit(`tag ${JSON.stringify(tagName)}`, env);

    const commitSha = this.execGit('rev-parse HEAD', env);
    const domains = this.computeDomainsPresent('HEAD', env);

    return {
      id: tagName,
      label,
      timestamp: ts,
      commit_sha: commitSha,
      message: commitMsg,
      domains_present: domains,
    };
  }

  /**
   * S-4: enumerate `snapshot/*` tags sorted by creatordate (newest first),
   * then fetch per-tag metadata via `git log` + `ls-tree`.
   */
  async listSnapshots(): Promise<SnapshotEntry[]> {
    const env = this.getGitEnv();
    const tagsOut = this.execGit(`tag -l 'snapshot/*' --sort=-creatordate`, env);
    if (!tagsOut) return [];

    return tagsOut.split('\n').map((tag) => {
      const commitSha = this.execGit(
        `rev-list -n 1 ${JSON.stringify(tag)}`,
        env,
      );
      const msg = this.execGit(
        `log -1 --format=%s ${JSON.stringify(tag)}`,
        env,
      );
      // Parse `snapshot/<label>-<UTC-ts>` back into its parts. The label
      // itself may contain `-`, so we anchor on the date prefix `YYYY-MM-DD`
      // that follows the final label segment.
      const m = tag.match(/^snapshot\/(.+?)-(\d{4}-\d{2}-\d{2}T.+)$/);
      const label = m?.[1] ?? tag;
      const timestamp = m?.[2] ?? '';
      const domains = this.computeDomainsPresent(tag, env);

      return {
        id: tag,
        label,
        timestamp,
        commit_sha: commitSha,
        message: msg,
        domains_present: domains,
      };
    });
  }

  /**
   * S-2: hard reset on the exports dir only. Returns control to the caller;
   * does NOT wipe LevelDB, does NOT restart, does NOT call process.exit.
   *
   * Per CONTEXT S-2 (revised) and RESEARCH §Pitfall 4: the destructive parts
   * (LevelDB wipe, process restart) are the responsibility of the HTTP handler
   * in Plan 06, which wraps this response with `restartRequired: true`.
   *
   * T-44-04-01: snapshot id format validated before passing to git.
   * T-44-04-03: caller must pass `{ confirmDestructive: true }` — the manager
   * level gate prevents accidental invocation from scripts. (The HTTP handler
   * in Plan 06 enforces the same check on the POST body for the same reason.)
   */
  async restoreSnapshot(
    snapshotId: string,
    opts: { confirmDestructive: boolean },
  ): Promise<{ restored: true; id: string; commit_sha: string }> {
    if (!opts || opts.confirmDestructive !== true) {
      throw new Error(
        'restoreSnapshot requires confirmDestructive:true ' +
          '(restore is destructive — overwrites the exports directory).',
      );
    }
    if (!SNAPSHOT_ID_REGEX.test(snapshotId)) {
      throw new Error(
        `Invalid snapshot id format: ${JSON.stringify(snapshotId)} ` +
          `(expected ${SNAPSHOT_ID_REGEX.source})`,
      );
    }
    const env = this.getGitEnv();
    const commitSha = this.execGit(
      `rev-list -n 1 ${JSON.stringify(snapshotId)}`,
      env,
    );
    // Scoped checkout — exportsRel only. Pattern matches OKM (routes.ts:2120)
    // which uses the same scoped form to avoid blowing away unrelated files.
    this.execGit(
      `checkout ${JSON.stringify(snapshotId)} -- ${JSON.stringify(env.exportsRel + '/')}`,
      env,
    );
    return { restored: true, id: snapshotId, commit_sha: commitSha };
  }

  /**
   * Helper: list top-level files in the exports dir at a given ref and return
   * their basenames (without `.json`). Errors on malformed refs are surfaced
   * via execSync's thrown SyntheticError; callers above propagate them.
   */
  private computeDomainsPresent(ref: string, env: GitEnv): string[] {
    let lsTree: string;
    try {
      lsTree = this.execGit(
        `ls-tree --name-only ${JSON.stringify(ref)} -- ${JSON.stringify(env.exportsRel + '/')}`,
        env,
      );
    } catch (err) {
      // Empty trees / freshly-tagged-but-empty-exports paths are valid;
      // emit a one-line diagnostic and return [].
      process.stderr.write(
        `[SnapshotManager] ls-tree at ${ref} returned non-zero; treating as empty. ` +
          `(${(err as Error).message})\n`,
      );
      return [];
    }
    if (!lsTree) return [];
    return lsTree
      .split('\n')
      .map((p) => path.basename(p, '.json'))
      .filter((d) => d && !d.startsWith('.'));
  }
}
