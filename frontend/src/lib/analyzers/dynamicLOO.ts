// frontend/src/lib/analyzers/dynamicLOO.ts
/**
 * Dynamic Leave-One-Out CAE fine-tuning for intra-mode substrate adaptation (H14).
 *
 * Algorithm:
 *   1. Find same-mode support profiles S = AllProfiles_mode \ {Target}.
 *   2. Optimize substrate latent θ = argmin_θ Σ_{p∈S} MSE(decode(encode_ink(X_p,θ_p),θ), X_p)
 *      + λ_few · Σ_{a∈anchors} MSE(decode(encode_ink(X_a,θ_a),θ), X_a)
 *      via Nelder-Mead. Support profiles use their real one-hot IDs for ink encoding.
 *      Ink encoder uses real subA; only the decoder substrate (subB=θ) is optimized.
 *   3. Predict target: runCAETransfer(Target, overrideSubstrateLatent=θ).
 *
 * @module lib/analyzers/dynamicLOO
 */

import type { CAEWeights } from '../predict/cae'
import { CAEForward, runCAETransfer } from '../predict/cae'
import { nelderMead } from './optimizer'
import type { PredictionReport, WhitePointXYZ } from '../../types'
import { spectraToXYZ } from '../colormath'

export interface LOOProfileData {
  /** N×L row-major reflectance (values in [0,1]). */
  spectra: Float64Array
  /** N×3 row-major device values (0–255 RGB). */
  deviceValues: Float64Array
  /** Paper white spectrum, length L. */
  paperSpectrum: number[]
  /** SAMPLE_IDs, length N. */
  sampleIds: string[]
  /** Profile name as stored in weights.id_table (or unknown name → null_id). */
  profileName: string
}

export interface LOOConfig {
  nmIterations: number
  nmTolerance: number
  /** Indices into target sampleIds for few-shot guidance (may be empty). */
  anchorIndices: number[]
  L: number
  /** Patches per support profile for optimizer subsampling (default 30). */
  maxPatchesPerSupport?: number
  /** Weight for few-shot anchor term relative to support term (default 1.0). */
  anchorWeight?: number
}

export interface LOOPredictionResult {
  X_pred: Float64Array
  report: PredictionReport
  optimizedLatent: number[]
  anchorFineTuned: boolean
  looSupportCount: number
}

function computePaperWP(paperSpectrum: number[]): WhitePointXYZ {
  const xyz = spectraToXYZ(paperSpectrum)
  return [xyz[0], xyz[1], xyz[2]] as WhitePointXYZ
}

export function predictTargetWithLOO(
  weights: CAEWeights,
  supportProfiles: LOOProfileData[],
  target: LOOProfileData,
  config: LOOConfig,
): LOOPredictionResult {
  const { L, anchorIndices } = config
  // Default: use all patches. Pass a finite number only if browser perf is a concern.
  const maxPatchesPerSupport = config.maxPatchesPerSupport ?? Infinity
  const anchorWeight = config.anchorWeight ?? 1.0

  const targetPaperWP = computePaperWP(target.paperSpectrum)
  const fwd = new CAEForward(weights)

  // Init substrate latent from target paper (null_id = held-out substrate).
  const initLatent = Array.from(fwd.encodeSubstrate(target.paperSpectrum, weights.null_id))

  // Pre-compute support substrate latents — real IDs so ink encoder sees correct substrate.
  const supportSubLats = supportProfiles.map(sp => {
    const id = weights.id_table[sp.profileName] ?? weights.null_id
    return fwd.encodeSubstrate(sp.paperSpectrum, id)
  })

  // Pre-compute target substrate latent for few-shot anchor term.
  const tgtId = weights.id_table[target.profileName] ?? weights.null_id
  const tgtSubLat = fwd.encodeSubstrate(target.paperSpectrum, tgtId)

  // Evenly-spaced subsample indices per support profile.
  const supportSubsamples = supportProfiles.map(sp => {
    const N_sp = sp.sampleIds.length
    const stride = Math.max(1, Math.floor(N_sp / maxPatchesPerSupport))
    const idxs: number[] = []
    for (let i = 0; i < N_sp; i += stride) idxs.push(i)
    return idxs
  })

  // Reusable rgb buffer — allocated once outside the hot loop.
  const rgb = new Float64Array(3)

  // Loss: spectral MSE across support (subsampled) + few-shot anchor patches.
  const lossFn = (latent: number[]) => {
    let totalSS = 0
    let totalN = 0

    for (let si = 0; si < supportProfiles.length; si++) {
      const sp = supportProfiles[si]
      const spSubLat = supportSubLats[si]
      for (const i of supportSubsamples[si]) {
        rgb[0] = sp.deviceValues[i * 3] / 255
        rgb[1] = sp.deviceValues[i * 3 + 1] / 255
        rgb[2] = sp.deviceValues[i * 3 + 2] / 255
        const rRow = sp.spectra.subarray(i * L, i * L + L)
        const ink = fwd.encodeSpectrum(rRow, rgb, spSubLat)
        const pred = fwd.decode(ink, rgb, latent)
        for (let l = 0; l < L; l++) {
          const d = pred[l] - sp.spectra[i * L + l]
          totalSS += d * d
        }
        totalN++
      }
    }

    // Few-shot: target anchor patches guide latent toward actual target substrate.
    if (anchorIndices.length > 0) {
      for (const i of anchorIndices) {
        rgb[0] = target.deviceValues[i * 3] / 255
        rgb[1] = target.deviceValues[i * 3 + 1] / 255
        rgb[2] = target.deviceValues[i * 3 + 2] / 255
        const rRow = target.spectra.subarray(i * L, i * L + L)
        const ink = fwd.encodeSpectrum(rRow, rgb, tgtSubLat)
        const pred = fwd.decode(ink, rgb, latent)
        let ss = 0
        for (let l = 0; l < L; l++) {
          const d = pred[l] - target.spectra[i * L + l]
          ss += d * d
        }
        totalSS += anchorWeight * ss
        totalN++
      }
    }

    return totalN > 0 ? totalSS / totalN : Infinity
  }

  const nmResult = nelderMead(lossFn, initLatent, {
    max_iter: config.nmIterations,
    tol: config.nmTolerance,
    initial_simplex_size: 0.1,
  })

  const optimizedLatent = nmResult.bestPoint

  // Final prediction on full target using optimized substrate latent.
  const finalResult = runCAETransfer({
    weights,
    X_A: target.spectra,
    X_B: target.spectra,
    D: target.deviceValues,
    paper_A: target.paperSpectrum,
    paper_B: target.paperSpectrum,
    sampleIds: target.sampleIds,
    anchorIdx: new Int32Array(anchorIndices),
    paperRowIdx: 0,
    L,
    paperWP: targetPaperWP,
    refProfile: target.profileName,
    targetProfile: target.profileName,
    overrideSubstrateLatent: optimizedLatent,
  })

  return {
    X_pred: finalResult.X_pred,
    report: finalResult.report,
    optimizedLatent,
    anchorFineTuned: anchorIndices.length > 0,
    looSupportCount: supportProfiles.length,
  }
}
