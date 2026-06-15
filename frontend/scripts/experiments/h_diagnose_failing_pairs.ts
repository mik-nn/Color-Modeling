// frontend/scripts/experiments/h_diagnose_failing_pairs.ts
//
// Diagnostic: identify the ~19/114 same-mode BC pairs that fail H4 at k=13.
// Characterise failures by: print mode, OBA delta, ink density, directionality.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h_diagnose_failing_pairs.ts"

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
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/h_diagnose_failing.json')
const MIN_MATCH = 100
const UV_BAND_COUNT = 4
const RANK = 5
const K = 13

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function percentile(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))
  return s[idx]
}
function totalInk(r: number, g: number, b: number): number {
  return (3 * 255 - r - g - b) / 255
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

interface LoadedProfile extends ProfileData { wavelengths: number[]; obaAmplitude: number }

async function loadProfile(filePath: string): Promise<LoadedProfile | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    const wl = r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10)

    // Pre-compute OBA amplitude from paper-white patch
    const measurements = r.measurements
    const paperPatch = measurements.find(m =>
      m.device.R === 255 && m.device.G === 255 && m.device.B === 255
    )
    let obaAmplitude = 0
    if (paperPatch?.spectrum?.reflectances) {
      const em = extractOBAEmission(paperPatch.spectrum.reflectances)
      obaAmplitude = em.peakAmplitude
    }

    return {
      metadata: {
        full_name: name, brand: name.startsWith('BC') ? 'BC' : 'MOAB',
        series: name, printer: 'P9000', ink: 'mk', substrate: name,
        parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: measurements, clean: measurements,
      has_spectral: true, patch_count: measurements.length,
      wavelengths: wl, obaAmplitude,
    }
  } catch { return null }
}

interface PairRecord {
  ref: string; tgt: string; mode: string
  ref_oba: number; tgt_oba: number; oba_delta: number
  med: number; p95: number; pass: boolean
  // ΔE by ink tercile (0–1: low, 1–2: mid, 2–3: high CMY)
  p95_lo: number; p95_mid: number; p95_hi: number
  n_lo: number; n_mid: number; n_hi: number
}

async function evalPair(profA: LoadedProfile, profB: LoadedProfile): Promise<PairRecord | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D } = al
  const L = profA.wavelengths.length

  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break }
  }
  const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, 380)

  const tgt = {
    X: X_B, D, channels: 3 as const, N, L,
    wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0,
  }
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, K)
  const anchorSet = new Set(anchorIdx)

  const d1 = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D, sampleIds: al.sampleIds,
    anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred = addOBA(d1.X_pred, L, fB, emB.emission)

  const des: number[] = []
  const lo: number[] = [], mid: number[] = [], hi: number[] = []

  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pred = Array.from(X_pred.subarray(i * L, i * L + L))
    const meas = Array.from(X_B.subarray(i * L, i * L + L))
    const lp = spectraToLab(pred), lm = spectraToLab(meas)
    const de = deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2])
    des.push(de)
    const ink = totalInk(D[i * 3], D[i * 3 + 1], D[i * 3 + 2])
    if (ink < 1.0) lo.push(de)
    else if (ink < 2.0) mid.push(de)
    else hi.push(de)
  }

  const med = median(des), p95 = percentile(des, 95)
  return {
    ref: profA.metadata.full_name, tgt: profB.metadata.full_name,
    mode: profA.metadata.printMode,
    ref_oba: profA.obaAmplitude, tgt_oba: profB.obaAmplitude,
    oba_delta: Math.abs(profA.obaAmplitude - profB.obaAmplitude),
    med, p95, pass: med <= 1.5 && p95 <= 3.0,
    p95_lo: lo.length ? percentile(lo, 95) : NaN,
    p95_mid: mid.length ? percentile(mid, 95) : NaN,
    p95_hi: hi.length ? percentile(hi, 95) : NaN,
    n_lo: lo.length, n_mid: mid.length, n_hi: hi.length,
  }
}

async function main() {
  const allFiles = await walk(PROFILES_ROOT)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as LoadedProfile[]
  const bc = profiles.filter(p => p.metadata.brand === 'BC')
  console.log(`BC profiles: ${bc.length}`)

  const all: PairRecord[] = []
  let done = 0
  for (let i = 0; i < bc.length; i++) {
    for (let j = 0; j < bc.length; j++) {
      if (i === j) continue
      if (bc[i].metadata.printMode !== bc[j].metadata.printMode) continue
      if (bc[i].metadata.full_name.includes('AllureAq') || bc[j].metadata.full_name.includes('AllureAq')) continue
      const r = await evalPair(bc[i], bc[j])
      if (!r) continue
      all.push(r)
      done++
      process.stdout.write(`\r${done} pairs`)
    }
  }
  console.log()

  const failing = all.filter(r => !r.pass).sort((a, b) => b.p95 - a.p95)
  const passing = all.filter(r => r.pass)

  console.log(`\nTotal: ${all.length}  Pass: ${passing.length}  Fail: ${failing.length}`)
  console.log(`Pass rate: ${(100 * passing.length / all.length).toFixed(1)}%`)

  // ── Failing pairs table ──────────────────────────────────────────────────
  console.log('\n── Failing pairs (k=13, sorted by P95 desc) ───────────────────────')
  console.log('  Ref (short) → Tgt (short) | mode | oba_delta | med  | P95  | P95_hi')
  for (const r of failing) {
    const refS = r.ref.replace('BC_', '').replace('_P9000_mk_', '/').replace('CanvasMatte', 'CM').replace('CanvasSatin', 'CS').replace('WatercolorRag', 'WCRW').replace('_', ' ')
    const tgtS = r.tgt.replace('BC_', '').replace('_P9000_mk_', '/').replace('CanvasMatte', 'CM').replace('CanvasSatin', 'CS').replace('WatercolorRag', 'WCRW').replace('_', ' ')
    console.log(`  ${refS.padEnd(30)} → ${tgtS.padEnd(30)} | ${r.mode.padEnd(12)} | ${r.oba_delta.toFixed(3).padStart(9)} | ${r.med.toFixed(3)} | ${r.p95.toFixed(3)} | ${isNaN(r.p95_hi) ? '   n/a' : r.p95_hi.toFixed(3)}`)
  }

  // ── Mode breakdown ───────────────────────────────────────────────────────
  const modeStats = new Map<string, { pass: number; fail: number }>()
  for (const r of all) {
    if (!modeStats.has(r.mode)) modeStats.set(r.mode, { pass: 0, fail: 0 })
    const s = modeStats.get(r.mode)!
    if (r.pass) s.pass++; else s.fail++
  }
  console.log('\n── By print mode ───────────────────────────────────────────────────')
  for (const [mode, s] of [...modeStats.entries()].sort((a, b) => b[1].fail - a[1].fail)) {
    const total = s.pass + s.fail
    console.log(`  ${mode.padEnd(20)} pass=${s.pass}/${total} (${(100*s.pass/total).toFixed(0)}%)  fail=${s.fail}`)
  }

  // ── OBA delta distribution: failing vs passing ────────────────────────
  const failOba = failing.map(r => r.oba_delta)
  const passOba = passing.map(r => r.oba_delta)
  console.log('\n── OBA delta (|oba_A - oba_B|) ────────────────────────────────────')
  console.log(`  Failing: med=${median(failOba).toFixed(4)}  P75=${percentile(failOba, 75).toFixed(4)}  P95=${percentile(failOba, 95).toFixed(4)}`)
  console.log(`  Passing: med=${median(passOba).toFixed(4)}  P75=${percentile(passOba, 75).toFixed(4)}  P95=${percentile(passOba, 95).toFixed(4)}`)

  // ── Directionality: A→B fail, B→A pass? ──────────────────────────────
  const pairKey = (r: PairRecord) => [r.ref, r.tgt].sort().join('↔')
  const byKey = new Map<string, PairRecord[]>()
  for (const r of all) {
    const k = pairKey(r)
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k)!.push(r)
  }
  let asymmetric = 0, symmetric_fail = 0
  for (const [, recs] of byKey) {
    if (recs.length !== 2) continue
    const [a, b] = recs
    if (!a.pass && !b.pass) symmetric_fail++
    else if (!a.pass || !b.pass) asymmetric++
  }
  console.log('\n── Directionality of failures ──────────────────────────────────────')
  console.log(`  Symmetric fails (A→B AND B→A both fail): ${symmetric_fail} undirected pairs`)
  console.log(`  Asymmetric (one direction fails):         ${asymmetric} undirected pairs`)

  // ── Ink-coverage breakdown for failing pairs ──────────────────────────
  const failP95Lo  = failing.map(r => r.p95_lo).filter(v => !isNaN(v))
  const failP95Mid = failing.map(r => r.p95_mid).filter(v => !isNaN(v))
  const failP95Hi  = failing.map(r => r.p95_hi).filter(v => !isNaN(v))
  console.log('\n── Ink-coverage P95 for FAILING pairs ─────────────────────────────')
  console.log(`  Low  ink (CMY 0–1): P95 med = ${median(failP95Lo).toFixed(3)}`)
  console.log(`  Mid  ink (CMY 1–2): P95 med = ${median(failP95Mid).toFixed(3)}`)
  console.log(`  High ink (CMY 2–3): P95 med = ${median(failP95Hi).toFixed(3)}`)
  console.log('\n── Ink-coverage P95 for PASSING pairs ─────────────────────────────')
  const passP95Lo  = passing.map(r => r.p95_lo).filter(v => !isNaN(v))
  const passP95Mid = passing.map(r => r.p95_mid).filter(v => !isNaN(v))
  const passP95Hi  = passing.map(r => r.p95_hi).filter(v => !isNaN(v))
  console.log(`  Low  ink (CMY 0–1): P95 med = ${median(passP95Lo).toFixed(3)}`)
  console.log(`  Mid  ink (CMY 1–2): P95 med = ${median(passP95Mid).toFixed(3)}`)
  console.log(`  High ink (CMY 2–3): P95 med = ${median(passP95Hi).toFixed(3)}`)

  // ── Top failing substrate names ───────────────────────────────────────
  const failCount = new Map<string, number>()
  for (const r of failing) {
    failCount.set(r.ref, (failCount.get(r.ref) ?? 0) + 1)
    failCount.set(r.tgt, (failCount.get(r.tgt) ?? 0) + 1)
  }
  const topFail = [...failCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  console.log('\n── Substrates most often in a failing pair ─────────────────────────')
  for (const [name, cnt] of topFail) {
    const obaVal = bc.find(p => p.metadata.full_name === name)?.obaAmplitude ?? NaN
    console.log(`  ${name.padEnd(55)} count=${cnt}  OBA=${obaVal.toFixed(4)}`)
  }

  await fs.writeFile(OUT_JSON, JSON.stringify({
    generated: new Date().toISOString(), k: K,
    total: all.length, pass: passing.length, fail: failing.length,
    failing, passing: passing.map(r => ({ ref: r.ref, tgt: r.tgt, mode: r.mode, med: r.med, p95: r.p95 })),
  }, null, 2))
  console.log(`\nWrote ${OUT_JSON}`)
}

main().catch(console.error)
