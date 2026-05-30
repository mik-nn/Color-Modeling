// frontend/scripts/exportCaeData.ts
//
// One-shot TS → JSON exporter for the Python CAE training pipeline.
//
// Reads all P9000 ICC/ICM profiles from the local sample directories, filters
// by optional CAE_PRINT_MODE / CAE_INK_MODE, parses each via the existing TS pipeline
// (iccTagScanner → cxfParser → ICM extractor), and writes a single
// profiles-mk.json file consumed by python/cae/dataset.py.
//
// Run: cd frontend && npx tsx scripts/exportCaeData.ts
//
// The output file is large (~10 MB) and gitignored. Re-run whenever you
// load a new MK substrate into the sample directory.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

// jsdom polyfill — cxfParser uses DOMParser which only exists in browsers.
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../src/lib/parsers/icmParser'
import { parseProfileFilename } from '../src/utils/filenameParser'

// Profiles now live in per-Epson-preset subfolders under data/profiles/ (see
// scripts/reorgByMode.ts), so discovery is a recursive walk rather than a fixed
// list of directories.
const PROFILES_ROOT =
  process.env.CAE_PROFILE_DIR ?? path.resolve(process.cwd(), '../data/profiles')
const OUT_DIR = path.resolve(process.cwd(), 'data/cae-input')
const OUT_FILE = path.join(OUT_DIR, 'profiles-mk.json')
const PRINT_MODE_FILTER = process.env.CAE_PRINT_MODE
const INK_MODE_FILTER = process.env.CAE_INK_MODE

interface ExportedPatch {
  sample_id: string
  rgb: [number, number, number]
  spectrum: number[] // length 36, 380..730 nm @ 10 nm
}

interface ExportedProfile {
  full_name: string
  substrate: string
  ink_mode: 'mk' | 'pk' | 'unknown'
  print_mode: string
  paper_idx: number // row index of paper anchor (RGB = 255,255,255)
  paper_spectrum: number[] // length 36
  patches: ExportedPatch[]
  wavelength_start_nm: number
  wavelength_step_nm: number
}

function inkMode(filename: string): 'mk' | 'pk' | 'unknown' {
  if (/_mk_|_MK_/i.test(filename)) return 'mk'
  if (/_pk_|_PK_/i.test(filename)) return 'pk'
  return 'unknown'
}

function substrate(filename: string): string {
  const base = filename.replace(/^.*\//, '').replace(/\.(icm|icc)$/i, '')
  // BC_<series>_P9000_<mk|pk>_<substrate>
  const parts = base.split('_')
  return parts[parts.length - 1] || 'unknown'
}

function profileLabel(filename: string): string {
  return filename.replace(/^.*\//, '').replace(/\.(icm|icc)$/i, '')
}

async function exportProfile(filePath: string): Promise<ExportedProfile | null> {
  const buf = await fs.readFile(filePath)
  const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // Construct a minimal File-like object that parseIcmFile accepts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fakeFile = { arrayBuffer: async () => arrayBuffer } as any
  const result = await parseIcmFile(fakeFile)
  if (!result.hasSpectral) {
    console.warn(`[skip] ${filePath} — no spectral data`)
    return null
  }

  // Find paper anchor (RGB exactly 255,255,255 with spectrum).
  const paperIdx = result.measurements.findIndex(
    (m) => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
  )
  if (paperIdx < 0) {
    console.warn(`[skip] ${filePath} — no paper anchor (255,255,255 with spectrum)`)
    return null
  }
  const paperSpec = result.measurements[paperIdx].spectra!
  const startWL = result.measurements[paperIdx].wavelengths?.[0] ?? 380
  const step = result.measurements[paperIdx].wavelengths
    ? result.measurements[paperIdx].wavelengths![1] - result.measurements[paperIdx].wavelengths![0]
    : 10

  const patches: ExportedPatch[] = []
  for (const m of result.measurements) {
    if (!m.spectra) continue
    if (m.RGB_R === undefined || m.RGB_G === undefined || m.RGB_B === undefined) continue
    if (m.spectra.length !== paperSpec.length) continue
    patches.push({
      sample_id: m.SAMPLE_ID,
      rgb: [m.RGB_R, m.RGB_G, m.RGB_B],
      spectrum: m.spectra,
    })
  }

  const filename = path.basename(filePath)
  const metadata = parseProfileFilename(filename)
  return {
    full_name: profileLabel(filename),
    substrate: metadata.substrate || substrate(filename),
    ink_mode: inkMode(filename),
    print_mode: metadata.printMode || substrate(filename),
    paper_idx: patches.findIndex((p) => p.rgb[0] === 255 && p.rgb[1] === 255 && p.rgb[2] === 255),
    paper_spectrum: paperSpec,
    patches,
    wavelength_start_nm: startWL,
    wavelength_step_nm: step,
  }
}

async function walkProfiles(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out // optional local source directory
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...(await walkProfiles(full)))
    } else if (e.name.toLowerCase().endsWith('.icm') || e.name.toLowerCase().endsWith('.icc')) {
      out.push(full)
    }
  }
  return out
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })
  const icms = await walkProfiles(PROFILES_ROOT)
  icms.sort()

  console.log(`Found ${icms.length} ICC/ICM files`)
  if (PRINT_MODE_FILTER) console.log(`Filtering print_mode=${PRINT_MODE_FILTER}`)
  if (INK_MODE_FILTER) console.log(`Filtering ink_mode=${INK_MODE_FILTER}`)

  const mkProfiles: ExportedProfile[] = []
  for (const fp of icms) {
    const mode = inkMode(fp)
    const metadata = parseProfileFilename(path.basename(fp))
    if (INK_MODE_FILTER && mode !== INK_MODE_FILTER) continue
    if (!INK_MODE_FILTER && mode !== 'mk' && mode !== 'unknown') continue
    if (PRINT_MODE_FILTER && metadata.printMode !== PRINT_MODE_FILTER) continue
    console.log(`Parsing ${path.basename(fp)}`)
    try {
      const exported = await exportProfile(fp)
      if (exported) mkProfiles.push(exported)
    } catch (e) {
      console.error(`[error] ${fp}:`, e instanceof Error ? e.message : e)
    }
  }

  console.log(`\nParsed ${mkProfiles.length} MK profiles with spectral data.`)
  const totalPatches = mkProfiles.reduce((s, p) => s + p.patches.length, 0)
  console.log(`Total patches: ${totalPatches}`)

  const payload = {
    schema_version: 1,
    source_dirs: [PROFILES_ROOT],
    print_mode_filter: PRINT_MODE_FILTER ?? null,
    ink_mode_filter: INK_MODE_FILTER ?? null,
    exported_at: new Date().toISOString(),
    profile_count: mkProfiles.length,
    profiles: mkProfiles,
  }
  await fs.writeFile(OUT_FILE, JSON.stringify(payload))
  const bytes = (await fs.stat(OUT_FILE)).size
  console.log(`\nWrote ${OUT_FILE} (${(bytes / 1024 / 1024).toFixed(2)} MB)`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
