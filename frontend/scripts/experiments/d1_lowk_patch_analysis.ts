// D1 low-k patch analysis — WHERE does error concentrate at k=5, and what
// distinguishes the persistent failers (fail @ k=13).
//
// Two questions:
//   (Q1) At k=5, do test patches FAR from the 5 anchors in device space carry
//        the error? (→ sparsity/placement hypothesis: fix anchor coverage, not
//        count.) Bin per-patch ΔE by nearest-anchor device distance + by ink
//        coverage, split by pair class (low-k-only-fail vs always-pass).
//   (Q2) Which 12/104 pairs fail even at k=13, and what do they share?
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/d1_lowk_patch_analysis.ts"

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

const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '')
const cmy = (D: Float64Array, i: number): [number, number, number] =>
  [(255-D[i*3])/255, (255-D[i*3+1])/255, (255-D[i*3+2])/255]

interface Built {
  N: number; X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array; paperRowIdx: number
  sampleIds: string[]; anchorIdx13: number[]; paperWLab: [number,number,number]
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
  // paper-white Lab distance between substrates (OBA-cleaned)
  const lpA = spectraToLab(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const lpB = spectraToLab(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const paperWLab: [number,number,number] = [lpB[0]-lpA[0], lpB[1]-lpA[1], lpB[2]-lpA[2]]
  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, paperRowIdx, sampleIds, anchorIdx13, paperWLab }
}

interface PatchRow { de: number; nnDist: number; ink: number }
function runD1(b: Built, k: number): { rows: PatchRow[]; med: number; p95v: number; pass: boolean; anchorCMY: [number,number,number][] } {
  const anchorIdx = b.anchorIdx13.slice(0, k)
  const anchorSet = new Set(anchorIdx)
  const anchorCMY = anchorIdx.map(ai => cmy(b.D, ai))
  const paperWP = paperWPFromBrightestPatch(new Float64Array(b.X_B_orig.subarray(b.paperRowIdx*L, b.paperRowIdx*L+L)), 1, L, 380)
  const d1 = runPaperRatioResidualTransfer({ X_A: b.X_A_clean, X_B: b.X_B_clean, D: b.D, sampleIds: b.sampleIds,
    anchorIdx, paperRowIdx: b.paperRowIdx, L, paperWP, refProfile: 'A', targetProfile: 'B',
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV })
  const pred = addOBA(d1.X_pred, L, b.fB, b.emB)
  const rows: PatchRow[] = [], des: number[] = []
  for (let i = 0; i < b.N; i++) {
    if (anchorSet.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i*L, i*L+L)))
    const lm = spectraToLab(Array.from(b.X_B_orig.subarray(i*L, i*L+L)))
    const de = deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2])
    const c = cmy(b.D, i)
    let nn = Infinity
    for (const a of anchorCMY) { const dd=(c[0]-a[0])**2+(c[1]-a[1])**2+(c[2]-a[2])**2; if (dd<nn) nn=dd }
    rows.push({ de, nnDist: Math.sqrt(nn), ink: c[0]+c[1]+c[2] })
    des.push(de)
  }
  const med = median(des), p95v = p95(des)
  return { rows, med, p95v, pass: med<=1.5 && p95v<=3.0, anchorCMY }
}

function binStats(rows: PatchRow[], key: 'nnDist'|'ink', edges: number[]): string[] {
  const out: string[] = []
  for (let bI = 0; bI < edges.length-1; bI++) {
    const lo=edges[bI], hi=edges[bI+1]
    const sel = rows.filter(r => r[key]>=lo && r[key]<hi).map(r=>r.de)
    out.push(`[${lo.toFixed(2)},${hi.toFixed(2)}) n=${String(sel.length).padStart(5)} mean=${mean(sel).toFixed(2)} p95=${p95(sel).toFixed(2)}`)
  }
  return out
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

  interface PR { ref:string; tgt:string; mode:string; pass5:boolean; pass13:boolean
    med5:number; p955:number; med13:number; p9513:number; paperWLab:[number,number,number]
    rows5: PatchRow[] }
  const prs: PR[] = []
  for (const [a,b] of pairs) {
    const built = build(a,b); if (!built) continue
    const r5 = runD1(built,5), r13 = runD1(built,13)
    prs.push({ ref:short(a.metadata.full_name), tgt:short(b.metadata.full_name), mode:a.metadata.printMode,
      pass5:r5.pass, pass13:r13.pass, med5:r5.med, p955:r5.p95v, med13:r13.med, p9513:r13.p95v,
      paperWLab:built.paperWLab, rows5:r5.rows })
  }

  // ── Q2: persistent failers (fail @ k=13) ─────────────────────────────────
  const persist = prs.filter(p => !p.pass13)
  console.log(`=== Q2: persistent failers (fail @ k=13): ${persist.length}/${prs.length} = ${(100*persist.length/prs.length).toFixed(1)}% ===`)
  console.log(`  ${'ref→tgt'.padEnd(42)} mode            med13 p95_13  ΔpaperWhite(ΔL,Δa,Δb |ΔE_ab)`)
  for (const p of persist.sort((a,b)=>b.p9513-a.p9513)) {
    const dL=p.paperWLab[0], da=p.paperWLab[1], db=p.paperWLab[2]
    const dEab=Math.sqrt(dL*dL+da*da+db*db)
    console.log(`  ${(p.ref+'→'+p.tgt).padEnd(42)} ${p.mode.padEnd(14)} ${p.med13.toFixed(2)}  ${p.p9513.toFixed(2)}   (${dL.toFixed(1)},${da.toFixed(1)},${db.toFixed(1)} | ${dEab.toFixed(1)})`)
  }

  // substrate frequency among failers
  const freq = new Map<string,number>()
  for (const p of persist) for (const s of [p.ref, p.tgt]) freq.set(s,(freq.get(s)??0)+1)
  console.log('\n  Substrate frequency in persistent failers:')
  for (const [s,c] of [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)) console.log(`    ${s.padEnd(22)} ${c}`)

  // paper-white distance: failers vs passers
  const dEab = (p:PR)=>Math.hypot(p.paperWLab[0],p.paperWLab[1],p.paperWLab[2])
  const pass13 = prs.filter(p=>p.pass13)
  console.log(`\n  Paper-white ΔE_ab (substrate base difference):`)
  console.log(`    persistent failers: median=${median(persist.map(dEab)).toFixed(2)}  max=${Math.max(...persist.map(dEab)).toFixed(2)}`)
  console.log(`    pass@13           : median=${median(pass13.map(dEab)).toFixed(2)}  max=${Math.max(...pass13.map(dEab)).toFixed(2)}`)

  // ── Q1: where does k=5 error concentrate ─────────────────────────────────
  const lowkOnly = prs.filter(p => p.pass13 && !p.pass5)   // degraded purely by anchor count
  const always   = prs.filter(p => p.pass13 && p.pass5)
  console.log(`\n=== Q1: low-k-only failures (pass@13, fail@5): ${lowkOnly.length} pairs ===`)
  console.log(`  these degrade purely from dropping 13→5 anchors. always-pass: ${always.length} pairs.`)

  const distEdges = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 3.0]
  const inkEdges  = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0]
  const lowkRows = lowkOnly.flatMap(p=>p.rows5)
  const alwaysRows = always.flatMap(p=>p.rows5)

  console.log('\n  ΔE@k=5 by NEAREST-ANCHOR device distance (CMY euclid):')
  console.log('    low-k-only-fail pairs:'); for (const s of binStats(lowkRows,'nnDist',distEdges)) console.log('      '+s)
  console.log('    always-pass pairs   :'); for (const s of binStats(alwaysRows,'nnDist',distEdges)) console.log('      '+s)

  console.log('\n  ΔE@k=5 by INK COVERAGE (C+M+Y, 0..3):')
  console.log('    low-k-only-fail pairs:'); for (const s of binStats(lowkRows,'ink',inkEdges)) console.log('      '+s)
  console.log('    always-pass pairs   :'); for (const s of binStats(alwaysRows,'ink',inkEdges)) console.log('      '+s)

  // correlation: ΔE vs nnDist (low-k-only pairs)
  const corr = (xs:number[], ys:number[]) => {
    const mx=mean(xs), my=mean(ys); let sxy=0,sx=0,sy=0
    for (let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my; sxy+=dx*dy; sx+=dx*dx; sy+=dy*dy}
    return sxy/Math.sqrt(sx*sy)
  }
  console.log(`\n  Pearson r(ΔE, nnDist) @k=5 — low-k-only pairs: ${corr(lowkRows.map(r=>r.de),lowkRows.map(r=>r.nnDist)).toFixed(3)}`)
  console.log(`  Pearson r(ΔE, ink)    @k=5 — low-k-only pairs: ${corr(lowkRows.map(r=>r.de),lowkRows.map(r=>r.ink)).toFixed(3)}`)

  // ── what ARE the 5 S1 anchors (coverage)? ────────────────────────────────
  const sample = prs[0]
  const b0 = build(pairs.find(([a,b])=>short(a.metadata.full_name)===sample.ref && short(b.metadata.full_name)===sample.tgt)![0],
                    pairs.find(([a,b])=>short(a.metadata.full_name)===sample.ref && short(b.metadata.full_name)===sample.tgt)![1])!
  const a5 = runD1(b0,5).anchorCMY
  console.log(`\n  S1 k=5 anchor device-CMY (sample ${sample.ref}→${sample.tgt}):`)
  for (const a of a5) console.log(`    (C=${a[0].toFixed(2)} M=${a[1].toFixed(2)} Y=${a[2].toFixed(2)})  ink=${(a[0]+a[1]+a[2]).toFixed(2)}`)
}
main().catch(e => { console.error(e); process.exit(1) })
