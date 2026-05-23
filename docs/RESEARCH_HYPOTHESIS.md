# RESEARCH_HYPOTHESIS.md

> Falsifiable. Pre-registered. Update only with a new dated section — never edit past
> hypotheses retroactively.

---

## H1 — Device-Substrate Separation (primary, 2026-05)

Under fixed print conditions (one printer, one ink set, one print mode), the **device
behaviour** $f_d$ — ink mixing, dot gain, Yule-Nielsen optics — can be separated from the
**substrate effect** $g_s$ in a way that admits a low-parameter representation of $g_s$.

### Formal statement

Let $\mathbf{c}$ be a device-colorant vector (RGB inversion → CMY, or CMYK directly).
Let $f_d(\mathbf{c})$ be the device-dependent forward model producing a reference-substrate
reflectance, and $g_s(\cdot)$ the substrate-dependent transform. Then the measured
reflectance is approximately:

$$\mathbf{R}_{\text{meas}}(\lambda) \approx g_s\!\left(f_d(\mathbf{c}); \lambda\right).$$

H1 claims $g_s$ is well-approximated by an **affine transform** in either (a) reflectance
space, (b) XYZ space, or (c) the CYNSN parameter space (primaries + $n$ + spreading).

### Sub-hypotheses

- **H1.1** Residuals after a within-profile CYNSN fit correlate linearly between
  substrates (Pearson r > 0.93).
- **H1.2** Relative ink-spreading coefficients (slope / bias between channels) are stable
  across substrates (CV of cross-substrate ratios < 0.15).
- **H1.3** Media white point + a single global scaling factor explains > 70 % of
  cross-substrate variance.
- **H1.4** A CIECAM02-style adaptation outperforms simple media-relative scaling.

### Acceptance criteria

- Pearson / Spearman correlation > **0.93** between predicted and measured spectra on the
  held-out substrate.
- $R^2$ of linear regression on residuals > **0.90**.
- Mean ΔE00 after correction < **1.5** when using ≤ **12 patches** on the target substrate.

### Falsification criteria

Hypothesis is rejected if **any** of the following holds on the Epson P9000 dataset:

- Median ΔE00 > 3 after correction with the smallest patch budget (≤ 12) on > 30 % of
  cross-substrate pairs.
- The cross-substrate transform requires > 50 free parameters to hit ΔE00 < 1.5 (i.e. the
  separation provides no compression).
- Within-profile CYNSN itself fails to reach median ΔE00 < 2 on > 7 of 27 profiles —
  without a converged within-profile model, the cross-profile claim is undefined.

### Dataset slice

- 27 Epson P9000 RGB ICM profiles (with embedded CxF3 spectral) at
  `/mnt/e/PET/LinkedInPosts/surecolor-p9000/`.
- All profiles printed with the same printer / ink set / print mode; only the substrate
  differs.
- M0 measurement condition (24 profiles) for primary analysis; M2 (4 profiles, UV-cut) as
  a secondary sensitivity check.

### Tests

Recorded as dated rows in `docs/EXPERIMENTS.md` with the analyser commit SHA.

---

## H2 — DeviceSpace invariance (2026-05, secondary)

The data model and analyser surface remain valid when the dataset changes from RGB to
CMYK profiles, provided the `DeviceSpace` discriminator is honoured. **Test:** after the
DeviceSpace refactor, identical CYNSN fits on a synthetic CMYK fixture and the same data
re-encoded as RGB must produce ΔE00 < 0.5 between their predictions.

This is an engineering hypothesis (architecture, not science) but it is recorded here
because it gates downstream research on CMYK datasets.

---

## H3 — Single-profile compression (2026-05, data-driven)

For any RGB profile in the current 27-profile P9000 set, there exists a calibration
subset K ≤ 80 patches whose measurement enables reconstruction of the remaining
905 − K patches with **median ΔE00 ≤ 1.5** and **P95 ΔE00 ≤ 3.0** under paper-relative
D50/2°.

### Acceptance & falsification

- Pass: ≥ 22 of 27 profiles meet the K ≤ 80 bound under at least one of the three
  Task-1 predictors (A3 per-λ affine baseline, D1 paper-ratio + PCA residual primary,
  B3 pool-PCA basis backup).
- Reject: > 5 of 27 profiles require K > 120 under all three predictors.

### Tests

Recorded in `docs/EXPERIMENTS.md` as rows of the form
`HXX | profile | predictor | strategy | K | medianDE00 | P95DE00 | commit`.

---

## H4 — Cross-substrate transfer (2026-05, data-driven)

Given any directed pair (reference profile A, target profile B) drawn from the 27
P9000 substrates, k ≤ 15 measurements on B (chosen via the Task-1 greedy ordering)
suffice to predict the remaining 905 − k patches of B with **median ΔE00 ≤ 1.5** and
**P95 ΔE00 ≤ 3.0** when A is fully known.

### Acceptance & falsification

- Pass: ≥ 80 % of the 27 × 26 = 702 directed pairs meet the bound under predictor D1
  (paper-ratio + PCA residual) with anchor strategy S2 (greedy uncertainty reduction).
- Reject: > 5 % of pairs require k > 30 under D1+S2.

### Tests

Leave-one-out batch under `scripts/experiments/h4_min_k_loo.ts`; results appended to
`docs/EXPERIMENTS.md` with per-pair k distribution + histogram.

---

## H5 — Low-rankness of the substrate-transform difference (2026-05, data-driven)

Across any two P9000 RGB profiles A and B (joined by common Row:Col:Page), the
per-patch reflectance difference matrix `(X_B − X_A) ∈ ℝ^{N×L}` has **effective
rank ≤ 4** — defined as the smallest r such that the rank-r truncated SVD captures
**≥ 99 % of the Frobenius energy** of `(X_B − X_A)`.

### Why it matters

If H5 holds, predictors D1 (paper-ratio + PCA residual) and B1 (PCA + diagonal
transform) are well-matched to the data; few free parameters are needed. If H5
fails, fall back to A3 (per-λ affine, 72 params) or C2/C3 (non-parametric kNN/RBF
on the ratio).

### Acceptance & falsification

- Pass: ≥ 90 % of the 351 unordered pairs satisfy rank-4 capture ≥ 99 %.
- Reject: > 10 % of pairs require rank > 6 to capture 99 %.

### Tests

`scripts/experiments/h5_rank_distribution.ts` — SVD over all pairs, output JSON
histogram of (rank required for 99 % energy) + summary in `docs/EXPERIMENTS.md`.

---

## H6 — Pool-PCA basis vs reference-only PCA basis (2026-05, data-driven)

For substrate pairs (A, B) whose paper-white delta exceeds **5 ΔE76**, the pool-PCA
predictor B3 (basis built from all 27 profiles) **outperforms** the reference-only
PCA predictor B1 (basis built from A alone) at fixed k = 15.

### Acceptance & falsification

- Pass: among the 5 pairs with the largest paper-white delta in the dataset, B3
  beats B1 by at least 0.3 in median ΔE00 on at least 4 of 5.
- Reject: B1 ≥ B3 on 3+ of 5.

### Tests

`scripts/experiments/h6_pool_vs_ref.ts`.

---

## H8 — OBA-aware D1 dominance on OBA-mismatched pairs (2026-05, data-driven)

For substrate pairs (A, B) with `oba_mismatch(A, B) ≥ 0.10` (R(440)/R(550)
score difference, see `lib/predict/oba.ts`), the D1 predictor with the default
ratio clamp `[0.3, 3.0]` **beats** the A3 per-λ affine predictor in median
ΔE00 on the held-out subset.

### Why this is non-trivial

A3 has 72 free parameters (2 per λ) and can in principle absorb arbitrary
per-wavelength offsets, including the OBA fluorescence shift at 380–440 nm.
D1 has fewer free parameters (36 ratio + low-rank residual) and its first-
order assumption (pure multiplicative substrate) is structurally wrong when
OBA differs. The hypothesis bets that D1's *structural* assumption is closer
to the physical truth than A3's *purely empirical* per-λ fit, **as long as**
the ratio clamp prevents catastrophic blow-up where the raw ratio exceeds
3× (typical in 380–390 nm for OBA-disparate pairs).

### Acceptance & falsification

- Pass: among substrate pairs with `oba_mismatch ≥ 0.10`, D1 (rank ≤ 3, clamp
  default) beats A3 by at least 0.05 in median ΔE00 on **≥ 60 %** of the
  pairs.
- Reject: D1 ties or loses on ≥ 50 % of OBA-mismatched pairs.

### Tests

First data point: 2026-05-23 row in `EXPERIMENTS.md`, DecorMatte ↔ Lyve
(both CanvasMatte, OBA mismatch 0.179). D1 wins by 0.09 ΔE00 and 2× higher
R². Need batch run over all 27 × 26 = 702 directed pairs (Phase 7) to
properly test H8.

---

## Conventions

- All ΔE values are CIEDE2000 unless explicitly tagged ΔE76.
- D50 illuminant, 2° observer everywhere.
- "Calibration patch" = a patch used to fit the model. "Test patch" = a held-out patch
  used only to evaluate.
- Train/test splits are 50/50 by patch index parity unless otherwise stated (see
  `cynsn.ts:runCYNSNComparison`).
