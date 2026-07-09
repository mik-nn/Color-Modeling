# Diagnosing Extreme Printing Modes Through Spectral Adaptation Errors
### Why 5 patches aren't enough for 12% of media pairs—and how prediction failures reveal fixable pre-press errors.

**Michal Erlich**  
*Color Management Researcher & Profiling Tool Developer*

This is a direct continuation of the article *[Five Patches Instead of a Thousand](https://mikchael.substack.com/p/predictive-color-adaptation-on-new)*. There, I demonstrated that a color profile can be adapted to a new material using just five strategically chosen control patches. Here, we address the ~12% of material pairs where five patches (or even fifty) are not enough. We will explore exactly what fails in these cases and why this is usually a symptom of a fixable error in the print mode setup, rather than a fundamental limit of the predictive method itself.

---

## 1. The Limits of the Paper-Ratio Predictive Model
The method of adapting a profile to a new material using a few anchor patches works remarkably well. Given a fully characterized reference profile and a few measured anchor patches on the new substrate, the **Paper-Ratio** predictor reconstructs the remaining spectra. Across 27 art materials and two printer models (Epson SC-P9000 and Canon G2470):
*   About five optimally placed patches yield a median ΔE₀₀ ≤ 1.5 with a 95th percentile (P95) ≤ 3.0 for ~88–90% of material pairs within the same print mode.
*   It matters less *how many* patches you measure, and more *which ones*: a 5-patch set optimized algorithmically outperforms a 12-patch set chosen manually.

However, the first article noted a constraint: about 12% of pairs fail the quality criteria regardless of the number of anchor patches—adding more measurements doesn't save them. This article explains why. These failures are not random noise; they have a stable localization, a measurable signature, and two distinct physical root causes.

> **Critical Constraint (unchanged from the first article):** All experiments were conducted on Epson SC-P9000 and Canon G2470/G1430 printers using standard RGB drivers. Color separation occurs within the driver’s internal LUTs and is inaccessible for direct control. Optical Brightening Agent (OBA) fluorescence is accounted for as a preprocessing factor. All results are reproducible using the open-source tool at [github.com/mik-nn/Color-Modeling](https://github.com/mik-nn/Color-Modeling).

## 2. Decomposing the Colorimetric Error: The Dominance of Chroma and Hue Shifts
The first question regarding any failed prediction is the nature of the error. A profile that prints too dark is one problem; a profile with a hue shift is entirely another.

Let's decompose the largest errors (patches with ΔE₀₀ > 3) into standard CIELAB components: Lightness |ΔL*|, Chroma |ΔC*|, and Hue |ΔH*|. The answer is unequivocal. On the Canon printer, out of 626 pairs of the same media family, 148 failed the criteria. In 147 of these 148 pairs (99%), the error is predominantly chromatic: across the failing patches, the average |ΔC*| ≈ 3.3 and |ΔH*| ≈ 3.1 are nearly five times higher than |ΔL*| ≈ 1.0. The Epson SC-P9000 shows the exact same pattern. The method fails not in tonal gradations, but in chroma and hue at the extreme edge of the color gamut.

This immediately rules out an entire class of solutions. Lightness errors are easy to reduce—just add more anchor patches and improve interpolation. The predictor is smooth, and smooth models handle lightness well. A shift in chroma and hue, which a multiplicative model cannot express, has a different origin. Even direct optimization (a genetic algorithm tuning the patch set specifically for the difficult pairs) fixes only about half the cases and hits a plateau; in the rest, the error remains stubbornly anchored in chroma and hue. The issue is not patch placement.

## 3. Correlation of Transfer Error with Driver Table Saturation (The RGB Proxy)
If the error is chromatic and lives at the edge of the gamut—where exactly is that edge? It is where the maximum amount of ink is laid down on the paper.

> **Methodological Note: The RGB Proxy in a "Black Box" Environment.**  
> Because color separation is hidden inside the standard RGB driver's LUT, we cannot directly measure the physical Total Area Coverage (TAC). This is especially critical for the 10-ink Epson SC-P9000, where the driver actively uses light (Lc, Lm) and gray (Lk, LLk) inks to smooth gradients, alongside Orange and Green. As a metric, we use the sum `(255-R) + (255-G) + (255-B)`. Strictly speaking, this is not the physical volume of ink, but an indicator of the saturation of the driver's internal tables (**Driver Saturation Proxy**). It is precisely at high values of this proxy that the driver is forced to apply aggressive gamut compression algorithms, which, combined with the physics of the specific material, leads to the failure of the Paper-Ratio model.

Let's sort every non-anchor patch by total ink coverage and compare it with the prediction error. The Spearman rank correlation is 0.71. The dependence across coverage levels is stark:

| Total Coverage (C+M+Y) | Median ΔE₀₀ | P95 ΔE₀₀ |
| :--- | :--- | :--- |
| **Low** (0–255) | 1.20 | 2.13 |
| **Medium** (256–383) | 1.21 | 3.45 |
| **High** (384–511) | 2.76 | 6.13 |
| **Maximum** (512–765) | 5.23 | 7.72 |

In the light and medium coverage zones, the method confidently stays within tolerance. The error doubles at high coverage and quadruples at maximum ink. The method is accurate everywhere except in the region of maximum ink deposition. This is the clue: the cause is not the model itself, but what physically happens to the ink at extreme coverage.

## 4. Physical Mechanism A: Non-linear Chroma Response (Gradient Inversion) and Ink Limiting
Let's look at how chroma changes as ink is added—along the gradation scale of a single color. On a "properly tuned" material, chroma grows and then plateaus: beyond a certain level, added ink no longer increases saturation. On many materials, something worse happens: chroma reaches a maximum and then folds downward, while the hue shifts. Let's call this the *fold*.

In colorimetry, this phenomenon is described as **chroma gradient inversion** or non-linear response to ink deposition (**overinking**). Having reached the peak point (t*), further addition of ink leads not to a deepening of color, but to dot gain, parasitic mixing, and hue shift. The trajectory in the a*b* plane folds inward toward the center of the color body.

Specifically, the green scale (cyan + yellow) on Signa 270 material:

| Ink Coverage (t) | 0.0 | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Chroma C*ab** | 0.0 | 17.4 | 40.2 | 75.7 | 82.8 | 70.4 |

Chroma reaches its maximum around `t = 0.75–0.8` and then loses about 12 units at full ink. The last 20% of ink does not deepen the color; it reduces saturation and shifts the hue. This is overinking: beyond the peak, excess dye no longer lays down cleanly but scatters and mixes unpredictably. Out of 24 P9000 profiles measured under M0 conditions, 23 show this fold on at least one scale.

*(See Generated Illustration 1: Chroma Gradient Inversion)*

### Maximum Chroma is Not a Single Number, But a Boundary in Hue Space
There is an important detail here that is easy to miss. Every hue has its own maximum chroma—and it is achieved at its own ink coverage level. The green scale (hue ≈ 130°) peaks at one coverage level, red (≈ 30°) at another, and blue (≈ 270°) at a third. There is no single "ink limit for all colors."

Therefore, two related but distinct quantities are at play:
1.  **The coverage level at the peak, `t* = arg max C*ab(t)`.** It is unique for each ink direction (C, M, Y, and secondary R, G, B, plus neutral) and defines the ink limit in that direction. A patch exceeds the limit if it contains more ink than the peak saturation point for its hue.
2.  **The maximum chroma `C*ab` at that point.** It is calculated separately for each of the 36 hue sectors (10° steps). All 36 values together form the gamut boundary in the a*b* plane.

In other words, both the ink limit and the gamut boundary are defined per hue: data is truncated not by a single threshold, but by the individual maximum of each direction.

### How Much Gamut Does Truncation Cost?
If we restrict coverage to level `t*`—keeping only points up to the maximum chroma for their direction—how much gamut is lost? Comparing the volume of the color solid (convex hull in Lab) before and after, the median loss is **5.4%**. Meanwhile, the gamut boundary—the maximum chroma in each of the 36 hue sectors—is preserved entirely (100%): the maximum does not change in a single sector.

Only the dark corner of low lightness is lost. Colors beyond the maximum chroma point do not extend outward; they fold inward into the color solid. Therefore, discarding them costs zero units of chroma—only a narrow band of dark density that was unstable anyway.

*(See Generated Illustration 2: Gamut Volume Truncation)*

## 5. Physical Mechanism B: Surface Holdout and Optical Anomalies of Matte Substrates
There is one material in the dataset that defies all built models, and it is particularly illustrative: **DecorMatte**, a Canvas Matte. It is the source of the most difficult cases from the first article—and the only one of the 24 profiles without a fold. Its green scale:

| Ink Coverage (t) | 0.0 | 0.2 | 0.4 | 0.6 | 0.8 | 1.0 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Chroma C*ab** | 0.0 | 18.1 | 35.9 | 60.4 | 70.9 | 72.1 |

Chroma grows monotonically to full ink—no fold, the maximum occurs at maximum coverage. By the maximum chroma criterion, DecorMatte has no overinking. Yet, it is the most difficult material to predict. The cause must be something else.

### Why is Paper-Ratio Powerless Here?
The core hypothesis of our model is that, with a constant driver, the material acts merely as a passive modifier of a pre-formed ink layer. The **Holdout** mechanism on matte canvases (DecorMatte) violates this assumption. The ink does not absorb; it forms a surface film (pooling), creating micro-gloss and bronzing.

Under standard measurement geometry (M0), the spectrophotometer registers not just the diffuse reflection of the pigment, but parasitic specular reflection from the wet layer. This creates an optical anisotropy that fundamentally differs from the spectral signature of absorbing materials in the training set. Multiplicative correction (White Point Scaling) cannot compensate for the change in the physical topology of the ink layer. The solution lies not in the math of the model, but in choosing the correct measurement geometry (switching to M1/M2 with polarization) or changing the RIP media preset.

This is **ink holdout**: on a matte canvas, ink at high coverage does not absorb but remains on the surface. In parts of the spectrum, reflection increases where it would normally fall on highly absorbing materials. Chroma continues to grow because the surface ink layer is still saturated, but its spectral shape diverges from the shape on any absorbing material—and a transformation trained on absorbing materials predicts it poorly. This is not overinking, cured by an ink limit, but a material mismatch, cured by the correct media preset.

Two arguments prove Mechanisms A and B are independent. First: DecorMatte's monotonic scale vs. the fold in all others. Second: the descriptor of fold severity and the descriptor of neutral scale curvature (holdout) barely correlate (0.03). They describe different phenomena.

*(See Generated Illustration 3: Ink Holdout vs Absorption)*

## 6. Verifying the Limits: Transfer Error as a Metric for Media Preset Quality
Now for the result that ties everything together; I verified this with particular care.

We derived the ink limit blindly—from the chroma curve of the profile itself, knowing nothing about the transfer error between materials. Let's ask: where is this transfer error actually at its maximum? It turns out that **70% of the patches in the worst 5% by ΔE₀₀ lie above this limit**—where more ink is deposited than at the peak chroma point. The limit, calculated without any reference to the error, accurately points to the zone where transfer breaks down.

Hence, a practical technique: report metrics only for patches within the ink limit, and flag the rest as unreliable. This raises the pass rate from 71.3% to 79.6%. But such an increase requires a control: if you simply throw out part of the test set, the pass rate will naturally rise—fewer patches mean fewer chances to fail. So, I threw out the exact same number of *random* patches and averaged over 30 runs:

| Test Set | Pass Rate |
| :--- | :--- |
| **Full** (no exclusions) | 71.3% |
| **Random patches excluded** (same amount) | 71.6% |
| **Patches above ink limit excluded** | 79.6% |

Random exclusion yields +0.3 percentage points—practically zero. Excluding specifically the patches above the ink limit yields **+8.0 p.p.** above the random baseline. This means the increase is not just a reduction in sample size: the zone above the ink limit is genuinely where transfer fails. More importantly, the limit is calculated on the *reference profile*—the one that is fully known during implementation—so the technique is applicable proactively, not retroactively.

Read correctly, this is not "the method covers a smaller gamut," but a quality indicator for every patch: a large prediction error signals that the profile was built in an overinking mode (or another unsuitable mode), and roughly indicates where.

## 7. Practical Correction: TAC Limiting and Media Profile Selection
The good news is that both mechanisms are resolved by long-known pre-press techniques—no new inventions required.

*   **Overinking → Ink Limiting.** The peak chroma point `t*` is the perceptual ink limit per channel. Setting correct per-channel and total ink limits is a standard, long-solved step in print preparation (see my previous article, *[Pre-calibration of RGB Printers](https://mikchael.substack.com/p/pre-calibration-of-rgb-printers-moving)*). Set the limits, re-linearize, and the problem zone simply stops printing; the resulting profile is cleaner and operates in a predictable regime by definition. The novelty here is the ability to detect that a limit is needed directly from the profile's spectra, and to show that it costs almost nothing in gamut (5% of dark volume, 0% of the chroma boundary).
*   **Holdout → Correct Media Preset.** DecorMatte doesn't need ink limiting—it needs a regime designed for non-absorbing matte canvas. The detector flags it just as clearly—as the only material with a monotonic scale—making it immediately obvious that the ink-limiting tool should not be applied here.

### The Open Question: The Residual Ceiling for Multi-Channel Systems
What remains an open question is the residual accuracy ceiling for 10-ink systems (Epson SC-P9000). If in the 4-ink Canon G2470 the inter-channel interaction (GCR/UCR) is relatively predictable, in 10-ink printing the driver uses complex multi-dimensional LUTs to mix orange, green, and gray inks. The Paper-Ratio model operates on spectral ratios, but it is blind to *which* of the 10 channels the driver used to achieve a given Lab coordinate. Overcoming this ceiling will require either bypassing the driver via a direct CMYK/10ch RIP, or building a multi-dimensional model that accounts for driver metadata. This is the subject of our next research.

## Conclusions
*   When adaptation to a material via a few patches fails, the error lies in **chroma and hue**, at the edge of the gamut at high ink coverage—not in lightness, and not in the number of patches.
*   There are two distinct mechanisms at this edge, both resulting from printing in an unsuitable mode: **overinking** (chroma folds past the maximum) and **material holdout** (ink remains on the surface; DecorMatte, the only one without a fold).
*   The maximum chroma `t*` is unique per hue; there is no single limit for all colors. All 36 maximum chroma values across hue sectors form the gamut boundary. Limiting ink at `t*` costs ~5% of dark volume and 0% of the chroma boundary.
*   Transfer error between materials acts as a quality indicator for the print mode: the limit, calculated without knowledge of the error, captures 70% of the worst patches, and their exclusion yields +8 p.p. above a random exclusion control—a real, actionable signal, not a concession of gamut.
*   The remedies—ink limiting and correct media presets—are standard pre-press operations, not a new method. The open question is the ceiling for chroma and hue that persists even in the correct print mode.

---
*All numbers are reproducible via the open-source tool at [github.com/mik-nn/Color-Modeling](https://github.com/mik-nn/Color-Modeling); key scripts are `h45_inklimit_gamut.ts` and `h45c_control.ts`; the gamut boundary by chroma is calculated in `gamutVolume.ts` (`maxChromaPerHueBin`), and the ink limit by direction is in `inkLimitChroma.ts` (`chromaMaxT`).*