// H34 — M2 / OBA diagnosis on structural failers.
//
// All CanvasMatte profiles + ArtPeelBlckt + VibranceLuster carry paired M0+M2
// spectra. M2 = UV-cut (eliminates OBA fluorescence by design). 1930 and
// RiverStoneSatinRag are M0-only.
//
// Three conditions per pair:
//   M0   — baseline: M0 primary spectra + software OBA separator (current pipeline)
//   M2   — UV-cut spectra directly, NO OBA separator applied
//   M0-N — M0, OBA separator DISABLED (raw M0, no correction) — upper bound on OBA error
//
// For pairs where only ONE side has M2 (1930↔ArtPeel, VibranceLuster↔RiverStone):
// only M0 baseline + partial-M2 (one side only) are run.
//
// If M2 ≈ M0 baseline → OBA separator works fine; OBA NOT the cause
// If M2 << M0 baseline (lower error) → OBA imperfection contributes
// If M2 ≈ M0-N (no correction) → OBA separator is doing the right thing; M2 only changes ref
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h34_m2_oba_diagnosis.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as any).DOMParser = jsdom.window.DOMParser
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
import type { ProfileData, Measurement } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, RANK = 5, UV_K = 4, K = 13

const median = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if (!xs.length) return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
const fmtGate = (med: number, p: number) => `${med.toFixed(2)}/${p.toFixed(2)}${med<=1.5&&p<=3.0?'✓':' '}`

type LP = ProfileData & { wavelengths: number[]; measurements_raw: Measurement[] }

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  try { for (const d of await fs.readdir(dir, {withFileTypes:true})) {
    const f = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walk(f))
    else if (/\.(icm|icc)$/i.test(d.name)) out.push(f)
  } } catch { /* skip */ }
  return out
}

async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const r = await parseIcmFile({arrayBuffer: async () => ab} as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let preset: string; try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: { full_name: name, brand:'BC', series:name, printer:'P9000', ink:'mk',
                  substrate:name, parsed_at: new Date().toISOString(), printMode: preset },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({length:36},(_,i)=>380+i*10),
      measurements_raw: r.measurements,
    }
  } catch { return null }
}

const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '').replace(/_P9000$/, '')

/** Build X matrix from a specific spectra field per measurement array */
function buildX(measurements: Measurement[], field: 'spectra' | 'spectra_m2'): { X: Float64Array | null; N: number } {
  const valid = measurements.filter(m => m[field] && (m[field] as number[]).length === L)
  if (valid.length === 0) return { X: null, N: 0 }
  const N = valid.length
  const X = new Float64Array(N * L)
  for (let i = 0; i < N; i++) {
    const sp = valid[i][field] as number[]
    for (let l = 0; l < L; l++) X[i * L + l] = sp[l]
  }
  return { X, N }
}

function evalTransfer(
  X_A: Float64Array, X_B: Float64Array,
  D: Float64Array, sampleIds: string[],
  paperRowIdx: number,
  useOBA: boolean,   // whether to apply OBA separator
  anchorIdx: number[],
): { med: number; p95: number } {
  const N = sampleIds.length

  let XA_clean: Float64Array, XB_clean: Float64Array
  let fB: Float64Array, emB: Float64Array

  if (useOBA) {
    const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
    const emBObj = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
    const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
    fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
    XA_clean = subtractOBA(X_A, L, fA, emA.emission)
    XB_clean = subtractOBA(X_B, L, fB, emBObj.emission)
    emB = new Float64Array(emBObj.emission)
  } else {
    // no OBA correction — raw spectra
    XA_clean = new Float64Array(X_A)
    XB_clean = new Float64Array(X_B)
    fB = new Float64Array(N).fill(0)
    emB = new Float64Array(L).fill(0)
  }

  const paperWP = paperWPFromBrightestPatch(
    new Float64Array(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)), 1, L, 380)

  const d1 = runPaperRatioResidualTransfer({
    X_A: XA_clean, X_B: XB_clean, D, sampleIds, anchorIdx, paperRowIdx, L, paperWP,
    refProfile: 'A', targetProfile: 'B', residualRank: RANK, knnK: 4, uvBandCount: UV_K,
  })

  const pred = useOBA ? addOBA(d1.X_pred, L, fB, emB) : d1.X_pred
  const anchorSet = new Set(anchorIdx)
  const des: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const lp = spectraToLab(Array.from(pred.subarray(i*L, i*L+L)))
    const lm = spectraToLab(Array.from(X_B.subarray(i*L, i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]))
  }
  return { med: median(des), p95: p95(des) }
}

const TARGETS: Array<[string, string]> = [
  // DecorMatte group (all have M0+M2 on both sides)
  ['DecorMatte','ChromataWhite'], ['ChromataWhite','DecorMatte'],
  ['DecorMatte','800M'],          ['800M','DecorMatte'],
  ['DecorMatte','Lyve'],          ['Lyve','DecorMatte'],
  ['DecorMatte','BelgianLinen'],  ['BelgianLinen','DecorMatte'],
  // EMP group (ArtPeel has M2, 1930 does NOT)
  ['1930','ArtPeelBlckt'],        ['ArtPeelBlckt','1930'],
  // Luster group (VibranceLuster has M2, RiverStone does NOT)
  ['VibranceLuster','RiverStoneSatinRag'], ['RiverStoneSatinRag','VibranceLuster'],
]

async function main() {
  const files = (await walk(PROFILES_ROOT)).filter(f => path.basename(f).startsWith('BC_')).sort()
  const profiles = (await Promise.all(files.map(loadProfile))).filter(Boolean) as LP[]
  const byShort = new Map<string, LP>()
  for (const p of profiles) byShort.set(short(p.metadata.full_name), p)

  console.log('=== H34: M2 / OBA diagnosis on 12 structural failers ===')
  console.log('  M0   = M0 spectra + OBA separator (production pipeline)')
  console.log('  M2   = UV-cut spectra direct, NO OBA separator (measures OBA contribution)')
  console.log('  M0-N = M0 spectra, OBA separator DISABLED (upper bound on raw-OBA error)')
  console.log('  If M2≈M0: OBA separator adequate, OBA not the cause')
  console.log('  If M2 better: OBA separator imperfect on these pairs')
  console.log('  "n/a" = that side has no M2 data (M0-only profile)\n')
  console.log(`  ${'pair'.padEnd(38)} ${'M0'.padEnd(16)} ${'M2'.padEnd(16)} M0-N`)
  console.log(`  ${'----'.padEnd(38)} ${'-------'.padEnd(16)} ${'-------'.padEnd(16)} -------`)

  const summary = { total:0, m2_better:0, m2_same:0, m2_worse:0, m2_na:0 }

  for (const [aS, bS] of TARGETS) {
    const pA = byShort.get(aS), pB = byShort.get(bS)
    if (!pA || !pB) { console.log(`  ${aS}→${bS}: profiles missing`); continue }

    // Check same print mode
    if (pA.metadata.printMode !== pB.metadata.printMode) {
      console.log(`  ${(aS+'→'+bS).padEnd(38)} mode mismatch`); continue
    }

    // Build aligned M0 matrices via existing path
    const alM0 = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
    if (alM0.N < 100) { console.log(`  ${(aS+'→'+bS).padEnd(38)} align failed`); continue }

    const { N, X_A, X_B, D, sampleIds } = alM0
    let paperRowIdx = 0
    for (let i = 0; i < N; i++) {
      if (D[i*3]===255 && D[i*3+1]===255 && D[i*3+2]===255) { paperRowIdx = i; break }
    }
    const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: alM0.wavelengths ?? [], sampleIds, droppedCount: 0 }
    const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, K)

    const m0 = evalTransfer(X_A, X_B, D, sampleIds, paperRowIdx, true, anchorIdx)
    const m0n = evalTransfer(X_A, X_B, D, sampleIds, paperRowIdx, false, anchorIdx)

    // Check M2 availability — need M2 spectra on BOTH sides with same sampleId alignment
    const hasM2_A = pA.measurements_raw.some(m => m.spectra_m2 && m.spectra_m2.length === L)
    const hasM2_B = pB.measurements_raw.some(m => m.spectra_m2 && m.spectra_m2.length === L)

    let m2str = 'n/a           '
    let m2med: number | null = null

    if (hasM2_A && hasM2_B) {
      // Build M2-based X matrices using same sampleId ordering as aligned M0
      // Map sampleId → m2 spectra for each profile
      const m2A = new Map<string, number[]>()
      const m2B = new Map<string, number[]>()
      for (const m of pA.measurements_raw) {
        if (m.spectra_m2 && m.spectra_m2.length === L && m.SAMPLE_ID) m2A.set(m.SAMPLE_ID, m.spectra_m2)
      }
      for (const m of pB.measurements_raw) {
        if (m.spectra_m2 && m.spectra_m2.length === L && m.SAMPLE_ID) m2B.set(m.SAMPLE_ID, m.spectra_m2)
      }

      // Build X_A_m2 and X_B_m2 in the SAME order as the aligned sampleIds
      let allHave = true
      const XA_m2 = new Float64Array(N * L)
      const XB_m2 = new Float64Array(N * L)
      for (let i = 0; i < N; i++) {
        const sid = sampleIds[i]
        const spA = m2A.get(sid), spB = m2B.get(sid)
        if (!spA || !spB) { allHave = false; break }
        for (let l = 0; l < L; l++) { XA_m2[i*L+l] = spA[l]; XB_m2[i*L+l] = spB[l] }
      }
      if (allHave) {
        const m2 = evalTransfer(XA_m2, XB_m2, D, sampleIds, paperRowIdx, false, anchorIdx)
        m2str = fmtGate(m2.med, m2.p95)
        m2med = m2.med
      } else {
        m2str = 'id-mismatch   '
      }
    } else if (hasM2_B && !hasM2_A) {
      m2str = 'A=M0-only     '
    } else if (hasM2_A && !hasM2_B) {
      m2str = 'B=M0-only     '
    }

    summary.total++
    if (m2med !== null) {
      const delta = m2med - m0.med
      if (delta < -0.1) summary.m2_better++
      else if (delta > 0.1) summary.m2_worse++
      else summary.m2_same++
    } else {
      summary.m2_na++
    }

    console.log(`  ${(aS+'→'+bS).padEnd(38)} ${fmtGate(m0.med,m0.p95).padEnd(16)} ${m2str.padEnd(16)} ${fmtGate(m0n.med,m0n.p95)}`)
  }

  console.log(`\n  OBA hypothesis summary (pairs with both-side M2):`)
  console.log(`    M2 better  (>0.1 lower median): ${summary.m2_better}/${summary.total-summary.m2_na}`)
  console.log(`    M2 same    (±0.1):               ${summary.m2_same}/${summary.total-summary.m2_na}`)
  console.log(`    M2 worse   (>0.1 higher):        ${summary.m2_worse}/${summary.total-summary.m2_na}`)
  console.log(`    N/A (one side M0-only):          ${summary.m2_na}/${summary.total}`)

  // --- Per-λ OBA emission magnitude on DecorMatte group ---
  console.log('\n=== Per-λ OBA emission comparison: DecorMatte vs peers (paper-white spectra) ===')
  console.log('  (M0 - M2 = OBA fluorescence contribution at paper white)')
  const decorM = byShort.get('DecorMatte')
  const peers = ['800M','ChromataWhite','Lyve','BelgianLinen'].map(s => byShort.get(s)).filter(Boolean) as LP[]
  if (decorM) {
    const dm0 = decorM.measurements_raw.find(m => {
      const d = m.device; return d && 'R' in d && d.R>=250 && d.G>=250 && d.B>=250
    }) ?? decorM.measurements_raw.find(m => m.RGB_R!==undefined && (m.RGB_R??0)>=250)
    if (dm0?.spectra && dm0.spectra_m2) {
      const oba_deco = dm0.spectra.map((v,i)=>v-(dm0.spectra_m2![i]??0))
      const peer_obas = peers.map(p => {
        const wh = p.measurements_raw.find(m => {
          const d = m.device; return d && 'R' in d && d.R>=250 && d.G>=250 && d.B>=250
        }) ?? p.measurements_raw.find(m => m.RGB_R!==undefined && (m.RGB_R??0)>=250)
        return wh?.spectra && wh.spectra_m2 ? wh.spectra.map((v,i)=>v-(wh.spectra_m2![i]??0)) : null
      }).filter(Boolean) as number[][]

      const WL = Array.from({length:36},(_,i)=>380+i*10)
      console.log('  λ    DecorMatte(OBA)  peers-mean(OBA)  diff')
      for (let l = 0; l < 36; l += 2) {
        const peerMean = peer_obas.length ? peer_obas.reduce((s,p)=>s+p[l],0)/peer_obas.length : 0
        const diff = oba_deco[l] - peerMean
        if (Math.abs(oba_deco[l]) > 0.001 || Math.abs(peerMean) > 0.001)
          console.log(`  ${WL[l]}  ${oba_deco[l].toFixed(4).padStart(12)}   ${peerMean.toFixed(4).padStart(11)}   ${diff.toFixed(4)}`)
      }
    }
  }
}
main().catch(e => { console.error(e); process.exit(1) })
