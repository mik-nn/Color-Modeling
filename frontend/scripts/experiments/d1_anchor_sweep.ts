// D1 anchor-count sweep — pass rate at k=5/8/13 on 104 non-metallic same-mode
// pairs. Answers "what is D1 at fewer anchors" for the H22/H28/H29 comparison
// (those report k=5/8/13; D1 was only logged at k=13=88.5% in H27).
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/d1_anchor_sweep.ts"

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
const K_LIST = [5, 8, 13]

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

function evalPair(pA: LP, pB: LP, k: number): { med: number; p95v: number; pass: boolean } | null {
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
  const XA_c = subtractOBA(X_A, L, fA, emA.emission), XB_c = subtractOBA(X_B, L, fB, emB.emission)
  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: wl, sampleIds, droppedCount: 0 }
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, k)
  const anchorSet = new Set(anchorIdx)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)), 1, L, 380)
  const d1 = runPaperRatioResidualTransfer({ X_A: XA_c, X_B: XB_c, D, sampleIds, anchorIdx,
    paperRowIdx, L, paperWP, refProfile: pA.metadata.full_name, targetProfile: pB.metadata.full_name,
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV })
  const X_pred_abs = addOBA(d1.X_pred, L, fB, emB.emission)
  const des: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const lp = spectraToLab(Array.from(X_pred_abs.subarray(i*L, i*L+L)))
    const lm = spectraToLab(Array.from(X_B.subarray(i*L, i*L+L)))
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95v = p95(des)
  return { med, p95v, pass: med <= 1.5 && p95v <= 3.0 }
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (await Promise.all(files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  console.log(`BC profiles: ${profiles.length}`)
  const pairs: Array<[LP, LP]> = []
  for (const a of profiles) for (const b of profiles) {
    if (a === b || a.metadata.printMode !== b.metadata.printMode) continue
    const nA = a.metadata.full_name, nB = b.metadata.full_name
    if (nA.includes('AllureAq') || nB.includes('AllureAq')) continue
    if (METALLIC_RE.test(nA) || METALLIC_RE.test(nB)) continue
    pairs.push([a, b])
  }
  console.log(`Non-metallic same-mode pairs: ${pairs.length}\n`)
  for (const k of K_LIST) {
    let pass = 0, total = 0; const meds: number[] = [], p95s: number[] = []
    for (const [a, b] of pairs) {
      const r = evalPair(a, b, k); if (!r) continue
      total++; if (r.pass) pass++; meds.push(r.med); p95s.push(r.p95v)
    }
    console.log(`  D1 k=${k}: pass=${pass}/${total} (${(100*pass/total).toFixed(1)}%)  med=${median(meds).toFixed(3)}  P95(pairmed)=${median(p95s).toFixed(3)}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
