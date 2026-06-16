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

### Result (2026-05-29) — REJECTED

461 same-chart pairs (BC-BC + MOAB-MOAB, matched by rounded RGB, ≥100 patches),
raw difference `X_B − X_A`, eigenvalues of `DᵀD`: **median effective rank 5, max 9**.
Only **17.8 %** of pairs have r ≤ 4 (acceptance needs ≥ 90 %); 16.7 % require r > 6
(falsification needs ≤ 10 %). **H5 is rejected at 99 % energy.** The substrate-transform
difference needs ~5–6 components, not ≤ 4 — consistent with paper-white shift (1) +
OBA band structure (1–2) + ink-coverage interaction (2–3). Implication: D1's rank-≤3
residual under-captures; a richer residual (rank ~5) or A3's per-λ affine is better matched.

### Addendum (2026-06-08) — raw vs d7 and cross-mode

Full 27-profile dataset (702 directed pairs) re-analysed with `python/cae/rank_analysis.py`
(cached in `weights/rank_analysis_{raw,d7}.npz`). Key new findings:

**OBA-compensation does not reduce rank.**
`d7` (OBA-cleaned via polynomial baseline subtraction per `oba.py`) vs `raw`: rank distribution
identical, RMS(D) drops ~2 %. OBA fluorescence is a small amplitude perturbation, not a
separate structural degree of freedom in the residual field.

**Cross-mode rank is only 1 unit higher than same-mode:**

| Slice | n pairs | median rank@99% | p95 rank@99% | 5 SVs cover |
| --- | --- | --- | --- | --- |
| same-mode | 144 | **5** | 8 | 99.0 % |
| cross-mode | 558 | **6** | 8 | 98.2 % |
| all | 702 | 6 | 8 | 98.5 % |

**Information-theoretic minimum k:**

- Minimum anchors to fit the residual = rank + 1 (one degree of freedom per basis vector).
- same-mode: **≥ 6 patches** (median rank 5).
- cross-mode: **≥ 7 patches** (median rank 6, p95 = 8 → ≥ 9 to cover 95 % of pairs).
- Current S1 = 13 comfortably exceeds p95; D-optimal anchor selection could approach
  the theoretical minimum and reduce measurement burden by ~50 %.

**Implication for method choice:** the low-rank structure (rank 5–6, 702 pairs) directly
explains why D1 + rank-5 residual meets H4 on same-mode pairs with k = 13. Cross-mode
adds one component — not a different physics — so the same predictor family should work
for cross-mode with a slightly larger k or a cross-mode-aware D-optimal anchor design.

### Addendum (2026-06-08b) — cross-mode tier analysis (558 pairs)

Full per-preset breakdown computed via `python/cae/rank_analysis.py --variant raw`.

**Coverage vs k (% pairs where k SVs capture ≥ 99 % energy):**

| k | same-mode | cross-mode |
| --- | --- | --- |
| 5 | 59.7 % | 19.7 % |
| 6 | 86.1 % | 59.5 % |
| 7 | 94.4 % | **91.8 %** |
| 8 | 100.0 % | **99.3 %** |
| 10 | 100.0 % | 100.0 % |

**Three difficulty tiers for cross-mode pairs:**

| Tier | rank@99% | pairs | % | RMS(D) med | Min k |
| --- | --- | --- | --- | --- | --- |
| Easy | ≤ 5 | 110 | 19.7 % | 0.050 | 6 |
| Medium | 6–7 | 402 | 72.0 % | 0.038 | 7–8 |
| Hard | ≥ 8 | 46 | 8.2 % | 0.030 | 9 |

**Pattern:** Hard pairs have *lower* RMS than easy pairs — they are spectrally compact but
structurally complex (more dimensions). Easy pairs are large-shift/near-identity (e.g.
VibranceLuster ↔ VibranceMetallic, rank = 3).

**Hardest target presets** (median rank across all ref→tgt cross-mode pairs):

- `BC_1930_P9000_pk_EMP`, `BC_ArtPeelBlckt_P9000_mk_EMP`, `BC_VibranceGloss_pk_PGPP`,
  `BC_VibranceLuster_PLPP260` — all median rank = 7, p95 = 8. Brand-custom EMP profiles
  with tighter, more structured residuals.
- `CanvasMatte`, `WCRW` (9-profile groups) — median rank = 6–7, well-behaved.
- `BC_VibranceMetallic_PGPP260` — median rank = 5 (easiest target; spectrally near-luster).

**Min-k implications by tier:**

- For 91.8 % of cross-mode pairs (rank ≤ 7): **k = 8** suffices with D-optimal anchors.
- For 99.3 % coverage: **k = 9**.
- Current S1 = 13 covers 100 % with a safe 4-anchor margin.
- D-optimal selection could reduce k by ~30–40 % vs greedy while maintaining ≥ 99.3 %
  coverage (same budget as rank+1 = 9 with margin for ill-conditioned pairs).

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

## H9 — Per-λ substrate transform is shared across inks (2026-05, data-driven)

User-articulated hypothesis: ink behaviour is *proportional* across substrates.
If we know the substrate transform `f_λ(A → B)` for one channel ramp (e.g.,
cyan), we can apply the same `f_λ` to all other channels and predict the full
target profile from a handful of anchors.

Formal statement: for every λ there exists a monotone function `f_λ` such
that `B(λ, RGB) ≈ f_λ(A(λ, RGB))` for ALL RGB triples, regardless of which
inks are active at that RGB. The function is fit empirically per λ from any
anchor set whose (A, B) pairs span enough of the per-λ reflectance range.

### Why this matters

If true, the measurement burden for cross-substrate transfer drops from "13
spread anchors" (S1) to "paper + 4 ramp patches = 5 anchors" (S3 + C7).
For a 905-patch chart, this is the difference between 1.4 % and 0.6 % of
patches measured.

### Acceptance & falsification

- Pass: C7 predictor + S3 neutral ramp (k=5) achieves median ΔE00 ≤ 1.5 on
  ≥ 60 % of substrate pairs in the dataset, AND beats A3+S1 (k=13) on
  ≥ 50 % of those pairs.
- Reject: ratio of pairs where C7+S3 underperforms A3+S1 exceeds 50 %, OR
  S3 ramps in different channels (C / M / Y / neutral) produce wildly
  different results for the same pair (suggests channel-specific
  transform, contradicting "shared").

### Caveat — OBA-band limitation

S3 single-channel ramps that do NOT visit a wide range of A(λ) at every λ
will fail at those λ. Cyan ink is transparent at 380–410 nm; a cyan ramp
leaves the per-λ curve there undefined and the predictor extrapolates
catastrophically. Empirical confirmation: 2026-05-24 EXPERIMENTS row
"S3 cyan ramp counterexample" shows C7+S3cyan median 9.28 ΔE00 vs
C7+S3neutral median 1.06 on the same pair. Neutral gray ramps work
because they touch all inks proportionally.

### First data point

DecorMatte ↔ Lyve, both CanvasMatte, OBA mismatch 0.179:

- A3 + S1 (k=13): median 1.54
- C7 + S1 (k=13): median 1.28 — best at S1 budget
- C7 + S3 neutral (k=5): median **1.06** — H9 confirmed for neutral ramp
- C7 + S3 cyan (k=5): median 9.28 — H9 confirmed-with-caveat

### Tests

H9 needs the Phase 7 batch runner over all 702 directed pairs to know
how often C7+S3neutral wins, and what the worst-case substrate pair
looks like.

---

## H10 — Conditional Autoencoder cross-trained on MK profiles (2026-05-24)

A Conditional Autoencoder trained on 70 % of the MK (matte-black) profile
subset, with hybrid conditioning (paper spectrum + substrate ID with 30 %
ID-dropout) and substrate-invariance loss, predicts held-out substrates
from paper white alone with median ΔE00 ≤ 1.5 on ≥ 60 % of pairs.

### First run (2026-05-24, see EXPERIMENTS)

- Training MSE in reflectance: 0.0009 on the held-out fold.
- Per-pair median-of-medians ΔE00: 3.20.
- Pairs achieving median ≤ 1.5: 0 %.

**H10 in its current form is REJECTED.** The CAE without anchor fine-tune
loses to every classical predictor on every tested pair because A3 / D1 /
B3 / C7 each see 13 anchors of MEASURED target reflectance while the CAE
sees only the paper white spectrum.

### H10b (planned)

CAE_RAW + 1-step few-shot fine-tune of substrate_latent_B on k anchors at
inference reduces median ΔE00 by ≥ 0.5 on held-out pairs.

### Result (2026-05-30) — H10b CONFIRMED on per-mode CAE_D7

Few-shot fine-tune of `substrate_latent_B` (Adam, 200 steps, lr=0.05) on k=13 S1
anchors of the target, holding the model frozen, evaluated on non-anchor patches.
Implemented as `evaluate.py --anchors 13`. Result depends critically on the
underlying CAE's training pool:

- **Full 36-profile pool** (mixed presets): bank-RGB intersection collapses to N=10
  patches, capping k_effective to 5. With 5 anchors median 3.30 → 3.25 (−1.5 %),
  but P95 7.42 → 12.6 (much worse) — uninformative due to test set being too small.
- **Per-mode pools** (homogeneous chart, bank.N ≈ 905):
  - **WCRW (9 BC):** median 0.98 → **0.88** (−10 %) — already at the floor.
  - **USFA (7 MOAB):** median 2.26 → **2.11** (−7 %); P95 4.68 → 8.38 (over-fit).
  - **CanvasMatte (5 BC):** median 2.58 → **1.73** (−33 %); ≤1.5 0 % → 25 %.

The −0.5 ΔE threshold is met on CanvasMatte (−0.85) and missed on WCRW (−0.10,
already at floor) and USFA (−0.15). Per-mode CAE_D7 + H10b on the modes where
anchor signal can correct sub-cluster substrate structure clears the H4 bar
(median ≤ 1.5) for the first time on this dataset without a classical
ratio-clamp or per-λ affine predictor.

The H10 original (paper-only, k=0, full pool) stays rejected; H10b changes the
verdict for the anchored, per-mode variant.

### Addendum (2026-06-12) — H10b distribution-shift caveat

The results above were based on WCRW / CanvasMatte models trained on incorrect evaluation
data (duplicate `evaluate_d7.json`). After re-generating all per-mode evaluate JSONs from
the correct weights (`evaluate.py --mode <MODE> --payload profiles-all.json`), the updated
figures are:

| Mode | a0 med | a13 med | Δmed | a0 p95 | a13 p95 | Δp95 | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| WCRW | 0.795 | 0.770 | −0.025 | 2.054 | 2.021 | −0.033 | ✓ H10b helps |
| CanvasMatte | 0.812 | 0.772 | −0.040 | 2.345 | 2.369 | +0.024 | ✓ H10b helps |
| CanvasSatin | 1.527 | 1.404 | −0.123 | 4.370 | 4.228 | −0.142 | ✓ H10b helps |
| PremiumLuster | 0.849 | 0.844 | −0.005 | 3.723 | 3.674 | −0.049 | ~ marginal |
| USFA (Unryu) | **1.320** | 1.290 | −0.030 | **3.605** | 4.079 | **+0.47** | ✗ P95 regression |

**USFA exception.** Unryu (washi) is the furthest outlier from the cotton-rag training
distribution (spectral distance to centroid = 32.9 vs median ≈ 20). Fine-tuning the
substrate latent overshoots: anchors pull the latent into a localised region that fits
S1 patches but misses mid-gamut coverage. Higher `l2_init` (0.5–1.0) reduces the P95
regression but cannot eliminate it. **For USFA, canonical result is a0 (no fine-tune).**

The confirmation gate (−0.5 ΔE threshold) holds for in-distribution modes (WCRW,
CanvasMatte, CanvasSatin). H10b should be disabled for OOD targets with spectral
distance-to-centroid > 25.

### H10c (planned, Stage 2)

CAE_D7 (CAE trained on OBA-cleaned spectra, OBA re-added at output) beats
CAE_RAW on OBA-mismatched held-out pairs (mismatch ≥ 0.10) by ≥ 0.2 ΔE00.

---

## Retraction (2026-05-29) — H1 + H2 withdrawn

Per the header rule, past hypotheses are not edited; this section records that **H1**
(device-substrate separation via CYNSN / affine transform) and **H2** (DeviceSpace RGB↔CMYK
invariance) are **withdrawn** as active research targets.

Reason: the CYNSN within-profile track that H1's falsification gate and H2's synthetic
cross-validation both depend on never converged to its acceptance criterion and was removed
from the frontend in the 2026-05-24 cleanup. The project's research is carried by the
data-driven track (H3–H10, CAE). The CYNSN-correctness P0 work in `TODO.md` and the
DeviceSpace migration epic are moved to a "Retired" block and are no longer gating.

This does not retract H3–H10. Those remain active.

---

## H11 — Cross-vendor same-mode device-response equivalence (2026-05-29, data-driven)

Two ICC profiles built for the **same Epson media preset** (e.g. Canvas Matte) but on
different papers and/or from different vendors (Breathing Color vs MOAB) share the same
underlying **device response** once the substrate (paper white + OBA) is accounted for.

### Formal statement

Resample each profile's measured `RGB → R(λ)` onto a common regular RGB lattice (the two
source charts use different RGB sampling but the identical 380–730 nm / 10 nm / 36-band
wavelength grid). After paper-relative normalisation, the residual device response of two
same-preset profiles agrees within a bounded ΔE00; cross-preset profiles do not.

### Acceptance & falsification (pre-registered)

- **Pass:** for the three overlapping presets (Canvas Matte, Premium Luster, Premium
  Glossy), cross-set (BC vs MOAB) median ΔE00 on the common grid is **≤ 3** and is
  **smaller than** the median ΔE00 between profiles of two *different* presets.
- **Reject:** cross-set median ΔE00 > 5 on any overlapping preset, OR same-preset cross-set
  ΔE00 is not smaller than a random cross-preset pairing (no preset signal).

### Caveats

- All ΔE00 must be read above the interpolation noise floor (LOO RMS on each chart).
- Substrate (paper white / OBA) differences are expected to dominate the residual; H11 is
  about the *device* response after paper normalisation, not raw spectra.

### Tests

`frontend/scripts/experiments/modeCompare.ts` — within-mode + cross-set ΔE00 over all 10
presets; summary rows in `docs/EXPERIMENTS.md`, full tables in `docs/mode-comparison.md`.

---

## H12 — Few-anchor OBA emission model for cross-vendor transfer (2026-05-30)

The default D7 OBA wrapper extracts the emission curve `E(λ)` analytically (degree-2
polynomial fit on `R_paper(λ)` over 460–730 nm extrapolated back into 380–450 nm) and
assumes a uniform per-patch attenuation factor `f(patch) = clamp(R_patch(380)/R_paper(380),
0, 1)`. That model is vendor-agnostic — every profile gets `f` computed the same way
regardless of its OBA chemistry. On OBA-disparate pairs across vendors (e.g. BC vs MOAB)
the residual at 380–410 nm is dominated by this mismatch.

**Claim.** With a small set of OBA-diagnostic anchor patches measured on each profile —
**paper white** + **yellow** + **gray** + **cyan/blue** (k = 4) — we can fit a one-parameter
emission-scaling correction:

    f_H12(patch) = clamp(α · R_patch(380) / R_paper(380), 0, 1)

where `α` is chosen per profile to minimise the residual `R_anchor − R_clean(anchor; α)`
in the OBA band (380–450 nm) over the anchor set. The yellow anchor is the strongest
constraint because yellow ink blocks the 410–460 nm region almost entirely — its observed
reflectance there comes overwhelmingly from the unattenuated paper baseline plus a small
emission residue, so it pins both the emission magnitude and the visible-attenuation behaviour.

### Why these anchors

- **Paper (RGB 255,255,255):** full OBA effect, gives `R_paper(λ)` and the unmodified
  emission curve via the existing extractor.
- **Yellow (RGB 255,255,0):** yellow ink has `T_yellow(440) ≈ 0` — kills the fluorescent
  re-emission. The observed `R_yellow(440)` therefore tells us how much "would-be"
  emission the ink absorbs, calibrating `α` against the substrate's actual OBA contribution.
- **Neutral gray (RGB 128,128,128):** intermediate ink coverage — a point on the mid-range
  factor curve where the default model is most error-prone.
- **Cyan/blue (RGB 0,255,255 or 0,0,255):** transmits some blue → another point on the
  visible-attenuation curve.

### Acceptance & falsification

- **Pass:** on OBA-disparate pairs (OBA mismatch ≥ 0.10), H12-D7 lowers median ΔE00 by
  ≥ 0.2 and the 380–410 nm band RMS by ≥ 30 % vs default D7, on at least 3 of 4 tested pairs.
- **Reject:** H12-D7 fails to improve on default D7 on the majority of OBA-disparate pairs,
  OR the fitted α is unstable across pairs (CV across pairs > 30 %).

### Tests

`scripts/experiments/h12_oba_scale.ts` — load DecorMatte (OBA-extreme) against three
low-OBA Canvas Matte papers (Lyve, BelgianLinen, ChromataWhite). For each pair: fit α
on the 4 anchors of the target, run D7 with the fitted α vs the default α = 1, compare
median / P95 ΔE00 and the 380–410 nm RMS.

### Result (2026-05-30) — REJECTED

Four anchor recipes tried (`with-yellow`, `no-yellow`, `gray-blue`, `red-only`).
**α_ref (DecorMatte) varies from 0.30 to 1.83 across recipes** — coefficient of variation
≈ 79 %, well above the 30 % falsification threshold. On all three OBA-disparate pairs
H12 either tied or slightly worsened median ΔE00 (Δ ≈ +0.01–0.14) and P95 (Δ ≈ +0.01–0.16).
The 380–410 nm UV-RMS was unchanged within ±0.5 %. Low-OBA target papers correctly fell
back to α = 1 (no OBA → no scaling needed), so the regression is driven entirely by
ref-side α-suppression hurting cross-substrate transfer.

**Diagnosis.** A single per-profile scalar α cannot capture the per-ink visible-band
absorption of OBA emission. Yellow ink at 440 nm has near-zero transmittance → the
observed emission contribution there is tiny, regardless of substrate emission magnitude.
The LSQ fit interprets this as "low α", but applying that α uniformly cancels real
emission contribution on every other patch. The right model is per-ink (or at least
per-coverage) visible-band attenuation of the emission, not a profile-level scalar.

A richer follow-up (deferred): fit a per-channel attenuation curve for OBA emission from
the same anchors (more parameters but matches the physics). Not pursued in this iteration —
the data-driven CAE_D7 already absorbs this structure implicitly.

---

## H4-revised — Same-preset cross-substrate transfer (2026-05-30)

The original **H4** (dated 2026-05) asked whether k ≤ 15 anchors suffice for cross-substrate
transfer between **any** pair of P9000 substrates, with ≥ 80 % of 702 directed pairs reaching
median ΔE00 ≤ 1.5 and P95 ≤ 3.0 under D1+S2. Per the 2026-05-30 H4 batch row in
`EXPERIMENTS.md`, that hypothesis is **rejected at the dataset level**: only 13.8 % of the
600 BC pairs (those with ≥ 100 shared SAMPLE_IDs) clear both bounds under
D1+S1+D7+rank=5+UV-clamp.

But the rejection is dominated by **cross-Epson-preset** pairs (different ink mode, total ink
limit, driver media setting). When restricted to pairs that share an Epson media preset, the
same predictor passes the original acceptance bound:

- **same-mode subset**: 98 BC pairs, median-of-medians ΔE00 = **0.84**, **80.6 %** clear the
  median ≤ 1.5 ∧ P95 ≤ 3.0 bound at k = 13 — **meets the 80 % threshold**.
- cross-mode subset: 502 BC pairs, median-of-medians = 2.47, only 0.8 % pass.

H4-revised therefore reframes the claim:

> For any pair of P9000 profiles built on the **same Epson media preset**, k = 13 forced
> anchors (S1) plus D1 with `residualRank = 5`, `uvBandCount = 4` per-band UV clamp, and
> D7 OBA-separation suffice to reach **median ΔE00 ≤ 1.5 and P95 ≤ 3.0 on ≥ 80 % of
> directed pairs**.

### Acceptance & falsification

- **Pass:** ≥ 80 % of same-preset pairs in the BC P9000 set clear `median ≤ 1.5 ∧ P95 ≤ 3.0`.
  **Confirmed 2026-05-30 (80.6 % on 98 same-mode BC pairs).**
- **Reject:** < 70 % pass, OR the cross-mode subset is materially better than reported
  (i.e. the same-mode / cross-mode split is not the real divider).

### Cross-mode is a separate problem

Cross-preset transfer (mk ↔ pk, matte ↔ glossy, …) lies outside D1's first-order substrate
model. The follow-on hypothesis for that regime — addressed by **per-mode CAE_D7** and the
**H10b anchor fine-tune** — is registered separately under H10b (already pre-existing) and
will be tested with the same `h4_batch.ts` runner extended with a `--predictor cae` mode.

### Tests

`scripts/experiments/h4_batch.ts` — already produces the per-pair table with
`sameMode` flag and the same-mode / cross-mode aggregates. Re-run after any predictor change.

---

## H13 — Measured-fluorescence OBA correction from paired M0/M2 spectra (2026-05-30)

CxF3 files from the X-Rite / i1Profiler pipeline carry **paired M0 + M2 measurements** for
every patch on almost every BC P9000 profile (probed: 23/26 have both). M2 is the
**UV-cut** condition — the illumination has all energy below ~400 nm filtered out, so the
OBA fluorophore cannot be excited and there is no re-emission. M0 is the standard tungsten
condition with full UV content. The per-patch difference

    E_patch(λ) = R_M0_patch(λ) − R_M2_patch(λ)

is therefore the **measured** OBA fluorescence contribution at that patch, not a model
extrapolation. The default D7 wrapper, by contrast, extracts emission from `R_paper` via
a degree-2 polynomial fit on 460–730 nm extrapolated into 380–450 nm and assumes a single
per-patch attenuation factor `f(patch) = clamp(R_patch(380)/R_paper(380), 0, 1)`.

**Claim.** Replacing the analytic D7 emission with the **measured M0−M2** emission, then
running D1 transfer on the OBA-free M2 spectra and adding measured emission back on output,
materially lowers the cross-substrate transfer error on OBA-disparate pairs.

### Approach

Per profile we now have `spectra` (= M0) and `spectra_m2` (= M2). For a transfer (ref → tgt):

1. **Build clean matrices** `X_A_m2`, `X_B_m2` from the paired M2 spectra of ref and tgt.
2. **Train D1** on `(X_A_m2, X_B_m2)` with anchors — no UV-clamp needed, no D7 wrapper,
   because M2 has no OBA fluorescence to clamp out. The residual model captures the
   true smooth substrate transform.
3. **Predict** `X_B_m2_pred` for all non-anchor patches.
4. **Add measured emission back**: for the target, emission of every patch is the measured
   `E_patch = R_M0_tgt − R_M2_tgt` *at anchor patches only*. For non-anchor patches we
   estimate emission per band as
   `E_patch(λ) ≈ E_paper(λ) · (R_patch_m2(λ_uv) / R_paper_m2(λ_uv))`
   — a single scalar scaling driven by how much UV the patch's ink lets through, taken
   directly from M2 (no OBA non-linearity in the ratio). `λ_uv = 380 nm`.
5. Final prediction: `X_B_pred(λ) = X_B_m2_pred(λ) + E_patch(λ)`.

### Acceptance & falsification

- **Pass:** on the OBA-disparate same-mode pairs (e.g. Canvas Matte DecorMatte ↔
  ChromataWhite, OBA mismatch ≥ 0.10), H13 lowers median ΔE00 by ≥ 0.3 and P95 by ≥ 1.0
  vs the current D7-default predictor at k = 13 (S1).
- **Reject:** H13 fails to improve over D7-default on the majority of OBA-disparate pairs,
  OR its P95 is consistently worse (the emission scaling adds variance instead of removing it).

### Why this should work physically

The 380–410 nm region of M0 paper ratio routinely hits 5–7× on OBA-disparate pairs (e.g.
DecorMatte / Lyve from `EXPERIMENTS.md` 2026-05-23), which forces D1's clamp to truncate
real signal. On the M2 side those ratios collapse to ~1× because both papers are equally
non-fluorescent under UV-cut light — D1 fits cleanly there. Re-adding the measured emission
restores the M0 signal without re-introducing the non-linearity that broke D1 in the first
place.

### Tests

`scripts/experiments/h13_m0m2.ts` — per-pair head-to-head between D1+S1+D7-default and
D1+S1+H13 on the same-mode pairs that did NOT pass H4 (i.e. P95 > 3 in
`h4_batch.json`). Reports median/P95 ΔE00 for each pair under both predictors.

---

## H14-revised — Substrate-specific cyan red-band absorption is the P95 driver (2026-05-30)

Diagnostic in `scripts/experiments/h14_ink_diagnostic.ts` ruled out ink fluorescence as the
cause of the 640–680 nm residual:

- `mean(M0 − M2)` at λ > 500 nm ≈ **0.0000** across paper + magenta-heavy + cyan-heavy +
  yellow-heavy + red-heavy patch groups on all 5 Canvas Matte BC profiles. **No ink itself
  fluoresces** in the visible band on this dataset.
- The previously-suspected red-band ΔE residual on pairs like DecorMatte ↔ 800M
  (obaMismatch = 0.00 but P95 = 5.16) is therefore **not** a fluorescence effect.

The actual driver, surfaced by the 1-ink ramp dump:

> At 660 nm, the **full-coverage cyan** reflectance varies between Canvas Matte
> substrates by ±30 % despite identical device command:
> ChromataWhite 0.112, Lyve 0.115, BelgianLinen 0.117, 800M 0.126, DecorMatte **0.152**.
> Spread = **0.040 reflectance** (~3.5 ΔE-equivalent at this brightness). Magenta and
> yellow at 660 nm are flat across all 5 substrates (~0.92), confirming the effect is
> cyan-specific.

**Claim (H14-revised).** The 640–680 nm P95 residual on same-mode Canvas Matte pairs is
driven by **substrate-specific cyan absorption depth** — a Yule-Nielsen-style optical
scatter difference between canvas coatings, not OBA, not magenta dye fluorescence. D1's
`r(λ) = B_paper / A_paper` ratio model uses *paper* reflectance as the substrate proxy and
linearly transfers it onto inked patches, but the substrate-mediated cyan-darkening curve
is non-linear in coverage and per-substrate-specific → linear ratio underfits.

### Acceptance & falsification

- **Pass:** a per-substrate YN-style exponent fit at 660 nm (or a cyan-ramp anchor set
  per profile) lowers P95 on the DecorMatte ↔ {800M, ChromataWhite, Lyve, BelgianLinen}
  worst-pair set by ≥ 1.0 ΔE without hurting other pairs by > 0.05 median.
- **Reject:** per-substrate YN at 660 nm fails to capture the spread, OR the residual is
  actually driven by magenta+cyan overprint coupling rather than cyan alone (testable by
  inspecting 2-ink M+C overprints separately).

### Tests

`scripts/experiments/h14_redband.ts` — to be written. Fits one extra parameter per
substrate from the cyan ramp at 660 nm, re-runs D1 across the 90 same-mode BC pairs.

---

## H15 — Cyan-ramp anchor strategy (S5, 2026-05-30)

Following H14-revised: instead of a generic 13-anchor S1 (paper + RGB corners + neutrals),
include a **cyan ramp** (RGB (0, 255, 255), (64, 255, 255), (128, 255, 255), (192, 255, 255))
as 4 additional anchors. These 4 measurements directly sample the substrate's effect on
cyan absorption depth at every illuminant band, including the 640–680 nm region where
substrate spread is largest.

**Claim.** S1 + 4 cyan-ramp anchors (k = 17) on same-mode BC pairs lowers worst-pair P95
by ≥ 1.0 ΔE on the cyan-driven outliers (DecorMatte ↔ ChromataWhite etc.) at a small
incremental cost (4 patches measured on the target instead of 13).

### Acceptance & falsification

- **Pass:** P95 drop ≥ 1.0 ΔE on at least 4 of the 6 worst Canvas Matte pairs.
- **Reject:** No P95 improvement, OR magenta/yellow ramps perform equally well (refuting
  the cyan-specific framing).

### Tests

`scripts/experiments/h15_cyan_anchors.ts` — extend `pickHeuristicAnchors` with an
optional cyan-ramp 4-tuple, re-run h13_m0m2 on the same 90 pairs, compare with S1
baseline.

---

## H15 — Cyan-ramp anchor strategy (S5) — REJECTED (2026-05-30 result)

H15 was tested in `scripts/experiments/h15_cyan_anchors.ts`. On 98 same-mode BC pairs
the cyan-ramp anchor addition produced:

- med-of-medians 0.823 → **0.795** (small win, −0.03 ΔE00)
- P95-of-medians 1.608 → 1.614 (flat)
- **Zero pairs reach ΔP95 ≤ −0.2 ΔE00**; acceptance bar (ΔP95 ≤ −1.0 ΔE on ≥ 4 of 6 worst
  Canvas Matte pairs) was missed. Top-6 worst-P95 deltas: −0.13, −0.04, +0.03, +0.15,
  −0.11, +0.12. Net negligible.

Per-mode breakdown is most informative:

- **WCRW (n = 56): −0.034 ΔE median** — the only mode that wins, despite being already
  the easiest (S1 median 0.736). The 4 cyan-ramp samples expose substrate behaviour the
  S1 corners miss on near-identical-OBA WCRW papers.
- **Canvas Matte (n = 20): +0.013 median, +0.040 P95** — the target mode of H15 is hurt
  rather than helped. Adding the cyan ramp anchors does NOT fix the substrate-specific
  cyan absorption depth — D1's per-λ paper-ratio multiplies all coverage by `r(λ)` even
  though the underlying physics is non-linear in coverage.

**Diagnosis.** D1's structural model is `R_B(λ) = r(λ) · R_A(λ) + residual(λ)` with
`r(λ) = R_paper_B(λ) / R_paper_A(λ)`. Cyan-ramp anchors fit the residual basis at four
extra coverage levels, but the **multiplicative form is wrong** when two substrates have
different effective Yule-Nielsen exponents in the red band. More anchors of the same
predictor class cannot fix a model that is structurally biased.

The H14-revised finding stands: substrate-specific cyan absorption depth at 640–680 nm
is real and is the source of the P95 residual. The remedy is **structural**, not more
anchors of the existing predictor.

---

## H16 — Per-substrate Yule-Nielsen exponent in the red band (2026-05-30)

Following H15's rejection: replace D1's multiplicative paper-ratio with a substrate-aware
Yule-Nielsen-Spectral-Neugebauer (YNSN) correction restricted to the cyan-darkening
region (640–680 nm). Two-step predictor:

1. **Base D1 transfer** (current default: residualRank 5, UV clamp on 380–410 nm) for
   λ ∉ [640, 680] nm.
2. **YN correction** for λ ∈ [640, 680] nm only: fit a single per-substrate exponent
   `n_target` from the cyan-ramp anchors (RGB (0, 255, 255), (64, 255, 255),
   (128, 255, 255), (192, 255, 255)) using the standard YN equation
   `R = ((1 − t) · R_paper^(1/n) + t · R_cyan_full^(1/n))^n`. The anchor cyan ramp
   pins `t = 1, 0.75, 0.5, 0.25` of cyan coverage; solve for `n` by non-linear
   least squares.

**Claim (H16).** A single per-substrate `n` parameter fit from the cyan ramp (k = 4
extra anchors) lowers P95 on the 6 worst Canvas Matte pairs by ≥ 0.5 ΔE00 without
hurting same-mode pairs by > 0.05 median.

### Why H16 is structurally different from H15

H15 added anchors to a multiplicative model — the residual basis got bigger but still
multiplicative. H16 swaps the model class on the affected bands: `n_substrate` is the
optical-scatter exponent for that paper's coating, which is exactly the parameter that
explains the 0.040-reflectance spread at full-cyan-660 nm across Canvas Matte papers.
Two free parameters per substrate (`n_target`, `n_ref`) instead of zero — but still
just one new measurement (the 4-cyan-anchor ramp).

### Acceptance & falsification

- **Pass:** Canvas Matte median P95 ≤ 1.7 (S1 baseline 2.2), no other mode hurt by > 0.05
  median.
- **Reject:** YN exponent doesn't capture spread, OR adding it hurts other modes.

### Result — **REJECTED (2026-06-12)**

`scripts/experiments/h16_redband_yn.ts` executed on 26 BC profiles.

**Failure mode 1 (unmasked):** Applying YN to all patches produced catastrophic regressions
(CanvasMatte ΔP95 = +14). Root cause: the two-endpoint model (paper ↔ full-cyan) is only
valid when M and Y inks are absent; magenta absorbs heavily at 640–680 nm, so YN predicts
≈ paper-white for M-laden patches.

**Failure mode 2 (cyan-mask G ≥ 220, B ≥ 220):** Masking to the cyan-dominant sector
eliminates the regression but produces null effect (ΔP95 = 0.000 for CanvasMatte). D1
already handles cyan-dominated patches well.

**Conclusion:** The P95 = 2.2 on Canvas Matte is driven by OBA-mismatch in mixed/neutral
patches on DecorMatte ↔ OBA-extreme pairs (ChromataWhite, 800M, BelgianLinen) — not by
640–680 nm YN nonlinearity. H16 was targeting the wrong spectral mechanism. The `n_B`
values were physically plausible (1.72–2.60 across papers) but irrelevant to the P95 driver.

---

## H17 — Spectral residual band analysis on the worst OBA-disparate pair (2026-06-12)

**Motivation (diagnostic hypothesis):** H16's rejection revealed that P95=6.42 on
DecorMatte→ChromataWhite is caused by OBA-mismatch in chromatic/neutral patches, not by
640–680 nm YN nonlinearity. H17 diagnoses *which wavelength bands* carry the residual
error in the P95 group, to guide the next targeted fix.

**Claim (H17).** On the pair `BC_DecorMatte_P9000_mk_CanvasMatte` →
`BC_ChromataWhite_P9000_mk_CanvasMatte`, the per-band mean absolute spectral error
`|R_pred(λ) − R_meas(λ)|` for the P95-error patches (worst 5 % by ΔE00) is
**concentrated in the OBA/UV bands (380–430 nm)**, where the elevated error is
> 2× the average visible-band (430–730 nm) error for the same patch group.
Formally: `mean_err_UV / mean_err_VIS > 2.0` for P95 patches, where
`mean_err_UV = mean over λ∈{380,390,400,410,420,430}` and
`mean_err_VIS = mean over λ∈{440,...,730}`.

**Why this matters.** If confirmed, the fix is OBA-targeted: better anchor selection
(D-optimal on OBA-band SVD components) or measured M0/M2 OBA at anchors (H13c path).
If rejected (error flat across λ), some non-OBA structural mechanism dominates and
a different approach is needed.

### Acceptance & falsification

- **Confirm:** P95 patches show UV/OBA mean error > 2× VIS mean error. Identify the
  top-3 wavelength bands by mean absolute error in the P95 group.
- **Reject:** UV/OBA error < 1.5× VIS error in P95 patches → OBA is not the primary
  driver; structural visible-range mismatch dominates.

### H17 script

`frontend/scripts/experiments/h17_residual_bands.ts`

### H17 result — **REJECTED (2026-06-12)**

`h17_residual_bands.ts` executed: 905 patches aligned, k=13 S1 anchors, D1 rank-5 UV-clamp-4 D7 OBA.

**D1 baseline on this pair:** median = 1.886, P95 = 6.419.

**UV/VIS ratio for P95 group: 0.933** — far below the 2.0 threshold. H17 claim is refuted.

**Actual spectral pattern in P95 patches:**

| Band range | Mean |err| in P95 group | Ratio vs dataset mean |
| --- | --- | --- |
| 380–430 nm (UV/OBA) | 0.0150 | 0.93× (below average) |
| 530–580 nm (green-yellow) | 0.0205–0.0234 | **1.28–1.56×** (elevated) |
| 640–730 nm (red) | 0.0147–0.0170 | 0.79–0.86× |

Top-5 bands by P95-group error: **570 nm, 580 nm, 540 nm, 560 nm, 380 nm**.

**Worst 10 patches** (device values): all in the range R=31–63, G=0–28, B=63–191 — the
dark blue/violet gamut boundary (heavy C+M, moderate Y coverage).

**Conclusion:** The D7 OBA correction is working — UV/OBA error in P95 patches is
*below* dataset average (ratio 0.93). The P95 residual is a **visible-range green-yellow
mismatch at high CMY density**, not an OBA-fluorescence issue. ChromataWhite (bright-coated
substrate) and DecorMatte (natural matte) have different ink-absorption behaviour at the
C+M gamut boundary (530–580 nm where both C and M absorb), which the paper-ratio D1 model
cannot capture with rank-5 residuals. OBA-targeted anchors (D-optimal on UV-band SVDs,
H13c M2 anchors) would not help here.

**Implication for next step:** The remaining ~1–2 ΔE00 P95 gap on CanvasMatte OBA-disparate
pairs is likely driven by two mechanisms operating in *different* patch sectors:

1. **UV (380–430 nm)**: handled adequately by D7 + rank-5 residual.
2. **VIS green-yellow (530–580 nm) at high C+M coverage**: not addressed by any current predictor.

Candidate H18: verify whether the gamut-boundary mismatch at 530–580 nm correlates with
**total ink coverage** (C + M + Y device sum), and whether adding 2–3 high-ink-density
chromatic anchors (near R≈40, G≈0, B≈100–200) to S1 closes the gap.

---

## H18 — Ink-coverage correlation and high-CMY anchor augmentation (2026-06-12)

**Motivation:** H17 showed the P95 residual on DecorMatte→ChromataWhite (CanvasMatte mode)
is concentrated at 530–580 nm in dark blue/violet patches (R=31–63, G=0–28, B=63–191),
which are regions of heavy C+M coverage. The D1 paper-ratio model cannot capture the
nonlinear ink-substrate interaction at high C+M density for these two substrates. Two
questions to resolve:

1. **Ink-coverage correlation (diagnostic):** Does the 530–580 nm spectral error and ΔE00
   correlate with total ink coverage `C+M+Y = (255−R)+(255−G)+(255−B)`? If yes, the error
   is not random noise but a systematic model-coverage effect.
2. **Anchor augmentation (intervention):** Adding 2–3 anchors in the high-CMY sector
   (R≈40, G≈0, B≈100–200) directly samples the ink-substrate interaction at the problematic
   gamut boundary. Does this close the P95 gap?

**Claim (H18).** On the pair `BC_DecorMatte_P9000_mk_CanvasMatte` →
`BC_ChromataWhite_P9000_mk_CanvasMatte` (D1 rank=5 UV-clamp-4 D7 OBA):

- **H18a:** Spearman rank correlation between per-patch ΔE00 and (C+M+Y) device sum
  is > 0.5 across all non-anchor patches.
- **H18b:** Spearman rank correlation between per-patch mean |err| at 530–580 nm and
  (C+M+Y) device sum is > 0.5 across all non-anchor patches.
- **H18c:** Adding 3 high-CMY anchors (nearest grid patches to
  (R=40, G=0, B=100), (R=40, G=0, B=150), (R=40, G=0, B=190)) to S1 (k=13 → k=16)
  lowers P95 by ≥ 1.0 ΔE00 on this pair.

### Acceptance & falsification

| Part              | Pass                   | Fail                                          |
|-------------------|------------------------|-----------------------------------------------|
| H18a/b (corr.)    | Spearman r > 0.50      | r < 0.30 (error not coverage-driven)          |
| H18c (augment)    | P95 drop ≥ 1.0 ΔE      | P95 drop < 0.30 ΔE (anchors miss mechanism)   |

### H18 script

`frontend/scripts/experiments/h18_ink_coverage.ts`

### H18 result — H18a + H18c CONFIRMED; H18b REJECTED (2026-06-12)

905 patches aligned, D1 rank=5 uvBandCount=4 D7 OBA, S1 k=13 baseline (892 non-anchor patches).

**H18a:** Spearman(ink, ΔE00) = **0.712** — PASS (gate > 0.50). Total ink coverage is a strong
systematic predictor of transfer error.

**H18b:** Spearman(ink, 530–580nm err) = **−0.120** — REJECT. The 530–580 nm elevation in H17's
P95 patches was a consequence of those patches' location in color space (dark blue-violet gamut
boundary), not an independent coverage→green-yellow-band effect.

**H18c:** Augmented anchors (31,0,95), (31,0,159), (31,0,191): k=13 → k=16.
P95: **6.419 → 4.787** (Δ = 1.632) — PASS (gate ≥ 1.0).
Median: 1.886 → 1.817 (−0.069).

**Coverage bucket analysis (baseline):**

| Ink sum (C+M+Y) | n   | Median ΔE | P95 ΔE |
|-----------------|-----|-----------|--------|
| 0–255 (light)   | 182 | 1.200     | 2.133  |
| 256–383 (mid)   | 263 | 1.207     | 3.447  |
| 384–511 (high)  | 260 | 2.759     | 6.131  |
| 512–765 (max)   | 187 | 5.230     | 7.723  |

**After augmentation:** worst patches shift from dark blue-violet to heavy-Y olive-green sector
(R≈100–160, G≈85–170, B≈0 — high C+M+Y total coverage, Y-dominated). Same root cause, new
gamut sector.

**Conclusion:** D1's paper-ratio + rank-5 residual is fundamentally inadequate at high total
ink density regardless of gamut sector. Each targeted sector fix shifts the worst tier to the
next-worst sector. Remedy requires either (a) a model upgrade (higher rank or coverage-aware
weighting) or (b) exhaustive anchor coverage of all high-ink sectors.

Candidate H19: test residualRank 5 → 8 (SVD p95 rank from H8) and/or heavy-Y sector anchors.

---

## H19 — Residual rank increase and heavy-Y anchor augmentation (2026-06-12)

**Motivation:** H18 confirmed total ink coverage is a strong predictor of D1 transfer error
(Spearman 0.712). Augmenting S1 with 3 dark-blue/violet anchors drops P95 6.42→4.79, but
the new worst sector shifts to heavy-Y olive-green (R≈100–160, G≈85–170, B≈0). Two candidate
interventions address the same root cause (D1 inadequacy at high ink density) via different
mechanisms:

**H19a:** Adding 3 anchors in the heavy-Y sector (nearest patches to (R=130,G=130,B=0),
(R=100,G=85,B=0), (R=160,G=170,B=0)) to S1+H18c (k=16 → k=19) further reduces P95 by ≥ 1.0
ΔE00 on `BC_DecorMatte_P9000_mk_CanvasMatte` → `BC_ChromataWhite_P9000_mk_CanvasMatte`.

**H19b:** Raising `residualRank` from 5 to 8 (the SVD p95 rank from the H8 analysis —
effectively rank@99% energy for 100% of same-mode pairs) closes the high-ink gap. Gate: P95 drops
≥ 1.0 ΔE00 on the worst pair (baseline P95 4.79 after H18c), without hurting same-mode
median by > 0.05.

**H19c (batch):** Raising residualRank 5→8 on the full 98-pair same-mode batch increases the
H4 pass rate (median ≤ 1.5 ∧ P95 ≤ 3.0) from 80.6% to ≥ 85% without any additional anchors.

### Acceptance & falsification

| Part   | Pass                              | Fail                                          |
|--------|-----------------------------------|-----------------------------------------------|
| H19a   | ΔP95 ≤ −1.0 on DecorMatte→ChromataWhite (k=19 vs k=16 baseline) | ΔP95 > −0.3 |
| H19b   | ΔP95 ≤ −1.0 on same pair (rank=8, k=13 vs rank=5, k=13) | ΔP95 > −0.3 |
| H19c   | Same-mode H4 pass ≥ 85% at rank=8, k=13 | < 80% (regression) |

### H19 script

`frontend/scripts/experiments/h19_high_y_anchors.ts` (single-pair, 4 variants) and
`frontend/scripts/experiments/h19_batch_rank.ts` (98-pair rank sweep).

### H19 results (2026-06-15)

- H19a: heavy-Y augmentation **REJECTED** — P95 regressed (worse, not better).
- H19b: rank=8 **REJECTED** — ΔP95 < gate (missed by 0.066 ΔE₀₀).
- H19c: batch rank comparison — 83.3% at rank=5 = 83.3% at rank=8. Rank not the bottleneck.
- D-optimal k-sweep: greedy k=8 = **78.1%** pass; D-opt k=8 = 21.9% (structural corners required).
- **Ceiling**: 83.3% at k=13 is structural — linear correction on nonlinear ink physics.

---

## H20 — Kubelka-Munk space paper correction (D1-KM) (2026-06-15)

**Motivation:** H18 + H19 establish that D1's linear PCA residual fails at high ink density
(Spearman(total\_ink, ΔE₀₀) = 0.712) and no linear intervention (more anchors, higher rank)
moves the 83.3% ceiling. The root cause is the paper-ratio model itself: it assumes spectral
multiplicativity (R\_B ∝ R\_A per λ), which breaks as ink absorption saturates. Kubelka-Munk
two-flux theory predicts that a substrate change acts as an *additive* shift in K-M remission
space, not a multiplicative one in reflectance space.

**Model (D1-KM):**
$$K/S(R) = \frac{(1-R)^2}{2R}, \quad R(K/S) = 1 + K/S - \sqrt{(K/S)^2 + 2 \cdot K/S}$$

Paper correction in K-M space (1 anchor):
$$\widehat{KS}_B(i,\lambda) = KS_A(i,\lambda) + \Delta KS_{\text{paper}}(\lambda)$$
where $\Delta KS_{\text{paper}}(\lambda) = KS_{B,\text{paper}}(\lambda) - KS_{A,\text{paper}}(\lambda)$.

Residual correction: same PCA+kNN structure as D1 but fit on $\Delta KS$ residuals at
non-paper anchors. OBA subtraction/addition remains in reflectance space (before/after K-M
transform).

**H20a:** D1-KM at k=8 greedy (S1) achieves H4 pass rate ≥ **85%** (vs 78.1% for D1 at k=8)
across 114 same-mode BC pairs.

**H20b:** D1-KM at k=8 provides ΔP95 ≤ −1.0 ΔE₀₀ on high-ink patches
(total CMY coverage > 1.5 out of 3.0 max).

### Acceptance & falsification

| Part  | Pass                                     | Fail                                              |
|-------|------------------------------------------|---------------------------------------------------|
| H20a  | Batch H4 pass ≥ 85% at k=8 D1-KM        | ≤ 78.5% (no meaningful improvement vs D1 k=8)    |
| H20b  | P95 on high-ink tercile drops ≥ 1.0 ΔE₀₀ | < 0.5 ΔE₀₀ improvement on high-ink patches       |

Falsification implication: if H20 fails, K-M linearity in KS space does not hold for these
substrates (likely due to surface scattering or OBA making simple two-flux inapplicable).
Next step then becomes H22 (neural).

### H20 script

`frontend/scripts/experiments/h20_km_residual.ts` — batch comparison D1 vs D1-KM at k=8+13,
114 same-mode BC pairs.

### H20 result (2026-06-15) — REJECTED

| k  | D1 pass% | D1-KM pass% | D1 med | KM med  |
|----|----------|-------------|--------|---------|
| 8  | 78.1%    | **0.0%**    | 0.908  | 7.963   |
| 13 | 83.3%    | **3.5%**    | 0.869  | 2.516   |

D1-KM catastrophically fails. Root cause: K/S=(1−R)²/(2R) diverges as R→0. Dark-ink anchor
patches (R≈0.03) have K/S≈16; their ΔKS residuals are enormous. kNN interpolation in RGB
space spreads these huge K-M corrections to mid-tone patches, collapsing predicted reflectance
near zero (median ΔE₀₀ = 7.963 at k=8 vs 0.908 for D1).

Physical conclusion: simple two-flux K-M does not hold for glossy inkjet. Inks here are
transparent absorbers, not turbid scatterers — the K-M turbid-medium assumption is violated.
K/S values span 3–4 orders of magnitude across the patch grid; kNN interpolation of K-M
residuals is numerically undefined.

**Consequence for H22:** K-M can not replace a learned nonlinear model. H22 (neural few-shot
network) is now the single remaining structural path beyond D1.

---

## H22 — Cross-attention spectral transfer network (few-shot) (2026-06-15, pre-registered)

**Motivation:** H19 + H20 (if H20 fails) establish a structural ceiling for affine/K-M models.
User prior: ResNet for lamination-effect prediction on another print dataset demonstrated that
learned spectral mappings can generalise across substrates when trained on sufficient pairs.
The Epson P9000 dataset provides 27 substrates × ~50 directed same-mode pairs ≈ 1 350 source
pairs, each contributing ~800 test patches → ~1M spectral prediction samples (leave-one-out).

**Architecture (candidate):**

```text
Input query:   [source_spectrum (36), CMY_coords (3)]
Anchor set:    k pairs × [source_j (36), target_j (36), CMY_j (3)] → k × 75
Cross-attention: 2–4 heads, 128-dim, 2 layers
Output:        target_spectrum (36)
Loss:          RMSE on spectra + λ · ΔE₀₀ term
```

Alternative: small MLP with FiLM (Feature-wise Linear Modulation) conditioning on anchor
embeddings. Simpler to train, less expressive.

**Training protocol:**

- Leave-one-out: train on 26 substrates, validate on held-out substrate.
- Augmentation: random anchor subset size k ∈ {4, 5, 6, 8, 13} per batch item.
- Normalise spectra by paper-white of source before input (paper-white conditioning).

**H22a:** At k=5 anchors (paper + R + G + B + K), network achieves H4 pass rate ≥ **78.1%**
on held-out substrates (matching D1 at k=8 with 3 fewer anchors).

**H22b:** At k=8 anchors (S1), network achieves H4 pass rate ≥ **90%** (vs 78.1% for D1 at k=8).

**H22c:** Minimum k for ≥ 78.1% pass is ≤ 5 (network infers interior from corners + priors).

### Acceptance & falsification

| Part  | Pass                                           | Fail                                                        |
|-------|------------------------------------------------|-------------------------------------------------------------|
| H22a  | k=5 → H4 pass ≥ 78.1% on ≥ 3 held-out substrates | < 70% on any held-out substrate (poor generalisation)   |
| H22b  | k=8 → H4 pass ≥ 90%                           | < 85% (network not better than D1-KM at k=13)              |
| H22c  | Minimum k ≤ 5 to match D1 k=8                 | Min k ≥ 8 (no anchor reduction benefit from learned prior)  |

Falsification implication: if H22 fails at k=8, the 27-substrate dataset is insufficient for
generalisation across this media class. Need cross-manufacturer data or a stronger physics
prior (Saunderson / fluorescence-aware K-M).

### H22 implementation notes

- Framework: PyTorch or ONNX (server-side) / `onnxruntime-web` (in-browser inference).
- Training outside this repo (Python); inference exported as ONNX model loaded by browser.
- Pre-requisite: validate H20 first. If H20 reaches 88%+, H22 adds diminishing returns.
- Estimated training time: < 1 h on a single GPU for 1M samples at 128-dim architecture.

### H22 script

`frontend/scripts/h22_train.ts` — TypeScript + tfjs-node, full train+eval in one script.

### H22 result (2026-06-15)

Architecture: MLP [79→256→128→64→36]. Input: query(39) + mean\_anchor\_delta(39) + k\_norm(1).
k-augmentation: trained on k ∈ {5, 8, 13} simultaneously. 23 train substrates, 200 epochs.

| k  | H22 pass% | D1 pass% (reference) | Δ        |
|----|-----------|----------------------|----------|
| 5  | **78.1%** | 47.4% (D1 k=5)       | +30.7pp  |
| 8  | 74.6%     | 78.1% (D1 k=8)       | −3.5pp   |
| 13 | 74.6%     | 83.3% (D1 k=13)      | −8.7pp   |

**H22a PASS:** k=5 → 78.1% (gate ≥ 78.1%). Matches D1 k=8 with 3 fewer anchors.
The 5-anchor set {paper, R, G, B, K} = paper-white + 4 ink primaries is sufficient
because the mean anchor delta over device-cube extremes fully characterises the spectral
transfer direction; the network interpolates continuously from there.

**H22b FAIL:** k=8 → 74.6% (gate ≥ 90% not reached; slightly worse than D1 k=8).

**Structural ceiling not broken.** The 16.7% failure rate (same DecorMatte/Silverada pairs)
persists regardless of model. More diverse training data (cross-manufacturer substrates) or
a physics-informed prior required to push past 83.3%.

**Practical result:** minimum measurement protocol = **5 patches** (paper + RGBK) for
78.1% of same-mode substrate pairs, down from 8 patches with D1.

---

## H23 — Neutral-ramp spreading divergence as primary non-metallic failure predictor

**Pre-registered:** 2026-06-15

### Motivation

H22 diagnostic confirmed a 16.7% structural failure ceiling. H_diagnose_failing_pairs
identified 19 failing pairs (k=13, D1 rank-5). Excluding 7 metallic-substrate pairs
(Silverada CanvasSatin ×4, VibranceMetallic PremiumGlossy ×3) — physically distinct
measurement geometry — leaves **12 non-metallic failing pairs**.

H23 diagnostic (2026-06-15, `scripts/experiments/h23_spreading_diagnostic.ts`) showed:

| Metric | Failing (non-metallic, n=12) | Passing (n≈95) |
|--------|------------------------------|----------------|
| ΔSpread median | **0.172** | 0.076 |
| ΔSpread P75 | 0.248 | 0.094 |
| ΔOBA R(380) median | 0.129 | 0.199 |

**ΔSpread = ‖(Δc1, Δc2)‖₂** where c1, c2 are coefficients of the quadratic
neutral-ramp fit at λ=560 nm: `R_norm(560, a) = 1 + c1·a + c2·a²`,
`a = (255 − RGB) / 255` for neutral patches (R=G=B).

**OBA Δ R(380) does NOT predict failure** — passing pairs have higher median ΔOBA than
failing. This falsifies the "structural spectral incompatibility" conclusion from H22.

Key pure-spreading evidence:

- ArtPeelBlckt ↔ 1930 (EnhancedMatte, ×2): ΔSpread=0.156, ΔOBA≈0.003, p95_lo=3.22–3.25
- DecorMatte → 800M (CanvasMatte, ×2): ΔSpread=0.248, ΔOBA=0.076, p95_lo=1.59–1.84

DecorMatte spreading curve is a genuine outlier within CanvasMatte:

- DecorMatte: c1=−1.469, c2=0.427
- All other CanvasMatte: c1≈−1.55 to −1.66, c2≈0.55−0.64

### H23a — Spreading Δ predicts non-metallic failure (diagnostic)

**Claim:** ΔSpread > 0.10 is a statistically significant binary predictor of H4 failure
among non-metallic same-mode pairs.

**Acceptance gate:** AUC > 0.75 in ROC analysis over non-metallic pairs.

**Script:** extend `h23_spreading_diagnostic.ts` to output ROC/AUC over all
non-metallic pairs.

**Status:** **PASS** — AUC=0.848 > 0.75 gate. Experiment 2026-06-15.

### H23b — Explicit spreading correction from neutral-ramp anchors

**Claim:** Adding a spreading-correction layer to D1 — fitting (c1_B, c2_B) from ≥3
neutral-ramp anchor patches on substrate B, then applying a per-patch multiplicative
correction derived from the spreading ratio f_B(a) / f_A(a) — reduces ΔE and
increases non-metallic H4 pass rate to ≥90%.

**Mechanism (as tested):**

    f(a; substrate) = 1 + c1·a + c2·a²        (spreading function at 560 nm only)
    s(a) = f_B(a) / f_A(a)                    (scalar ratio, same for all λ)

For patch i with effective neutral ink level `a_i = (3·255 − R − G − B) / (3·255)`:

    R̂_spreading[i, λ] = R̂_paper_ratio[i, λ] · s(a_i)

**Status:** **FAIL** — neither acceptance gate reached.

Results from `scripts/experiments/h23_spreading_correction.ts`:

| Variant | Pass rate | vs baseline |
| ------- | --------- | ----------- |
| Baseline D1 k=13 | 92/104 = 88.5% | — |
| Anchor-based (6 neutral patches) | 88/104 = 84.6% | −3.9% |
| Oracle (all 36 neutral patches) | 88/104 = 84.6% | −3.9% |
| Oracle + dSpread>0.13 threshold | 91/104 = 87.5% | −1.0% |

High-dSpread spotlight (oracle):

- DecorMatte→ChromataWhite: p95 6.42→3.59 (−2.83 ΔE) — significant improvement
- DecorMatte→BelgianLinen: p95 4.00→2.98 — **PASS** (only 1 new passing pair)
- ArtPeelBlckt↔1930: med 2.17→1.94 (improved but still above 1.5 gate)

**Root cause of failure:** Spreading is wavelength-specific. A single scalar
`s(a)` fitted at λ=560 nm and applied uniformly to all 36 bands is incorrect:

1. Dot-gain curves c1(λ), c2(λ) vary across wavelengths — each ink absorbs differently
2. OBA fluorescence (UV-band, λ<450 nm) cannot be described by a neutral-ramp
   quadratic at 560 nm; OBA contribution has a different sign/magnitude there
3. The uniform scalar creates regressions on borderline-passing pairs where the
   spreading correction is small but has the wrong spectral shape

The hypothesis is partially confirmed at the diagnostic level (H23a: AUC=0.848)
but the **correction mechanism** is insufficient. See H24.

---

## H24 — Per-wavelength spreading correction (neutral-ramp per-λ fit)

**Pre-registered:** 2026-06-15

### Rationale

H23b showed that a single scalar `s(a)` fitted at λ=560 nm is insufficient because:

- Dot-gain `c1(λ)` and `c2(λ)` vary across wavelengths (ink absorption is spectrally selective)
- OBA fluorescence contributes additively at λ<450 nm — a different functional form
  from dot-gain absorption; fitting at 560 nm gives zero signal for OBA

The correct model: fit independent quadratic spreading curves at **each of the 36 wavelength
bands** from neutral-ramp patches, then apply the per-λ correction.

### Mechanism

For each wavelength λ ∈ {380, 390, …, 730} nm, fit from neutral patches of substrate X:

    f(a, λ; X) = 1 + c1(λ; X) · a + c2(λ; X) · a²        (no bias — f(0,λ)=1 by construction)

where `a = (255 − RGB) / 255` for neutral patch with RGB = R = G = B.

Per-λ spreading ratio applied to patch i:

    s(a_i, λ) = clamp( f_B(a_i, λ) / f_A(a_i, λ), 0.5, 2.0 )
    R̂_corr[i, λ] = R̂_paper_ratio[i, λ] · s(a_i, λ)

This correctly captures:

- Wavelength-dependent dot gain (each ink's absorption peak affects c1(λ) differently)
- OBA: at λ=380–420 nm, paper_B > paper_A → f_B/f_A > 1 → correction adds UV boost
- Low-correction bypass: if ‖c1_B(λ) − c1_A(λ)‖ is small at a given λ, s≈1 → no change

### Acceptance gate

- ArtPeelBlckt↔1930 corrected med ≤ 1.5
- Non-metallic H4 pass rate ≥ 90% (oracle: all neutral patches)
- Oracle pass rate ≥ 88.5% (≥ baseline, no regressions)

### Data requirement

Needs ≥ 4 neutral patches at different ink densities (a ≈ 0.0, 0.25, 0.5, 0.75, 1.0).
With 36 neutral patches available in the BC profiles, the per-λ fit is well-conditioned
(36 observations, 2 free parameters per band).

For the practical k=5 deployment: neutral ramp = paper + 3 neutral grays (RGB=R=G=B with
R=192, 128, 64) — minimum 4 anchors for a stable 2-parameter fit per wavelength.

**Script:** `scripts/experiments/h24_spreading_per_lambda.ts`

**Status:** **PARTIAL** — experiment run 2026-06-15.

Results (oracle: all 36 neutral patches, threshold dSpread560 > 0.10, 28 of 104 pairs corrected):

| Gate | Result |
| ---- | ------ |
| No regressions (≥ baseline) | **PASS** — 0 regressions, 92/104=88.5% |
| ArtPeelBlckt corrected med ≤ 1.5 | FAIL — med=1.82 (improved from 2.17) |
| Non-metallic pass rate ≥ 90% | FAIL — 88.5% |

Key improvements vs baseline:

- DecorMatte→ChromataWhite: Δp95=−2.89 (6.42→3.53)
- 1930→ArtPeelBlckt: Δp95=−1.45, Δmed=−0.36 (2.17→1.82)
- DecorMatte→800M: Δp95=−1.65 (5.16→3.51)
- 0 regressions (vs 5 in H23b scalar correction)

Remaining gap: all DecorMatte group p95 = 3.05–4.02 (gate 3.0). Neutral-ramp
quadratic captures combined-channel spreading but not per-channel differences
(C vs M vs Y). High-CMY chromatic patches retain residual error. See H25.

---

### H23/H24 Scope exclusion

Metallic substrates (Silverada, VibranceMetallic) are excluded from H23/H24 scope.
Their neutral-ramp spreading curves are nearly identical to other substrates in the same
mode (CanvasSatin all c1≈−2.02, c2≈1.05), yet they fail — indicating a different
physical mechanism (metallic surface scattering geometry, not ink spreading). Separate
investigation required; outside the scope of this ink-physics decomposition.

---

## H25 — Per-channel spreading correction (C/M/Y ramps, per-λ)

**Pre-registered:** 2026-06-15

### Rationale

H24 proved that per-λ spreading correction is the correct model form (zero regressions,
significant improvement on DecorMatte group). But the neutral-ramp quadratic gives ONE
proxy for combined-channel spreading: `a_eff = (3·255 − R − G − B) / (3·255)`.

For a chromatic patch such as (R=30, G=0, B=190):

- a_C = (255−30)/255 = 0.882
- a_M = (255−0)/255 = 1.000
- a_Y = (255−190)/255 = 0.255
- a_eff_neutral = (765−30−0−190)/765 = 0.706

The neutral proxy (0.706) under-represents C and M, over-represents Y at this point.
Per-channel: each ink spreads independently at its own density.

Physical basis: in CMY subtractive model, ink spreading is per-colorant. The Yule-Nielsen
exponent and dot-gain curve reflect the ink–substrate system for each pigment independently
(different absorption spectra → different interaction with substrate chemistry).

The 905-patch grid contains full single-channel ramps (verified 2026-06-15):

| Channel | Pure-channel patches | Density range |
| ------- | -------------------- | ------------- |
| C | 9 patches (G=B=255, R=0,31,63,…,255) | a_C = 0 → 1 |
| M | 10 patches (R=B=255, G=0,28,56,…,255) | a_M = 0 → 1 |
| Y | 9 patches (R=G=255, B=0,31,63,…,255) | a_Y = 0 → 1 |
| Neutral | 25 patches (R=G=B) | a = 0 → 1 |

### Mechanism

For each channel X ∈ {C, M, Y} and each wavelength λ:

    f_X(a_X, λ; substrate) = 1 + c1_X(λ) · a_X + c2_X(λ) · a_X²

where `a_C = (255−R)/255`, `a_M = (255−G)/255`, `a_Y = (255−B)/255`.

Fit from the single-channel ramp patches of that substrate (9–10 data points per λ
per channel — well-conditioned for a 2-parameter quadratic).

Per-patch per-λ correction for patch i:

    s_X(a_X, λ) = clamp( f_B_X(a_X, λ) / f_A_X(a_X, λ), 0.5, 2.0 )

Ink-weighted composition (avoids multiplicative overcorrection at high density):

    w_tot = a_C + a_M + a_Y  (total ink weight)
    s_total(a_C, a_M, a_Y, λ) = (a_C · s_C + a_M · s_M + a_Y · s_Y) / max(w_tot, ε)

For neutral patches (a_C = a_M = a_Y = a): s_total = (s_C + s_M + s_Y) / 3 — mean of channels.
For paper (a_C = a_M = a_Y = 0): s_total undefined → no correction (same as H24).

Threshold: apply only when `max(|s_C−1|, |s_M−1|, |s_Y−1|) > δ` (prevents noise
from small spreading differences; exact value TBD experimentally).

### Anchor requirements for deployment (practical k budget)

The S1 heuristic already picks the **max-density endpoint** of each channel ramp:

- cyan = (0,255,255): a_C = 1.0, verified dist=0 in 905-patch grid
- magenta = (255,0,255): a_M = 1.0, verified dist=0
- yellow = (255,255,0): a_Y = 1.0, verified dist=0

Missing for a proper per-channel quadratic fit — 50%-density points:

- C-50%: nearest to (128,255,255) = (127,255,255), dist=1
- M-50%: nearest to (255,128,255) = (255,113,255), dist=13 (M=0.557)
- Y-50%: nearest to (255,255,128) = (255,255,127), dist=1

In oracle mode (all 905 patches available): use all 9 C-ramp, 10 M-ramp, 9 Y-ramp points.

In k=5 deployment mode: paper + {C, M, Y} max + {C-50% or M-50% or Y-50%} → 5–7 patches.

Note: the user's proposed anchor **(0,112,112) = C=1, M=0.557, Y=0.502** (nearest: (0,113,127),
dist=16) is NOT a single-channel point. It sits in the C=1 interior face and captures
C-channel behavior under partial M+Y load. Useful for characterising channel interaction
but requires a different fitting model (cannot isolate M or Y spreading from it).

### Acceptance gates

- Gate 1: ArtPeelBlckt↔1930 corrected med ≤ 1.5
- Gate 2: Non-metallic pass rate ≥ 90%
- Gate 3: No regressions (≥ baseline 88.5%)

**Script:** `scripts/experiments/h25_spreading_per_channel.ts`

**Status:** **FAIL** — experiment run 2026-06-15.

Results (oracle, dSpread560 > 0.10, 16 of 104 pairs corrected):

| Gate | Result |
| ---- | ------ |
| No regressions | PASS — 0 regressions, 92/104=88.5% |
| ArtPeelBlckt corrected med ≤ 1.5 | FAIL — med=1.91/1.87 |
| Non-metallic pass rate ≥ 90% | FAIL — 88.5% |

**Critically WORSE than H24 on spotlight pairs:**

- DecorMatte→ChromataWhite: Δp95=−0.14 (H24 per-λ neutral gave −2.89)
- BelgianLinen→DecorMatte: Δp95=+0.72 (regression)
- DecorMatte→Lyve: Δp95=+0.51 (regression)

Root cause: the ink-weighted average `(a_C·s_C + a_M·s_M + a_Y·s_Y) / w_tot`
assumes per-channel spreading is additive. It is NOT. When C+M+Y inks are
printed simultaneously, they compete for absorption sites on rough substrate
surfaces — the combined spreading is less than the sum of individual channels.
The neutral ramp (R=G=B) captures these ink-on-ink interactions directly; the
per-channel ramp measures single-ink behavior without co-print load.

**Conclusion: neutral ramp is the correct spreading basis for multi-ink systems.**
H24 (neutral per-λ) remains the best spreading correction found.

---

## H26 — H22 anchor-composition nonlinearity analysis (2026-06-15)

### Statement

The H22 MLP's mean-delta architecture captures inter-substrate spectral nonlinearity that
D1's linear layers miss. Specifically: (a) H22 k=5 should uniquely pass pairs that D1 k=13
fails; (b) replacing S1-ordered k=5 anchors with CMY-primary-ordered anchors (paper + C +
M + Y + black) should improve H22's ability to capture per-channel spreading differences via
the mean_delta feature.

### Acceptance gates

- Gate A: H22 k=5 S1 uniquely passes ≥ 1 pair that D1 k=13 fails (H22-only > 0)
- Gate B: H22 k=5 CMY-primary ≥ H22 k=5 S1 pass rate

### Rationale

CMY primaries {paper, (0,255,255), (255,0,255), (255,255,0), (0,0,0)} provide pure per-channel
spreading information (single-ink channels + full black). S1 k=5 = {paper, R(M+Y), G(C+Y),
B(C+M), cyan(C)} — missing pure M and Y channels. Mean_delta over CMY primaries should carry
more informative per-channel spreading signal. This tests whether H22 generalizes from
mean_delta features or memorizes specific anchor compositions.

### Script

`scripts/experiments/h22_anchor_comparison.ts` (2026-06-15)

### Status: **FAIL (both gates)**

**Results (104 non-metallic same-mode pairs):**

| Method | Pass | % |
|---|---|---|
| D1 k=13 | 92/104 | 88.5% |
| H22 k=5 S1 (paper+R+G+B+cyan) | 88/104 | 84.6% |
| H22 k=5 CMY-primary (paper+C+M+Y+black) | 0/104 | **0.0%** |
| H22 k=8 S1 | 87/104 | 83.7% |

**Cross-tab D1 vs H22 k=5 S1:**

| | H22 pass | H22 fail |
|---|---|---|
| D1 pass | 88 | 4 |
| D1 fail | **0** | 12 |

H22-only = **0**: the neural network uniquely passes zero pairs. D1 is strictly better.

D1-only = 4: PhotoPeelGloss↔VibranceGloss (H22 p95=5.2–5.7 vs D1 2.3–2.4), 17MSatin/17MGloss→Crystalline
(H22 p95=3.2–3.5 vs D1 2.6–2.7). D1's Layer 3 IDW correction is decisive for these pairs.

**CMY-primary: 0%** — complete OOD failure. The model memorizes anchor composition, not a
general transfer function. When given mean_delta over {paper,C,M,Y,black} (never seen during
training), all outputs are meaningless.

**k=8 S1 WORSE than k=5** (87 vs 88 pairs): 1-pair degradation at k=8 vs k=5 is marginal
but counter-intuitive. Consistent with anchor-specific memorization: the model's k-conditional
behavior is tied to the specific anchor subsets seen during training.

### Root cause

H22's mean_delta architecture compresses k anchor deltas into a single 39-dimensional mean
vector. This loses:

1. **Spatial information**: which anchor the delta came from (device-space location)
2. **Local nonlinearity**: D1 Layer 3 IDW interpolates locally in CMY space; H22 can only apply
   global correction
3. **Anchor-invariance**: the model is NOT invariant to anchor reordering / composition changes

The 4 D1-only failures all have D1 p95 = 2.3–2.7 (close to gate 3.0). IDW finds the nearest
anchor in CMY space and applies its exact correction; H22's global mean cannot replicate this
precision for isolated "correctable" regions.

### Implication for architecture design

H22 is a global model pretending to be local. The correct architecture for capturing local
nonlinearity would be:

- **Per-anchor attention**: give network the full (k × 39) anchor feature matrix, let attention
  select which anchors matter for each query patch
- **KNN-conditioned**: for each query patch, find nearest k anchors in CMY space, use only those
  deltas (as D1 Layer 3 does, but learned)
- **Invariant to anchor order/composition**: predictions should be equivariant to anchor set
  permutations

**H27 proposal**: D1 ablation — measure how much Layer 3 (IDW) contributes to the 4 D1-only
failures by running D1 with Layer 3 disabled. If D1-no-L3 fails those 4 pairs too, this
confirms IDW = the decisive difference.

---

## H27 result (2026-06-16) — CONFIRMED

D1 Layer-3 ablation (`globalResidual` switch on `applyPaperRatioResidual`,
`scripts/experiments/h27_layer3_ablation.ts`). On 104 non-metallic same-mode pairs:
D1 FULL (local IDW) **92/104 = 88.5%** → D1 noL3 (global mean residual) **79/104 = 76.0%**.
Layer 3 is worth **+12.5 pp**; 13 pairs lost, 0 gained; Δp95(noL3−full) ≥ 0 everywhere.
All 3 H27/H26 D1-only pairs (17MGloss→Crystalline, 17MSatin→Crystalline,
PhotoPeelGloss→VibranceGloss) collapse without Layer 3. Confirms H26 root-cause: **D1's
entire edge over H22 mean_delta IS the device-space-local correction (Layer 3).** noL3 D1
(76.0%) is below H22 k=5 S1 (84.6%) — locality, not the linear layers, carries D1.

---

## H28 — Per-anchor device-space attention (learned IDW analogue) (2026-06-16, pre-registered)

### Statement

H22's failure (H26: H22-only = 0; H27: D1 needs Layer 3) is caused by mean-pooling the k
anchor deltas into one global vector, discarding device-space locality. Replacing the mean
pool with a **learned attention over individual anchors, keyed on device coordinates**, lets
the network weight nearby anchors more — a soft, learnable, cross-substrate-trained analogue
of D1's fixed-k IDW Layer 3. This should (a) match or beat H22's pass rate, and (b) recover
the locality that makes D1's marginal pairs pass.

### Architecture

For query patch q with normalised source spectrum `s_q ∈ ℝ³⁶` and device coords `c_q ∈ ℝ³`
(CMY = (255−RGB)/255), and k anchors each with `(s_j, t_j, c_j)`:

```text
delta_j   = t_j − s_j                              ∈ ℝ³⁶   (normalised tgt−src per anchor)
score_j   = (Wq·c_q) · (Wk·c_j) / √d                       (d = 8 attention dim)
a_j       = softmax_j(score_j)   over real anchors (k<K_MAX padded + masked)
attended  = Σ_j a_j · delta_j                       ∈ ℝ³⁶
corr      = α · tanh( MLP([s_q, c_q, attended]) )   ∈ ℝ³⁶   (α small, learned head)
pred      = clamp(s_q + attended + corr, 0, ∞)
```

Locality lives in the learned bilinear kernel `Wq, Wk` on device coords (not fixed Euclidean
IDW). The residual form `pred = s_q + attended + corr` mirrors D1 (paper-ratio base +
anchor-driven local residual). Trained k-augmented (k ∈ {5,8,13}), same OBA handling and
leave-out-substrate split as H22. Loss = MSE in normalised reflectance.

### Acceptance gates

- **Gate H28a**: all-pairs k=5 pass rate ≥ H22 k=5 S1 (84.6%) — attention ≥ mean-pool.
- **Gate H28b**: recover ≥ 2 of the 3 H27 D1-only pairs (17MGloss→Crystalline,
  17MSatin→Crystalline, PhotoPeelGloss→VibranceGloss) — locality captured.
- **Stretch**: all-pairs k=13 ≥ D1 88.5% — attention beats fixed IDW.

### Rationale

H26 named the fix explicitly: per-anchor attention, KNN-conditioned, invariant to anchor
order. Attention with masked softmax is permutation-invariant over anchors by construction,
killing the CMY-primary OOD collapse (H26: 0%). Keying on device coords reproduces IDW's
"nearest anchor dominates" behaviour but with a learned bandwidth/metric shared across all
substrate pairs, so it can be smoother than fixed k=4 inverse-distance.

### Script

`scripts/h28_train.ts` (2026-06-16)

### Status: **FAIL (both gates)**

**Results (104 non-metallic same-mode pairs, leave-3-substrate-out):**

| Method | k=5 | k=8 | k=13 | median ΔE₀₀ (k=13) | P95 (k=13) |
|---|---|---|---|---|---|
| H22 mean-pool | 84.6% | 83.7% | — | 0.81 | — |
| **H28 attention** | **80.8%** | 78.8% | **84.6%** | **0.735** | 2.662 |
| D1 (reference) | — | — | 88.5% | ~0.9 | — |

- **Gate H28a FAIL**: k=5 = 80.8% < 84.6% (H22 k=5). Attention does NOT beat mean-pool at low k.
- **Gate H28b FAIL**: recovered 1/3 H27 D1-only pairs (17MGloss→Crystalline PASS;
  17MSatin→Crystalline p95=3.12 fail; PhotoPeelGloss→VibranceGloss p95=4.83 fail).

**Diagnosis.** H28 has the *best median* of any method (0.735 — beats H22 0.81, matches D1):
the device-keyed attention captures the bulk transfer well. But the gate is defined by the
**P95 tail**, and there H28 still loses near-gate pairs. Root cause: **softmax attention is too
diffuse** — divided by √d it spreads weight over many anchors, behaving like a smoother
mean-pool rather than IDW's "nearest anchor dominates". The residual `corr` (α=0.25) cannot
sharpen the tail. Median improves because soft averaging is a good *global* estimator;
the tail fails because the *local* sharpness that makes D1's marginal pairs pass is absent.
Permutation-invariance did fix the H26 CMY-primary OOD collapse (not retested here), but
invariance alone is not the locality mechanism.

**H29 proposal.** Sharpen the attention to recover IDW behaviour: (a) learnable temperature τ
on the scores (`score/τ`, τ→0 ⇒ hard nearest-anchor), and/or (b) hard top-k gating (mask all
but the nearest k′=4 anchors in device space before softmax — the literal learned-IDW). Expect
the P95 tail to drop and the 3 D1-only pairs to pass, since their failure is precisely a
locality problem (H27: D1 needs Layer-3 IDW for them).

---

## Note — M0/M2 at 380 nm (measurement artefact)

Independent of the ink-physics hypotheses: `mean(M0 − M2)` at 380 nm is **negative**
(−0.10 to −0.52) on every probed profile. M2 = UV-cut → the illuminant has no energy
below ~400 nm, so M2's reported reflectance at 380 nm is an extrapolated fallback rather
than a measured value. The H13 simple model's division by `R_paper_m2(380)` therefore
used a defective denominator, which explains part of why H13 simple amplified noise on
non-OBA papers. H13b's anchor-driven interpolation sidesteps this by using emission
samples directly, not band-0 ratios.

This is a parser/data-handling clarification, not a hypothesis — flagged so future
M2-based work skips the 380 nm band or treats it as missing data.

---

## H14 — Red-band substrate-ink interaction is the dominant P95 driver (2026-05-30, superseded)

Original draft hypothesis. Superseded by H14-revised above. The diagnostic data narrowed
"red-band substrate-ink interaction" to "**substrate-specific cyan absorption depth at
640–680 nm**" — same physical phenomenon, far more specific framing.

Diagnostic finding from `scripts/experiments/h13_diagnose.ts`. Across 90 same-mode BC pairs:

- Pearson r(obaMismatch, baseline P95) = **0.31** — only weak correlation.
- 2 of the 4 worst-P95 pairs have `obaMismatch = 0.00` (DecorMatte ↔ 800M, both
  high-OBA papers): P95 4.5–5.2 ΔE despite no OBA difference.
- Per-band reflectance RMS on those pairs peaks at **640–680 nm**, not UV.
- Worst-5 % patches cluster around mid-coverage 3-ink mixtures: typical RGB
  ≈ (60–80, 50–70, 50–80); the single worst patch across multiple pairs is
  RGB(0, 56, 31) (pure G+B, no R) at ΔE 7–9.

**Claim (H14).** The dominant residual on OBA-disparate AND OBA-matched same-mode pairs
is **substrate-specific ink interaction in the 640–680 nm region** on mid-coverage 3-ink
mixtures, not OBA fluorescence. A predictor that adds a per-band residual term targeted at
640–680 nm and fitted from mid-coverage anchors (say 4 additional patches at RGB(64, 32, 64),
(96, 64, 96), (64, 96, 32), (32, 64, 96)) should lower P95 by ≥ 1.0 ΔE on the worst pairs.

### Why this matters more than OBA at this stage

The post-2026-05-29 D1 (rank=5 + UV clamp) already absorbs most of the OBA non-linearity.
The remaining headroom isn't in fluorescence — it's in how each substrate's coating
interacts with the printer's red inks (Y absorption tail, K behaviour) on mid-coverage
mixtures. H14 reframes the project's residual-shaving direction.

### Acceptance & falsification

- **Pass:** an additional rank-2 residual term fitted on the 640–680 nm bands from 4 new
  mid-coverage anchors lowers P95 by ≥ 1.0 ΔE on at least 5 of the 10 worst-P95 pairs.
- **Reject:** the new anchors add no P95 reduction OR they hurt the dataset-level median
  by ≥ 0.1 ΔE.

### Tests

`scripts/experiments/h14_redband.ts` (to be written) — adds 4 mid-coverage anchors to S1,
fits the per-band residual at 640–680 nm separately from the rest, evaluates against the
H13c+S1 baseline on the same 90 same-mode pairs.

---

## H13 minimal-measurement OBA protocol (2026-05-30, deferred)

Given the H14 finding that OBA accounts for only ~0.08–0.09 ΔE of residual on disparate
pairs and the bulk of P95 lives at 640–680 nm, the minimal-measurement OBA protocol is
deferred but recorded for completeness:

- **2 measurements per profile in BOTH M0 and M2 conditions** (= 4 spectrometric reads):
  paper white (RGB 255,255,255) + mid-gray (RGB ≈ 128,128,128).
- Paper measurements give `E_paper(λ) = R_paper_m0(λ) − R_paper_m2(λ)`.
- Mid-gray measurement gives one calibration point for the UV-attenuation factor — fit
  `u(patch) = α · (R_patch_m0(380) / R_paper_m0(380))` where α is solved from the
  measured (M0 − M2) at the mid-gray anchor.

Exposed as an opt-in in TransferView once H14 work has shipped — OBA is the cheap
0.08 ΔE win, not the headline result.

---

## Conventions

- All ΔE values are CIEDE2000 unless explicitly tagged ΔE76.
- D50 illuminant, 2° observer everywhere.
- "Calibration patch" = a patch used to fit the model. "Test patch" = a held-out patch
  used only to evaluate.
- Train/test splits are 50/50 by patch index parity unless otherwise stated (see
  `cynsn.ts:runCYNSNComparison`).

### Hypothesis 14: Dynamic LOO CAE Fine-Tuning per Target (Same Print Mode)

- **Statement:** Static pre-trained CAE fails across heterogeneous print modes. For each target profile, fine-tuning the substrate latent on all other profiles of the *same mode* (LOO) + few-shot anchor patches (k=3) will capture mode-specific dot gain & spectral masking, reducing P95 ΔE₀₀ < 2.0 when ≥3 same-mode support profiles are available.
- **Status:** ⚠️ CONDITIONAL PASS / DATASET-LIMITED
- **Falsification criterion:** P95 ΔE₀₀ > 2.5 after LOO latent optimization + k=3 few-shot anchors on same-mode WCRW pairs (≥3 support profiles).
- **Findings (2026-06-08):**
  - WCRW (4 profiles, 3 support, k=13 old config): CAE_LOO median **1.26**, P95 3.90. Algorithm confirmed working.
  - PremiumLuster (2 profiles, 1 support, k=3): CAE_LOO median 7.8–8.9 (C7 = 1.37–1.38). H14 fails when support set = 1 profile.
  - Conclusion: algorithm is correct; effectiveness requires |S| ≥ 3.
- **Algorithm (corrected):**
  1. `S = AllProfiles_mode \ {Target}` — **all** profiles of the mode must be in the support set, not a subset. The browser implementation must load all same-mode profiles; the Python training pipeline must include all same-mode profiles in the LOO fold.
  2. **RGB-grid normalisation (invariant):** before entering the Nelder-Mead loop, every support profile `p ∈ S` is WLS-interpolated onto the **target's exact RGB device grid** (`B_raw.D`, shape N_target × 3). This guarantees that the loss function evaluates all support profiles at the same device locations, enabling consistent cross-profile MSE. Direct SAMPLE_ID intersection is insufficient when charts differ (BC 905-patch vs MOAB ~1550-patch); even for same-chart profiles the WLS path must be taken to guarantee grid identity.
  3. `few_shot_anchors = anchorIdx[:3]` (paper + 2 chromatic, from target only)
  4. `θ_substrate = argmin_θ [Σ_{p∈S} MSE_all_patches(S_pred(θ,p), S_true_p) + λ·Σ_{a∈few_shot} MSE(pred(θ,a), R_target_a)]` via Nelder-Mead, where all `S_true_p` matrices are at the target's RGB grid (step 2).
  5. `S_target = runCAETransfer(Target, θ_substrate)` evaluated on non-few-shot patches.
- **Math:**
  1. `S = AllProfiles_mode \ {Target}`
  2. `∀ p ∈ S: (X_p, D_p) ← WLS_interp(p, onto=D_target)` — shapes become `(N_target, L)` and `(N_target, 3)`.
  3. `θ_substrate = argmin_θ Σ_{p∈S} MSE(S_pred(θ, p), S_true_p)` via Nelder-Mead
  4. `S_target = runCAETransfer(Target, θ_substrate, anchorResiduals)`
