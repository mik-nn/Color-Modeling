// frontend/scripts/experiments/h23_spreading_correction.ts
//
// H23b — Explicit spreading correction pre-layer for D1.
//
// Core idea: before running D1, pre-correct spectra_A with the spreading
// ratio s(a) = f_B(a) / f_A(a) where f(a) = 1 + c1·a + c2·a² (quadratic
// fit of normalised neutral ramp at λ=560 nm). This maps A's spectra into
// "what they would look like if A had B's spreading curve", so the paper-
// ratio + affine steps of D1 work on spreading-corrected data.
//
// s(0) = 1 (paper patch unchanged), s(1) = f_B(1)/f_A(1) at max ink.
// Ratio clamped to [0.5, 2.0] for numerical safety.
//
// Experiment design:
//   Baseline : D1 k=13 S1 heuristic anchors, no spreading correction.
//   Corrected: D1 k=13 same anchors + spreading from neutral subset of B.
//     c1_A, c2_A → from ALL neutral patches of A (oracle — free).
//     c1_B, c2_B → from neutral patches of B WITHIN the anchor set
//                  (no extra measurements — spreading uses what S1 already picks).
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h23_spreading_correction.ts"

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

const ROOT         = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const DIAG_JSON    = path.resolve(process.cwd(), 'data/cae-input/h_diagnose_failing.json')
const MIN_MATCH    = 100
const UV_BAND_COUNT = 4
const RANK         = 5
const K            = 13
const IDX_560      = 18   // (560-380)/10
const S_CLAMP_LO   = 0.5
const S_CLAMP_HI   = 2.0
const METALLIC_RE  = /Silverada|VibranceMetallic/i

// ─── helpers ─────────────────────────────────────────────────────────────────

function median(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function p95(xs: number[]): number {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))]
}
function totalInk(r: number, g: number, b: number): number {
  return (3 * 255 - r - g - b) / 255
}

/** Least-squares fit y = 1 + c1·x + c2·x² (c0 forced to 1). */
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n = xs.length
  if (n < 2) return [0, 0]
  let S11 = 0, S12 = 0, S22 = 0, T1 = 0, T2 = 0
  for (let i = 0; i < n; i++) {
    const x = xs[i], x2 = x * x, r = ys[i] - 1
    S11 += x * x; S12 += x * x2; S22 += x2 * x2
    T1  += x * r; T2  += x2 * r
  }
  const det = S11 * S22 - S12 * S12
  if (Math.abs(det) < 1e-18) return [0, 0]
  return [(T1 * S22 - T2 * S12) / det, (T2 * S11 - T1 * S12) / det]
}

/** Fit spreading curve from given rows (subset of N×L matrix). */
function fitSpreading(
  spectra: Float64Array, device: Float64Array,
  rowIndices: number[], L: number,
  paperSpec560: number,
): [number, number] {
  const xs: number[] = [], ys: number[] = []
  for (const i of rowIndices) {
    const r = device[i * 3], g = device[i * 3 + 1], b = device[i * 3 + 2]
    const a = (765 - r - g - b) / 765
    if (a < 0.01) continue  // skip paper
    const rnorm = paperSpec560 > 1e-4 ? spectra[i * L + IDX_560] / paperSpec560 : 1
    xs.push(a); ys.push(rnorm)
  }
  return xs.length >= 2 ? fitQuadNoBias(xs, ys) : [0, 0]
}

/** Return indices of neutral patches (|R-G|+|G-B| ≤ tol) in device matrix. */
function neutralIndices(device: Float64Array, N: number, tol = 10): number[] {
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    const r = device[i * 3], g = device[i * 3 + 1], b = device[i * 3 + 2]
    if (Math.abs(r - g) + Math.abs(g - b) <= tol) out.push(i)
  }
  return out
}

/**
 * Pre-correct spectra_A by spreading ratio s(a_i) = f_B(a_i) / f_A(a_i).
 * Returns a new Float64Array; paper patch (a≈0) is unchanged.
 */
function preCorrectSpreading(
  X_A: Float64Array, device_A: Float64Array,
  N: number, L: number,
  c1_A: number, c2_A: number,
  c1_B: number, c2_B: number,
): Float64Array {
  const out = new Float64Array(X_A)
  for (let i = 0; i < N; i++) {
    const r = device_A[i * 3], g = device_A[i * 3 + 1], b = device_A[i * 3 + 2]
    const a = (765 - r - g - b) / 765
    if (a < 0.01) continue
    const fA = 1 + c1_A * a + c2_A * a * a
    const fB = 1 + c1_B * a + c2_B * a * a
    if (Math.abs(fA) < 0.01) continue
    const s = Math.max(S_CLAMP_LO, Math.min(S_CLAMP_HI, fB / fA))
    for (let l = 0; l < L; l++) out[i * L + l] *= s
  }
  return out
}

// ─── profile loading ──────────────────────────────────────────────────────────

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

interface LoadedProfile extends ProfileData { wavelengths: number[] }

async function loadProfile(filePath: string): Promise<LoadedProfile | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r   = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    const wl = r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10)
    return {
      metadata: {
        full_name: name, brand: name.startsWith('BC') ? 'BC' : 'MOAB',
        series: name, printer: 'P9000', ink: 'mk', substrate: name,
        parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length, wavelengths: wl,
    }
  } catch { return null }
}

// ─── pair evaluation ──────────────────────────────────────────────────────────

interface PairResult {
  ref: string; tgt: string; mode: string
  baseline_med: number; baseline_p95: number; baseline_pass: boolean
  corrected_med: number; corrected_p95: number; corrected_pass: boolean
  c1_A: number; c2_A: number; c1_B: number; c2_B: number
  dSpread: number; neutral_anchors_used: number
}

async function evalPair(
  profA: LoadedProfile, profB: LoadedProfile,
): Promise<PairResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D } = al
  const L = profA.wavelengths.length

  // Paper row
  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) {
      paperRowIdx = i; break
    }
  }

  // OBA clean (same as baseline)
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP   = paperWPFromBrightestPatch(
    new Float64Array(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)), 1, L, 380)

  // Anchor selection (same for both variants)
  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, K)
  const anchorSet = new Set(anchorIdx)

  // ── Baseline D1 ─────────────────────────────────────────────────────────
  const d1base = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D, sampleIds: al.sampleIds,
    anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred_base = addOBA(d1base.X_pred, L, fB, emB.emission)

  // ── Spreading correction ─────────────────────────────────────────────────
  // c1_A, c2_A from ALL neutral patches in A (oracle — no measurement cost)
  const paper560_A = X_A_clean[paperRowIdx * L + IDX_560]
  const neutralA   = neutralIndices(D, N)
  const [c1_A, c2_A] = fitSpreading(X_A_clean, D, neutralA, L, paper560_A)

  // c1_B, c2_B — ORACLE: ALL neutral patches of B (upper-bound test).
  // Tells us the maximum achievable improvement if spreading is the true mechanism.
  const paper560_B = X_B_clean[paperRowIdx * L + IDX_560]
  const neutralB   = neutralIndices(D, N).filter(i => i !== paperRowIdx)
  const neutralAnchors = neutralB  // oracle: all neutral patches
  const [c1_B, c2_B] = neutralAnchors.length >= 2
    ? fitSpreading(X_B_clean, D, neutralAnchors, L, paper560_B)
    : [c1_A, c2_A]

  // Pre-correct A spectra with spreading ratio — only when dSpread large enough
  // to be meaningful. Small dSpread corrections introduce more noise than signal.
  const dSpreadPre = Math.sqrt((c1_B-c1_A)**2 + (c2_B-c2_A)**2)
  const SPREAD_THR = 0.13
  const X_A_spread = dSpreadPre > SPREAD_THR
    ? preCorrectSpreading(X_A_clean, D, N, L, c1_A, c2_A, c1_B, c2_B)
    : X_A_clean

  const d1spread = runPaperRatioResidualTransfer({
    X_A: X_A_spread, X_B: X_B_clean, D, sampleIds: al.sampleIds,
    anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred_spread = addOBA(d1spread.X_pred, L, fB, emB.emission)

  // ── Metrics ──────────────────────────────────────────────────────────────
  const des_base: number[] = [], des_spread: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pred_b  = Array.from(X_pred_base.subarray(i * L, i * L + L))
    const pred_s  = Array.from(X_pred_spread.subarray(i * L, i * L + L))
    const meas    = Array.from(X_B.subarray(i * L, i * L + L))
    const lm      = spectraToLab(meas)
    const lb      = spectraToLab(pred_b)
    const ls      = spectraToLab(pred_s)
    des_base.push(deltaE00(lb[0], lb[1], lb[2], lm[0], lm[1], lm[2]))
    des_spread.push(deltaE00(ls[0], ls[1], ls[2], lm[0], lm[1], lm[2]))
  }

  const bMed = median(des_base),   bP95 = p95(des_base)
  const sMed = median(des_spread), sP95 = p95(des_spread)
  const dc1 = c1_B - c1_A, dc2 = c2_B - c2_A

  return {
    ref: profA.metadata.full_name, tgt: profB.metadata.full_name,
    mode: profA.metadata.printMode,
    baseline_med: bMed, baseline_p95: bP95, baseline_pass: bMed <= 1.5 && bP95 <= 3.0,
    corrected_med: sMed, corrected_p95: sP95, corrected_pass: sMed <= 1.5 && sP95 <= 3.0,
    c1_A, c2_A, c1_B, c2_B,
    dSpread: Math.sqrt(dc1 * dc1 + dc2 * dc2),
    neutral_anchors_used: neutralAnchors.length,
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Known pass/fail from previous run (for cross-check)
  const diagRaw = JSON.parse(await fs.readFile(DIAG_JSON, 'utf8'))
  const knownFail = new Set<string>(
    diagRaw.failing.map((r: { ref: string; tgt: string }) => `${r.ref}↔${r.tgt}`),
  )

  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (await Promise.all(
    files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile),
  )).filter(Boolean) as LoadedProfile[]
  console.log(`Loaded ${profiles.length} BC profiles`)

  const results: PairResult[] = []
  let done = 0
  for (let i = 0; i < profiles.length; i++) {
    for (let j = 0; j < profiles.length; j++) {
      if (i === j) continue
      const pA = profiles[i], pB = profiles[j]
      if (pA.metadata.printMode !== pB.metadata.printMode) continue
      if (pA.metadata.full_name.includes('AllureAq') || pB.metadata.full_name.includes('AllureAq')) continue
      if (METALLIC_RE.test(pA.metadata.full_name) || METALLIC_RE.test(pB.metadata.full_name)) continue
      const r = await evalPair(pA, pB)
      if (!r) continue
      results.push(r)
      done++
      process.stdout.write(`\r${done} pairs`)
    }
  }
  console.log()

  // ── Overall summary ───────────────────────────────────────────────────────
  const base_pass    = results.filter(r => r.baseline_pass).length
  const spread_pass  = results.filter(r => r.corrected_pass).length
  const total        = results.length
  console.log(`\n=== H23b Results (non-metallic pairs, k=13) ===`)
  console.log(`Total pairs: ${total}`)
  console.log(`Baseline  D1:          ${base_pass}/${total} = ${(100*base_pass/total).toFixed(1)}%`)
  console.log(`D1+spreading:          ${spread_pass}/${total} = ${(100*spread_pass/total).toFixed(1)}%`)

  // ── Changes: newly passing / newly failing ────────────────────────────────
  const newPass = results.filter(r => !r.baseline_pass &&  r.corrected_pass)
  const newFail = results.filter(r =>  r.baseline_pass && !r.corrected_pass)
  console.log(`\nNewly passing (baseline FAIL → corrected PASS): ${newPass.length}`)
  for (const r of newPass.sort((a, b) => a.dSpread - b.dSpread)) {
    const refS = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tgtS = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(
      `  ${refS.padEnd(22)} → ${tgtS.padEnd(22)}` +
      `  dSpread=${r.dSpread.toFixed(3)}  neutral_k=${r.neutral_anchors_used}` +
      `  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}` +
      `  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`
    )
  }
  console.log(`\nNewly failing (baseline PASS → corrected FAIL, regressions): ${newFail.length}`)
  for (const r of newFail.sort((a, b) => b.corrected_p95 - a.corrected_p95).slice(0, 10)) {
    const refS = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tgtS = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(
      `  ${refS.padEnd(22)} → ${tgtS.padEnd(22)}` +
      `  dSpread=${r.dSpread.toFixed(3)}  neutral_k=${r.neutral_anchors_used}` +
      `  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}` +
      `  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`
    )
  }

  // ── Remaining failures ────────────────────────────────────────────────────
  const stillFail = results.filter(r => !r.corrected_pass)
  console.log(`\nStill failing after correction: ${stillFail.length}`)
  for (const r of stillFail.sort((a, b) => b.corrected_p95 - a.corrected_p95)) {
    const refS = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tgtS = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const wasKnown = knownFail.has(`${r.ref}↔${r.tgt}`) ? 'known' : 'NEW'
    console.log(
      `  [${wasKnown}] ${refS.padEnd(22)} → ${tgtS.padEnd(22)}` +
      `  dSpread=${r.dSpread.toFixed(3)}  neutral_k=${r.neutral_anchors_used}` +
      `  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}` +
      `  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`
    )
  }

  // ── Spotlight: key pairs ──────────────────────────────────────────────────
  const spotlight = ['ArtPeelBlckt', 'DecorMatte', '1930', 'BelgianLinen', 'ChromataWhite']
  console.log('\n=== Spotlight pairs (high-dSpread non-metallic) ===')
  for (const r of results.filter(r => spotlight.some(s => r.ref.includes(s) || r.tgt.includes(s)))
                         .sort((a, b) => b.dSpread - a.dSpread)) {
    const refS = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tgtS = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const arrow = r.baseline_pass === r.corrected_pass ? '  ' :
                  !r.baseline_pass && r.corrected_pass ? '✓ ' : '✗ '
    console.log(
      `  ${arrow}${refS.padEnd(20)} → ${tgtS.padEnd(20)}` +
      `  dSpread=${r.dSpread.toFixed(3)}  neutral_k=${r.neutral_anchors_used}` +
      `  Δmed=${(r.corrected_med - r.baseline_med).toFixed(3).padStart(7)}` +
      `  Δp95=${(r.corrected_p95 - r.baseline_p95).toFixed(3).padStart(7)}` +
      `  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}` +
      `  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`
    )
  }

  // ── Mode breakdown ────────────────────────────────────────────────────────
  const modeMap = new Map<string, { base_pass: number; spread_pass: number; total: number }>()
  for (const r of results) {
    if (!modeMap.has(r.mode)) modeMap.set(r.mode, { base_pass: 0, spread_pass: 0, total: 0 })
    const m = modeMap.get(r.mode)!
    m.total++
    if (r.baseline_pass)  m.base_pass++
    if (r.corrected_pass) m.spread_pass++
  }
  console.log('\n=== By print mode ===')
  for (const [mode, m] of [...modeMap.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(
      `  ${mode.padEnd(24)} base=${m.base_pass}/${m.total}` +
      ` (${(100*m.base_pass/m.total).toFixed(0)}%)` +
      `  spread=${m.spread_pass}/${m.total}` +
      ` (${(100*m.spread_pass/m.total).toFixed(0)}%)`
    )
  }

  // ── Acceptance gate check ─────────────────────────────────────────────────
  const artPeelPairs = results.filter(r => r.ref.includes('ArtPeelBlckt') || r.tgt.includes('ArtPeelBlckt'))
  const artPeelMed   = artPeelPairs.map(r => r.corrected_med)
  console.log('\n=== H23b Acceptance Gate ===')
  console.log(`  Gate 1: ArtPeelBlckt pairs corrected med ≤ 1.5`)
  for (const r of artPeelPairs) {
    const ok = r.corrected_med <= 1.5
    console.log(`    ${ok ? 'PASS' : 'FAIL'}: med=${r.corrected_med.toFixed(3)} (baseline=${r.baseline_med.toFixed(3)})`)
  }
  console.log(`  Gate 2: Non-metallic pass rate ≥ 90%`)
  console.log(`    ${(100*spread_pass/total).toFixed(1)}% (${spread_pass}/${total})  gate=${(100*90/100).toFixed(1)}%  ${spread_pass/total >= 0.90 ? 'PASS' : 'FAIL'}`)
}

main().catch(console.error)
