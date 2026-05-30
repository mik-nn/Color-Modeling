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

## Phase 2 — CYNSN within-profile model (June 2026) — **RETIRED (2026-05-29, H1 withdrawn)**

> Superseded by the data-driven track below. The CYNSN physics model never met its
> acceptance gate and was removed from the frontend; H1 is withdrawn (see
> `docs/RESEARCH_HYPOTHESIS.md` Retraction). The `[x]` items below remain as historical
> record; the `[ ]` items are cancelled.

**Goal (historical):** predict R(λ) from device values for a single profile using
physics-based Cellular Yule-Nielsen Spectral Neugebauer (CYNSN).

- [x] Port Python CYNSN to TypeScript, 3D CMY (K = 0):
  - `colormath.ts`: `xyzToLab`, `spectraToLab`, CIEDE2000 `deltaE00`.
  - `spreading.ts`: polynomial dot-gain, `pack/unpackTheta3`, monotonicity penalty.
  - `optimizer.ts`: Nelder-Mead simplex (pure TS).
  - `cynsn.ts`: `demichel3`, `findCell3`, `buildGridFromColorants3`, `buildGridFromData3`,
    `predictSpectra3`, `extractNeugebauerPrimaries3`, `trainCYNSN3`, `evaluateCYNSN3`,
    `runCYNSNComparison`.
- [x] Wire into `ComparisonView` — "Within-profile CYNSN prediction" table per profile,
      columns: model / `n_exponent` / median ΔE00 / P95 ΔE00 / RMS.
- [x] Fix primary-extraction collapse (commit f8cb1e8) and add measured-grid override path
      for CYNSN-2.
- [ ] ~~Fix Bug 2 (`grid_cynsn2` ignored in `trainCYNSN3` loss)~~ — cancelled.
- [ ] ~~Fix Bug 1 (`n` cap 10→30)~~ — cancelled.
- [ ] ~~Acceptance: median ΔE00 < 2 on ≥ 20 of 27~~ — cancelled.

## Phase 3 — Cross-substrate transfer (CYNSN parameter delta) — **RETIRED (2026-05-29)**

> Withdrawn with H1. Replaced by the data-driven cross-substrate transfer track below.

- [ ] ~~Per-channel primary delta between ref/target CYNSN fits~~ — cancelled.
- [ ] ~~8-primary calibration A→B within median ΔE00 < 3~~ — cancelled.
- [ ] ~~Few-shot adaptation: min patches for ΔE00 < 3~~ — cancelled.

## Phase 2′ — Data-driven transfer (active; H3–H10) — **IN PROGRESS**

Replaces the retired CYNSN track. Predict cross-substrate spectra from anchors via empirical
predictors (A3 per-λ affine, D1 paper-ratio+PCA, C7 per-λ monotone) and a Conditional
Autoencoder (CAE_D7). Best results so far on single pairs: C7+S3-neutral 1.06 ΔE00;
CAE_D7 median-of-medians 1.66 over held-out pairs (see `docs/EXPERIMENTS.md`).

- [x] A3 / D1 / B3 / C7 predictors + anchor strategies S1–S4.
- [x] CAE_RAW, CAE_D7, CAE_D7_M1 (cross-trained MK profiles; OBA-cleaned variant).
- [ ] Batch runner over all directed pairs to test H4 (≥80% ≤1.5) / H8 / H9 properly.
- [ ] H10b anchor fine-tune (fair CAE-vs-classical comparison).

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
