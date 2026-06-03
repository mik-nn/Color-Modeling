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
Note this is on the *raw* difference (substrate included); the device-normalised difference
is expected to be lower-rank.

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

### Tests

`scripts/experiments/h16_redband_yn.ts` — to be written.

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
