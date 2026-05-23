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

## Conventions

- All ΔE values are CIEDE2000 unless explicitly tagged ΔE76.
- D50 illuminant, 2° observer everywhere.
- "Calibration patch" = a patch used to fit the model. "Test patch" = a held-out patch
  used only to evaluate.
- Train/test splits are 50/50 by patch index parity unless otherwise stated (see
  `cynsn.ts:runCYNSNComparison`).
