// H44 Experiment B — GA-evolved chart placement per printer
//
// For each printer, run GA to find the optimal k=8 RGB chart (unreachable
// ceiling) and compare the evolved placements across the printer ladder.
// Hypothesis B: optimal placement differs by gamut/ink set.
//
// Uses sampled pairs (MAX_PAIRS = 60 per printer) and a lightweight GA
// (POP=20, GEN=15). Results are qualitative — chart comparison, not
// a deployable generalization number (in-sample evolution).
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h44_placement_per_printer.ts [K]"

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
import type { ProfileData } from '../../src/types'

const REPO = path.resolve(process.cwd(), '..')
const MANIFEST_PATH = path.join(REPO, 'data', 'h44_manifest.json')
const P9000_DIR = '/mnt/e/PET/LinkedInPosts/surecolor-p9000'

const L = 36, D1_RANK = 5, D1_UV = 4
const K    = Number(process.argv[2] ?? 8)
const POP  = 20
const GEN  = 15
const MUT  = 0.25
const ELITE = 2
const MAX_PAIRS = 60

const PALETTE = [0, 32, 64, 96, 128, 160, 192, 224, 255]

type RGB = [number, number, number]
type Genome = RGB[]

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))] }
const randPal = () => PALETTE[(Math.random() * PALETTE.length) | 0]
const randRGB = (): RGB => [randPal(), randPal(), randPal()]

interface ManifestEntry { printer: string; file: string; substrate: string; patchCount: number; hasSpectral: boolean; parseError?: string }
type LP = ProfileData & { wavelengths: number[]; _file: string }

const PRINTER_DEF: Record<string, { label: string; inkCount: number; dir: string }> = {
  canon_g2470:      { label: 'Canon G2470',        inkCount: 4,  dir: path.join(REPO, 'data/profiles/Canon G2470') },
  canon_g1430:      { label: 'Canon G1430',         inkCount: 4,  dir: path.join(REPO, 'data/profiles/G1430') },
  epson_p9000:      { label: 'Epson P9000',         inkCount: 10, dir: P9000_DIR },
  epson_p9900:      { label: 'Epson P9900',         inkCount: 11, dir: path.join(REPO, 'data/profiles/stylus-pro-9900') },
  canon_ipf4100:    { label: 'Canon iPF4100',       inkCount: 12, dir: path.join(REPO, 'data/profiles/ipf-pro-4100/extracted') },
  canon_ipf8100_bc: { label: 'Canon iPF8100 (BC)',  inkCount: 12, dir: path.join(REPO, 'data/profiles/ipf8100') },
  canon_ipf8100_moab: { label: 'Canon iPF8100 (MOAB)', inkCount: 12, dir: path.join(REPO, 'data/profiles/Canon+imagePROGRAF+iPF8100+MOAB+ICC+Profiles/Canon iPF8100 MOAB Profiles') },
}

async function loadProfile(fp: string, printerId: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || r.patchCount < 50) return null
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
  N: number; X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array
  paperRowIdx: number; sampleIds: string[]; paperWP: ReturnType<typeof paperWPFromBrightestPatch>
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

function evalChart(b: Built, anchorIdx: number[]): { pass: boolean; slack: number } {
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
  const pass = med <= 1.5 && pp <= 3.0
  const slack = Math.max(0, med - 1.5) + Math.max(0, pp - 3.0)
  return { pass, slack }
}

function fitness(built: Built[], chart: RGB[]): number {
  let pass = 0; let totalSlack = 0
  for (const b of built) {
    const ai = anchorsFor(b, chart)
    const { pass: p, slack } = evalChart(b, ai)
    if (p) pass++
    totalSlack += slack
  }
  return pass - 0.05 * (totalSlack / built.length)
}

function crossover(a: Genome, b: Genome): Genome {
  return a.map((g, i) => Math.random() < 0.5 ? [...g] as RGB : [...b[i]] as RGB)
}

function mutate(g: Genome): Genome {
  return g.map(t => {
    if (Math.random() < MUT) return randRGB()
    return t.map(v => Math.random() < MUT ? randPal() : v) as RGB
  })
}

function tournamentSelect(pop: Genome[], fits: number[]): Genome {
  const a = (Math.random() * pop.length) | 0
  const b = (Math.random() * pop.length) | 0
  return fits[a] >= fits[b] ? pop[a] : pop[b]
}

// Characterize chart: coverage breakdown (white/primary/secondary/interior)
function charterizeChart(chart: RGB[]): { whites: number; primaries: number; secondaries: number; interior: number; rgbStr: string } {
  let whites = 0, primaries = 0, secondaries = 0, interior = 0
  for (const [r, g, b] of chart) {
    const v = [r, g, b]
    const hi = v.filter(x => x >= 200).length
    const lo = v.filter(x => x <= 55).length
    if (hi === 3) { whites++; continue }
    if (lo === 3) { primaries++; continue }  // black = CMY primary at 100%
    if (hi === 2 && lo === 1) { primaries++; continue }  // CMY primaries (two high, one low)
    if (hi === 1 && lo === 2) { secondaries++; continue } // RGB secondaries (one high, two low)
    if (lo === 2) { secondaries++; continue }
    interior++
  }
  const rgbStr = chart.map(([r, g, b]) => `(${r},${g},${b})`).join(' ')
  return { whites, primaries, secondaries, interior, rgbStr }
}

async function runGAForPrinter(printerId: string, entries: ManifestEntry[]): Promise<{
  label: string; inkCount: number; nPairs: number; bestChart: RGB[]
  bestFitness: number; bestPassRate: number; chartStats: ReturnType<typeof charterizeChart>
} | null> {
  const def = PRINTER_DEF[printerId]
  if (!def) return null
  const spectral = entries.filter(e => e.hasSpectral)
  const profs: LP[] = []
  for (const e of spectral) {
    const fp = path.join(def.dir, e.file)
    const p = await loadProfile(fp, printerId)
    if (p) profs.push(p)
  }
  if (profs.length < 2) return null

  // Sample pairs
  const allIdxPairs: [number, number][] = []
  for (let i = 0; i < profs.length; i++) for (let j = 0; j < profs.length; j++) if (i !== j) allIdxPairs.push([i, j])
  const stride = Math.max(1, Math.floor(allIdxPairs.length / MAX_PAIRS))
  const sampledPairs = allIdxPairs.filter((_, idx) => idx % stride === 0).slice(0, MAX_PAIRS)
  const pairs: Built[] = []
  for (const [i, j] of sampledPairs) { const b = buildPair(profs[i], profs[j]); if (b) pairs.push(b) }
  if (pairs.length === 0) return null

  console.log(`  ${def.label}: ${profs.length} profiles, ${pairs.length} pairs`)

  // Seed: white + CMY primaries + neutrals
  const seed: Genome = [[255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0],[128,128,128],[64,64,64],[192,192,192]]
  let pop: Genome[] = [seed.slice(0, K) as Genome]
  while (pop.length < POP) pop.push(Array.from({ length: K }, randRGB) as Genome)
  let fits = pop.map(g => fitness(pairs, g))
  let bestIdx = fits.indexOf(Math.max(...fits))
  let bestChart = pop[bestIdx]
  let bestFit = fits[bestIdx]
  const passAtK = (chart: RGB[]) => pairs.filter(b => evalChart(b, anchorsFor(b, chart)).pass).length

  for (let gen = 0; gen < GEN; gen++) {
    const elite = pop
      .map((g, i) => ({ g, f: fits[i] }))
      .sort((a, b) => b.f - a.f)
      .slice(0, ELITE)
      .map(x => x.g)
    const next: Genome[] = [...elite]
    while (next.length < POP) {
      const a = tournamentSelect(pop, fits)
      const b = tournamentSelect(pop, fits)
      next.push(mutate(crossover(a, b)))
    }
    pop = next
    fits = pop.map(g => fitness(pairs, g))
    const bi = fits.indexOf(Math.max(...fits))
    if (fits[bi] > bestFit) { bestFit = fits[bi]; bestChart = pop[bi] }
  }

  const bestPassRate = passAtK(bestChart) / pairs.length
  const chartStats = charterizeChart(bestChart)
  console.log(`  → best k=${K} pass=${(100 * bestPassRate).toFixed(0)}%  ${chartStats.rgbStr}`)

  return { label: def.label, inkCount: def.inkCount, nPairs: pairs.length, bestChart, bestFitness: bestFit, bestPassRate, chartStats }
}

async function main() {
  const manifest: ManifestEntry[] = JSON.parse(await fs.readFile(MANIFEST_PATH, 'utf8'))
  const byPrinter = new Map<string, ManifestEntry[]>()
  for (const e of manifest) {
    if (!byPrinter.has(e.printer)) byPrinter.set(e.printer, [])
    byPrinter.get(e.printer)!.push(e)
  }

  console.log(`H44 Experiment B — GA k=${K} placement per printer (POP=${POP}, GEN=${GEN})\n`)

  const results: Awaited<ReturnType<typeof runGAForPrinter>>[] = []
  for (const [printerId, entries] of byPrinter) {
    if (!PRINTER_DEF[printerId]) continue
    const r = await runGAForPrinter(printerId, entries)
    results.push(r)
  }

  const valid = results.filter(Boolean) as NonNullable<typeof results[0]>[]
  valid.sort((a, b) => a.inkCount - b.inkCount)

  console.log('\n=== Comparison table ===\n')
  console.log('Printer'.padEnd(28) + 'Inks  Pairs  Pass%  White  Prim  Sec  Interior')
  console.log('-'.repeat(75))
  for (const r of valid) {
    const { whites, primaries, secondaries, interior } = r.chartStats
    console.log(r.label.padEnd(28) + String(r.inkCount).padStart(4) + String(r.nPairs).padStart(7) + `  ${(100*r.bestPassRate).toFixed(0).padStart(4)}%`
      + String(whites).padStart(7) + String(primaries).padStart(6) + String(secondaries).padStart(5) + String(interior).padStart(10))
  }

  console.log('\n=== Evolved charts (RGB targets) ===\n')
  for (const r of valid) {
    console.log(`${r.label} (${r.inkCount} inks, k=${K}, pass=${(100*r.bestPassRate).toFixed(0)}%):`)
    console.log(`  ${r.chartStats.rgbStr}`)
  }

  // Hypothesis B verdict
  const allCharts = valid.map(r => r.bestChart)
  if (allCharts.length >= 2) {
    // Mean pairwise distance between corresponding RGB targets across printers
    const dye = valid.filter(r => r.inkCount <= 5)
    const pigment = valid.filter(r => r.inkCount >= 10)
    if (dye.length && pigment.length) {
      const dyeInterior = dye.reduce((s, r) => s + r.chartStats.interior, 0) / dye.length
      const pigInterior = pigment.reduce((s, r) => s + r.chartStats.interior, 0) / pigment.length
      console.log(`\nHypothesis B — interior points: dye=${dyeInterior.toFixed(1)} vs pigment=${pigInterior.toFixed(1)}`)
      console.log(pigInterior > dyeInterior ? '  → Pigment uses more interior points (H-B CONFIRMED direction)' : '  → No clear difference by ink type (H-B unclear)')
    }
  }

  const outPath = path.join(REPO, 'data', 'h44_experiment_b.json')
  await fs.writeFile(outPath, JSON.stringify({ date: '2026-06-20', k: K, pop: POP, gen: GEN, results: valid }, null, 2))
  console.log(`\nSaved → ${outPath}`)
}

main().catch(e => { console.error(e); process.exit(1) })
