# progress-log.md

> Append-only per-session changelog. Newest entries at the top. Bilingual EN/RU acceptable.
> Each entry: date, one-line summary, body explaining **why**, links to relevant
> `EXPERIMENTS.md` rows and commits.

---

## 2026-05-23 — Phase 3.5: OBA-aware D1 (ratio clamp + UI mismatch tile)

User observation triggered this commit: the spectral difference between
substrates in 380–390 nm is dominated by optical brighteners (OBA / FWA),
not by ink-paper optics. Empirical dump (commit 1e73dc6, second EXPERIMENTS
row) confirmed: R_paper(380 nm) ranges 0.117 → 0.819 across 8 sampled
substrates — a **7× spread**. Substrate-class name does NOT predict OBA
content (DecorMatte 0.117 and Lyve 0.663 are both CanvasMatte).

D1's `r(λ) = B_paper / A_paper` predictor blows up at those bands without
protection. A3's per-λ affine handles the linear part but cannot model the
non-linear OBA-vs-ink-coverage interaction.

### Changes

- **`frontend/src/lib/predict/oba.ts` (new)** — `detectOBA(spectrum)` returns
  `{ score = R(440)/R(550), r380, r440, r550, hasOBA }`. `obaMismatch(a, b)`
  is symmetric, non-negative. `obaMismatchSeverity` buckets into
  low / moderate / high at 0.05 / 0.15 thresholds.
- **`frontend/src/lib/predict/oba.test.ts` (+6 tests)** — flat spectrum
  score ≈ 1; synthetic 440 nm bump score > 1.1; bounds checks; symmetry;
  severity buckets.
- **`frontend/src/lib/predict/paperRatioResidual.ts`** — finalised the
  ratio clamp. New options field `ratioClamp: [number, number]` default
  `[0.3, 3.0]`. Fit now records `r` (clamped), `rUnclamped` (raw),
  `clampedBands: Int32Array` (indices where clamp fired), `clamp` (bounds
  used). Plumbed through `applyPaperRatioResidual` and
  `runPaperRatioResidualTransfer`.
- **`frontend/src/lib/predict/paperRatioResidual.test.ts` (+2 tests)** —
  no clamp in normal range; clamp activates at extreme ratios and bands
  list matches; custom `ratioClamp` honoured.
- **`frontend/src/components/TransferView.tsx`** —
  - Profile dropdowns now show `(OBA x.xx)` suffix per profile.
  - New `OBAMismatchTile` above head-to-head: shows mismatch score with
    red/yellow/green severity colouring; per-band table for ref + target
    (R(380), R(440), R(550), score); short advisory text matching severity.
  - D1 detail block now shows `clamped bands: N/36` when the ratio clamp
    fired, with explanatory text.
- **`frontend/src/App.tsx`** — kept the dev-only `window.__store =
  useProfileStore` line that landed during OBA dump investigation. Used
  by Playwright introspection to extract paper spectra for analysis.

### Hypothesis added

- **H8** in `docs/RESEARCH_HYPOTHESIS.md`: for OBA-mismatched pairs
  (`oba_mismatch ≥ 0.10`), D1 with default clamp beats A3 in median ΔE00
  on ≥ 60 % of pairs. Falsifiable via Phase 7 batch runner.

### First data point (EXPERIMENTS row)

DecorMatte (no OBA, R(380) = 0.117, score = 1.195) vs Lyve (OBA-loaded,
R(380) = 0.663, score = 1.017) — both CanvasMatte, OBA mismatch 0.179.

| Predictor | median ΔE00 | P95 ΔE00 | R² | RMS |
|---|---|---|---|---|
| A3 | 1.54 | 5.94 | 0.428 | 0.0210 |
| D1 (rank 2, clamp) | **1.45** | **5.36** | **0.846** | **0.0166** |

D1 wins by 0.09 ΔE00 and 2× higher R². **Meets H4 target (≤ 1.5);** A3
misses by 0.04. Clamp fired on 2/36 bands (380, 390 nm — raw ratios 5.67×,
4.82× clamped to 3.0×). Screenshot:
`docs/experiments/2026-05-23-oba-mismatch-decormatte-lyve.png`.

### Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → **102/102 passed** (was 93; +6 oba + 2 clamp + 1
  TransferView wiring)
- `npx vite build` → 331 KB / 101 KB gzip, success
- Playwright headless: OBA mismatch tile renders red (0.179 high),
  clamped-bands count visible in D1 block, A3 vs D1 head-to-head shows
  D1 winning by 0.09 ΔE00 on the first OBA-disparate pair.

### Next

Phase 4 — B3 pool-PCA predictor (basis from all 27 profiles, expected to
help on OBA-disparate pairs because OBA pattern is shared across many
substrates in the pool). Phase 5 — S2 greedy adaptive anchor selection.
Phase 7 — H4/H8 batch runner over all 702 directed pairs.

---

## 2026-05-23 — Phase 3: D1 paper-ratio + PCA residual + head-to-head TransferView

Phase 3 lands the second predictor (D1) and a head-to-head comparison mode so
A3 baseline and D1 can be evaluated side-by-side on the same anchor set.

D1 design:

- First-order: `B̂₁(λ, RGB) = r(λ) · A(λ, RGB)` with `r(λ) = B_paper / A_paper`
  (zero-division guard at 1e-3). Costs ONE anchor (paper).
- Second-order: PCA on residuals at the k-1 non-paper anchors, default rank 2.
  Per-RGB residual interpolated to all patches via inverse-distance-weighted
  kNN (K = 4) in device-RGB space.
- Final: `B̂ = B̂₁ + ε̂`, clamped to [0, 1].
- Degenerate paths: k = 1 → first-order only (graceful baseline); k = 2 →
  rank-1 trivial basis built from the single residual direction; k ≥ 3 → full
  PCA on residuals.

Changes in this commit:

- **`frontend/src/lib/predict/paperRatioResidual.ts` (new)** —
  `fitPaperRatioResidual`, `applyPaperRatioResidual`,
  `runPaperRatioResidualTransfer`. Reuses `dataset/basis.ts` for PCA.
- **`frontend/src/lib/predict/paperRatioResidual.test.ts` (+4 tests)** —
  paper-only k=1 path, pure-multiplicative recovery, k=2 degenerate basis,
  end-to-end run on non-multiplicative synthetic data.
- **`frontend/src/components/TransferView.tsx` (rewrite)** —
  - Predictor dropdown: `A3 vs D1 (head-to-head)` (default), `A3 only`, `D1 only`.
  - D1 residual rank selector (1 / 2 / 3 / 4).
  - Anchor strategy displayed as fixed text (only S1 for now).
  - Head-to-head table when both run: per-predictor median/P95 ΔE00, R², RMS,
    k. Bottom-line "Winner on median ΔE00" callout.
  - Per-predictor detail blocks: metric tiles, worst-5 patches, per-λ R²
    strip (A3 only), residual-rank annotation (D1 only).
  - Internal type narrowing via discriminated union (`{kind: 'ok' | 'error'}`)
    to keep tsc strict-mode happy.

First real-data observation (BC_17MGloss vs BC_17MSatin, both pk on
CanvasSatin):

- A3: median ΔE00 = 0.50, P95 = 1.71, R² = 0.967
- D1 (rank 2): median ΔE00 = 0.65, P95 = 2.08, R² = 0.965
- A3 wins because this pair is almost pure multiplicative substrate (same
  base, different finish). D1's residual stage overfits without adding value.
  Expect D1 to win on substrate pairs with strong non-linear deviation
  (different paper class, different OBA content, etc.).

Tests (+4): paperRatioResidual.test.ts. Phase 3 total: 93 → 93 (PCA test
file path is paperRatioResidual.test.ts; counts include all prior tests).

Verification (Node 22 via nvm; CI on Node 20):

- `npx tsc --noEmit` → exit 0
- `npx vitest run` → 93/93 passed
- `npx vite build` → 327 KB / 100 KB gzip, success
- Playwright headless verification on real data — screenshot captured;
  metrics + head-to-head + per-predictor blocks all populated.

Next: Phase 4 — Pool-PCA basis predictor (B3) so the 27-profile pool is
exploited; Phase 5 — greedy active anchor selection (S2) so the user can
see the minimum k for a chosen ΔE00 budget. The OBA observation (see
follow-up commit) will need an OBA-aware predictor variant or a per-λ
ratio cap to prevent D1 from blowing up on UV-bright substrate mismatches.

---

## 2026-05-23 — Standing permission: Playwright + screenshots (CLAUDE.md §7.1)

Added `CLAUDE.md` §7.1 — the agent is now expected to start the dev server,
drive it with Playwright (headless by default), and capture screenshots
without asking permission after every non-trivial frontend change. First
applied while diagnosing the Phase 2 `TransferView` panel: a screenshot
proved the new tab was rendering and that the empty-state message was the
expected behaviour when no profiles are loaded. A follow-up screenshot with
two real P9000 ICMs loaded showed populated metrics (median ΔE00 = 0.50,
P95 = 1.71, k = 13 anchors out of 905 shared SAMPLE_IDs) — A3 baseline
clearly meets the H4 acceptance bound on this pair.

Workflow + scope documented in `CLAUDE.md` §7.1.

---

## 2026-05-23 — Phase 2: A3 per-λ affine predictor + S1 heuristic anchors + TransferView UI

Phase 1 was infra-only — no visible output. This phase lands the first predictor end
to end so the user can pick two profiles in the UI and see actual ΔE00 numbers.

Why A3 first: trivial (closed-form OLS, 72 free parameters), no surprises, gives a
baseline that D1 (paper-ratio + PCA residual) and B3 (pool-PCA) must justify their
complexity against. Why S1 first: deterministic, no hidden hyperparameters, picks
the patches every reasonable transfer model needs (paper + 8 RGB corners + 5
neutrals = 13 anchors).

Changes in this commit:

- **`frontend/src/lib/sampling/heuristic.ts` (new)** — `pickHeuristicAnchors`
  picks the nearest measured patch to each of: paper (255,255,255), 6 RGB
  primaries, black, and N evenly spaced neutrals. Returns an `AnchorSet` with
  row indices in `meta.chosenIdx` for downstream predictor consumption.
- **`frontend/src/lib/predict/perLambdaAffine.ts` (new)** —
  - `fitPerLambdaAffine(X_A_anchors, X_B_anchors, L)`: closed-form OLS per λ
    yielding `(a, b)`. Fallback to `a=1, b=mean(B)-mean(A)` when variance at a
    wavelength is degenerate.
  - `applyPerLambdaAffine(X_A, L, fit)`: apply with [0,1] clamp.
  - `runPerLambdaAffineTransfer(input)`: end-to-end Task-2 run. Extracts anchor
    rows, fits, predicts every patch, evaluates on non-anchor patches.
  - `paperWPFromBrightestPatch(X, N, L)`: helper to derive paper-relative XYZ
    when no exact paper anchor exists.
- **`frontend/src/components/TransferView.tsx` (new)** — Phase 2 UI hub.
  Dropdowns for ref + target profile. Metric tiles: median ΔE00 (colour-coded
  green/yellow/red), P95 ΔE00, mean spectral R², mean RMS, anchor count,
  held-out patch count, shared SAMPLE_IDs. Worst-5 patches by ΔE00. Anchor list
  with labels (paper, red, …, neutral_0, …). Per-λ R² strip showing where the
  affine fit is tight vs loose.
- **`frontend/src/App.tsx`** — new tab strip above the main pane: "Compare
  (legacy)" → existing `ComparisonView`; "Transfer (Phase 2 — A3 + S1)" → new
  `TransferView`. Selection persists across tab switches.

Tests (+9, all pass):

- `heuristic.test.ts`: 4 tests — exact corners present, nearest fallback,
  neutralCount option, CMYK rejection.
- `perLambdaAffine.test.ts`: 5 tests — exact recovery of known (a, b),
  degenerate-wavelength fallback, shape guards, [0,1] clamp, end-to-end
  identity-affine transfer reports low ΔE00.

Verification (Node 22 via nvm; CI uses Node 20):

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **89/89 passed** (was 80/80 pre-Phase 2; +9 new).
- `npx vite build` → 317 KB / 97 KB gzip, success.

How to see the result: `npm run dev` in `frontend/`, drag-drop two ICM
profiles (different substrates, same printer/mode), switch to the "Transfer"
tab, pick reference and target. The report card populates as soon as both are
chosen. No "Run" button — the prediction is cheap enough to recompute on every
selection change.

Honest framing in the UI: the panel header explicitly says "predictor: per-λ
affine, anchor strategy: forced heuristic" so the user knows this is empirical
regression, not physics. Subsequent phases (D1, B3) will compete on the same
panel.

Next: Phase 3 — D1 paper-ratio + PCA residual predictor (expected best
performance at small k); add predictor dropdown to the panel so A3 / D1 / B3
can be compared head-to-head.

---

## 2026-05-23 — Phase 1: data-driven track shared infrastructure

Strategic pivot from physics-faithful CYNSN to data-driven profile compression and
cross-substrate transfer (plan: `/home/mikz/.claude/plans/64c2df34-whitepoint-rgb-cmy-bug.md`).
This commit lands the shared infra used by every predictor and anchor-selection
method in subsequent phases. No predictors yet — that lands in Phase 2 onward.

Why now: the previous CYNSN track was physics-incorrect for the actual dataset
(Epson P9000 is a 10-channel printer hiding behind an RGB ICC), and the architecture
had drifted from any falsifiable hypothesis. Resetting to a data-driven track keeps
the parser + UI shell + colour math (the parts that work) and rebuilds the analytic
layer on honest assumptions: empirical regression on RGB → R(λ) with explicit
acknowledgement that primaries/n/spreading from the old CYNSN had no physical
meaning on this dataset.

Changes in this commit:

- **`frontend/src/types/index.ts`** — add `WhitePointXYZ`, `SaturationLimits`,
  `AnchorSet`, `PredictionReport` types. These are the contract between every
  predictor and the evaluation harness.
- **`frontend/src/lib/colormath.ts`** — add optional `wp` argument to `xyzToLab` and
  `spectraToLab`. Default = `D50_PERFECT_WHITE` (matches historic behaviour, no
  regression). Passing a substrate-derived white point yields paper-relative Lab
  where the substrate's paper anchor sits at (100, 0, 0).
- **`frontend/src/lib/dataset/matrix.ts` (new)** — `loadProfileMatrix` builds N×L
  spectral and N×{3,4} device matrices in stable SAMPLE_ID order so cross-profile
  joins by `Row:Col:Page` are deterministic. `alignByCommonSampleIds` does the
  join itself and returns index arrays for the shared subset.
- **`frontend/src/lib/dataset/split.ts` (new)** — `splitCalTest` with `kfold`,
  `random`, and `fixed` modes. Deterministic Mulberry32 PRNG under a seed so
  experiment runs are reproducible across sessions.
- **`frontend/src/lib/dataset/evaluate.ts` (new)** — `evaluatePrediction` consumes a
  predicted vs measured spectral matrix and returns the canonical `PredictionReport`:
  median + P95 ΔE00 (paper-relative WP), mean spectral R², mean RMS, five worst
  patches by ΔE00.
- **`frontend/src/lib/dataset/basis.ts` (new)** — minimal PCA: Jacobi
  eigendecomposition on an L×L covariance matrix (L = 36, plenty fast in pure TS),
  `fitPCA`/`pcaProject`/`pcaReconstruct`/`varianceExplained`. `fitPoolPCA`
  concatenates per-profile matrices for hypothesis H6 (pool basis vs ref-only basis).
- **Pre-existing optimiser flakiness fix (cherry-picked from your uncommitted work)** —
  `nelderMead` now requires BOTH ftol AND xtol to fire before declaring convergence.
  The previous behaviour returned the moment one of the two thresholds was hit,
  which caused the 1D quadratic test to stop at x ≈ 0.3 instead of converging to 0.
  The rest of your in-progress analyser/component work remains stashed under
  `stash@{1}` for separate review.
- **New hypothesis statements: H3, H4, H5, H6** in `docs/RESEARCH_HYPOTHESIS.md`,
  each with falsifiable acceptance/reject criteria and a pointer to the experiment
  script that will test it.
- **New tests:** 4 in `dataset/matrix.test.ts`, 7 in `dataset/split.test.ts`,
  3 in `dataset/evaluate.test.ts`, 6 in `dataset/basis.test.ts`, 3 in
  `colormath.wp.test.ts`. Total: 23 new tests covering every Phase 1 module.

Verification (Node 22 via nvm; CI uses Node 20):

- `npx tsc --noEmit` → exit 0.
- `npx vitest run` → **80/80 passed** (was 57/57 pre-Phase 1; +23 from new tests).
- `npx vite build` → 304 KB / 93 KB gzip, success.

Next: Phase 2 — A3 per-λ affine predictor + S1 heuristic anchor strategy + minimal
`TransferView` UI panel. Will compose entirely from the modules landed in this commit.

---

## 2026-05-23 — DeviceSpace abstraction (foundation) + tsc cleanup

Two parallel chunks of code work shipped together because the tsc fixes are
needed for the build to be green at all — DeviceSpace touches the same files
indirectly through `types/index.ts`.

### DeviceSpace abstraction (foundation slice)

The codebase had two competing conventions for device-side colorants: legacy
`CMYK_*` fields (used by `linearityAnalyzer` and the old icmParser synthetic
path) and direct `RGB_R/G/B` access (used by everything currently producing
results on the real RGB dataset). Future CMYK datasets cannot be processed
without a rewrite under either convention. Step 1 of the migration:

- **`types/index.ts`** — introduce `DeviceSpace = 'rgb' | 'cmyk'`,
  `DeviceValue = { space, values }`, and a new optional `device?: DeviceValue`
  field on `Measurement`. Add helpers `toCMY()` (RGB inversion / CMYK→CMY with
  K composited multiplicatively), `toCMYK()`, and `deriveDevice()` to build
  `device` from legacy fields for transitional code paths.
- **`parsers/cxfParser.ts`, `parsers/icmParser.ts`** — populate `device`
  alongside the existing `RGB_*`/`CMYK_*` fields. No analysers consume it yet;
  per-analyser port is queued under TODO.md P1 epic.

Legacy `RGB_*` / `CMYK_*` fields remain populated so existing analysers keep
working. They will be removed once every analyser has been ported.

### Duplicate removal

- **Deleted** `frontend/src/lib/cxFParser.ts` (137 LOC) — a vestigial
  text-format CxF/X3 `@data` parser referenced only by its own test. The real
  CxF3 path goes through `lib/iccTagScanner.ts` + `lib/parsers/cxfParser.ts`.
- **Deleted** `frontend/src/utils/cxfParser.test.ts` — the only consumer of
  the file above.

### tsc cleanup (pre-existing errors, not introduced by this session)

`npx tsc --noEmit` was failing on `main` before this session. Verified the
errors were not introduced by the DeviceSpace edits, then cleaned them up:

- **`types/index.ts`** — `PatchGroupResult` gained the fields the analyser
  was already producing and the table was already reading: `pearson_r`,
  `r_squared_L`, `slope_L`, `intercept_L`. These were referenced from
  `groupAnalyzer.ts` and `GroupBreakdownTable.tsx` / `ComparisonView.tsx`
  but absent from the interface.
- **`lib/iccTagScanner.ts`** — drop broken `import type … from './types'`
  (no such module; the types are defined inline).
- **`src/global.d.ts`** — minimal ambient declaration for `pako` (avoids the
  `@types/pako` dev dep for just `inflate`).
- **`.gitignore`** — strip stray markdown fence (lines 1, 56 were literal
  triple-backtick); add `!frontend/src/**/*.d.ts` exception so hand-written
  ambient declarations are tracked; add `.kilo/` alongside `.specify/` and
  `.lingma/`.
- **`spectralPredictor.ts`** — drop unused `PredictionModelType` import and
  unused `n` local.
- **`InkRatioTable.tsx`, `PredictionAccuracyView.tsx`** — drop unused
  destructured props (`refLabel`, `targetLabel`).

Verification: `npx tsc --noEmit` exits 0; `npx vitest run` → 57/57 passed;
`npx vite build` → success.

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
