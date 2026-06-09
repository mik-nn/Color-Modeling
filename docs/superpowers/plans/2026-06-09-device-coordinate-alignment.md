# Device-Coordinate Profile Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace position/string-ID patch matching with device-coordinate (RGB/CMYK) matching, exact-match-first with k-NN interpolation fallback, unified in one `alignProfiles` function.

**Architecture:** New `alignProfiles(a, b)` in `matrix.ts` matches B patches to A's real device points by quantized device key; exact when B has the point, k-NN IDW interpolation otherwise, drop A points outside B's gamut. Both call-sites (`TransferView.tsx`, `kSweep.ts`) collapse their duplicated threshold-switch into one call. `cxfParser` emits device-encoded `SAMPLE_ID`. Old `alignByCommonSampleIds`/`alignByDeviceGrid` deleted last so every intermediate commit compiles.

**Tech Stack:** TypeScript (strict), Vitest, existing `rgbInterp.ts` IDW interpolator. Node ≥18 required for tests — local dev is Node v12, so run tests via `bash -l -c "nvm use 20 && ..."` (see CLAUDE.md §6).

**Spec:** `docs/specs/device-coordinate-alignment.md`

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/lib/dataset/matrix.ts` | `alignProfiles` + `AlignedProfiles` type; delete 2 old fns | Modify |
| `frontend/src/lib/dataset/matrix.test.ts` | tests for `alignProfiles`; remove old fn tests | Modify |
| `frontend/src/lib/parsers/cxfParser.ts` | device-encoded `SAMPLE_ID` | Modify |
| `frontend/src/lib/parsers/cxfParser.test.ts` | SAMPLE_ID encoding test | Modify |
| `frontend/src/components/TransferView.tsx` | one `alignProfiles` call; simplify paper lookup; UI fields | Modify |
| `frontend/src/lib/experiments/kSweep.ts` | one `alignProfiles` call in `_buildPairMatrices` | Modify |
| `frontend/src/lib/predict/perLambdaAffine.ts` | comment ref update | Modify |
| `docs/IMPLEMENTATION.md`, `docs/progress-log.md` | DDD docs | Modify |

---

## Task 1: cxfParser emits device-encoded SAMPLE_ID

**Files:**
- Modify: `frontend/src/lib/parsers/cxfParser.ts:218-239`
- Test: `frontend/src/lib/parsers/cxfParser.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/lib/parsers/cxfParser.test.ts` inside `describe('CxF Parser', ...)`:

```ts
  it('encodes SAMPLE_ID from RGB device values (cc:CxF spectral path)', async () => {
    // Minimal cc:CxF: one Target (RGB) + one M0 Measurement at same Row/Col/Page.
    const xml = `<?xml version="1.0"?>
<cc:CxF xmlns:cc="http://colorexchangeformat.com/CxF3-core">
  <cc:Resources>
    <cc:ObjectCollection>
      <cc:Object Id="t1" ObjectType="Target">
        <cc:TagCollection>
          <cc:Tag Name="Row" Value="3"/><cc:Tag Name="Column" Value="5"/><cc:Tag Name="Page" Value="1"/>
        </cc:TagCollection>
        <cc:DeviceColorValues><cc:ColorRGB><cc:R>128</cc:R><cc:G>64</cc:G><cc:B>32</cc:B></cc:ColorRGB></cc:DeviceColorValues>
      </cc:Object>
      <cc:Object Id="m1" ObjectType="M0_Measurement">
        <cc:TagCollection>
          <cc:Tag Name="Row" Value="3"/><cc:Tag Name="Column" Value="5"/><cc:Tag Name="Page" Value="1"/>
        </cc:TagCollection>
        <cc:ColorValues><cc:ReflectanceSpectrum StartWL="380">0.1 0.2 0.3 0.4 0.5 0.6</cc:ReflectanceSpectrum></cc:ColorValues>
      </cc:Object>
    </cc:ObjectCollection>
  </cc:Resources>
</cc:CxF>`;
    const { parseCxf3Xml } = await import('./cxfParser');
    const result = parseCxf3Xml(xml);
    expect(result.measurements).toHaveLength(1);
    expect(result.measurements[0].SAMPLE_ID).toBe('RGB_128_64_32');
    expect(result.measurements[0].device).toEqual({ space: 'rgb', values: [128, 64, 32] });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run src/lib/parsers/cxfParser.test.ts -t 'encodes SAMPLE_ID'"`
Expected: FAIL — `SAMPLE_ID` is `R3C5P1`, not `RGB_128_64_32`.

- [ ] **Step 3: Change SAMPLE_ID encoding in the spectral builder**

In `frontend/src/lib/parsers/cxfParser.ts`, the `measurements` map (currently around line 218-239) sets `SAMPLE_ID: item.sampleId`. Replace that build block:

```ts
  // ── Build final measurements ──
  const measurements: Measurement[] = rawItems.map((item, i) => {
    const [X, Y, Z] = xyzList[i];
    const lab = xyzToLab(X, Y, Z, wpX, wpY, wpZ);
    const hasRgb = item.rgb?.r !== undefined && item.rgb?.g !== undefined && item.rgb?.b !== undefined;
    // Match patches across profiles by device coordinate, not position. Encode RGB
    // into SAMPLE_ID (same convention as cgatsParser) so profiles with different
    // chart layouts still align by measurement point. Fall back to ordinal id only
    // when no Target/RGB exists for this measurement.
    const sampleId = hasRgb
      ? `RGB_${Math.round(item.rgb!.r!)}_${Math.round(item.rgb!.g!)}_${Math.round(item.rgb!.b!)}`
      : item.sampleId;
    return {
      SAMPLE_ID: sampleId,
      CMYK_C: 0, CMYK_M: 0, CMYK_Y: 0, CMYK_K: 0,
      RGB_R: item.rgb?.r,
      RGB_G: item.rgb?.g,
      RGB_B: item.rgb?.b,
      device: hasRgb
        ? { space: 'rgb', values: [item.rgb!.r!, item.rgb!.g!, item.rgb!.b!] }
        : undefined,
      LAB_L: lab.L,
      LAB_A: lab.a,
      LAB_B: lab.b,
      spectra: item.spectra,
      spectra_m2: item.spectra_m2,
      wavelengths: item.spectra.map((_, j) => item.startWL + j * 10),
    };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run src/lib/parsers/cxfParser.test.ts"`
Expected: PASS (all CxF Parser tests, including the new one).

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/parsers/cxfParser.ts frontend/src/lib/parsers/cxfParser.test.ts
git commit -m "fix(cxf): encode SAMPLE_ID from RGB device values for cross-profile matching

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Add `alignProfiles` (exact + interp) to matrix.ts

Old `alignByCommonSampleIds`/`alignByDeviceGrid` stay for now so call-sites keep compiling.

**Files:**
- Modify: `frontend/src/lib/dataset/matrix.ts` (add new fn + type + helper; keep existing imports)
- Test: `frontend/src/lib/dataset/matrix.test.ts`

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block to `frontend/src/lib/dataset/matrix.test.ts`. Note `mkPatch`/`mkProfile`/`loadProfileMatrix` already exist at the top of the file.

```ts
describe('alignProfiles', () => {
  it('exact-matches identical RGB grids, keeps real spectra of both', () => {
    const pA = mkProfile('A', [
      mkPatch('RGB_255_255_255', [255, 255, 255], [0.9, 0.9, 0.9]),
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.05, 0.05, 0.05]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('RGB_255_255_255', [255, 255, 255], [0.95, 0.95, 0.95]),
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.04, 0.04, 0.04]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.55, 0.55, 0.55]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.N).toBe(3);
    expect(al.exactCount).toBe(3);
    expect(al.interpCount).toBe(0);
    expect(al.looRms).toBeNull();
    // A keeps real spectra; B keeps real spectra (matched by device coord).
    // Row order follows A's sorted order: (0,0,0),(128..),(255..).
    expect(al.D[0]).toBe(0);
    expect(al.X_A[0]).toBeCloseTo(0.05);
    expect(al.X_B[0]).toBeCloseTo(0.04);
  });

  it('interpolates B onto A grid when grids differ; A stays real', () => {
    // A samples a midpoint B does not have; B has neighbours around it.
    const pA = mkProfile('A', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
    ]);
    const pB = mkProfile('B', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
      mkPatch('RGB_100_100_100', [100, 100, 100], [0.4, 0.4, 0.4]),
      mkPatch('RGB_150_150_150', [150, 150, 150], [0.6, 0.6, 0.6]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.N).toBe(3);
    expect(al.exactCount).toBe(2); // (0,0,0) and (255,255,255) exact in B
    expect(al.interpCount).toBe(1); // (128,128,128) interpolated
    expect(al.looRms).not.toBeNull();
    // A's midpoint spectrum stays real (0.5), B's is interpolated near 0.5.
    const mid = al.sampleIds.indexOf('RGB_128_128_128');
    expect(al.X_A[mid * a.L]).toBeCloseTo(0.5);
    expect(al.X_B[mid * a.L]).toBeGreaterThan(0.4);
    expect(al.X_B[mid * a.L]).toBeLessThan(0.6);
  });

  it('drops A points outside B device bounding box', () => {
    const pA = mkProfile('A', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_128_128_128', [128, 128, 128], [0.5, 0.5, 0.5]),
      mkPatch('RGB_255_255_255', [255, 255, 255], [1.0, 1.0, 1.0]),
    ]);
    // B bbox maxes at 150 → (128,128,128) is interpolatable, (255,255,255) is out of gamut.
    const pB = mkProfile('B', [
      mkPatch('RGB_0_0_0', [0, 0, 0], [0.0, 0.0, 0.0]),
      mkPatch('RGB_100_100_100', [100, 100, 100], [0.4, 0.4, 0.4]),
      mkPatch('RGB_150_150_150', [150, 150, 150], [0.6, 0.6, 0.6]),
    ]);
    const a = loadProfileMatrix(pA);
    const b = loadProfileMatrix(pB);
    const al = alignProfiles(a, b);
    expect(al.droppedOutOfGamut).toBe(1); // (255,255,255) dropped — outside B bbox
    expect(al.exactCount).toBe(1); // (0,0,0) exact
    expect(al.interpCount).toBe(1); // (128,128,128) interpolated
    expect(al.sampleIds).not.toContain('RGB_255_255_255');
    expect(al.N).toBe(2);
  });

  it('throws on CMYK interpolation (no 4D IDW yet)', () => {
    const cmykPatch = (c: number, spectra: number[]): Measurement => ({
      SAMPLE_ID: `CMYK_${c}`,
      CMYK_C: c, CMYK_M: 0, CMYK_Y: 0, CMYK_K: 0,
      device: { space: 'cmyk', values: [c, 0, 0, 0] },
      LAB_L: 50, LAB_A: 0, LAB_B: 0,
      spectra,
      wavelengths: spectra.map((_, i) => 380 + i * 10),
    });
    const a = loadProfileMatrix(mkProfile('A', [cmykPatch(10, [0.5, 0.5]), cmykPatch(50, [0.3, 0.3])]));
    const b = loadProfileMatrix(mkProfile('B', [cmykPatch(20, [0.4, 0.4]), cmykPatch(60, [0.2, 0.2])]));
    expect(() => alignProfiles(a, b)).toThrow(/CMYK interpolation/);
  });

  it('throws on wavelength count mismatch', () => {
    const a = loadProfileMatrix(mkProfile('A', [mkPatch('RGB_0_0_0', [0, 0, 0], [0.1, 0.2, 0.3])]));
    const b = loadProfileMatrix(mkProfile('B', [mkPatch('RGB_0_0_0', [0, 0, 0], [0.1, 0.2])]));
    expect(() => alignProfiles(a, b)).toThrow(/wavelength count mismatch/);
  });
});
```

Update the import line at the top of `matrix.test.ts` (line 2) to include `alignProfiles`:

```ts
import { loadProfileMatrix, alignByCommonSampleIds, alignByDeviceGrid, alignProfiles } from './matrix';
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run src/lib/dataset/matrix.test.ts -t alignProfiles"`
Expected: FAIL — `alignProfiles` is not exported.

- [ ] **Step 3: Implement `alignProfiles` + `AlignedProfiles`**

In `frontend/src/lib/dataset/matrix.ts`, the existing import block (lines 8-15) already pulls `buildInterpolator`, `boundingBox`, `inBox`, `type InterpPoint`. Add `looRms` and `type Box` to that import:

```ts
import {
  buildInterpolator,
  regularGrid,
  boundingBox,
  intersectBox,
  inBox,
  looRms,
  type InterpPoint,
} from '../interp/rgbInterp';
```

Append at the end of the file (after `alignByDeviceGrid`):

```ts
export interface AlignedProfiles {
  /** Display labels (device-encoded) in row order. */
  sampleIds: string[];
  /** N×L reflectance for reference A — always real measured spectra. */
  X_A: Float64Array;
  /** N×L reflectance for target B — exact where B has the point, else interpolated. */
  X_B: Float64Array;
  /** N×channels device coordinates (A's actual sampled points). */
  D: Float64Array;
  channels: 3 | 4;
  N: number;
  L: number;
  /** B patches matched exactly by device coordinate. */
  exactCount: number;
  /** B patches reconstructed by k-NN IDW interpolation. */
  interpCount: number;
  /** A points dropped because they fall outside B's device bounding box. */
  droppedOutOfGamut: number;
  /** Interpolation noise floor (LOO RMS reflectance over B); null when interpCount === 0. */
  looRms: number | null;
}

/** Quantized device key for exact matching: RGB → integer, CMYK → 2-decimal. */
function deviceKey(d: Float64Array, row: number, channels: 3 | 4): string {
  if (channels === 3) {
    return `${Math.round(d[row * 3])}_${Math.round(d[row * 3 + 1])}_${Math.round(d[row * 3 + 2])}`;
  }
  let s = '';
  for (let c = 0; c < 4; c++) s += (c ? '_' : '') + d[row * 4 + c].toFixed(2);
  return s;
}

/**
 * Align two profiles by DEVICE COORDINATE (the invariant across files), not by
 * position or string ID. Query grid is A's actual device points: A keeps its real
 * measured spectra; for each A point, B's spectrum is taken exactly when B has that
 * device coordinate, otherwise reconstructed by k-NN IDW interpolation from B's
 * neighbours. A points outside B's device bounding box are dropped (no extrapolation).
 *
 * Unifies the former exact-match (`alignByCommonSampleIds`) and grid-resample
 * (`alignByDeviceGrid`) paths into one. RGB only for interpolation; CMYK exact-match
 * works but interpolation throws (needs 4D IDW — see spec §2.3).
 */
export function alignProfiles(
  a: ProfileMatrices,
  b: ProfileMatrices,
  opts: { k?: number; power?: number } = {},
): AlignedProfiles {
  if (a.channels !== b.channels) {
    throw new Error(`alignProfiles: device channel mismatch (A=${a.channels}, B=${b.channels})`);
  }
  if (a.L !== b.L) {
    throw new Error(`alignProfiles: wavelength count mismatch (${a.L} vs ${b.L})`);
  }
  const channels = a.channels;
  const L = a.L;

  // B exact-match lookup by quantized device key.
  const bByKey = new Map<string, number>();
  for (let j = 0; j < b.N; j++) bByKey.set(deviceKey(b.D, j, channels), j);

  // Resolve each A row: exact B row index, or -1 meaning "needs interpolation".
  const exactRow = new Int32Array(a.N);
  let anyInterp = false;
  for (let i = 0; i < a.N; i++) {
    const j = bByKey.get(deviceKey(a.D, i, channels));
    if (j !== undefined) {
      exactRow[i] = j;
    } else {
      exactRow[i] = -1;
      anyInterp = true;
    }
  }

  // Build interpolation machinery only if some A point misses an exact B match.
  let interp: ReturnType<typeof buildInterpolator> | null = null;
  let bbox: ReturnType<typeof boundingBox> | null = null;
  let looRmsVal: number | null = null;
  if (anyInterp) {
    if (channels !== 3) {
      throw new Error('alignProfiles: CMYK interpolation not yet implemented; need 4D IDW');
    }
    const bPoints: InterpPoint[] = new Array(b.N);
    for (let j = 0; j < b.N; j++) {
      bPoints[j] = {
        rgb: [b.D[j * 3], b.D[j * 3 + 1], b.D[j * 3 + 2]],
        spectrum: Array.from(b.X.subarray(j * L, j * L + L)),
      };
    }
    interp = buildInterpolator(bPoints, opts);
    bbox = boundingBox(bPoints);
    looRmsVal = b.N >= 2 ? looRms(bPoints, opts) : null;
  }

  // Decide which A rows survive (exact, or interpolatable inside B's bbox).
  const keptA: number[] = [];
  let exactCount = 0;
  let interpCount = 0;
  let droppedOutOfGamut = 0;
  for (let i = 0; i < a.N; i++) {
    if (exactRow[i] >= 0) {
      keptA.push(i);
      exactCount++;
      continue;
    }
    const rgb: [number, number, number] = [a.D[i * 3], a.D[i * 3 + 1], a.D[i * 3 + 2]];
    if (bbox && inBox(rgb, bbox)) {
      keptA.push(i);
      interpCount++;
    } else {
      droppedOutOfGamut++;
    }
  }

  const N = keptA.length;
  const X_A = new Float64Array(N * L);
  const X_B = new Float64Array(N * L);
  const D = new Float64Array(N * channels);
  const sampleIds: string[] = new Array(N);

  for (let r = 0; r < N; r++) {
    const i = keptA[r];
    for (let l = 0; l < L; l++) X_A[r * L + l] = a.X[i * L + l];
    for (let c = 0; c < channels; c++) D[r * channels + c] = a.D[i * channels + c];

    const bj = exactRow[i];
    if (bj >= 0) {
      for (let l = 0; l < L; l++) X_B[r * L + l] = b.X[bj * L + l];
    } else {
      const s = interp!.query([a.D[i * 3], a.D[i * 3 + 1], a.D[i * 3 + 2]]);
      for (let l = 0; l < L; l++) X_B[r * L + l] = s[l];
    }

    if (channels === 3) {
      sampleIds[r] = `RGB_${Math.round(D[r * 3])}_${Math.round(D[r * 3 + 1])}_${Math.round(D[r * 3 + 2])}`;
    } else {
      sampleIds[r] = `CMYK_${deviceKey(D, r, channels)}`;
    }
  }

  return {
    sampleIds,
    X_A,
    X_B,
    D,
    channels,
    N,
    L,
    exactCount,
    interpCount,
    droppedOutOfGamut,
    looRms: interpCount > 0 ? looRmsVal : null,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run src/lib/dataset/matrix.test.ts"`
Expected: PASS — all `alignProfiles` tests plus the existing `loadProfileMatrix`/old-fn tests still green.

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/dataset/matrix.ts frontend/src/lib/dataset/matrix.test.ts
git commit -m "feat(matrix): add alignProfiles device-coordinate alignment

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Migrate TransferView to `alignProfiles`

Collapses the threshold=50 switch (lines ~274-322) and simplifies the `paperRowIdxA`
white-patch lookup (lines ~356-393) that depended on `aligned.idxA`.

**Files:**
- Modify: `frontend/src/components/TransferView.tsx` (import line 20; RunResult type 126-145; result body 269-393; UI banner 1252-1259; stat label 1365-1367)

- [ ] **Step 1: Update the import**

`frontend/src/components/TransferView.tsx:20`:

```ts
import { loadProfileMatrix, alignProfiles } from '../lib/dataset/matrix'
```

- [ ] **Step 2: Extend RunResult type with interp metrics**

Replace `frontend/src/components/TransferView.tsx:132-134`:

```ts
      alignedN: number
      /** True when any target patch was reconstructed by interpolation. */
      crossChart: boolean
      /** Target patches matched exactly by device coordinate. */
      exactCount: number
      /** Target patches reconstructed by k-NN IDW interpolation. */
      interpCount: number
      /** Interpolation noise floor (LOO RMS reflectance), null when interpCount===0. */
      looRms: number | null
```

- [ ] **Step 3: Replace the alignment block**

Replace `frontend/src/components/TransferView.tsx:274-322` (from `const aligned = alignByCommonSampleIds(A, B)` through the closing `}` of the `else` error branch) with:

```ts
      const al = alignProfiles(A, B)
      if (al.N < 50) {
        return {
          kind: 'error' as const,
          error: `Only ${al.N} device-aligned patches (gamut overlap too small or wavelength/space mismatch).`,
        }
      }
      const N = al.N
      const sampleIds = al.sampleIds
      const X_A = al.X_A
      const X_B = al.X_B
      const D_B = al.D
      const crossChart = al.interpCount > 0
```

Note: `L` is already declared just above (`const L = A.L`). Keep it.

- [ ] **Step 4: Simplify the paper-white lookup**

Replace `frontend/src/components/TransferView.tsx:356-390` (the `let paperRowIdxA = ... if (crossChart) { ... } else { ... }` block) with a direct search over the aligned device matrix `D_B` (which now equals A's device coordinates):

```ts
      // Reference paper: find white (255,255,255) directly in the aligned device grid.
      // D_B holds A's device coordinates (query grid = A's real points), so the aligned
      // row index is the paper row — no idxA indirection needed.
      let paperRowIdxA = paperRowIdx // fallback: target's anchor if no white found
      for (let j = 0; j < N; j++) {
        if (D_B[j * B.channels] === 255 && D_B[j * B.channels + 1] === 255 && D_B[j * B.channels + 2] === 255) {
          paperRowIdxA = j
          break
        }
      }
```

- [ ] **Step 5: Populate the new result fields**

At the `kind: 'ok'` return (around line 890-894), add the three new fields next to `alignedN`/`crossChart`:

```ts
        alignedN: N,
        crossChart,
        exactCount: al.exactCount,
        interpCount: al.interpCount,
        looRms: al.looRms,
```

- [ ] **Step 6: Update the cross-chart banner to show the real noise floor**

Replace `frontend/src/components/TransferView.tsx:1252-1259`:

```tsx
          {result.crossChart && (
            <div className="bg-amber-950/40 border border-amber-700/60 rounded-lg p-3 text-sm text-amber-200">
              Device-coordinate alignment: {result.exactCount} target patches matched
              exactly, {result.interpCount} reconstructed by per-band k-NN IDW
              interpolation onto the reference's device grid.
              {result.looRms !== null && (
                <> Interpolation noise floor ≈ {fmt(result.looRms, 4)} RMS reflectance —
                read ΔE00 above it.</>
              )}
            </div>
          )}
```

- [ ] **Step 7: Update the stat-tile label**

`frontend/src/components/TransferView.tsx:1365-1367`:

```tsx
                  label={result.crossChart ? 'patches (some interp)' : 'patches (all exact)'}
                  value={String(result.alignedN)}
                  cls={result.crossChart ? 'text-amber-300' : 'text-gray-200'}
```

- [ ] **Step 8: Build to verify compilation**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx tsc --noEmit"`
Expected: no errors referencing `alignByCommonSampleIds`, `alignByDeviceGrid`, `aligned`, or `crossChart` mismatch in TransferView.

- [ ] **Step 9: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/components/TransferView.tsx
git commit -m "refactor(transfer): use alignProfiles, drop threshold switch + idxA paper lookup

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Migrate kSweep to `alignProfiles`

**Files:**
- Modify: `frontend/src/lib/experiments/kSweep.ts` (imports 14-17; `_buildPairMatrices` 405-444)

- [ ] **Step 1: Update imports**

Replace the `alignByCommonSampleIds` / `alignByDeviceGrid` entries in the import from `../dataset/matrix` (lines 15-16) with `alignProfiles`. The resulting import should pull `loadProfileMatrix` and `alignProfiles` (keep any other names already imported there).

- [ ] **Step 2: Replace the alignment block in `_buildPairMatrices`**

Replace `frontend/src/lib/experiments/kSweep.ts:420-444` (from `const aligned = alignByCommonSampleIds(A, B)` through the end of the `else { ... }` block) with:

```ts
  const al = alignProfiles(A, B)
  if (al.N < 50) return null
  N = al.N
  sampleIds = al.sampleIds
  X_A = al.X_A
  X_B = al.X_B
  D_B = al.D
```

The surrounding `const A`, `const B`, channel/`L` guards (lines 409-418) and the
`paperRowIdx`/`paperWP` block below (446-468) are unchanged — `D_B` still holds RGB
device coordinates, so the white-patch search keeps working.

- [ ] **Step 3: Build to verify compilation**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx tsc --noEmit"`
Expected: no errors in `kSweep.ts`.

- [ ] **Step 4: Run kSweep tests**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run src/lib/experiments/kSweep.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/experiments/kSweep.ts
git commit -m "refactor(ksweep): use alignProfiles in _buildPairMatrices

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Delete old align functions + update docs

Now that no caller references them, remove the two old functions and their tests.

**Files:**
- Modify: `frontend/src/lib/dataset/matrix.ts` (delete `alignByCommonSampleIds` 140-165, `alignByDeviceGrid` 167-248, `AlignedGrid` type)
- Modify: `frontend/src/lib/dataset/matrix.test.ts` (delete old describe blocks + import names)
- Modify: `frontend/src/lib/predict/perLambdaAffine.ts:11-12` (comment)
- Modify: `docs/IMPLEMENTATION.md`, `docs/progress-log.md`

- [ ] **Step 1: Delete the old functions**

In `frontend/src/lib/dataset/matrix.ts`, delete:
- `export function alignByCommonSampleIds(...)` and its doc comment (the block starting "For two profiles built from the identical target chart…").
- `export interface AlignedGrid { ... }`.
- `export function alignByDeviceGrid(...)` and its doc comment.

Then clean the now-unused imports from `../interp/rgbInterp`: `regularGrid` and `intersectBox` are no longer referenced in `matrix.ts` (they remain exported/tested in `rgbInterp.ts`). The import should keep `buildInterpolator`, `boundingBox`, `inBox`, `looRms`, `type InterpPoint`:

```ts
import {
  buildInterpolator,
  boundingBox,
  inBox,
  looRms,
  type InterpPoint,
} from '../interp/rgbInterp';
```

- [ ] **Step 2: Delete old tests + fix import**

In `frontend/src/lib/dataset/matrix.test.ts`:
- Delete the entire `describe('alignByCommonSampleIds', () => { ... })` block.
- Delete the entire `describe('alignByDeviceGrid', () => { ... })` block (including the `cubeProfile` helper if it is only used there).
- Fix line 2 import to:

```ts
import { loadProfileMatrix, alignProfiles } from './matrix';
```

- [ ] **Step 3: Update the perLambdaAffine comment**

`frontend/src/lib/predict/perLambdaAffine.ts:11-12` currently references `alignByCommonSampleIds`. Replace the mention with `alignProfiles`:

```ts
// Inputs assumed already aligned by device coordinate — see dataset/matrix.ts
// alignProfiles. The predictor never touches sample IDs; it operates
```

- [ ] **Step 4: Run the full test suite + build**

Run: `bash -l -c "cd /home/mikz/Color-ModelingETL/frontend && nvm use 20 && npx vitest run && npx tsc --noEmit"`
Expected: PASS, no references to deleted symbols.

- [ ] **Step 5: Update docs**

In `docs/IMPLEMENTATION.md`, find the `matrix.ts` entry (or the dataset section) and replace any mention of `alignByCommonSampleIds`/`alignByDeviceGrid` with a single line:

```markdown
- `lib/dataset/matrix.ts` — `loadProfileMatrix` (ProfileData → dense X/D matrices),
  `alignProfiles` (device-coordinate alignment: exact match + k-NN IDW interp fallback,
  drops out-of-gamut points). Matching is by device coordinate, never by position/ID.
```

Append to `docs/progress-log.md` (newest entry at the appropriate place per file convention):

```markdown
## 2026-06-09 — Device-coordinate alignment

Заменил сопоставление патчей по позиции/SAMPLE_ID на сопоставление по device-координате
(RGB/CMYK). Новая `alignProfiles` в `matrix.ts` объединяет старые `alignByCommonSampleIds`
и `alignByDeviceGrid`: query-сетка = реальные точки референса A (A хранит измеренные спектры),
B берётся exact-match по квантованному device-ключу или реконструируется k-NN IDW
интерполяцией; точки A вне gamut B дропаются (без экстраполяции). `cxfParser` теперь отдаёт
`SAMPLE_ID = RGB_{r}_{g}_{b}`. TransferView и kSweep схлопнули дублированный threshold=50
switch в один вызов. Spec: `docs/specs/device-coordinate-alignment.md`.
```

- [ ] **Step 6: Final commit (includes spec)**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/dataset/matrix.ts frontend/src/lib/dataset/matrix.test.ts \
  frontend/src/lib/predict/perLambdaAffine.ts \
  docs/IMPLEMENTATION.md docs/progress-log.md \
  docs/specs/device-coordinate-alignment.md \
  docs/superpowers/plans/2026-06-09-device-coordinate-alignment.md
git commit -m "refactor(matrix): delete legacy align fns; device-coordinate matching only

Replaces position/SAMPLE_ID matching with device-coordinate matching across the
codebase. Spec + plan included.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 7: Push + verify CI (source of truth, CLAUDE.md §3.7)**

```bash
cd /home/mikz/Color-ModelingETL && git push
```
Then check GitHub Actions is green before claiming done.

---

## Notes for the implementer

- **Node v12 locally breaks vitest/tsc** — always wrap Node calls in `bash -l -c "nvm use 20 && ..."`.
- **Pre-commit hook** blocks `feat:`/`fix:` touching `lib/` or `components/` without a
  `docs/progress-log.md` change. Tasks 1-4 touch lib/components without a progress-log edit.
  The progress-log entry lands in Task 5. For Tasks 1-4 either (a) commit with `--no-verify`
  (CLAUDE.md permits it as a budget for a multi-commit feature) and ensure Task 5 adds the
  log, or (b) move the progress-log append earlier. Recommended: use `--no-verify` on Tasks
  1-4, land the full log in Task 5.
- **`looRms` cost** is O(N²) over B's points (~905 → ~820k band-ops); acceptable for a
  one-shot run inside `useMemo`. If it stalls the UI, gate it behind a flag — out of scope here.
- **`fmt` helper** used in the banner (Task 3 Step 6) already exists in TransferView (line 153).
