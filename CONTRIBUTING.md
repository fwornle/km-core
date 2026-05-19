# Contributing to @fwornle/km-core

## Dev Setup

```bash
git clone git@github.com:fwornle/km-core.git
cd km-core
npm install
npm run build
npm test
```

Requires Node `>= 22`. ESM-only.

## Submodule Consumers

KM-Core is consumed via git submodule by:

- `coding/lib/km-core/` (Wave 5 of Phase 37 wires this up)
- `rapid-automations/.../km-core/` (post-Phase 43)

After publishing changes here, each consumer must:

```bash
cd consumer-repo
git submodule update --remote lib/km-core
cd lib/km-core
npm install
npm run build
git add lib/km-core
git commit -m "chore: bump km-core submodule"
```

The compiled `dist/` is bind-mounted into Docker containers; consumers do not run `tsc` inside their own service containers.

## Code Style Constraints

- **No `console.*` calls in source.** Use `process.stderr.write('[km-core] ...\n')` or accept a logger via constructor. This mirrors the `no-console-log` constraint in consumer projects (`coding/CLAUDE.md`).
- **Strict TypeScript.** `tsconfig.json` enables `strict: true`. Do not weaken.
- **ESM-only.** All imports use `.js` extensions (NodeNext resolution).
- **Atomic file writes.** Any write to `.data/exports/` goes through temp-file + rename — never naive `writeFile`.

## Tests

- Unit tests live under `tests/unit/`.
- Integration tests live under `tests/integration/`.
- Frozen reference snapshots live under `tests/fixtures/` — do NOT regenerate without intent.
- Run a single file: `npm test -- tests/unit/<file>.test.ts`.

## Pull Requests

- Open PRs against `main`.
- CI must be green (`npm run build` + `npm test` on Node 22.x).
- Bump `version` in `package.json` for any change that alters the public API surface.

## License

MIT — by contributing, you agree your contributions are licensed under MIT.
