// src/lib/parsers/cgatsParser.ts
//
// CGATS.17 parser for ICC `targ` tags produced by basICColor / similar tools.
// MOAB P9000 profiles store spectral target data this way rather than as
// X-Rite ZXML CxF.

import type { Measurement, WhitePointXYZ } from '../../types'
import { D50_PERFECT_WHITE, spectraToXYZ, xyzToLab } from '../colormath'

export interface CgatsParseResult {
  measurements: Measurement[]
  hasSpectral: boolean
  wavelengths?: number[]
  patchCount: number
}

function cleanCgatsText(text: string): string {
  const cgatsIdx = text.indexOf('CGATS')
  return (cgatsIdx >= 0 ? text.slice(cgatsIdx) : text).replace(/\0/g, '').replace(/\r/g, '\n')
}

function splitFields(line: string): string[] {
  return line.trim().split(/\s+/).filter(Boolean)
}

function findBlock(lines: string[], begin: string, end: string): string[] {
  const start = lines.findIndex((line) => line.trim() === begin)
  if (start < 0) return []
  const stop = lines.findIndex((line, i) => i > start && line.trim() === end)
  return lines
    .slice(start + 1, stop >= 0 ? stop : undefined)
    .filter((line) => line.trim().length > 0)
}

function spectralWavelength(field: string): number | null {
  // Accept i1Profiler/X-Rite (`nm380`), Canon MOAB targ (`R_380`), and
  // CGATS.17 (`SPECTRAL_NM_380`) column dialects. 3-digit wavelengths only
  // (380–730), so `RGB_R` etc. never match.
  const m = field.match(/^(?:SPECTRAL_NM_|nm|R_)(\d{3})$/i)
  return m ? Number(m[1]) : null
}

const SAMPLE_ID_RE = /^SAMPLE_?ID$/i

function parseTagRows(text: string): { fields: string[]; rows: string[][] } {
  const lines = cleanCgatsText(text).split('\n')
  const fmt = findBlock(lines, 'BEGIN_DATA_FORMAT', 'END_DATA_FORMAT')
  const data = findBlock(lines, 'BEGIN_DATA', 'END_DATA')
  if (fmt.length === 0 || data.length === 0) return { fields: [], rows: [] }
  return { fields: splitFields(fmt[0]), rows: data.map(splitFields) }
}

/**
 * Join an i1Profiler `CIED` spectral tag (SampleID + nm380…) to its `DevD`
 * device tag (SampleID + RGB_R/G/B) on the shared SampleID, emitting one
 * combined CGATS.17 text. Returns '' if either tag lacks its required columns.
 */
export function mergeCiedDevDToCgats(ciedText: string, devdText: string): string {
  const dev = parseTagRows(devdText)
  const dSid = dev.fields.findIndex((f) => SAMPLE_ID_RE.test(f))
  const dR = dev.fields.findIndex((f) => /^RGB_R$/i.test(f))
  const dG = dev.fields.findIndex((f) => /^RGB_G$/i.test(f))
  const dB = dev.fields.findIndex((f) => /^RGB_B$/i.test(f))
  if (dSid < 0 || dR < 0 || dG < 0 || dB < 0) return ''
  const rgb = new Map<string, [string, string, string]>()
  for (const row of dev.rows) rgb.set(row[dSid], [row[dR], row[dG], row[dB]])

  const cie = parseTagRows(ciedText)
  const cSid = cie.fields.findIndex((f) => SAMPLE_ID_RE.test(f))
  const spec = cie.fields
    .map((f, i) => ({ i, wl: spectralWavelength(f) }))
    .filter((x): x is { i: number; wl: number } => x.wl !== null)
  if (cSid < 0 || spec.length === 0) return ''

  const header = ['RGB_R', 'RGB_G', 'RGB_B', ...spec.map((x) => `SPECTRAL_NM_${x.wl}`)].join('\t')
  const out: string[] = []
  for (const row of cie.rows) {
    const dv = rgb.get(row[cSid])
    if (!dv) continue
    out.push([dv[0], dv[1], dv[2], ...spec.map((x) => row[x.i])].join('\t'))
  }
  if (out.length === 0) return ''
  return `CGATS.17\nBEGIN_DATA_FORMAT\n${header}\nEND_DATA_FORMAT\nNUMBER_OF_SETS ${out.length}\nBEGIN_DATA\n${out.join('\n')}\nEND_DATA\n`
}

function normalizeReflectance(values: number[]): number[] {
  const max = Math.max(...values)
  return max > 1.5 ? values.map((v) => v / 100) : values
}

export function parseCgats17Text(text: string): CgatsParseResult {
  const cleaned = cleanCgatsText(text)
  const lines = cleaned.split('\n')
  const formatLines = findBlock(lines, 'BEGIN_DATA_FORMAT', 'END_DATA_FORMAT')
  const dataLines = findBlock(lines, 'BEGIN_DATA', 'END_DATA')
  if (formatLines.length === 0 || dataLines.length === 0) {
    return { measurements: [], hasSpectral: false, patchCount: 0 }
  }

  const fields = splitFields(formatLines[0])
  const spectralColumns: { idx: number; wavelength: number }[] = []
  fields.forEach((field, idx) => {
    const wavelength = spectralWavelength(field)
    if (wavelength !== null) spectralColumns.push({ idx, wavelength })
  })
  if (spectralColumns.length === 0) {
    return { measurements: [], hasSpectral: false, patchCount: 0 }
  }

  const rgbRIdx = fields.findIndex((f) => /^RGB_R$/i.test(f))
  const rgbGIdx = fields.findIndex((f) => /^RGB_G$/i.test(f))
  const rgbBIdx = fields.findIndex((f) => /^RGB_B$/i.test(f))
  const sampleIdx = fields.findIndex((f) => /^SAMPLE_ID$/i.test(f))

  const raw = dataLines
    .map((line, row) => {
      const cols = splitFields(line)
      const spectra = normalizeReflectance(spectralColumns.map((c) => Number(cols[c.idx])))
      const r = rgbRIdx >= 0 ? Number(cols[rgbRIdx]) : undefined
      const g = rgbGIdx >= 0 ? Number(cols[rgbGIdx]) : undefined
      const b = rgbBIdx >= 0 ? Number(cols[rgbBIdx]) : undefined
      const explicitId = sampleIdx >= 0 && cols[sampleIdx] ? cols[sampleIdx] : undefined
      // When SAMPLE_ID is absent, encode device values so profiles with different
      // patch counts align by measurement point, not by row order.
      const sampleId =
        explicitId ??
        (r !== undefined && g !== undefined && b !== undefined
          ? `RGB_${Math.round(r)}_${Math.round(g)}_${Math.round(b)}`
          : `P${String(row + 1).padStart(4, '0')}`)
      return { sampleId, r, g, b, spectra }
    })
    .filter((item) => item.spectra.every(Number.isFinite))

  const paper = raw.find((item) => item.r === 255 && item.g === 255 && item.b === 255)
  const paperWP: WhitePointXYZ = paper
    ? spectraToXYZ(paper.spectra, spectralColumns[0]?.wavelength ?? 380)
    : D50_PERFECT_WHITE
  const startWL = spectralColumns[0]?.wavelength ?? 380
  const wavelengths = spectralColumns.map((c) => c.wavelength)

  const measurements: Measurement[] = raw.map((item, _row) => {
    const [X, Y, Z] = spectraToXYZ(item.spectra, startWL)
    const [L, a, bLab] = xyzToLab(X, Y, Z, paperWP)
    const hasRgb = item.r !== undefined && item.g !== undefined && item.b !== undefined
    return {
      SAMPLE_ID: item.sampleId,
      RGB_R: item.r,
      RGB_G: item.g,
      RGB_B: item.b,
      CMYK_C: 0,
      CMYK_M: 0,
      CMYK_Y: 0,
      CMYK_K: 0,
      device: hasRgb ? { space: 'rgb', values: [item.r!, item.g!, item.b!] } : undefined,
      LAB_L: L,
      LAB_A: a,
      LAB_B: bLab,
      spectra: item.spectra,
      wavelengths,
    }
  })

  return {
    measurements,
    hasSpectral: measurements.length > 0 && spectralColumns.length > 0,
    wavelengths,
    patchCount: measurements.length,
  }
}
