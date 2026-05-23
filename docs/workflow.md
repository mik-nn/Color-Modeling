# workflow.md — The DDD loop, expanded

> Companion to [`/CLAUDE.md`](../CLAUDE.md) §1. Same loop, more detail per step.

```text
Idea → Hypothesis → Spec → Code → Test → Run → Experiment log → Progress log → Commit
```

---

## 1. Data ingestion

- Drop `.icm` files into the local sample directory (do **not** commit data).
- Drag-drop into the dev UI to load through `lib/dataLoader.ts`.
- New file format? Add a parser under `lib/parsers/` and wire dispatch in `dataLoader`.

## 2. Parse & extract

- Filename → `ProfileMetadata` (`utils/filenameParser.ts`).
- ICC → ZXML CxF (`lib/iccTagScanner.ts` + `lib/parsers/icmParser.ts`).
- CxF XML → `Measurement[]` (`lib/parsers/cxfParser.ts`).
- Result wrapped in `ProfileData` with raw / clean / has_spectral / patch_count.

## 3. Data preparation

- Today: `clean === raw` placeholder.
- Planned: MAD outlier detection → Savitzky-Golay smoothing → interpolation /
  alignment across profiles.
- Any cleaning function must update `Measurement.deltaE00` between raw and clean.

## 4. Analysis

- Cross-profile pairwise: `MatchedPatchPair[]` from `Row:Col:Page` join.
- Ink limits gate everything downstream (`InkLimitSection`).
- Linearity (legacy), group breakdown, ink-ratio, spectral predictor, CYNSN.

## 5. Visualisation

- Hub: `ComparisonView`. Cards + plots + tables. D3 for scatter / curves.
- Add a new analyser → add a new card / table to `ComparisonView`.

## 6. Documentation (this is where DDD lives)

Every analysis run that produced a meaningful number must:

1. **Append a row to `docs/EXPERIMENTS.md`** with date, profiles, key metric, conclusion,
   next step.
2. **Append a paragraph to `docs/progress-log.md`** describing what was done in this
   session and why.
3. If the result changes the architecture or scope: update `docs/ONTOLOGY.md`,
   `docs/IMPLEMENTATION.md`, or `docs/ROADMAP.md` as appropriate.
4. If the result tests a hypothesis: cross-reference the relevant `H1.x` from
   `docs/RESEARCH_HYPOTHESIS.md`.

## 7. Commit

- Conventional Commits (`feat:` / `fix:` / `refactor:` / `docs:` / `chore:`).
- Pre-commit hook (`.githooks/pre-commit`) blocks `feat:` / `fix:` whose diff touches
  `frontend/src/lib/` or `frontend/src/components/` without a matching change in
  `docs/progress-log.md`.
- Body explains **why**, not what. Reference an `EXPERIMENTS.md` row by date.

---

## After every significant analysis run

A non-trivial run includes: a new CYNSN fit on a profile pair, a parameter sweep, a
hypothesis test, a fix that changes any observed metric. After such a run:

1. Save key plots locally (the dev UI does not persist them yet — screenshot or copy
   from devtools).
2. Append the experiment row.
3. Append the progress log paragraph.
4. Commit.

If the result invalidates an earlier conclusion, **add a new row** noting the previous
result and the new one — never edit history.
