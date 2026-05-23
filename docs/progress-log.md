# progress-log.md

> Append-only per-session changelog. Newest entries at the top. Bilingual EN/RU acceptable.
> Each entry: date, one-line summary, body explaining **why**, links to relevant
> `EXPERIMENTS.md` rows and commits.

---

## 2026-05-23 — DDD enforcement: pre-commit hook

Wire the DDD loop into git. Without a hook, future commits will drift back to "I'll
document it later" — the project's prior state, which produced the audit findings in the
previous entry.

- **`.githooks/pre-commit` (new)** — fails when `git diff --cached` touches
  `frontend/src/lib/` or `frontend/src/components/` without a matching change to
  `docs/progress-log.md`. Bypass with `--no-verify` only for trivial fixes (typos,
  comments, dead code) — and then log it in the following commit.
- **`frontend/scripts/install-hooks.sh` (new)** — idempotent `chmod +x .githooks/* &&
  git config core.hooksPath .githooks`. Safe to re-run; skips silently outside a git
  work tree (e.g. tarball install).
- **`frontend/package.json`** — `postinstall` script runs the installer so every
  `npm install` keeps the hook active. Guarded with `|| true` so a missing repo does
  not fail the install.

Rationale for raw `.githooks/` vs husky: zero new dependencies, one shell file in the
repo, identical onboarding (`npm install`). Husky's added value (auto-wiring of
`core.hooksPath` from `node_modules`) is exactly what `install-hooks.sh` does in a
fraction of the lines.

Verification: `git config core.hooksPath` returns `.githooks` after `npm install`.
Commit 2 of today's session (this commit) passed the gate because it updates
`progress-log.md`.

---

## 2026-05-23 — Documentation revision (DDD foundation)

Project-wide doc audit and reset. Reasons: documentation had drifted significantly from
the code (CMYK language in `README.md` / `IMPLEMENTATION.md` / `RESEARCH_HYPOTHESIS.md`
while the dataset is RGB-only; `progress-log.md` stopped at 2026-05-21 even though four
substantive commits landed after; `EXPERIMENTS.md` was a template with a single ad-hoc
row; `TODO.md` referenced Node v12 blockage that no longer applies). Several aliased AI
scaffolding folders (`.specify/`, `.kilo/`, `.lingma/`) were dead weight.

Changes in this commit:

- **`CLAUDE.md` (new)** — operating manual: DDD loop, hard rules, file map,
  architecture map, environment caveats, anti-patterns.
- **`docs/ONTOLOGY.md` (new)** — entity model + mermaid diagram, glossary, conventions
  (D50/2°, ΔE00, wavelength grid, device-vs-colorimetric RGB distinction). Establishes
  **spectra as primary measurement, Lab as derived/informational** — all hypothesis tests
  must rest on spectral or XYZ-linear quantities.
- **`docs/SATA_DICTIONARY.md` → `docs/DATA_DICTIONARY.md`** — typo fix + content rewrite
  emphasising spectral primacy.
- **All docs translated to English** and updated to reflect current code state (RGB only,
  CYNSN Phase 2, CYNSN-2 known bugs, DeviceSpace migration target).
- **`docs/AGENTS.md` rewritten** for concrete Claude Code subagents and skills,
  replacing the abstract 6-roles version.
- **`docs/EXPERIMENTS.md` backfilled** with the four experiments embedded in commits
  since 2026-05-21 (ink-limit Yule-Nielsen bug, primary-extraction collapse, CYNSN-2
  measured-grid override, colormath exponentiation fix).
- **`docs/progress-log.md` backfilled** with entries for all twelve commits since
  `a5a03c7`.
- **`docs/ROADMAP.md`** restructured into phases with measurable acceptance criteria and
  a cross-cutting epics section.
- **`docs/RESEARCH_HYPOTHESIS.md`** rewritten as pre-registered, falsifiable H1 with
  sub-hypotheses, acceptance criteria, falsification criteria, dataset slice. Added H2
  (DeviceSpace invariance) as the engineering gate for future CMYK datasets.
- **`docs/structure.md`** updated to reflect the actual tree (added `.githooks/`,
  `scripts/`, `ONTOLOGY.md`, removed stale `hooks/` reference).
- **`docs/workflow.md`** expanded into the full DDD loop with the after-run checklist.
- **`docs/SKILLS.md`** deduplicated (the file had a doubled "CxF specifications" block).
- **`docs/PROMPTS.md`** replaced CMYK-era prompts with CYNSN baseline / cross-substrate /
  diagnostic / VAE templates that match current code.
- **`docs/Tech.md`** version-aligned with `frontend/package.json`; removed `math.js` /
  `simple-statistics` claims (not in deps).
- **`README.md`** rewritten to reflect ZXML/CxF reality (was claiming A2B-table parsing).
- **`AGENTS.md`** (root) updated with the DDD gate clause and the "what done means" list.
- **`TODO.md`** restructured into P0 (CYNSN bugs) / P1 (DeviceSpace epic, cleaning
  pipeline) / P2 (engineering) / P3 (transfer model, docs). Removed stale Node v12 item.
- **`.specify/`, `.kilo/`, `.lingma/` deleted** — unused AI scaffolding leftovers from
  Spec-Kit / Kilo Code / Lingma. None referenced by the project.

No code touched in this commit. Hook wiring and DeviceSpace refactor follow in separate
commits.

---

## 2026-05-21 — `fix(cynsn): primary extraction collapse + CYNSN-2 measured grid` (f8cb1e8)

Two bugs fixed in CYNSN:

1. **Primary-extraction collapse.** `extractNeugebauerPrimaries3` was collapsing onto a
   single vertex when the KNN tolerance was too tight. Loosened tolerance handling and
   added IDW fallback so all 8 corners always receive a spectrum.
2. **CYNSN-2 measured-grid override.** Added the post-training swap that replaces grid
   nodes near measured patches (tol 0.08) with the measured spectra. **Caveat:** the
   training loop still ignores `grid_cynsn2` during loss evaluation — `spreading` ends
   up tuned for the wrong grid. Documented as Bug 2 in `docs/cynsn-pipeline.md`. Fix
   queued in `TODO.md`.

## 2026-05-21 — `fix: colormath exponentiation parse error; add tests + CI` (a2ea011)

`xyzToLab` body contained `-x/25**2` which parses as `-(x / (25**2))` not `-((x/25)**2)`
under standard precedence. Resulted in incorrect L\* in a narrow range. Fixed to
`-(((x/25)**2))`. Added `lib/colormath.test.ts` with ISO 11664-6 reference pairs for
`xyzToLab` and `deltaE00`. Wired GitHub Actions CI (`.github/workflows/ci.yml`, Node 20)
to run `npm test` followed by `npm run build`.

## 2026-05-21 — `feat: port CYNSN 3D CMY model to TypeScript with Nelder-Mead optimizer` (87cae9a)

Initial CYNSN port. New files: `lib/colormath.ts` (`xyzToLab`, `spectraToLab`, `deltaE00`),
`lib/analyzers/spreading.ts` (polynomial dot-gain + monotonicity penalty),
`lib/analyzers/optimizer.ts` (Nelder-Mead simplex, pure TS),
`lib/analyzers/cynsn.ts` (`demichel3`, `findCell3`, grid builders, `predictSpectra3`,
`extractNeugebauerPrimaries3`, `trainCYNSN3`, `evaluateCYNSN3`, `runCYNSNComparison`).
Architecture choice: K = 0 always → 3D CMY → 8 primaries → YNSN with `n_intervals = 1`
gives the single-cell baseline; CYNSN-2 uses `n_intervals = 2` for a 27-node grid.

UI integration: `ComparisonView` gained the "Within-profile CYNSN prediction" section
with per-profile YNSN vs CYNSN-2 table (columns: model, n_exponent, median ΔE00,
P95 ΔE00, RMS). Color coding: green < 2.0, yellow 2–3, red > 3.

Also pre-computed measured Lab outside the `trainCYNSN3` optimiser loop to avoid repeated
spectraToLab calls; reused a `predTmp` buffer to cut allocation pressure.

## 2026-05-21 — `feat: ink limits gate all analysis — sliders at top, filtered patches everywhere` (cc14bf6)

Ink-limit sliders moved to the top of `ComparisonView` and now gate every downstream
analyser (linearity, groups, ink-ratio, predictor, CYNSN). Each analyser receives the
already-filtered `MatchedPatchPair[]`. Eliminates the bug where the user could see
correlation numbers computed on patches above the ink limit.

`limitsAnalyzer.computeRampErrors` rewritten to use Yule-Nielsen `n = 2` between paper
and primary instead of linear Neugebauer (`n = 1`). For real Epson P9000 inks, `n = 1`
gave max ΔE76 ≈ 17.8 on a normal primary ramp — false-positive ink limit at level 192/255.
With `n = 2`, max ΔE drops to 5.3. Threshold raised from 2.0 to 6.0 accordingly. Detailed
write-up in `docs/EXPERIMENTS.md` (2026-05-22).

## 2026-05-21 — `refactor(frontend): code quality, English UI, responsive charts, project cleanup` (d745a8c)

Rebuilt frontend layout: gray-950 dark theme, responsive sidebar, English copy throughout.
D3 charts (`LabScatterPlot`, `SpectralCurves`) made responsive with `useMeasure`.
Removed stale fixtures and unused utilities. No analyser changes.

## 2026-05-21 — `feat(frontend): implement advanced color profile analysis and spectral prediction` (00c1cba)

Added `spectralPredictor.ts` (per-wavelength polynomial / YN / XYZ-affine model machinery,
`SpectralModelComparison` row), `inkRatioAnalyzer.ts` (T(λ) = R_ink / R_paper), and the
`PredictionAccuracyView` + `InkRatioTable` UI components. `groupAnalyzer.ts` introduced
to break patches into primaries / neutrals / mixed for the breakdown table.

## 2026-05-14 — `feat(frontend): add CxF and ZXML support for ICC profile parsing` (40b3645)

Real ICC parsing landed: `iccTagScanner.ts` locates the X-Rite `CxF` private tag,
identifies the `ZXML` data-type, skips the 12-byte header (4 data-type + 4 reserved +
4 unknown), inflates with `pako`. `parseCxf3Xml` walks the `cc:CxF` namespace and
extracts per-patch RGB device values + 36-band spectra. ICM parser refactored to
delegate to these.

## 2026-05-14 — `feat(frontend): implement color profile analysis dashboard` (f854d4a)

Two-pane dashboard: sidebar with `ProfileUploader` + `ProfileList`, main area with
`ComparisonView`. Zustand store added (`useProfileStore`) with profiles / selection /
results / loading state. ΔE colour-coding in `LabScatterPlot`.

## 2026-05-13 — `Add test infrastructure and fix parser/analyzer tests` (ea1ded1)

Vitest + jsdom + `@testing-library/jest-dom`. Fixed flaky parser tests around
percentage normalisation and default ID generation.

## 2026-05-13 — `Implement parsers and analyzers with tests, update documentation` (0eff24c)

First real CxF parser (XML), early `linearityAnalyzer` with Pearson r / R² / slope
stability / mean ΔE00 after correction / residual correlation. CMYK fuzzy match
(tolerance 2 %) for patch alignment — later superseded by the `Row:Col:Page` join when
RGB ZXML data came in.

## 2026-05-12 — `implement color profile analysis dashboard` (e3edd5f)

Initial scaffolding. React + Vite + TypeScript + Tailwind + Zustand.

## 2026-05-12 — `first commit` (a5a03c7)

Repository initialised.
