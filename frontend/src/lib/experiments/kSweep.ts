// src/lib/experiments/kSweep.ts
//
// k-sweep harness: for each directed profile pair, runs two anchor strategies
// (greedy worst-patch and D-optimal SVD-based), samples k ∈ kGrid, and
// aggregates per (predictor × strategy × slice × k):
//   - median-of-medians ΔE00
//   - p95-of-medians ΔE00
//   - pass-fraction (H4 gate: median ≤ 1.5 AND p95 ≤ 3.0)
//
// No React. No side-effects. Import-safe in a Web Worker.

import type { ProfileData, PredictionReport, WhitePointXYZ } from '../../types'
import {
  loadProfileMatrix,
  alignByCommonSampleIds,
  alignByDeviceGrid,
} from '../dataset/matrix'
import { fitPCA, pcaProject } from '../dataset/basis'
import { runGreedyActiveAnchors } from '../sampling/greedy'
import { runPaperRatioResidualTransfer } from '../predict/paperRatioResidual'
import { runPerLambdaCurveTransfer } from '../predict/perLambdaCurve'
import { paperWPFromBrightestPatch } from '../predict/perLambdaAffine'
import { canonicalPrintMode } from '../../utils/printMode'

// ─── Public types ────────────────────────────────────────────────────────────

export type KSweepPredictor = 'D1' | 'C7'
export type AnchorStrategy = 'greedy' | 'dOptimal'
export type PairSlice = 'same-mode' | 'cross-mode'

export interface KSweepRow {
  predictor: KSweepPredictor
  anchorStrategy: AnchorStrategy
  slice: PairSlice
  k: number
  medianOfMedians: number
  p95OfMedians: number
  passFraction: number
  nPairs: number
}

export interface MinKEntry {
  predictor: KSweepPredictor
  anchorStrategy: AnchorStrategy
  slice: PairSlice
  /** First k in kGrid where passFraction >= passGate, or null if never reached. */
  k: number | null
}

export interface KSweepResult {
  perK: KSweepRow[]
  minKToPass: MinKEntry[]
  /** Total pairs evaluated (both slices). */
  totalPairs: number
}

export interface KSweepOptions {
  predictors?: KSweepPredictor[]
  anchorStrategies?: AnchorStrategy[]
  kGrid?: number[]
  maxPairsPerSlice?: number
  /** H4 median gate. Default 1.5. */
  medianGate?: number
  /** H4 p95 gate. Default 3.0. */
  p95Gate?: number
  /** Fraction of pairs that must pass the gate. Default 0.80. */
  passGate?: number
  onProgress?: (done: number, total: number) => void
}

// ─── D-optimal anchor selection (greedy Gram-Schmidt in PC space) ─────────────

/**
 * Select k anchors from X_A (N×L) that span the leading PC subspace
 * of X_A — a proxy for the residual B−A's column space when B ≈ A.
 *
 * Always includes paperRowIdx as the first anchor (paper must be measured).
 * Uses greedy orthogonal pivoting: at each step the row with the largest
 * residual after projecting out the current span is added.
 *
 * O(k × N × r) time, r = min(8, N−1, L).
 */
export function dOptimalAnchors(
  X_A: Float64Array,
  N: number,
  L: number,
  paperRowIdx: number,
  k: number,
): number[] {
  if (k <= 0 || N <= 0) return []
  const r = Math.min(8, N - 1, L)
  const basis = fitPCA(X_A, N, L, r)
  const Z = pcaProject(X_A, N, basis) // N×r

  // Working residual matrix — starts as a copy of Z.
  const residuals = Z.slice() // N×r

  const anchors: number[] = [paperRowIdx]
  const anchorSet = new Set<number>([paperRowIdx])
  _projectOut(residuals, N, r, paperRowIdx)

  while (anchors.length < k) {
    let bestIdx = -1
    let bestNorm2 = 0
    for (let i = 0; i < N; i++) {
      if (anchorSet.has(i)) continue
      let n2 = 0
      for (let j = 0; j < r; j++) {
        const v = residuals[i * r + j]
        n2 += v * v
      }
      if (n2 > bestNorm2) {
        bestNorm2 = n2
        bestIdx = i
      }
    }
    if (bestIdx < 0) break
    anchors.push(bestIdx)
    anchorSet.add(bestIdx)
    _projectOut(residuals, N, r, bestIdx)
  }

  return anchors
}

/** Project out the direction of residuals[rowIdx] from every row. */
function _projectOut(residuals: Float64Array, N: number, r: number, rowIdx: number): void {
  let norm2 = 0
  for (let j = 0; j < r; j++) {
    const v = residuals[rowIdx * r + j]
    norm2 += v * v
  }
  if (norm2 < 1e-14) return
  const inv = 1 / norm2
  for (let i = 0; i < N; i++) {
    let dot = 0
    for (let j = 0; j < r; j++) dot += residuals[i * r + j] * residuals[rowIdx * r + j]
    dot *= inv
    for (let j = 0; j < r; j++) residuals[i * r + j] -= dot * residuals[rowIdx * r + j]
  }
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

function _sortedMedian(arr: number[]): number {
  if (arr.length === 0) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

function _sortedP95(arr: number[]): number {
  if (arr.length === 0) return NaN
  const s = arr.slice().sort((a, b) => a - b)
  const pos = 0.95 * (s.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

// ─── Per-pair dispatch helpers ────────────────────────────────────────────────

interface PairMatrices {
  X_A: Float64Array
  X_B: Float64Array
  D_B: Float64Array
  sampleIds: string[]
  N: number
  L: number
  paperRowIdx: number
  paperWP: WhitePointXYZ
  refName: string
  tgtName: string
}

function makeD1Dispatch(m: PairMatrices) {
  return (anchorIdx: number[]): PredictionReport =>
    runPaperRatioResidualTransfer({
      X_A: m.X_A,
      X_B: m.X_B,
      D: m.D_B,
      sampleIds: m.sampleIds,
      anchorIdx,
      paperRowIdx: anchorIdx[0] ?? m.paperRowIdx,
      L: m.L,
      paperWP: m.paperWP,
      refProfile: m.refName,
      targetProfile: m.tgtName,
      residualRank: 5,
      uvBandCount: 4,
    }).report
}

function makeC7Dispatch(m: PairMatrices) {
  return (anchorIdx: number[]): PredictionReport =>
    runPerLambdaCurveTransfer({
      X_A: m.X_A,
      X_B: m.X_B,
      sampleIds: m.sampleIds,
      anchorIdx,
      L: m.L,
      paperWP: m.paperWP,
      refProfile: m.refName,
      targetProfile: m.tgtName,
    }).report
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Run the k-sweep experiment on a set of profiles.
 *
 * For each directed pair (ref → tgt) up to maxPairsPerSlice per slice:
 *   - Aligns matrices (same-chart or cross-chart fallback).
 *   - Runs greedy (no-early-stop trajectory k=1..max(kGrid)) and D-optimal
 *     (one evaluation per kGrid value) for each predictor.
 *   - Aggregates pass-fraction and median-of-medians ΔE00.
 */
export function runKSweep(profiles: ProfileData[], opts: KSweepOptions = {}): KSweepResult {
  const {
    predictors = ['D1', 'C7'],
    anchorStrategies = ['greedy', 'dOptimal'],
    kGrid = [3, 5, 8, 13, 20, 30],
    maxPairsPerSlice = 60,
    medianGate = 1.5,
    p95Gate = 3.0,
    passGate = 0.80,
    onProgress,
  } = opts

  const kGridSorted = [...kGrid].sort((a, b) => a - b)
  const maxK = kGridSorted[kGridSorted.length - 1]

  // Per-profile metadata for slice classification.
  const presets = profiles.map(p => {
    try {
      return canonicalPrintMode(p.metadata)
    } catch {
      return null
    }
  })

  // Collect all valid directed pairs, classify by slice.
  const samePairs: [number, number][] = []
  const crossPairs: [number, number][] = []
  for (let a = 0; a < profiles.length; a++) {
    for (let b = 0; b < profiles.length; b++) {
      if (a === b) continue
      const pa = presets[a]
      const pb = presets[b]
      if (pa !== null && pb !== null && pa === pb) {
        samePairs.push([a, b])
      } else {
        crossPairs.push([a, b])
      }
    }
  }

  // Deterministic shuffle → cap to maxPairsPerSlice.
  // Use a simple deterministic subset (first N pairs in enumeration order).
  const sampledSame = samePairs.slice(0, maxPairsPerSlice)
  const sampledCross = crossPairs.slice(0, maxPairsPerSlice)
  const allPairs: { idx: [number, number]; slice: PairSlice }[] = [
    ...sampledSame.map(idx => ({ idx, slice: 'same-mode' as const })),
    ...sampledCross.map(idx => ({ idx, slice: 'cross-mode' as const })),
  ]

  const totalWork = allPairs.length
  let doneWork = 0

  // Accumulators: key = `predictor|strategy|slice|k`
  const acc = new Map<
    string,
    { medians: number[]; p95s: number[]; passes: number; total: number }
  >()

  const accKey = (
    pred: KSweepPredictor,
    strat: AnchorStrategy,
    slice: PairSlice,
    k: number,
  ) => `${pred}|${strat}|${slice}|${k}`

  const ensureAcc = (key: string) => {
    if (!acc.has(key)) acc.set(key, { medians: [], p95s: [], passes: 0, total: 0 })
    return acc.get(key)!
  }

  for (const { idx: [ai, bi], slice } of allPairs) {
    try {
      const pm = _buildPairMatrices(profiles[ai], profiles[bi])
      if (!pm) continue

      for (const predictor of predictors) {
        const dispatch =
          predictor === 'D1' ? makeD1Dispatch(pm) : makeC7Dispatch(pm)

        // ── Greedy strategy ──────────────────────────────────────────────────
        if (anchorStrategies.includes('greedy')) {
          try {
            const result = runGreedyActiveAnchors({
              predict: dispatch,
              seedAnchors: [pm.paperRowIdx],
              sampleIds: pm.sampleIds,
              targetMedianDE: -Infinity,
              maxK,
            })
            // trajectory[i].k == i + 1 (seeded at k=1)
            for (const k of kGridSorted) {
              const stepIdx = k - 1
              if (stepIdx < 0 || stepIdx >= result.trajectory.length) continue
              const report = result.trajectory[stepIdx].report
              const key = accKey(predictor, 'greedy', slice, k)
              const a = ensureAcc(key)
              a.medians.push(report.medianDE00)
              a.p95s.push(report.p95DE00)
              a.total++
              if (report.medianDE00 <= medianGate && report.p95DE00 <= p95Gate) a.passes++
            }
          } catch {
            // skip failed pairs
          }
        }

        // ── D-optimal strategy ───────────────────────────────────────────────
        if (anchorStrategies.includes('dOptimal')) {
          for (const k of kGridSorted) {
            try {
              const anchors = dOptimalAnchors(pm.X_A, pm.N, pm.L, pm.paperRowIdx, k)
              // C7 requires k ≥ 2; D1 works at k ≥ 1.
              if (anchors.length < (predictor === 'C7' ? 2 : 1)) continue
              const report = dispatch(anchors)
              const key = accKey(predictor, 'dOptimal', slice, k)
              const a = ensureAcc(key)
              a.medians.push(report.medianDE00)
              a.p95s.push(report.p95DE00)
              a.total++
              if (report.medianDE00 <= medianGate && report.p95DE00 <= p95Gate) a.passes++
            } catch {
              // skip failed k
            }
          }
        }
      }
    } catch {
      // skip failed pair alignment
    }

    doneWork++
    onProgress?.(doneWork, totalWork)
  }

  // ── Build perK rows ─────────────────────────────────────────────────────────
  const perK: KSweepRow[] = []
  for (const pred of predictors) {
    for (const strat of anchorStrategies) {
      for (const slice of ['same-mode', 'cross-mode'] as PairSlice[]) {
        for (const k of kGridSorted) {
          const key = accKey(pred, strat, slice, k)
          const a = acc.get(key)
          if (!a || a.total === 0) continue
          perK.push({
            predictor: pred,
            anchorStrategy: strat,
            slice,
            k,
            medianOfMedians: _sortedMedian(a.medians),
            p95OfMedians: _sortedP95(a.medians),
            passFraction: a.passes / a.total,
            nPairs: a.total,
          })
        }
      }
    }
  }

  // ── minKToPass ──────────────────────────────────────────────────────────────
  const minKToPass: MinKEntry[] = []
  for (const pred of predictors) {
    for (const strat of anchorStrategies) {
      for (const slice of ['same-mode', 'cross-mode'] as PairSlice[]) {
        const rows = perK.filter(
          r => r.predictor === pred && r.anchorStrategy === strat && r.slice === slice,
        )
        const found = rows.find(r => r.passFraction >= passGate)
        minKToPass.push({
          predictor: pred,
          anchorStrategy: strat,
          slice,
          k: found ? found.k : null,
        })
      }
    }
  }

  return {
    perK,
    minKToPass,
    totalPairs: allPairs.length,
  }
}

// ─── Internal: align two profiles and extract pair matrices ──────────────────

function _buildPairMatrices(
  refProfile: ProfileData,
  tgtProfile: ProfileData,
): PairMatrices | null {
  const A = loadProfileMatrix(refProfile)
  const B = loadProfileMatrix(tgtProfile)
  if (A.channels !== 3 || B.channels !== 3 || A.L !== B.L) return null

  const L = A.L
  let N: number
  let sampleIds: string[]
  let X_A: Float64Array
  let X_B: Float64Array
  let D_B: Float64Array

  const aligned = alignByCommonSampleIds(A, B)
  if (aligned.sampleIds.length >= 50) {
    N = aligned.sampleIds.length
    sampleIds = aligned.sampleIds
    X_A = new Float64Array(N * L)
    X_B = new Float64Array(N * L)
    D_B = new Float64Array(N * 3)
    for (let i = 0; i < N; i++) {
      const ai = aligned.idxA[i]
      const bi = aligned.idxB[i]
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = A.X[ai * L + l]
        X_B[i * L + l] = B.X[bi * L + l]
      }
      for (let c = 0; c < 3; c++) D_B[i * 3 + c] = B.D[bi * 3 + c]
    }
  } else {
    const g = alignByDeviceGrid(A, B)
    if (g.N < 50) return null
    N = g.N
    sampleIds = g.sampleIds
    X_A = g.X_A
    X_B = g.X_B
    D_B = g.D
  }

  // Paper row: nearest to (255,255,255) in D_B.
  const paperRowIdx = (() => {
    let best = 0
    let bestDist = Infinity
    for (let i = 0; i < N; i++) {
      const dr = D_B[i * 3] - 255
      const dg = D_B[i * 3 + 1] - 255
      const db = D_B[i * 3 + 2] - 255
      const d = dr * dr + dg * dg + db * db
      if (d < bestDist) { bestDist = d; best = i }
    }
    return best
  })()

  const paperSpecB = new Float64Array(L)
  for (let l = 0; l < L; l++) paperSpecB[l] = X_B[paperRowIdx * L + l]
  const paperWP = paperWPFromBrightestPatch(paperSpecB, 1, L, A.wavelengths[0] ?? 380)

  return {
    X_A, X_B, D_B, sampleIds, N, L, paperRowIdx, paperWP,
    refName: refProfile.metadata.full_name,
    tgtName: tgtProfile.metadata.full_name,
  }
}
