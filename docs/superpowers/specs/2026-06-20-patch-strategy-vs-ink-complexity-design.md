# H44 — Patch count & placement vs printer ink-complexity (design)

**Date:** 2026-06-20
**Status:** approved frame, pending spec review
**Script:** `frontend/scripts/experiments/h44_ink_complexity_patches.ts`

## Problem (user)

Production constraint: **never** a large per-print-mode dataset, often **1 profile
per mode**. Always known: the printer's **colorant set** (ink count + composition).
Deliverable: a patch-selection **strategy** under profile scarcity, plus a rule for
the patch count k — using the known colorant structure.

## Key empirical fact (this session)

ALL printers in the dataset are **RGB-addressed** (`prtr` / `RGB ` color space),
regardless of 4 / 10 / 12 physical inks. There is NO CMYK/CMYKOG addressing
anywhere. So the testable axis is **physical ink complexity / gamut**, under
constant RGB addressing — not addressable channel count.

## Hypotheses (headline: A + B)

- **A — count:** the patch count k needed to clear the H4 gate **increases with
  physical ink complexity** (richer ink set → higher-rank cross-substrate spectral
  residual → more patches).
- **B — placement:** the optimal **RGB patch placement** depends on the printer's
  gamut / ink set (a 12-ink extended gamut samples different RGB directions than a
  4-ink dye printer). Tested via per-printer GA-evolved charts.

## Data ladder (ALL printers — nothing deferred)

| Tier | Printer | Physical inks | Spectral source | Parser status |
|---|---|---|---|---|
| low | Canon G2470 desktop | ~4–5 (dye color) | ZXML→CxF / prior | ready (prior exp) |
| mid | Epson P9000 | ~10–11 pigment | ZXML→CxF | ready |
| mid | Epson P9900 | ~10–11 pigment | `.icm` ZXML; `.icc` CIED+DevD | `.icm` ready; `.icc` via parser ext |
| high | Canon iPF4100 | 12 pigment | ZXML→CxF (in .zip) | unzip → ready |
| high | Canon iPF8100 | 12 pigment | MOAB `targ` / BC CIED+DevD | via parser ext |

Confound (stated honestly): the gradient is non-uniform (4 → 10 → 12) and the low
tier (desktop) is **dye**, the rest **pigment**. The clean count-gradient is
**Epson 10 vs iPF 12 (both pigment)**; desktop is an extreme low anchor with a
dye caveat. Prior Canon-desktop lower pass-rates conflate ink-count with substrate
set + dye chromatic outliers → A is judged primarily on min-k within pigment
printers and on a **same-substrate subset** (same BC media appears on all printers).

## Prep step 0 — parser extension (SAME parser, not a new one)

Proven minimal this session (`parseCgats17Text` in `cgatsParser.ts`):

1. **Regex:** `spectralWavelength` currently matches only `SPECTRAL_NM_\d+`.
   Extend to `^(?:SPECTRAL_NM_|nm|R_)(\d{3})$` → reads `nm380` (CIED) and `R_380`
   (MOAB targ). Unlocks iPF8100 MOAB `targ` fully (RGB + 36 bands + 1728 rows in one tag).
2. **CIED+DevD join:** BC iPF8100 / P9900 `.icc` store spectral in `CIED`
   (SampleID + nm380..) and RGB in `DevD` (SampleID + RGB_R/G/B), both 1728 rows.
   Add a join-on-SampleID helper that merges into the parser's row model, then
   reuse the same downstream path. `icmParser.parseIcmFile` gains a `CIED` branch
   after the `targ` branch.

Both are EXTENSIONS to the existing CGATS parser. DDD requirements: unit test in
`cgatsParser.test.ts` (one CIED-join fixture, one `nm`/`R_` column fixture),
update `docs/IMPLEMENTATION.md`, append `docs/progress-log.md`.

## Alignment

By **RGB device value** (nearest-patch), the project's established principle —
NOT by position/SAMPLE index. Heterogeneous grids (P9000 905, iPF8100 1728=12³,
desktop 294) align via nearest-RGB. Colorant-chart RGB targets map to each grid's
nearest patch. Same-substrate cross-printer pairs use the shared-RGB intersection.

## Method

1. **Prep:** parser ext (step 0); unzip iPF4100 `.zip`, strip `Zone.Identifier`,
   verify each profile parses (RGB + spectral), log drops.
2. **Pre-gate:** `spreadCurv.ts` per-profile `s560`; drop nonlinear outliers
   (`|s560 − median| ≥ SPREADCURV_FAIL_THRESHOLD`) per printer. Log drops.
3. **Build & cache** aligned + OBA-cleaned same-mode pairs per printer (`Built`
   pattern from `epson_ga_permode.ts`). Also build same-substrate cross-printer
   pairs (context, not headline).
4. **A — min-k:** colorant-derived RGB chart family k ∈ {5, 6, 8, 12}
   (+ 16 probe for iPF). Eval H4 (median ΔE00 ≤ 1.5 AND P95 ≤ 3.0) on non-anchor
   patches via existing D1 pipeline, per printer / mode. min-k = smallest k whose
   pass clears the gate. Compare min-k / pass-at-fixed-k across the ladder.
5. **B — placement:** per-printer GA-evolved chart (k=5, k=8). Compare evolved RGB
   targets across printers (coverage histogram, primary/secondary/interior
   breakdown, pairwise RGB distance). B confirmed if best charts differ
   systematically by gamut. GA also = unreachable ceiling for the colorant charts.

## Chart family (colorant geometry, 0 profiles to construct)

| k | Composition (CMY-model colorant geometry in RGB device space) |
|---|---|
| 5 | C, M, Y primaries + white + 1 neutral |
| 6 | H31 coverage: + black (full CMY) |
| 8 | + secondaries R, G, B |
| 12 | + 2nd coverage level on primaries + mid-coverage interior + 2nd neutral |
| 16 | iPF probe: + extended-gamut directions |

## Metrics & output

- Per (printer, mode, k, chart): H4 pass-rate, median-of-medians, P95.
- **A:** min-k vs ink-complexity table + plot (pass vs k, one line per printer).
- **B:** GA placement-comparison figure (coverage histograms per printer).
- `docs/EXPERIMENTS.md` row + `docs/progress-log.md` entry.
- Plot `docs/experiments/2026-06-20-h44-ink-complexity.png`.

## Deliverable answers

1. **k for a printer of given ink complexity** = empirical min-k from the ladder.
2. **Placement depends on ink set?** = A/B verdict from per-printer GA charts.
3. **Strategy under scarcity** = fixed colorant-derived RGB chart (0 profiles to
   design); the available profile(s) are only the adaptation reference.
4. **all-printer vs mode-matched selection** = dissolved for chart DESIGN (chart =
   colorant geometry, no profile pool needed); profiles only serve adaptation.

## Out of scope (YAGNI)

- CMYK/CMYKOG addressing (absent from all data).
- Substrate-disjoint CV (27 profiles underpower it — prior finding).
- New adaptation models (uses existing D1 pipeline unchanged).
- Per-ink chromatic-remap model (named as the structural-floor frontier; separate experiment).
