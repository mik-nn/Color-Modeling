// frontend/scripts/experiments/h12_oba_scale.ts
//
// H12 test: fit a per-profile α scaling factor on the OBA emission from a small
// anchor set (paper + yellow + gray + cyan/blue) and check whether it improves
// (a) the per-profile OBA reconstruction fidelity and (b) cross-substrate D1
// transfer on OBA-disparate pairs.
//
// Run: cd frontend && npx tsx scripts/experiments/h12_oba_scale.ts

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignByCommonSampleIds } from '../../src/lib/dataset/matrix'
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
import { fitObaScale, pickObaAnchors, ObaAnchor } from '../../src/lib/predict/obaModelFit'

// Anchor recipes to compare. Yellow blocks blue → in early tests it pulled α down
// to the clamp; recipes without yellow give a fairer scaling reading.
const ANCHOR_RECIPES: Record<string, [number, number, number][]> = {
  'with-yellow': [[255, 255, 0], [128, 128, 128], [0, 255, 255], [0, 0, 255]],
  'no-yellow':   [[128, 128, 128], [0, 255, 255], [0, 0, 255]],
  'gray-blue':   [[128, 128, 128], [0, 0, 255]],
  'red-only':    [[255, 0, 0], [128, 128, 128]],
}
import type { ProfileData } from '../../src/types'

const ROOT = path.resolve(process.cwd(), '..')
const REF = path.resolve(ROOT, 'data/profiles/CanvasMatte/BC_DecorMatte_P9000_mk_CanvasMatte.icm')
const TARGETS = [
  'data/profiles/CanvasMatte/BC_Lyve_P9000_mk_CanvasMatte.icm',
  'data/profiles/CanvasMatte/BC_BelgianLinen_P9000_mk_CanvasMatte.icm',
  'data/profiles/CanvasMatte/BC_ChromataWhite_P9000_mk_CanvasMatte.icm',
]

async function load(filePath: string): Promise<ProfileData> {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
  return {
    metadata: {
      full_name: name, brand: 'BC', series: name, printer: 'P9000',
      ink: 'mk', substrate: 'CanvasMatte', parsed_at: new Date().toISOString(),
    },
    raw: r.measurements,
    clean: r.measurements,
    has_spectral: r.hasSpectral,
    patch_count: r.measurements.length,
    wavelengths: r.wavelengths,
  } as unknown as ProfileData
}

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

// Pull paper spec + diagnostic anchors as InterpPoint-style {rgb, spectrum}.
function profilePoints(mx: ReturnType<typeof loadProfileMatrix>): {
  paper: number[]
  all: ObaAnchor[]
} {
  const points: ObaAnchor[] = []
  for (let i = 0; i < mx.N; i++) {
    points.push({
      rgb: [mx.D[i * 3], mx.D[i * 3 + 1], mx.D[i * 3 + 2]],
      spectrum: Array.from(mx.X.subarray(i * mx.L, i * mx.L + mx.L)),
    })
  }
  const paper = points.find(
    (p) => p.rgb[0] === 255 && p.rgb[1] === 255 && p.rgb[2] === 255,
  )?.spectrum
  if (!paper) throw new Error('no paper anchor')
  return { paper, all: points }
}

// Run D1 with the given OBA-cleaning α (1 = default D7). Returns median + P95 ΔE00.
function runD1Withα(
  X_A: Float64Array,
  X_B: Float64Array,
  D: Float64Array,
  sampleIds: string[],
  L: number,
  N: number,
  anchorIdx: number[],
  paperRowIdx: number,
  refName: string,
  tgtName: string,
  alphaA: number,
  alphaB: number,
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
) {
  const paperA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const paperB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
  const emA = extractOBAEmission(paperA)
  const emB = extractOBAEmission(paperB)
  const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
  // Apply α scaling.
  const fA_scaled = new Float64Array(fA.length)
  const fB_scaled = new Float64Array(fB.length)
  for (let i = 0; i < fA.length; i++) fA_scaled[i] = Math.min(1, Math.max(0, alphaA * fA[i]))
  for (let i = 0; i < fB.length; i++) fB_scaled[i] = Math.min(1, Math.max(0, alphaB * fB[i]))
  const X_A_clean = subtractOBA(X_A, L, fA_scaled, emA.emission)
  const X_B_clean = subtractOBA(X_B, L, fB_scaled, emB.emission)

  const { X_pred } = runPaperRatioResidualTransfer({
    X_A: X_A_clean,
    X_B: X_B_clean,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: 5,
    uvBandCount: 4,
  })

  const X_pred_final = addOBA(X_pred, L, fB_scaled, emB.emission)

  // Evaluate on non-anchor patches.
  const anchorSet = new Set(anchorIdx)
  const des: number[] = []
  // Per-band residual on 380-410 nm (first 4 bands).
  let uvSqSum = 0
  let uvN = 0
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const pred = Array.from(X_pred_final.subarray(i * L, i * L + L))
    const truth = Array.from(X_B.subarray(i * L, i * L + L))
    for (let b = 0; b < 4; b++) {
      const d = pred[b] - truth[b]
      uvSqSum += d * d
      uvN++
    }
    const lp = spectraToLab(pred)
    const lt = spectraToLab(truth)
    des.push(deltaE00(lp[0], lp[1], lp[2], lt[0], lt[1], lt[2]))
  }
  return {
    median: median(des),
    p95: percentile(des, 95),
    uvRms: Math.sqrt(uvSqSum / uvN),
  }
}

async function main() {
  const refData = await load(REF)
  const refMx = loadProfileMatrix(refData)
  const refPts = profilePoints(refMx)
  console.log(`Ref: ${path.basename(REF)}\n`)

  for (const [recipeName, targets] of Object.entries(ANCHOR_RECIPES)) {
    const refFit = fitObaScale(refPts.paper, pickObaAnchors(refPts.all, targets))
    console.log(`=== Recipe: ${recipeName} (${targets.length} anchors) ===`)
    console.log(`  α_ref (DecorMatte) = ${refFit.alpha.toFixed(3)}  (used: ${refFit.anchorsUsed})`)
    await runRecipe(refData, refMx, refPts, refFit.alpha, targets)
    console.log()
  }
}

async function runRecipe(
  refData: ProfileData,
  refMx: ReturnType<typeof loadProfileMatrix>,
  refPts: ReturnType<typeof profilePoints>,
  alphaRef: number,
  recipeTargets: [number, number, number][],
) {
  for (const tgtRel of TARGETS) {
    const tgtPath = path.resolve(ROOT, tgtRel)
    const tgtData = await load(tgtPath)
    const tgtMx = loadProfileMatrix(tgtData)
    const tgtPts = profilePoints(tgtMx)
    const tgtFit = fitObaScale(tgtPts.paper, pickObaAnchors(tgtPts.all, recipeTargets))

    const aligned = alignByCommonSampleIds(refMx, tgtMx)
    const N = aligned.sampleIds.length
    const L = refMx.L
    const X_A = new Float64Array(N * L)
    const X_B = new Float64Array(N * L)
    const D = new Float64Array(N * 3)
    for (let i = 0; i < N; i++) {
      const ai = aligned.idxA[i]
      const bi = aligned.idxB[i]
      for (let l = 0; l < L; l++) {
        X_A[i * L + l] = refMx.X[ai * L + l]
        X_B[i * L + l] = tgtMx.X[bi * L + l]
      }
      D[i * 3] = tgtMx.D[bi * 3]
      D[i * 3 + 1] = tgtMx.D[bi * 3 + 1]
      D[i * 3 + 2] = tgtMx.D[bi * 3 + 2]
    }

    const Baligned = {
      X: X_B, D, channels: 3 as const, N, L,
      wavelengths: refMx.wavelengths, sampleIds: aligned.sampleIds, droppedCount: 0,
    }
    const anchors = pickHeuristicAnchors(Baligned)
    const anchorIdx = anchors.meta?.chosenIdx as number[]
    const paperRowIdx = anchorIdx[0]
    const paperSpecB = new Float64Array(L)
    for (let l = 0; l < L; l++) paperSpecB[l] = X_B[paperRowIdx * L + l]
    const paperWP = paperWPFromBrightestPatch(paperSpecB, 1, L, refMx.wavelengths[0])

    const tgtName = path.basename(tgtPath).replace(/\.(icm|icc)$/i, '')
    const defResult = runD1Withα(
      X_A, X_B, D, aligned.sampleIds, L, N, anchorIdx, paperRowIdx,
      refData.metadata.full_name, tgtName, 1.0, 1.0, paperWP,
    )
    const h12Result = runD1Withα(
      X_A, X_B, D, aligned.sampleIds, L, N, anchorIdx, paperRowIdx,
      refData.metadata.full_name, tgtName, alphaRef, tgtFit.alpha, paperWP,
    )

    const dMed = defResult.median - h12Result.median
    const dP95 = defResult.p95 - h12Result.p95
    console.log(`  ${tgtName.padEnd(45)} α_tgt=${tgtFit.alpha.toFixed(2)}  ` +
      `def med/P95 ${defResult.median.toFixed(2)}/${defResult.p95.toFixed(2)}  ` +
      `H12 ${h12Result.median.toFixed(2)}/${h12Result.p95.toFixed(2)}  ` +
      `Δmed ${dMed >= 0 ? '−' : '+'}${Math.abs(dMed).toFixed(3)}  ` +
      `ΔP95 ${dP95 >= 0 ? '−' : '+'}${Math.abs(dP95).toFixed(3)}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
