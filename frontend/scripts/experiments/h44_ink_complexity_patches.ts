// H44 Experiment A — minimum k vs printer ink complexity
//
// For each printer: build all same-printer substrate pairs, evaluate colorant
// chart anchors at k=5,6,8,12 (+ k=16 for 12-ink printers). Record H4 pass
// rate (median ΔE00 ≤ 1.5, P95 ≤ 3.0) and minimum k to clear the gate.
//
// Hypothesis A: min-k increases with physical ink complexity.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h44_ink_complexity_patches.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer
import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles } from '../../src/lib/dataset/matrix'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA } from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { colorantChart } from '../../src/lib/sampling/colorantChart'
import type { ProfileData } from '../../src/types'

const REPO = path.resolve(process.cwd(), '..')
const MANIFEST_PATH = path.join(REPO, 'data', 'h44_manifest.json')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'

const L = 36
const D1_RANK = 5
const D1_UV = 4

type RGB = [number, number, number]
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))] }

interface ManifestEntry {
  printer: string
  file: string
  substrate: string
  patchCount: number
  hasSpectral: boolean
  wavelengthCount: number
  parseError?: string
}

// Printer definitions (from manifest + spec)
const PRINTER_DEF: Record<string, { label: string; inkCount: number; inkType: string; dir: string; kSizes: (5|6|8|12|16)[] }> = {
  canon_g2470:     { label: 'Canon G2470',        inkCount: 4,  inkType: 'dye',     dir: path.join(REPO, 'data/profiles/Canon G2470'),   kSizes: [5,6,8,12] },
  canon_g1430:     { label: 'Canon G1430',         inkCount: 4,  inkType: 'dye',     dir: path.join(REPO, 'data/profiles/G1430'),          kSizes: [5,6,8,12] },
  epson_p9000:     { label: 'Epson P9000',         inkCount: 10, inkType: 'pigment', dir: P9000_DIR,                                       kSizes: [5,6,8,12] },
  epson_p9900:     { label: 'Epson P9900',         inkCount: 11, inkType: 'pigment', dir: path.join(REPO, 'data/profiles/stylus-pro-9900'), kSizes: [5,6,8,12] },
  canon_ipf4100:   { label: 'Canon iPF4100',       inkCount: 12, inkType: 'pigment', dir: path.join(REPO, 'data/profiles/ipf-pro-4100/extracted'), kSizes: [5,6,8,12,16] },
  canon_ipf8100_bc:{ label: 'Canon iPF8100 (BC)',  inkCount: 12, inkType: 'pigment', dir: path.join(REPO, 'data/profiles/ipf8100'),        kSizes: [5,6,8,12,16] },
  canon_ipf8100_moab:{ label: 'Canon iPF8100 (MOAB)', inkCount: 12, inkType: 'pigment', dir: path.join(REPO, 'data/profiles/Canon+imagePROGRAF+iPF8100+MOAB+ICC+Profiles/Canon iPF8100 MOAB Profiles'), kSizes: [5,6,8,12,16] },
}

type LP = ProfileData & { wavelengths: number[]; _file: string }

async function loadProfile(fp: string, printerId: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || r.patchCount < 100) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    return {
      metadata: { full_name: name, brand: 'BC', series: name, printer: printerId, ink: '', substrate: name, parsed_at: new Date().toISOString(), printMode: printerId },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.patchCount,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
      _file: fp,
    }
  } catch { return null }
}

interface Built {
  N: number
  X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array
  paperRowIdx: number; sampleIds: string[]
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>
  name: string
}

function buildPair(pA: LP, pB: LP): Built | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < 50) return null
  const { N, X_A, X_B, D, sampleIds } = al
  let paperRowIdx = 0
  for (let i = 0; i < N; i++) if (D[i*3] === 255 && D[i*3+1] === 255 && D[i*3+2] === 255) { paperRowIdx = i; break }
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)), 1, L, 380)
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, paperWP,
    name: `${pA.metadata.full_name} → ${pB.metadata.full_name}` }
}

function anchorsFor(b: Built, chart: RGB[]): number[] {
  const chosen: number[] = []
  for (const [tr, tg, tb] of chart) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < b.N; i++) {
      const dd = (b.D[i*3]-tr)**2 + (b.D[i*3+1]-tg)**2 + (b.D[i*3+2]-tb)**2
      if (dd < bestD) { bestD = dd; best = i }
    }
    if (best >= 0 && !chosen.includes(best)) chosen.push(best)
  }
  return chosen
}

function evalChart(b: Built, anchorIdx: number[]): { pass: boolean; med: number; pp: number } {
  const aset = new Set(anchorIdx)
  const d1 = runPaperRatioResidualTransfer({
    X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds,
    anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP: b.paperWP,
    refProfile: 'A', targetProfile: 'B', residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV,
  })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB)
  const des: number[] = []
  for (let i = 0; i < b.N; i++) {
    if (aset.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i*L, i*L+L)))
    const lm = spectraToLab(Array.from(b.X_B_orig.subarray(i*L, i*L+L)))
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), pp = p95(des)
  return { pass: med <= 1.5 && pp <= 3.0, med, pp }
}

interface PrinterResult {
  printerId: string
  label: string
  inkCount: number
  inkType: string
  nFiles: number
  nPairs: number
  kResults: { k: number; passRate: number; medMed: number; medP95: number }[]
  minK: number | null
}

async function processPrinter(
  printerId: string,
  entries: ManifestEntry[],
): Promise<PrinterResult | null> {
  const def = PRINTER_DEF[printerId]
  if (!def) return null

  console.log(`\n=== ${def.label} (${def.inkCount} inks, ${def.inkType}) ===`)
  const spectral = entries.filter(e => e.hasSpectral)
  console.log(`  Files with spectral: ${spectral.length}/${entries.length}`)

  // Load profiles
  const profs: LP[] = []
  for (const e of spectral) {
    const fp = path.join(def.dir, e.file)
    const p = await loadProfile(fp, printerId)
    if (p) profs.push(p)
    else console.log(`  SKIP ${e.file}`)
  }
  console.log(`  Loaded: ${profs.length}/${spectral.length}`)

  if (profs.length < 2) {
    console.log('  Not enough profiles — skip')
    return null
  }

  // Sample pairs (deterministic shuffle to keep total ≤ MAX_PAIRS)
  const MAX_PAIRS = 100
  const allIdxPairs: [number, number][] = []
  for (let i = 0; i < profs.length; i++)
    for (let j = 0; j < profs.length; j++)
      if (i !== j) allIdxPairs.push([i, j])
  // Deterministic sample: stride through the list
  const stride = Math.max(1, Math.floor(allIdxPairs.length / MAX_PAIRS))
  const sampledPairs = allIdxPairs.filter((_, idx) => idx % stride === 0).slice(0, MAX_PAIRS)

  const pairs: Built[] = []
  for (const [i, j] of sampledPairs) {
    const b = buildPair(profs[i], profs[j])
    if (b) pairs.push(b)
  }
  console.log(`  Pairs built: ${pairs.length} (sampled from ${allIdxPairs.length})`)

  if (pairs.length === 0) return null

  // Evaluate each k
  const kResults: PrinterResult['kResults'] = []
  for (const k of def.kSizes) {
    const chart = colorantChart(k)
    let passCount = 0; const meds: number[] = [], pps: number[] = []
    for (const b of pairs) {
      const ai = anchorsFor(b, chart)
      const res = evalChart(b, ai)
      if (res.pass) passCount++
      meds.push(res.med); pps.push(res.pp)
    }
    const passRate = passCount / pairs.length
    const medMed = median(meds)
    const medP95 = median(pps)
    kResults.push({ k, passRate, medMed, medP95 })
    console.log(`  k=${k}: pass=${passCount}/${pairs.length} (${(100*passRate).toFixed(0)}%)  med=${medMed.toFixed(2)}  P95=${medP95.toFixed(2)}`)
  }

  // min-k = smallest k where passRate ≥ 50%
  const minK = kResults.find(r => r.passRate >= 0.50)?.k ?? null

  return {
    printerId, label: def.label, inkCount: def.inkCount, inkType: def.inkType,
    nFiles: profs.length, nPairs: pairs.length, kResults, minK,
  }
}

async function main() {
  const manifest: ManifestEntry[] = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))

  // Group by printer
  const byPrinter = new Map<string, ManifestEntry[]>()
  for (const e of manifest) {
    if (!byPrinter.has(e.printer)) byPrinter.set(e.printer, [])
    byPrinter.get(e.printer)!.push(e)
  }

  const results: PrinterResult[] = []
  for (const [printerId, entries] of byPrinter) {
    if (!PRINTER_DEF[printerId]) continue
    const r = await processPrinter(printerId, entries)
    if (r) results.push(r)
  }

  // Summary table
  console.log('\n\n=== H44 Experiment A — min-k vs ink complexity ===\n')
  console.log('Printer'.padEnd(28) + 'Inks  Type      Files  Pairs   k=5   k=6   k=8  k=12  k=16  minK')
  console.log('-'.repeat(100))

  // Sort by inkCount
  results.sort((a, b) => a.inkCount - b.inkCount || a.label.localeCompare(b.label))

  const pct = (r: { passRate: number }) => `${(100 * r.passRate).toFixed(0).padStart(3)}%`

  for (const r of results) {
    const def = PRINTER_DEF[r.printerId]
    let line = r.label.padEnd(28) + String(r.inkCount).padStart(4) + '  ' + r.inkType.padEnd(8)
      + String(r.nFiles).padStart(5) + String(r.nPairs).padStart(7) + '  '
    for (const k of [5, 6, 8, 12, 16]) {
      const kr = r.kResults.find(x => x.k === k)
      line += (kr ? pct(kr) : ' N/A').padStart(6)
    }
    line += '  ' + (r.minK ? `k=${r.minK}` : 'none')
    console.log(line)
  }

  // Save results
  const outPath = path.join(REPO, 'data', 'h44_experiment_a.json')
  await fs.writeFile(outPath, JSON.stringify({ date: '2026-06-20', results }, null, 2))
  console.log(`\nSaved → ${outPath}`)

  // Hypothesis A verdict
  const pigmentResults = results.filter(r => r.inkType === 'pigment' && r.minK)
  if (pigmentResults.length >= 2) {
    const sorted = [...pigmentResults].sort((a, b) => a.inkCount - b.inkCount)
    const minKTrend = sorted.map(r => r.minK!)
    const increasing = minKTrend.every((v, i) => i === 0 || v >= minKTrend[i-1])
    console.log(`\nHypothesis A (pigment printers): min-k trend = ${minKTrend.join(' → ')} → ${increasing ? 'CONFIRMED ✓' : 'NOT confirmed ✗'}`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
