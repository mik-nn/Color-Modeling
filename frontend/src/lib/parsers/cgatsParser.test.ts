import { describe, expect, it } from 'vitest'
import { parseCgats17Text } from './cgatsParser'

const CGATS = `text\0\0\0\0CGATS.17
NUMBER_OF_FIELDS 6
BEGIN_DATA_FORMAT
RGB_R RGB_G RGB_B SPECTRAL_NM_380 SPECTRAL_NM_390 SPECTRAL_NM_400
END_DATA_FORMAT
NUMBER_OF_SETS 2
BEGIN_DATA
255 255 255 0.9 0.9 0.9
0 0 0 0.1 0.1 0.1
END_DATA`

describe('parseCgats17Text', () => {
  it('parses CGATS spectral RGB rows from ICC text tag payloads', () => {
    const result = parseCgats17Text(CGATS)

    expect(result.hasSpectral).toBe(true)
    expect(result.patchCount).toBe(2)
    expect(result.wavelengths).toEqual([380, 390, 400])
    expect(result.measurements[0].RGB_R).toBe(255)
    expect(result.measurements[0].device).toEqual({ space: 'rgb', values: [255, 255, 255] })
    expect(result.measurements[0].spectra).toEqual([0.9, 0.9, 0.9])
  })

  it('generates SAMPLE_ID from device RGB when field is absent', () => {
    const result = parseCgats17Text(CGATS)

    expect(result.measurements[0].SAMPLE_ID).toBe('RGB_255_255_255')
    expect(result.measurements[1].SAMPLE_ID).toBe('RGB_0_0_0')
  })

  it('preserves explicit SAMPLE_ID field when present', () => {
    const cgatsWithId = `CGATS.17
BEGIN_DATA_FORMAT
SAMPLE_ID RGB_R RGB_G RGB_B SPECTRAL_NM_380 SPECTRAL_NM_390
END_DATA_FORMAT
NUMBER_OF_SETS 1
BEGIN_DATA
MyPatch 255 255 255 0.9 0.9
END_DATA`
    const result = parseCgats17Text(cgatsWithId)

    expect(result.measurements[0].SAMPLE_ID).toBe('MyPatch')
  })

  it('normalizes percent reflectance values to 0-1', () => {
    const result = parseCgats17Text(CGATS.replace(/0\.9/g, '90').replace(/0\.1/g, '10'))

    expect(result.measurements[0].spectra?.[0]).toBeCloseTo(0.9)
    expect(result.measurements[1].spectra?.[0]).toBeCloseTo(0.1)
  })

  it('returns an empty result when required blocks are missing', () => {
    const result = parseCgats17Text('CGATS.17\nNUMBER_OF_FIELDS 0')

    expect(result.hasSpectral).toBe(false)
    expect(result.patchCount).toBe(0)
    expect(result.measurements).toEqual([])
  })

  it('returns an empty result when the data has no spectral columns', () => {
    const result = parseCgats17Text(`CGATS.17
BEGIN_DATA_FORMAT
RGB_R RGB_G RGB_B
END_DATA_FORMAT
BEGIN_DATA
255 255 255
END_DATA`)

    expect(result.hasSpectral).toBe(false)
    expect(result.patchCount).toBe(0)
    expect(result.measurements).toEqual([])
  })
})
