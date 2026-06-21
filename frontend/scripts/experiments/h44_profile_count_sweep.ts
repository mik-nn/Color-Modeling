// H44 (correct) — From HOW MANY profiles must the GA select the anchor-point set?
//
// The deployable method is GA-evolved anchor placement (evolved 5 beats manual 12,
// article §"Why Patch Selection Matters More Than Count"). The GA evolves a fixed
// device-RGB chart by optimizing D1 pass-count over same-mode pairs. Those pairs
// come from N measured profiles. Question: what is the minimum N such that the
// GA-selected chart, evaluated on a FIXED held-out pair set, still generalizes?
//
// Design:
//   - One printer pool (default P9000), exclusions applied: metallic + AllureAq +
//     spreadCurv-incompatible pairs (classifyPairCompatibility 'warn', dCurv≥0.137).
//   - Fix a held-out TEST pair set (30% of all compatible same-mode pairs), constant
//     across the whole sweep.
//   - Sweep N = number of profiles the GA may draw training pairs from. Training pairs
//     = remaining 70% pairs whose BOTH endpoints fall in the first N profiles.
//   - GA evolves a k-patch chart on those training pairs; the frozen best chart is
//     evaluated on the FIXED test pairs. Genome is substrate-agnostic device-RGB, so
//     leakage from a profile being on both sides is 2nd-order (article CV note).
//   - REPS random profile-orderings per N → mean ± spread.
//   - Output: test pass-rate vs N → the plateau N answers the question.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h44_profile_count_sweep.ts [K] [PRINTER]"

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
const PRINTER = (process.argv[3] ?? 'p9000') as 'p9000' | 'g2470'
const POP = 20, GEN = 14, MUT = 0.25, ELITE = 2
const REPS = 3
const N_LIST = [2, 3, 4, 6, 8, 12, 16, 20]
const TEST_FRAC = 0.30

// HARD RULE: metallic + AllureAq excluded from the population entirely.
const EXCLUDE_RE = /Silverada|VibranceMetallic|Metallic|AllureAq/i

const DIRS: Record<string, string> = {
  p9000: P9000_DIR,
  g2470: path.join(REPO, 'data/profiles/Canon G2470'),
}

const median = (xs: number[]) => { const s = [...xs].sort((a,b)=>a-b), m = s.length>>1; return s.length%2 ? s[m] : (s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { const s = [...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.round(0.95*(s.length-1)))] }

// deterministic PRNG (mulberry32)
function makeRng(seed: number) {
  let s = seed >>> 0
  return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s>>>15, 1|s); t = t + Math.imul(t ^ t>>>7, 61|t) ^ t; return ((t ^ t>>>14) >>> 0) / 4294967296 }
}

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

async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || r.patchCount < 100) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    // Epson BC names carry a print mode; Canon single-mode → use printer id.
    let printMode = PRINTER
    if (name.startsWith('BC_')) { try { printMode = canonicalPrintMode(name) as never } catch { /* single-mode */ } }
    return {
      metadata: { full_name: name, brand: 'BC', series: name, printer: PRINTER, ink: '', substrate: name, parsed_at: new Date().toISOString(), printMode },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.patchCount,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i*10),
    }
  } catch { return null }
}

interface Built {
  N: number; X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array
  paperRowIdx: number; sampleIds: string[]; paperWP: ReturnType<typeof paperWPFromBrightestPatch>
  ai: number; bi: number  // profile indices (for N-subset filtering)
}

function build(pA: LP, pB: LP, ai: number, bi: number): Built | null {
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
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, paperWP, ai, bi }
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

function score(pairs: Built[], chart: RGB[]): number {
  let pass = 0
  for (const b of pairs) if (evalPair(b, chart).pass) pass++
  return pass
}
function passRate(pairs: Built[], chart: RGB[]): number { return pairs.length ? score(pairs, chart) / pairs.length : 0 }

// GA on a fixed training set → returns best chart found.
function evolve(trainPairs: Built[], rng: () => number): Genome {
  const randPal = () => PALETTE[(rng()*PALETTE.length)|0]
  const randRGB = (): RGB => [randPal(), randPal(), randPal()]
  const randGenome = (): Genome => Array.from({ length: K }, randRGB)
  const crossover = (a: Genome, b: Genome): Genome => a.map((g, i) => rng()<0.5 ? [...g] as RGB : [...b[i]] as RGB)
  const mutate = (g: Genome): Genome => g.map(t => {
    if (rng() < MUT) {
      const ch = (rng()*3)|0, nt = [...t] as RGB
      if (rng()<0.5) { const cur = PALETTE.indexOf(nt[ch]); nt[ch] = PALETTE[Math.max(0, Math.min(PALETTE.length-1, cur+(rng()<0.5?-1:1)))] }
      else nt[ch] = randPal()
      return nt
    }
    return [...t] as RGB
  })
  const slackOf = (pairs: Built[], g: Genome) => { let s = 0; for (const b of pairs) s += evalPair(b, g).slack; return s/Math.max(1,pairs.length) }

  let pop: Genome[] = Array.from({ length: POP }, randGenome)
  let best: { g: Genome; pass: number; slack: number } | null = null
  for (let gen = 0; gen < GEN; gen++) {
    const scored = pop.map(g => ({ g, pass: score(trainPairs, g), slack: slackOf(trainPairs, g) })).sort((a, b) => (b.pass-a.pass) || (a.slack-b.slack))
    if (!best || scored[0].pass>best.pass || (scored[0].pass===best.pass && scored[0].slack<best.slack)) best = { g: scored[0].g, pass: scored[0].pass, slack: scored[0].slack }
    const next: Genome[] = scored.slice(0, ELITE).map(s => s.g.map(t => [...t] as RGB))
    const pick = () => { const a = scored[(rng()*POP)|0], b = scored[(rng()*POP)|0]; return (a.pass>b.pass || (a.pass===b.pass && a.slack<b.slack)) ? a.g : b.g }
    while (next.length < POP) next.push(mutate(crossover(pick(), pick())))
    pop = next
  }
  return best!.g
}

const COV5: RGB[] = [[255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0]]

async function main() {
  const dir = DIRS[PRINTER]
  const files = (await walk(dir)).sort().filter(f => !EXCLUDE_RE.test(path.basename(f)))
  const profiles = (await Promise.all(files.map(loadProfile))).filter(Boolean) as LP[]
  console.log(`H44 profile-count sweep | printer=${PRINTER} K=${K} | ${profiles.length} profiles (metallic/AllureAq excluded)`)

  // spreadCurv per profile (pair compatibility filter)
  const sc = new Map<number, SpreadCurv | null>()
  profiles.forEach((p, i) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { sc.set(i, computeSpreadCurv(loadProfileMatrix(p as any))) } catch { sc.set(i, null) }
  })

  // Build ALL compatible same-mode pairs once (cache alignment+OBA).
  const allPairs: Built[] = []
  let scWarn = 0
  for (let a = 0; a < profiles.length; a++)
    for (let b = 0; b < profiles.length; b++) {
      if (a === b || profiles[a].metadata.printMode !== profiles[b].metadata.printMode) continue
      // HARD: same device grid only — mixing 905/1728 chart grids gives ~99% interpolated alignment.
      if (profiles[a].patch_count !== profiles[b].patch_count) continue
      const scA = sc.get(a), scB = sc.get(b)
      if (scA && scB && classifyPairCompatibility(scA, scB).risk === 'warn') { scWarn++; continue }
      const built = build(profiles[a], profiles[b], a, b)
      if (built) allPairs.push(built)
    }
  console.log(`compatible same-mode pairs: ${allPairs.length} (spreadCurv-warn dropped: ${scWarn})\n`)
  if (allPairs.length < 10) { console.log('Too few pairs — aborting.'); return }

  // Fixed held-out TEST set: 30% of pairs, chosen once (seed 12345), constant across sweep.
  const splitRng = makeRng(12345)
  const order = allPairs.map((_, i) => i).sort(() => splitRng() - 0.5)
  const nTest = Math.max(5, Math.round(allPairs.length * TEST_FRAC))
  const testIdx = new Set(order.slice(0, nTest))
  const testPairs = allPairs.filter((_, i) => testIdx.has(i))
  const trainCandidates = allPairs.filter((_, i) => !testIdx.has(i))
  const covBaseline = passRate(testPairs, COV5)
  console.log(`held-out TEST pairs: ${testPairs.length} | train-candidate pairs: ${trainCandidates.length}`)
  console.log(`baseline COV5 on TEST: ${(100*covBaseline).toFixed(1)}%\n`)

  console.log('N_profiles  trainPairs(mean)  GA test pass% (mean [min..max] over reps)')
  const results: { N: number; mean: number; min: number; max: number; trainMean: number }[] = []

  for (const N of N_LIST) {
    if (N > profiles.length) continue
    const reps: number[] = []
    let trainPairCountSum = 0
    for (let rep = 0; rep < REPS; rep++) {
      const rng = makeRng(1000 + rep*7 + N*131)
      // pick N profiles at random; training pairs = candidate pairs with BOTH endpoints in the subset
      const idxs = profiles.map((_, i) => i).sort(() => rng() - 0.5).slice(0, N)
      const subset = new Set(idxs)
      const trainPairs = trainCandidates.filter(p => subset.has(p.ai) && subset.has(p.bi))
      trainPairCountSum += trainPairs.length
      if (trainPairs.length === 0) { reps.push(NaN); continue }
      const chart = evolve(trainPairs, rng)
      reps.push(passRate(testPairs, chart))
    }
    const valid = reps.filter(x => !Number.isNaN(x))
    const mean = valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : NaN
    const min = valid.length ? Math.min(...valid) : NaN
    const max = valid.length ? Math.max(...valid) : NaN
    const trainMean = trainPairCountSum / REPS
    results.push({ N, mean, min, max, trainMean })
    const fmtPct = (x: number) => Number.isNaN(x) ? '  n/a' : `${(100*x).toFixed(1)}%`
    console.log(
      String(N).padStart(10),
      trainMean.toFixed(1).padStart(16),
      `   ${fmtPct(mean)} [${fmtPct(min)}..${fmtPct(max)}]`
    )
  }

  // Plateau detection: first N whose mean is within 3pp of the best mean.
  const best = Math.max(...results.map(r => r.mean).filter(x => !Number.isNaN(x)))
  const plateau = results.find(r => !Number.isNaN(r.mean) && r.mean >= best - 0.03)
  console.log(`\nbest GA test pass = ${(100*best).toFixed(1)}%; COV5 baseline = ${(100*covBaseline).toFixed(1)}%`)
  console.log(`PLATEAU at N = ${plateau?.N ?? 'n/a'} profiles (within 3pp of best).`)
  console.log(`→ ANSWER: select the anchor set from ≈${plateau?.N ?? '?'} profiles of this printer to match the GA ceiling.`)

  await fs.writeFile(
    path.join(REPO, 'data', `h44_profile_count_${PRINTER}_k${K}.json`),
    JSON.stringify({ printer: PRINTER, K, testPairs: testPairs.length, covBaseline, results, plateauN: plateau?.N ?? null }, null, 2),
  )
}

main().catch(e => { console.error(e); process.exit(1) })
