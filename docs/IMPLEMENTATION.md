# IMPLEMENTATION.md — Code Map

> Snapshot of what each module does, as of 2026-06-12 (H18). See
> `docs/progress-log.md` for the history that produced this state.

---

## 1. Stack

- React 18 + TypeScript 5 (strict) + Vite 8
- TailwindCSS 3 + D3 v7 + Zustand 4
- Vitest 4 + jsdom 25
- `pako` for zlib (ZXML CxF decompression)

No backend; everything runs in the browser. Sample data is read locally via the file
picker.

---

## 2. Module map

### 2.1 Entry & state

| File                       | Role                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `App.tsx`                  | Layout: `ProfileUploader` + `ProfileList` + tab bar (`Transfer` / `k-Sweep`). Dispatches uploads to `dataLoader`. Renders `TransferView` or `KSweepView` depending on active tab. |
| `store/useProfileStore.ts` | Zustand: `profiles`, `selectedProfiles` (max 2), `linearityResult`, selection actions.            |

### 2.2 I/O

| File                         | Role                                                                                                                                                                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/dataLoader.ts`          | File-type dispatch (`.icm` / `.icc` → `icmParser`, `.cxf` → `cxfParser`). Wraps the result in `ProfileData` with a placeholder cleaning pipeline.                                                                                                  |
| `lib/iccTagScanner.ts`       | `extractZxmlCxfXml(buffer)`: locates the ZXML tag in an ICC profile, skips 12 bytes (4 data-type + 4 reserved + 4 unknown), `pako.inflate`s the rest, returns CxF XML. `extractIccTextTag(buffer, sig)` reads ICC `text` tags such as MOAB `targ`. |
| `lib/parsers/icmParser.ts`   | Parses ICC header (validates magic, reads tag count at byte 128), tries ZXML CxF first, then falls back to CGATS.17 text in the `targ` ICC tag. Legacy synthetic-fallback path remains; do not extend it.                                          |
| `lib/parsers/cxfParser.ts`   | `parseCxf3Xml(xml)`: walks `cc:CxF` namespace, extracts `cc:Object/cc:ColorValues` per patch. Handles both M0 (`SpectralData`) and Lab-only objects. Multiple attribute naming conventions tolerated.                                              |
| `lib/parsers/cgatsParser.ts` | Reads CGATS.17 tables, normalises reflectance, derives D50 Lab. **SAMPLE_ID:** if absent, use `RGB_{R}_{G}_{B}` for cross-grid alignment (device value, not row index).                                                                              |
| `lib/cgatsExport.ts`         | CGATS.17 ASCII export. Fields: `SAMPLE_ID RGB_R RGB_G RGB_B LAB_L LAB_A LAB_B`.                                                                                                                                                                    |
| `utils/filenameParser.ts`    | Extracts profile metadata from BC underscore names and MOAB space-separated names. For CAE grouping, `metadata.printMode` is the final filename segment before extension (`USFA`, `Prem Luster`, `CanvasMatte`, etc.).                             |
| `scripts/exportCaeData.ts`   | One-shot exporter for Python CAE input. Recursively walks `data/profiles/` (now per-preset subfolders), accepts `.icm` and `.icc`, emits `print_mode`, and supports `CAE_PRINT_MODE` / `CAE_INK_MODE` filters for same-mode training sets.          |
| `utils/printMode.ts`         | `canonicalPrintMode(file\|meta)` → Epson media preset (`CanvasMatte`, `PremiumLuster`, …). Maps BC abbreviations (CanvasMatte, PLPP260, WCRW…) and MOAB names (Exh Canvas Matte, Prem Luster, USFA…) onto one canonical taxonomy; throws on unknown media. Exposes `ALL_PRESETS` and `OVERLAPPING_PRESETS` (the 3 cross-vendor presets). |
| `lib/interp/rgbInterp.ts`    | Scattered RGB→spectrum interpolation (per-band k-NN IDW in normalised RGB) to put profiles measured on different RGB charts onto a common lattice. `buildInterpolator`, `regularGrid`, `boundingBox`/`intersectBox`/`inBox`, `looRms` (interpolation noise floor).                                                                       |
| `lib/interp/wlsInterp.ts`    | **Default** mode-comparison interpolant. Per-band local-linear weighted-least-squares: fit `R(λ) ≈ β₀ + β·rgb` from k weighted neighbours, solve via Cholesky on the 4×4 normal equations, IDW fallback on collinear neighbours. Drops the BC chart's interpolation noise floor from ~1.8 ΔE00 (IDW) to ~0.7 ΔE00.                       |
| `lib/interp/pcaInterp.ts`    | Opt-in (`MODE_INTERP=pca`). PCA in spectrum space (Jacobi eigensolver) + score-space IDW. Exports `jacobiEigen` for reuse by H5 SVD experiment. Negative result on this dataset — kept as a research tool. |
| `lib/dataset/matrix.ts`      | `loadProfileMatrix` (ProfileData → dense X/D matrices), `alignProfiles` (device-coordinate alignment: exact match + k-NN IDW interp fallback, drops out-of-gamut points). Matching is by device coordinate, never by position/ID.                |
| `scripts/reorgByMode.ts`     | Reorganises `data/profiles/` into per-Epson-preset subfolders via `canonicalPrintMode` (`git mv` tracked, `mv` untracked). Dry-run by default; `--apply` executes.                                                                                 |
| `scripts/experiments/modeCompare.ts` | H11 print-mode comparison. Per-preset profile tables (paper Lab, OBA) + within-mode and cross-set BC↔MOAB ΔE00 on the common grid. Writes `docs/mode-comparison.md` + a JSON dump.                                                          |

**Duplicate to remove (TODO):** `lib/cxFParser.ts` (137 lines) and
`utils/cxfParser.test.ts` are leftovers from the old layout. The canonical paths are
`lib/parsers/cxfParser.ts` and `lib/parsers/cxfParser.test.ts`.

### 2.3 Colour math

`lib/colormath.ts` exports:

- `spectraToXYZ(reflectance, startWL = 380)` — CIE 1931 2° / D50, returns `{X, Y, Z}` with
  Y normalised to 100.
- `xyzToLab(X, Y, Z)` — D50 white point.
- `spectraToLab(reflectance, startWL)` — composition of the above.
- `deltaE00(L1, a1, b1, L2, a2, b2)` — full CIEDE2000, ISO 11664-6 compliant.

Tests in `lib/colormath.test.ts` cover ISO reference pairs.

### 2.4 Single-profile analysers

| File                                 | Purpose                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/analyzers/limitsAnalyzer.ts`    | Per-channel ink-limit detection. `computeRampErrors` walks each primary ramp (C/M/Y) and 2-ink combos (CY/MY/CM), compares measured spectra to Yule-Nielsen (n = 2) interpolation between paper and primary endpoint, returns the first ink level where ΔE76 > 6. |
| `lib/analyzers/linearityAnalyzer.ts` | **Legacy.** Cross-profile linearity via Pearson r / R² / slope stability. Originally CMYK-fuzzy-match; current code path uses RGB via `MatchedPatchPair`. Slated for either rewrite under DeviceSpace abstraction or removal — see `TODO.md`.                     |
| `lib/analyzers/groupAnalyzer.ts`     | Per-patch-group breakdown (primaries / neutrals / mixed). Used by the UI breakdown table.                                                                                                                                                                         |
| `lib/analyzers/inkRatioAnalyzer.ts`  | `T(λ) = R_ink / R_paper`. Per-channel Pearson r / MAD / scale CV — diagnostic for multiplicative substrate effects.                                                                                                                                               |
| `lib/analyzers/spectralPredictor.ts` | Per-wavelength polynomial / YN / XYZ-affine predictors. Fits on a calibration subset, evaluates on test subset, returns `SpectralModelComparison` row.                                                                                                            |
| `lib/analyzers/spreading.ts`         | Polynomial dot-gain: `u_eff = a·u² + (1-a)·u` per channel. Constraints: `f(0)=0, f(1)=1`, monotone iff `a ≥ -0.5`.                                                                                                                                                |
| `lib/analyzers/optimizer.ts`         | Nelder-Mead simplex (pure TS, no deps). Used by `trainCYNSN3`.                                                                                                                                                                                                    |
| `lib/analyzers/cynsn.ts`             | **Retired (2026-05-29).** 3D CYNSN model — kept for reference but removed from UI (Phase 2 withdrawn, H1 retracted). Replaced by data-driven transfer predictors.                                                                                                   |

### 2.4.1 Cross-substrate transfer predictors (Phase 2′ — data-driven)

| File                               | Predictor | Purpose                                                                                                                                                                              |
| ---------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/predict/perLambdaAffine.ts`   | **A3** | Per-wavelength affine: `R_B(λ) ≈ α(λ) · R_A(λ) + β(λ)`. 72 free params. Baseline empirical model; no structural assumption.                                                         |
| `lib/predict/paperRatioResidual.ts` | **D1** | Paper-relative ratio + rank-≤N PCA residual (`residualRank`, default 5). Exploits multiplicative substrate model: `R_B ≈ (R_paper_B / R_paper_A) ⊙ R_A + PCA residual` (H4). Works best on non-OBA pairs. Default rank=5 comes from H5 (median effective rank). Per-band UV clamp on 380–410 nm (`uvBandCount=4` in TransferView). **Limitation (H18):** error scales monotonically with total ink coverage (C+M+Y); P95 reaches 6–8 ΔE00 at maximum ink density regardless of gamut sector. |
| `lib/predict/poolPCATransfer.ts`   | **B3** | Pool-PCA basis (all 27 profiles) vs reference-only PCA. Chosen when paper-white ΔE76 > 5; tests H6.                                                                                |
| `lib/predict/perLambdaCurve.ts`    | **C7** | Per-λ monotone curve fitted from anchors. Paired with S3 ramp anchors; minimal-measurement cross-substrate (H9). Fits `f_λ(A→B)` per wavelength, applies uniformly.                 |
| `lib/predict/cae.ts`               | **CAE_D7** | Conditional Autoencoder, trained per-print-mode on D7-cleaned profiles (commit 706a51b). Architecture: substrate encoder [paper(36) + ID(N)] → 8-dim latent; spectrum encoder [R(36) + RGB(3) + sub_lat(8)] → 16-dim latent; decoder → R(36). H10b: fine-tune `substrate_latent_B` on k=13 S1 anchors at inference (Adam, 200 steps, lr=0.05). Per-mode pools (WCRW/USFA/CanvasMatte) + L2 regularisation (`--l2-init 0.1` default). `CAEForward` class is exported for direct use in LOO optimizer. |
| `lib/analyzers/dynamicLOO.ts`      | **CAE_LOO** | Dynamic LOO substrate latent optimization (H14). For each target profile, builds a same-mode support set `S = AllProfiles_mode \ {Target}` — **all** profiles of the mode, not only those loaded in the current UI session. **Before** the optimizer loop, every support profile is WLS-interpolated onto the target's exact RGB device grid (N_target × 3) so that the Nelder-Mead loss is computed at identical device locations across all support profiles (H14 invariant: one common RGB grid). Optimizes substrate latent θ: loss = spectral MSE over support spectra (real profile one-hot IDs for ink encoder, only decoder substrate θ is free) + few-shot term on k=3 target anchor patches. Init θ from `encodeSubstrate(targetPaper, null_id)`. Final prediction via `runCAETransfer(..., overrideSubstrateLatent=θ)`. Support-set construction is in `TransferView.tsx` (not inside this module). |

### 2.4.2 Anchor sampling strategies

| File                           | Strategy | Purpose                                                                                                                                          |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `lib/sampling/heuristic.ts`    | **S1** | Forced set: paper + RGB corners (8) + black + neutrals. Total k=13. Baseline; comprehensive coverage.                                          |
| `lib/sampling/channelRamp.ts`  | **S3** | Single-channel or neutral ramps (k=5). For H9: test if per-λ substrate transform `f_λ` shared across inks. Neutral ramps work; cyan ramps fail. |
| `lib/sampling/labSaturation.ts` | **S4** | Lab-saturation anchors: paper + high-chroma patches. Experimental; rejected on OBA-disparate pairs (H12).                                       |

### 2.4.3 Experiment harness

| File | Purpose |
| ---- | ------- |
| `lib/experiments/kSweep.ts` | `runKSweep(profiles, opts)` — enumerate directed profile pairs, classify same-mode/cross-mode via `canonicalPrintMode`, run greedy and D-optimal anchor strategies for each predictor (D1/C7) at each k in `kGrid`, aggregate pass-fraction and median ΔE00. `dOptimalAnchors(X_A, N, L, paperRowIdx, k)` — greedy Gram-Schmidt in PCA space of `X_A`, maximises volume in leading PC subspace (proxy for residual space). Returns `KSweepResult` with `perK` rows and `minKToPass` summary. H4 gate: median ≤1.5 AND p95 ≤3.0. |
| `lib/experiments/kSweep.worker.ts` | Web Worker wrapper for `runKSweep`. Posts `{type:'progress', done, total}` ticks and `{type:'done', result}`. Keeps sweep off the main thread. |
| `lib/experiments/kSweep.test.ts` | 9 unit tests: `dOptimalAnchors` invariants + `runKSweep` on 60-patch synthetic fixture (minimum-overlap guard: `al.N < 50` aborts alignment via `alignProfiles`). |

### 2.4.4 Standalone diagnostic experiment scripts (`scripts/experiments/`)

Each script is run via `npx tsx scripts/experiments/<name>.ts` from `frontend/`. Results are
appended to `docs/EXPERIMENTS.md` and written to `data/cae-input/<name>.json`.

| File | Hypothesis | Purpose & key result |
| ---- | ---------- | -------------------- |
| `h12_oba_scale.ts` | H12 | OBA scale anchor strategy (S4). Rejected: Lab-saturation anchors hurt OBA-disparate pairs. |
| `h13_diagnose.ts` | H13 | D1 residual rank sweep 1–10 on CanvasMatte same-mode pairs. Confirmed median effective rank ≈5 (H5). |
| `h13_m0m2.ts` | H13b/c | M0/M2 OBA emission model at anchors. Full-mode batch (98 BC same-mode pairs). D7 default ON. |
| `h14_ink_diagnostic.ts` | H14 | CAE_LOO dynamic substrate latent optimization. Confirms H14 invariant: common RGB grid required. |
| `h15_cyan_anchors.ts` | H15 | S1 + 4 cyan-ramp anchors (S5). Rejected: no P95 improvement on Canvas Matte; multiplicative model structurally biased. |
| `h16_redband_yn.ts` | H16 | Per-substrate YN exponent at 640–680 nm from cyan ramp. Rejected: catastrophic regression on M-laden patches (unmasked), null effect (masked). |
| `h17_residual_bands.ts` | H17 | Per-band spectral error decomposition for P95 group. Rejected as stated: UV/VIS ratio=0.933. Unexpected: error concentrated at 530–580 nm in dark blue-violet (C+M-heavy) patches. |
| `h18_ink_coverage.ts` | H18 | Spearman correlation (ink vs ΔE00 / 530–580nm err) + S1 augmented with 3 high-CMY anchors. H18a confirmed (r=0.712), H18b rejected (r=−0.12), H18c confirmed (P95 6.42→4.79, Δ=1.63). |
| `h19_high_y_anchors.ts` | H19a/b | Heavy-Y anchors + rank=8 variants on DecorMatte→ChromataWhite. H19a rejected (P95 regresses), H19b just misses gate (ΔP95=0.934). Best combined (h19bc): P95=4.724. |
| `h19_batch_rank.ts` | H19c | rank=5 vs rank=8 D1 on 114 same-mode BC pairs. Both: 95/114 pass (83.3%) — rank increase gives zero benefit. |
| `h19_ksweep_dopt.ts` | min-k | Greedy vs D-optimal k=6..13 on 114 same-mode pairs. **Greedy k=8 = 78.1%** (paper+7 corners); D-optimal dramatically worse (21.9% at k=8). Article claim: 8 heuristic patches = 78% pass. |

### 2.5 UI components

| Component         | What it shows                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProfileUploader` | Drag-and-drop with visual feedback.                                                                                                                                                                                   |
| `ProfileList`     | Loaded profiles, selection radios (max 2).                                                                                                                                                                            |
| `ComparisonView`  | The hub. Renders metadata cards, `LabScatterPlot`, `SpectralCurves`, `InkLimitSection`, `GroupBreakdownTable`, `InkRatioTable`, `PredictionAccuracyView`, `PatchCorrelationScatter`, plus the CYNSN comparison table. |
| `InkLimitSection` | Slider per channel; downstream analyses re-filter when limits change.                                                                                                                                                 |
| `MetricCard`      | Reusable metric tile with colour-coded values.                                                                                                                                                                        |
| `KSweepView`      | k-sweep experiment tab. Controls: predictor checkboxes (D1/C7), anchor strategy (greedy/dOptimal), slice radio, max-pairs limit. Runs sweep via `kSweep.worker.ts`, shows progress bar, D3 line charts (pass-fraction vs k, median-of-medians vs k), min-k summary table, CSV export. |

---

## 3. CYNSN model (Phase 2)

Detailed flow in `docs/cynsn-pipeline.md`. Summary:

### 3.1 Device-space mapping

RGB profiles only (current dataset). K is implicitly 0.

```text
C = (255 - R) / 255
M = (255 - G) / 255
Y = (255 - B) / 255
```

### 3.2 8 Neugebauer primaries (3D CMY)

| v   | C   | M   | Y   | RGB         | Name              |
| --- | --- | --- | --- | ----------- | ----------------- |
| 0   | 0   | 0   | 0   | 255,255,255 | Paper             |
| 1   | 0   | 0   | 1   | 255,255, 0  | Yellow            |
| 2   | 0   | 1   | 0   | 255, 0,255  | Magenta           |
| 3   | 0   | 1   | 1   | 255, 0, 0   | Red               |
| 4   | 1   | 0   | 0   | 0,255,255   | Cyan              |
| 5   | 1   | 0   | 1   | 0,255, 0    | Green             |
| 6   | 1   | 1   | 0   | 0, 0,255    | Blue              |
| 7   | 1   | 1   | 1   | 0, 0, 0     | Black (CMY-stack) |

Extracted from measured patches via `extractNeugebauerPrimaries3` (KNN, tolerance 0.10).

### 3.3 Demichel weights (3D)

$$w_v = C^{c_v}(1-C)^{1-c_v} \cdot M^{m_v}(1-M)^{1-m_v} \cdot Y^{y_v}(1-Y)^{1-y_v}$$

where $(c_v, m_v, y_v)$ are the bits of vertex index $v$.

### 3.4 YNSN spectral forward formula

$$R(\lambda) = \left( \sum_v w_v \cdot R_v(\lambda)^{1/n} \right)^{n}$$

### 3.5 Ink spreading (dot gain)

Per-channel polynomial `u_eff = a·u² + (1-a)·u`, 1 DOF per channel. Total: 3 spreading
parameters + 1 Yule-Nielsen exponent = 4 reals.

### 3.6 Training loop

Nelder-Mead on `x = [a_C, a_M, a_Y, log n]`. Loss:

```text
loss = mean ΔE00(R_pred, R_cal)
     + 1e-4 · ‖a‖²                  (L2 regularisation)
     + 10.0 · Σ max(0, -a - 0.5)²   (monotonicity penalty)
```

### 3.7 CYNSN-2

Subdivides the colorant cube once → 27 nodes (3×3×3). Nodes within tolerance 0.08 of a
measured patch are overridden with measured spectra; the rest use the YNSN colorant
formula. **Known issue:** training loop ignores the measured-grid override (see
`docs/cynsn-pipeline.md` Bug 2). Fix pending.

---

## 4. CAE Python Training Data

| File | Purpose |
| --- | --- |
| `python/cae/dataset.py` | `ProfileBank` loads exported JSON profiles. **Current alignment:** takes the intersection of rounded RGB keys across all profiles (`common_keys &= …`). This collapses to N ≈ 10 when mixed BC+MOAB grids are in the same pool (root cause of the "N=10 / k_effective=5" failure in H10b full-pool result). **Required fix (H14 invariant):** for LOO training each LOO fold must interpolate all non-target profiles onto the target's RGB grid (WLS in device space) rather than restricting to the raw intersection. Per-mode pools that are homogeneous (all BC or all MOAB) avoid the collapse — but the correct long-term approach is WLS normalisation to a reference grid for any mixed pool. |
| `python/cae/train.py` | Trains raw/D7 CAE variants. LOO split: trains on **all** profiles of the mode except the held-out target (the LOO fold), not a fixed 80/20 random split. If `split.json` does not match the filtered export payload, it creates a deterministic split from available profile names. |

---

## 5. Testing

- `lib/colormath.test.ts` — `xyzToLab`, `deltaE00` (ISO 11664-6 reference pairs).
- `lib/analyzers/cynsn.test.ts` — `demichel3`, `findCell3`, grid builder, train/eval.
- `lib/analyzers/optimizer.test.ts` — Nelder-Mead on quadratic / Rosenbrock.
- `lib/analyzers/spreading.test.ts` — endpoint constraints, monotonicity.
- `lib/analyzers/linearityAnalyzer.test.ts` — basic linearity, fuzzy match (legacy).
- `lib/parsers/cxfParser.test.ts` — XML / Sample / spectral data.
- `lib/parsers/cgatsParser.test.ts` — ICC text-tag CGATS tables, percent reflectance,
  missing spectral columns.
- `lib/iccTagScanner.test.ts` — ICC `text` tag extraction for `targ`-style payloads.
- `utils/filenameParser.test.ts` — filename parsing.
- `lib/experiments/kSweep.test.ts` — `dOptimalAnchors` invariants + `runKSweep` aggregation on synthetic fixture.

`npm test` runs the full suite via Vitest. Local Node 12 cannot execute Vitest; rely on CI
(GitHub Actions, Node 20).

---

## 6. Known issues & deprecations

| Item                                             | Status                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `lib/cxFParser.ts`, `utils/cxfParser.test.ts`    | Duplicates of canonical paths; delete in next refactor.             |
| `linearityAnalyzer.ts`                           | Legacy CMYK fuzzy-match path. Either port to DeviceSpace or remove. |
| `icmParser` synthetic-fallback path              | Deprecated. Do not extend.                                          |
| Mixed `RGB_*` / `CMYK_*` fields on `Measurement` | Migrating to single `device: DeviceValue` discriminator.            |
| CYNSN-2 grid/spreading mismatch                  | Documented in `docs/cynsn-pipeline.md` Bug 2; fix queued.           |
| YN n-cap at 10 in CYNSN training                 | Documented as Bug 1; raise cap to 30.                               |
