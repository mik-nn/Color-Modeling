/**
 * CxF Parser - supports multiple CxF formats per ISO 17972
 * 
 * Supported formats:
 * - CxF/X3 (ISO 17972-3): Output target data with @data blocks
 * - CxF/X4 (ISO 17972-4): Spot color characterization
 * - CxF3 XML: Full XML format with <ColorMeasurements>
 */

export interface ParsedAtData {
  wavelengths: number[]
  spectra: number[]
}

function extractSection(text: string, sectionName: string): string | null {
  const lines = text.split(/\r?\n/)

  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith(sectionName)) {
      start = i
      break
    }
  }
  if (start === -1) return null

  // section body ends at next line starting with "@"
  const bodyStart = start + 1
  let end = lines.length
  for (let i = bodyStart; i < lines.length; i++) {
    if (lines[i].trim().startsWith('@')) {
      end = i
      break
    }
  }

  return lines
    .slice(bodyStart, end)
    .join('\n')
    .trim()
}

function parseNumber(token: string): number | null {
  // allow decimal commas? cxF sometimes uses dot; keep dot strict but tolerant
  const normalized = token.replace(',', '.')
  if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(normalized)) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function parseTwoColumnData(block: string): ParsedAtData | null {
  const wavelengthSpectra: { w: number; s: number }[] = []

  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (const line of lines) {
    // Split on whitespace; ignore comments starting with '#'
    const cleaned = line.replace(/#.*$/, '').trim()
    if (!cleaned) continue

    const parts = cleaned.split(/\s+/)
    if (parts.length < 2) continue

    const w = parseNumber(parts[0])
    const s = parseNumber(parts[1])
    if (w === null || s === null) continue

    wavelengthSpectra.push({ w, s })
  }

  if (wavelengthSpectra.length < 2) return null

  // Sort by wavelength (sometimes they are already ordered)
  wavelengthSpectra.sort((a, b) => a.w - b.w)

  return {
    wavelengths: wavelengthSpectra.map(p => p.w),
    spectra: wavelengthSpectra.map(p => p.s),
  }
}

function parseSingleColumnSpectrum(block: string): ParsedAtData | null {
  const values: number[] = []
  const lines = block.split(/\r?\n/).map(l => l.trim()).filter(Boolean)

  for (const line of lines) {
    const cleaned = line.replace(/#.*$/, '').trim()
    if (!cleaned) continue

    // if the line contains multiple numbers, treat it as two-column only if at least 2 numbers
    const parts = cleaned.split(/\s+/)
    for (const token of parts) {
      const n = parseNumber(token)
      if (n === null) continue
      values.push(n)
    }
  }

  if (values.length < 2) return null

  // if wavelengths are unknown, generate a linear grid assuming 380..730 by default step
  const wavelengths = values.map((_, i) => 380 + i * 10)

  return { wavelengths, spectra: values }
}

export function extractAtDataBlock(text: string): string | null {
  return extractSection(text, '@data')
}

export function extractCxfMeasurements(text: string): string | null {
  // Try XML ColorMeasurements extraction (CxF3 format)
  // <ColorMeasurements>...</ColorMeasurements> blocks
  const cmMatch = text.match(/<ColorMeasurements[^>]*>([\s\S]*?)<\/ColorMeasurements>/i)
  if (cmMatch) return cmMatch[1]
  
  // Also try @data block for CxF/X3 format
  return extractAtDataBlock(text)
}

export function parseAtDataToSpectra(block: string): ParsedAtData | null {
  // Try common formats:
  // 1) two columns: wavelength reflectance
  const twoCol = parseTwoColumnData(block)
  if (twoCol) return twoCol

  // 2) single column reflectance values
  const singleCol = parseSingleColumnSpectrum(block)
  if (singleCol) return singleCol

  return null
}

export function parseCxFTextToSpectra(text: string): ParsedAtData | null {
  const block = extractAtDataBlock(text)
  if (!block) return null
  return parseAtDataToSpectra(block)
}
