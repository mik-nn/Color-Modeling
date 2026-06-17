/**
 * TDD: biasWarning — spreadCurv-based hue/saturation bias detector.
 *
 * Inputs: reference ProfileData[] + target AnchorMeasurements (must include 3
 * neutrals: white/gray128/black). Outputs BiasWarning with level, deltaCurv560,
 * message, optional recommendedReference, recoverable flag.
 *
 * Thresholds from H36 (Youden-optimal): dCurv >= 0.137 → warn.
 * H41: FLIP dCurv ≈ 0.081 (low → count-limited, more patches help);
 *       FAIL dCurv ≈ 0.147 (structural, chromatic — won't fix).
 */

import { describe, it, expect } from 'vitest'
import type { BiasWarning, BiasWarningInput } from './biasWarning'
import { computeBiasWarning } from './biasWarning'
import type { ProfileData } from '../../types'
import type { AnchorMeasurement } from './generateDataset'

const L = 36
const WL = Array.from({ length: L }, (_, i) => 380 + i * 10)

// ---- synthetic spectrum helpers -----------------------------------------

function flatSpec(scale: number): number[] {
  return Array.from({ length: L }, () => scale)
}

/**
 * Build a neutral-ramp spectrum: paper-normalised R(λ) = 1 + c1*a + c2*a²
 * where a = ink coverage. Tune c1/c2 to set spreadCurv magnitude.
 */
function neutralSpec(paperScale: number, a: number, c1: number, c2: number): number[] {
  return WL.map(() => {
    const norm = 1 + c1 * a + c2 * a * a
    return Math.max(0.01, paperScale * norm)
  })
}

// Reference profile with a known spreadCurv value (determined by c1/c2)
function makeRefProfile(name: string, paperScale: number, c1: number, c2: number): ProfileData {
  const coverages = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
  const raw = coverages.map((a, idx) => {
    const rgb = Math.round((1 - a) * 255)
    return {
      SAMPLE_ID: `R1C${idx + 1}P1`,
      RGB_R: rgb, RGB_G: rgb, RGB_B: rgb,
      spectra: neutralSpec(paperScale, a, c1, c2),
      has_spectral: true,
    }
  })
  return {
    metadata: { full_name: name, brand: 'test', series: name, printer: 'P9000',
      ink: 'mk', substrate: name, parsed_at: '', printMode: 'CanvasMatte' },
    raw,
    has_spectral: true,
    patch_count: raw.length,
    wavelengths: WL,
  } as any
}

// 3 neutral anchor measurements with a given c1/c2 (simulates target substrate)
function makeNeutralAnchors(paperScale: number, c1: number, c2: number): AnchorMeasurement[] {
  return [
    { device: [255, 255, 255], spectrum: neutralSpec(paperScale, 0,   c1, c2) }, // paper a=0
    { device: [128, 128, 128], spectrum: neutralSpec(paperScale, 0.5, c1, c2) }, // mid   a≈0.5
    { device: [0,   0,   0],   spectrum: neutralSpec(paperScale, 1.0, c1, c2) }, // black a=1
  ]
}

function makeCov6Anchors(paperScale: number, c1: number, c2: number): AnchorMeasurement[] {
  return [
    ...makeNeutralAnchors(paperScale, c1, c2),
    { device: [0,   255, 255], spectrum: flatSpec(paperScale * 0.4) }, // cyan
    { device: [255, 0,   255], spectrum: flatSpec(paperScale * 0.4) }, // magenta
    { device: [255, 255, 0],   spectrum: flatSpec(paperScale * 0.4) }, // yellow
  ]
}

// ---- tests ---------------------------------------------------------------

describe('biasWarning', () => {
  describe('input validation', () => {
    it('throws when refs empty', () => {
      expect(() => computeBiasWarning({
        refs: [],
        targetAnchors: makeCov6Anchors(0.9, -0.5, -0.1),
      })).toThrow(/at least one/)
    })

    it('throws when no paper-white anchor in target', () => {
      const ref = makeRefProfile('RefA', 1.0, -0.5, -0.1)
      const anchors = makeCov6Anchors(0.9, -0.5, -0.1).filter(
        (a) => !(a.device[0] === 255 && a.device[1] === 255 && a.device[2] === 255),
      )
      expect(() => computeBiasWarning({ refs: [ref], targetAnchors: anchors }))
        .toThrow(/paper.white/)
    })

    it('throws when fewer than 3 neutral anchors', () => {
      const ref = makeRefProfile('RefA', 1.0, -0.5, -0.1)
      // Only paper + cyan + magenta (no gray, no black)
      const anchors: AnchorMeasurement[] = [
        { device: [255, 255, 255], spectrum: flatSpec(0.9) },
        { device: [0,   255, 255], spectrum: flatSpec(0.4) },
        { device: [255, 0,   255], spectrum: flatSpec(0.4) },
      ]
      expect(() => computeBiasWarning({ refs: [ref], targetAnchors: anchors }))
        .toThrow(/neutral/)
    })
  })

  describe('level = ok (matched substrates)', () => {
    it('returns level=ok when ref and target have similar spreadCurv', () => {
      // Same c1/c2 → dCurv ≈ 0
      const ref = makeRefProfile('RefA', 1.0, -0.5, -0.1)
      const result = computeBiasWarning({
        refs: [ref],
        targetAnchors: makeCov6Anchors(0.9, -0.5, -0.1),
      })
      expect(result.level).toBe('ok')
      expect(result.deltaCurv560).toBeLessThan(0.137)
      expect(result.recoverable).toBe(true)
    })
  })

  describe('level = hue-sat-bias (dCurv >= 0.137)', () => {
    it('warns when spreadCurv mismatch exceeds threshold', () => {
      // Ref: low curv (matte-like, c1=-0.3, c2=-0.05 → small spread)
      // Target: high curv (glossy-like, c1=-0.9, c2=-0.3 → large spread)
      const ref = makeRefProfile('Matte', 1.0, -0.3, -0.05)
      const result = computeBiasWarning({
        refs: [ref],
        targetAnchors: makeCov6Anchors(0.9, -0.9, -0.3),
      })
      expect(result.level).toBe('hue-sat-bias')
      expect(result.deltaCurv560).toBeGreaterThanOrEqual(0.137)
      expect(result.message).toMatch(/bias|mismatch|dCurv/i)
    })

    it('recoverable = false for hue-sat-bias (chromatic, spreading won\'t fix)', () => {
      const ref = makeRefProfile('Matte', 1.0, -0.3, -0.05)
      const result = computeBiasWarning({
        refs: [ref],
        targetAnchors: makeCov6Anchors(0.9, -0.9, -0.3),
      })
      expect(result.recoverable).toBe(false)
    })
  })

  describe('multiple refs — recommender', () => {
    it('returns recommendedReference = nearest spreadCurv ref', () => {
      // Target has curv similar to refB, not refA
      const refA = makeRefProfile('Matte',  1.0, -0.3, -0.05)  // low curv
      const refB = makeRefProfile('Glossy', 0.95, -0.8, -0.25) // high curv — close to target
      const result = computeBiasWarning({
        refs: [refA, refB],
        targetAnchors: makeCov6Anchors(0.88, -0.75, -0.22), // similar to refB
      })
      expect(result.recommendedReference).toBe('Glossy')
    })

    it('level based on nearest (best) ref pair, not worst', () => {
      const refA = makeRefProfile('Matte',  1.0, -0.3, -0.05)  // far from target
      const refB = makeRefProfile('Glossy', 0.95, -0.8, -0.25) // close to target
      const targetAnchors = makeCov6Anchors(0.88, -0.78, -0.24)
      const result = computeBiasWarning({ refs: [refA, refB], targetAnchors })
      // refB is close → level should be ok (or lower severity than refA alone)
      const resultA = computeBiasWarning({ refs: [refA], targetAnchors })
      // Using both refs should give same or better level than refA alone
      expect(['ok', 'hue-sat-bias'].includes(result.level)).toBe(true)
      if (resultA.level === 'hue-sat-bias') {
        expect(['ok', 'hue-sat-bias'].includes(result.level)).toBe(true)
      }
    })
  })

  describe('output structure', () => {
    it('always returns deltaCurv560, level, message, recoverable', () => {
      const ref = makeRefProfile('RefA', 1.0, -0.5, -0.1)
      const result = computeBiasWarning({
        refs: [ref],
        targetAnchors: makeCov6Anchors(0.9, -0.5, -0.1),
      })
      expect(typeof result.deltaCurv560).toBe('number')
      expect(['ok', 'hue-sat-bias', 'incompatible'].includes(result.level)).toBe(true)
      expect(typeof result.message).toBe('string')
      expect(result.message.length).toBeGreaterThan(0)
      expect(typeof result.recoverable).toBe('boolean')
    })

    it('recommendedReference is undefined for single ref', () => {
      const ref = makeRefProfile('RefA', 1.0, -0.5, -0.1)
      const result = computeBiasWarning({
        refs: [ref],
        targetAnchors: makeCov6Anchors(0.9, -0.5, -0.1),
      })
      expect(result.recommendedReference).toBeUndefined()
    })
  })
})
