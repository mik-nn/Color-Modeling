// frontend/scripts/experiments/h16_redband_yn.ts
//
// H16 — Per-substrate Yule-Nielsen exponent correction at 640–680 nm.
//
// Hypothesis: D1's multiplicative paper-ratio model structurally underfits the
// substrate-specific cyan absorption depth at 640–680 nm. A single per-substrate
// YN exponent n, fitted from the cyan-ramp anchors (RGB (0,255,255), (64,255,255),
// (128,255,255), (192,255,255)), corrects this for that spectral region without
// affecting other bands.
//
// Two-step predictor (H16):
//   1. D1 base transfer for all λ (residualRank=5, uvBandCount=4, D7 OBA).
//   2. Override bands 640–680 nm with YN prediction:
//      R_B_pred(t, λ) = ((1-t)·R_paper_B^(1/n_B) + t·R_cyan_B^(1/n_B))^n_B
//      where n_B is fitted per-λ from B's 4-patch cyan ramp,
//      R_cyan_B is B's reflectance at RGB(0,255,255),
//      t = effective cyan coverage = (255 - R_patch) / 255.
//
// Acceptance (H16): P95 on Canvas Matte ≤ 1.7 (S1 baseline ~2.2) on ≥ 4 of 6
// worst pairs; no other mode hurt by > 0.05 median.
//
// Run: cd frontend && npx tsx scripts/experiments/h16_redband_yn.ts

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
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES_ROOT = path.resolve(ROOT, 'data/profiles')

// Spectral grid: 380–730 nm, 10 nm step, 36 bands.
const START_WL = 380
const STEP = 10
const N_BANDS = 36

// YN correction region: 640–680 nm = band indices 26–30.
const YN_BAND_START = (640 - START_WL) / STEP  // 26
const YN_BAND_END = (680 - START_WL) / STEP      // 30 (inclusive)

// Cyan-ramp RGB targets: t = (255-R)/255 = 1.0, 0.75, 0.50, 0.25
const CYAN_RAMP: Array<{ rgb: [number, number, number]; t: number }> = [
  { rgb: [0, 255, 255], t: 1.0 },
  { rgb: [64, 255, 255], t: 0.75 },
  { rgb: [128, 255, 255], t: 0.5 },
  { rgb: [192, 255, 255], t: 0.25 },
]

const RANK = 5
const UV_BAND_COUNT = 4

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// Find aligned row index for a target RGB value (nearest-neighbour in device space).
function findRgbRow(D: Float64Array, N: number, target: [number, number, number]): number {
  let best = -1
  let bestDist = Infinity
  for (let i = 0; i < N; i++) {
    const dr = D[i * 3] - target[0]
    const dg = D[i * 3 + 1] - target[1]
    const db = D[i * 3 + 2] - target[2]
    const d2 = dr * dr + dg * dg + db * db
    if (d2 < bestDist) { bestDist = d2; best = i }
  }
  return best
}

// YN prediction: R = ((1-t)*R_paper^(1/n) + t*R_cyan^(1/n))^n
// Returns NaN if inputs are non-positive.
function ynPredict(t: number, paper: number, cyan: number, n: number): number {
  if (paper <= 0 || cyan <= 0 || n <= 0) return paper
  const p = Math.pow(paper, 1 / n)
  const c = Math.pow(cyan, 1 / n)
  const linear = (1 - t) * p + t * c
  return Math.pow(Math.max(0, linear), n)
}

// Fit YN exponent n from 4 (t, R_measured) points at a single wavelength.
// Grid search over n ∈ [0.3, 6.0]; refine with bisection.
function fitYNExponent(
  tValues: number[],
  rMeasured: number[],
  paper: number,
  cyan: number,
): number {
  if (paper <= 1e-6 || cyan <= 1e-6) return 1.0

  function residual(n: number): number {
    let ss = 0
    for (let i = 0; i < tValues.length; i++) {
      const diff = ynPredict(tValues[i], paper, cyan, n) - rMeasured[i]
      ss += diff * diff
    }
    return ss
  }

  // Golden-section search over [0.3, 6.0].
  const phi = (Math.sqrt(5) - 1) / 2
  let lo = 0.3
  let hi = 6.0
  let x1 = hi - phi * (hi - lo)
  let x2 = lo + phi * (hi - lo)
  let f1 = residual(x1)
  let f2 = residual(x2)
  for (let iter = 0; iter < 50; iter++) {
    if (f1 < f2) {
      hi = x2; x2 = x1; f2 = f1
      x1 = hi - phi * (hi - lo); f1 = residual(x1)
    } else {
      lo = x1; x1 = x2; f1 = f2
      x2 = lo + phi * (hi - lo); f2 = residual(x2)
    }
    if (hi - lo < 1e-5) break
  }
  return (lo + hi) / 2
}

// Fit per-band YN exponent array for bands [YN_BAND_START..YN_BAND_END] from the
// aligned matrix X (N×L) and the D matrix (N×3). Returns Float64Array of length
// (YN_BAND_END - YN_BAND_START + 1).
function fitYNProfile(
  X: Float64Array,
  D: Float64Array,
  N: number,
  L: number,
): { nByBand: Float64Array; paperRow: number; cyanRow: number } {
  const paperRow = findRgbRow(D, N, [255, 255, 255])
  const cyanRow = findRgbRow(D, N, [0, 255, 255])
  const nBands = YN_BAND_END - YN_BAND_START + 1
  const nByBand = new Float64Array(nBands)

  const tVals = CYAN_RAMP.map(cr => cr.t)
  for (let bi = 0; bi < nBands; bi++) {
    const lambda = bi + YN_BAND_START
    const paper = X[paperRow * L + lambda]
    const cyan = X[cyanRow * L + lambda]
    const rMeas = CYAN_RAMP.map(cr => {
      const row = findRgbRow(D, N, cr.rgb)
      return X[row * L + lambda]
    })
    nByBand[bi] = fitYNExponent(tVals, rMeas, paper, cyan)
  }
  return { nByBand, paperRow, cyanRow }
}

// Apply YN correction at [640,680] nm, but ONLY for cyan-dominant patches (G≥220, B≥220).
// For other patches X_pred retains the D1 base value already stored there.
// Rationale: the two-endpoint YN model (paper ↔ full-cyan) is physically valid only when
// M and Y ink are absent. At 640-680nm, magenta also absorbs; applying YN to M/Y-laden
// patches would massively overpredict reflectance (predicts near-paper-white instead of
// the true absorptive value).
const CYAN_DOMINANT_THRESH = 220
function applyYNCorrection(
  X_pred: Float64Array,   // modified in-place; D1 clean prediction on entry
  D: Float64Array,
  X_B_ref: Float64Array,
  N: number,
  L: number,
  nByBandB: Float64Array,
  paperRowB: number,
  cyanRowB: number,
): void {
  for (let bi = 0; bi < nByBandB.length; bi++) {
    const lambda = bi + YN_BAND_START
    const n_B = nByBandB[bi]
    const paper_B = X_B_ref[paperRowB * L + lambda]
    const cyan_B = X_B_ref[cyanRowB * L + lambda]

    for (let k = 0; k < N; k++) {
      if (D[k * 3 + 1] < CYAN_DOMINANT_THRESH || D[k * 3 + 2] < CYAN_DOMINANT_THRESH) continue
      const t = Math.max(0, Math.min(1, (255 - D[k * 3]) / 255))
      X_pred[k * L + lambda] = ynPredict(t, paper_B, cyan_B, n_B)
    }
  }
}

// ---------------------------------------------------------------------------
// Profile loading
// ---------------------------------------------------------------------------

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: import('node:fs').Dirent[]
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...(await walk(full)))
    else if (/^BC_.*\.icm$/i.test(e.name)) out.push(full)
  }
  return out
}

async function loadWrapped(filePath: string): Promise<ProfileData & { wavelengths: number[] } | null> {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) return null
  const name = path.basename(filePath).replace(/\.icm$/i, '')
  return {
    metadata: {
      full_name: name, brand: 'BC', series: name, printer: 'P9000',
      ink: 'mk', substrate: name, parsed_at: new Date().toISOString(),
    },
    raw: r.measurements, clean: r.measurements,
    has_spectral: true, patch_count: r.measurements.length,
    wavelengths: r.wavelengths ?? Array.from({ length: N_BANDS }, (_, i) => START_WL + i * STEP),
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const matrices: { name: string; preset: string; mx: ReturnType<typeof loadProfileMatrix> }[] = []

  for (const f of files) {
    const wrapped = await loadWrapped(f)
    if (!wrapped) continue
    let preset: string
    try { preset = canonicalPrintMode(wrapped.metadata.full_name) } catch { continue }
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mx = loadProfileMatrix(wrapped as any)
      matrices.push({ name: wrapped.metadata.full_name, preset, mx })
    } catch { continue }
  }
  console.log(`Loaded ${matrices.length} BC profiles`)

  interface Row {
    ref: string
    target: string
    preset: string
    d1_median: number
    d1_p95: number
    h16_median: number
    h16_p95: number
    delta_median: number
    delta_p95: number
    n_mean: number  // mean fitted n_B across YN bands
  }
  const rows: Row[] = []

  for (let i = 0; i < matrices.length; i++) {
    for (let j = 0; j < matrices.length; j++) {
      if (i === j) continue
      const { mx: A } = matrices[i]
      const { mx: B } = matrices[j]
      if (matrices[i].preset !== matrices[j].preset) continue

      const al = alignProfiles(A, B)
      if (al.exactCount < 100) continue

      const N = al.N
      const L = A.L
      const X_A = al.X_A
      const X_B = al.X_B
      const D = al.D  // N×3 device values (A's grid)

      // Find paper by RGB(255,255,255).
      let paperRowIdx = 0
      for (let k = 0; k < N; k++) {
        if (D[k * 3] === 255 && D[k * 3 + 1] === 255 && D[k * 3 + 2] === 255) {
          paperRowIdx = k; break
        }
      }

      // S1 anchors + add cyan-ramp anchors (S5).
      const tgtForAnchors = {
        X: X_B, D, channels: 3 as const, N, L,
        wavelengths: A.wavelengths, sampleIds: al.sampleIds, droppedCount: 0,
      }
      const anchorsS1 = pickHeuristicAnchors(tgtForAnchors)
      const anchorIdx = (anchorsS1.meta?.chosenIdx as number[]).slice()
      const seen = new Set(anchorIdx)
      for (const cr of CYAN_RAMP) {
        const k = findRgbRow(D, N, cr.rgb)
        if (k >= 0 && !seen.has(k)) { anchorIdx.push(k); seen.add(k) }
      }

      // D7 OBA removal.
      const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
      const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
      const emA = extractOBAEmission(paperSpecA)
      const emB = extractOBAEmission(paperSpecB)
      const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
      const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
      const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
      const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)

      const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, A.wavelengths[0])

      // ---- Baseline D1 (S1 anchors only, k=13) ----
      const anchorIdxS1 = (anchorsS1.meta?.chosenIdx as number[]).slice(0, 13)
      const d1result = runPaperRatioResidualTransfer({
        X_A: X_A_clean, X_B: X_B_clean, D,
        sampleIds: al.sampleIds, anchorIdx: anchorIdxS1, paperRowIdx, L, paperWP,
        refProfile: matrices[i].name, targetProfile: matrices[j].name,
        residualRank: RANK, uvBandCount: UV_BAND_COUNT,
      })
      const X_d1_final = addOBA(d1result.X_pred, L, fB, emB.emission)

      // ---- H16: D1 base + YN correction at 640–680 nm (cyan-dominant patches only) ----
      const ynB = fitYNProfile(X_B_clean, D, N, L)
      const X_d1_clean_pred = d1result.X_pred.slice()
      applyYNCorrection(X_d1_clean_pred, D, X_B_clean, N, L, ynB.nByBand, ynB.paperRow, ynB.cyanRow)
      const X_h16_final = addOBA(X_d1_clean_pred, L, fB, emB.emission)

      // Evaluate non-anchor patches.
      const anchorSet = new Set(anchorIdxS1)
      const d1Des: number[] = []
      const h16Des: number[] = []
      for (let k = 0; k < N; k++) {
        if (anchorSet.has(k)) continue
        const a_d1 = Array.from(X_d1_final.subarray(k * L, k * L + L))
        const a_h16 = Array.from(X_h16_final.subarray(k * L, k * L + L))
        const b = Array.from(X_B.subarray(k * L, k * L + L))
        const la_d1 = spectraToLab(a_d1)
        const la_h16 = spectraToLab(a_h16)
        const lb = spectraToLab(b)
        d1Des.push(deltaE00(la_d1[0], la_d1[1], la_d1[2], lb[0], lb[1], lb[2]))
        h16Des.push(deltaE00(la_h16[0], la_h16[1], la_h16[2], lb[0], lb[1], lb[2]))
      }

      const nMean = Array.from(ynB.nByBand).reduce((a, b) => a + b, 0) / ynB.nByBand.length

      rows.push({
        ref: matrices[i].name,
        target: matrices[j].name,
        preset: matrices[i].preset,
        d1_median: median(d1Des),
        d1_p95: percentile(d1Des, 95),
        h16_median: median(h16Des),
        h16_p95: percentile(h16Des, 95),
        delta_median: median(h16Des) - median(d1Des),
        delta_p95: percentile(h16Des, 95) - percentile(d1Des, 95),
        n_mean: nMean,
      })
    }
  }

  // Summary by preset.
  const presets = [...new Set(rows.map(r => r.preset))]
  for (const preset of presets.sort()) {
    const pr = rows.filter(r => r.preset === preset)
    if (pr.length === 0) continue
    const d1Meds = pr.map(r => r.d1_median)
    const h16Meds = pr.map(r => r.h16_median)
    const d1P95s = pr.map(r => r.d1_p95)
    const h16P95s = pr.map(r => r.h16_p95)
    console.log(`\n${preset} (n=${pr.length} pairs):`)
    console.log(`  D1  med-of-meds=${median(d1Meds).toFixed(3)}  med-of-P95s=${median(d1P95s).toFixed(3)}`)
    console.log(`  H16 med-of-meds=${median(h16Meds).toFixed(3)}  med-of-P95s=${median(h16P95s).toFixed(3)}`)
    console.log(`  Δ   median=${(median(h16Meds)-median(d1Meds)).toFixed(3)}  P95=${(median(h16P95s)-median(d1P95s)).toFixed(3)}`)

    const nMeans = pr.map(r => r.n_mean)
    console.log(`  n_B range: ${Math.min(...nMeans).toFixed(2)}–${Math.max(...nMeans).toFixed(2)} (avg ${(nMeans.reduce((a,b)=>a+b,0)/nMeans.length).toFixed(2)})`)
  }

  // Top worst D1 pairs (for H16 acceptance gate: DecorMatte↔others).
  const cmPairs = rows.filter(r => r.preset === 'CanvasMatte')
  if (cmPairs.length > 0) {
    const worst = [...cmPairs].sort((a, b) => b.d1_p95 - a.d1_p95).slice(0, 6)
    console.log('\n6 worst CanvasMatte pairs by D1 P95:')
    console.log('  ref                                    → target                                 D1 med  D1 p95  H16 med H16 p95  Δp95')
    let nImproved = 0
    for (const r of worst) {
      const improved = r.delta_p95 <= -0.5
      if (improved) nImproved++
      const flag = improved ? '✓' : '✗'
      console.log(
        `  ${r.ref.slice(0,35).padEnd(35)} → ${r.target.slice(0,35).padEnd(35)}` +
        `  ${r.d1_median.toFixed(2)}   ${r.d1_p95.toFixed(2)}   ${r.h16_median.toFixed(2)}    ${r.h16_p95.toFixed(2)}    ${r.delta_p95.toFixed(3)} ${flag}`
      )
    }
    console.log(`\nH16 acceptance: ${nImproved}/6 worst pairs improved by ≥ 0.5 P95 (need 4/6 per H16 spec, 0.5 is interim gate)`)
  }

  // Write JSON.
  const outPath = path.resolve(process.cwd(), 'data/cae-input/h16_redband_yn.json')
  await fs.writeFile(outPath, JSON.stringify({ rows, generated: new Date().toISOString() }, null, 2))
  console.log(`\nwrote ${outPath}`)
}

main().catch(console.error)
