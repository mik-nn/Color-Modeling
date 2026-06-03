// frontend/scripts/experiments/h13_m0m2.ts
//
// H13 — measured-fluorescence OBA correction from paired M0/M2 spectra.
//
// For each OBA-disparate (or otherwise H4-failing) same-mode pair:
//   1. Baseline: D1+S1+D7-default (rank=5, uvBandCount=4).
//   2. H13: train D1 on the OBA-free M2 spectra (no UV clamp), then re-add
//      a measured emission `E_patch(λ) = E_paper(λ) · u(patch)` where
//      `u(patch) = R_patch_m2(380) / R_paper_m2(380)`. The paper's emission
//      `E_paper(λ) = R_paper_m0(λ) − R_paper_m2(λ)` is measured directly.
// Report median + P95 ΔE00 (against the true M0 spectra) per predictor.
//
// Run: cd frontend && npx tsx scripts/experiments/h13_m0m2.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import {
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { canonicalPrintMode } from '../../src/utils/printMode'
import { detectOBA, obaMismatch } from '../../src/lib/predict/oba'

// AllureAq is a 1550-patch chart that doesn't share SAMPLE_IDs cleanly with the
// 905-patch BC charts → cross-chart alignment yields garbage (41+ ΔE). Treat its
// print mode as "unknown to us" until that's resolved at the parser layer.
const SKIP_PROFILES = new Set(['BC_AllureAq_P9000_MK_EMP'])

const H13C_OBA_MISMATCH_THRESHOLD = 0.10

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')

interface PatchData {
  sampleId: string
  rgb: [number, number, number]
  m0: number[]
  m2: number[] | null
}
interface ProfileBundle {
  name: string
  preset: string
  patches: PatchData[]
  byId: Map<string, PatchData>
}

async function loadProfile(filePath: string): Promise<ProfileBundle | null> {
  const name = path.basename(filePath).replace(/\.icm$/i, '')
  if (SKIP_PROFILES.has(name)) return null
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
  let preset: string
  try {
    preset = canonicalPrintMode(name)
  } catch {
    return null
  }
  const patches: PatchData[] = []
  const byId = new Map<string, PatchData>()
  for (const m of r.measurements) {
    if (!m.spectra) continue
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue
    const p: PatchData = {
      sampleId: m.SAMPLE_ID,
      rgb: [m.RGB_R, m.RGB_G, m.RGB_B],
      m0: m.spectra,
      m2: m.spectra_m2 && m.spectra_m2.length === m.spectra.length ? m.spectra_m2 : null,
    }
    patches.push(p)
    byId.set(p.sampleId, p)
  }
  return { name, preset, patches, byId }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (/^BC_.*\.icm$/i.test(e.name)) out.push(full)
  }
  return out
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}

// Build aligned matrices from two profiles (M0 + M2) over shared SAMPLE_IDs.
function alignPair(
  A: ProfileBundle,
  B: ProfileBundle,
): {
  sampleIds: string[]
  X_A_m0: Float64Array
  X_A_m2: Float64Array | null
  X_B_m0: Float64Array
  X_B_m2: Float64Array | null
  D: Float64Array
  L: number
  N: number
} | null {
  const shared: string[] = []
  const aRows: PatchData[] = []
  const bRows: PatchData[] = []
  for (const p of A.patches) {
    const q = B.byId.get(p.sampleId)
    if (!q) continue
    shared.push(p.sampleId)
    aRows.push(p)
    bRows.push(q)
  }
  if (shared.length < 100) return null
  const L = aRows[0].m0.length
  const N = shared.length
  const X_A_m0 = new Float64Array(N * L)
  const X_B_m0 = new Float64Array(N * L)
  const D = new Float64Array(N * 3)
  const haveM2 = aRows.every((p) => p.m2 !== null) && bRows.every((p) => p.m2 !== null)
  const X_A_m2 = haveM2 ? new Float64Array(N * L) : null
  const X_B_m2 = haveM2 ? new Float64Array(N * L) : null
  for (let i = 0; i < N; i++) {
    const a = aRows[i]
    const b = bRows[i]
    for (let l = 0; l < L; l++) {
      X_A_m0[i * L + l] = a.m0[l]
      X_B_m0[i * L + l] = b.m0[l]
      if (X_A_m2 && X_B_m2) {
        X_A_m2[i * L + l] = a.m2![l]
        X_B_m2[i * L + l] = b.m2![l]
      }
    }
    D[i * 3] = b.rgb[0]
    D[i * 3 + 1] = b.rgb[1]
    D[i * 3 + 2] = b.rgb[2]
  }
  return { sampleIds: shared, X_A_m0, X_A_m2, X_B_m0, X_B_m2, D, L, N }
}

function evalDe(X_pred: Float64Array, X_true: Float64Array, L: number, anchorSet: Set<number>): { median: number; p95: number; n: number } {
  const N = X_pred.length / L
  const des: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const a = Array.from(X_pred.subarray(i * L, i * L + L))
    const b = Array.from(X_true.subarray(i * L, i * L + L))
    const la = spectraToLab(a)
    const lb = spectraToLab(b)
    des.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
  }
  return { median: median(des), p95: percentile(des, 95), n: des.length }
}

// Plain D1 on M0, no D7 OBA wrapper at all. Used as the "no compensation" branch
// of H13c when the substrate pair has near-zero OBA mismatch.
function runPlainD1(
  aligned: NonNullable<ReturnType<typeof alignPair>>,
  anchorIdx: number[],
  paperRowIdx: number,
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  refName: string,
  tgtName: string,
) {
  const { X_A_m0, X_B_m0, D, L, sampleIds } = aligned
  const result = runPaperRatioResidualTransfer({
    X_A: X_A_m0,
    X_B: X_B_m0,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: 5,
    uvBandCount: 4,
  })
  return { X_pred: result.X_pred, clampedBands: result.fit.clampedBands.length }
}

// D1+S1+D7 default baseline (matches h4_batch.ts).
function runBaseline(
  aligned: NonNullable<ReturnType<typeof alignPair>>,
  anchorIdx: number[],
  paperRowIdx: number,
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  refName: string,
  tgtName: string,
) {
  const { X_A_m0, X_B_m0, D, L, sampleIds } = aligned
  const paperSpecA = Array.from(X_A_m0.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperSpecB = Array.from(X_B_m0.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(paperSpecA)
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A_m0, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B_m0, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A_m0, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B_m0, L, fB, emB.emission)
  const result = runPaperRatioResidualTransfer({
    X_A: X_A_clean,
    X_B: X_B_clean,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: 5,
    uvBandCount: 4,
  })
  const X_pred = addOBA(result.X_pred, L, fB, emB.emission)
  return { X_pred, clampedBands: result.fit.clampedBands.length }
}

// H13 — D1 on M2 spectra + measured emission re-added per patch via UV factor.
function runH13(
  aligned: NonNullable<ReturnType<typeof alignPair>>,
  anchorIdx: number[],
  paperRowIdx: number,
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  refName: string,
  tgtName: string,
) {
  const { X_A_m0, X_A_m2, X_B_m0, X_B_m2, D, L, sampleIds, N } = aligned
  if (!X_A_m2 || !X_B_m2) return null

  // 1. Transfer on M2 (clean substrate, no OBA non-linearity).
  const result = runPaperRatioResidualTransfer({
    X_A: X_A_m2,
    X_B: X_B_m2,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: 5,
    // No UV clamp — M2 has no OBA, so 380 nm ratios are well-behaved.
    uvBandCount: 0,
  })
  const X_B_m2_pred = result.X_pred

  // 2. Measured paper emission: E_paper(λ) = R_paper_M0(λ) − R_paper_M2(λ).
  const paperOff = paperRowIdx * L
  const E_paper = new Float64Array(L)
  for (let l = 0; l < L; l++) {
    E_paper[l] = Math.max(0, X_B_m0[paperOff + l] - X_B_m2[paperOff + l])
  }
  const paperM2_380 = X_B_m2[paperOff] // band 0 = 380 nm
  const safePaper = Math.max(paperM2_380, 1e-6)

  // 3. Predict M0 per patch by adding scaled emission to M2 prediction.
  //    u(patch) = R_patch_m2(380) / R_paper_m2(380), clipped to [0, 1].
  const X_pred = new Float64Array(N * L)
  for (let i = 0; i < N; i++) {
    const patchM2_380 = X_B_m2_pred[i * L] // predicted M2 at 380 — should be near M0 base
    let u = patchM2_380 / safePaper
    if (u < 0) u = 0
    if (u > 1) u = 1
    for (let l = 0; l < L; l++) {
      const v = X_B_m2_pred[i * L + l] + u * E_paper[l]
      X_pred[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return { X_pred, clampedBands: result.fit.clampedBands.length }
}

// H13b — anchor-driven kNN emission interpolation. Each anchor's measured
// `E_anchor(λ) = M0_anchor − M2_anchor` is a direct emission sample. Non-anchor
// patches get `E(λ) = Σ_i w_i · E_anchor_i(λ)` with `w_i = 1 / d_i^power` and
// `d_i` the RGB distance (normalised to [0, 1]) to the i-th anchor.
function runH13b(
  aligned: NonNullable<ReturnType<typeof alignPair>>,
  anchorIdx: number[],
  paperRowIdx: number,
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  refName: string,
  tgtName: string,
  opts: { kNN?: number; power?: number } = {},
) {
  const { X_A_m0, X_A_m2, X_B_m0, X_B_m2, D, L, sampleIds, N } = aligned
  if (!X_A_m2 || !X_B_m2) return null
  const kNN = Math.max(1, Math.min(opts.kNN ?? 4, anchorIdx.length))
  const power = opts.power ?? 2

  // 1. Transfer on M2 (clean substrate).
  const result = runPaperRatioResidualTransfer({
    X_A: X_A_m2,
    X_B: X_B_m2,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: 5,
    uvBandCount: 0,
  })
  const X_B_m2_pred = result.X_pred

  // 2. Per-anchor measured emission `E_a(λ) = M0_a(λ) − M2_a(λ)`.
  const E_anchors: Float64Array[] = []
  const anchorRGB: Array<[number, number, number]> = []
  for (const a of anchorIdx) {
    const e = new Float64Array(L)
    for (let l = 0; l < L; l++) {
      e[l] = Math.max(0, X_B_m0[a * L + l] - X_B_m2[a * L + l])
    }
    E_anchors.push(e)
    anchorRGB.push([D[a * 3] / 255, D[a * 3 + 1] / 255, D[a * 3 + 2] / 255])
  }

  // 3. Final prediction = M2_pred + emission interpolated from anchors per patch.
  const X_pred = new Float64Array(N * L)
  const anchorSet = new Set(anchorIdx)
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) {
      // Anchors: use the ground-truth M0 directly (they're measured).
      for (let l = 0; l < L; l++) X_pred[i * L + l] = X_B_m0[i * L + l]
      continue
    }
    const r = D[i * 3] / 255
    const g = D[i * 3 + 1] / 255
    const b = D[i * 3 + 2] / 255
    // Distance to each anchor (squared).
    const ds: { idx: number; d2: number }[] = anchorRGB.map((c, k) => {
      const dr = c[0] - r
      const dg = c[1] - g
      const db = c[2] - b
      return { idx: k, d2: dr * dr + dg * dg + db * db }
    })
    ds.sort((x, y) => x.d2 - y.d2)
    // kNN weights.
    let exactHit = -1
    for (let k = 0; k < ds.length; k++) {
      if (ds[k].d2 === 0) {
        exactHit = ds[k].idx
        break
      }
    }
    const E = new Float64Array(L)
    if (exactHit >= 0) {
      const src = E_anchors[exactHit]
      for (let l = 0; l < L; l++) E[l] = src[l]
    } else {
      let wsum = 0
      for (let k = 0; k < kNN; k++) {
        const { idx, d2 } = ds[k]
        const w = Math.pow(d2, -power / 2)
        wsum += w
        const src = E_anchors[idx]
        for (let l = 0; l < L; l++) E[l] += w * src[l]
      }
      for (let l = 0; l < L; l++) E[l] /= wsum
    }
    for (let l = 0; l < L; l++) {
      const v = X_B_m2_pred[i * L + l] + E[l]
      X_pred[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v
    }
  }
  return { X_pred, clampedBands: result.fit.clampedBands.length }
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  console.log(`Loading ${files.length} BC profiles…`)
  const profiles: ProfileBundle[] = []
  for (const f of files) {
    try {
      const p = await loadProfile(f)
      if (p) profiles.push(p)
    } catch {
      // skip
    }
  }
  const withM2 = profiles.filter((p) => p.patches.every((pp) => pp.m2 !== null))
  console.log(`Loaded ${profiles.length} profiles, M2-paired in ${withM2.length}\n`)

  // All same-mode pairs from same-preset.
  interface Row {
    ref: string
    target: string
    preset: string
    obaMismatch: number
    h13cUsedB: boolean
    plain_median: number
    plain_p95: number
    base_median: number
    base_p95: number
    h13_median: number
    h13_p95: number
    h13b_median: number
    h13b_p95: number
    h13c_median: number
    h13c_p95: number
    delta_median: number
    delta_p95: number
    delta_b_median: number
    delta_b_p95: number
    delta_c_median: number
    delta_c_p95: number
  }
  const rows: Row[] = []
  for (let i = 0; i < withM2.length; i++) {
    for (let j = 0; j < withM2.length; j++) {
      if (i === j) continue
      const A = withM2[i]
      const B = withM2[j]
      if (A.preset !== B.preset) continue
      const aligned = alignPair(A, B)
      if (!aligned) continue

      const Baligned = {
        X: aligned.X_B_m0,
        D: aligned.D,
        channels: 3 as const,
        N: aligned.N,
        L: aligned.L,
        wavelengths: Array.from({ length: aligned.L }, (_, k) => 380 + k * 10),
        sampleIds: aligned.sampleIds,
        droppedCount: 0,
      }
      const anchors = pickHeuristicAnchors(Baligned)
      const anchorIdx = anchors.meta?.chosenIdx as number[]
      const paperRowIdx = anchorIdx[0]
      const paperSpecB = new Float64Array(aligned.L)
      for (let l = 0; l < aligned.L; l++) paperSpecB[l] = aligned.X_B_m0[paperRowIdx * aligned.L + l]
      const paperWP = paperWPFromBrightestPatch(paperSpecB, 1, aligned.L, 380)

      const base = runBaseline(aligned, anchorIdx, paperRowIdx, paperWP, A.name, B.name)
      const plain = runPlainD1(aligned, anchorIdx, paperRowIdx, paperWP, A.name, B.name)
      const h13 = runH13(aligned, anchorIdx, paperRowIdx, paperWP, A.name, B.name)
      const h13b = runH13b(aligned, anchorIdx, paperRowIdx, paperWP, A.name, B.name)
      if (!h13 || !h13b) continue

      const anchorSet = new Set(anchorIdx)
      const baseEval = evalDe(base.X_pred, aligned.X_B_m0, aligned.L, anchorSet)
      const plainEval = evalDe(plain.X_pred, aligned.X_B_m0, aligned.L, anchorSet)
      const h13Eval = evalDe(h13.X_pred, aligned.X_B_m0, aligned.L, anchorSet)
      const h13bEval = evalDe(h13b.X_pred, aligned.X_B_m0, aligned.L, anchorSet)

      // H13c — adaptive gate: ABOVE threshold pick H13b (anchor-driven measured
      // emission); BELOW threshold pick plain D1 (no OBA compensation at all).
      const paperSpecAfull = new Array<number>(aligned.L)
      const paperSpecBfull = new Array<number>(aligned.L)
      for (let l = 0; l < aligned.L; l++) {
        paperSpecAfull[l] = aligned.X_A_m0[paperRowIdx * aligned.L + l]
        paperSpecBfull[l] = aligned.X_B_m0[paperRowIdx * aligned.L + l]
      }
      const obaA = detectOBA(paperSpecAfull)
      const obaB = detectOBA(paperSpecBfull)
      const mismatch = obaMismatch(obaA, obaB)
      const usedB = mismatch >= H13C_OBA_MISMATCH_THRESHOLD
      const h13cEval = usedB ? h13bEval : plainEval

      rows.push({
        ref: A.name,
        target: B.name,
        preset: A.preset,
        obaMismatch: mismatch,
        h13cUsedB: usedB,
        plain_median: plainEval.median,
        plain_p95: plainEval.p95,
        base_median: baseEval.median,
        base_p95: baseEval.p95,
        h13_median: h13Eval.median,
        h13_p95: h13Eval.p95,
        h13b_median: h13bEval.median,
        h13b_p95: h13bEval.p95,
        h13c_median: h13cEval.median,
        h13c_p95: h13cEval.p95,
        delta_median: h13Eval.median - baseEval.median,
        delta_p95: h13Eval.p95 - baseEval.p95,
        delta_b_median: h13bEval.median - baseEval.median,
        delta_b_p95: h13bEval.p95 - baseEval.p95,
        delta_c_median: h13cEval.median - baseEval.median,
        delta_c_p95: h13cEval.p95 - baseEval.p95,
      })
    }
  }

  // Aggregates.
  const meds = rows.map((r) => r.base_median)
  const h13s = rows.map((r) => r.h13_median)
  const h13bs = rows.map((r) => r.h13b_median)
  const wins = rows.filter((r) => r.delta_median < -0.1).length
  const losses = rows.filter((r) => r.delta_median > 0.1).length
  const winsB = rows.filter((r) => r.delta_b_median < -0.1).length
  const lossesB = rows.filter((r) => r.delta_b_median > 0.1).length
  const h13cs = rows.map((r) => r.h13c_median)
  const winsC = rows.filter((r) => r.delta_c_median < -0.1).length
  const lossesC = rows.filter((r) => r.delta_c_median > 0.1).length
  const cUsedB = rows.filter((r) => r.h13cUsedB).length
  const plains = rows.map((r) => r.plain_median)
  console.log(`\n=== Predictor sweep on ${rows.length} same-mode BC pairs (AllureAq excluded) ===`)
  console.log(`  plain D1: med-of-meds=${median(plains).toFixed(3)}  P95-of-meds=${percentile(plains, 95).toFixed(3)}    (no OBA wrapper)`)
  console.log(`  baseline: med-of-meds=${median(meds).toFixed(3)}  P95-of-meds=${percentile(meds, 95).toFixed(3)}    (D1+D7-default)`)
  console.log(`  H13     : med-of-meds=${median(h13s).toFixed(3)}  P95-of-meds=${percentile(h13s, 95).toFixed(3)}    (D1+M2 + paper-scaled emission)`)
  console.log(`  H13b    : med-of-meds=${median(h13bs).toFixed(3)}  P95-of-meds=${percentile(h13bs, 95).toFixed(3)}    (D1+M2 + anchor kNN emission)`)
  console.log(`  H13c    : med-of-meds=${median(h13cs).toFixed(3)}  P95-of-meds=${percentile(h13cs, 95).toFixed(3)}    (adaptive: ≥${H13C_OBA_MISMATCH_THRESHOLD} → H13b, < → plain D1; used H13b on ${cUsedB}/${rows.length})`)
  console.log(`  H13  wins ≥0.1: ${wins}/${rows.length}   losses ≥0.1: ${losses}`)
  console.log(`  H13b wins ≥0.1: ${winsB}/${rows.length}   losses ≥0.1: ${lossesB}`)
  console.log(`  H13c wins ≥0.1: ${winsC}/${rows.length}   losses ≥0.1: ${lossesC}`)
  const basePass = rows.filter((r) => r.base_median <= 1.5 && r.base_p95 <= 3.0).length
  const h13Pass = rows.filter((r) => r.h13_median <= 1.5 && r.h13_p95 <= 3.0).length
  const h13bPass = rows.filter((r) => r.h13b_median <= 1.5 && r.h13b_p95 <= 3.0).length
  const h13cPass = rows.filter((r) => r.h13c_median <= 1.5 && r.h13c_p95 <= 3.0).length
  console.log(`  H4 pass: baseline ${(basePass / rows.length * 100).toFixed(1)}%  H13 ${(h13Pass / rows.length * 100).toFixed(1)}%  H13b ${(h13bPass / rows.length * 100).toFixed(1)}%  H13c ${(h13cPass / rows.length * 100).toFixed(1)}%`)

  // Per-mode breakdown.
  const byMode = new Map<string, Row[]>()
  for (const r of rows) {
    if (!byMode.has(r.preset)) byMode.set(r.preset, [])
    byMode.get(r.preset)!.push(r)
  }
  console.log('\n=== Per-mode H13 / H13b effect (medians) ===')
  console.log(`${'mode'.padEnd(24)} ${'n'.padStart(4)} ${'base'.padStart(8)} ${'H13'.padStart(8)} ${'Δ13'.padStart(8)} ${'H13b'.padStart(8)} ${'Δ13b'.padStart(8)}`)
  for (const mode of [...byMode.keys()].sort()) {
    const rs = byMode.get(mode)!
    const bm = median(rs.map((r) => r.base_median))
    const hm = median(rs.map((r) => r.h13_median))
    const hbm = median(rs.map((r) => r.h13b_median))
    console.log(`${mode.padEnd(24)} ${String(rs.length).padStart(4)} ${bm.toFixed(3).padStart(8)} ${hm.toFixed(3).padStart(8)} ${(hm - bm).toFixed(3).padStart(8)} ${hbm.toFixed(3).padStart(8)} ${(hbm - bm).toFixed(3).padStart(8)}`)
  }

  // Top 5 H13b wins / losses.
  console.log('\nTop 5 H13b WINS (largest Δb_median negative):')
  rows.sort((a, b) => a.delta_b_median - b.delta_b_median).slice(0, 5).forEach((r) =>
    console.log(`  ${r.preset.padEnd(20)} ${r.ref.slice(0, 30).padEnd(30)} → ${r.target.slice(0, 30).padEnd(30)} base=${r.base_median.toFixed(2)} H13b=${r.h13b_median.toFixed(2)} Δ=${r.delta_b_median.toFixed(2)}`),
  )
  console.log('\nTop 5 H13b LOSSES (largest Δb_median positive):')
  rows.sort((a, b) => b.delta_b_median - a.delta_b_median).slice(0, 5).forEach((r) =>
    console.log(`  ${r.preset.padEnd(20)} ${r.ref.slice(0, 30).padEnd(30)} → ${r.target.slice(0, 30).padEnd(30)} base=${r.base_median.toFixed(2)} H13b=${r.h13b_median.toFixed(2)} Δ=${r.delta_b_median.toFixed(2)}`),
  )

  // Save JSON.
  const OUT = path.resolve(process.cwd(), 'data/cae-input/h13_m0m2.json')
  await fs.mkdir(path.dirname(OUT), { recursive: true })
  await fs.writeFile(OUT, JSON.stringify({ pairs: rows.length, rows }, null, 2))
  console.log(`\nWrote ${path.relative(ROOT, OUT)}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
