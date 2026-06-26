# ROADMAP.md

> Pre-registered plan. Each milestone has a measurable acceptance criterion and produces at
> least one row in `docs/EXPERIMENTS.md`. Phases run roughly sequentially but Phase 3 needs
> Phase 2 done.

---

## Phase 0 — Foundation (May 2026) — **DONE**

- [x] Document-driven project skeleton: `CLAUDE.md`, `AGENTS.md`, `docs/*`, `.githooks/`.
- [x] Filename parser + metadata extraction (`utils/filenameParser.ts`).
- [x] File loader for `.icm` / `.cxf` (`lib/dataLoader.ts`).
- [x] CxF3 (`cc:CxF` namespace) XML parser → `Measurement[]` (`lib/parsers/cxfParser.ts`).
- [x] ICC tag scanner: locate ZXML tag, `pako.inflate`, hand to CxF parser
      (`lib/iccTagScanner.ts`, `lib/parsers/icmParser.ts`).
- [x] Cross-profile patch matching by `Row:Col:Page` key.
- [x] Spectral → XYZ (CIE 1931 2° / D50) → Lab pipeline (`lib/colormath.ts`).
- [x] CIEDE2000 ΔE00 (`lib/colormath.ts`), ISO 11664-6 reference tests.

## Phase 1 — Cross-substrate analysis dashboard (May–June 2026) — **DONE**

- [x] Interactive comparison view (React + D3): `ComparisonView`.
- [x] Ink-limit sliders per channel (C / M / Y) + 2-ink combos (CY / MY / CM) gating all
      downstream analyses (`InkLimitSection`).
- [x] Linearity metrics: Pearson r, R², slope stability, ΔE00 after correction
      (`linearityAnalyzer.ts` — legacy, slated for DeviceSpace port).
- [x] Group breakdown table (primaries, neutrals, mixed) — `groupAnalyzer`.
- [x] Ink ratio analyser: `T(λ) = R_ink / R_paper` (`inkRatioAnalyzer`).
- [x] Spectral predictor: per-wavelength polynomial (poly1/2/3), YN, XYZ affine
      (`spectralPredictor`).
- [x] Yule-Nielsen-based ink-limit detection with `n = 2` interpolation
      (`limitsAnalyzer`).

## Phase 2 — CYNSN within-profile model — **RETIRED (2026-05-29)**

> Physics-based Cellular Yule-Nielsen Spectral Neugebauer. Never met acceptance gate
> (median ΔE00 < 2). Removed from frontend; H1 retracted. Kept as historical reference in
> `lib/analyzers/cynsn.ts`. Replaced by Phase 2′ data-driven track.

**Historical goal:** predict R(λ) from device values using CYNSN physics.

- [x] Port CYNSN to TypeScript, 3D CMY (K = 0) — `colormath.ts`, `spreading.ts`,
      `optimizer.ts`, `cynsn.ts`, Nelder-Mead simplex.
- [x] Wire into `ComparisonView` — "Within-profile CYNSN prediction" table.
- [x] Fix primary-extraction collapse (commit f8cb1e8).
- [x] Retired 2026-05-29. See `docs/RESEARCH_HYPOTHESIS.md` Retraction for H1.

## Phase 3 — Cross-substrate transfer (CYNSN parameter delta) — **RETIRED (2026-05-29)**

> Withdrawn with H1. Superseded by Phase 2′ data-driven transfer.

## Phase 2′ — Data-driven transfer (H3–H10) — **IN PROGRESS (as of 2026-05-30)**

Empirical spectral predictors + Conditional Autoencoder. Best results: CAE_D7 median
1.66 ΔE00 over held-out cross-substrate pairs on per-mode training (H10b confirmed).

- [x] A3 / D1 / B3 / C7 predictors + anchor strategies S1–S4 (`lib/predict/`, `lib/sampling/`).
- [x] CAE_RAW, CAE_D7, per-mode variants (commit 706a51b: `python/cae/cv_train.py`, per-preset pools).
- [x] H10b anchor fine-tune (in `lib/predict/cae.ts`; Adam, 200 steps, lr=0.05).
- [x] CGATS cross-grid alignment: `cgatsParser.ts` `SAMPLE_ID = RGB_{R}_{G}_{B}` + `TransferView.tsx` paper detection by exact RGB(255,255,255) device-value lookup (2026-06-12).
- [x] Re-run batch runner over all 702 directed pairs after CGATS fix — same-mode 80.6% confirmed stable (2026-06-12).
- [x] Re-generate all per-mode evaluate JSONs from correct per-mode weights; `evaluate.py` gains `--mode` + `--payload` + `_test` set suffix (2026-06-12).
- [ ] UI mode selector for per-mode CAE_D7 weight loading (`frontend/src/data/cae_weights_d7_*.json`).
- [x] H16: per-substrate YN exponent at 640–680 nm — **REJECTED** (2026-06-12). Null effect on P95; P95 driver is OBA-mismatch in chromatic patches, not 640–680nm YN nonlinearity.
- [x] **H17:** Spectral residual band analysis on DecorMatte→ChromataWhite — **REJECTED as stated** (2026-06-12). UV/VIS ratio=0.933 in P95 group (OBA-dominance hypothesis wrong). Unexpected finding: P95 error concentrated at 530–580 nm (green-yellow VIS) in dark blue/violet gamut-boundary patches (R=31–63, G=0–28, B=63–191, heavy C+M). D7 OBA correction works; the gap is nonlinear ink-substrate interaction at high CMY density.
- [x] **H18:** Ink-coverage correlation + high-CMY anchor augmentation — **H18a+H18c CONFIRMED; H18b rejected** (2026-06-12). Spearman(ink, ΔE00)=0.712 (confirmed). 530–580nm error NOT coverage-driven (r=−0.12, rejected). Augmenting S1 with 3 dark-blue/violet anchors drops P95 6.419→4.787 (Δ1.63 ΔE00, confirmed). Coverage bucket analysis: error scales monotonically with ink sum (P95: 2.1→3.4→6.1→7.7). After fix, worst sector shifts to heavy-Y patches (R≈100–160, G≈85–170, B≈0).
- [ ] **H19 (next):** Test whether (a) adding 3 anchors in the heavy-Y sector (R≈130, G≈130, B≈0 and R≈100, G≈85, B≈0) further reduces P95, or (b) raising residualRank 5→8 (SVD p95 rank = 8 from H8 analysis) closes the high-ink gap without more anchors. Both interventions target the same ink-coverage model-inadequacy root cause.

## Phase 2″ — Print-mode taxonomy + cross-vendor comparison (H11) — **CONFIRMED**

- [x] Reorganise `data/profiles/` into per-Epson-preset subfolders + canonical-mode mapper
      (`utils/printMode.ts`).
- [x] RGB-lattice interpolation: `rgbInterp.ts` (k-NN IDW), then `wlsInterp.ts` (local-linear
      WLS, default — drops BC interp noise floor 1.8 → 0.7 ΔE00).
- [x] Cross-chart alignment fallback in `dataset/matrix.ts:alignByDeviceGrid` (TransferView
      uses it when shared SAMPLE_IDs < 50).
- [x] Substrate normalisation (`MODE_NORM=device`: OBA-clean + paper-relative on a common
      reference paper) — closes the H11 gap (Premium Glossy 3.36 → 1.34).
- [x] **H11 confirmed** on the three overlapping presets (Canvas Matte, Premium Luster,
      Premium Glossy): cross-set median 1.2–1.4 ΔE00, P95 3.3–4.0; most BC×MOAB pairs P95 < 3.
      Per-pair breakdown in `docs/mode-comparison.md` surfaces outlier pairs (all are
      OBA-extreme BC papers paired with low-OBA MOAB papers — physically grounded, not
      interpolation artefacts).
- [ ] Refine D7 OBA-emission model on multi-vendor papers to push the OBA-extreme outlier
      pairs below P95 3.

## Phase 2‴ — D1 defaults tuned for OBA-mismatched pairs — **DONE**

- [x] D1 default residual rank 2 → 5 (H5 showed median effective rank 5).
- [x] Per-band UV clamp in `paperRatioResidual.ts` (`ratioClampUV=[0.1, 7.0]` on 380–410 nm,
      uniform `[0.3, 3.0]` retained for 420–730 nm). Library default is opt-in
      (`uvBandCount=0`); TransferView passes `uvBandCount: 4`.
- [x] D7 OBA-separation default ON in TransferView. Combined effect on DecorMatte ↔ {Lyve,
      BelgianLinen, ChromataWhite}: P95 −14 to −20 %, zero clamped bands.

## Phase 2⁴ — H44: patch strategy vs ink complexity — **DONE (2026-06-20)**

Tested whether colorant-derived anchor charts (0 profiles) enable cross-substrate
D1 prediction across 7 printers spanning 4–12 physical inks.

- [x] Parser extensions: nm/R_ CGATS dialects (`cgatsParser.ts`); CIED+DevD join
      (`mergeCiedDevDToCgats`); CIED branch in `icmParser.ts`. All 7 printers parse.
- [x] `h44_manifest_builder.ts` → `data/h44_manifest.json` (240 entries).
- [x] `colorantChart(k)` pure function — CMY-geometry RGB targets, k=5/6/8/12/16.
      Tests: 13/13 green.
- [x] **H44-A (NEGATIVE):** colorant chart gives 0–20% H4 pass at k ≤ 16 on all
      7 printers. No trend with ink complexity. Colorant geometry alone insufficient.
- [x] **H44-B (WEAK):** GA k=8 in-sample gives 7–58% across printers on cross-mode
      pairs. Pigment slightly more interior points (5.2 vs 4.5 dye). Critical finding:
      cross-mode pairs are 4–10× harder than same-mode (prior 90.4% → 7–22%).
- [x] Docs: `EXPERIMENTS.md` rows, `RESEARCH_HYPOTHESIS.md` H44 section, progress-log.

**Practical answer:** minimum 1 same-mode measured profile + COV5 anchors. Colorant
geometry or GA chart without profile data cannot clear H4 in the cross-mode regime.

## Phase 2⁵ — H45: ink-limit gamut-volume tradeoff — **IN PROGRESS (2026-06-26)**

Tests whether an **intrinsic ink limit** (chroma-maximum $t^\*$ per ramp) removes the
unpredictable gamut-edge overflow/holdout patches while barely shrinking gamut volume —
unifying H18 (error ∝ coverage), H35 (ink holdout) and H40 (gamut-edge hue rotation).

- [ ] `lib/analyzers/gamutVolume.ts` — pure-TS 3D convex hull + Lab volume + max-chroma-per-hue-bin. Tests vs cube/tetra/octahedron.
- [ ] `lib/analyzers/inkLimitChroma.ts` — ramp extraction by device coords, chroma-max $t^\*$ + hue-shift + signFlipScore.
- [ ] `lib/analyzers/forwardRampModel.ts` — within-profile YN n=2 forward model, LOO ΔE00.
- [ ] `scripts/experiments/h45_inklimit_gamut.ts` — broad sweep all ink systems; auto-select problematic cohort; both predictors before/after limit. → `data/h45_inklimit_gamut.json`.
- [ ] Verdict on H45a (ΔV ≤ 5 %), H45b (forward LOO −0.5), H45c (D1 +10 pp), H45d (worst-5 % recall ≥ 60 %) → `EXPERIMENTS.md` + `KEY_FINDINGS.md`.

## Phase 4 — Generative & ML

- [ ] Conditional β-VAE prototype for ink-vs-substrate factor disentanglement.
- [ ] Adaptation layer on top of CYNSN (few-shot fine-tune).

## Phase 5 — Scientific output

- [ ] Article / Substack post: "Predicting spectral color across substrates with 8 patches".
- [ ] Open-source release with sample data and reproducible notebooks.

---

## Cross-cutting epics

- [ ] ~~**DeviceSpace abstraction** — branch analysers on `device.space`~~ — **RETIRED**
      (2026-05-29, H2 withdrawn). Types/helpers stay as inert scaffolding; revive only for a
      real CMYK dataset.
- [ ] **Remove parser duplicates** — `lib/cxFParser.ts`, `utils/cxfParser.test.ts`.
- [ ] **Pre-commit DDD hook** — `.githooks/pre-commit` blocks `feat:` / `fix:` without
      `progress-log.md` change.
- [ ] **Cleaning pipeline** — `lib/dataLoader.ts` `clean === raw` placeholder; implement
      MAD outlier detection + Savitzky-Golay smoothing.
- [ ] **Web Worker** for CYNSN training (Nelder-Mead blocks main thread 1–5 s).
