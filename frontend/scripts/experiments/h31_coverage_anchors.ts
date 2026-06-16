// H31 — Coverage-spanning anchors fix D1's low-k collapse.
//
// Diagnostic (d1_lowk_patch_analysis) showed D1's k=5 error is ink-coverage-
// driven: the S1 k=5 set {paper, red, green, blue, cyan} has NO anchor at
// ink=3 (full CMY) and one primary, so the heavy-ink corner is extrapolated.
// H31 replaces those corners with a COVERAGE-SPANNING set that anchors every
// gamut direction at low AND high coverage:
//   targets (RGB) = white(ink0), cyan/magenta/yellow primaries(ink1),
//                   black(ink3), mid-gray(ink1.5)
// nearest available patch per target, deduped.
//
// Isolation of placement vs count:
//   S1 k=5  (baseline, ~45%)   S1 k=6 (count control)   H31 cov k≈6 (test)
//   S1 k=13 (ceiling, 88.5%)
// Gate H31a: H31 cov ≥ 75%.   Gate H31b: the 12 persistent failers stay failing.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h31_coverage_anchors.ts"

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
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, D1_RANK = 5, D1_UV = 4
const METALLIC_RE = /Silverada|VibranceMetallic/i

// Coverage-spanning anchor targets in RGB device space.
const COV_TARGETS: Array<[number, number, number]> = [
  [255, 255, 255], // white  ink 0
  [0, 255, 255],   // cyan    ink 1
  [255, 0, 255],   // magenta ink 1
  [255, 255, 0],   // yellow  ink 1
  [0, 0, 0],       // black   ink 3 (full CMY)
  [128, 128, 128], // mid-gray ink 1.5
]

const median = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let e: import('node:fs').Dirent[]
  try { e = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const d of e) { const f = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walk(f)); else if (d.isFile() && /\.(icm|icc)$/i.test(d.name)) out.push(f) }
  return out
}

type LP = ProfileData & { wavelengths: number[] }
async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let preset: string; try { preset = canonicalPrintMode(name) } catch { return null }
    return { metadata: { full_name: name, brand: 'BC', series: name, printer: 'P9000', ink: 'mk',
        substrate: name, parsed_at: new Date().toISOString(), printMode: preset },
      raw: r.measurements, clean: r.measurements, has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10) }
  } catch { return null }
}
const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '')

interface Built {
  N: number; X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array; paperRowIdx: number
  sampleIds: string[]; anchorIdx13: number[]
}
function build(pA: LP, pB: LP): Built | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < 100) return null
  const { N, X_A, X_B, D, sampleIds, wavelengths } = al
  const wl = wavelengths ?? Array.from({ length: L }, (_, i) => 380 + i * 10)
  let paperRowIdx = 0
  for (let i = 0; i < N; i++) if (D[i*3]===255 && D[i*3+1]===255 && D[i*3+2]===255) { paperRowIdx = i; break }
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx), fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission), X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: wl, sampleIds, droppedCount: 0 }
  const anchorIdx13 = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, 13)
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, anchorIdx13 }
}

// nearest patch index to each coverage target (RGB euclid), deduped.
function coverageAnchors(b: Built): number[] {
  const chosen: number[] = []
  for (const [tr, tg, tb] of COV_TARGETS) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < b.N; i++) {
      const dd = (b.D[i*3]-tr)**2 + (b.D[i*3+1]-tg)**2 + (b.D[i*3+2]-tb)**2
      if (dd < bestD) { bestD = dd; best = i }
    }
    if (best >= 0 && !chosen.includes(best)) chosen.push(best)
  }
  return chosen
}

function evalD1(b: Built, anchorIdx: number[]): { med: number; p95v: number; pass: boolean } {
  const anchorSet = new Set(anchorIdx)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(b.X_B_orig.subarray(b.paperRowIdx*L, b.paperRowIdx*L+L)), 1, L, 380)
  const d1 = runPaperRatioResidualTransfer({ X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds,
    anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP, refProfile: 'A', targetProfile: 'B',
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB)
  const des: number[] = []
  for (let i = 0; i < b.N; i++) {
    if (anchorSet.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i*L, i*L+L)))
    const lm = spectraToLab(Array.from(b.X_B_orig.subarray(i*L, i*L+L)))
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95v = p95(des)
  return { med, p95v, pass: med<=1.5 && p95v<=3.0 }
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (await Promise.all(files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const pairs: Array<[LP,LP]> = []
  for (const a of profiles) for (const b of profiles) {
    if (a===b || a.metadata.printMode!==b.metadata.printMode) continue
    const nA=a.metadata.full_name, nB=b.metadata.full_name
    if (nA.includes('AllureAq')||nB.includes('AllureAq')) continue
    if (METALLIC_RE.test(nA)||METALLIC_RE.test(nB)) continue
    pairs.push([a,b])
  }
  console.log(`Non-metallic same-mode pairs: ${pairs.length}\n`)

  const PERSIST = new Set([
    'VibranceLuster→RiverStoneSatinRag','RiverStoneSatinRag→VibranceLuster',
    '1930→ArtPeelBlckt','ArtPeelBlckt→1930',
    'DecorMatte→ChromataWhite','ChromataWhite→DecorMatte','DecorMatte→800M','800M→DecorMatte',
    'DecorMatte→Lyve','Lyve→DecorMatte','DecorMatte→BelgianLinen','BelgianLinen→DecorMatte',
  ])

  interface Row { key:string; s5:boolean; s6:boolean; cov:boolean; s13:boolean; covN:number
    covMed:number; covP95:number; persist:boolean }
  const rows: Row[] = []
  let covSizes: number[] = []
  for (const [a,b] of pairs) {
    const built = build(a,b); if (!built) continue
    const key = `${short(a.metadata.full_name)}→${short(b.metadata.full_name)}`
    const cov = coverageAnchors(built); covSizes.push(cov.length)
    const s5 = evalD1(built, built.anchorIdx13.slice(0,5))
    const s6 = evalD1(built, built.anchorIdx13.slice(0,6))
    const cv = evalD1(built, cov)
    const s13 = evalD1(built, built.anchorIdx13.slice(0,13))
    rows.push({ key, s5:s5.pass, s6:s6.pass, cov:cv.pass, s13:s13.pass, covN:cov.length,
      covMed:cv.med, covP95:cv.p95v, persist:PERSIST.has(key) })
  }

  const n = rows.length
  const pct = (f:(r:Row)=>boolean) => `${rows.filter(f).length}/${n} = ${(100*rows.filter(f).length/n).toFixed(1)}%`
  console.log(`Coverage anchor-set size: median=${median(covSizes)} (targets=6, deduped)\n`)
  console.log('=== Pass rates ===')
  console.log(`  S1 k=5  (baseline)          : ${pct(r=>r.s5)}`)
  console.log(`  S1 k=6  (count control)     : ${pct(r=>r.s6)}`)
  console.log(`  H31 coverage k≈6 (test)     : ${pct(r=>r.cov)}`)
  console.log(`  S1 k=13 (ceiling)           : ${pct(r=>r.s13)}`)

  console.log('\n=== Gate H31a: H31 coverage ≥ 75% ===')
  const covRate = 100*rows.filter(r=>r.cov).length/n
  console.log(`  ${covRate.toFixed(1)}% → ${covRate>=75?'PASS':'FAIL'}`)

  console.log('\n=== Gate H31b: 12 persistent failers stay failing under coverage ===')
  const persistRows = rows.filter(r=>r.persist)
  const stillFail = persistRows.filter(r=>!r.cov).length
  console.log(`  ${stillFail}/${persistRows.length} persistent failers still fail under H31 coverage`)
  for (const r of persistRows.sort((a,b)=>b.covP95-a.covP95))
    console.log(`    ${r.key.padEnd(42)} cov: med=${r.covMed.toFixed(2)} p95=${r.covP95.toFixed(2)} ${r.cov?'PASS(!)':'fail'}`)

  console.log('\n=== Placement vs count (pairs gained by coverage over S1 k=6) ===')
  const gained = rows.filter(r=>r.cov && !r.s6)
  const lost   = rows.filter(r=>!r.cov && r.s6)
  console.log(`  coverage-only pass: ${gained.length}   S1k6-only pass: ${lost.length}   net: ${gained.length-lost.length}`)
}
main().catch(e => { console.error(e); process.exit(1) })
