# ROADMAP.md

## Phase 0: Foundation (May 2026) — DONE

- [x] Document-driven project structure
- [x] Filename parser + metadata extraction (TypeScript)
- [x] Data loader (.icm / CxF / ZXML embedded in ICM)
- [x] CxF3 cc:-namespace XML parsing, spectral extraction
- [x] ICC tag scanner: ZXML tag → pako inflate → CxF XML
- [x] Patch matching by Row:Col:Page key across profiles
- [x] Lab ← spectral via CIE 1931 2° / D50

## Phase 1: Cross-substrate analysis dashboard (May–June 2026)

- [x] Interactive comparison dashboard (React + D3)
- [x] Ink limit sliders (per-channel CMY + 2-ink combos) — filter all downstream analysis
- [x] Linearity metrics: Pearson r, R², slope stability, ΔE00 after correction
- [x] Group breakdown table (primaries, neutrals, mixed)
- [x] Ink ratio analysis (T(λ) = R_ink / R_paper)
- [x] Spectral predictor: per-wavelength polynomial models (mult, poly1-3, YN)
- [x] XYZ-space affine predictor as baseline

## Phase 2: CYNSN within-profile model (June 2026) — IN PROGRESS

Goal: predict R(λ) from device RGB values for a single profile using physics-based
Cellular Yule-Nielsen Spectral Neugebauer (CYNSN) model.
Achieves median ΔE00 < 2 on calibration fraction; enables cross-substrate comparison
via model parameter delta rather than raw spectral difference.

- [x] Port Python CYNSN to TypeScript, adapted for RGB/3D (K=0 always):
  - `colormath.ts`: `xyzToLab`, `spectraToLab`, CIEDE2000 `deltaE00`
  - `spreading.ts`: polynomial CMY dot-gain (1 DOF/channel), pack/unpack
  - `optimizer.ts`: Nelder-Mead simplex — joint (θ_C, θ_M, θ_Y, log n) optimisation
  - `cynsn.ts`: `demichel3`, `findCell3`, `buildGridFromColorants3`, `predictSpectra3`,
    `extractNeugebauerPrimaries3`, `trainCYNSN3`, `evaluateCYNSN3`, `runCYNSNComparison`
- [ ] Wire into ComparisonView: CYNSN result card with median/P95 ΔE00, n_exponent
- [ ] Validate: median ΔE00 < 2 on Epson P9000 within-profile test

## Phase 3: Cross-substrate transfer model (July 2026)

Hypothesis: CYNSN model parameters (primaries, n, spreading) shift predictably
between substrates.  An affine transform in spectral or model-parameter space
generalises across substrates with few calibration patches.

- [ ] Fit delta between ref and target CYNSN primaries
- [ ] Test: can 8-primary calibration on substrate A predict substrate B?
- [ ] Savitzky-Golay spectral smoothing before fitting
- [ ] Few-shot adaptation: how many patches needed for accurate transfer?

## Phase 4: Generative & ML

- [ ] VAE / β-VAE prototype for disentanglement of ink vs substrate factors
- [ ] Few-shot fine-tuning (adaptation layer on CYNSN)

## Phase 5: Scientific output

- [ ] Substack article: "Predicting spectral color across substrates with 8 patches"
- [ ] Open-source release with sample data
