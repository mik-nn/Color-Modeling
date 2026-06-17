/**
 * cgatsDataset — CGATS.17 export for generateDataset output.
 *
 * Converts GenerateDatasetResult (N×36 predicted spectra + device values)
 * into a CGATS.17 text string. Lab values derived from spectra via D50/2°.
 *
 * Format: SAMPLE_ID, RGB_R/G/B, LAB_L/A/B, SPECTRAL_NM_380 … SPECTRAL_NM_730
 * Reflectance stored as 0–100 % (CGATS convention).
 *
 * @module lib/core/cgatsDataset
 */

import { spectraToLab } from '../colormath'
import type { GenerateDatasetResult } from './generateDataset'

const WLS = Array.from({ length: 36 }, (_, i) => 380 + i * 10)
const L = 36

export interface ExportOptions {
  /** Name tag for the DESCRIPTOR header field (e.g. substrate name). */
  targetName: string
  /** Name of reference profile(s) used — written to ORIGINATOR comment. */
  refName?: string
  /** If true, anchor patches are marked with a trailing '*' in SAMPLE_ID. */
  markAnchors?: boolean
}

/**
 * Convert GenerateDatasetResult to a CGATS.17 text string ready for download.
 */
export function exportDatasetAsCGATS(
  result: GenerateDatasetResult,
  options: ExportOptions,
): string {
  const { predicted, deviceValues, sampleIds, anchorIdx } = result
  const N = sampleIds.length
  const anchorSet = new Set(anchorIdx)

  const fields = [
    'SAMPLE_ID',
    'RGB_R', 'RGB_G', 'RGB_B',
    'LAB_L', 'LAB_A', 'LAB_B',
    ...WLS.map((wl) => `SPECTRAL_NM_${wl}`),
  ]

  const header = [
    'CGATS.17',
    `ORIGINATOR\t"Color-ModelingETL${options.refName ? ` / ref: ${options.refName}` : ''}"`,
    `DESCRIPTOR\t"Predicted substrate dataset - ${options.targetName}"`,
    `CREATED\t"${new Date().toISOString().slice(0, 10)}"`,
    `NUMBER_OF_FIELDS\t${fields.length}`,
    'BEGIN_DATA_FORMAT',
    fields.join('\t'),
    'END_DATA_FORMAT',
    `NUMBER_OF_SETS\t${N}`,
    'BEGIN_DATA',
  ]

  const rows: string[] = []
  for (let i = 0; i < N; i++) {
    const spec = Array.from(predicted.subarray(i * L, i * L + L))
    const lab = spectraToLab(spec)
    const r = deviceValues[i * 3]
    const g = deviceValues[i * 3 + 1]
    const b = deviceValues[i * 3 + 2]
    const id = options.markAnchors && anchorSet.has(i)
      ? `${sampleIds[i]}*`
      : sampleIds[i]

    const row: string[] = [
      id,
      r.toFixed(0), g.toFixed(0), b.toFixed(0),
      lab[0].toFixed(4), lab[1].toFixed(4), lab[2].toFixed(4),
      ...spec.map((v) => (v * 100).toFixed(4)),
    ]
    rows.push(row.join('\t'))
  }

  return [...header, ...rows, 'END_DATA'].join('\n')
}

/**
 * Trigger browser download of a CGATS string as a .txt file.
 * Only works in browser context — do not call from Node.
 */
export function downloadDatasetCGATS(
  result: GenerateDatasetResult,
  options: ExportOptions,
): void {
  const cgats = exportDatasetAsCGATS(result, options)
  const filename = `${options.targetName.replace(/[^a-zA-Z0-9_-]/g, '_')}_predicted.txt`
  const blob = new Blob([cgats], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
