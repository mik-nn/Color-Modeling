# EXPERIMENTS.md — Append-only experiment log

> Each row is one experiment. Newest at the top. Never edit a past row — append a new
> row when a result is superseded or corrected.

| Date | Experiment | Profiles | Commit | Key metric | Conclusion | Next step |
|---|---|---|---|---|---|---|
| 2026-05-22 | Ink-limit detection — Yule-Nielsen `n=2` vs linear `n=1` | All 27 P9000 RGB ICMs (C ramp, M ramp, Y ramp; CY/MY/CM combos where ≥ 8 patches available) | cc14bf6 | `n=1`: max ΔE76 = 17.8 on primary ramp (false limit at level 192/255). `n=2`: max ΔE76 = 5.3. Empirical optimum `n ≈ 2.7`: mean ΔE76 = 2.6. | Linear Neugebauer is wrong for Epson P9000 — the optics of real ink need Yule-Nielsen. False-positive ink limits at n=1. | Switch `limitsAnalyzer.computeRampErrors` to `n=2`; raise ΔE threshold from 2.0 to 6.0. Open question: should `n` be per-channel-fit instead of fixed 2? |
| 2026-05-21 | CYNSN-2 measured-grid override + primary-extraction collapse fix | Synthetic + sample of P9000 RGB profiles | f8cb1e8 | Primary extraction now returns 8 distinct corners (was collapsing onto one vertex when KNN tolerance was tight). CYNSN-2 grid now uses measured spectra at nodes within tolerance 0.08 of measured patches. | Both fixes land but **CYNSN-2 still under-performs YNSN** on real data because the training loss does not see the measured grid — it tunes spreading for the colorant grid, then the grid is swapped post-training. Documented as Bug 2 in `docs/cynsn-pipeline.md`. | Fix Bug 2: pass `grid_cynsn2` into `trainCYNSN3` and use it inside the loss. Re-measure ΔE00 deltas YNSN vs CYNSN-2 on the same profile set. |
| 2026-05-21 | CYNSN training stability — Yule-Nielsen `n` cap | Sample profile during CYNSN debugging | 87cae9a | Optimiser hits the `n = 10` cap on substrates where the true optimum is `n ≈ 15–20`; gradient ≈ 0 at the boundary, simplex stalls. | Hard cap distorts model. | Raise cap to 30 or replace with a soft penalty for very large `n`. Documented as Bug 1 in `docs/cynsn-pipeline.md`. |
| 2026-05-21 | Colormath `xyzToLab` precedence fix | Synthetic test pairs (ISO 11664-6) | a2ea011 | Pre-fix: incorrect L\* in a narrow XYZ range due to `-x/25**2` parsing as `-(x/(25**2))`. Post-fix: agreement with ISO reference within 1e-4 on Lab and within 1e-3 on ΔE00. | Operator precedence bug — `**` binds tighter than unary minus. Rewritten as `-(((x/25)**2))`. ISO tests pinned. | None — covered by `lib/colormath.test.ts`. |

---

## How to add a row

1. Add a row at the top of the table with: date (ISO), short experiment name, profiles
   used, commit SHA of the analyser version, the numeric key metric (with units),
   the one-sentence conclusion, and the next concrete step.
2. If the metric needs a chart, attach the screenshot under
   `docs/experiments/<date>-<slug>.png` and reference it inline.
3. If the experiment **invalidates** a previous row, add a new row that cites the older
   commit and states the new conclusion. Do not edit history.
4. Cross-reference the relevant `H1.x` from `docs/RESEARCH_HYPOTHESIS.md` in the
   conclusion column.
