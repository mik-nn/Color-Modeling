// frontend/src/lib/analyzers/dynamicLOO.ts
/**
 * Dynamic Leave-One-Out CAE fine-tuning for intra-mode substrate adaptation.
 * 
 * @module lib/analyzers/dynamicLOO
 */

import type { CAERunInput, CAERunResult, CAEWeights } from '../predict/cae'
import { runCAETransfer, buildAnchorResiduals } from '../predict/cae'
import { nelderMead, type NelderMeadOptions } from './optimizer'
import type { Measurement, WhitePointXYZ } from '../../types'
import { spectraToXYZ, xyzToLab, deltaE00 } from '../colormath'

export interface LOOConfig {
  nmIterations: number
  nmTolerance: number
  useAnchorResiduals: boolean
  anchorIndices: number[]
  L: number
}

export interface LOOPredictionResult {
  X_pred: Float64Array
  optimizedLatent: number[]
  medianDE00: number
  p95DE00: number
  anchorFineTuned: boolean
}

/**
 * Compute paper white point from actual paper spectrum.
 */
function computePaperWP(paperSpectrum: number[]): WhitePointXYZ {
  const xyz = spectraToXYZ(paperSpectrum)
  return [xyz[0], xyz[1], xyz[2]] as WhitePointXYZ
}

/**
 * Compute Lab from spectrum using specified white point.
 */
function spectrumToLab(spectrum: number[], whitePoint: WhitePointXYZ): [number, number, number] {
  const [X, Y, Z] = spectraToXYZ(spectrum)
  return xyzToLab(X, Y, Z, whitePoint)
}

export function predictTargetWithLOO(
  weights: CAEWeights,
  supportProfiles: Array<{
    profile: { raw: Measurement[]; wavelengths?: number[] }
    paperSpectrum: number[]
    sampleIds: string[]
    deviceValues: Float64Array
  }>,
  targetProfile: {
    profile: { raw: Measurement[]; wavelengths?: number[] }
    paperSpectrum: number[]
    sampleIds: string[]
    deviceValues: Float64Array
  },
  config: LOOConfig,
): LOOPredictionResult {
  const { L } = config
  const N = targetProfile.sampleIds.length

  // Compute paper white points from actual spectra
  const supportPaperWP = computePaperWP(supportProfiles[0].paperSpectrum)
  const targetPaperWP = computePaperWP(targetProfile.paperSpectrum)

  // 1. Optimize substrate latent on support set
  const initialLatent = new Array(weights.arch.substrate_latent_dim).fill(0)
  
  const lossFn = (latent: number[]) => {
    let totalMSE = 0
    let totalPatches = 0

    for (const support of supportProfiles) {
      let anchorResiduals: CAERunInput['anchorResiduals']
      if (config.useAnchorResiduals && config.anchorIndices.length > 0) {
        anchorResiduals = buildAnchorResiduals({
          weights,
          X_A: flattenSpectra(support.profile.raw, L),
          X_B: flattenSpectra(support.profile.raw, L),
          D: support.deviceValues,
          paper_A: support.paperSpectrum,
          paper_B: support.paperSpectrum,
          anchorIdx: new Int32Array(config.anchorIndices),
          L,
          refProfile: 'support',
          targetProfile: 'support',
        })
      }

      const input: CAERunInput = {
        weights,
        X_A: flattenSpectra(support.profile.raw, L),
        X_B: flattenSpectra(support.profile.raw, L),
        D: support.deviceValues,
        paper_A: support.paperSpectrum,
        paper_B: support.paperSpectrum,
        sampleIds: support.sampleIds,
        anchorIdx: new Int32Array(config.anchorIndices),
        paperRowIdx: 0,
        L,
        paperWP: supportPaperWP,
        refProfile: 'support',
        targetProfile: 'support',
        overrideSubstrateLatent: latent,
        anchorResiduals,
      }

      const result = runCAETransfer(input)
      
      for (let i = 0; i < N; i++) {
        for (let l = 0; l < L; l++) {
          const pred = result.X_pred[i * L + l]
          const true_ = support.profile.raw[i].spectra?.[l] ?? 0
          totalMSE += (pred - true_) ** 2
        }
      }
      totalPatches += N
    }

    return totalMSE / totalPatches
  }

  const nmResult = nelderMead(lossFn, initialLatent, {
    max_iter: config.nmIterations,
    tol: config.nmTolerance,
    initial_simplex_size: 0.1,
  })

  const optimizedLatent = nmResult.bestPoint

  // 2. Predict target with optimized latent
  let anchorResiduals: CAERunInput['anchorResiduals']
  if (config.useAnchorResiduals && config.anchorIndices.length > 0) {
    anchorResiduals = buildAnchorResiduals({
      weights,
      X_A: flattenSpectra(targetProfile.profile.raw, L),
      X_B: flattenSpectra(targetProfile.profile.raw, L),
      D: targetProfile.deviceValues,
      paper_A: targetProfile.paperSpectrum,
      paper_B: targetProfile.paperSpectrum,
      anchorIdx: new Int32Array(config.anchorIndices),
      L,
      refProfile: 'target_ref',
      targetProfile: 'target',
    })
  }

  const input: CAERunInput = {
    weights,
    X_A: flattenSpectra(targetProfile.profile.raw, L),
    X_B: flattenSpectra(targetProfile.profile.raw, L),
    D: targetProfile.deviceValues,
    paper_A: targetProfile.paperSpectrum,
    paper_B: targetProfile.paperSpectrum,
    sampleIds: targetProfile.sampleIds,
    anchorIdx: new Int32Array(config.anchorIndices),
    paperRowIdx: 0,
    L,
    paperWP: targetPaperWP,
    refProfile: 'target_ref',
    targetProfile: 'target',
    overrideSubstrateLatent: optimizedLatent,
    anchorResiduals,
  }

  const result: CAERunResult = runCAETransfer(input)

  // 3. Compute metrics with correct function signatures
  const errors: number[] = []
  for (let i = 0; i < N; i++) {
    const predSpectrum = Array.from(result.X_pred.slice(i * L, (i + 1) * L))
    const trueSpectrum = targetProfile.profile.raw[i].spectra ?? []
    
    const [predL, predA, predB] = spectrumToLab(predSpectrum, targetPaperWP)
    const [trueL, trueA, trueB] = spectrumToLab(trueSpectrum, targetPaperWP)
    
    const dE = deltaE00(predL, predA, predB, trueL, trueA, trueB)
    errors.push(dE)
  }

  errors.sort((a, b) => a - b)
  const medianDE00 = errors[Math.floor(N / 2)]
  const p95DE00 = errors[Math.floor(N * 0.95)]

  return {
    X_pred: result.X_pred,
    optimizedLatent,
    medianDE00,
    p95DE00,
    anchorFineTuned: result.anchorFineTuned ?? false,
  }
}

function flattenSpectra(measurements: Measurement[], L: number): Float64Array {
  const N = measurements.length
  const out = new Float64Array(N * L)
  for (let i = 0; i < N; i++) {
    const spec = measurements[i].spectra
    if (!spec || spec.length !== L) {
      throw new Error(`Measurement ${i} has invalid spectra length`)
    }
    for (let l = 0; l < L; l++) {
      out[i * L + l] = spec[l]
    }
  }
  return out
}