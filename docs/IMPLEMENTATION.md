# IMPLEMENTATION.md — Code Map

> Snapshot of what each module does, as of commit f8cb1e8 (May 2026). See
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

| File | Role |
|---|---|
| `App.tsx` | Layout: `ProfileUploader` + `ProfileList` + `ComparisonView`. Dispatches uploads to `dataLoader`. |
| `store/useProfileStore.ts` | Zustand: `profiles`, `selectedProfiles` (max 2), `linearityResult`, selection actions. |

### 2.2 I/O

| File | Role |
|---|---|
| `lib/dataLoader.ts` | File-type dispatch (`.icm` → `icmParser`, `.cxf` → `cxfParser`). Wraps the result in `ProfileData` with a placeholder cleaning pipeline. |
| `lib/iccTagScanner.ts` | `extractZxmlCxfXml(buffer)`: locates the ZXML tag in an ICC profile, skips 12 bytes (4 data-type + 4 reserved + 4 unknown), `pako.inflate`s the rest, returns CxF XML. |
| `lib/parsers/icmParser.ts` | Parses ICC header (validates magic, reads tag count at byte 128), uses `extractZxmlCxfXml`, hands XML to `parseCxf3Xml`. Legacy synthetic-fallback path remains; do not extend it. |
| `lib/parsers/cxfParser.ts` | `parseCxf3Xml(xml)`: walks `cc:CxF` namespace, extracts `cc:Object/cc:ColorValues` per patch. Handles both M0 (`SpectralData`) and Lab-only objects. Multiple attribute naming conventions tolerated. |
| `lib/cgatsExport.ts` | CGATS.17 ASCII export. Fields: `SAMPLE_ID RGB_R RGB_G RGB_B LAB_L LAB_A LAB_B`. |

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

### 2.4 Analysers

| File | Purpose |
|---|---|
| `lib/analyzers/limitsAnalyzer.ts` | Per-channel ink-limit detection. `computeRampErrors` walks each primary ramp (C/M/Y) and 2-ink combos (CY/MY/CM), compares measured spectra to Yule-Nielsen (n = 2) interpolation between paper and primary endpoint, returns the first ink level where ΔE76 > 6. |
| `lib/analyzers/linearityAnalyzer.ts` | **Legacy.** Cross-profile linearity via Pearson r / R² / slope stability. Originally CMYK-fuzzy-match; current code path uses RGB via `MatchedPatchPair`. Slated for either rewrite under DeviceSpace abstraction or removal — see `TODO.md`. |
| `lib/analyzers/groupAnalyzer.ts` | Per-patch-group breakdown (primaries / neutrals / mixed). Used by the UI breakdown table. |
| `lib/analyzers/inkRatioAnalyzer.ts` | `T(λ) = R_ink / R_paper`. Per-channel Pearson r / MAD / scale CV — diagnostic for multiplicative substrate effects. |
| `lib/analyzers/spectralPredictor.ts` | Per-wavelength polynomial / YN / XYZ-affine predictors. Fits on a calibration subset, evaluates on test subset, returns `SpectralModelComparison` row. |
| `lib/analyzers/spreading.ts` | Polynomial dot-gain: `u_eff = a·u² + (1-a)·u` per channel. Constraints: `f(0)=0, f(1)=1`, monotone iff `a ≥ -0.5`. |
| `lib/analyzers/optimizer.ts` | Nelder-Mead simplex (pure TS, no deps). Used by `trainCYNSN3`. |
| `lib/analyzers/cynsn.ts` | 3D CYNSN model — see §3. |

### 2.5 UI components

| Component | What it shows |
|---|---|
| `ProfileUploader` | Drag-and-drop with visual feedback. |
| `ProfileList` | Loaded profiles, selection radios (max 2). |
| `ComparisonView` | The hub. Renders metadata cards, `LabScatterPlot`, `SpectralCurves`, `InkLimitSection`, `GroupBreakdownTable`, `InkRatioTable`, `PredictionAccuracyView`, `PatchCorrelationScatter`, plus the CYNSN comparison table. |
| `InkLimitSection` | Slider per channel; downstream analyses re-filter when limits change. |
| `MetricCard` | Reusable metric tile with colour-coded values. |

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

| v | C | M | Y | RGB | Name |
|---|---|---|---|---|---|
| 0 | 0 | 0 | 0 | 255,255,255 | Paper |
| 1 | 0 | 0 | 1 | 255,255,  0 | Yellow |
| 2 | 0 | 1 | 0 | 255,  0,255 | Magenta |
| 3 | 0 | 1 | 1 | 255,  0,  0 | Red |
| 4 | 1 | 0 | 0 |   0,255,255 | Cyan |
| 5 | 1 | 0 | 1 |   0,255,  0 | Green |
| 6 | 1 | 1 | 0 |   0,  0,255 | Blue |
| 7 | 1 | 1 | 1 |   0,  0,  0 | Black (CMY-stack) |

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

## 4. Testing

- `lib/colormath.test.ts` — `xyzToLab`, `deltaE00` (ISO 11664-6 reference pairs).
- `lib/analyzers/cynsn.test.ts` — `demichel3`, `findCell3`, grid builder, train/eval.
- `lib/analyzers/optimizer.test.ts` — Nelder-Mead on quadratic / Rosenbrock.
- `lib/analyzers/spreading.test.ts` — endpoint constraints, monotonicity.
- `lib/analyzers/linearityAnalyzer.test.ts` — basic linearity, fuzzy match (legacy).
- `lib/parsers/cxfParser.test.ts` — XML / Sample / spectral data.
- `utils/filenameParser.test.ts` — filename parsing.

`npm test` runs the full suite via Vitest. Local Node 12 cannot execute Vitest; rely on CI
(GitHub Actions, Node 20).

---

## 5. Known issues & deprecations

| Item | Status |
|---|---|
| `lib/cxFParser.ts`, `utils/cxfParser.test.ts` | Duplicates of canonical paths; delete in next refactor. |
| `linearityAnalyzer.ts` | Legacy CMYK fuzzy-match path. Either port to DeviceSpace or remove. |
| `icmParser` synthetic-fallback path | Deprecated. Do not extend. |
| Mixed `RGB_*` / `CMYK_*` fields on `Measurement` | Migrating to single `device: DeviceValue` discriminator. |
| CYNSN-2 grid/spreading mismatch | Documented in `docs/cynsn-pipeline.md` Bug 2; fix queued. |
| YN n-cap at 10 in CYNSN training | Documented as Bug 1; raise cap to 30. |
