# Spec: Device-Coordinate Profile Alignment

**Date:** 2026-06-09
**Status:** Approved (design) → pending implementation
**Replaces:** `alignByCommonSampleIds` + `alignByDeviceGrid` (both deleted)

---

## 1. Problem

Cross-profile comparison currently matches patches by **string `SAMPLE_ID`**, and
`cxfParser.ts` emits position-based IDs (`R{row}C{col}P{page}`). Two profiles printed on
different substrates but laid out on different charts (e.g. 905-patch BC vs 1550-patch
2-page AllureAq) will **not** match even when their RGB device values are identical.

**Principle (non-negotiable):** patches must be matched by **device coordinate**
(RGB or CMYK), never by position index or string ID. Device values are the invariant
across files; positions are not.

Secondary problem: alignment logic is **duplicated** in two call-sites
(`TransferView.tsx`, `kSweep.ts`) as an identical threshold=50 switch between an exact path
and a grid path.

---

## 2. Contract

### 2.1 New function — `alignProfiles`

`frontend/src/lib/dataset/matrix.ts`

```ts
export interface AlignedProfiles {
  /** Display labels (device-encoded: "RGB_{r}_{g}_{b}") in row order. */
  sampleIds: string[]
  /** N×L reflectance for reference A — always REAL measured spectra. */
  X_A: Float64Array
  /** N×L reflectance for target B — exact where B has the point, else interpolated. */
  X_B: Float64Array
  /** N×channels device coordinates (A's actual sampled points). */
  D: Float64Array
  channels: 3 | 4
  N: number
  L: number
  /** B patches matched exactly by device coordinate. */
  exactCount: number
  /** B patches reconstructed by k-NN IDW interpolation. */
  interpCount: number
  /** A points dropped because they fall outside B's device bounding box. */
  droppedOutOfGamut: number
  /** Interpolation noise floor (LOO RMS reflectance over B); null when interpCount === 0. */
  looRms: number | null
}

export function alignProfiles(
  a: ProfileMatrices,
  b: ProfileMatrices,
  opts?: { k?: number; power?: number },
): AlignedProfiles
```

### 2.2 Algorithm

Query grid = **A's actual device points** (chosen over a synthetic regular grid so A keeps
its real measured spectra). For each A row `i` with device coordinate `d_i`:

| Step | Rule |
|------|------|
| 1 | `X_A[i] = A.X[i]` — always A's real spectrum. |
| 2 | Build B lookup: `Map<deviceKey, rowIndex>` where `deviceKey` = quantized device tuple (RGB → integer; CMYK → 2-decimal). |
| 3 | If `d_i` ∈ B map → `X_B[i] = B.X[matchRow]`, `exactCount++`. |
| 4 | Else if `d_i` inside B's bounding box → `X_B[i] = ` k-NN IDW interp from B, `interpCount++`. |
| 5 | Else (`d_i` outside B gamut) → **drop row**, `droppedOutOfGamut++` (no extrapolation). |

`looRms` computed via `looRms(bPoints, opts)` only when `interpCount > 0`.

### 2.3 Device-space handling (CLAUDE.md §3.2)

| Channel count | Exact path | Interp path |
|---------------|-----------|-------------|
| 3 (RGB) | ✅ | ✅ (`rgbInterp` 3D IDW) |
| 4 (CMYK) | ✅ | ❌ `throw` — "CMYK interpolation not yet implemented; need 4D IDW" |

Mixed-channel pair (`a.channels !== b.channels`) → `throw`.
Wavelength mismatch (`a.L !== b.L`) → `throw`.

### 2.4 Unified behavior

| Case | Result |
|------|--------|
| Same chart (identical RGB grid) | every A point exact-matches → `interpCount=0`, `looRms=null`; identical to old exact path but A keeps real spectra (already did). |
| Different charts | B interpolated onto A's grid; A real. Old grid path resampled **both** — this is strictly better (A no longer lossy). |
| Barely-overlapping gamuts | most A rows dropped → caller checks `N` and surfaces error. |

---

## 3. Parser change — `cxfParser.ts`

`parseCxf3Xml` must emit device-encoded `SAMPLE_ID` matching `cgatsParser` convention:

- `SAMPLE_ID = RGB_{r}_{g}_{b}` when RGB device values present (rounded int).
- Within-file Target↔Measurement link **stays by position** (`Row:Col:Page`) — that is how
  i1Profiler associates a requested device value with its measured spectrum; correct and unchanged.
- Fallback when no RGB (Measurement without Target): keep `P{n}` ordinal. Such rows have no
  `device` field, so `loadProfileMatrix` already drops them — no fabricated coordinates.

`SAMPLE_ID` becomes a display/export label; matching keys off the numeric `D` matrix, not the string.

---

## 4. Call-site changes

Both call-sites collapse the duplicated threshold-switch into one `alignProfiles` call.

### 4.1 `TransferView.tsx` (~line 274–322)

Replace the `if (aligned.sampleIds.length >= 50) … else if … else` block with:

```ts
const al = alignProfiles(A, B)
if (al.N < 50) return { kind: 'error', error: `Only ${al.N} aligned patches (gamut overlap too small).` }
// X_A = al.X_A, X_B = al.X_B, D_B = al.D, sampleIds = al.sampleIds, N = al.N
const crossChart = al.interpCount > 0
```

UI: show `exactCount / interpCount / looRms` (replaces the `crossChart` shared-SAMPLE_IDs label).

### 4.2 `kSweep.ts` `_buildPairMatrices` (~line 420–444)

Same collapse. Returns `null` when `al.N < 50` (preserves current skip behavior).

### 4.3 Deletions

- `alignByCommonSampleIds` — delete.
- `alignByDeviceGrid` — delete.
- `matrix.test.ts` — replace both describe-blocks with `alignProfiles` tests.
- `perLambdaAffine.ts` comment ref to `alignByCommonSampleIds` — update to `alignProfiles`.

`rgbInterp.ts` helpers: `boundingBox`/`inBox` used by step 4–5. `regularGrid`/`intersectBox`
no longer called by `matrix.ts` but **kept** — they have their own unit tests in
`rgbInterp.test.ts` and are part of that module's tested utility surface. Deleting them would
mean deleting passing tests for no gain.

---

## 5. Tests (CLAUDE.md §3.6)

`matrix.test.ts`:

| Test | Assert |
|------|--------|
| same RGB grid, different spectra | `exactCount=N`, `interpCount=0`, `looRms=null`, `X_A`=A real, `X_B`=B real |
| different grids, overlapping gamut | `interpCount>0`, `X_A`=A real, `looRms>0` |
| A point outside B bbox | counted in `droppedOutOfGamut`, excluded from N |
| CMYK channels | interp path `throw`s with clear message |
| wavelength mismatch | `throw` |

`cxfParser.test.ts`:

| Test | Assert |
|------|--------|
| Target with RGB present | `SAMPLE_ID === 'RGB_{r}_{g}_{b}'` |
| Measurement without Target | `device === undefined`, ordinal `P{n}` id |

---

## 6. Metric / acceptance

- **Exact-match invariant:** loading two identical-chart profiles yields `interpCount === 0`.
- **No-extrapolation invariant:** no A row with `d_i` outside B bbox appears in output.
- **Interp noise floor surfaced:** `looRms` non-null whenever `interpCount > 0`; UI must not
  read cross-profile ΔE below it.
- CI green (Node 20): `npm test` + `npm run build`.

---

## 7. Out of scope (YAGNI)

- 4D CMYK interpolation (no CMYK dataset yet; exact path works, interp throws).
- RBF/spline interpolation (IDW is the chosen O(N) method, see `rgbInterp.ts` header).
- Changing the within-file Target↔Measurement position link.
