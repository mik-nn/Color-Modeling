// frontend/scripts/experiments/h17_residual_bands.ts
//
// H17 — Spectral residual band analysis on DecorMatte→ChromataWhite.
//
// Diagnostic: run D1 baseline on the worst CanvasMatte pair and decompose
// the per-patch spectral error by wavelength band. Tests whether UV/OBA
// bands (380–430 nm) dominate the P95 residuals (ratio > 2× visible-band
// error), which would implicate OBA-mismatch as the root cause of P95=6.42.
//
// Outputs:
//   1. Per-band mean|R_pred − R_meas| table: all patches, P95 group, P5 group.
//   2. UV/VIS ratio for P95 group (acceptance gate: > 2.0).
//   3. Per-patch scatter: ΔE00 vs per-band UV error (380–430 nm).
//   4. JSON written to data/cae-input/h17_residual_bands.json.
//
// Run: cd frontend && npx tsx scripts/experiments/h17_residual_bands.ts

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
import { detectOBA, obaMismatch } from '../../src/lib/predict/oba'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles/CanvasMatte')
const REF_FILE  = 'BC_DecorMatte_P9000_mk_CanvasMatte.icm'
const TGT_FILE  = 'BC_ChromataWhite_P9000_mk_CanvasMatte.icm'

const START_WL  = 380
const STEP      = 10
const N_BANDS   = 36

// OBA/UV band range: 380–430 nm = indices 0–5 (6 bands).
const UV_END_IDX = 5   // inclusive; 430 nm
// Visible: 440–730 nm = indices 6–35 (30 bands).
const VIS_START_IDX = 6

const RANK = 5
const UV_BAND_COUNT = 4  // per-band UV clamp in D1

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
  if (al.N < 100) throw new Error('Too few aligned patches — check profile loading')

  const { N, X_A, X_B, D } = al
  const L = mxA.L

  // Paper row: exact RGB(255,255,255).
  let paperRowIdx = 0
  for (let k = 0; k < N; k++) {
    if (D[k * 3] === 255 && D[k * 3 + 1] === 255 && D[k * 3 + 2] === 255) {
      paperRowIdx = k; break
    }
  }
  console.log(`Paper row: ${paperRowIdx}  (D=${D[paperRowIdx*3]},${D[paperRowIdx*3+1]},${D[paperRowIdx*3+2]})`)

  // OBA mismatch.
  const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const obaA = detectOBA(paperSpecA)
  const obaB = detectOBA(paperSpecB)
  const mismatch = obaMismatch(obaA, obaB)
  console.log(`\nOBA scores: ${REF_FILE.split('_')[1]}=${obaA.score.toFixed(3)}  ${TGT_FILE.split('_')[1]}=${obaB.score.toFixed(3)}  mismatch=${mismatch.toFixed(3)}`)

  // D7 OBA removal.
  const emA = extractOBAEmission(paperSpecA)
  const emB = extractOBAEmission(paperSpecB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  const X_A_clean = subtractOBA(X_A, L, fA, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB, emB.emission)

  const paperWP = paperWPFromBrightestPatch(new Float64Array(paperSpecB), 1, L, mxA.wavelengths[0])

  // S1 anchors (k=13).
  const tgtForAnchors = {
    X: X_B, D, channels: 3 as const, N, L,
    wavelengths: mxA.wavelengths, sampleIds: al.sampleIds, droppedCount: 0,
  }
  const anchorsS1 = pickHeuristicAnchors(tgtForAnchors)
  const anchorIdx = (anchorsS1.meta?.chosenIdx as number[]).slice(0, 13)
  const anchorSet = new Set(anchorIdx)
  console.log(`S1 anchors: k=${anchorIdx.length}`)

  // D1 prediction.
  const d1result = runPaperRatioResidualTransfer({
    X_A: X_A_clean, X_B: X_B_clean, D,
    sampleIds: al.sampleIds, anchorIdx, paperRowIdx, L, paperWP,
    refProfile: profA.metadata.full_name, targetProfile: profB.metadata.full_name,
    residualRank: RANK, uvBandCount: UV_BAND_COUNT,
  })
  const X_pred = addOBA(d1result.X_pred, L, fB, emB.emission)

  // Per-patch evaluation.
  interface PatchResult {
    patchIdx: number
    de00: number
    // per-band absolute error |R_pred(λ) - R_meas(λ)|
    bandErr: Float64Array
    // device values
    r: number; g: number; b: number
  }
  const patches: PatchResult[] = []
  for (let k = 0; k < N; k++) {
    if (anchorSet.has(k)) continue
    const predSpec = Array.from(X_pred.subarray(k * L, k * L + L))
    const measSpec = Array.from(X_B.subarray(k * L, k * L + L))
    const labPred = spectraToLab(predSpec)
    const labMeas = spectraToLab(measSpec)
    const de = deltaE00(labPred[0], labPred[1], labPred[2], labMeas[0], labMeas[1], labMeas[2])
    const bandErr = new Float64Array(L)
    for (let b = 0; b < L; b++) bandErr[b] = Math.abs(predSpec[b] - measSpec[b])
    patches.push({
      patchIdx: k,
      de00: de,
      bandErr,
      r: D[k * 3], g: D[k * 3 + 1], b: D[k * 3 + 2],
    })
  }

  const des = patches.map(p => p.de00)
  const p95Val = percentile(des, 95)
  const p5Val  = percentile(des, 5)
  console.log(`\nNon-anchor patches: ${patches.length}`)
  console.log(`D1 median=${median(des).toFixed(3)}  P95=${p95Val.toFixed(3)}`)

  // Split groups.
  const grpP95 = patches.filter(p => p.de00 >= p95Val)
  const grpP5  = patches.filter(p => p.de00 <= p5Val)
  const grpAll = patches
  console.log(`P95 group (ΔE≥${p95Val.toFixed(2)}): n=${grpP95.length}`)
  console.log(`P5  group (ΔE≤${p5Val.toFixed(2)}): n=${grpP5.length}`)

  // Per-band mean absolute error for each group.
  function groupBandErr(grp: PatchResult[]): number[] {
    const out: number[] = new Array(L).fill(0)
    for (const p of grp) for (let b = 0; b < L; b++) out[b] += p.bandErr[b]
    return out.map(v => v / grp.length)
  }
  const errAll  = groupBandErr(grpAll)
  const errP95  = groupBandErr(grpP95)
  const errP5   = groupBandErr(grpP5)

  // UV vs VIS means for P95 group.
  const uvErrP95  = mean(errP95.slice(0, UV_END_IDX + 1))
  const visErrP95 = mean(errP95.slice(VIS_START_IDX))
  const uvVisRatio = uvErrP95 / visErrP95

  // Print per-band table.
  console.log('\n--- Per-band absolute spectral error ---')
  console.log('λ(nm)  errAll   errP95   errP5    ratio(P95/All)')
  for (let b = 0; b < L; b++) {
    const wl = START_WL + b * STEP
    const ratio = errAll[b] > 0 ? errP95[b] / errAll[b] : 0
    const flag = b <= UV_END_IDX ? ' ← UV' : ''
    console.log(
      `${wl}   ${errAll[b].toFixed(4)}   ${errP95[b].toFixed(4)}   ${errP5[b].toFixed(4)}   ${ratio.toFixed(2)}${flag}`
    )
  }

  // Summary.
  console.log(`\n--- UV/VIS decomposition for P95 group ---`)
  console.log(`UV  (380–430 nm) mean |err|: ${uvErrP95.toFixed(4)}`)
  console.log(`VIS (440–730 nm) mean |err|: ${visErrP95.toFixed(4)}`)
  console.log(`UV/VIS ratio: ${uvVisRatio.toFixed(3)}  (H17 gate: > 2.0 → OBA-mismatch confirmed)`)
  if (uvVisRatio > 2.0) {
    console.log('→ H17 CONFIRMED: UV/OBA bands dominate P95 error. OBA-targeted fix is warranted.')
  } else if (uvVisRatio > 1.5) {
    console.log('→ H17 PARTIAL: UV error elevated but < 2×. Mixed mechanism.')
  } else {
    console.log('→ H17 REJECTED: Error spectrally flat. Non-OBA mechanism dominates.')
  }

  // Top-5 bands by errP95.
  const ranked = errP95.map((e, i) => ({ wl: START_WL + i * STEP, err: e }))
    .sort((a, b) => b.err - a.err).slice(0, 5)
  console.log('\nTop-5 bands by P95-group error:')
  for (const r of ranked) console.log(`  λ=${r.wl} nm  mean|err|=${r.err.toFixed(4)}`)

  // Top-10 worst patches: device values + ΔE + per-UV-band error.
  const worst10 = [...patches].sort((a, b) => b.de00 - a.de00).slice(0, 10)
  console.log('\nTop-10 worst patches:')
  console.log('  R    G    B    ΔE00   UV_err(380-430 mean)')
  for (const p of worst10) {
    const uvE = mean(Array.from(p.bandErr.slice(0, UV_END_IDX + 1)))
    console.log(`  ${p.r.toString().padStart(3)} ${p.g.toString().padStart(3)} ${p.b.toString().padStart(3)}  ${p.de00.toFixed(3)}  ${uvE.toFixed(4)}`)
  }

  // Write JSON.
  const outPath = path.resolve(process.cwd(), 'data/cae-input/h17_residual_bands.json')
  const outData = {
    generated: new Date().toISOString(),
    pair: { ref: profA.metadata.full_name, target: profB.metadata.full_name },
    oba: { scoreA: obaA.score, scoreB: obaB.score, mismatch },
    d1: { median: median(des), p95: p95Val, n_eval: patches.length },
    uvVisRatio,
    uvErrP95,
    visErrP95,
    bandTable: Array.from({ length: L }, (_, i) => ({
      wl: START_WL + i * STEP,
      errAll: errAll[i],
      errP95: errP95[i],
      errP5: errP5[i],
    })),
    worst10: worst10.map(p => ({
      r: p.r, g: p.g, b: p.b,
      de00: p.de00,
      bandErr: Array.from(p.bandErr),
      uvErrMean: mean(Array.from(p.bandErr.slice(0, UV_END_IDX + 1))),
    })),
  }
  await fs.writeFile(outPath, JSON.stringify(outData, null, 2))
  console.log(`\nWrote ${outPath}`)
}

main().catch(console.error)
