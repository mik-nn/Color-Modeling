/**
 * biasWarning — spreadCurv-based Hue/Saturation Bias detector.
 *
 * Computes spreadCurv for reference profile(s) and target substrate (from
 * 3 neutral anchors: white/mid-gray/black), compares them, and returns a
 * BiasWarning with level, message, and reference recommender.
 *
 * H36/H37/H38/H41:
 *   - dCurv < 0.137 → ok (spreading-compatible)
 *   - dCurv ≥ 0.137 → hue-sat-bias (chromatic tail, spreading won't fix)
 *   - recoverable = false because the residual is chromatic, not neutral (H38/H40)
 *
 * The recommender (multi-ref) uses rankReferencesByProximity to pick the ref
 * nearest in spreadCurv space (H37: nearest-vs-farthest 13/14 pass-rate).
 *
 * @module lib/core/biasWarning
 */

import type { ProfileData } from '../../types'
import { loadProfileMatrix } from '../dataset/matrix'
import {
  computeSpreadCurv,
  classifyPairCompatibility,
  rankReferencesByProximity,
  SPREADCURV_FAIL_THRESHOLD,
} from '../predict/spreadCurv'
import type { AnchorMeasurement } from './generateDataset'

export type BiasLevel = 'ok' | 'hue-sat-bias' | 'incompatible'

export interface BiasWarning {
  level: BiasLevel
  deltaCurv560: number
  /** Human-readable description of the risk (EN). */
  message: string
  /** Name of the recommended reference (nearest spreadCurv), multi-ref only. */
  recommendedReference?: string
  /**
   * Whether the issue is expected to be fixable with more anchor patches.
   * Always false for hue-sat-bias/incompatible (H38: spreading won't fix;
   * H40: tail is chromatic, per-ink — neutral data can't correct it).
   */
  recoverable: boolean
}

export interface BiasWarningInput {
  refs: ProfileData[]
  targetAnchors: AnchorMeasurement[]
}

// --------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------

function validate(input: BiasWarningInput): void {
  if (!input.refs.length) {
    throw new Error('computeBiasWarning: need at least one reference profile')
  }
  const hasPaper = input.targetAnchors.some(
    (a) => a.device[0] === 255 && a.device[1] === 255 && a.device[2] === 255,
  )
  if (!hasPaper) {
    throw new Error(
      'computeBiasWarning: targetAnchors must include paper-white (255,255,255)',
    )
  }
  const neutrals = input.targetAnchors.filter(
    (a) => Math.abs(a.device[0] - a.device[1]) + Math.abs(a.device[1] - a.device[2]) <= 10,
  )
  if (neutrals.length < 3) {
    throw new Error(
      `computeBiasWarning: need ≥3 neutral anchors (R≈G≈B) to compute spreadCurv; ` +
      `got ${neutrals.length}. Ensure coverage chart includes paper, mid-gray, and black.`,
    )
  }
}

// --------------------------------------------------------------------------
// Compute spreadCurv from sparse neutral anchors (≥2 non-paper points).
//
// computeSpreadCurv() requires ≥3 non-paper neutrals. cov6 only provides 2
// (gray128 + black) after skipping paper. We solve the quadratic exactly for
// n=2 (2×2 linear system: well-determined given paper = implicit a=0 anchor).
// --------------------------------------------------------------------------

function idx560(L: number): number {
  // 560nm: band index = (560-380)/10 = 18
  return Math.min(18, L - 1)
}

/**
 * Fit y = 1 + c1*a + c2*a² on n≥1 (a,y) pairs (no free constant).
 * For n=1: 1-DOF line c2=0. For n=2: exact 2×2 solution. For n≥3: OLS.
 * Returns [c1, c2].
 */
function fitSpreadQuad(ai: number[], yi: number[]): [number, number] {
  const n = ai.length
  if (n === 0) return [0, 0]
  const ri = yi.map((y, i) => y - 1) // r = y - 1
  if (n === 1) {
    // c1 only: c1*a = r → c1 = r/a (c2=0)
    return [ai[0] > 0 ? ri[0] / ai[0] : 0, 0]
  }
  if (n === 2) {
    // Exact: [a1 a1²; a2 a2²] * [c1;c2] = [r1;r2]
    const [a1, a2] = ai, [r1, r2] = ri
    const det = a1 * a2 * a2 - a2 * a1 * a1
    if (Math.abs(det) < 1e-12) return [0, 0]
    const c1 = (r1 * a2 * a2 - r2 * a1 * a1) / det
    const c2 = (r2 * a1 - r1 * a2) / det
    return [c1, c2]
  }
  // n≥3: OLS via normal equations
  let S11 = 0, S12 = 0, S22 = 0, T1 = 0, T2 = 0
  for (let i = 0; i < n; i++) {
    const a = ai[i], a2 = a * a, r = ri[i]
    S11 += a * a; S12 += a * a2; S22 += a2 * a2; T1 += a * r; T2 += a2 * r
  }
  const det = S11 * S22 - S12 * S12
  if (Math.abs(det) < 1e-18) return [0, 0]
  return [(T1 * S22 - T2 * S12) / det, (T2 * S11 - T1 * S12) / det]
}

/**
 * Compute spreadCurv from sparse neutral anchor measurements.
 * Accepts ≥1 non-paper neutral. Paper is the implicit a=0 anchor.
 */
function targetSpreadCurv(anchors: AnchorMeasurement[]): SpreadCurv | null {
  const L = 36

  // Extract neutrals, separate paper (a≈0) from ramp points
  const paperAnc = anchors.find(
    (a) => a.device[0] === 255 && a.device[1] === 255 && a.device[2] === 255,
  )
  if (!paperAnc) return null
  const paperSpec = paperAnc.spectrum

  const ramp = anchors.filter((a) => {
    const isNeutral = Math.abs(a.device[0] - a.device[1]) + Math.abs(a.device[1] - a.device[2]) <= 10
    const ai = (765 - a.device[0] - a.device[1] - a.device[2]) / 765
    return isNeutral && ai >= 0.01
  })
  if (ramp.length < 1) return null

  const coverages = ramp.map((a) => (765 - a.device[0] - a.device[1] - a.device[2]) / 765)

  const i560 = idx560(L)
  let s560 = 0, bbSum = 0, bbCnt = 0

  for (let l = 0; l < L; l++) {
    const pv = paperSpec[l] ?? 0
    if (pv < 1e-5) continue
    const ys = ramp.map((a) => (a.spectrum[l] ?? 0) / pv)
    const [c1, c2] = fitSpreadQuad(coverages, ys)
    const mag = Math.hypot(c1, c2)
    bbSum += mag; bbCnt++
    if (l === i560) s560 = mag
  }

  return { s560, bb: bbCnt ? bbSum / bbCnt : 0, nNeutrals: ramp.length }
}

// --------------------------------------------------------------------------
// Build message
// --------------------------------------------------------------------------

function buildMessage(level: BiasLevel, dCurv: number, recommended?: string): string {
  const dStr = dCurv.toFixed(3)
  switch (level) {
    case 'ok':
      return `Substrate compatible (ΔcurvBias ${dStr} < ${SPREADCURV_FAIL_THRESHOLD}). No chromatic bias expected.`
    case 'hue-sat-bias':
      return (
        `Hue/saturation bias risk (Δcurv ${dStr} ≥ ${SPREADCURV_FAIL_THRESHOLD}). ` +
        `Predicted: chromatic tail in heavy-ink / saturated regions (H40: chroma ±5–9, hue ±13–18°). ` +
        `Adding more anchor patches will NOT fix this — bias is chromatic, not neutral (H38).` +
        (recommended ? ` Recommended reference: ${recommended}.` : '')
      )
    case 'incompatible':
      return (
        `Substrates spectrally incompatible (Δcurv ${dStr}). ` +
        `Structural ceiling applies — additional patches will not improve accuracy.`
      )
  }
}

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

/**
 * Compute Hue/Saturation Bias warning for a reference → new-substrate transfer.
 *
 * For multiple refs: evaluates all pairs, picks the nearest (best) reference
 * as the recommended one, and reports the warning level for that best pair.
 */
export function computeBiasWarning(input: BiasWarningInput): BiasWarning {
  validate(input)

  const { refs, targetAnchors } = input

  // Compute target spreadCurv from neutral anchors
  const targetCurv = targetSpreadCurv(targetAnchors)
  if (!targetCurv) {
    return {
      level: 'ok',
      deltaCurv560: 0,
      message: 'Could not compute spreadCurv from target anchors (insufficient neutral coverage).',
      recoverable: true,
    }
  }

  // Compute spreadCurv for each reference
  const refCurvs = refs.map((ref) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mat = loadProfileMatrix(ref as any)
    return { ref, curv: computeSpreadCurv(mat) }
  }).filter((rc): rc is { ref: ProfileData; curv: NonNullable<ReturnType<typeof computeSpreadCurv>> } =>
    rc.curv !== null,
  )

  if (!refCurvs.length) {
    // Refs have no neutral ramp data → can't assess; be conservative
    return {
      level: 'ok',
      deltaCurv560: 0,
      message: 'Reference profiles lack neutral-ramp data; bias assessment skipped.',
      recoverable: true,
    }
  }

  // Single ref
  if (refs.length === 1) {
    const { curv } = refCurvs[0]
    const compat = classifyPairCompatibility(curv, targetCurv)
    const level: BiasLevel = compat.risk === 'warn' ? 'hue-sat-bias' : 'ok'
    return {
      level,
      deltaCurv560: compat.dCurv,
      message: buildMessage(level, compat.dCurv),
      recoverable: level === 'ok',
    }
  }

  // Multiple refs: rank by proximity to target, evaluate best pair
  const ranked = rankReferencesByProximity(
    targetCurv,
    refCurvs.map(({ ref, curv }) => ({ ref, curv })),
  )
  const best = ranked[0]
  const level: BiasLevel = best.risk === 'warn' ? 'hue-sat-bias' : 'ok'
  const recommended = best.ref.metadata.full_name

  return {
    level,
    deltaCurv560: best.dCurv,
    message: buildMessage(level, best.dCurv, recommended),
    recommendedReference: recommended,
    recoverable: level === 'ok',
  }
}
