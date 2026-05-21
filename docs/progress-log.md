# Progress Log

## 2026-05-21 — CYNSN core implementation

**colormath.ts** — Added:

- `xyzToLab(X, Y, Z)` — CIE XYZ (D50/Y=100) → CIE Lab
- `spectraToLab(reflectance, startWL)` — spectral → Lab
- `deltaE00(L1,a1,b1, L2,a2,b2)` — full CIEDE2000

**spreading.ts** (new):

- `applySpreading3(cmy, params, N)` — polynomial dot-gain batch
- `packTheta3 / unpackTheta3` — optimizer interface
- `monotonicityPenalty3(params)` — soft monotonicity constraint

**optimizer.ts** (new):

- `nelderMead(fn, x0, options)` — Nelder-Mead simplex, pure TS, no deps

**cynsn.ts** (new) — 3D CMY CYNSN model ported from Python Color_Modeling:

- `demichel3 / demichel3Batch`
- `findCell3`
- `buildGridFromColorants3` — (n_intervals+1)³ grid via YNSN formula
- `buildGridFromData3` — KNN grid from measured patches
- `predictSpectra3` — full CYNSN forward pass
- `extractNeugebauerPrimaries3`
- `trainCYNSN3` — Nelder-Mead on ΔE00 loss
- `evaluateCYNSN3`, `runCYNSNComparison`

Architecture: K=0 always → 3D CMY, 8 primaries. YNSN (n_intervals=1) = 1 cell; CYNSN-2 = 27-node grid.

---

## 2026-05-21 — CYNSN UI integration

**cynsn.ts** — Optimized `trainCYNSN3`:
Pre-compute measured Lab outside optimizer loop; reuse `predTmp` buffer.

**ComparisonView.tsx**:

- `cysnRef` / `cysnTarget` useMemo hooks — fit ref and target profiles independently
- New "Within-profile CYNSN prediction" section — YNSN vs CYNSN-2 table per profile
- Columns: model, n_exponent, median ΔE00, P95 ΔE00, RMS
- Color coding: green < 2.0, yellow 2–3, red > 3

**types/index.ts** — Removed duplicate CYNSN interfaces (canonical location: cynsn.ts).

Next: validate on real Epson P9000 data. Check median ΔE00 < 2.
