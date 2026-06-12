// frontend/scripts/experiments/h18_ink_coverage.ts
//
// H18 — Ink-coverage correlation + high-CMY anchor augmentation.
//
// Part 1 (H18a/b): Compute Spearman rank correlation between (C+M+Y device sum)
//   and (a) per-patch ΔE00, (b) per-patch mean |err| at 530–580 nm.
//   Gate: Spearman r > 0.50 in both cases.
//
// Part 2 (H18c): Add 3 high-CMY anchors (nearest patches to R=40,G=0,B=100/150/190)
//   to S1 k=13 → k=16. Rerun D1 transfer. Gate: P95 drop ≥ 1.0 ΔE00.
//
// Run: cd frontend && npx tsx scripts/experiments/h18_ink_coverage.ts

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
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles/CanvasMatte')
const REF_FILE = 'BC_DecorMatte_P9000_mk_CanvasMatte.icm'
const TGT_FILE = 'BC_ChromataWhite_P9000_mk_CanvasMatte.icm'

const START_WL = 380
const STEP = 10
const N_BANDS = 36

// 530–580 nm = indices 15–20 (inclusive)
const GY_START = 15  // 530 nm
const GY_END   = 20  // 580 nm

const RANK = 5
const UV_BAND_COUNT = 4

// High-CMY target device values to probe near the gamut boundary.
const HIGH_CMY_TARGETS: Array<readonly [number, number, number]> = [
  [40,  0, 100],
  [40,  0, 150],
  [40,  0, 190],
]

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
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Spearman rank correlation between two equal-length arrays. */
function spearman(x: number[], y: number[]): number {
  const n = x.length
  if (n < 3) return NaN
  const rankOf = (arr: number[]): number[] => {
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const rank = new Array<number>(n)
    for (let j = 0; j < n; ) {
      let k = j
      while (k < n - 1 && sorted[k + 1].v === sorted[k].v) k++
      const avgRank = (j + k) / 2
      for (let m = j; m <= k; m++) rank[sorted[m].i] = avgRank
      j = k + 1
    }
    return rank
  }
  const rx = rankOf(x), ry = rankOf(y)
  let num = 0, sdx = 0, sdy = 0
  const mx = mean(rx), my = mean(ry)
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my)
    sdx += (rx[i] - mx) ** 2
    sdy += (ry[i] - my) ** 2
  }
  return num / Math.sqrt(sdx * sdy)
}

/** Find the row index in D (N×3) nearest to target RGB, excluding takenSet. */
function nearestRgb(
  D: Float64Array, N: number,
  target: readonly [number, number, number],
  takenSet: Set<number>,
): number {
  let best = -1, bestDist = Infinity
  for (let i = 0; i < N; i++) {
    if (takenSet.has(i)) continue
    const dr = D[i * 3] - target[0]
    const dg = D[i * 3 + 1] - target[1]
    const db = D[i * 3 + 2] - target[2]
    const d = dr * dr + dg * dg + db * db
    if (d < bestDist) { bestDist = d; best = i }
  }
  return best
}

async function loadProfile(filename: string): Promise<ProfileData & { wavelengths: number[] }> {
  const filePath = path.join(PROFILES_ROOT, filename)
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) throw new Error(`No spectral data in ${filename}`)
  const name = filename.replace(/\.icm$/i, '')
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

interface EvalResult {
  de00: number
  gyErr: number   // mean |err| at 530–580 nm
  ink: number     // (255-R)+(255-G)+(255-B)
  r: number; g: number; b: number
}

async function evalAnchors(
  X_A_clean: Float64Array, X_B_clean: Float64Array,
  X_B_raw: Float64Array,
  D: Float64Array, N: number, L: number,
  anchorIdx: number[],
  sampleIds: string[],
  paperRowIdx: number,
  paperWP: Float64Array,
  profAName: string, profBName: string,
  fB: Float64Array, emB: Float64Array,
  label: string,
): Promise<{ results: EvalResult[], median: number, p95: number }> {
  const anchorSet = new Set(anchorIdx)

  const d1result = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D,
    sampleIds, anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profAName, targetProfile: profBName,
    residualRank: RANK, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred = addOBA(d1result.X_pred, L, fB, emB)

  const results: EvalResult[] = []
  for (let k = 0; k < N; k++) {
    if (anchorSet.has(k)) continue
    const predSpec = Array.from(X_pred.subarray(k * L, k * L + L))
    const measSpec = Array.from(X_B_raw.subarray(k * L, k * L + L))
    const labPred = spectraToLab(predSpec)
    const labMeas = spectraToLab(measSpec)
    const de = deltaE00(labPred[0], labPred[1], labPred[2], labMeas[0], labMeas[1], labMeas[2])
    let gyErrSum = 0
    for (let b = GY_START; b <= GY_END; b++) {
      gyErrSum += Math.abs(predSpec[b] - measSpec[b])
    }
    const gyErr = gyErrSum / (GY_END - GY_START + 1)
    const r = D[k * 3], g = D[k * 3 + 1], b = D[k * 3 + 2]
    const ink = (255 - r) + (255 - g) + (255 - b)
    results.push({ de00: de, gyErr, ink, r, g, b })
  }

  const des = results.map(p => p.de00)
  const med = median(des)
  const p95 = percentile(des, 95)
  console.log(`\n[${label}] n_eval=${results.length}  median=${med.toFixed(3)}  P95=${p95.toFixed(3)}`)
  return { results, median: med, p95 }
}

async function main() {
  console.log(`Loading ${REF_FILE} …`)
  const profA = await loadProfile(REF_FILE)
  console.log(`Loading ${TGT_FILE} …`)
  const profB = await loadProfile(TGT_FILE)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mxA = loadProfileMatrix(profA as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mxB = loadProfileMatrix(profB as any)

  const al = alignProfiles(mxA, mxB)
  console.log(`Aligned patches: ${al.N} (exact=${al.exactCount})`)
  if (al.N < 100) throw new Error('Too few aligned patches')

  const { N, X_A, X_B, D } = al
  const L = mxA.L

  // Paper row.
  let paperRowIdx = 0
  for (let k = 0; k < N; k++) {
    if (D[k * 3] === 255 && D[k * 3 + 1] === 255 && D[k * 3 + 2] === 255) {
      paperRowIdx = k; break
    }
  }
  console.log(`Paper row: ${paperRowIdx}`)

  // D7 OBA removal.
  const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(paperSpecA)
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)

  const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, mxA.wavelengths[0])

  // S1 baseline anchors (k=13).
  const tgtForAnchors = {
    X: X_B, D, channels: 3 as const, N, L,
    wavelengths: mxA.wavelengths, sampleIds: al.sampleIds, droppedCount: 0,
  }
  const anchorsS1 = pickHeuristicAnchors(tgtForAnchors)
  const anchorIdxS1 = (anchorsS1.meta?.chosenIdx as number[]).slice(0, 13)
  console.log(`S1 anchors: k=${anchorIdxS1.length}`)

  // ── Part 1: S1 baseline ───────────────────────────────────────────────────
  const baseline = await evalAnchors(
    X_A_clean, X_B_clean, X_B, D, N, L,
    anchorIdxS1, al.sampleIds, paperRowIdx, paperWP,
    profA.metadata.full_name, profB.metadata.full_name,
    fB, emB.emission,
    'S1 baseline k=13',
  )

  // ── Spearman correlations (on baseline results) ───────────────────────────
  const inkVals = baseline.results.map(p => p.ink)
  const deVals  = baseline.results.map(p => p.de00)
  const gyVals  = baseline.results.map(p => p.gyErr)

  const rInkDE  = spearman(inkVals, deVals)
  const rInkGY  = spearman(inkVals, gyVals)

  console.log('\n── Spearman correlations ────────────────────────────────────')
  console.log(`  Spearman(ink, ΔE00):        ${rInkDE.toFixed(3)}  (H18a gate > 0.50)`)
  console.log(`  Spearman(ink, 530–580 err): ${rInkGY.toFixed(3)}  (H18b gate > 0.50)`)

  const h18a = rInkDE > 0.50
  const h18b = rInkGY > 0.50
  console.log(`  H18a: ${h18a ? 'PASS' : (rInkDE < 0.30 ? 'REJECT' : 'PARTIAL')}`)
  console.log(`  H18b: ${h18b ? 'PASS' : (rInkGY < 0.30 ? 'REJECT' : 'PARTIAL')}`)

  // ── Part 2: augmented anchors (S1 + 3 high-CMY) ──────────────────────────
  const takenSet = new Set(anchorIdxS1)
  const highCmyIdx: number[] = []
  for (const tgt of HIGH_CMY_TARGETS) {
    const idx = nearestRgb(D, N, tgt, takenSet)
    if (idx >= 0) {
      highCmyIdx.push(idx)
      takenSet.add(idx)
      console.log(
        `  Nearest to (R=${tgt[0]},G=${tgt[1]},B=${tgt[2]}): ` +
        `idx=${idx}  actual=(${D[idx*3]},${D[idx*3+1]},${D[idx*3+2]})`
      )
    }
  }
  const anchorIdxAug = [...anchorIdxS1, ...highCmyIdx]
  console.log(`\nAugmented anchors: k=${anchorIdxAug.length} (+${highCmyIdx.length} high-CMY)`)

  const augmented = await evalAnchors(
    X_A_clean, X_B_clean, X_B, D, N, L,
    anchorIdxAug, al.sampleIds, paperRowIdx, paperWP,
    profA.metadata.full_name, profB.metadata.full_name,
    fB, emB.emission,
    `S1+highCMY k=${anchorIdxAug.length}`,
  )

  const p95Drop = baseline.p95 - augmented.p95
  const medDrop = baseline.median - augmented.median
  const h18c = p95Drop >= 1.0

  console.log('\n── H18c anchor augmentation ─────────────────────────────────')
  console.log(`  Baseline  median=${baseline.median.toFixed(3)}  P95=${baseline.p95.toFixed(3)}`)
  console.log(`  Augmented median=${augmented.median.toFixed(3)}  P95=${augmented.p95.toFixed(3)}`)
  console.log(`  ΔP95=${(-p95Drop).toFixed(3)} ΔMedian=${(-medDrop).toFixed(3)}`)
  console.log(`  H18c: ${h18c ? 'PASS (P95 drop ≥ 1.0)' : (p95Drop < 0.30 ? 'REJECT' : 'PARTIAL')}`)

  // ── Overall verdict ───────────────────────────────────────────────────────
  console.log('\n══ H18 VERDICT ══════════════════════════════════════════════')
  console.log(`  H18a (ΔE vs ink corr.):      ${h18a ? 'CONFIRMED' : 'NOT CONFIRMED'} (r=${rInkDE.toFixed(3)})`)
  console.log(`  H18b (530–580 nm vs ink):    ${h18b ? 'CONFIRMED' : 'NOT CONFIRMED'} (r=${rInkGY.toFixed(3)})`)
  console.log(`  H18c (augmented anchors):    ${h18c ? 'CONFIRMED' : 'NOT CONFIRMED'} (ΔP95=${p95Drop.toFixed(3)})`)

  // ── Top-10 worst patches in augmented run ────────────────────────────────
  const worst10 = [...augmented.results].sort((a, b) => b.de00 - a.de00).slice(0, 10)
  console.log('\nTop-10 worst patches (augmented):')
  console.log('  R    G    B    ink   ΔE00   530–580 err')
  for (const p of worst10) {
    console.log(
      `  ${p.r.toString().padStart(3)} ${p.g.toString().padStart(3)} ` +
      `${p.b.toString().padStart(3)}  ${p.ink.toString().padStart(3)}  ` +
      `${p.de00.toFixed(3)}  ${p.gyErr.toFixed(4)}`
    )
  }

  // ── Coverage bucket analysis ──────────────────────────────────────────────
  console.log('\nCoverage bucket analysis (baseline, non-anchor):')
  const buckets = [
    { label: '  0–255 (all)',   lo: 0,   hi: 255  },
    { label: '256–383 (med)',   lo: 256, hi: 383  },
    { label: '384–511 (high)',  lo: 384, hi: 511  },
    { label: '512–765 (max)',   lo: 512, hi: 765  },
  ]
  for (const bk of buckets) {
    const g = baseline.results.filter(p => p.ink >= bk.lo && p.ink <= bk.hi)
    if (g.length === 0) continue
    const des = g.map(p => p.de00)
    console.log(
      `  ink ${bk.label}: n=${g.length.toString().padStart(3)}  ` +
      `median=${median(des).toFixed(3)}  P95=${percentile(des, 95).toFixed(3)}`
    )
  }

  // ── Write JSON ────────────────────────────────────────────────────────────
  const outPath = path.resolve(process.cwd(), 'data/cae-input/h18_ink_coverage.json')
  await fs.writeFile(outPath, JSON.stringify({
    generated: new Date().toISOString(),
    pair: { ref: profA.metadata.full_name, target: profB.metadata.full_name },
    baseline: { median: baseline.median, p95: baseline.p95, n_eval: baseline.results.length },
    spearman: { inkVsDE: rInkDE, inkVsGY530_580: rInkGY },
    highCmyAnchors: highCmyIdx.map(i => ({ idx: i, r: D[i*3], g: D[i*3+1], b: D[i*3+2] })),
    augmented: { median: augmented.median, p95: augmented.p95, n_eval: augmented.results.length },
    p95Drop,
    medDrop,
    verdict: { h18a, h18b, h18c },
  }, null, 2))
  console.log(`\nWrote ${outPath}`)
}

main().catch(console.error)
