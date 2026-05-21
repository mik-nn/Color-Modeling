# TODO

## CYNSN Implementation (active)

### Core math (DONE)

- [x] `colormath.ts` — add `xyzToLab`, `spectraToLab`, `deltaE00` (CIEDE2000)
- [x] `spreading.ts` — CMY polynomial spreading, pack/unpack, monotonicity penalty
- [x] `optimizer.ts` — Nelder-Mead simplex (pure TS, no deps)
- [x] `cynsn.ts` — 3D CMY port of Python CYNSN:
  - `demichel3` / `demichel3Batch`
  - `findCell3`
  - `buildGridFromColorants3`
  - `buildGridFromData3` (KNN)
  - `predictSpectra3`
  - `extractNeugebauerPrimaries3`
  - `trainCYNSN3` (Nelder-Mead on ΔE00 loss)
  - `evaluateCYNSN3`
  - `runCYNSNComparison`
- [x] Types: `CYNSNEvaluation`, `CYNSNComparisonResult` in `types/index.ts`

### Integration (next)

- [ ] Wire `runCYNSNComparison` into `ComparisonView.tsx`
- [ ] Add `CYNSNResultCard` component — show median/P95 ΔE00, n_exponent, spreading params
- [ ] Add `PredictionModelType` variants: `'ynsn'`, `'cynsn_2'`
- [ ] Show YNSN vs CYNSN-2 comparison table in UI (model_label, median ΔE00, P95 ΔE00)

### Testing

- [ ] Unit tests for `demichel3` (weights sum to 1, corner cases)
- [ ] Unit tests for `deltaE00` (known reference pairs from ISO 11664-6)
- [ ] Integration test: synthetic primary dataset → YNSN converges dE < 2

### Quality

- [ ] Benchmark: run on real data, compare with Python reference output
- [ ] CYNSN-2 with measured grid (`buildGridFromData3`) — check if improves over YNSN
- [ ] Savitzky-Golay smoothing for spectral cleaning before CYNSN fitting

## Infrastructure

- [ ] `npm test` passes (blocked by Node v12 — needs v14+ for optional chaining in vitest/tsc)
- [ ] Add GitHub Actions CI with Node v18

## Research

- [ ] Verify: within-profile YNSN achieves median ΔE00 < 2 on Epson P9000 data
- [ ] Cross-substrate: fit affine transform in spectral domain after CYNSN prediction
- [ ] Document findings in `docs/EXPERIMENTS.md`
