// H44 — do anchor sets transfer across printers, or are they printer-specific?
//
// Hypothesis: printers sharing an ink system (Epson UltraChrome HDX: P9000 + P9900;
// Canon dye: G2470 + G1430) can share the SAME GA-evolved anchor chart, so the dataset
// for selecting anchor coordinates is per-INK-SYSTEM, not per-printer.
//
// Method: evolve a GA k=5 chart on each donor printer's compatible same-mode pairs, then
// evaluate every donor chart on every recipient printer's pairs (transfer matrix). Compare:
//   - native (donor == recipient) = the in-family ceiling
//   - same-ink-system off-diagonal (P9000↔P9900, G2470↔G1430)
//   - cross-ink-system off-diagonal (Epson ↔ Canon) = negative control
//   - COV5 row = universal fixed-chart baseline
// All printers are RGB-addressed → a device-RGB chart maps to each printer's own grid by
// nearest-RGB, so charts are directly portable.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h44_cross_printer_transfer.ts [K]"

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
import { computeSpreadCurv, classifyPairCompatibility, type SpreadCurv } from '../../src/lib/predict/spreadCurv'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const REPO = path.resolve(process.cwd(), '..')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'
const L = 36, D1_RANK = 5, D1_UV = 4
const PALETTE = [0, 32, 64, 96, 128, 160, 192, 224, 255]
const K = Number(process.argv[2] ?? 5)
const POP = 18, GEN = 12, MUT = 0.25, ELITE = 2
const MAX_PAIRS = 80
const EXCLUDE_RE = /Silverada|VibranceMetallic|Metallic|AllureAq/i

interface PrinterDef { id: string; label: string; inkSystem: string; dir: string }
const PRINTERS: PrinterDef[] = [
  { id: 'p9000',  label: 'Epson P9000',  inkSystem: 'epson_hdx',  dir: P9000_DIR },
  { id: 'p9900',  label: 'Epson P9900',  inkSystem: 'epson_hdx',  dir: path.join(REPO, 'data/profiles/stylus-pro-9900') },
  { id: 'g2470',  label: 'Canon G2470',  inkSystem: 'canon_dye',  dir: path.join(REPO, 'data/profiles/Canon G2470') },
  { id: 'g1430',  label: 'Canon G1430',  inkSystem: 'canon_dye',  dir: path.join(REPO, 'data/profiles/G1430') },
]

const median = (xs: number[]) => { const s = [...xs].sort((a,b)=>a-b), m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { const s = [...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.round(0.95*(s.length-1)))] }
function makeRng(seed: number) { let s = seed>>>0; return () => { s = s+0x6D2B79F5|0; let t = Math.imul(s^s>>>15,1|s); t = t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296 } }

type RGB = [number, number, number]
type Genome = RGB[]
type LP = ProfileData & { wavelengths: number[] }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let e: import('node:fs').Dirent[]
  try { e = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const d of e) {
    const f = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walk(f))
    else if (d.isFile() && /\.(icm|icc)$/i.test(d.name) && !d.name.includes(':Zone.Identifier')) out.push(f)
  }
  return out
}

async function loadProfile(fp: string, printerId: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || r.patchCount < 100) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let printMode = printerId
    if (name.startsWith('BC_')) { try { printMode = canonicalPrintMode(name) } catch { /* single-mode */ } }
    return {
      metadata: { full_name: name, brand: 'BC', series: name, printer: printerId, ink: '', substrate: name, parsed_at: new Date().toISOString(), printMode },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.patchCount,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i*10),
    }
  } catch { return null }
}

interface Built {
  N: number; X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array
  paperRowIdx: number; sampleIds: string[]; paperWP: ReturnType<typeof paperWPFromBrightestPatch>
}

function build(pA: LP, pB: LP): Built | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < 100) return null
  const { N, X_A, X_B, D, sampleIds } = al
  let paperRowIdx = 0
  for (let i = 0; i < N; i++) if (D[i*3]===255 && D[i*3+1]===255 && D[i*3+2]===255) { paperRowIdx = i; break }
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)), 1, L, 380)
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, paperWP }
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

function evalPair(b: Built, chart: RGB[]): { pass: boolean; slack: number } {
  const anchorIdx = anchorsFor(b, chart); const aset = new Set(anchorIdx)
  const d1 = runPaperRatioResidualTransfer({ X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds, anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP: b.paperWP, refProfile: 'A', targetProfile: 'B', residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB); const des: number[] = []
  for (let i = 0; i < b.N; i++) {
    if (aset.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i*L, i*L+L))), lm = spectraToLab(Array.from(b.X_B_orig.subarray(i*L, i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]))
  }
  const med = median(des), pp = p95(des)
  return { pass: med<=1.5 && pp<=3.0, slack: Math.max(0,med-1.5)+Math.max(0,pp-3.0) }
}
const passRate = (pairs: Built[], chart: RGB[]) => pairs.length ? pairs.filter(b => evalPair(b, chart).pass).length / pairs.length : 0

function evolve(trainPairs: Built[], rng: () => number): Genome {
  const randPal = () => PALETTE[(rng()*PALETTE.length)|0]
  const randRGB = (): RGB => [randPal(), randPal(), randPal()]
  const randGenome = (): Genome => Array.from({ length: K }, randRGB)
  const crossover = (a: Genome, b: Genome): Genome => a.map((g, i) => rng()<0.5 ? [...g] as RGB : [...b[i]] as RGB)
  const mutate = (g: Genome): Genome => g.map(t => {
    if (rng() < MUT) { const ch = (rng()*3)|0, nt = [...t] as RGB
      if (rng()<0.5) { const cur = PALETTE.indexOf(nt[ch]); nt[ch] = PALETTE[Math.max(0, Math.min(PALETTE.length-1, cur+(rng()<0.5?-1:1)))] } else nt[ch] = randPal()
      return nt }
    return [...t] as RGB
  })
  const slackOf = (pairs: Built[], g: Genome) => { let s = 0; for (const b of pairs) s += evalPair(b, g).slack; return s/Math.max(1,pairs.length) }
  let pop: Genome[] = Array.from({ length: POP }, randGenome)
  let best: { g: Genome; pass: number; slack: number } | null = null
  for (let gen = 0; gen < GEN; gen++) {
    const scored = pop.map(g => ({ g, pass: pairs_pass(trainPairs, g), slack: slackOf(trainPairs, g) })).sort((a, b) => (b.pass-a.pass) || (a.slack-b.slack))
    if (!best || scored[0].pass>best.pass || (scored[0].pass===best.pass && scored[0].slack<best.slack)) best = { g: scored[0].g, pass: scored[0].pass, slack: scored[0].slack }
    const next: Genome[] = scored.slice(0, ELITE).map(s => s.g.map(t => [...t] as RGB))
    const pick = () => { const a = scored[(rng()*POP)|0], b = scored[(rng()*POP)|0]; return (a.pass>b.pass || (a.pass===b.pass && a.slack<b.slack)) ? a.g : b.g }
    while (next.length < POP) next.push(mutate(crossover(pick(), pick())))
    pop = next
  }
  return best!.g
}
const pairs_pass = (pairs: Built[], g: Genome) => { let p = 0; for (const b of pairs) if (evalPair(b, g).pass) p++; return p }
const fmtChart = (g: Genome) => g.map(t => `(${t.join(',')})`).join(' ')
const chartDist = (a: Genome, b: Genome) => { // mean nearest-target RGB distance (symmetric)
  const nn = (x: Genome, y: Genome) => x.reduce((s, t) => s + Math.min(...y.map(u => Math.hypot(t[0]-u[0],t[1]-u[1],t[2]-u[2]))), 0) / x.length
  return (nn(a,b) + nn(b,a)) / 2
}

const COV5: RGB[] = [[255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0]]

async function buildPrinterPairs(pd: PrinterDef): Promise<Built[]> {
  const files = (await walk(pd.dir)).sort().filter(f => !EXCLUDE_RE.test(path.basename(f)))
  const profiles = (await Promise.all(files.map(f => loadProfile(f, pd.id)))).filter(Boolean) as LP[]
  const sc = new Map<number, SpreadCurv | null>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  profiles.forEach((p, i) => { try { sc.set(i, computeSpreadCurv(loadProfileMatrix(p as any))) } catch { sc.set(i, null) } })
  const pairs: Built[] = []
  for (let a = 0; a < profiles.length; a++)
    for (let b = 0; b < profiles.length; b++) {
      if (a === b || profiles[a].metadata.printMode !== profiles[b].metadata.printMode) continue
      // HARD: pair only within the SAME device grid (patch count). Mixing chart
      // grids (e.g. P9900 905-patch M0 ZXML vs 1728-patch M2 CIED+DevD) yields
      // ~99% interpolated alignment (exact matches only at 0/255) → garbage truth.
      if (profiles[a].patch_count !== profiles[b].patch_count) continue
      const scA = sc.get(a), scB = sc.get(b)
      if (scA && scB && classifyPairCompatibility(scA, scB).risk === 'warn') continue
      const built = build(profiles[a], profiles[b])
      if (built) pairs.push(built)
    }
  // cap (deterministic shuffle) to keep GA tractable
  if (pairs.length > MAX_PAIRS) {
    const rng = makeRng(777)
    return pairs.sort(() => rng() - 0.5).slice(0, MAX_PAIRS)
  }
  return pairs
}

async function main() {
  console.log(`H44 cross-printer anchor transfer | K=${K} | metallic/AllureAq/spreadCurv excluded\n`)
  const pairsByPrinter = new Map<string, Built[]>()
  const charts = new Map<string, Genome>()

  for (const pd of PRINTERS) {
    const pairs = await buildPrinterPairs(pd)
    pairsByPrinter.set(pd.id, pairs)
    if (pairs.length < 6) { console.log(`${pd.label}: only ${pairs.length} compatible pairs — chart skipped`); continue }
    const chart = evolve(pairs, makeRng(42))
    charts.set(pd.id, chart)
    console.log(`${pd.label.padEnd(14)} ${String(pairs.length).padStart(3)} pairs | GA chart: ${fmtChart(chart)} | native pass ${(100*passRate(pairs, chart)).toFixed(1)}%`)
  }

  // Transfer matrix: rows = donor chart, cols = recipient printer
  console.log(`\nTransfer matrix — pass% of DONOR chart on RECIPIENT pairs (diag = native):`)
  const ids = PRINTERS.filter(p => charts.has(p.id)).map(p => p.id)
  const head = ['donor\\recip'.padEnd(12), ...ids.map(id => PRINTERS.find(p=>p.id===id)!.label.split(' ')[1].padStart(8))].join(' ')
  console.log(head)
  for (const donor of ids) {
    const row = [PRINTERS.find(p=>p.id===donor)!.label.split(' ')[1].padEnd(12)]
    for (const recip of ids) {
      const pr = passRate(pairsByPrinter.get(recip)!, charts.get(donor)!)
      row.push(`${(100*pr).toFixed(0)}%`.padStart(8))
    }
    console.log(row.join(' '))
  }
  // COV5 reference row
  const covRow = ['COV5(fixed)'.padEnd(12)]
  for (const recip of ids) covRow.push(`${(100*passRate(pairsByPrinter.get(recip)!, COV5)).toFixed(0)}%`.padStart(8))
  console.log(covRow.join(' '))

  // Same- vs cross-ink-system summary
  console.log(`\nInk-system transfer summary (recipient pass, native vs donor-from-same vs cross):`)
  for (const recip of ids) {
    const rp = PRINTERS.find(p=>p.id===recip)!
    const pairs = pairsByPrinter.get(recip)!
    const native = passRate(pairs, charts.get(recip)!)
    const sameSys = ids.filter(d => d!==recip && PRINTERS.find(p=>p.id===d)!.inkSystem===rp.inkSystem)
    const crossSys = ids.filter(d => d!==recip && PRINTERS.find(p=>p.id===d)!.inkSystem!==rp.inkSystem)
    const avg = (ds: string[]) => ds.length ? ds.reduce((s,d)=>s+passRate(pairs, charts.get(d)!),0)/ds.length : NaN
    const cd = sameSys.length ? chartDist(charts.get(recip)!, charts.get(sameSys[0])!) : NaN
    const f = (x:number)=>Number.isNaN(x)?' n/a':`${(100*x).toFixed(0)}%`
    console.log(`  ${rp.label.padEnd(14)} native ${f(native)} | same-system ${f(avg(sameSys))} | cross-system ${f(avg(crossSys))} | chartRGBdist(same)=${Number.isNaN(cd)?'n/a':cd.toFixed(0)}`)
  }
  console.log(`\nRead: if same-system ≈ native and > cross-system → anchors transfer within ink system`)
  console.log(`(datasets per ink-system, not per printer). If same-system << native → printer-specific.`)
}

main().catch(e => { console.error(e); process.exit(1) })
