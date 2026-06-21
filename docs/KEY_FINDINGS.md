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

Epson HDX (P9000/P9900) is NOT a clean test: P9000 is 905-patch **M0**, P9900 is mostly
1728-patch **M2/UVcut** — different chart grid AND measurement condition, so the transfer is
asymmetric (P9900-chart→P9000 = 95%, but P9000-chart→P9900 = 39% < native 57%). This is a
measurement-setup mismatch, NOT an ink-system difference. (Note: the P9900 CIED+DevD parse is
correct; the earlier "P9900 = 11%" was a grid-mixing bug — see finding §2.) A clean Epson-HDX
test needs P9000 and P9900 measured the same way (same grid + same M-condition).
(`h44_cross_printer_transfer.ts`)
