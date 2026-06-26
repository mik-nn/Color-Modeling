# Article #2 plan — "Where Five Patches Fail"

> Sequel to "Five Patches Instead of a Thousand" (article #1, D1 + GA placement, ~5 patches,
> 27 papers + 2 printers). Article #1 sold the win. Article #2 is the **honest footnote made
> into the main story**: when the few-patch method fails, it fails in a specific, diagnosable
> way — and we can now tell two failure mechanisms apart and flag the at-risk patches per-pixel.

## Thesis (one sentence)

The ~12 % of substrate pairs the few-patch method can't reach fail **chromatically at the
gamut edge, not in lightness** — and that failure is a **symptom of printing in an unsuitable
mode for the medium**. Two flavors: **over-inking** (the chroma *fold* — past the chroma knee
extra ink subtracts saturation; the textbook ink-limit signature) and **media holdout**
(DecorMatte — the paper can't absorb the ink). The few-patch prediction error is a **sensor**
for both, and the cures are **known print-prep steps** (ink limiting, correct media preset) —
not new research. Our spectral chroma-max detector is, in effect, an automatic perceptual
ink-limit finder.

## Title options

1. **Where Five Patches Fail — and Why** (recommended; direct sequel framing)
2. Two Ways Ink Breaks at the Gamut Edge
3. The Honest Footnote: Anatomy of the 12 % Ceiling

## Audience / voice

Same as #1: color-management practitioners + technically curious print folks. First-person,
Michal Erlich. Honest about negatives (the series' credibility comes from publishing rejected
hypotheses). Reproducible: every number ties to a script in the open repo.

## Narrative arc

| § | Section | Beat | Backed by |
|---|---------|------|-----------|
| 1 | Recap & the footnote | Article #1 hit ~88–90 % same-mode. This piece is about the other ~12 %. | KEY_FINDINGS #1,#5 |
| 2 | The failure is chromatic, not lightness | Decompose the bad tail (ΔE>3) into ΔL\* vs ΔC\*,ΔH\*. ~99 % chroma-dominated on BOTH Epson and Canon. More anchors don't fix it (best-case GA placement still leaves chroma/light ≫1). | H40, hard_ga_attack, canon_fail_decomp |
| 3 | It lives at high ink coverage | ΔE scales monotonically with total C+M+Y (Spearman 0.71); worst patches = the gamut edge. | H18 coverage-bucket table |
| 4 | Mechanism A — the chroma fold (benign) | On 23/24 papers, a colorant ramp's chroma rises then **folds back** + hue rotates past a peak t\*. That peak is an **intrinsic ink limit**. Clip it → lose ~4–5 % dark-corner volume but **100 % of the chromatic boundary**. Gamut barely suffers. | H45a (gamutVolume.ts, inkLimitChroma.ts) |
| 4b | **Sidebar: "absolute" vs "masked" ink limit** | A limit can mean **rescale** (t\* becomes the new 100 % → the *corrected* ink-limited print mode) or **mask** (keep the mode, just stop trusting colors past t\*). This article's numbers are the **masked** regime (stats on the in-limit subset). Key point: the rescaled mode is not a scary unknown — it is the **right** mode; the original over-inked mode is the misconfiguration. The masked +8 pp **diagnoses** that misconfiguration. Characterizing the corrected mode needs new prints (future work), but the *fix* — ink limiting — is established practice with a citation. | KEY_FINDINGS #7 table |
| 5 | Mechanism B — the ink holdout (malignant) | DecorMatte: ink sits on the surface, reflectance *rises* at high coverage. The villain that breaks every model — and the **sole paper with NO chroma fold** (chroma rises monotonically to full ink). Different physics from A. | H35, H45 falsification (DecorMatte) |
| 6 | The prediction error is a mode-quality sensor | The intrinsic (error-blind) chroma-max limit predicts the failure region: 70 % worst-5 % recall; excluding it lifts transfer +8.0 pp **over a matched random-exclusion control** (random buys +0.3 pp). Read it not as "smaller gamut" but as: **few-patch error flags that the profile was built in an over-inked / unsuitable mode** — a per-patch quality signal. | H45d, H45c control |
| 7 | The fixes are known print-prep — link out | **Over-inking → ink limiting** (TIL/CIL): chroma-max t\* *is* a perceptual ink limit, and proper ink limiting is a solved problem — link to the prior article **[Pre-calibration of RGB Printers](https://mikchael.substack.com/p/pre-calibration-of-rgb-printers-moving)**. **Holdout → correct media preset.** The only genuinely open part is the residual **per-ink chromatic ceiling** after the mode is fixed → teases article #3 (per-ink chromatic model / CMYK-addressable dataset). | KEY_FINDINGS #5, #7; ink-limit article |
| 8 | Takeaways | (a) failures are chromatic edge effects; (b) two mechanisms, both = printing in an unsuitable mode; (c) few-patch error is a **mode-quality sensor**, and chroma-max is an automatic perceptual ink-limit finder; (d) the cures are known print-prep (ink limiting — link; correct media); (e) the residual chromatic ceiling after the mode is fixed is the open problem → article #3. | — |

## Figures (data already on disk)

1. **Chroma-vs-coverage curves**: a folder (e.g. Signa270) rising-then-folding vs DecorMatte monotone. Source: re-dump from `inkLimitChroma` (cyan/green ramps). The money shot for §4–5.
2. **ΔL vs ΔC,ΔH bar** for the failing tail (chroma ≫ lightness). Source: H40 / hard_ga_attack output.
3. **Coverage-bucket ΔE table/heatmap** (light→max ink: 1.2→1.2→2.8→5.2 median). Source: H18.
4. **Gamut hull before/after ink limit** (3D or 2D a\*b\* slices) showing chroma boundary preserved, dark corner trimmed. Source: `gamutVolume.ts` + `data/h45_inklimit_gamut.json`.
5. **Real-vs-mechanical bar**: pass-rate FULL 71.3 / random 71.6 / limit 79.6. Source: `data/h45c_control.json`. The credibility figure.
6. (optional) Worst-patch gamut-sector map (dark blue-violet / heavy-Y olive). Source: H18.

Reuse `docs/substack/make_figures.py` + `build_html.py` pipeline; add an H45 figure block.

## Key numbers to quote (verified)

- Failure tail: 99 % chroma-dominated (147/148 Canon; Epson same).
- Coverage correlation Spearman 0.712.
- 23/24 P9000 papers chroma-fold; DecorMatte the lone exception (Cyan 0→60.1, Green 0→72.1 monotone).
- Ink limit: ΔV 5.42 % median (dark corner), chroma-per-hue retention 100 %.
- Failure flag: worst-5 % over-limit recall 0.70.
- Real gain: +8.0 pp over random control (random +0.3 pp). REF-defined, deployable.
- corr(signFlip, spreadCurv) = 0.03 → the fold and the holdout are independent descriptors.

## Honest-framing guardrails (the series' brand)

- Do NOT claim the ink limit fixes the failures — it **flags** them; the holdout class is unfixed.
- Label H45c gain as "+8 pp over a random-exclusion control," never bare "+8 pp pass-rate."
- Keep the same-mode caveat from #1 (cross-mode is a different, harder problem).
- RGB-driver constraint restated: empirical Device-Space relationships, not a physical ink model.

## Scope decision

**Recommended:** article #2 = failure anatomy (above), H45 as the diagnostic lens. **Defer**
the H44 "one anchor chart per ink system" result to a separate article #3 (it's a clean,
self-contained logistics story and would dilute the failure-mechanism narrative here).

## Effort / what's left

All experiments + numbers exist. Work = (1) write prose ~2,500–3,500 words EN (plus a Russian
port, as for article 1), (2) generate 5–6 figures from existing JSON, (3) wire into the substack
HTML build. No new code or experiments required — this is a writing + figure task.
