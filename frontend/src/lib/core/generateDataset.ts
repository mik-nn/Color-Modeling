/**
 * generateDataset — orchestrator for few-patch substrate transfer.
 *
 * 1+ reference profiles (same print mode) + k measured anchor patches
 * on a new substrate → predicted full N×36 spectral dataset.
 *
 * 1 ref  → D1 pipeline (D7 OBA + paper-ratio + rank-5 PCA residual).
 * N refs → pool-PCA pipeline (D7 OBA + fitPoolBasis + runPoolPCATransfer).
 *
 * Chart tiers (H31/H42): k=6 (76.9%), k=8 cov8n (82.7%), k=12 (88.5%).
 *
 * @module lib/core/generateDataset
 */

import type { ProfileData } from '../../types'
import { loadProfileMatrix } from '../dataset/matrix'
import { mapDeviceToAnchorIdx } from './coverage6Chart'
import {
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
} from '../predict/obaSeparator'
import {
  runPaperRatioResidualTransfer,
} from '../predict/paperRatioResidual'
import {
  fitPoolBasis,
  runPoolPCATransfer,
} from '../predict/poolPCATransfer'
import { paperWPFromBrightestPatch } from '../predict/perLambdaAffine'

const L = 36
const D1_RANK = 5
const D1_UV = 4
const D1_KNN = 4

export interface AnchorMeasurement {
  /** RGB device values 0–255 (the values printed on the new substrate). */
  device: [number, number, number]
  /** 36-band reflectance spectrum (380–730 nm, 10 nm step), values in [0,1]. */
  spectrum: number[]
}

export interface GenerateDatasetInput {
  /** 1 or N reference profiles — same print mode. */
  refs: ProfileData[]
  /** k measured patches on the new substrate (coverage-6, cov8n, or cov12). */
  anchors: AnchorMeasurement[]
  /** Chart tier: 6, 8, or 12. Must match anchors.length (or less after dedup). */
  chartK: 6 | 8 | 12
  /** Name tag for the generated profile (used in reports). */
  targetName: string
}

export interface GenerateDatasetResult {
  /** Predicted spectra N×36 for the new substrate (row-major). */
  predicted: Float64Array
  /** Device RGB values N×3 taken from the (first) reference. */
  deviceValues: Float64Array
  /** Sample IDs from the (first) reference, length N. */
  sampleIds: string[]
  /** Row indices in the reference that were used as anchors. */
  anchorIdx: number[]
  /** Which prediction path was taken. */
  path: 'D1' | 'pool-PCA'
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function validate(input: GenerateDatasetInput): void {
  if (!input.refs.length) {
    throw new Error('generateDataset: need at least one reference profile')
  }
  if (input.anchors.length < input.chartK) {
    throw new Error(
      `generateDataset: anchor count (${input.anchors.length}) < chartK (${input.chartK})`,
    )
  }
  const hasPaper = input.anchors.some(
    (a) => a.device[0] === 255 && a.device[1] === 255 && a.device[2] === 255,
  )
  if (!hasPaper) {
    throw new Error(
      'generateDataset: anchors must include a paper-white patch (255,255,255)',
    )
  }
}

// --------------------------------------------------------------------------
// Build X_B_sparse: N×L matrix with only anchor rows populated
// --------------------------------------------------------------------------

function buildSparseTarget(
  anchorIdx: number[],
  anchors: AnchorMeasurement[],
  N: number,
): Float64Array {
  const X_B = new Float64Array(N * L)
  for (let j = 0; j < anchorIdx.length; j++) {
    const row = anchorIdx[j]
    const spec = anchors[j].spectrum
    for (let l = 0; l < L; l++) {
      X_B[row * L + l] = spec[l]
    }
  }
  return X_B
}

// --------------------------------------------------------------------------
// Find paper row index in a device matrix
// --------------------------------------------------------------------------

function findPaperRow(D: Float64Array, N: number): number {
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) {
      return i
    }
  }
  // Fallback: brightest patch
  let best = -Infinity, bestIdx = 0
  for (let i = 0; i < N; i++) {
    const s = D[i * 3] + D[i * 3 + 1] + D[i * 3 + 2]
    if (s > best) { best = s; bestIdx = i }
  }
  return bestIdx
}

// --------------------------------------------------------------------------
// D1 pipeline — single reference
// --------------------------------------------------------------------------

function runD1(
  ref: ProfileData,
  anchors: AnchorMeasurement[],
  _chartK: number,
  targetName: string,
  anchorIdx: number[],
): GenerateDatasetResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mat = loadProfileMatrix(ref as any)
  const { N, X, D, sampleIds } = mat

  // Paper row
  const paperRowIdx = findPaperRow(D, N)

  // OBA on reference paper
  const emA = extractOBAEmission(Array.from(X.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const fA = computeOBAFactorPerPatch(X, L, paperRowIdx)
  const X_A_clean = subtractOBA(X, L, fA, emA.emission)

  // Build sparse target matrix (only anchor rows populated)
  const X_B_sparse = buildSparseTarget(anchorIdx, anchors, N)

  // OBA on target paper (from paper anchor 255,255,255)
  const paperAnchorIdx = anchorIdx.find((idx) =>
    D[idx * 3] === 255 && D[idx * 3 + 1] === 255 && D[idx * 3 + 2] === 255,
  ) ?? anchorIdx[0]
  const paperSpecB = Array.from(X_B_sparse.subarray(paperAnchorIdx * L, paperAnchorIdx * L + L))
  const emB = extractOBAEmission(paperSpecB)

  // OBA factor: X_B_sparse has zeros for non-anchor patches →
  // computeOBAFactorPerPatch gives 0 → addOBA adds nothing for those rows.
  // Fix: scale reference OBA factors by (target_paper / ref_paper) ratio.
  // OBA factor is device-driven; per-patch ratio preserved across substrates.
  const fB_anchors = computeOBAFactorPerPatch(X_B_sparse, L, paperAnchorIdx)
  const fA_paperVal = Math.max(1e-5, fA[paperRowIdx])
  const fB_paperVal = fB_anchors[paperAnchorIdx]
  const obaScale = fB_paperVal / fA_paperVal
  const fB = new Float64Array(N)
  for (let i = 0; i < N; i++) fB[i] = fA[i] * obaScale
  // Override anchor rows with directly measured factors (more accurate than scaled)
  for (const idx of anchorIdx) fB[idx] = fB_anchors[idx]

  const X_B_clean = subtractOBA(X_B_sparse, L, fB, emB.emission)

  // Paper white point (from target paper spectrum)
  const paperWP = paperWPFromBrightestPatch(
    new Float64Array(X_B_sparse.subarray(paperAnchorIdx * L, paperAnchorIdx * L + L)),
    1, L, 380,
  )

  // D1 transfer
  const d1 = runPaperRatioResidualTransfer({
    X_A: X_A_clean,
    X_B: X_B_clean,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: ref.metadata.full_name,
    targetProfile: targetName,
    residualRank: D1_RANK,
    knnK: D1_KNN,
    uvBandCount: D1_UV,
  })

  // Refine OBA factors using predicted R(380) values (self-consistent).
  // D1 output gives estimated R_B(380,i) for all patches; use these to
  // compute fB_final[i] = R_B_pred(380,i) / R_B_pred(380,paper), which is
  // more accurate than ref-scaled estimate for non-anchor patches.
  const predPaper380 = d1.X_pred[paperAnchorIdx * L]
  if (predPaper380 > 1e-5) {
    for (let i = 0; i < N; i++) {
      fB[i] = d1.X_pred[i * L] / predPaper380
    }
    // Keep directly measured anchor factors (override self-consistent estimate)
    for (const idx of anchorIdx) fB[idx] = fB_anchors[idx]
  }

  // Add target OBA back
  const predicted = addOBA(d1.X_pred, L, fB, emB.emission)

  return {
    predicted,
    deviceValues: D,
    sampleIds,
    anchorIdx,
    path: 'D1',
  }
}

// --------------------------------------------------------------------------
// Pool-PCA pipeline — multiple references
// --------------------------------------------------------------------------

function runPoolPCA(
  refs: ProfileData[],
  anchors: AnchorMeasurement[],
  _chartK: number,
  targetName: string,
  anchorIdx: number[],
): GenerateDatasetResult {
  // Use first ref as the primary (device values + sampleIds come from it)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const primaryMat = loadProfileMatrix(refs[0] as any)
  const { N, D, sampleIds } = primaryMat

  // Build pool basis from ALL refs
  const matrices: Float64Array[] = []
  const rowCounts: number[] = []
  for (const ref of refs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = loadProfileMatrix(ref as any)
    matrices.push(m.X)
    rowCounts.push(m.N)
  }
  const basis = fitPoolBasis({ matrices, rowCounts, L, p: Math.min(5, anchorIdx.length - 1) })

  // Paper handling (primary ref)
  const paperRowIdx = findPaperRow(D, N)
  const emA = extractOBAEmission(
    Array.from(primaryMat.X.subarray(paperRowIdx * L, paperRowIdx * L + L)),
  )
  const fA = computeOBAFactorPerPatch(primaryMat.X, L, paperRowIdx)
  const X_A_clean = subtractOBA(primaryMat.X, L, fA, emA.emission)

  // Sparse target
  const X_B_sparse = buildSparseTarget(anchorIdx, anchors, N)
  const paperAnchorIdx = anchorIdx.find((idx) =>
    D[idx * 3] === 255 && D[idx * 3 + 1] === 255 && D[idx * 3 + 2] === 255,
  ) ?? anchorIdx[0]
  const paperSpecB = Array.from(X_B_sparse.subarray(paperAnchorIdx * L, paperAnchorIdx * L + L))
  const emB = extractOBAEmission(paperSpecB)
  const fB = computeOBAFactorPerPatch(X_B_sparse, L, paperAnchorIdx)
  const X_B_clean = subtractOBA(X_B_sparse, L, fB, emB.emission)

  const paperWP = paperWPFromBrightestPatch(
    new Float64Array(X_B_sparse.subarray(paperAnchorIdx * L, paperAnchorIdx * L + L)),
    1, L, 380,
  )

  const poolResult = runPoolPCATransfer({
    basis,
    X_ref: X_A_clean,
    X_target: X_B_clean,
    sampleIds,
    anchorIdx,
    L,
    paperWP,
    refProfile: refs.map((r) => r.metadata.full_name).join('+'),
    targetProfile: targetName,
  })

  const predicted = addOBA(poolResult.X_pred, L, fB, emB.emission)

  return {
    predicted,
    deviceValues: D,
    sampleIds,
    anchorIdx,
    path: 'pool-PCA',
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Generate a full spectral dataset for a new substrate from few anchor
 * measurements and one or more reference profiles (same print mode).
 *
 * Routes to D1 (1 ref) or pool-PCA (N refs) automatically.
 */
export function generateDataset(input: GenerateDatasetInput): GenerateDatasetResult {
  validate(input)

  const { refs, anchors, chartK, targetName } = input

  // Map anchor device coordinates to patch indices in the primary reference
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const primaryMat = loadProfileMatrix(refs[0] as any)
  const chartResult = mapDeviceToAnchorIdx(primaryMat, chartK)
  const anchorIdx = chartResult.anchorIdx

  // Re-order anchors to match the index order returned by mapDeviceToAnchorIdx
  const orderedAnchors = chartResult.metadata.matched.map(([mr, mg, mb]) => {
    // Find the anchor measurement closest to matched device RGB
    let best = anchors[0]
    let bestD = Infinity
    for (const a of anchors) {
      const d = (a.device[0] - mr) ** 2 + (a.device[1] - mg) ** 2 + (a.device[2] - mb) ** 2
      if (d < bestD) { bestD = d; best = a }
    }
    return best
  })

  if (refs.length === 1) {
    return runD1(refs[0], orderedAnchors, chartK, targetName, anchorIdx)
  }
  return runPoolPCA(refs, orderedAnchors, chartK, targetName, anchorIdx)
}
