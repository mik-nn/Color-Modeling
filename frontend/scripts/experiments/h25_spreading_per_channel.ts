// frontend/scripts/experiments/h25_spreading_per_channel.ts
//
// H25 — Per-channel per-λ spreading correction.
//
// H24 used neutral-ramp (R=G=B patches) to fit a single combined-channel
// spreading proxy a_eff=(3·255−R−G−B)/(3·255). For chromatic high-ink patches
// this under- or over-estimates the spreading of individual channels.
//
// H25: fit independent quadratic f_X(a_X, λ) from SINGLE-CHANNEL ramp patches:
//   C-ramp: G=B=255 patches (9 in the 905-patch grid)
//   M-ramp: R=B=255 patches (10 in the grid)
//   Y-ramp: R=G=255 patches (9 in the grid)
//
// Per-patch correction: ink-weighted average of per-channel ratios.
//   s_total(a_C, a_M, a_Y, λ) = (a_C·s_C + a_M·s_M + a_Y·s_Y) / max(a_C+a_M+a_Y, ε)
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h25_spreading_per_channel.ts"

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

const ROOT          = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const DIAG_JSON     = path.resolve(process.cwd(), 'data/cae-input/h_diagnose_failing.json')
const MIN_MATCH     = 100
const UV_BAND_COUNT = 4
const RANK          = 5
const K             = 13
const S_CLAMP_LO    = 0.5
const S_CLAMP_HI    = 2.0
const EPS           = 1e-6
// Tolerance for "pure channel" ramp: how much the OTHER channels may deviate from 255
const RAMP_TOL      = 8
// Minimum total spreading deviation to apply correction (avoids noise regressions)
const SPREAD_THR    = 0.10
const METALLIC_RE   = /Silverada|VibranceMetallic/i

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

/** Least-squares y = 1 + c1·x + c2·x² (intercept forced to 1). */
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

/**
 * Return indices of single-channel ramp patches for a given channel.
 *   channel 0 = C: varies R (a_C = (255-R)/255), G≈255, B≈255
 *   channel 1 = M: varies G (a_M = (255-G)/255), R≈255, B≈255
 *   channel 2 = Y: varies B (a_Y = (255-B)/255), R≈255, G≈255
 */
function channelRampIndices(device: Float64Array, N: number, channel: 0|1|2, tol = RAMP_TOL): number[] {
  const out: number[] = []
  for (let i = 0; i < N; i++) {
    const r = device[i * 3], g = device[i * 3 + 1], b = device[i * 3 + 2]
    if (channel === 0 && g >= 255 - tol && b >= 255 - tol) out.push(i)
    if (channel === 1 && r >= 255 - tol && b >= 255 - tol) out.push(i)
    if (channel === 2 && r >= 255 - tol && g >= 255 - tol) out.push(i)
  }
  return out
}

/**
 * Fit per-λ quadratic spreading curves from single-channel ramp patches.
 * Returns c1[L] and c2[L].
 * The ink density for each patch is a_ch = (255 − device[ch]) / 255.
 */
function fitChannelSpreadingPerLambda(
  spectra: Float64Array,
  device: Float64Array,
  rowIndices: number[],
  channel: 0|1|2,
  L: number,
  paperRowIdx: number,
): { c1: Float64Array; c2: Float64Array } {
  const c1 = new Float64Array(L)
  const c2 = new Float64Array(L)

  const ais = rowIndices.map(i => {
    const v = device[i * 3 + channel]
    return (255 - v) / 255
  })

  for (let l = 0; l < L; l++) {
    const paperVal = spectra[paperRowIdx * L + l]
    if (paperVal < 1e-5) continue
    const xs: number[] = [], ys: number[] = []
    for (let k = 0; k < rowIndices.length; k++) {
      const a = ais[k]
      if (a < 0.005) continue  // skip near-paper
      xs.push(a)
      ys.push(spectra[rowIndices[k] * L + l] / paperVal)
    }
    if (xs.length >= 2) {
      const [_c1, _c2] = fitQuadNoBias(xs, ys)
      c1[l] = _c1; c2[l] = _c2
    }
  }
  return { c1, c2 }
}

/**
 * Pre-correct X_A using per-channel per-λ ink-weighted spreading ratio.
 *
 * For each patch i:
 *   a_C = (255-R)/255,  a_M = (255-G)/255,  a_Y = (255-B)/255
 *   s_X(a_X, λ) = clamp( f_B_X(a_X,λ) / f_A_X(a_X,λ) )
 *   s_total(λ)  = (a_C·s_C + a_M·s_M + a_Y·s_Y) / max(a_C+a_M+a_Y, ε)
 */
function preCorrectSpreadingPerChannel(
  X_A: Float64Array,
  device_A: Float64Array,
  N: number, L: number,
  cA: Array<{ c1: Float64Array; c2: Float64Array }>,  // [C, M, Y]
  cB: Array<{ c1: Float64Array; c2: Float64Array }>,
): Float64Array {
  const out = new Float64Array(X_A)
  for (let i = 0; i < N; i++) {
    const r = device_A[i * 3], g = device_A[i * 3 + 1], b = device_A[i * 3 + 2]
    const aC = (255 - r) / 255
    const aM = (255 - g) / 255
    const aY = (255 - b) / 255
    const wTot = aC + aM + aY
    if (wTot < 0.01) continue  // near-paper — no correction

    for (let l = 0; l < L; l++) {
      // Per-channel spreading ratio at this λ
      const sArr: number[] = []
      const wArr: number[] = [aC, aM, aY]
      for (let ch = 0; ch < 3; ch++) {
        const a = wArr[ch]
        const a2 = a * a
        const fA = 1 + cA[ch].c1[l] * a + cA[ch].c2[l] * a2
        const fB = 1 + cB[ch].c1[l] * a + cB[ch].c2[l] * a2
        const s = Math.abs(fA) < 0.01 ? 1.0
          : Math.max(S_CLAMP_LO, Math.min(S_CLAMP_HI, fB / fA))
        sArr.push(s)
      }
      // Ink-weighted average
      const sTotal = (wArr[0] * sArr[0] + wArr[1] * sArr[1] + wArr[2] * sArr[2])
        / Math.max(wTot, EPS)
      out[i * L + l] *= sTotal
    }
  }
  return out
}

/** Compute dSpread (scalar at 560nm) for neutral direction — used for threshold check. */
function neutralDSpread560(
  spectra: Float64Array, device: Float64Array,
  N: number, L: number, paperRowIdx: number,
): number {
  const IDX = 18  // (560-380)/10
  const paper = spectra[paperRowIdx * L + IDX]
  if (paper < 1e-4) return 0
  const neutIdx = []
  for (let i = 0; i < N; i++) {
    const r = device[i*3], g = device[i*3+1], b = device[i*3+2]
    if (Math.abs(r-g)+Math.abs(g-b) <= 10 && i !== paperRowIdx) neutIdx.push(i)
  }
  const xs: number[] = [], ys: number[] = []
  for (const i of neutIdx) {
    const a = (765-device[i*3]-device[i*3+1]-device[i*3+2])/765
    if (a < 0.01) continue
    xs.push(a); ys.push(spectra[i*L+IDX]/paper)
  }
  return xs.length >= 2 ? Math.abs(fitQuadNoBias(xs, ys)[0]) : 0
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
  dSpread560: number
  cRampN: number; mRampN: number; yRampN: number
}

async function evalPair(
  profA: LoadedProfile, profB: LoadedProfile,
): Promise<PairResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D } = al
  const L = profA.wavelengths.length

  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i*3] === 255 && D[i*3+1] === 255 && D[i*3+2] === 255) { paperRowIdx = i; break }
  }

  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP   = paperWPFromBrightestPatch(
    new Float64Array(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)), 1, L, 380)

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

  // ── Per-channel spreading fit (oracle: all ramp patches of both profiles) ──
  const ds560A = neutralDSpread560(X_A_clean, D, N, L, paperRowIdx)
  const ds560B = neutralDSpread560(X_B_clean, D, N, L, paperRowIdx)
  const dSpread560 = Math.abs(ds560B - ds560A)

  const cRampA_idx  = channelRampIndices(D, N, 0)
  const mRampA_idx  = channelRampIndices(D, N, 1)
  const yRampA_idx  = channelRampIndices(D, N, 2)

  let X_pred_corr: Float64Array

  if (dSpread560 > SPREAD_THR && cRampA_idx.length >= 2 && mRampA_idx.length >= 2 && yRampA_idx.length >= 2) {
    const fitA = [
      fitChannelSpreadingPerLambda(X_A_clean, D, cRampA_idx, 0, L, paperRowIdx),
      fitChannelSpreadingPerLambda(X_A_clean, D, mRampA_idx, 1, L, paperRowIdx),
      fitChannelSpreadingPerLambda(X_A_clean, D, yRampA_idx, 2, L, paperRowIdx),
    ]
    const fitB = [
      fitChannelSpreadingPerLambda(X_B_clean, D, cRampA_idx, 0, L, paperRowIdx),
      fitChannelSpreadingPerLambda(X_B_clean, D, mRampA_idx, 1, L, paperRowIdx),
      fitChannelSpreadingPerLambda(X_B_clean, D, yRampA_idx, 2, L, paperRowIdx),
    ]
    const X_A_corr = preCorrectSpreadingPerChannel(X_A_clean, D, N, L, fitA, fitB)
    const d1corr = runPaperRatioResidualTransfer({
      X_A: X_A_corr, X_B: X_B_clean, D, sampleIds: al.sampleIds,
      anchorIdx, paperRowIdx, L, paperWP,
      refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
      residualRank: RANK, knnK: 4, uvBandCount: UV_BAND_COUNT,
    })
    X_pred_corr = addOBA(d1corr.X_pred, L, fB, emB.emission)
  } else {
    X_pred_corr = X_pred_base
  }

  // ── Metrics ──────────────────────────────────────────────────────────────────
  const des_base: number[] = [], des_corr: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pb = Array.from(X_pred_base.subarray(i*L, i*L+L))
    const pc = Array.from(X_pred_corr.subarray(i*L, i*L+L))
    const m  = Array.from(X_B.subarray(i*L, i*L+L))
    const lm = spectraToLab(m), lb = spectraToLab(pb), lc = spectraToLab(pc)
    des_base.push(deltaE00(lb[0],lb[1],lb[2],lm[0],lm[1],lm[2]))
    des_corr.push(deltaE00(lc[0],lc[1],lc[2],lm[0],lm[1],lm[2]))
  }

  const bMed = median(des_base), bP95 = p95(des_base)
  const cMed = median(des_corr), cP95 = p95(des_corr)

  return {
    ref: profA.metadata.full_name, tgt: profB.metadata.full_name,
    mode: profA.metadata.printMode,
    baseline_med: bMed,  baseline_p95: bP95,  baseline_pass: bMed <= 1.5 && bP95 <= 3.0,
    corrected_med: cMed, corrected_p95: cP95, corrected_pass: cMed <= 1.5 && cP95 <= 3.0,
    dSpread560,
    cRampN: cRampA_idx.length, mRampN: mRampA_idx.length, yRampN: yRampA_idx.length,
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const diagRaw   = JSON.parse(await fs.readFile(DIAG_JSON, 'utf8'))
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

  const base_pass = results.filter(r => r.baseline_pass).length
  const corr_pass = results.filter(r => r.corrected_pass).length
  const total     = results.length

  console.log(`\n=== H25 Results (non-metallic, k=${K}, oracle per-channel per-λ) ===`)
  console.log(`Total pairs          : ${total}`)
  console.log(`Baseline D1          : ${base_pass}/${total} = ${(100*base_pass/total).toFixed(1)}%`)
  console.log(`D1 + per-ch spread   : ${corr_pass}/${total} = ${(100*corr_pass/total).toFixed(1)}%`)
  const nCorr = results.filter(r => r.dSpread560 > SPREAD_THR).length
  console.log(`Correction applied   : ${nCorr} pairs (dSpread560 > ${SPREAD_THR})`)

  const newPass = results.filter(r => !r.baseline_pass &&  r.corrected_pass)
  const newFail = results.filter(r =>  r.baseline_pass && !r.corrected_pass)
  console.log(`\nNewly passing: ${newPass.length}`)
  for (const r of newPass) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread560=${r.dSpread560.toFixed(3)}  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`)
  }
  console.log(`\nRegressions: ${newFail.length}`)
  for (const r of newFail) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread560=${r.dSpread560.toFixed(3)}  base: med=${r.baseline_med.toFixed(3)} p95=${r.baseline_p95.toFixed(3)}  → corr: med=${r.corrected_med.toFixed(3)} p95=${r.corrected_p95.toFixed(3)}`)
  }

  console.log(`\nStill failing: ${results.filter(r => !r.corrected_pass).length}`)
  for (const r of results.filter(r => !r.corrected_pass).sort((a, b) => b.corrected_p95 - a.corrected_p95)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const tag = knownFail.has(`${r.ref}↔${r.tgt}`) ? 'known' : 'NEW'
    console.log(`  [${tag}] ${rn.padEnd(22)} → ${tn.padEnd(22)}  dSpread=${r.dSpread560.toFixed(3)}  Δmed=${(r.corrected_med-r.baseline_med).toFixed(3).padStart(7)}  Δp95=${(r.corrected_p95-r.baseline_p95).toFixed(3).padStart(7)}  base p95=${r.baseline_p95.toFixed(3)}  corr p95=${r.corrected_p95.toFixed(3)}`)
  }

  const spotlight = ['ArtPeelBlckt', 'DecorMatte', '1930', 'BelgianLinen', 'ChromataWhite', 'Lyve', '800M']
  console.log('\n=== Spotlight pairs ===')
  for (const r of results.filter(r => spotlight.some(s => r.ref.includes(s) || r.tgt.includes(s))).sort((a, b) => b.dSpread560 - a.dSpread560)) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    const mark = r.baseline_pass === r.corrected_pass ? '  ' : !r.baseline_pass && r.corrected_pass ? '✓ ' : '✗ '
    console.log(`  ${mark}${rn.padEnd(20)} → ${tn.padEnd(20)}  dSpread=${r.dSpread560.toFixed(3)}  Δmed=${(r.corrected_med-r.baseline_med).toFixed(3).padStart(7)}  Δp95=${(r.corrected_p95-r.baseline_p95).toFixed(3).padStart(7)}  base p95=${r.baseline_p95.toFixed(3)}  corr p95=${r.corrected_p95.toFixed(3)}`)
  }

  console.log('\n=== H25 Acceptance Gates ===')
  const artPeelPairs = results.filter(r => r.ref.includes('ArtPeelBlckt') || r.tgt.includes('ArtPeelBlckt'))
  console.log('  Gate 1: ArtPeelBlckt corrected med ≤ 1.5')
  for (const r of artPeelPairs) {
    const rn = r.ref.replace('BC_','').replace(/_P9000_.+/,'')
    const tn = r.tgt.replace('BC_','').replace(/_P9000_.+/,'')
    console.log(`    ${r.corrected_med <= 1.5 ? 'PASS' : 'FAIL'}: ${rn}→${tn}  med=${r.corrected_med.toFixed(3)} (base=${r.baseline_med.toFixed(3)})`)
  }
  const pct = 100 * corr_pass / total
  console.log(`  Gate 2: Non-metallic pass rate ≥ 90%: ${pct.toFixed(1)}% — ${pct >= 90 ? 'PASS' : 'FAIL'}`)
  console.log(`  Gate 3: No regressions:               ${corr_pass >= base_pass ? 'PASS' : 'FAIL'} (${corr_pass}/${total} vs baseline ${base_pass}/${total})`)

  // Compare vs H24
  console.log('\n=== vs H24 (neutral per-λ, same threshold) ===')
  console.log('  H24 results: 92/104=88.5%, 0 regressions')
  console.log(`  H25 results: ${corr_pass}/${total}=${pct.toFixed(1)}%, ${newFail.length} regressions`)
}

main().catch(console.error)
