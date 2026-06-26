# KEY_FINDINGS.md — Canonical durable conclusions

> The conclusions here are **load-bearing**: forgetting one wastes experiment runs and money.
> This file is the single source of truth for "what we already proved." If a finding here
> conflicts with an experiment row, the newer dated `EXPERIMENTS.md` row wins — update this file.
> Detailed methodology lives in the `cross-substrate-spectral-adaptation` skill; per-run numbers
> in `docs/EXPERIMENTS.md`; the public write-up in `docs/substack/article_substack.html`.

Validated on Epson SC-P9000 (27 RGB art-paper profiles) + replicated on Canon G2470. All
printers are **RGB-addressed** (driver hides physical CMYK; K=0 in the CMY model).

---

## 1. Regime — H4 gate is SAME-MODE only

H4 pass gate = **median ΔE₀₀ ≤ 1.5 AND P95 ≤ 3.0**, evaluated on **same-print-mode pairs**
(same print mode, different substrate). The method works *within one fixed print mode*.

**Cross-mode transfer (matte ↔ glossy) is a separate, much harder problem** — same-mode P9000
reaches ~90% (GA k=5) while cross-mode collapses to 7–22%. Never evaluate the few-patch method
on cross-mode pairs and call it a failure; that is the wrong regime.

## 2. Mandatory pre-filters before forming pairs

Drop these **before** building any pair set, in every experiment:

| Filter | Rule | Why |
|--------|------|-----|
| Metallic | drop `Silverada`, `VibranceMetallic`, `Metallic` | different base spectra → structural ceiling, not adaptable |
| AllureAq | drop `AllureAq` | 1550-patch grid (2 pages) ≠ standard 905 → corrupts device-coord alignment |
| spreadCurv-incompatible pair | drop pair where `classifyPairCompatibility(a,b).risk === 'warn'` (dCurv ≥ 0.137, H36) | the two substrates' ink-spreading optics differ structurally → no affine transform adapts them |
| **different device grid** | pair only when `patch_count` (chart grid) matches | mixing grids (e.g. P9900 905-patch M0 ZXML vs 1728-patch M2 CIED+DevD 12-cube) gives **only 12 exact device matches** — the rest k-NN-interpolated → fabricated ground truth |
| **different measurement condition** | pair only same M-condition (M0 vs M2/UVcut) | OBA separation assumes one condition; M2/UVcut already has OBA cut → not comparable to M0 |

Forgetting these deflates pass-rate (P9000 dropped from ~82% to 66% just by leaving metallics in;
P9900 read as 11% until same-grid pairing lifted it to ~35–57%).

## 3. Patch correspondence — by device coordinate

Match the same patch across profiles **by its RGB/CMYK device value**, never by row/col index
or `SAMPLE_ID`. Device values are the invariant; indices break across different grids.
`alignProfiles` already does this (exact device-key match, else k-NN IDW in device space).

## 4. Placement beats count — and GA placement beats all manual charts

For the Paper-Ratio + rank-5 residual predictor (D1), **which** patches matters more than **how many**:

| Chart (k=5 unless noted) | Pass rate (same-mode P9000) |
|--------------------------|-----------------------------|
| Trivial 5 (white + R,G,B,cyan) | 45.2% |
| Subtractive COV5 (white + C,M,Y + black) | 80.8% |
| Trivial manual 12 | 88.5% |
| **GA-evolved 5** | **90.4% in-sample / ~88% held-out (70/30)** |
| **GA-evolved 8** | **92.3%** |

- Optimal patches are **mid-coverage interior points**, NOT RGB cube corners.
- Replicated on Canon G2470 (+17–31 pp held-out vs manual) — device-general, not P9000-specific.
- **GA placement is THE method.** It requires measured profiles to evolve the chart. A fixed
  hand chart (COV5) needs 0 profiles to *select* but is the inferior fallback (80.8% vs 90.4%).

## 5. Structural ceiling — chromatic, not lightness

~12% of same-mode pairs fail regardless of patch budget (16.7% at the fixed S1-13 chart; GA
placement recovers part of it). The residual error concentrates in a ~20% tail and is
**chromatic (hue/chroma shift), not lightness** — a per-ink substrate interaction the
multiplicative paper-ratio model structurally cannot express. More anchors don't fix these
pairs; only a per-ink chromatic model or a CMYK-addressable dataset would.

## 6. H44 — anchor-set selection: how many profiles, and shared across which printers?

The deployable method (finding 4) is GA-evolved placement, which needs measured profiles to
optimize over. Two answered sub-questions:

**(a) How many profiles must the GA train on?** ~8 same-mode profiles to STABILIZE (P9000 k=5:
N=8 → 88.9% held-out, min 85%), plateau at N≈16 (98.8%). Below N≈6 the GA sees ≤2 same-mode
pairs and overfits (variance 29–93%) → use the fixed COV5 fallback instead. NOT "0 profiles":
0 only buys the inferior fixed chart; a fixed chart's coords being identical across a printer's
profiles is a **tautology** (shared RGB target grid), not an answer.
(`h44_profile_count_sweep.ts`)

**(b) Per-printer or per-ink-system?** Anchor sets transfer **within an ink system when the
chart grid AND measurement condition match.** Clean evidence — Canon dye (both M0, same grid):
the GA chart from G1430 scores 73% on G2470 (≈ its native 75%) and the G2470 chart scores 64% on
G1430 (≈ native 61%); sibling charts RGB-close (dist 52). A cross-ink-system chart (Epson on
Canon) drops ~25–30 pp (35–44%), and a GA sibling chart beats the fixed COV5 on Canon (73% vs 48%).
**Practice: evolve ONE chart per ink system (Epson HDX, Canon dye, Canon Lucia) from same-grid +
same-M-condition profiles, reuse across that family's printers.**

Epson HDR (SP7900 ↔ SP9900) = the **decisive clean confirmation**: two printers of the same ink
system measured with the SAME MOAB chart + condition (only print width differs) evolve the
**EXACT SAME** GA chart (RGB dist = 0) and it transfers at native quality (44% = 44%);
cross-ink-system charts score ~16 pp lower (28%). The low 44% absolute is just MOAB substrate
diversity (32 single-mode pairs) — the transfer (same = native ≫ cross) is the point.

So the per-ink-system verdict holds on BOTH a dye (Canon) and a pigment (Epson HDR) family when
measurement setups match. NOT a clean test: Epson HDX P9000(905/M0) ↔ P9900(1728/M2-UVcut) — they
differ in grid AND measurement condition, so transfer is asymmetric (a setup mismatch, not an ink
difference; the P9900 CIED+DevD parse itself is correct — the old "11%" was the §2 grid-mixing bug).
(`h44_cross_printer_transfer.ts`)

## 7. Ink-limit ≠ ink-holdout — two distinct gamut-edge mechanisms (H45)

A colorant ramp's chroma C*ab normally rises with ink; on most profiles it **rises then folds
back** (peaks at t* < 1, then desaturates + hue-rotates). That fold is an **intrinsic ink
limit** — clip device coverage at t*. This is real and ubiquitous: **23/24 P9000 profiles
fold** on at least one ramp.

- **Clipping at t* costs almost no gamut.** Chroma-per-hue-bin boundary retention = **100 %**;
  the only volume lost (~1.6–5 % on the clean Epson set, up to ~10 % on iPF8100) is the
  **dark low-L\* corner**, not the chromatic boundary. The user's "gamut barely suffers"
  intuition holds — for the chromatic boundary.
- **It captures most transfer failures and the gain is REAL.** The intrinsic (chroma-defined,
  error-blind) limit covers **70 % of the cross-substrate worst-5 % ΔE patches** (H45d) and
  improves a within-profile YN forward fit (median −0.66 ΔE). Excluding the over-limit region
  from the D1 test set lifts pass-rate **+8.0 pp over a matched-count random-exclusion control**
  (random exclusion buys only +0.3 pp → the effect is **not** test-set shrink), and it holds
  with a **REF-defined** limit (deployment-realistic). So the over-limit region is genuinely
  where transfer fails — the chroma-fold limit is a real, deployable failure-region *flag*.
- **The chroma-fold is NOT the H35/H40 ink-holdout.** `DecorMatte` — the canonical CanvasMatte
  holdout substrate — is the **sole non-folder** (chroma rises monotonically to full ink:
  Cyan 0→60, Green 0→72). The CanvasMatte failure class (Finding 5: per-ink chromatic
  hue/chroma remap at high mixed CMY) has **no chroma fold**, so an ink limit does not fix it.
  `corr(signFlip, spreadCurv) = 0.03` — independent descriptors.

**Practical:** an ink limit at the chroma maximum is a safe gamut-preserving cleanup (free
chroma boundary, sheds only dark-corner volume) and a useful failure-region *flag*, but it is
**not** the remedy for the ~12 % chromatic structural ceiling — that still needs the per-ink
chromatic model (Finding 5). (`h45_inklimit_gamut.ts`)

**Two ways to "apply" the limit — H45 is the masked one.** There is a real semantic fork that
must be stated explicitly:

| Regime | What it does | Print mode | Our prediction | Stats population |
|--------|--------------|------------|----------------|------------------|
| **(1) Absolute / rescale** | t\* becomes the new 100 %; device [0,255] re-maps to ink [0,t\*] | **NEW mode** (different linearization) | **invalid** — model was trained on the original mode; would need re-anchoring on re-printed limited data | n/a here |
| **(2) Masked / subset** | keep the mode; refuse / don't evaluate device values past t\* | **unchanged** | **valid** | **in-limit subset only** |

H45 implements **(2)** — `isOverLimit` excludes over-limit patches from evaluation; spectra and
print mode are untouched. So every H45 statistic (pass-rate, recall, forward residual) is on the
**in-limit subset of the original mode**. The achievable-gamut ΔV (~5 %, 100 % chroma) is
**interpretation-robust** (both regimes deposit ≤ t\* ink → same physical gamut ceiling); only
prediction validity differs.

**Reframe — the +8 pp is a DIAGNOSTIC, not a gamut concession.** The right reading of "excluding
the over-limit region recovers +8 pp (real, over a random control)" is **not** "declare a smaller
gamut." It is: **the over-limit region is unpredictable because the medium is being printed in an
unsuitable (over-inked) mode**, and that same over-inking degrades profile quality generally
(wasted ink, unstable color, the chroma fold / ink holdout). The cross-substrate prediction error
therefore acts as a **sensor for "this profile was built in a suboptimal print mode for this
medium."** Two flavors of the same problem:

- **Over-inking (the chroma fold, 23/24 papers):** past the chroma knee t\* extra ink subtracts
  chroma + rotates hue — the textbook signature of exceeding the useful ink limit. So our spectral
  chroma-max detector is effectively an **automatic perceptual ink-limit (CIL) finder**, and the
  remedy is the established practice of **ink limiting** (TIL/CIL) — see the prior article
  [Pre-calibration of RGB Printers](https://mikchael.substack.com/p/pre-calibration-of-rgb-printers-moving).
  Regime (1) is then not a scary uncharacterized mode; it is the **correct** mode that should have
  been used.
- **Media holdout (DecorMatte):** no chroma fold, yet worst pair — the paper can't absorb the ink
  at high coverage (H35). A different "unsuitable mode" (wrong media setting), fixed by media/mode
  selection, not by an ink cap.

Net: few-patch prediction failure is a **detector of an unsuitable print mode**; the cures
(ink limiting, correct media preset) are known print-prep steps with prior art to cite, not
open research. Characterizing the ink-limited mode on this dataset still needs new prints (future
work), but the *remedy* is not novel — the contribution is the spectral, perceptual detector.
