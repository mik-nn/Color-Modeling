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

## Phase 2 — CYNSN within-profile model (June 2026) — **IN PROGRESS**

**Goal:** predict R(λ) from device values for a single profile using physics-based
Cellular Yule-Nielsen Spectral Neugebauer (CYNSN). Target: median ΔE00 < 2 on the
calibration fraction. This is the foundation for Phase 3 (cross-substrate transfer via
model-parameter delta).

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
- [ ] **Fix Bug 2** (`docs/cynsn-pipeline.md`): `trainCYNSN3` ignores `grid_cynsn2`
      inside the loss; spreading is tuned for the wrong grid, then the grid is swapped.
- [ ] **Fix Bug 1**: raise `n` cap from 10 to 30 (or use a soft penalty).
- [ ] **Acceptance:** median ΔE00 < 2 on within-profile test split for ≥ 20 of 27 P9000
      profiles. Record in `docs/EXPERIMENTS.md`.

## Phase 3 — Cross-substrate transfer model (July 2026)

**Hypothesis:** CYNSN parameters (primaries, $n$, spreading) shift predictably between
substrates. A low-parameter transform (affine in spectral space, or per-parameter delta)
generalises with few calibration patches on the target.

- [ ] Compute per-channel primary delta between ref and target CYNSN fits.
- [ ] Test: can 8-primary calibration on substrate A reconstruct CYNSN on substrate B
      within median ΔE00 < 3?
- [ ] Few-shot adaptation: minimum patches needed for ΔE00 < 3.
- [ ] Optional: Savitzky-Golay spectral smoothing before fitting.

## Phase 4 — Generative & ML

- [ ] Conditional β-VAE prototype for ink-vs-substrate factor disentanglement.
- [ ] Adaptation layer on top of CYNSN (few-shot fine-tune).

## Phase 5 — Scientific output

- [ ] Article / Substack post: "Predicting spectral color across substrates with 8 patches".
- [ ] Open-source release with sample data and reproducible notebooks.

---

## Cross-cutting epics

- [ ] **DeviceSpace abstraction** — refactor `Measurement` to `{device: {space, values}}`,
      branch analysers on `device.space`. Unblocks future CMYK datasets.
- [ ] **Remove parser duplicates** — `lib/cxFParser.ts`, `utils/cxfParser.test.ts`.
- [ ] **Pre-commit DDD hook** — `.githooks/pre-commit` blocks `feat:` / `fix:` without
      `progress-log.md` change.
- [ ] **Cleaning pipeline** — `lib/dataLoader.ts` `clean === raw` placeholder; implement
      MAD outlier detection + Savitzky-Golay smoothing.
- [ ] **Web Worker** for CYNSN training (Nelder-Mead blocks main thread 1–5 s).
