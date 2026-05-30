// src/lib/sampling/labSaturation.ts
//
// S4 — Lab-saturation anchor selection.
//
// Picks paper plus the highest-chroma measured patches, with a hue-separation
// guard so a tiny anchor set does not collapse into one saturated color family.

import type { AnchorSet, WhitePointXYZ } from '../../types'
import { spectraToLab, spectraToXYZ } from '../colormath'
import type { ProfileMatrices } from '../dataset/matrix'

export interface LabSaturationAnchorOptions {
  /** Number of saturated non-paper anchors to add. Default 2. */
  count?: number
  /** Minimum hue separation between saturated anchors. Default 90 degrees. */
  minHueSeparationDeg?: number
}

export function labChroma(lab: readonly [number, number, number]): number {
  return Math.hypot(lab[1], lab[2])
}

export function hueDegrees(lab: readonly [number, number, number]): number {
  const hue = (Math.atan2(lab[2], lab[1]) * 180) / Math.PI
  return hue < 0 ? hue + 360 : hue
}

export function angularDistanceDeg(a: number, b: number): number {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

export function labFromMatrixRow(
  profile: ProfileMatrices,
  rowIdx: number,
  paperWP: WhitePointXYZ,
): [number, number, number] {
  if (rowIdx < 0 || rowIdx >= profile.N) {
    throw new Error(`labFromMatrixRow: row ${rowIdx} out of range`)
  }
  const spectrum = new Array<number>(profile.L)
  for (let l = 0; l < profile.L; l++) {
    spectrum[l] = profile.X[rowIdx * profile.L + l]
  }
  return spectraToLab(spectrum, profile.wavelengths[0] ?? 380, paperWP)
}

function nearestRgbIdx(
  profile: ProfileMatrices,
  target: readonly [number, number, number],
): number {
  if (profile.channels !== 3) {
    throw new Error(`pickLabSaturationAnchors: RGB-only for now (got ${profile.channels} channels)`)
  }
  let bestIdx = -1
  let bestD = Infinity
  for (let i = 0; i < profile.N; i++) {
    const dr = profile.D[i * 3] - target[0]
    const dg = profile.D[i * 3 + 1] - target[1]
    const db = profile.D[i * 3 + 2] - target[2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestD) {
      bestD = d
      bestIdx = i
    }
  }
  return bestIdx
}

export function pickLabSaturationAnchors(
  profile: ProfileMatrices,
  options: LabSaturationAnchorOptions = {},
): AnchorSet {
  if (profile.N === 0) {
    throw new Error('pickLabSaturationAnchors: no patches in profile')
  }
  const count = options.count ?? 2
  if (count < 1) {
    throw new Error(`pickLabSaturationAnchors: count must be >= 1, got ${count}`)
  }
  const minHueSeparationDeg = options.minHueSeparationDeg ?? 90

  const paperIdx = nearestRgbIdx(profile, [255, 255, 255])
  if (paperIdx < 0) {
    throw new Error('pickLabSaturationAnchors: no paper candidate found')
  }

  const paperSpec = new Array<number>(profile.L)
  for (let l = 0; l < profile.L; l++) {
    paperSpec[l] = profile.X[paperIdx * profile.L + l]
  }
  const paperWP = spectraToXYZ(paperSpec, profile.wavelengths[0] ?? 380)

  const candidates: { idx: number; chroma: number; hue: number }[] = []
  for (let i = 0; i < profile.N; i++) {
    if (i === paperIdx) continue
    const lab = labFromMatrixRow(profile, i, paperWP)
    candidates.push({ idx: i, chroma: labChroma(lab), hue: hueDegrees(lab) })
  }
  candidates.sort((a, b) => b.chroma - a.chroma)

  const picked = [paperIdx]
  const pickedHues: number[] = []
  for (const candidate of candidates) {
    if (
      pickedHues.length === 0 ||
      pickedHues.every((h) => angularDistanceDeg(h, candidate.hue) >= minHueSeparationDeg)
    ) {
      picked.push(candidate.idx)
      pickedHues.push(candidate.hue)
      if (picked.length === count + 1) break
    }
  }

  for (const candidate of candidates) {
    if (picked.length === count + 1) break
    if (!picked.includes(candidate.idx)) picked.push(candidate.idx)
  }

  return {
    sampleIds: picked.map((i) => profile.sampleIds[i]),
    strategy: 'forced',
    meta: {
      chosenIdx: picked,
      labels: picked.map((_, i) => (i === 0 ? 'paper' : `sat_${i}`)),
      count,
      minHueSeparationDeg,
    },
  }
}
