# Repository Guidelines

> **Read [CLAUDE.md](CLAUDE.md) first.** It is the project operating manual and supersedes
> anything inferred from this file.

This is a **Document-Driven Development** research repository. Every non-trivial change must
be reflected in `docs/progress-log.md` (and, when an experiment produced the result,
`docs/EXPERIMENTS.md`) as part of the same commit. The pre-commit hook enforces this.

## Project structure

- `frontend/src/lib/parsers/` — `.icm` (ICC profile + embedded ZXML CxF3) and `.cxf` parsers.
- `frontend/src/lib/analyzers/` — ink limits, linearity, CYNSN, spectral predictor, ink-ratio.
- `frontend/src/lib/{colormath,cgatsExport,dataLoader,iccTagScanner}.ts` — shared utilities.
- `frontend/src/store/` — Zustand store (`useProfileStore`).
- `frontend/src/components/` — UI; `ComparisonView` is the hub.
- `frontend/src/types/index.ts` — single source of truth for data types.
- `docs/` — see [README.md](README.md#documentation-map) for the full map.
- `.githooks/` — pre-commit hook enforcing the DDD loop. Installed via `npm install`.

## Build, test, development commands

Run from `frontend/`:

| Command | Purpose |
|---|---|
| `npm install` | Install deps + auto-install git hooks via `postinstall`. |
| `npm run dev` | Start Vite dev server. Runs `vitest run` first via `predev`. |
| `npm run build` | Production build. |
| `npm run lint` | ESLint (TypeScript strict). |
| `npm test` | One-shot Vitest run. |
| `npx vitest <path>` | Single test file. |

Local Node must be ≥ 18. CI uses Node 20.

## Coding style

- TypeScript strict mode. No `any` without `// reason: …`.
- Functional React with hooks; Zustand for shared state.
- Pure functions in `lib/`; side effects only in components and `dataLoader.ts`.
- `camelCase.ts` modules, `PascalCase.tsx` components.
- Prettier + ESLint (config in `frontend/`). Run `npx prettier . --write` before commit.
- Comments explain **why**, never **what**. Reserve them for invariants, formula references,
  and non-obvious limits.

## Testing

- Vitest + jsdom. Test files co-located with sources (`*.test.ts`).
- Required for every new function in `lib/analyzers/` and `lib/colormath.ts`.
- Use ISO 11664-6 reference pairs for ΔE / Lab tests; hand-computed numerics elsewhere.
- Do not mock the spectral pipeline — feed real spectra fixtures.

## Commits & pull requests

- Conventional Commits, imperative, ≤ 70 chars subject (`feat(cynsn): …`, `fix(parser): …`).
- Body explains **why** when not obvious. Reference an `EXPERIMENTS.md` entry by date if the
  commit implements an experimental finding.
- The pre-commit hook blocks `feat:` / `fix:` whose diff touches `frontend/src/lib/` or
  `frontend/src/components/` without a matching change in `docs/progress-log.md`. Use
  `--no-verify` only for truly trivial changes (typos, comments, dead-code removal) — and
  then log it in the next commit.
- Do not skip pre-commit hooks (`--no-verify`) routinely. Do not skip GPG signing.

## What "done" means

A change is done when **all** of the following hold:

1. Code compiles with `npm run build`.
2. `npm test` passes (verify on CI if Node ≥ 18 is unavailable locally).
3. `docs/progress-log.md` has a new entry describing what changed and why.
4. If the change introduced a new metric or model behaviour on real data:
   `docs/EXPERIMENTS.md` has an append-only row with date, profiles, metric value,
   conclusion, next step.
5. If the change altered the conceptual model, scope, or hypothesis:
   `docs/ONTOLOGY.md`, `docs/RESEARCH_HYPOTHESIS.md`, or `docs/ROADMAP.md` reflects it.
6. `TODO.md` no longer lists the item (or links to the experiment that resolved it).
