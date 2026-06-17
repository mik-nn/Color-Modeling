import { describe, it, expect } from 'vitest'
import { exportDatasetAsCGATS } from './cgatsDataset'
import type { GenerateDatasetResult } from './generateDataset'

const L = 36
const WLS = Array.from({ length: L }, (_, i) => 380 + i * 10)

function makeResult(N: number): GenerateDatasetResult {
  const predicted = new Float64Array(N * L)
  const deviceValues = new Float64Array(N * 3)
  const sampleIds: string[] = []
  for (let i = 0; i < N; i++) {
    sampleIds.push(`P${i + 1}`)
    // Ramp: flat spectrum at level i/(N-1)
    const v = N > 1 ? i / (N - 1) : 0.5
    for (let l = 0; l < L; l++) predicted[i * L + l] = v
    deviceValues[i * 3] = Math.round(255 * (1 - v))
    deviceValues[i * 3 + 1] = Math.round(255 * (1 - v))
    deviceValues[i * 3 + 2] = Math.round(255 * (1 - v))
  }
  return { predicted, deviceValues, sampleIds, anchorIdx: [0], path: 'D1' }
}

describe('exportDatasetAsCGATS', () => {
  it('produces valid CGATS header', () => {
    const r = makeResult(3)
    const out = exportDatasetAsCGATS(r, { targetName: 'TestSub' })
    expect(out).toContain('CGATS.17')
    expect(out).toContain('BEGIN_DATA_FORMAT')
    expect(out).toContain('END_DATA_FORMAT')
    expect(out).toContain('BEGIN_DATA')
    expect(out).toContain('END_DATA')
    expect(out).toContain('NUMBER_OF_SETS\t3')
  })

  it('contains correct field list', () => {
    const r = makeResult(2)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    expect(out).toContain('SAMPLE_ID\tRGB_R\tRGB_G\tRGB_B\tLAB_L\tLAB_A\tLAB_B')
    for (const wl of WLS) expect(out).toContain(`SPECTRAL_NM_${wl}`)
    expect(out).toContain(`NUMBER_OF_FIELDS\t${7 + L}`)
  })

  it('data rows: correct count', () => {
    const N = 5
    const r = makeResult(N)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    const dataSection = out.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0]
    const rows = dataSection.trim().split('\n')
    expect(rows).toHaveLength(N)
  })

  it('data rows: sample IDs match', () => {
    const r = makeResult(3)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    expect(out).toContain('P1\t')
    expect(out).toContain('P2\t')
    expect(out).toContain('P3\t')
  })

  it('data rows: RGB values are integers', () => {
    const r = makeResult(3)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    const dataSection = out.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0]
    for (const row of dataSection.trim().split('\n')) {
      const cols = row.split('\t')
      // cols[1,2,3] = RGB
      for (const idx of [1, 2, 3]) {
        expect(Number.isInteger(parseFloat(cols[idx]))).toBe(true)
      }
    }
  })

  it('spectral values in 0–100 range', () => {
    // spectrum of 0.5 reflectance → CGATS 50.0000
    const r = makeResult(3)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    // Mid-row (i=1, v=0.5) should have spectral ≈ 50.0000
    const dataSection = out.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0]
    const rows = dataSection.trim().split('\n')
    const midCols = rows[1].split('\t')
    // spectral start at col 7
    for (let i = 7; i < 7 + L; i++) {
      const v = parseFloat(midCols[i])
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })

  it('markAnchors: anchor rows get trailing *', () => {
    const r = makeResult(4)
    // anchorIdx = [0] by default in makeResult
    const out = exportDatasetAsCGATS(r, { targetName: 'T', markAnchors: true })
    expect(out).toContain('P1*\t')
    expect(out).not.toContain('P2*\t')
  })

  it('refName appears in ORIGINATOR', () => {
    const r = makeResult(2)
    const out = exportDatasetAsCGATS(r, { targetName: 'T', refName: 'CanvasGloss' })
    expect(out).toContain('CanvasGloss')
    expect(out).toContain('ORIGINATOR')
  })

  it('DESCRIPTOR contains targetName', () => {
    const r = makeResult(2)
    const out = exportDatasetAsCGATS(r, { targetName: 'AllureMatt' })
    expect(out).toContain('AllureMatt')
    expect(out).toContain('DESCRIPTOR')
  })

  it('round-trip: parse SAMPLE_ID and RGB back from data rows', () => {
    const r = makeResult(4)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    const dataSection = out.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0]
    const rows = dataSection.trim().split('\n')
    for (let i = 0; i < rows.length; i++) {
      const cols = rows[i].split('\t')
      expect(cols[0]).toBe(`P${i + 1}`)
      const rgb_r = parseFloat(cols[1])
      // RGB should be in 0–255
      expect(rgb_r).toBeGreaterThanOrEqual(0)
      expect(rgb_r).toBeLessThanOrEqual(255)
      // total columns = 7 + 36 = 43
      expect(cols).toHaveLength(7 + L)
    }
  })

  it('Lab values present and finite', () => {
    const r = makeResult(3)
    const out = exportDatasetAsCGATS(r, { targetName: 'T' })
    const dataSection = out.split('BEGIN_DATA\n')[1].split('\nEND_DATA')[0]
    for (const row of dataSection.trim().split('\n')) {
      const cols = row.split('\t')
      // Lab at cols 4,5,6
      for (const idx of [4, 5, 6]) {
        expect(isFinite(parseFloat(cols[idx]))).toBe(true)
      }
    }
  })
})
