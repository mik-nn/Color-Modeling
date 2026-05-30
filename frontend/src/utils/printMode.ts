// src/utils/printMode.ts
//
// Canonical print-mode taxonomy. The canonical mode of a profile is the Epson
// SureColor media preset it was built for (per the MOAB "Media Settings" PDF).
// Both source sets are mapped onto the same preset so profiles can be grouped
// regardless of vendor naming: Breathing Color uses abbreviations
// (CanvasMatte, PLPP260, WCRW…) and MOAB uses Epson-ish names
// (Exh Canvas Matte, Prem Luster, USFA…).

import { ProfileMetadata } from '../types'
import { parseProfileFilename } from './filenameParser'

export type EpsonPreset =
  | 'CanvasMatte'
  | 'CanvasSatin'
  | 'PremiumLuster'
  | 'PremiumGlossy'
  | 'PremiumSemigloss'
  | 'UltrasmoothFineArt'
  | 'VelvetFineArt'
  | 'WatercolorRadiantWhite'
  | 'EnhancedMatte'
  | 'SingleweightMatte'

export const ALL_PRESETS: EpsonPreset[] = [
  'CanvasMatte',
  'CanvasSatin',
  'PremiumLuster',
  'PremiumGlossy',
  'PremiumSemigloss',
  'UltrasmoothFineArt',
  'VelvetFineArt',
  'WatercolorRadiantWhite',
  'EnhancedMatte',
  'SingleweightMatte',
]

// Which of the presets carry profiles from both source sets (BC + MOAB) and are
// therefore comparable cross-vendor.
export const OVERLAPPING_PRESETS: EpsonPreset[] = [
  'CanvasMatte',
  'PremiumLuster',
  'PremiumGlossy',
]

// Token → preset table. Tokens are matched against a space-stripped, lowercased
// print-mode string. Order matters only in that more specific tokens must not be
// shadowed; the tokens here are mutually non-overlapping so any match order works.
const TOKEN_TABLE: Array<{ preset: EpsonPreset; tokens: string[] }> = [
  { preset: 'CanvasMatte', tokens: ['canvasmatte'] }, // "Exh Canvas Matte" → "exhcanvasmatte" contains "canvasmatte"
  { preset: 'CanvasSatin', tokens: ['canvassatin'] },
  { preset: 'PremiumSemigloss', tokens: ['premsemigloss', 'semigloss'] },
  { preset: 'PremiumLuster', tokens: ['premluster', 'plpp'] }, // PLPP260 → "plpp260" contains "plpp"
  { preset: 'PremiumGlossy', tokens: ['premglossy', 'pgpp'] }, // PGPP / PGPP260 → contains "pgpp"
  { preset: 'UltrasmoothFineArt', tokens: ['usfa', 'ultrasmoothfineart'] },
  { preset: 'VelvetFineArt', tokens: ['vfa', 'velvetfineart'] },
  { preset: 'WatercolorRadiantWhite', tokens: ['wcrw', 'watercolorradiantwhite'] },
  { preset: 'EnhancedMatte', tokens: ['emp', 'enhancedmatte'] },
  { preset: 'SingleweightMatte', tokens: ['swm', 'singleweightmatte'] },
]

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Recover the print-mode portion of a filename. MOAB metadata already isolates
// the trailing tokens after the P9000 segment; BC filenames put the mode in the
// last underscore segment, but may carry a numeric offset suffix (e.g.
// "..._PLPP260_-15") that the base parser mistakes for the mode.
function modeStringFromMetadata(meta: ProfileMetadata): string {
  let mode = (meta.printMode ?? '').trim()
  if (mode === '' || /^-?\d+(\.\d+)?$/.test(mode)) {
    // Drop pure-numeric / signed-offset segments and take the last meaningful one.
    const segs = meta.full_name
      .split('_')
      .map((s) => s.trim())
      .filter((s) => s !== '' && !/^-?\d+(\.\d+)?$/.test(s))
    mode = segs[segs.length - 1] ?? ''
  }
  return mode
}

/**
 * Map a profile (filename or parsed metadata) to its canonical Epson media preset.
 * Throws on an unrecognised print mode so unknown media can never be silently
 * grouped into the wrong folder.
 */
export function canonicalPrintMode(input: string | ProfileMetadata): EpsonPreset {
  const meta = typeof input === 'string' ? parseProfileFilename(input) : input
  const mode = normalize(modeStringFromMetadata(meta))
  if (mode === '') {
    throw new Error(`canonicalPrintMode: empty print mode for "${meta.full_name}"`)
  }
  for (const { preset, tokens } of TOKEN_TABLE) {
    if (tokens.some((t) => mode.includes(t))) return preset
  }
  throw new Error(
    `canonicalPrintMode: unrecognised print mode "${mode}" for "${meta.full_name}"`,
  )
}

/** Folder name for a preset (currently identical to the preset id). */
export function presetFolder(preset: EpsonPreset): string {
  return preset
}
