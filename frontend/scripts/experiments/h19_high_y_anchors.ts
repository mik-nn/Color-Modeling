// frontend/scripts/experiments/h19_high_y_anchors.ts
//
// H19 — Heavy-Y anchor augmentation + residualRank 5→8 on DecorMatte→ChromataWhite.
//
// Variants tested:
//   baseline : S1 k=13, rank=5
//   h18c     : S1+3 high-CMY k=16, rank=5  (H18c confirmed — new baseline)
//   h19a     : S1+3 high-CMY+3 heavy-Y k=19, rank=5
//   h19b     : S1 k=13, rank=8
//   h19bc    : S1+3 high-CMY k=16, rank=8
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h19_high_y_anchors.ts"

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
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles/CanvasMatte')
const REF_FILE = 'BC_DecorMatte_P9000_mk_CanvasMatte.icm'
const TGT_FILE = 'BC_ChromataWhite_P9000_mk_CanvasMatte.icm'
const START_WL = 380
const N_BANDS = 36

// High-CMY anchors confirmed by H18c (nearest measured patches to these targets).
const HIGH_CMY_TARGETS: Array<readonly [number, number, number]> = [
  [40, 0, 100], [40, 0, 150], [40, 0, 190],
]
// Heavy-Y sector (H18 conclusion: worst shift after aug = R≈100–160, G≈85–170, B≈0).
const HIGH_Y_TARGETS: Array<readonly [number, number, number]> = [
  [130, 130, 0], [100, 85, 0], [160, 170, 0],
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
  const buf = await fs.readFile(path.join(PROFILES_ROOT, filename))
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  if (!r.hasSpectral) throw new Error(`No spectral in ${filename}`)
  const name = filename.replace(/\.icm$/i, '')
  return {
    metadata: {
      full_name: name, brand: 'BC', series: name, printer: 'P9000',
      ink: 'mk', substrate: name, parsed_at: new Date().toISOString(),
    },
    raw: r.measurements, clean: r.measurements,
    has_spectral: true, patch_count: r.measurements.length,
    wavelengths: r.wavelengths ?? Array.from({ length: N_BANDS }, (_, i) => START_WL + i * 10),
  }
}

interface VariantResult { label: string; k: number; rank: number; median: number; p95: number }

async function runVariant(
  label: string,
  anchorIdx: number[],
  rank: number,
  X_A_clean: Float64Array, X_B_clean: Float64Array, X_B_raw: Float64Array,
  D: Float64Array, N: number, L: number,
  sampleIds: string[], paperRowIdx: number, paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  profAName: string, profBName: string,
  fB: Float64Array, emB: Float64Array,
): Promise<VariantResult> {
  const anchorSet = new Set(anchorIdx)
  const d1 = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D,
    sampleIds, anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profAName, targetProfile: profBName,
    residualRank: rank, uvBandCount: 4,
  })
  const X_pred = addOBA(d1.X_pred, L, fB, emB)
  const des: number[] = []
  for (let k = 0; k < N; k++) {
    if (anchorSet.has(k)) continue
    const pred = Array.from(X_pred.subarray(k * L, k * L + L))
    const meas = Array.from(X_B_raw.subarray(k * L, k * L + L))
    const lp = spectraToLab(pred), lm = spectraToLab(meas)
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95 = percentile(des, 95)
  console.log(`[${label.padEnd(24)}] k=${anchorIdx.length.toString().padStart(2)} rank=${rank}  median=${med.toFixed(3)}  P95=${p95.toFixed(3)}`)
  return { label, k: anchorIdx.length, rank, median: med, p95 }
}

async function main() {
  const profA = await loadProfile(REF_FILE)
  const profB = await loadProfile(TGT_FILE)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < 100) throw new Error('Too few aligned patches')
  const { N, X_A, X_B, D } = al
  const L = N_BANDS

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

  const tgtForAnchors = { X: X_B, D, channels: 3 as const, N, L, wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const anchorIdxS1 = (pickHeuristicAnchors(tgtForAnchors).meta?.chosenIdx as number[]).slice(0, 13)

  const takenCMY = new Set(anchorIdxS1)
  const highCmyIdx = HIGH_CMY_TARGETS.map(t => { const i = nearestRgb(D, N, t, takenCMY); takenCMY.add(i); return i })
  const anchorIdxH18c = [...anchorIdxS1, ...highCmyIdx]

  const takenY = new Set(anchorIdxH18c)
  const highYIdx = HIGH_Y_TARGETS.map(t => { const i = nearestRgb(D, N, t, takenY); takenY.add(i); return i })
  const anchorIdxH19a = [...anchorIdxH18c, ...highYIdx]

  const args = [X_A_clean, X_B_clean, X_B, D, N, L, al.sampleIds, paperRowIdx, paperWP, profA.metadata.full_name, profB.metadata.full_name, fB, emB.emission] as const

  console.log(`\nAligned: ${N} patches  paper_row=${paperRowIdx}\n`)
  const results: VariantResult[] = []
  results.push(await runVariant('baseline (S1 rank5)',      anchorIdxS1,   5, ...args))
  results.push(await runVariant('h18c (S1+CMY rank5)',      anchorIdxH18c, 5, ...args))
  results.push(await runVariant('h19a (S1+CMY+Y rank5)',    anchorIdxH19a, 5, ...args))
  results.push(await runVariant('h19b (S1 rank8)',          anchorIdxS1,   8, ...args))
  results.push(await runVariant('h19bc (S1+CMY rank8)',     anchorIdxH18c, 8, ...args))

  console.log('\n── H19 verdict ──────────────────────────────────────────────')
  const h18cBaseline = results.find(r => r.label.startsWith('h18c'))!
  const h19a = results.find(r => r.label.startsWith('h19a'))!
  const h19b = results.find(r => r.label.startsWith('h19b'))!
  const h19bc = results.find(r => r.label.startsWith('h19bc'))!
  console.log(`H19a: ΔP95=${(h18cBaseline.p95 - h19a.p95).toFixed(3)}  ${h18cBaseline.p95 - h19a.p95 >= 1.0 ? 'PASS' : 'FAIL'} (gate ≥ 1.0)`)
  console.log(`H19b: ΔP95=${(results[0].p95 - h19b.p95).toFixed(3)}  ${results[0].p95 - h19b.p95 >= 1.0 ? 'PASS' : 'FAIL'} (gate ≥ 1.0, vs baseline)`)
  console.log(`H19bc combined: P95=${h19bc.p95.toFixed(3)}`)

  await fs.writeFile(
    path.resolve(process.cwd(), 'data/cae-input/h19_high_y_anchors.json'),
    JSON.stringify({ generated: new Date().toISOString(), pair: { ref: REF_FILE, tgt: TGT_FILE }, results }, null, 2)
  )
  console.log('\nWrote data/cae-input/h19_high_y_anchors.json')
}

main().catch(console.error)
