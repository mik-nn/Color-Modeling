import { describe, expect, test } from 'vitest'
import { extractAtDataBlock, parseCxFTextToSpectra } from '../lib/cxFParser'

describe('CxF @data parsing', () => {
  test('extracts @data block', () => {
    const text = `
@header
some stuff
@data
380 0.1
390 0.2
400 0.3
@other
end
`.trim()

    const block = extractAtDataBlock(text)
    expect(block).toContain('380 0.1')
    expect(block).not.toContain('@other')
  })

  test('parses two-column wavelength/reflection format', () => {
    const text = `
@data
380 0.10
390 0.20
400 0.30
@end
`.trim()

    const parsed = parseCxFTextToSpectra(text)
    expect(parsed).not.toBeNull()
    expect(parsed?.wavelengths).toEqual([380, 390, 400])
    expect(parsed?.spectra).toEqual([0.1, 0.2, 0.3])
  })
})
