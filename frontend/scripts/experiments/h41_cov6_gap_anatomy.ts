// H41 — cov6→S1-12 gap anatomy: which profile pairs fail at coverage-6 but
// pass at S1-12, and what distinguishes them.
//
// Splits the 104 non-metallic same-mode pairs into:
//   ALWAYS  = pass@cov6 AND pass@S1-12
//   FLIP    = fail@cov6 AND pass@S1-12   ← the +6-anchor beneficiaries
//   FAIL    = fail@S1-12                  (structural ceiling, ~12 pairs)
// then compares features: spreadCurv dCurv, paper L*/b* gap, and per-ink-tercile
// ΔE at cov6 (where the failure concentrates) + the cov6→S1-12 improvement.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h41_cov6_gap_anatomy.ts"

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
import { computeSpreadCurv, classifyPairCompatibility } from '../../src/lib/predict/spreadCurv'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, D1_RANK = 5, D1_UV = 4
const METALLIC_RE = /Silverada|VibranceMetallic/i

const COV6: Array<[number,number,number]> = [
  [255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0],[128,128,128],
]

const median = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN

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
function coverageAnchors(b: Built, targets: Array<[number,number,number]>): number[] {
  const chosen: number[] = []
  for (const [tr,tg,tb] of targets) {
    let best=-1,bestD=Infinity
    for (let i=0;i<b.N;i++){ const dd=(b.D[i*3]-tr)**2+(b.D[i*3+1]-tg)**2+(b.D[i*3+2]-tb)**2; if(dd<bestD){bestD=dd;best=i} }
    if (best>=0 && !chosen.includes(best)) chosen.push(best)
  }
  return chosen
}
interface Detail { med: number; p95: number; pass: boolean; deByTercile: [number[],number[],number[]] }
function evalD1(b: Built, anchorIdx: number[]): Detail {
  const anchorSet = new Set(anchorIdx)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(b.X_B_orig.subarray(b.paperRowIdx*L, b.paperRowIdx*L+L)), 1, L, 380)
  const d1 = runPaperRatioResidualTransfer({ X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds,
    anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP, refProfile:'A', targetProfile:'B',
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB)
  const des: number[] = []
  const ter: [number[],number[],number[]] = [[],[],[]]
  for (let i=0;i<b.N;i++){ if(anchorSet.has(i))continue
    const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))), lm=spectraToLab(Array.from(b.X_B_orig.subarray(i*L,i*L+L)))
    const de=deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]); des.push(de)
    const a=(765-b.D[i*3]-b.D[i*3+1]-b.D[i*3+2])/765
    ter[a<0.34?0:a<0.67?1:2].push(de) }
  return { med: median(des), p95: p95(des), pass: median(des)<=1.5 && p95(des)<=3.0, deByTercile: ter }
}
function paperLab(b: Built, X: Float64Array): [number,number,number] {
  return spectraToLab(Array.from(X.subarray(b.paperRowIdx*L, b.paperRowIdx*L+L))) as [number,number,number]
}

interface Row {
  nameA: string; nameB: string; mode: string
  med6: number; p956: number; med12: number; p9512: number
  pass6: boolean; pass12: boolean
  dCurv: number; dPaperL: number; dPaperB: number
  light6: number; mid6: number; heavy6: number
  light12: number; mid12: number; heavy12: number
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (await Promise.all(files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  // pre-compute spreadCurv per profile
  const curv = new Map<string, ReturnType<typeof computeSpreadCurv>>()
  for (const p of profiles) { try { curv.set(p.metadata.full_name, computeSpreadCurv(loadProfileMatrix(p as any))) } catch { curv.set(p.metadata.full_name, null) } }

  const pairs: Array<[LP,LP]> = []
  for (const a of profiles) for (const b of profiles) {
    if (a===b || a.metadata.printMode!==b.metadata.printMode) continue
    const nA=a.metadata.full_name, nB=b.metadata.full_name
    if (nA.includes('AllureAq')||nB.includes('AllureAq')) continue
    if (METALLIC_RE.test(nA)||METALLIC_RE.test(nB)) continue
    pairs.push([a,b])
  }
  console.log(`Non-metallic same-mode pairs: ${pairs.length}\n`)

  const rows: Row[] = []
  for (const [pA,pB] of pairs) {
    const b = build(pA,pB); if (!b) continue
    const a6 = coverageAnchors(b, COV6)
    const a12 = b.anchorIdx13.slice(0,12)
    const d6 = evalD1(b, a6), d12 = evalD1(b, a12)
    const cA = curv.get(pA.metadata.full_name), cB = curv.get(pB.metadata.full_name)
    const dCurv = (cA && cB) ? classifyPairCompatibility(cA, cB).dCurv : NaN
    const lpA = paperLab(b, b.X_B_orig) // target paper (B)
    // ref paper via A_orig not stored; recompute from clean+oba is messy — use spreadCurv paper proxy skipped.
    rows.push({
      nameA: pA.metadata.full_name.replace(/^BC_/,'').replace(/_P9000.*/,''),
      nameB: pB.metadata.full_name.replace(/^BC_/,'').replace(/_P9000.*/,''),
      mode: pA.metadata.printMode!,
      med6:d6.med, p956:d6.p95, med12:d12.med, p9512:d12.p95,
      pass6:d6.pass, pass12:d12.pass, dCurv,
      dPaperL: lpA[0], dPaperB: lpA[2],
      light6:median(d6.deByTercile[0]), mid6:median(d6.deByTercile[1]), heavy6:median(d6.deByTercile[2]),
      light12:median(d12.deByTercile[0]), mid12:median(d12.deByTercile[1]), heavy12:median(d12.deByTercile[2]),
    })
  }

  const ALWAYS = rows.filter(r=>r.pass6 && r.pass12)
  const FLIP   = rows.filter(r=>!r.pass6 && r.pass12)
  const FAIL   = rows.filter(r=>!r.pass12)
  const pc=(n:number)=>`${n} (${(100*n/rows.length).toFixed(1)}%)`
  console.log(`Pairs evaluated: ${rows.length}`)
  console.log(`  pass@cov6  : ${pc(rows.filter(r=>r.pass6).length)}`)
  console.log(`  pass@S1-12 : ${pc(rows.filter(r=>r.pass12).length)}`)
  console.log(`  ALWAYS (pass6 & pass12): ${pc(ALWAYS.length)}`)
  console.log(`  FLIP   (fail6 & pass12): ${pc(FLIP.length)}   ← +6-anchor beneficiaries`)
  console.log(`  FAIL   (fail12)        : ${pc(FAIL.length)}\n`)

  console.log('=== FLIP pairs (fail@cov6 → pass@S1-12) ===')
  console.log('ref → target  [mode]            med6  p95_6   med12 p95_12  dCurv  heavy6→heavy12')
  for (const r of FLIP.sort((a,b)=>b.heavy6-a.heavy6)) {
    console.log(`${(r.nameA+' → '+r.nameB).padEnd(32)}${r.mode.slice(0,8).padEnd(9)} ${r.med6.toFixed(2)} ${r.p956.toFixed(2).padStart(5)}  ${r.med12.toFixed(2).padStart(5)} ${r.p9512.toFixed(2).padStart(5)}  ${(r.dCurv||0).toFixed(3)}  ${r.heavy6.toFixed(2)}→${r.heavy12.toFixed(2)}`)
  }

  const feat = (g: Row[], k: keyof Row) => mean(g.map(r=>r[k] as number).filter(x=>!Number.isNaN(x)))
  console.log('\n=== Feature means per category ===')
  console.log('group   n    dCurv   paperB  | ΔE@cov6: light  mid   heavy | ΔE@S1-12: light  mid   heavy')
  for (const [nm,g] of [['ALWAYS',ALWAYS],['FLIP',FLIP],['FAIL',FAIL]] as Array<[string,Row[]]>) {
    console.log(`${nm.padEnd(7)} ${String(g.length).padEnd(4)} ${feat(g,'dCurv').toFixed(3)}  ${feat(g,'dPaperB').toFixed(2).padStart(6)}  |        ${feat(g,'light6').toFixed(2)}  ${feat(g,'mid6').toFixed(2)}  ${feat(g,'heavy6').toFixed(2)} |          ${feat(g,'light12').toFixed(2)}  ${feat(g,'mid12').toFixed(2)}  ${feat(g,'heavy12').toFixed(2)}`)
  }
  console.log('\nNote: paperB = target B paper b* (yellowness); dCurv = |spreadCurv560(A)-spreadCurv560(B)|.')
}

main().catch(e => { console.error(e); process.exit(1) })
