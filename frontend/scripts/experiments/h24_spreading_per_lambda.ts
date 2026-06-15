// frontend/scripts/experiments/h24_spreading_per_lambda.ts
//
// H24 — Per-wavelength spreading correction.
//
// H23b showed that a scalar correction at 560 nm is insufficient because:
//   1. c1(λ), c2(λ) vary across wavelengths (per-ink absorption spectral selectivity)
//   2. OBA (UV fluorescence, λ<450 nm) has the WRONG sign at 560 nm
//
// Fix: fit independent quadratic f(a, λ) = 1 + c1(λ)·a + c2(λ)·a² for each
// of the 36 wavelength bands from neutral-ramp patches. Apply the ratio
//   s(a_i, λ) = clamp( f_B(a_i, λ) / f_A(a_i, λ), 0.5, 2.0 )
// per-band to all patches in X_A before running D1.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h24_spreading_per_lambda.ts"

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

const ROOT           = path.resolve(process.cwd(), '..')
const PROFILES_ROOT  = path.resolve(ROOT, 'data/profiles')
const DIAG_JSON      = path.resolve(process.cwd(), 'data/cae-input/h_diagnose_failing.json')
const MIN_MATCH      = 100
const UV_BAND_COUNT  = 4
const RANK           = 5
const K              = 13
const IDX_560        = 18   // (560-380)/10 — used for dSpread scalar threshold check
const S_CLAMP_LO     = 0.5
const S_CLAMP_HI     = 2.0
const SPREAD_THR     = 0.10 // minimum dSpread@560nm to apply correction
const METALLIC_RE    = /Silverada|VibranceMetallic/i

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

/** Least-squares fit y = 1 + c1·x + c2·x² (intercept forced to 1). */
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

/** Return indices of neutral patches (R=G=B within tol). */
function neutralIndices(device: Float64Array, N: number, tol = 10): number[] {
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    const r = device[i * 3], g = device[i * 3 + 1], b = device[i * 3 + 2]
    if (Math.abs(r - g) + Math.abs(g - b) <= tol) out.push(i)
  }
  return out
}

/**
 * Fit per-λ spreading curves from neutral patches.
 * Returns c1[L] and c2[L] — one quadratic coefficient pair per wavelength band.
 * Intercept forced to 1 (paper patch = normalised to 1 at each λ).
 */
function fitSpreadingPerLambda(
  spectra: Float64Array,
  device: Float64Array,
  rowIndices: number[],
  L: number,
  paperRowIdx: number,
): { c1: Float64Array; c2: Float64Array } {
  const c1 = new Float64Array(L)
  const c2 = new Float64Array(L)

  // Precompute a_i for neutral patches
  const ais = rowIndices.map(i => {
    const r = device[i * 3], g = device[i * 3 + 1], b = device[i * 3 + 2]
    return (765 - r - g - b) / 765
  })

  for (let l = 0; l < L; l++) {
    const paperVal = spectra[paperRowIdx * L + l]
    if (paperVal < 1e-5) continue  // degenerate band — skip, c1=c2=0

    const xs: number[] = [], ys: number[] = []
    for (let k = 0; k < rowIndices.length; k++) {
      const a = ais[k]
      if (a < 0.01) continue  // skip paper itself
      const rnorm = spectra[rowIndices[k] * L + l] / paperVal
      xs.push(a)
      ys.push(rnorm)
    }
    if (xs.length >= 2) {
      const [_c1, _c2] = fitQuadNoBias(xs, ys)
      c1[l] = _c1; c2[l] = _c2
    }
  }
  return { c1, c2 }
}

/**
 * Pre-correct spectra_A using per-λ spreading ratio.
 * For each patch i: R_corr[i,λ] = R_A[i,λ] * s(a_i, λ)
 * where s(a,λ) = clamp( (1+c1B[λ]*a+c2B[λ]*a²) / (1+c1A[λ]*a+c2A[λ]*a²), 0.5, 2.0 )
 */
function preCorrectSpreadingPerLambda(
  X_A: Float64Array,
  device_A: Float64Array,
  N: number, L: number,
  c1A: Float64Array, c2A: Float64Array,
  c1B: Float64Array, c2B: Float64Array,
): Float64Array {
  const out = new Float64Array(X_A)
  for (let i = 0; i < N; i++) {
    const r = device_A[i * 3], g = device_A[i * 3 + 1], b = device_A[i * 3 + 2]
    const a = (765 - r - g - b) / 765
    if (a < 0.01) continue  // paper patch — leave unchanged
    const a2 = a * a
    for (let l = 0; l < L; l++) {
      const fA = 1 + c1A[l] * a + c2A[l] * a2
      const fB = 1 + c1B[l] * a + c2B[l] * a2
      if (Math.abs(fA) < 0.01) continue
      const s = Math.max(S_CLAMP_LO, Math.min(S_CLAMP_HI, fB / fA))
      out[i * L + l] *= s
    }
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
  baseline_med: number;  baseline_p95: number;  baseline_pass: boolean
  corrected_med: number; corrected_p95: number; corrected_pass: boolean
  dSpread560: number; neutral_k: number
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

  // OBA separation
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP   = paperWPFromBrightestPatch(
    new Float64Array(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)), 1, L, 380)

  // Anchor selection
  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, K)
  const anchorSet = new Set(anchorIdx)

  // ── Baseline D1 ─────────────────────────────────────────────────────────────
  const d1base = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D, sampleIds: al.sampleIds,
    anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred_base = addOBA(d1base.X_pred, L, fB, emB.emission)

  // ── Per-λ spreading correction ───────────────────────────────────────────────
  const neutralA  = neutralIndices(D, N)
  const neutralB  = neutralIndices(D, N).filter(i => i !== paperRowIdx)

  // Compute scalar dSpread at 560nm for threshold check
  const paper560_A = X_A_clean[paperRowIdx * L + IDX_560]
  const paper560_B = X_B_clean[paperRowIdx * L + IDX_560]
  const xs_A: number[] = [], ys_A: number[] = []
  const xs_B: number[] = [], ys_B: number[] = []
  for (const i of neutralA) {
    const a = (765 - D[i*3] - D[i*3+1] - D[i*3+2]) / 765
    if (a < 0.01) continue
    xs_A.push(a); ys_A.push(paper560_A > 1e-4 ? X_A_clean[i*L+IDX_560]/paper560_A : 1)
  }
  for (const i of neutralB) {
    const a = (765 - D[i*3] - D[i*3+1] - D[i*3+2]) / 765
    if (a < 0.01) continue
    xs_B.push(a); ys_B.push(paper560_B > 1e-4 ? X_B_clean[i*L+IDX_560]/paper560_B : 1)
  }
  const [c1A560, c2A560] = fitQuadNoBias(xs_A, ys_A)
  const [c1B560, c2B560] = fitQuadNoBias(xs_B, ys_B)
  const dSpread560 = Math.sqrt((c1B560-c1A560)**2 + (c2B560-c2A560)**2)

  let X_pred_corr: Float64Array
  if (dSpread560 > SPREAD_THR && neutralB.length >= 4) {
    // Fit per-λ curves (oracle: all neutral patches)
    const fitA = fitSpreadingPerLambda(X_A_clean, D, neutralA, L, paperRowIdx)
    const fitB = fitSpreadingPerLambda(X_B_clean, D, neutralB, L, paperRowIdx)
    const X_A_corr = preCorrectSpreadingPerLambda(X_A_clean, D, N, L, fitA.c1, fitA.c2, fitB.c1, fitB.c2)
    const d1corr = runPaperRatioResidualTransfer({
      X_A: X_A_corr, X_B: X_B_clean, D, sampleIds: al.sampleIds,
      anchorIdx, paperRowIdx, L, paperWP,
      refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
      residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
    })
    X_pred_corr = addOBA(d1corr.X_pred, L, fB, emB.emission)
  } else {
    // Below threshold — no correction, copy baseline
    X_pred_corr = X_pred_base
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const des_base: number[] = [], des_corr: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pred_b = Array.from(X_pred_base.subarray(i * L, i * L + L))
    const pred_c = Array.from(X_pred_corr.subarray(i * L, i * L + L))
    const meas   = Array.from(X_B.subarray(i * L, i * L + L))
    const lm = spectraToLab(meas), lb = spectraToLab(pred_b), lc = spectraToLab(pred_c)
    des_base.push(deltaE00(lb[0], lb[1], lb[2], lm[0], lm[1], lm[2]))
    des_corr.push(deltaE00(lc[0], lc[1], lc[2], lm[0], lm[1], lm[2]))
  }

  const bMed = median(des_base), bP95 = p95(des_base)
  const cMed = median(des_corr), cP95 = p95(des_corr)

  return {
    ref: profA.metadata.full_name, tgt: profB.metadata.full_name,
    mode: profA.metadata.printMode,
    baseline_med: bMed,  baseline_p95: bP95,  baseline_pass: bMed <= 1.5 && bP95 <= 3.0,
    corrected_med: cMed, corrected_p95: cP95, corrected_pass: cMed <= 1.5 && cP95 <= 3.0,
    dSpread560, neutral_k: neutralB.length,
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const diagRaw  = JSON.parse(await fs.readFile(DIAG_JSON, 'utf8'))
  const knownFail = new Set<string>(
    diagRaw.failing.map((r: { ref: string; tgt: string }) => `${r.ref}↔${r.tgt}`),
  )

  const files    = (await walk(PROFILES_ROOT)).sort()
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

  const base_pass  = results.filter(r => r.baseline_pass).length
  const corr_pass  = results.filter(r => r.corrected_pass).length
  const total      = results.length

  console.log(`\n=== H24 Results (non-metallic pairs, k=${K}, oracle per-λ spreading) ===`)
  console.log(`Total pairs evaluated : ${total}`)
  console.log(`Baseline D1           : ${base_pass}/${total} = ${(100*base_pass/total).toFixed(1)}%`)
  console.log(`D1 + per-λ spreading  : ${corr_pass}/${total} = ${(100*corr_pass/total).toFixed(1)}%`)
  console.log(`Correction applied to : ${results.filter(r => r.dSpread560 > SPREAD_THR).length} pairs (dSpread560 > ${SPREAD_THR})`)

  const newPass = results.filter(r => !r.baseline_pass &&  r.corrected_pass)
  const newFail = results.filter(r =>  r.baseline_pass && !r.corrected_pass)
  console.log(`\nNewly passing : ${newPass.length}`)
  for (const r of newPass.sort((a, b) => a.dSpread560 - b.dSpread560)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread560=${r.dSpread560.toFixed(3)}  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`)
  }
  console.log(`\nRegressions   : ${newFail.length}`)
  for (const r of newFail.sort((a, b) => b.corrected_p95 - a.corrected_p95)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread560=${r.dSpread560.toFixed(3)}  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`)
  }

  console.log(`\nStill failing : ${results.filter(r => !r.corrected_pass).length}`)
  for (const r of results.filter(r => !r.corrected_pass).sort((a, b) => b.corrected_p95 - a.corrected_p95)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const tag = knownFail.has(`${r.ref}↔${r.tgt}`) ? 'known' : 'NEW'
    console.log(`  [${tag}] ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread560=${r.dSpread560.toFixed(3)}  Δmed=${(r.corrected_med-r.baseline_med).toFixed(3).padStart(7)}  Δp95=${(r.corrected_p95-r.baseline_p95).toFixed(3).padStart(7)}  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}  corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`)
  }

  // Spotlight: high-dSpread pairs
  const spotlight = ['ArtPeelBlckt', 'DecorMatte', '1930', 'BelgianLinen', 'ChromataWhite', 'Lyve', '800M']
  console.log('\n=== Spotlight pairs ===')
  for (const r of results.filter(r => spotlight.some(s => r.ref.includes(s) || r.tgt.includes(s))).sort((a, b) => b.dSpread560 - a.dSpread560)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const mark = r.baseline_pass === r.corrected_pass ? '  ' : !r.baseline_pass && r.corrected_pass ? '✓ ' : '✗ '
    console.log(`  ${mark}${rn.padEnd(20)} → ${tn.padEnd(20)}  dSpread560=${r.dSpread560.toFixed(3)}  Δmed=${(r.corrected_med-r.baseline_med).toFixed(3).padStart(7)}  Δp95=${(r.corrected_p95-r.baseline_p95).toFixed(3).padStart(7)}  base: p95=${r.baseline_p95.toFixed(3)}  corr: p95=${r.corrected_p95.toFixed(3)}`)
  }

  // Acceptance gates
  console.log('\n=== H24 Acceptance Gates ===')
  const artPeelPairs = results.filter(r => r.ref.includes('ArtPeelBlckt') || r.tgt.includes('ArtPeelBlckt'))
  console.log(`  Gate 1: ArtPeelBlckt corrected med ≤ 1.5`)
  for (const r of artPeelPairs) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`    ${r.corrected_med <= 1.5 ? 'PASS' : 'FAIL'}: ${rn}→${tn}  med=${r.corrected_med.toFixed(3)} (base=${r.baseline_med.toFixed(3)})`)
  }
  const pct = 100 * corr_pass / total
  console.log(`  Gate 2: Non-metallic pass rate ≥ 90%: ${pct.toFixed(1)}% — ${pct >= 90 ? 'PASS' : 'FAIL'}`)
  console.log(`  Gate 3: No regressions (≥ baseline 88.5%): ${pct.toFixed(1)}% — ${corr_pass >= base_pass ? 'PASS' : 'FAIL'}`)
}

main().catch(console.error)
