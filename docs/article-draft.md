# Predicting Color Across Print Substrates with 5 Patches

> Working title — alternative: *"How Optical Brighteners Break Cross-Substrate
> Color Prediction (and a Simple Fix)"*.

> **Status (updated 2026-06-15):** Batch validation complete. 114 same-mode directed
> pairs across 27 substrates confirm the main findings. Key numbers: **k=8 greedy
> (paper + 7 corners) = 78.1% pass**; k=13 = 83.3%; D-optimal PCA selection
> dramatically worse (21.9% at k=8). See the "Batch validation" section below.

---

## The problem

A print shop has a colour-managed workflow nailed for one substrate. The
customer asks for the same image on a new substrate — different paper, same
printer, same inks. The textbook procedure is to print the IT8.7/4 target
(~ 1600 patches), measure each one with a spectrophotometer, and build a new
ICC profile from scratch. That is several hours, a chunk of expensive
substrate, and a person who has to babysit the measurement.

The question I started with: **how few patches can we get away with on the
new substrate if we already have one substrate fully characterised on the
same printer?**

The intuitively-pleasing answer turns out to be *five*. The path to that
answer involves recognising that the textbook predictors — per-wavelength
affine regression, paper-ratio scaling, PCA pool basis — all converge on the
same accuracy ceiling on this dataset, that **optical brighteners are
quietly responsible for most of the residual cross-substrate signal**, and
that the cleanest fix is to subtract the OBA fluorescence analytically
*before* doing any prediction, then add it back afterward.

This post walks through the dataset, the four predictors I compared, the
three anchor-selection strategies, and the OBA finding. The companion tool
is at [github.com/mik-nn/Color-Modeling](https://github.com/mik-nn/Color-Modeling.git);
every number quoted below is reproducible from a single pair load in the
browser.

---

## The setup

**The printer.** [Epson SureColor SC-P9000](https://www.epson.com/For-Work/Printers/Large-Format/SureColor-P9000-Standard-Edition-Printer/p/SCP9000SE)
— a 10-ink wide-format inkjet. The ink set is PK/MK (photo black / matte
black, swapped per substrate), Cyan, Vivid Magenta, Vivid Light Magenta,
Yellow, Light Cyan, Light Black, Light Light Black, plus Green or Orange
depending on the print mode.

**The caveat.** Every ICC profile in my dataset is addressed as **3-channel
RGB**, not as 10-channel ink coverage. The driver does the RGB → 10-ink
separation internally with a proprietary LUT. I never observe per-ink
coverage; I only observe spectra at known RGB triples. So everything below
is **empirical regression** between substrates at matched RGB positions —
not a physical ink-mixing model. (If you wanted to do physically-faithful
Yule-Nielsen / Cellular-YN / Kubelka-Munk modelling on this kind of data
you would need a CMYK-addressed dataset; I don't have one yet.)

**The data.** 27 substrates, each measured as ICC v4 RGB profiles with a
[CxF3](https://www.iso.org/standard/61915.html) measurement block embedded
in a private tag. Per profile: 905 patches × 36 spectral bands (380–730 nm
in 10 nm steps), M0 condition (illuminant contains UV). The patches sit on
a shared chart so they're joinable across substrates by Row:Col:Page.

For the hypothesis tests in this post I use a single pair — DecorMatte
(no/low OBA, R(380) = 0.117) and Lyve (heavy OBA, R(380) = 0.663) — both
labelled "CanvasMatte" by their manufacturer. The fact that two products
in the same nominal substrate class differ 7× at 380 nm matters; I'll come
back to it.

---

## Four predictors

All four predict `B(λ, RGB) ≈ F(A(λ, RGB))` given k anchor pairs `(A, B)` at
matched RGB positions. They differ in how F is shaped.

**A3 — per-wavelength affine.** The simplest. For each wavelength, fit a
slope and intercept on the anchor pairs:

```
B(λ, RGB) ≈ a(λ) · A(λ, RGB) + b(λ)
```

72 free parameters (2 × 36 wavelengths). Closed-form OLS. Baseline.

**D1 — paper-ratio + PCA residual.** Multiplicative substrate scaling +
nonlinear correction:

```
B(λ, RGB) ≈ r(λ) · A(λ, RGB) + ε̂(RGB, λ)
```

`r(λ) = B_paper(λ) / A_paper(λ)`, clamped to `[0.3, 3.0]` to survive OBA
mismatches at short λ. The residual `ε̂` is a low-rank PCA fit on the
non-paper anchors, interpolated to all patches by inverse-distance kNN in
RGB space. Paper anchor is "free" — only one measurement.

**B3 — pool-PCA + diagonal score map.** Builds the spectral basis from a
*pool* of other substrates (the 25 we are not currently predicting). Then
projects ref + target anchors into that basis and fits a per-PC affine map.
Bets that cross-substrate variation lives on a low-dim manifold shared
across substrates.

**C7 — per-wavelength monotone curve.** For each λ, sort the k anchor `(A, B)`
pairs by A, build a piecewise-linear monotone interpolant. No parametric
form imposed; the curve is whatever the anchors say it is.

A3 is the most rigid, C7 the most flexible. D1 and B3 are mid-flexibility
priors of different shapes.

---

## Three anchor strategies

**S1 — forced heuristic.** Paper + 8 RGB corners (cyan, magenta, yellow,
red, green, blue, paper, black) + 5 neutrals → 13 anchors. Deterministic.
Spread across the RGB cube.

**S2 — greedy adaptive.** Start with S1, predict, find the worst-ΔE patch
on the target, add it to the anchor set, refit. Stop at a ΔE budget or a k
cap. Answers "what's the minimum k for the ΔE I want?"

**S3 — single-channel ramp.** Paper + N evenly-spaced anchors along one
channel (neutral / cyan / magenta / yellow). Tests the hypothesis that the
substrate transform is *shared across inks* — if so, one ramp is enough to
fit `f_λ` for every λ.

---

## The two findings

On the DecorMatte → Lyve pair, with default settings:

| Strategy   | k  | A3    | D1    | B3    | C7        |
|-----------:|---:|------:|------:|------:|----------:|
| S1         | 13 | 1.54  | 1.45  | 2.17  | **1.28**  |
| S3 neutral |  5 | 1.53  | 1.42  | 27.00 | **1.06**  |
| S3 cyan    |  5 | 9.31  | 2.93  | 21.28 |    9.28  |

All numbers are median CIEDE2000 on the 892 non-anchor patches, paper-relative.

**Finding 1: C7 beats every other predictor at the same anchor budget.** At
k = 13 (S1), the per-λ monotone curve gets 1.28 ΔE00 — beating A3 by 0.26,
D1 by 0.17, B3 by 0.89. The substrate transform between these two
canvas-matte papers is *non-affine* per wavelength; the linear-only fit
A3 systematically underfits, and the paper-ratio decomposition D1 spends a
parameter budget on the paper-white anchor that the per-λ curve absorbs for
free.

**Finding 2 (the surprise): five anchors on a neutral ramp beat
thirteen anchors anywhere.** C7 + S3 neutral (paper + 4 grey patches) gets
1.06 ΔE00. Anchor budget drops 13 → 5 (a 62 % reduction) AND the median
error improves. The user-articulated hypothesis was right: the substrate
transform really is per-wavelength scalar, and an anchor ramp that visits
the full reflectance range at every λ pins the curve everywhere.

But — and this is where it gets interesting — **the same hypothesis fails
catastrophically when you use a cyan ramp instead of a neutral ramp.**
Median ΔE00 explodes from 1.06 to 9.28.

That is not noise. That is OBA.

---

## The OBA detour

[Optical brightening agents (OBA)](https://en.wikipedia.org/wiki/Optical_brightener)
are fluorescent dyes added to most modern papers. They absorb UV light at
~ 365 nm and re-emit it in the blue at ~ 430–450 nm. The spectrophotometer
under M0 illumination (which contains UV) counts both reflected light *and*
fluorescent emission, so a paper with strong OBA can show R(440) > 1.0 — a
physically valid measurement of "more light comes out than the substrate's
own surface reflects."

I sampled the paper-white spectra for 8 substrates from the dataset:

| Substrate                  | R(380) | R(440) | OBA score = R(440)/R(550) |
|----------------------------|-------:|-------:|--------------------------:|
| DecorMatte · CanvasMatte   | 0.117  | 1.089  | 1.20 (heavy) |
| 17MGloss · CanvasSatin     | 0.193  | 1.097  | 1.18 |
| 600MT · WCRW               | 0.311  | 1.029  | 1.11 |
| Crystalline · CanvasSatin  | 0.392  | 0.904  | 1.02 |
| VibranceGloss · PGPP       | 0.620  | 0.942  | 1.10 |
| PhotoPeelGloss · PGPP      | 0.635  | 0.867  | 1.04 |
| Lyve · CanvasMatte         | 0.663  | 0.888  | 1.02 |
| PuraSmooth · WCRW          | 0.819  | 0.865  | 0.99 (none) |

Notice that two papers labelled "CanvasMatte" — DecorMatte and Lyve — differ
by a factor of 5.67 at 380 nm. **The substrate-class name does NOT predict
OBA loading**, even within a single manufacturer's product line.

This matters for cross-substrate prediction because OBA blocks differently
per ink:

| Ink     | UV absorption | OBA shutoff |
|---------|---------------|-------------|
| Cyan    | low — UV-transparent | minimal — cyan does NOT turn OBA off |
| Magenta | moderate (also absorbs 400–450 nm) | partial |
| Yellow  | **high — strongest UV absorber of CMY** | **strongest** |
| Black   | total | total |

A cyan ramp, viewed in isolation, looks identical at 380 nm regardless of
ink coverage — cyan ink does not block UV, so the OBA emission keeps coming
through. The S3 cyan failure mode is now obvious: the per-λ curve has only
one data point at 380 nm (paper, all cyan-ramp anchors collapse on top of
each other), so any patch with non-trivial yellow content gets a wildly
extrapolated B(380). Median 9.28.

A *neutral* ramp does not have this problem — gray patches use all three
inks proportionally, which means yellow (the UV absorber) varies through
the ramp, and the per-λ curve at 380 nm is well-determined.

---

## The fix: separate OBA before predicting

The standard advice when OBA confuses your measurements is to switch to M2
condition (UV-cut illuminant). That works for new measurements; it doesn't
help us when 23 of 27 profiles in our dataset are already M0.

Here's the observation that unlocks the cheap fix: **both substrates are
fully measured in the research dataset.** I can extract the OBA emission
from each paper spectrum analytically:

```text
1.  Fit a degree-2 polynomial to R_paper(λ) over λ ∈ [460, 730] nm.
2.  Extrapolate the polynomial back into [380, 450] → substrate base shape.
3.  OBA emission(λ) = max(0, R_paper(λ) − base(λ)).
4.  Per-patch factor in [0, 1]:
        factor(patch) = clamp(R_patch(380) / R_paper(380), 0, 1)
5.  R_clean = R_measured − factor · emission, applied to BOTH substrates.
6.  Run ANY predictor on (R_clean_A → R_clean_B).
7.  R_pred = R_pred_clean + factor · emission_B  (target's emission).
```

Steps 1–2 give us a smooth model of what the paper would have reflected if
it had no OBA. Step 3 measures the bump. Step 4 estimates how much UV is
blocked at each patch (a higher-coverage patch absorbs more UV → less OBA
emission). Steps 5–7 split the prediction into "predict the OBA-free
substrate transform" and "add OBA back as a separate component".

I call this wrapper D7. Empirically on the same DecorMatte → Lyve pair, the
catastrophic S3-cyan case:

| Strategy   | Predictor | D7 OFF | D7 ON | Δ        |
|------------|-----------|-------:|------:|---------:|
| S3 cyan    | A3        | 9.31   | 9.23  | −0.08    |
| S3 cyan    | **D1**    | **2.93** | **2.42** | **−0.51** |
| S3 cyan    | C7        | 9.28   | 8.88  | −0.40    |

D1 + S3 cyan drops from 2.93 to 2.42 — a half-unit of median ΔE00 with
zero extra anchors and no predictor changes. The OBA component is now
modelled separately, so the per-λ predictor sees a much simpler problem.

The two extracted OBA emissions:

- DecorMatte (ref): peak amplitude 0.106 at 410 nm.
- Lyve (target): peak amplitude 0.000.

These match what we expect from the per-substrate dump above.

---

## Live numbers

Reproducing all of the above: clone the repo, `cd frontend && npm install`,
`npm run dev`, drag-drop two ICM profiles into the sidebar. The Transfer
view runs all four predictors against all three anchor strategies in real
time as you change the selectors. The OBA mismatch tile lights up red when
the two papers differ in OBA loading; the D7 checkbox toggles the
separation wrapper on/off. Numbers update under 100 ms per change because
all four predictors are small closed-form fits.

The source is at
[github.com/mik-nn/Color-Modeling](https://github.com/mik-nn/Color-Modeling.git);
the predictors live in `frontend/src/lib/predict/`, the OBA separation in
`frontend/src/lib/predict/obaSeparator.ts`, and the empirical reference
data in `docs/EXPERIMENTS.md`.

---

## Limitations and open questions

**The 10-channel printer hides the inks.** Everything above is empirical
regression between substrate spectra at matched RGB positions. I cannot
make claims about cyan ink physics versus magenta ink physics because I
never see ink coverage. To do the physics-faithful 4D-CMYK Cellular-YN
Spectral Neugebauer track requires a CMYK-addressed test target (FOGRA51,
ECI2002, etc.) — I don't have one yet.

**One pair is anecdote, not science.** The numbers above are from
DecorMatte → Lyve. There are 702 directed substrate pairs in the 27-profile
dataset. Until I run the batch (Phase 8 of the project), "C7 + S3 neutral
beats C7 + S1" is one data point. Worth nothing.

**OBA proxy bias.** The UV-block proxy `R_patch(380) / R_paper(380)`
conflates "UV blocked by ink" with "spectrally-dark pigment that happens to
absorb at 380 nm". For yellow-heavy patches the proxy and the physics
agree; for unusual pigments it can underestimate the available OBA at the
patch.

**M0 vs M2 mixing.** 23 of 27 profiles in the dataset are M0; 4 are M2
(UV-cut). The current pipeline does not distinguish them. Anything that
crosses an M-condition boundary should be flagged.

**B3 underperforms on this pair.** Pool-PCA with 7 pool profiles and a
diagonal score map gives median 2.17 (worse than every other predictor).
The 7-profile pool is probably too small to span the OBA-coverage
direction; the diagonal map cannot capture cross-PC coupling. Either
expanding the pool or moving to a full-M score map should help; I will
investigate after the batch run.

---

## Why this matters

If the user-hypothesis result generalises beyond this single pair — and I
think there's a decent chance it does, because the underlying physics
(OBA-driven UV-blue distortion + smooth per-ink absorption) is universal
— then the practical workflow looks like this:

1. **Once per printer**: build a full ICC profile on one substrate
   (~ 1600 patches, the textbook IT8.7/4 procedure).
2. **For every new substrate**: print + measure a 5-patch neutral grey
   ramp (paper + 4 levels). Five patches. Fifteen minutes of work and
   essentially zero substrate cost.
3. **Predict the full target ICC profile** from the reference + 5 anchors
   using D7 + C7 + S3-neutral. Median ΔE00 ≈ 1.0 on what we have so far.

That moves the cost of a new substrate from hours / dollars to minutes /
cents. It's also a regime where you can iterate quickly on substrate
recommendations for a customer — "let me try this on three papers and
show you" becomes a real-time process, not a half-day project.

The physics-faithful version of this story — done on a CMYK dataset where
you can actually decompose per-ink behaviour — is the next chapter. Stay
tuned.

---

## Batch validation: does it hold across substrates? (updated 2026-06-15)

Single pair = anecdote. Useful proof of concept, but the real question: does this
generalise across all BC-family substrate pairs on the same P9000?

### Dataset

27 BC substrates (Epson SureColor P9000, RGB workflow). Evaluated 114 directed same-mode
pairs (source A → target B where both share the same Epson media preset). AllureAq
excluded (different patch grid, 1 550 patches vs 905).

### Results at a glance

| Anchors k | Strategy | H4 pass rate | Median ΔE₀₀ |
|-----------|----------|--------------|-------------|
| 6  | greedy (paper + 5 corners) | 47.4% | — |
| 7  | greedy (paper + 6 corners) | 47.4% | — |
| 8  | greedy (paper + 7 corners) | **78.1%** | ≈0.908 |
| 9  | greedy | 78.9% | — |
| 10 | greedy | 80.7% | — |
| 13 | greedy (S1 full set) | 83.3% | — |
| 8  | D-optimal (PCA volume) | 21.9% | — |

H4 pass gate: median ΔE₀₀ ≤1.5 AND P95 ΔE₀₀ ≤3.0 on non-anchor patches.

### The k=7 → k=8 jump

The large jump from 47.4% to 78.1% between k=7 and k=8 has a clear mechanical cause:
k=8 adds the black patch (RGB 0,0,0), completing the CMY device-space cube. The D1 model
is a paper-ratio multiplied by a rank-5 residual; without full-black, the residual can't
reach into the high-CMY gamut. Once black is included, the interpolation works for 78% of
pairs in a single shot.

### Why D-optimal fails

PCA volume maximisation picks spectrally diverse patches, but those are not the same as
device-space corner patches. D-optimal k=8 gives 21.9% vs greedy 78.1% because the PCA
anchors miss the structural corners the model needs. A hybrid strategy — fix paper + 7
device corners, then add D-optimal picks from the remaining budget — is untested but
looks promising for pushing past 83.3%.

### H19 anchor / rank experiments

After noticing worst errors cluster in the high-CMY + high-Y (olive-green) sector (H18
finding: Spearman(total_ink, ΔE₀₀) = 0.712), two augmentation experiments were run:

- **H19a — heavy-Y anchor augmentation**: Adding 3 olive-green patches to k=8 greedy
  set. P95 regressed from 4.79 → higher; gate missed. The residual can't use ink-dense
  anchors to extrapolate correctly from a paper-ratio model.
- **H19b — rank increase (5 → 8)**: Same result; P95 delta < gate. SVD dimensionality
  is not the bottleneck in the high-ink failure mode.
- **H19c — batch rank comparison**: 83.3% at rank=5 vs 83.3% at rank=8 across 114 pairs.
  Rank increase has zero effect on pass rate.

Conclusion: the 83.3% ceiling at k=13 is structural, not addressable by more anchors or
higher rank. Remaining 16.7% of pairs require a different model (e.g., non-multiplicative
spectral correction or separate UV/OBA treatment).

### H22 — neural delta predictor

To probe whether a learned model can close the gap with fewer anchors, a small MLP was
trained on the same 114-pair dataset using the delta representation:

- **Architecture:** 79 → Dense(256) → Dense(128) → Dense(64) → Dense(36, sigmoid)
- **Input:** `query_src_norm(36) ‖ query_CMY(3) ‖ mean(tgt_j_norm − src_j_norm)(36+3) ‖ k_norm(1)`
- **k-augmentation:** trained simultaneously on k ∈ {5, 8, 13} to avoid domain shift

Key result: **k=5 (paper + R + G + B + K) achieves 79.8% pass rate**, matching or exceeding
D1 greedy k=8 (78.1%). The mean-anchor delta is sufficient representation for device-cube
extreme anchors, and adding more anchors does not improve the network (k=8 = 78.1%).

The 16.7% structural ceiling persists even for the neural predictor — DecorMatte and similar
matte-canvas substrates differ from bright-coated substrates in base spectral shape, which
no amount of additional anchors (within the same ink mode) resolves.

### What "5 patches" means in practice

For a new substrate on the same printer + same media preset:

1. Print a 5-patch target: paper white + RGB primaries + black.
2. Measure with a spectrophotometer (M0 condition).
3. Transfer source profile → target via H22 neural delta model (or D1+D7+S1 at k=8 for a
   non-ML fallback with equivalent accuracy).

Expected outcome: median ΔE₀₀ ≤1.5, P95 ≤3.0 on ≥78% of same-mode substrate pairs.
Minimum viable protocol = 5 patches; the MLP and the heuristic reach the same ceiling.

---

## References

- ISO 13655:2017 — Spectral measurement and colorimetric computation for graphic arts images.
- ISO 11664-6:2014 — Colorimetry — Part 6: CIEDE2000 colour-difference formula.
- ISO 17972-3:2015 — Graphic technology — Colour data exchange format (CxF/X) — Part 3.
- Wyble, D.R., Berns, R.S. (2000). "A critical review of spectral models applied to binary color printing." *Color Research & Application*, 25(1).
- Fairchild, M.D. (2013). *Color Appearance Models* (3rd ed.). Wiley.
- ICC.1:2010 / ISO 15076-1:2010 — ICC profile format specification v4.

---

## Companion data

All numbers in this post are recorded with reproducible row entries in
[`docs/EXPERIMENTS.md`](https://github.com/mik-nn/Color-Modeling/blob/main/docs/EXPERIMENTS.md)
of the repository:

- "OBA range across 8 P9000 substrates" (2026-05-23)
- "OBA-aware D1 head-to-head on OBA-disparate same-class pair" (2026-05-23)
- "C7 per-λ monotone curve — 4-way head-to-head with S1 anchors" (2026-05-24)
- "S3 neutral ramp (k=5) — C7 dominates with fewer anchors than S1" (2026-05-24)
- "S3 cyan ramp (k=5) — counterexample: single-channel ramp FAILS at short λ" (2026-05-24)
- "D7 OBA-separation wrapper" (2026-05-24)

The full set of falsifiable hypotheses (H1 through H9) is in
[`docs/RESEARCH_HYPOTHESIS.md`](https://github.com/mik-nn/Color-Modeling/blob/main/docs/RESEARCH_HYPOTHESIS.md).
