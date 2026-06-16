// H27 ablation — quantify D1 Layer-3 (IDW local residual) contribution.
//
// D1 has three layers:
//   1. paper-ratio (global multiplicative)
//   2. PCA residual basis (rank-5) fit at non-paper anchors
//   3. IDW interpolation of residual scores in RGB device space (LOCAL)
//
// H26 found H22 mean_delta (a GLOBAL residual) provides zero unique coverage
// vs D1. Hypothesis: D1's edge over H22 IS Layer 3. This script disables
// Layer 3 (`globalResidual: true` → every patch gets the MEAN anchor residual,
// i.e. global like H22) and measures the pass-rate drop on 104 non-metallic
// same-mode pairs, with a spotlight on the 3 D1-only pairs from H26.
//
// Run: bash -l -c "nvm use 20 && cd frontend && npx tsx scripts/experiments/h27_layer3_ablation.ts"

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
const MIN_MATCH   = 100
const L           = 36
const D1_RANK     = 5
const D1_UV       = 4
const METALLIC_RE = /Silverada|VibranceMetallic/i

const median = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p95 = (xs: number[]) => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))]
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(full))
    else if (e.isFile() && /\.(icm|icc)$/i.test(e.name)) out.push(full)
  }
  return out
}

type LP = ProfileData & { wavelengths: number[] }

async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r   = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: {
        full_name: name, brand: 'BC', series: name, printer: 'P9000', ink: 'mk',
        substrate: name, parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

interface PairData {
  N: number
  X_A_clean: Float64Array; X_B_clean: Float64Array; X_B_orig: Float64Array
  D: Float64Array; fB: Float64Array; emB: Float64Array
  anchorIdx13: number[]; paperRowIdx: number; sampleIds: string[]
}

function buildPairData(pA: LP, pB: LP): PairData | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D, sampleIds, wavelengths } = al
  const wl = wavelengths ?? Array.from({ length: L }, (_, i) => 380 + i * 10)

  let paperRowIdx = 0
  for (let i = 0; i < N; i++)
    if (D[i*3] === 255 && D[i*3+1] === 255 && D[i*3+2] === 255) { paperRowIdx = i; break }

  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)

  const tgtMat = { X: X_B, D, channels: 3 as const, N, L, wavelengths: wl, sampleIds, droppedCount: 0 }
  const anchorIdx13 = (pickHeuristicAnchors(tgtMat).meta?.chosenIdx as number[]).slice(0, 13)

  return { N, X_A_clean, X_B_clean, X_B_orig: X_B, D, fB, emB: emB.emission, anchorIdx13, paperRowIdx, sampleIds }
}

function evalD1(pd: PairData, refName: string, tgtName: string, globalResidual: boolean) {
  const anchorIdx = pd.anchorIdx13
  const anchorSet = new Set(anchorIdx)
  const paperWP   = paperWPFromBrightestPatch(
    new Float64Array(pd.X_B_orig.subarray(pd.paperRowIdx*L, pd.paperRowIdx*L+L)), 1, L, 380)

  const d1 = runPaperRatioResidualTransfer({
    X_A: pd.X_A_clean, X_B: pd.X_B_clean, D: pd.D,
    sampleIds: pd.sampleIds, anchorIdx, paperRowIdx: pd.paperRowIdx, L,
    paperWP, refProfile: refName, targetProfile: tgtName,
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV, globalResidual,
  })

  const X_pred_abs = addOBA(d1.X_pred, L, pd.fB, pd.emB)
  const des: number[] = []
  for (let i = 0; i < pd.N; i++) {
    if (anchorSet.has(i)) continue
    const pred = Array.from(X_pred_abs.subarray(i*L, i*L+L))
    const meas = Array.from(pd.X_B_orig.subarray(i*L, i*L+L))
    const lp = spectraToLab(pred), lm = spectraToLab(meas)
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95v = p95(des)
  return { med, p95v, pass: med <= 1.5 && p95v <= 3.0 }
}

// 3 D1-only pairs from H26 (D1 passes, H22 global fails).
const D1_ONLY = [
  ['PhotoPeelGloss', 'VibranceGloss'],
  ['17MSatin', 'Crystalline'],
  ['17MGloss', 'Crystalline'],
]
const isD1Only = (a: string, b: string) =>
  D1_ONLY.some(([x, y]) => a.includes(x) && b.includes(y))

async function main() {
  console.log('Loading profiles...')
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (await Promise.all(
    files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile)
  )).filter(Boolean) as LP[]
  console.log(`BC profiles loaded: ${profiles.length}`)

  interface Row {
    ref: string; tgt: string; mode: string; d1only: boolean
    full_med: number; full_p95: number; full_pass: boolean
    nol3_med: number; nol3_p95: number; nol3_pass: boolean
  }
  const rows: Row[] = []
  let done = 0
  for (const pA of profiles) {
    for (const pB of profiles) {
      if (pA === pB) continue
      if (pA.metadata.printMode !== pB.metadata.printMode) continue
      const nA = pA.metadata.full_name, nB = pB.metadata.full_name
      if (nA.includes('AllureAq') || nB.includes('AllureAq')) continue
      if (METALLIC_RE.test(nA) || METALLIC_RE.test(nB)) continue

      const pd = buildPairData(pA, pB)
      if (!pd) continue

      const full = evalD1(pd, nA, nB, false)
      const nol3 = evalD1(pd, nA, nB, true)
      rows.push({
        ref: nA, tgt: nB, mode: pA.metadata.printMode, d1only: isD1Only(nA, nB),
        full_med: full.med, full_p95: full.p95v, full_pass: full.pass,
        nol3_med: nol3.med, nol3_p95: nol3.p95v, nol3_pass: nol3.pass,
      })
      process.stdout.write(`\r${++done} pairs evaluated...`)
    }
  }
  console.log()

  const n = rows.length
  const fullN = rows.filter(r => r.full_pass).length
  const nol3N = rows.filter(r => r.nol3_pass).length
  console.log(`\n=== Pass rates (${n} non-metallic same-mode pairs) ===`)
  console.log(`  D1 FULL  (Layer 3 IDW)   : ${fullN}/${n} = ${(100*fullN/n).toFixed(1)}%`)
  console.log(`  D1 noL3  (global resid.) : ${nol3N}/${n} = ${(100*nol3N/n).toFixed(1)}%`)
  console.log(`  Layer 3 contribution     : ${fullN - nol3N} pairs (${(100*(fullN-nol3N)/n).toFixed(1)} pp)`)

  const lostByAbl = rows.filter(r => r.full_pass && !r.nol3_pass)
  console.log(`\n=== Pairs that FAIL when Layer 3 removed (${lostByAbl.length}) ===`)
  for (const r of lostByAbl.sort((a, b) => b.nol3_p95 - a.nol3_p95)) {
    const rn = r.ref.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tn = r.tgt.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tag = r.d1only ? ' ★D1-only(H26)' : ''
    console.log(`  ${rn.padEnd(20)}→ ${tn.padEnd(20)}  full p95=${r.full_p95.toFixed(2)} → noL3 p95=${r.nol3_p95.toFixed(2)} (med ${r.full_med.toFixed(2)}→${r.nol3_med.toFixed(2)})${tag}`)
  }

  console.log('\n=== Spotlight: 3 D1-only pairs from H26 ===')
  for (const r of rows.filter(r => r.d1only)) {
    const rn = r.ref.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tn = r.tgt.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    console.log(`  ${rn.padEnd(20)}→ ${tn.padEnd(20)}  FULL: med=${r.full_med.toFixed(2)} p95=${r.full_p95.toFixed(2)} ${r.full_pass?'PASS':'fail'}   noL3: med=${r.nol3_med.toFixed(2)} p95=${r.nol3_p95.toFixed(2)} ${r.nol3_pass?'PASS':'fail'}`)
  }

  // Aggregate p95 lift attributable to Layer 3.
  const dP95 = rows.map(r => r.nol3_p95 - r.full_p95).filter(x => Number.isFinite(x))
  console.log(`\n=== Layer 3 p95 effect (noL3 − full, +ve = Layer 3 helps) ===`)
  console.log(`  median Δp95 = ${median(dP95).toFixed(3)}   p95 Δp95 = ${p95(dP95).toFixed(3)}   max = ${Math.max(...dP95).toFixed(3)}`)
}

main().catch(e => { console.error(e); process.exit(1) })
