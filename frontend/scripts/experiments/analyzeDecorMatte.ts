// frontend/scripts/experiments/analyzeDecorMatte.ts
//
// One-shot diagnostic: what makes DecorMatte so distinct from the rest of the
// Canvas Matte cluster, and from the dataset overall? Loads all CanvasMatte
// profiles + a wider pool, prints per-paper OBA-band reflectance, OBA emission
// peak, and z-scores so the distinguishing dimension is obvious.
//
// Run: cd frontend && npx tsx scripts/experiments/analyzeDecorMatte.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { spectraToLab } from '../../src/lib/colormath'
import { detectOBA } from '../../src/lib/predict/oba'
import { extractOBAEmission } from '../../src/lib/predict/obaSeparator'
import { canonicalPrintMode } from '../../src/utils/printMode'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')

interface Row {
  name: string
  preset: string
  paperLab: [number, number, number]
  R380: number
  R410: number
  R440: number
  R550: number
  obaScore: number
  obaPeakAmp: number
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (/\.(icm|icc)$/i.test(e.name)) out.push(full)
  }
  return out
}

async function loadRow(filePath: string): Promise<Row | null> {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
  const paper = r.measurements.find(
    (m) => m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
  )
  if (!paper?.spectra) return null
  const s = paper.spectra
  const idx = (wl: number) => Math.round((wl - 380) / 10)
  const oba = detectOBA(s)
  const ext = extractOBAEmission(s)
  const base = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
  return {
    name: base,
    preset: canonicalPrintMode(base),
    paperLab: spectraToLab(s),
    R380: s[idx(380)],
    R410: s[idx(410)],
    R440: s[idx(440)],
    R550: s[idx(550)],
    obaScore: oba.score,
    obaPeakAmp: ext.peakAmplitude,
  }
}

function zscore(xs: number[]): number[] {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length
  const sd = Math.sqrt(v) || 1
  return xs.map((x) => (x - m) / sd)
}

function fmt(x: number, d = 3): string {
  return x.toFixed(d)
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const rows: Row[] = []
  for (const f of files) {
    try {
      const r = await loadRow(f)
      if (r) rows.push(r)
    } catch {
      /* skip */
    }
  }
  console.log(`Loaded ${rows.length} profiles\n`)

  // ── Canvas Matte focus ──
  const cm = rows.filter((r) => r.preset === 'CanvasMatte')
  console.log('=== Canvas Matte cluster (per-paper OBA-band reflectance) ===')
  console.log(
    'profile'.padEnd(45) +
      'L*    a*    b*     R380  R410  R440  R550  OBAscore OBApeak',
  )
  for (const r of cm) {
    console.log(
      r.name.padEnd(45) +
        `${fmt(r.paperLab[0], 2).padStart(6)} ${fmt(r.paperLab[1], 2).padStart(5)} ${fmt(r.paperLab[2], 2).padStart(6)}  ` +
        `${fmt(r.R380).padStart(5)} ${fmt(r.R410).padStart(5)} ${fmt(r.R440).padStart(5)} ${fmt(r.R550).padStart(5)}  ` +
        `${fmt(r.obaScore).padStart(7)}  ${fmt(r.obaPeakAmp, 4).padStart(6)}`,
    )
  }

  console.log('\nZ-scores within Canvas Matte cluster (how extreme is each paper):')
  const dims: Array<{ key: keyof Row; label: string }> = [
    { key: 'R380', label: 'R380' },
    { key: 'R410', label: 'R410' },
    { key: 'R440', label: 'R440' },
    { key: 'obaScore', label: 'OBAscore' },
    { key: 'obaPeakAmp', label: 'OBApeak' },
  ]
  const zCols: Record<string, number[]> = {}
  for (const d of dims) zCols[d.label] = zscore(cm.map((r) => r[d.key] as number))
  console.log('profile'.padEnd(45) + dims.map((d) => d.label.padStart(9)).join(''))
  for (let i = 0; i < cm.length; i++) {
    console.log(
      cm[i].name.padEnd(45) +
        dims.map((d) => fmt(zCols[d.label][i], 2).padStart(9)).join(''),
    )
  }

  // ── Dataset-wide rank by OBA score ──
  console.log('\n=== Dataset-wide ranking by OBA strength ===')
  const ranked = [...rows].sort((a, b) => b.obaScore - a.obaScore)
  console.log('rank profile'.padEnd(50) + 'preset                R380   OBAscore  OBApeak')
  for (let i = 0; i < Math.min(10, ranked.length); i++) {
    const r = ranked[i]
    console.log(
      `${(i + 1).toString().padStart(3)}. ${r.name.padEnd(45)} ${r.preset.padEnd(22)} ${fmt(r.R380).padStart(5)} ${fmt(r.obaScore).padStart(8)}  ${fmt(r.obaPeakAmp, 4)}`,
    )
  }

  // ── DecorMatte cross-OBA pair impact (worst-case ratio at 380) ──
  const dm = rows.find((r) => /DecorMatte/.test(r.name))
  if (dm) {
    console.log('\n=== Paper-ratio at 380 nm: DecorMatte vs other CanvasMatte papers ===')
    console.log('(D1 paper-ratio = R_target/R_ref at 380 nm — explosive at OBA boundary)')
    for (const other of cm.filter((c) => c.name !== dm.name)) {
      const fwd = other.R380 / dm.R380
      const back = dm.R380 / other.R380
      console.log(
        `  DecorMatte → ${other.name.padEnd(40)} ratio=${fmt(fwd, 2)} (other→DM: ${fmt(back, 2)})`,
      )
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
