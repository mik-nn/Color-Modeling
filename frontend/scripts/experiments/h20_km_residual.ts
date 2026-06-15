// frontend/scripts/experiments/h20_km_residual.ts
//
// H20 — D1-KM: Kubelka-Munk space paper correction vs D1 reflectance-ratio.
//
// Physics: substrate change = additive shift in K-M remission space K/S = (1-R)²/(2R),
// not multiplicative in reflectance space.  D1-KM applies the paper ΔKS offset first,
// then a PCA+kNN residual in K-M space (same structure as D1 but transformed).
//
// OBA handling: subtract OBA in reflectance space → transform to K-M → fit → back to R
// → add OBA.  Identical to D1 pipeline except the inner loop is in K-M space.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h20_km_residual.ts"

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
import { fitPCA, pcaProject, pcaReconstruct, type PCABasis } from '../../src/lib/dataset/basis'
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')
const OUT_JSON = path.resolve(process.cwd(), 'data/cae-input/h20_km_residual.json')
const MIN_MATCH = 100
const UV_BAND_COUNT = 4
const RESIDUAL_RANK = 5
const KNN_K = 4

// ── K-M helpers ─────────────────────────────────────────────────────────────

function toKM(r: number): number {
  const rg = Math.max(r, 1e-4)
  return (1 - rg) * (1 - rg) / (2 * rg)
}

function fromKM(ks: number): number {
  const ks0 = Math.max(ks, 0)
  // R = 1 + K/S - sqrt(K/S^2 + 2*K/S) = 1 + K/S - sqrt(K/S * (K/S + 2))
  return Math.max(0, Math.min(1, 1 + ks0 - Math.sqrt(ks0 * (ks0 + 2))))
}

function matToKM(X: Float64Array): Float64Array {
  const out = new Float64Array(X.length)
  for (let i = 0; i < X.length; i++) out[i] = toKM(X[i])
  return out
}

function matFromKM(KS: Float64Array): Float64Array {
  const out = new Float64Array(KS.length)
  for (let i = 0; i < KS.length; i++) out[i] = fromKM(KS[i])
  return out
}

// ── kNN IDW interpolation (mirrors paperRatioResidual.ts) ───────────────────

function knnInterpolate(
  D_anchors: Float64Array, anchorScores: Float64Array, p: number,
  D_query: Float64Array, K: number,
): Float64Array {
  const kAnchors = anchorScores.length / p
  const M = D_query.length / 3
  const out = new Float64Array(M * p)
  const Keff = Math.min(K, kAnchors)
  const dists: { idx: number; d: number }[] = new Array(kAnchors)
  for (let q = 0; q < M; q++) {
    const qr = D_query[q * 3], qg = D_query[q * 3 + 1], qb = D_query[q * 3 + 2]
    for (let a = 0; a < kAnchors; a++) {
      const dr = D_anchors[a * 3] - qr
      const dg = D_anchors[a * 3 + 1] - qg
      const db = D_anchors[a * 3 + 2] - qb
      dists[a] = { idx: a, d: Math.sqrt(dr * dr + dg * dg + db * db) }
    }
    dists.sort((u, v) => u.d - v.d)
    let wSum = 0
    const w = new Array<number>(Keff)
    for (let j = 0; j < Keff; j++) { w[j] = 1 / (dists[j].d + 1e-6); wSum += w[j] }
    for (let c = 0; c < p; c++) {
      let s = 0
      for (let j = 0; j < Keff; j++) s += w[j] * anchorScores[dists[j].idx * p + c]
      out[q * p + c] = s / wSum
    }
  }
  return out
}

// ── D1-KM predictor ──────────────────────────────────────────────────────────

/**
 * Predict X_B_clean from X_A_clean using Kubelka-Munk paper correction
 * + PCA residual in K-M space.  Input/output in reflectance space [0,1].
 */
function predictKMResidual(
  X_A_clean: Float64Array,
  X_B_clean: Float64Array,
  D: Float64Array,
  L: number,
  anchorIdx: number[],
  paperRowIdx: number,
): Float64Array {
  const N = X_A_clean.length / L
  const KS_A = matToKM(X_A_clean)
  const KS_B = matToKM(X_B_clean)

  // Paper ΔKS
  const dksPaper = new Float64Array(L)
  for (let l = 0; l < L; l++) {
    dksPaper[l] = KS_B[paperRowIdx * L + l] - KS_A[paperRowIdx * L + l]
  }

  // First-order K-M prediction
  const KS_pred1 = new Float64Array(N * L)
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      KS_pred1[i * L + l] = KS_A[i * L + l] + dksPaper[l]
    }
  }

  const residualIdx = anchorIdx.filter(i => i !== paperRowIdx)
  const kRes = residualIdx.length
  if (kRes === 0) return matFromKM(KS_pred1)

  // K-M residuals at non-paper anchors
  const epsKS = new Float64Array(kRes * L)
  for (let a = 0; a < kRes; a++) {
    const src = residualIdx[a]
    for (let l = 0; l < L; l++) {
      epsKS[a * L + l] = KS_B[src * L + l] - KS_pred1[src * L + l]
    }
  }

  // PCA on K-M residuals
  const pKeep = Math.min(RESIDUAL_RANK, kRes < 2 ? 1 : kRes - 1, L)
  let basis: PCABasis
  if (kRes < 2) {
    const v = new Float64Array(L)
    let norm = 0
    for (let l = 0; l < L; l++) norm += epsKS[l] * epsKS[l]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let l = 0; l < L; l++) v[l] = epsKS[l] / norm
    basis = { mean: new Float64Array(L), V: v, eigenvalues: Float64Array.from([norm * norm]), L, p: 1 }
  } else {
    basis = fitPCA(epsKS, kRes, L, Math.max(1, pKeep))
  }
  const scores = pcaProject(epsKS, kRes, basis)

  // kNN in RGB space
  const anchorRGB = new Float64Array(kRes * 3)
  for (let a = 0; a < kRes; a++) {
    const src = residualIdx[a]
    anchorRGB[a * 3] = D[src * 3]
    anchorRGB[a * 3 + 1] = D[src * 3 + 1]
    anchorRGB[a * 3 + 2] = D[src * 3 + 2]
  }
  const qScores = knnInterpolate(anchorRGB, scores, basis.p, D, KNN_K)
  const dKS = pcaReconstruct(qScores, N, basis)

  // Apply correction and convert back to R
  const KS_pred = new Float64Array(N * L)
  for (let i = 0; i < N * L; i++) KS_pred[i] = Math.max(0, KS_pred1[i] + dKS[i])
  return matFromKM(KS_pred)
}

// ── Stats helpers ────────────────────────────────────────────────────────────

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

// total CMY ink coverage [0, 3]: (255-R)/255 + (255-G)/255 + (255-B)/255
function totalInk(r: number, g: number, b: number): number {
  return (3 * 255 - r - g - b) / 255
}

// ── Profile loader ───────────────────────────────────────────────────────────

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

async function loadProfile(filePath: string): Promise<(ProfileData & { wavelengths: number[] }) | null> {
  try {
    const buf = await fs.readFile(filePath)
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: {
        full_name: name, brand: name.startsWith('BC') ? 'BC' : 'MOAB',
        series: name, printer: 'P9000', ink: 'mk', substrate: name,
        parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

// ── Per-pair evaluation ──────────────────────────────────────────────────────

interface PairResult {
  d1_med: number; d1_p95: number; d1_pass: boolean
  km_med: number; km_p95: number; km_pass: boolean
  // same but restricted to high-ink patches (total_ink > 1.5)
  d1_hi_med: number; d1_hi_p95: number
  km_hi_med: number; km_hi_p95: number
  n_hi: number
}

async function evalPair(
  profA: ProfileData & { wavelengths: number[] },
  profB: ProfileData & { wavelengths: number[] },
  k: number,
): Promise<PairResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D } = al
  const L = profA.wavelengths.length

  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break }
  }
  const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(paperSpecA)
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)
  const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, 380)

  // Greedy anchors from target (B) profile
  const tgt = { X: X_B, D, channels: 3 as const, N, L, wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const anchorIdx = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, k)
  const anchorSet = new Set(anchorIdx)

  // ── D1 baseline ──────────────────────────────────────────────────────────
  const d1 = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D, sampleIds: al.sampleIds,
    anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RESIDUAL_RANK, knnK: KNN_K, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred_d1 = addOBA(d1.X_pred, L, fB, emB.emission)

  // ── D1-KM ────────────────────────────────────────────────────────────────
  const X_pred_km_clean = predictKMResidual(X_A_clean, X_B_clean, D, L, anchorIdx, paperRowIdx)
  const X_pred_km = addOBA(X_pred_km_clean, L, fB, emB.emission)

  // ── ΔE₀₀ on non-anchor test patches ─────────────────────────────────────
  const d1_des: number[] = [], km_des: number[] = []
  const d1_hi: number[] = [], km_hi: number[] = []

  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pred_d1 = Array.from(X_pred_d1.subarray(i * L, i * L + L))
    const pred_km = Array.from(X_pred_km.subarray(i * L, i * L + L))
    const meas    = Array.from(X_B.subarray(i * L, i * L + L))

    const ld1 = spectraToLab(pred_d1), lkm = spectraToLab(pred_km), lm = spectraToLab(meas)
    const de_d1 = deltaE00(ld1[0], ld1[1], ld1[2], lm[0], lm[1], lm[2])
    const de_km = deltaE00(lkm[0], lkm[1], lkm[2], lm[0], lm[1], lm[2])
    d1_des.push(de_d1)
    km_des.push(de_km)

    const ink = totalInk(D[i * 3], D[i * 3 + 1], D[i * 3 + 2])
    if (ink > 1.5) {
      d1_hi.push(de_d1)
      km_hi.push(de_km)
    }
  }

  const d1_med = median(d1_des), d1_p95 = percentile(d1_des, 95)
  const km_med = median(km_des), km_p95 = percentile(km_des, 95)

  return {
    d1_med, d1_p95, d1_pass: d1_med <= 1.5 && d1_p95 <= 3.0,
    km_med, km_p95, km_pass: km_med <= 1.5 && km_p95 <= 3.0,
    d1_hi_med: d1_hi.length ? median(d1_hi) : NaN,
    d1_hi_p95: d1_hi.length ? percentile(d1_hi, 95) : NaN,
    km_hi_med: km_hi.length ? median(km_hi) : NaN,
    km_hi_p95: km_hi.length ? percentile(km_hi, 95) : NaN,
    n_hi: d1_hi.length,
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runK(bcProfiles: Array<ProfileData & { wavelengths: number[] }>, k: number) {
  let d1Pass = 0, kmPass = 0, total = 0
  const d1Meds: number[] = [], kmMeds: number[] = []
  const d1P95s: number[] = [], kmP95s: number[] = []
  const d1HiP95s: number[] = [], kmHiP95s: number[] = []

  for (let i = 0; i < bcProfiles.length; i++) {
    for (let j = 0; j < bcProfiles.length; j++) {
      if (i === j) continue
      if (bcProfiles[i].metadata.printMode !== bcProfiles[j].metadata.printMode) continue
      if (bcProfiles[i].metadata.full_name.includes('AllureAq') ||
          bcProfiles[j].metadata.full_name.includes('AllureAq')) continue
      const res = await evalPair(bcProfiles[i], bcProfiles[j], k)
      if (!res) continue
      total++
      if (res.d1_pass) d1Pass++
      if (res.km_pass) kmPass++
      d1Meds.push(res.d1_med); kmMeds.push(res.km_med)
      d1P95s.push(res.d1_p95); kmP95s.push(res.km_p95)
      if (!isNaN(res.d1_hi_p95)) { d1HiP95s.push(res.d1_hi_p95); kmHiP95s.push(res.km_hi_p95) }
      process.stdout.write(`\r  k=${k}: ${total} pairs`)
    }
  }
  console.log()
  return { k, total, d1Pass, kmPass, d1Meds, kmMeds, d1P95s, kmP95s, d1HiP95s, kmHiP95s }
}

async function main() {
  const allFiles = await walk(PROFILES_ROOT)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as Array<ProfileData & { wavelengths: number[] }>
  const bcProfiles = profiles.filter(p => p.metadata.brand === 'BC')
  console.log(`BC profiles: ${bcProfiles.length}`)

  const results: object[] = []
  for (const k of [8, 13]) {
    const r = await runK(bcProfiles, k)
    const row = {
      k,
      n: r.total,
      d1_pass_pct: +(100 * r.d1Pass / r.total).toFixed(1),
      km_pass_pct: +(100 * r.kmPass / r.total).toFixed(1),
      d1_med_med:  +median(r.d1Meds).toFixed(3),
      km_med_med:  +median(r.kmMeds).toFixed(3),
      d1_p95_med:  +median(r.d1P95s).toFixed(3),
      km_p95_med:  +median(r.kmP95s).toFixed(3),
      d1_hi_p95_med: r.d1HiP95s.length ? +median(r.d1HiP95s).toFixed(3) : null,
      km_hi_p95_med: r.kmHiP95s.length ? +median(r.kmHiP95s).toFixed(3) : null,
    }
    results.push(row)
    console.log(`\n── k=${k} ──────────────────────────────────`)
    console.log(`  D1   pass: ${row.d1_pass_pct}%  med=${row.d1_med_med}  P95=${row.d1_p95_med}`)
    console.log(`  D1-KM pass: ${row.km_pass_pct}%  med=${row.km_med_med}  P95=${row.km_p95_med}`)
    if (row.d1_hi_p95_med !== null) {
      console.log(`  High-ink (>1.5): D1 P95=${row.d1_hi_p95_med}  KM P95=${row.km_hi_p95_med}`)
    }
    const h20aGate = k === 8 ? '≥85%' : '≥88%'
    const kmPct = row.km_pass_pct
    const pass = k === 8 ? kmPct >= 85 : kmPct >= 88
    console.log(`  H20${k === 8 ? 'a' : 'b'} gate (${h20aGate}): ${pass ? 'PASS ✓' : 'FAIL ✗'} (got ${kmPct}%)`)
  }

  await fs.writeFile(OUT_JSON, JSON.stringify({ generated: new Date().toISOString(), results }, null, 2))
  console.log(`\nWrote ${OUT_JSON}`)
}

main().catch(console.error)
