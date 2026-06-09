// src/components/TransferView.tsx
//
// Phase 2 + Phase 3 deliverable: cross-substrate transfer with a chooser of
// predictor variants. The user picks a reference profile (full), a target
// profile (treated as if only a few anchors were measured), and a predictor:
//
//   - A3 (per-λ affine):    72 free params, closed-form OLS, baseline.
//   - D1 (paper-ratio + PCA residual): graceful at small k; lowest k for a
//     given ΔE00 target in practice.
//
// Both use the S1 forced anchor strategy (paper + 6 RGB primaries + black +
// 5 neutrals = 13 anchors). Metrics are evaluated on the 905 − 13 = 892
// held-out patches under paper-relative D50/2° Lab.
//
// Honest framing: empirical regression of B(λ, RGB) from A(λ, RGB). No
// physics claim, no "primaries" interpretation on RGB-addressed datasets.

import { useMemo, useState } from 'react'
import type { AnchorSet, ProfileData, PredictionReport, WhitePointXYZ } from '../types'
import { loadProfileMatrix, alignProfiles } from '../lib/dataset/matrix'
import { buildWlsInterpolator, type WlsInterpOptions } from '../lib/interp/wlsInterp'
import type { InterpPoint } from '../lib/interp/rgbInterp'
import { pickHeuristicAnchors } from '../lib/sampling/heuristic'
import {
  runPerLambdaAffineTransfer,
  paperWPFromBrightestPatch,
} from '../lib/predict/perLambdaAffine'
import { runPaperRatioResidualTransfer } from '../lib/predict/paperRatioResidual'
import { detectOBA, obaMismatch, obaMismatchSeverity, type OBAInfo } from '../lib/predict/oba'
import { fitPoolBasis, runPoolPCATransfer } from '../lib/predict/poolPCATransfer'
import { runPerLambdaCurveTransfer, applyPerLambdaCurve } from '../lib/predict/perLambdaCurve'
import { evaluatePrediction } from '../lib/dataset/evaluate'
import { runGreedyActiveAnchors, type GreedyResult } from '../lib/sampling/greedy'
import { pickChannelRampAnchors, type RampChannel } from '../lib/sampling/channelRamp'
import { pickLabSaturationAnchors } from '../lib/sampling/labSaturation'
import {
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
  type OBAExtraction,
} from '../lib/predict/obaSeparator'
import { applyPerLambdaAffine } from '../lib/predict/perLambdaAffine'
import { spectraToLab } from '../lib/colormath'
import { runCAETransfer, buildAnchorResiduals, type CAEWeights } from '../lib/predict/cae'
import { predictTargetWithLOO, type LOOProfileData } from '../lib/analyzers/dynamicLOO'
import caeWeightsRaw from '../data/cae_weights_raw.json'
import caeWeightsD7M1 from '../data/cae_weights_d7_m1.json'
// Per-mode CAE_D7 weight bundles. Each is trained on a single Epson media preset
// (homogeneous chart, narrower substrate manifold → much lower validation MSE).
// `cae_weights_d7.json` stays as the legacy 36-profile mixed-pool fallback.
import caeWeightsD7WCRW from '../data/cae_weights_d7_WCRW.json'
import caeWeightsD7USFA from '../data/cae_weights_d7_USFA.json'
import caeWeightsD7CanvasMatte from '../data/cae_weights_d7_CanvasMatte.json'
import caeWeightsD7PremiumLuster from '../data/cae_weights_d7_PremiumLuster.json'
import caeWeightsD7Full36 from '../data/cae_weights_d7_full36.json'
import { canonicalPrintMode, EpsonPreset } from '../utils/printMode'

type PredictorKey =
  | 'A3'
  | 'D1'
  | 'B3'
  | 'C7'
  | 'CAE_RAW'
  | 'CAE_D7'
  | 'CAE_D7_M1'
  | 'CAE_D7_3ANCHOR'
  | 'CAE_LOO'
  | 'A3_vs_D1'
  | 'ALL'

const CAE_WEIGHTS_RAW = caeWeightsRaw as unknown as CAEWeights
const CAE_WEIGHTS_D7_M1 = caeWeightsD7M1 as unknown as CAEWeights

// Registry of per-mode CAE_D7 bundles keyed by canonical Epson preset.
// Each was trained on a single preset (homogeneous chart, narrow substrate
// manifold) — much lower validation MSE than the 36-profile mixed-pool fallback.
const CAE_D7_BY_MODE: Partial<Record<EpsonPreset, CAEWeights>> = {
  WatercolorRadiantWhite: caeWeightsD7WCRW as unknown as CAEWeights,
  UltrasmoothFineArt: caeWeightsD7USFA as unknown as CAEWeights,
  CanvasMatte: caeWeightsD7CanvasMatte as unknown as CAEWeights,
  PremiumLuster: caeWeightsD7PremiumLuster as unknown as CAEWeights,
}
const CAE_WEIGHTS_D7_FULL36 = caeWeightsD7Full36 as unknown as CAEWeights

function pickCaeD7Bundle(
  refProfile: ProfileData | null,
  targetProfile: ProfileData | null,
): { weights: CAEWeights; mode: 'full36' | EpsonPreset; matched: boolean } {
  if (!refProfile || !targetProfile) {
    return { weights: CAE_WEIGHTS_D7_FULL36, mode: 'full36', matched: false }
  }
  try {
    const refPreset = canonicalPrintMode(refProfile.metadata)
    const tgtPreset = canonicalPrintMode(targetProfile.metadata)
    if (refPreset === tgtPreset) {
      const bundle = CAE_D7_BY_MODE[refPreset]
      if (bundle) return { weights: bundle, mode: refPreset, matched: true }
    }
  } catch {
    // canonicalPrintMode throws on unknown media → fall through.
  }
  return { weights: CAE_WEIGHTS_D7_FULL36, mode: 'full36', matched: false }
}
type AnchorStrategy = 'S1' | 'S2' | 'S3' | 'S4'

interface Props {
  profiles: ProfileData[]
}

interface PredictorRun {
  variant: 'A3' | 'D1' | 'B3' | 'C7' | 'CAE_RAW' | 'CAE_D7' | 'CAE_D7_M1' | 'CAE_D7_3ANCHOR' | 'CAE_LOO'
  report: PredictionReport
  perLambdaR2?: Float64Array // A3 only
  residualRank?: number // D1 only
  clampedBandCount?: number // D1 only
  poolSize?: number // B3 only
  basisRank?: number // B3 only
  greedy?: GreedyResult // S2 only
  caeRefInTrain?: boolean // CAE only
  caeTargetInTrain?: boolean // CAE only
  caeBestTestMSE?: number // CAE only
  looSupportCount?: number // CAE_LOO only
}

type RunResult =
  | { kind: 'error'; error: string }
  | {
      kind: 'ok'
      runs: PredictorRun[]
      anchors: AnchorSet
      alignedN: number
      /** True when profiles came from different charts and were aligned on a common RGB grid. */
      crossChart: boolean
      /** Target patches matched exactly by device coordinate. */
      exactCount: number
      /** Target patches reconstructed by k-NN IDW interpolation. */
      interpCount: number
      /** Interpolation noise floor (LOO RMS reflectance), null when interpCount===0. */
      looRms: number | null
      /** Which CAE_D7 weight bundle was used: per-mode preset name, or 'full36' fallback. */
      caeD7Mode: 'full36' | EpsonPreset
      caeD7ModeMatched: boolean
      obaRef: OBAInfo
      obaTarget: OBAInfo
      obaMismatchScore: number
      /** Present only when obaSeparate=true. Per-substrate analytic emission. */
      obaExtractionA?: OBAExtraction
      obaExtractionB?: OBAExtraction
      obaSeparateEnabled: boolean
    }

function deColor(de: number): string {
  if (de < 1.5) return 'text-emerald-400'
  if (de < 3.0) return 'text-yellow-400'
  return 'text-red-400'
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—'
}

/**
 * Evenly spaced ramp levels in the 0–255 device-addressing range,
 * EXCLUDING the paper endpoint (255, picked separately as the paper
 * anchor). Includes 0 (max ink) when `count ≥ 1`.
 */
function evenlySpacedRampLevels(count: number): number[] {
  if (count <= 0) return []
  if (count === 1) return [0]
  const out: number[] = []
  for (let i = 0; i < count; i++) {
    // i=0 → 192, i=last → 0, evenly spaced.
    const v = Math.round(192 * (1 - i / (count - 1)))
    out.push(v)
  }
  return out
}

/**
 * Pick 3 anchors: paper + 2 patches closest to Lab directions in a/b (chromatic) space.
 * Searches for patches closest to the requested chroma and hue angles.
 * Returns [paperRowIdx, anchor1Idx, anchor2Idx]. Indices are valid row positions.
 */
function pickLabDirectionAnchorIdx(
  X: Float64Array,
  D: Float64Array,
  N: number,
  L: number,
  startWL: number,
  paperRowIdx: number,
  paperWP: WhitePointXYZ,
  angle1Deg: number,
  angle2Deg: number,
  chroma: number,
): [number, number, number] {
  const a1 = (angle1Deg * Math.PI) / 180
  const a2 = (angle2Deg * Math.PI) / 180
  const tA1 = chroma * Math.cos(a1)
  const tB1 = chroma * Math.sin(a1)
  const tA2 = chroma * Math.cos(a2)
  const tB2 = chroma * Math.sin(a2)

  let best1 = -1
  let best2 = -1
  let d1 = Infinity
  let d2 = Infinity
  for (let i = 0; i < N; i++) {
    if (i === paperRowIdx) continue
    const row = Array.from(X.subarray(i * L, i * L + L))
    const [, aS, bS] = spectraToLab(row, startWL, paperWP)
    const da1 = (aS - tA1) ** 2 + (bS - tB1) ** 2
    const da2 = (aS - tA2) ** 2 + (bS - tB2) ** 2
    if (da1 < d1) {
      d1 = da1
      best1 = i
    }
    if (da2 < d2) {
      d2 = da2
      best2 = i
    }
  }
  return [paperRowIdx, best1, best2]
}

export default function TransferView({ profiles }: Props) {
  const [refName, setRefName] = useState<string>('')
  const [targetName, setTargetName] = useState<string>('')
  const [predictor, setPredictor] = useState<PredictorKey>('A3_vs_D1')
  const [residualRank, setResidualRank] = useState<number>(5)
  const [poolBasisRank, setPoolBasisRank] = useState<number>(6)
  const [anchorStrategy, setAnchorStrategy] = useState<AnchorStrategy>('S1')
  const [greedyTarget, setGreedyTarget] = useState<number>(1.5)
  const [greedyMaxK, setGreedyMaxK] = useState<number>(40)
  const [rampChannel, setRampChannel] = useState<RampChannel>('neutral')
  const [rampLevels, setRampLevels] = useState<number>(4)
  const [obaSeparate, setObaSeparate] = useState<boolean>(true)
  const [angle1, setAngle1] = useState<number>(45)
  const [angle2, setAngle2] = useState<number>(165)
  const [chromaTarget, setChromaTarget] = useState<number>(30)

  const refProfile = profiles.find((p) => p.metadata.full_name === refName)
  const targetProfile = profiles.find((p) => p.metadata.full_name === targetName)

  // sampleId → [R,G,B] for display (worst patches + anchors).
  const rgbBySampleId = useMemo(() => {
    const map = new Map<string, [number, number, number]>()
    const tgt = profiles.find((p) => p.metadata.full_name === targetName)
    if (!tgt) return map
    for (const m of tgt.raw) {
      const sid = m.SAMPLE_ID
      if (sid && m.RGB_R !== undefined && m.RGB_G !== undefined && m.RGB_B !== undefined) {
        map.set(sid, [m.RGB_R, m.RGB_G, m.RGB_B])
      }
    }
    return map
  }, [profiles, targetName])

  // Pool basis cache: rebuild when the set of loaded profiles changes
  // (excluding the target — pool must be independent of what we predict).
  const poolMatrices = useMemo(() => {
    if (profiles.length < 2) return null
    return profiles
      .filter((p) => p.metadata.full_name !== targetName)
      .map((p) => {
        try {
          return loadProfileMatrix(p)
        } catch {
          return null
        }
      })
      .filter((m): m is NonNullable<typeof m> => m !== null && m.channels === 3)
  }, [profiles, targetName])

  const result = useMemo<RunResult | null>(() => {
    if (!refProfile || !targetProfile || refProfile === targetProfile) return null
    try {
      const A = loadProfileMatrix(refProfile)
      const B = loadProfileMatrix(targetProfile)
      const L = A.L
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

      const Baligned = {
        X: X_B,
        D: D_B,
        channels: B.channels,
        N,
        L,
        wavelengths: B.wavelengths,
        sampleIds,
        droppedCount: 0,
      }

      const anchors = (() => {
        if (anchorStrategy === 'S3') {
          return pickChannelRampAnchors(Baligned, {
            channel: rampChannel,
            levels: evenlySpacedRampLevels(rampLevels),
          })
        }
        if (anchorStrategy === 'S4') {
          return pickLabSaturationAnchors(Baligned, { count: 2, minHueSeparationDeg: 90 })
        }
        return pickHeuristicAnchors(Baligned)
      })()
      const anchorIdx = anchors.meta?.chosenIdx as number[]
      const paperRowIdx = anchorIdx[0]

      // Paper-relative WP from the target's paper anchor spectrum.
      const paperSpecB = new Array<number>(L)
      const paperSpecA = new Array<number>(L)
      for (let l = 0; l < L; l++) {
        paperSpecB[l] = X_B[paperRowIdx * L + l]
      }
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
      for (let l = 0; l < L; l++) {
        paperSpecA[l] = X_A[paperRowIdxA * L + l]
      }
      const startWL = Baligned.wavelengths[0]
      const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, startWL)

      // OBA diagnostics for ref + target.
      const obaRef = detectOBA(paperSpecA, { startWL })
      const obaTarget = detectOBA(paperSpecB, { startWL })
      const obaMm = obaMismatch(obaRef, obaTarget)

      // D7 OBA separation (optional): extract emission analytically and
      // pre-clean both matrices. All predictors below see the clean spectra.
      // At evaluation/display time we add B's OBA emission back.
      let X_A_work: Float64Array = X_A
      let X_B_work: Float64Array = X_B
      let obaExtractionA: OBAExtraction | undefined
      let obaExtractionB: OBAExtraction | undefined
      let factorsA_local: Float64Array | undefined
      let factorsB_local: Float64Array | undefined
      if (obaSeparate) {
        obaExtractionA = extractOBAEmission(paperSpecA, { startWL })
        obaExtractionB = extractOBAEmission(paperSpecB, { startWL })
        factorsA_local = computeOBAFactorPerPatch(X_A, L, paperRowIdxA, { startWL })
        factorsB_local = computeOBAFactorPerPatch(X_B, L, paperRowIdx, { startWL })
        X_A_work = subtractOBA(X_A, L, factorsA_local, obaExtractionA.emission)
        X_B_work = subtractOBA(X_B, L, factorsB_local, obaExtractionB.emission)
      }

      const runs: PredictorRun[] = []

      // Predictor adapters: each takes a candidate anchor list and returns a
      // PredictionReport (+ extras for the UI). Same shape used by both the
      // S1 single-shot path and the S2 greedy loop.
      //
      // When D7 OBA-separation is enabled, X_A_work / X_B_work are the
      // OBA-clean matrices. The predictor sees clean spectra, but we
      // post-process by adding the target's OBA emission back to every
      // predicted row before evaluating against the (uncleaned) ground truth.
      //
      // Each adapter calls the underlying predictor and, when D7 is on,
      // augments the returned report with metrics recomputed after adding
      // OBA back. Implemented inline rather than via the obaSeparator wrapper
      // because each predictor exposes different "fit" extras we still want
      // to show in the UI.

      const evalWithOBABack = (
        X_pred_clean_full: Float64Array,
        anchorList: number[],
        variantSuffix: string,
      ) => {
        // X_pred_clean_full: N × L predicted matrix on clean scale.
        // We add B's OBA emission back, then evaluate non-anchor patches
        // against the original (un-cleaned) X_B.
        const X_pred =
          factorsB_local && obaExtractionB
            ? addOBA(X_pred_clean_full, L, factorsB_local, obaExtractionB.emission)
            : X_pred_clean_full
        const anchorSet = new Set(anchorList)
        const testIdx: number[] = []
        for (let i = 0; i < N; i++) if (!anchorSet.has(i)) testIdx.push(i)
        const nTest = testIdx.length
        const XPredTest = new Float64Array(nTest * L)
        const XTrueTest = new Float64Array(nTest * L)
        const sids: string[] = new Array(nTest)
        for (let t = 0; t < nTest; t++) {
          const src = testIdx[t]
          sids[t] = sampleIds[src]
          for (let l = 0; l < L; l++) {
            XPredTest[t * L + l] = X_pred[src * L + l]
            XTrueTest[t * L + l] = X_B[src * L + l]
          }
        }
        return evaluatePrediction({
          variant: `D7_${variantSuffix}`,
          k: anchorList.length,
          XPred: XPredTest,
          XTrue: XTrueTest,
          L,
          sampleIds: sids,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
      }

      const runA3 = (idx: number[]) => {
        const base = runPerLambdaAffineTransfer({
          X_A: X_A_work,
          X_B: X_B_work,
          sampleIds: sampleIds,
          anchorIdx: idx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
        if (obaSeparate) {
          // Build the full N×L prediction on clean scale by re-applying the fit.
          const X_pred_clean = applyPerLambdaAffine(X_A_work, L, base.fit)
          return { ...base, report: evalWithOBABack(X_pred_clean, idx, 'A3') }
        }
        return base
      }
      const runD1 = (idx: number[]) => {
        const base = runPaperRatioResidualTransfer({
          X_A: X_A_work,
          X_B: X_B_work,
          D: D_B,
          sampleIds: sampleIds,
          anchorIdx: idx,
          paperRowIdx: idx[0] ?? paperRowIdx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
          residualRank,
          // Per-band UV clamp [0.1, 7.0] on 380-410 nm (first 4 bands of a
          // 380-730 nm / 10 nm spectrum). Physics demands ratios up to 5-7×
          // there on OBA-disparate substrates; the default [0.3, 3.0] clamp
          // destroys the signal.
          uvBandCount: 4,
        })
        if (obaSeparate) {
          return { ...base, report: evalWithOBABack(base.X_pred, idx, 'D1') }
        }
        return base
      }
      const runC7 = (idx: number[]) => {
        const base = runPerLambdaCurveTransfer({
          X_A: X_A_work,
          X_B: X_B_work,
          sampleIds: sampleIds,
          anchorIdx: idx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
        if (obaSeparate) {
          const X_pred_clean = applyPerLambdaCurve(X_A_work, L, base.fit)
          return { ...base, report: evalWithOBABack(X_pred_clean, idx, 'C7') }
        }
        return base
      }

      // B3 needs a pool basis; build once outside the closure so the greedy
      // loop doesn't re-run SVD per iteration.
      //
      // Under D7 OBA-separation the pool spectra should also be cleaned, but
      // we have no per-pool-profile paper anchor here — fall back to using
      // the same emission shape as B for all pool profiles. Imperfect but
      // sufficient because OBA emission shape is similar across substrates
      // (peak position fixed at ~440 nm), only amplitude differs.
      const b3Ready = !!poolMatrices && poolMatrices.length >= 2
      const poolXs: Float64Array[] = []
      const poolNs: number[] = []
      if (b3Ready) {
        for (const m of poolMatrices!) {
          if (obaSeparate && obaExtractionB) {
            const f = computeOBAFactorPerPatch(m.X, L, 0, { startWL })
            poolXs.push(subtractOBA(m.X, L, f, obaExtractionB.emission))
          } else {
            poolXs.push(m.X)
          }
          poolNs.push(m.N)
        }
      }
      const b3Basis = b3Ready
        ? fitPoolBasis({ matrices: poolXs, rowCounts: poolNs, L, p: Math.min(poolBasisRank, L) })
        : null
      const runB3 = (idx: number[]) => {
        if (!b3Basis) throw new Error('B3 unavailable: need ≥ 2 pool profiles')
        const base = runPoolPCATransfer({
          basis: b3Basis,
          X_ref: X_A_work,
          X_target: X_B_work,
          sampleIds: sampleIds,
          anchorIdx: idx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
        if (obaSeparate) {
          return { ...base, report: evalWithOBABack(base.X_pred, idx, 'B3') }
        }
        return base
      }

      type Variant = 'A3' | 'D1' | 'B3' | 'C7' | 'CAE_RAW' | 'CAE_D7' | 'CAE_D7_M1' | 'CAE_D7_3ANCHOR'
      const wantA3 = predictor === 'A3' || predictor === 'A3_vs_D1' || predictor === 'ALL'
      const wantD1 = predictor === 'D1' || predictor === 'A3_vs_D1' || predictor === 'ALL'
      const wantB3 = (predictor === 'B3' || predictor === 'ALL') && b3Ready
      const wantC7 = predictor === 'C7' || predictor === 'ALL'
      const wantCAE_RAW = predictor === 'CAE_RAW' || predictor === 'ALL'
      const wantCAE_D7 = predictor === 'CAE_D7' || predictor === 'ALL'
      const wantCAE_D7_M1 = predictor === 'CAE_D7_M1' || predictor === 'ALL'
      const wantCAE_D7_3ANCHOR = predictor === 'CAE_D7_3ANCHOR'
      const wantCAE_LOO = predictor === 'CAE_LOO'

      const runCAE_RAW = (idx: number[]) => {
        return runCAETransfer({
          weights: CAE_WEIGHTS_RAW,
          X_A,
          X_B,
          D: D_B,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          sampleIds: sampleIds,
          anchorIdx: idx,
          paperRowIdx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
      }

      const caeD7Bundle = pickCaeD7Bundle(refProfile, targetProfile)
      const runCAE_D7 = (idx: number[]) => {
        return runCAETransfer({
          weights: caeD7Bundle.weights,
          X_A,
          X_B,
          D: D_B,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          sampleIds: sampleIds,
          anchorIdx: idx,
          paperRowIdx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
      }

      const runCAE_D7_M1 = (idx: number[]) => {
        return runCAETransfer({
          weights: CAE_WEIGHTS_D7_M1,
          X_A,
          X_B,
          D: D_B,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          sampleIds: sampleIds,
          anchorIdx: idx,
          paperRowIdx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
      }

      const runCAE_D7_3ANCHOR = () => {
        const [pIdx, a1Idx, a2Idx] = pickLabDirectionAnchorIdx(
          X_A,
          D_B,
          N,
          L,
          Baligned.wavelengths[0],
          paperRowIdx,
          paperWP,
          angle1,
          angle2,
          chromaTarget,
        )
        const threeAnchors = [pIdx, a1Idx, a2Idx].filter((i) => i >= 0)
        const anchorResiduals = buildAnchorResiduals({
          weights: caeD7Bundle.weights,
          X_A,
          X_B,
          D: D_B,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          anchorIdx: threeAnchors,
          L,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        })
        return runCAETransfer({
          weights: caeD7Bundle.weights,
          X_A,
          X_B,
          D: D_B,
          paper_A: paperSpecA,
          paper_B: paperSpecB,
          sampleIds,
          anchorIdx: threeAnchors,
          paperRowIdx: pIdx,
          L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
          anchorResiduals,
        })
      }

      const dispatch = (v: Variant, idx: number[]) => {
        if (v === 'A3') return { ...runA3(idx), variant: 'A3' as const }
        if (v === 'D1') return { ...runD1(idx), variant: 'D1' as const }
        if (v === 'C7') return { ...runC7(idx), variant: 'C7' as const }
        if (v === 'CAE_RAW') return { ...runCAE_RAW(idx), variant: 'CAE_RAW' as const }
        if (v === 'CAE_D7') return { ...runCAE_D7(idx), variant: 'CAE_D7' as const }
        if (v === 'CAE_D7_M1') return { ...runCAE_D7_M1(idx), variant: 'CAE_D7_M1' as const }
        if (v === 'CAE_D7_3ANCHOR') return { ...runCAE_D7_3ANCHOR(), variant: 'CAE_D7_3ANCHOR' as const }
        return { ...runB3(idx), variant: 'B3' as const }
      }

      const variants: Variant[] = []
      if (wantA3) variants.push('A3')
      if (wantD1) variants.push('D1')
      if (wantB3) variants.push('B3')
      if (wantC7) variants.push('C7')
      if (wantCAE_RAW) variants.push('CAE_RAW')
      if (wantCAE_D7) variants.push('CAE_D7')
      if (wantCAE_D7_M1) variants.push('CAE_D7_M1')
      if (wantCAE_D7_3ANCHOR) variants.push('CAE_D7_3ANCHOR')

      for (const v of variants) {
        if (anchorStrategy === 'S2') {
          const greedy = runGreedyActiveAnchors({
            predict: (a) => dispatch(v, a).report,
            seedAnchors: anchorIdx,
            sampleIds: sampleIds,
            targetMedianDE: greedyTarget,
            maxK: greedyMaxK,
          })
          // Re-run dispatch once with final anchors to capture per-variant extras.
          const finalRun = dispatch(v, greedy.finalAnchors)
          const base: PredictorRun = { variant: v, report: finalRun.report, greedy }
          if (v === 'A3')
            base.perLambdaR2 = (finalRun as ReturnType<typeof runA3>).fit.rSquaredPerLambda
          if (v === 'D1') {
            const f = (finalRun as ReturnType<typeof runD1>).fit
            base.residualRank = f.residualRank
            base.clampedBandCount = f.clampedBands.length
          }
          if (v === 'B3') {
            const r = finalRun as ReturnType<typeof runB3>
            base.basisRank = r.p
            base.poolSize = poolMatrices!.length
          }
          if (v === 'CAE_RAW') {
            const c = finalRun as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = CAE_WEIGHTS_RAW.best_test_mse
          }
          if (v === 'CAE_D7') {
            const c = finalRun as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = caeD7Bundle.weights.best_test_mse
          }
          if (v === 'CAE_D7_M1') {
            const c = finalRun as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = CAE_WEIGHTS_D7_M1.best_test_mse
          }
          if (v === 'CAE_D7_3ANCHOR') {
            const c = finalRun as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = caeD7Bundle.weights.best_test_mse
          }
          runs.push(base)
        } else {
          const r = dispatch(v, anchorIdx)
          const base: PredictorRun = { variant: v, report: r.report }
          if (v === 'A3') base.perLambdaR2 = (r as ReturnType<typeof runA3>).fit.rSquaredPerLambda
          if (v === 'D1') {
            const f = (r as ReturnType<typeof runD1>).fit
            base.residualRank = f.residualRank
            base.clampedBandCount = f.clampedBands.length
          }
          if (v === 'B3') {
            const br = r as ReturnType<typeof runB3>
            base.basisRank = br.p
            base.poolSize = poolMatrices!.length
          }
          if (v === 'CAE_RAW') {
            const c = r as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = CAE_WEIGHTS_RAW.best_test_mse
          }
          if (v === 'CAE_D7') {
            const c = r as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = caeD7Bundle.weights.best_test_mse
          }
          if (v === 'CAE_D7_M1') {
            const c = r as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = CAE_WEIGHTS_D7_M1.best_test_mse
          }
          if (v === 'CAE_D7_3ANCHOR') {
            const c = r as ReturnType<typeof runCAETransfer>
            base.caeRefInTrain = c.refInTrain
            base.caeTargetInTrain = c.targetInTrain
            base.caeBestTestMSE = caeD7Bundle.weights.best_test_mse
          }
          runs.push(base)
        }
      }

      // CAE_LOO: dynamic leave-one-out substrate latent optimization (H14).
      // Runs outside the Variant loop — not compatible with S2 greedy (too slow).
      if (wantCAE_LOO) {
        try {
          const targetPreset = canonicalPrintMode(targetProfile.metadata)
          const B_raw = loadProfileMatrix(targetProfile)

          // Build same-mode support set (all loaded profiles of same preset, not target).
          // Two alignment strategies:
          //   1. Common SAMPLE_IDs (same chart grid, e.g. BC 905-patch → BC 905-patch).
          //   2. WLS RGB interpolation (different grids, e.g. MOAB ~2033-patch → BC 905-patch).
          const looSupport: LOOProfileData[] = []
          const wlsOpts: WlsInterpOptions = { k: 16, power: 2 }
          for (const p of profiles) {
            if (p.metadata.full_name === targetProfile.metadata.full_name) continue
            let preset: string
            try { preset = canonicalPrintMode(p.metadata) } catch { continue }
            if (preset !== targetPreset) continue
            try {
              const spMat = loadProfileMatrix(p)
              if (spMat.channels !== 3 || B_raw.channels !== 3 || spMat.L !== L) continue

              // Always WLS-interpolate onto target's exact RGB device grid (H14 invariant:
              // one common set of RGB values across all support profiles).
              const pts: InterpPoint[] = new Array(spMat.N)
              for (let i = 0; i < spMat.N; i++) {
                pts[i] = {
                  rgb: [spMat.D[i * 3], spMat.D[i * 3 + 1], spMat.D[i * 3 + 2]],
                  spectrum: Array.from(spMat.X.subarray(i * L, i * L + L)),
                }
              }
              const interp = buildWlsInterpolator(pts, wlsOpts)
              const tgtN = B_raw.N
              const spX = new Float64Array(tgtN * L)
              const spD = new Float64Array(tgtN * 3)
              for (let i = 0; i < tgtN; i++) {
                const rgb: [number, number, number] = [B_raw.D[i * 3], B_raw.D[i * 3 + 1], B_raw.D[i * 3 + 2]]
                const spec = interp.query(rgb)
                for (let l = 0; l < L; l++) spX[i * L + l] = spec[l]
                spD[i * 3] = rgb[0]; spD[i * 3 + 1] = rgb[1]; spD[i * 3 + 2] = rgb[2]
              }

              looSupport.push({
                spectra: spX,
                deviceValues: spD,
                paperSpectrum: interp.query([255, 255, 255]),
                sampleIds: B_raw.sampleIds,
                profileName: p.metadata.full_name,
              })
            } catch { continue }
          }

          if (looSupport.length > 0) {
            const looTarget: LOOProfileData = {
              spectra: X_B,
              deviceValues: D_B,
              paperSpectrum: Array.from(paperSpecB),
              sampleIds,
              profileName: targetProfile.metadata.full_name,
            }
            // Few-shot: exactly 3 target patches (paper + 2 chromatic) guide the latent.
            // Support: all patches from each same-mode profile (no subsample cap).
            const looAnchorIndices = anchorIdx.slice(0, 3)
            const looResult = predictTargetWithLOO(
              caeD7Bundle.weights,
              looSupport,
              looTarget,
              {
                nmIterations: 100,
                nmTolerance: 1e-4,
                anchorIndices: looAnchorIndices,
                L,
              },
            )
            runs.push({
              variant: 'CAE_LOO',
              report: looResult.report,
              caeBestTestMSE: caeD7Bundle.weights.best_test_mse,
              caeRefInTrain: false,
              caeTargetInTrain: false,
              looSupportCount: looResult.looSupportCount,
            })
          }
        } catch { /* canonicalPrintMode failed or no support — skip */ }
      }

      return {
        kind: 'ok' as const,
        runs,
        anchors,
        alignedN: N,
        crossChart,
        exactCount: al.exactCount,
        interpCount: al.interpCount,
        looRms: al.looRms,
        caeD7Mode: caeD7Bundle.mode,
        caeD7ModeMatched: caeD7Bundle.matched,
        obaRef,
        obaTarget,
        obaMismatchScore: obaMm,
        obaExtractionA,
        obaExtractionB,
        obaSeparateEnabled: obaSeparate,
      }
    } catch (e) {
      return { kind: 'error' as const, error: e instanceof Error ? e.message : String(e) }
    }
  }, [
    refProfile,
    targetProfile,
    predictor,
    residualRank,
    poolMatrices,
    poolBasisRank,
    anchorStrategy,
    greedyTarget,
    greedyMaxK,
    rampChannel,
    rampLevels,
    obaSeparate,
    angle1,
    angle2,
    chromaTarget,
  ])

  if (profiles.length < 2) {
    return (
      <div className="p-6 text-gray-400">
        Load at least two profiles to run cross-substrate transfer.
      </div>
    )
  }

  // Per-profile OBA score for dropdown labels — paper patch detection.
  const profileObaLabel = (p: ProfileData): string => {
    const paper = p.raw.find(
      (m) => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
    )
    if (!paper || !paper.spectra) return p.metadata.full_name
    try {
      const startWL = paper.wavelengths?.[0] ?? 380
      const info = detectOBA(paper.spectra, { startWL })
      return `${p.metadata.full_name}  (OBA ${info.score.toFixed(2)})`
    } catch {
      return p.metadata.full_name
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-xl font-bold mb-1">Cross-substrate transfer (Phase 2 + 3)</h2>
        <p className="text-sm text-gray-400">
          Predicts the full target profile from the reference profile + 13 measured anchors on the
          target (paper, 6 RGB primaries, black, 5 neutrals). Metrics on the 905 − 13 = 892 held-out
          patches under paper-relative D50/2°.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Reference (full)</span>
          <select
            value={refName}
            onChange={(e) => setRefName(e.target.value)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="">— pick reference —</option>
            {profiles.map((p) => (
              <option key={p.metadata.full_name} value={p.metadata.full_name}>
                {profileObaLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">
            Target (only anchors)
          </span>
          <select
            value={targetName}
            onChange={(e) => setTargetName(e.target.value)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="">— pick target —</option>
            {profiles.map((p) => (
              <option key={p.metadata.full_name} value={p.metadata.full_name}>
                {profileObaLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Predictor</span>
          <select
            value={predictor}
            onChange={(e) => setPredictor(e.target.value as PredictorKey)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="ALL">All predictors (A3 / D1 / B3 / C7 / CAE_RAW)</option>
            <option value="A3_vs_D1">A3 vs D1 (head-to-head)</option>
            <option value="A3">A3 — per-λ affine (baseline)</option>
            <option value="D1">D1 — paper-ratio + PCA residual</option>
            <option value="B3">
              B3 — pool-PCA (basis from {poolMatrices?.length ?? 0} profiles)
            </option>
            <option value="C7">C7 — per-λ monotone curve</option>
            <option value="CAE_RAW">
              CAE_RAW — Conditional Autoencoder (cross-trained MK, raw spectra)
            </option>
            <option value="CAE_D7">
              CAE_D7 — Conditional Autoencoder (cross-trained MK, OBA-cleaned spectra, M0)
            </option>
            <option value="CAE_D7_M1">
              CAE_D7_M1 — Conditional Autoencoder (cross-trained MK, OBA-cleaned spectra, M1)
            </option>
            <option value="CAE_D7_3ANCHOR">
              CAE_D7_3ANCHOR — paper + 2 Lab-direction anchors with fine-tuning
            </option>
            <option value="CAE_LOO">
              CAE_LOO — dynamic LOO substrate latent (H14, same-mode support set)
            </option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">D1 residual rank</span>
          <select
            value={residualRank}
            onChange={(e) => setResidualRank(Number(e.target.value))}
            disabled={!(predictor === 'D1' || predictor === 'A3_vs_D1' || predictor === 'ALL')}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-40"
          >
            <option value={1}>1</option>
            <option value={2}>2 (legacy)</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={5}>5 (default)</option>
            <option value={6}>6</option>
            <option value={8}>8</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">B3 basis rank</span>
          <select
            value={poolBasisRank}
            onChange={(e) => setPoolBasisRank(Number(e.target.value))}
            disabled={!(predictor === 'B3' || predictor === 'ALL')}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-40"
          >
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={6}>6 (default)</option>
            <option value={8}>8</option>
            <option value={12}>12</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">D7 OBA-separate</span>
          <div className="mt-1 flex items-center gap-3 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm">
            <input
              type="checkbox"
              checked={obaSeparate}
              onChange={(e) => setObaSeparate(e.target.checked)}
              className="accent-blue-500"
            />
            <span className={obaSeparate ? 'text-emerald-300' : 'text-gray-400'}>
              {obaSeparate
                ? 'ON — predictors run on OBA-clean spectra'
                : 'OFF — predictors see raw spectra'}
            </span>
          </div>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Anchor strategy</span>
          <select
            value={anchorStrategy}
            onChange={(e) => setAnchorStrategy(e.target.value as AnchorStrategy)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="S1">S1 — forced (13 fixed anchors)</option>
            <option value="S2">S2 — greedy adaptive (S1 seed + grow)</option>
            <option value="S3">S3 — single-channel ramp (paper + N ramp anchors)</option>
            <option value="S4">
              S4 — three anchors: paper + two along dominant directions at fixed chroma
            </option>
          </select>
        </label>
      </div>

      {anchorStrategy === 'S3' && (
        <div className="grid grid-cols-2 gap-4 p-3 rounded-lg border border-gray-800 bg-gray-900/60">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">S3 ramp channel</span>
            <select
              value={rampChannel}
              onChange={(e) => setRampChannel(e.target.value as RampChannel)}
              className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
            >
              <option value="neutral">neutral gray (R=G=B)</option>
              <option value="C">cyan (G=B=255, R varies)</option>
              <option value="M">magenta (R=B=255, G varies)</option>
              <option value="Y">yellow (R=G=255, B varies)</option>
            </select>
            <p className="text-[11px] text-gray-500 mt-1">
              Channel ramp to use as anchors. Tests the hypothesis that substrate transform is
              shared across inks.
            </p>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              S3 ramp levels (excluding paper)
            </span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={rampLevels}
                onChange={(e) => setRampLevels(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">{rampLevels}</span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Total anchors = paper + N = {1 + rampLevels}. Compare to S1's 13. Lower k = lower
              measurement burden if hypothesis holds.
            </p>
          </label>
        </div>
      )}

      {anchorStrategy === 'S2' && (
        <div className="grid grid-cols-2 gap-4 p-3 rounded-lg border border-gray-800 bg-gray-900/60">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              S2 target median ΔE00
            </span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={0.5}
                max={5.0}
                step={0.1}
                value={greedyTarget}
                onChange={(e) => setGreedyTarget(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">
                {greedyTarget.toFixed(1)}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Greedy stops as soon as the predictor's median ΔE00 ≤ this.
            </p>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">
              S2 max anchors (k cap)
            </span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={15}
                max={80}
                step={1}
                value={greedyMaxK}
                onChange={(e) => setGreedyMaxK(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">{greedyMaxK}</span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Hard cap on greedy iterations. Each iter ≈ one predictor refit.
            </p>
          </label>
        </div>
      )}

      {predictor === 'CAE_D7_3ANCHOR' && (
        <div className="grid grid-cols-3 gap-4 p-3 rounded-lg border border-gray-800 bg-gray-900/60">
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">Angle 1 (°)</span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={355}
                step={5}
                value={angle1}
                onChange={(e) => setAngle1(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">{angle1}°</span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Lab hue angle (0–360°) for first anchor in a/b* space.
            </p>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">Angle 2 (°)</span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={0}
                max={355}
                step={5}
                value={angle2}
                onChange={(e) => setAngle2(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">{angle2}°</span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Lab hue angle (0–360°) for second anchor in a/b* space.
            </p>
          </label>
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">Chroma</span>
            <div className="mt-1 flex items-center gap-3">
              <input
                type="range"
                min={5}
                max={80}
                step={5}
                value={chromaTarget}
                onChange={(e) => setChromaTarget(Number(e.target.value))}
                className="flex-1"
              />
              <span className="font-mono text-sm text-gray-200 w-12 text-right">
                {chromaTarget}
              </span>
            </div>
            <p className="text-[11px] text-gray-500 mt-1">
              Desired chroma in a/b* space. Patches closest to (angle, chroma) are selected as
              anchors.
            </p>
          </label>
        </div>
      )}

      {result && result.kind === 'error' && (
        <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          {result.error}
        </div>
      )}

      {result && result.kind === 'ok' && result.runs.length > 0 && (
        <div className="space-y-6">
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
          {(predictor === 'CAE_D7' || predictor === 'ALL') && (
            result.caeD7ModeMatched ? (
              <div className="bg-emerald-950/40 border border-emerald-700/60 rounded-lg p-3 text-sm text-emerald-200">
                CAE_D7: using per-mode weights <b>{result.caeD7Mode}</b> (trained on
                that Epson preset only). Lower validation MSE than the 36-profile
                mixed-pool fallback.
              </div>
            ) : (
              <div className="bg-gray-900/60 border border-gray-700 rounded-lg p-3 text-sm text-gray-300">
                CAE_D7: using <b>full36</b> mixed-pool weights (no per-mode bundle
                for this ref/target preset, or they differ). Mode-specific weights
                available for Canvas Matte, Premium Luster, WCRW, USFA.
              </div>
            )
          )}
          <OBAMismatchTile
            obaRef={result.obaRef}
            obaTarget={result.obaTarget}
            mismatch={result.obaMismatchScore}
          />
          {result.obaSeparateEnabled && result.obaExtractionA && result.obaExtractionB && (
            <OBAExtractionTile a={result.obaExtractionA} b={result.obaExtractionB} />
          )}

          {result.runs.length > 1 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Head-to-head</h3>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="text-left py-1">Predictor</th>
                    <th className="text-right py-1">median ΔE00</th>
                    <th className="text-right py-1">P95 ΔE00</th>
                    <th className="text-right py-1">mean R²</th>
                    <th className="text-right py-1">RMS</th>
                    <th className="text-right py-1">k</th>
                  </tr>
                </thead>
                <tbody>
                  {result.runs.map((run) => (
                    <tr key={run.variant} className="border-t border-gray-800">
                      <td className="py-2 font-mono">{run.variant}</td>
                      <td className={`text-right py-2 font-mono ${deColor(run.report.medianDE00)}`}>
                        {fmt(run.report.medianDE00)}
                      </td>
                      <td className={`text-right py-2 font-mono ${deColor(run.report.p95DE00)}`}>
                        {fmt(run.report.p95DE00)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-200">
                        {fmt(run.report.meanSpectralR2, 3)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-200">
                        {fmt(run.report.meanRMS, 4)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-400">{run.report.k}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(() => {
                if (result.runs.length < 2) return null
                const sorted = [...result.runs].sort(
                  (u, v) => u.report.medianDE00 - v.report.medianDE00,
                )
                const winner = sorted[0]
                const runnerUp = sorted[1]
                const delta = runnerUp.report.medianDE00 - winner.report.medianDE00
                return (
                  <div className="mt-3 text-xs text-gray-400">
                    Winner on median ΔE00:{' '}
                    <span className="text-emerald-400 font-semibold">{winner.variant}</span> by{' '}
                    {delta.toFixed(2)} ΔE00 over {runnerUp.variant}.
                  </div>
                )
              })()}
            </div>
          )}

          {result.runs.map((run) => (
            <div key={run.variant} className="space-y-3">
              <h3 className="text-sm uppercase tracking-wider text-gray-500">
                {run.report.variant}
              </h3>
              <div className="grid grid-cols-4 gap-3">
                <Metric
                  label="median ΔE00"
                  value={fmt(run.report.medianDE00)}
                  cls={deColor(run.report.medianDE00)}
                />
                <Metric
                  label="P95 ΔE00"
                  value={fmt(run.report.p95DE00)}
                  cls={deColor(run.report.p95DE00)}
                />
                <Metric
                  label="mean R²"
                  value={fmt(run.report.meanSpectralR2, 3)}
                  cls="text-gray-200"
                />
                <Metric label="mean RMS" value={fmt(run.report.meanRMS, 4)} cls="text-gray-200" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric label="anchors (k)" value={String(run.report.k)} cls="text-gray-200" />
                <Metric label="held-out" value={String(run.report.nTest)} cls="text-gray-200" />
                <Metric
                  label={result.crossChart ? 'patches (some interp)' : 'patches (all exact)'}
                  value={String(result.alignedN)}
                  cls={result.crossChart ? 'text-amber-300' : 'text-gray-200'}
                />
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">
                  Worst 5 patches
                </div>
                <div className="text-xs font-mono text-gray-400 flex flex-wrap gap-2">
                  {run.report.worstPatchSampleIds.map((id, i) => {
                    const rgb = rgbBySampleId.get(id)
                    return (
                      <span key={i} className="px-2 py-0.5 bg-gray-800 rounded text-red-300">
                        {rgb ? `(${rgb[0]},${rgb[1]},${rgb[2]})` : id}
                      </span>
                    )
                  })}
                </div>
              </div>
              {run.perLambdaR2 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
                    Per-λ R² of the affine fit (anchors)
                  </div>
                  <div className="grid grid-cols-6 gap-2 text-xs font-mono">
                    {Array.from(run.perLambdaR2).map((r2, l) => (
                      <div key={l} className="text-gray-400">
                        λ{380 + l * 10}:{' '}
                        <span
                          className={
                            r2 > 0.9
                              ? 'text-emerald-400'
                              : r2 > 0.6
                                ? 'text-yellow-400'
                                : 'text-red-400'
                          }
                        >
                          {r2.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {run.residualRank !== undefined && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <div>
                    D1 used PCA residual rank{' '}
                    <span className="text-gray-200 font-mono">{run.residualRank}</span> fit on{' '}
                    {run.report.k - 1} non-paper anchors. Lower-rank residual = stronger smoothness
                    assumption on the substrate transform.
                  </div>
                  {run.clampedBandCount !== undefined && run.clampedBandCount > 0 && (
                    <div>
                      Paper-ratio clamp activated on{' '}
                      <span className="text-yellow-300 font-mono">{run.clampedBandCount} / 36</span>{' '}
                      wavelengths (default bounds [0.3, 3.0]). Typically signals OBA mismatch in
                      380–410 nm — distrust D1 at those bands.
                    </div>
                  )}
                </div>
              )}
              {run.greedy && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
                  <div className="text-xs uppercase tracking-wider text-gray-500">
                    S2 greedy trajectory
                  </div>
                  <div className="grid grid-cols-3 gap-3 text-xs">
                    <Metric
                      label="converged?"
                      value={run.greedy.converged ? 'yes' : 'no (hit cap)'}
                      cls={run.greedy.converged ? 'text-emerald-400' : 'text-yellow-400'}
                    />
                    <Metric
                      label="iterations"
                      value={String(run.greedy.trajectory.length)}
                      cls="text-gray-200"
                    />
                    <Metric
                      label="final k"
                      value={String(run.greedy.finalAnchors.length)}
                      cls="text-gray-200"
                    />
                  </div>
                  <div className="text-[11px] text-gray-400">
                    Per-iter medianΔE00:{' '}
                    <span className="font-mono text-gray-200">
                      {run.greedy.trajectory.map((s) => s.report.medianDE00.toFixed(2)).join(' → ')}
                    </span>
                  </div>
                  {run.greedy.addedOrder.length > 0 && (
                    <div className="text-[11px] text-gray-400">
                      Added patches ({run.greedy.addedOrder.length} rows):{' '}
                      <span className="font-mono text-gray-200">
                        {run.greedy.addedOrder.map((rowIdx) => `r${rowIdx}`).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {run.caeBestTestMSE !== undefined && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <div>
                    CAE cross-trained on 11 / 16 MK profiles (70 / 30 split, seed 42). Best held-out
                    MSE on training:{' '}
                    <span className="font-mono text-gray-200">{run.caeBestTestMSE.toFixed(5)}</span>
                    .
                  </div>
                  <div>
                    Reference profile in training pool:{' '}
                    <span className={run.caeRefInTrain ? 'text-emerald-300' : 'text-yellow-300'}>
                      {run.caeRefInTrain ? 'yes' : 'no (held-out — substrate id = null)'}
                    </span>
                    . Target in training pool:{' '}
                    <span className={run.caeTargetInTrain ? 'text-emerald-300' : 'text-yellow-300'}>
                      {run.caeTargetInTrain ? 'yes' : 'no (held-out — substrate id = null)'}
                    </span>
                    .
                  </div>
                  {run.variant === 'CAE_LOO' ? (
                    <div>
                      Dynamic LOO (H14): substrate latent optimized via Nelder-Mead on{' '}
                      <span className="text-gray-200 font-mono">{run.looSupportCount ?? '?'}</span>{' '}
                      same-mode support profiles (all patches), init from target paper encoding.
                      Few-shot: <span className="text-gray-200 font-mono">k = {run.report.k}</span>{' '}
                      target anchors (paper + 2 chromatic). Evaluated on 905 − {run.report.k} = {905 - run.report.k} held-out patches.
                    </div>
                  ) : (
                    <div>
                      No anchor fine-tuning yet — substrate identity comes purely from the paper-white
                      spectrum. Few-shot anchor adaptation queued for the next revision.
                    </div>
                  )}
                </div>
              )}
              {run.poolSize !== undefined && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <div>
                    B3 basis built from{' '}
                    <span className="text-gray-200 font-mono">{run.poolSize}</span> pool profiles
                    (target excluded), truncated to rank{' '}
                    <span className="text-gray-200 font-mono">{run.basisRank ?? '—'}</span>.
                  </div>
                  <div>
                    B3 does NOT use the reference profile — it captures cross-substrate structure
                    shared across the pool. With fewer than 5 pool profiles, or with substrates very
                    unlike the target, B3 degrades to noise.
                  </div>
                </div>
              )}
            </div>
          ))}

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">
              Anchors used ({result.anchors.sampleIds.length})
            </div>
            <div className="text-xs font-mono text-gray-400 flex flex-wrap gap-2">
              {result.anchors.sampleIds.map((id, i) => {
                const label = (result.anchors.meta?.labels as string[])?.[i]
                const rgb = rgbBySampleId.get(id)
                return (
                  <span key={id} className="px-2 py-0.5 bg-gray-800 rounded">
                    {label}: <span className="text-gray-200">
                      {rgb ? `(${rgb[0]},${rgb[1]},${rgb[2]})` : id}
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-mono mt-1 ${cls}`}>{value}</div>
    </div>
  )
}

function OBAExtractionTile({ a, b }: { a: OBAExtraction; b: OBAExtraction }) {
  // Compact per-λ emission strip for both substrates, 380–460 nm.
  const obaBandIdx = [0, 1, 2, 3, 4, 5, 6, 7, 8] // 380..460 nm @ 10 nm
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-2">
      <div className="text-xs uppercase tracking-wider text-gray-500">
        D7 — extracted OBA emission (subtracted before predict, added back after)
      </div>
      <div className="grid grid-cols-2 gap-4 text-xs">
        <div>
          <div className="text-gray-400 mb-1">
            Reference paper · peak {a.peakAmplitude.toFixed(3)} @ {380 + a.peakLambdaIdx * 10} nm
          </div>
          <div className="font-mono text-gray-300 flex flex-wrap gap-x-3 gap-y-1">
            {obaBandIdx.map((i) => (
              <span key={i}>
                λ{380 + i * 10}:{' '}
                <span className={a.emission[i] > 0.02 ? 'text-emerald-300' : 'text-gray-500'}>
                  {a.emission[i].toFixed(3)}
                </span>
              </span>
            ))}
          </div>
        </div>
        <div>
          <div className="text-gray-400 mb-1">
            Target paper · peak {b.peakAmplitude.toFixed(3)} @ {380 + b.peakLambdaIdx * 10} nm
          </div>
          <div className="font-mono text-gray-300 flex flex-wrap gap-x-3 gap-y-1">
            {obaBandIdx.map((i) => (
              <span key={i}>
                λ{380 + i * 10}:{' '}
                <span className={b.emission[i] > 0.02 ? 'text-emerald-300' : 'text-gray-500'}>
                  {b.emission[i].toFixed(3)}
                </span>
              </span>
            ))}
          </div>
        </div>
      </div>
      <p className="text-[11px] text-gray-500">
        Emission = max(0, R_paper − substrate_base) per λ in the 380–450 nm OBA band, where
        substrate_base is a degree-2 polynomial fit to R_paper over λ ∈ [460, 730].
      </p>
    </div>
  )
}

function OBAMismatchTile({
  obaRef,
  obaTarget,
  mismatch,
}: {
  obaRef: OBAInfo
  obaTarget: OBAInfo
  mismatch: number
}) {
  const severity = obaMismatchSeverity(mismatch)
  const cls =
    severity === 'low'
      ? 'border-emerald-700 bg-emerald-950'
      : severity === 'moderate'
        ? 'border-yellow-700 bg-yellow-950'
        : 'border-red-700 bg-red-950'
  const valueCls =
    severity === 'low'
      ? 'text-emerald-300'
      : severity === 'moderate'
        ? 'text-yellow-300'
        : 'text-red-300'
  const advice =
    severity === 'low'
      ? 'Substrates have comparable OBA loading. D1 paper-ratio is reliable across all 36 bands.'
      : severity === 'moderate'
        ? 'Moderate OBA mismatch. Expect ratio clamp to activate at 1–3 short-wavelength bands.'
        : 'Strong OBA mismatch. D1 paper-ratio explodes at 380–410 nm without the clamp; with the clamp, expect a few clamped bands and biased prediction in the UV-blue region. A3 may also be unreliable since its per-λ slope cannot capture the non-linear OBA-vs-ink-coverage interaction.'

  return (
    <div className={`border rounded-lg p-4 ${cls}`}>
      <div className="grid grid-cols-3 gap-3 items-end">
        <div>
          <div className="text-xs uppercase tracking-wider text-gray-400">OBA mismatch</div>
          <div className={`text-3xl font-mono mt-1 ${valueCls}`}>{mismatch.toFixed(3)}</div>
          <div className="text-xs text-gray-400 mt-1">
            Severity: <span className={valueCls}>{severity}</span>
          </div>
        </div>
        <div className="text-xs text-gray-300 space-y-0.5">
          <div className="text-gray-500 uppercase tracking-wider">Reference</div>
          <div>
            OBA score: <span className="text-gray-100 font-mono">{obaRef.score.toFixed(3)}</span>
          </div>
          <div>
            R(380): <span className="text-gray-100 font-mono">{obaRef.r380.toFixed(3)}</span>
          </div>
          <div>
            R(440): <span className="text-gray-100 font-mono">{obaRef.r440.toFixed(3)}</span>
          </div>
          <div>
            R(550): <span className="text-gray-100 font-mono">{obaRef.r550.toFixed(3)}</span>
          </div>
        </div>
        <div className="text-xs text-gray-300 space-y-0.5">
          <div className="text-gray-500 uppercase tracking-wider">Target</div>
          <div>
            OBA score: <span className="text-gray-100 font-mono">{obaTarget.score.toFixed(3)}</span>
          </div>
          <div>
            R(380): <span className="text-gray-100 font-mono">{obaTarget.r380.toFixed(3)}</span>
          </div>
          <div>
            R(440): <span className="text-gray-100 font-mono">{obaTarget.r440.toFixed(3)}</span>
          </div>
          <div>
            R(550): <span className="text-gray-100 font-mono">{obaTarget.r550.toFixed(3)}</span>
          </div>
        </div>
      </div>
      <p className="text-xs text-gray-300 mt-3">{advice}</p>
    </div>
  )
}
