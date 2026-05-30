// frontend/scripts/experiments/compareD1Defaults.ts
//
// Quantify the OBA-mismatch fix on the canonical DecorMatte ↔ Lyve pair.
// Old defaults: D1 residualRank=2, uniform clamp [0.3, 3.0], no OBA separation.
// New defaults: D1 residualRank=5, UV clamp [0.1, 7.0] on 380-410 nm, D7 ON.
//
// Run: cd frontend && npx tsx scripts/experiments/compareD1Defaults.ts

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
import {
  runPaperRatioResidualTransfer,
} from '../../src/lib/predict/paperRatioResidual'
import {
  extractOBAEmission,
  computeOBAFactorPerPatch,
  subtractOBA,
  addOBA,
} from '../../src/lib/predict/obaSeparator'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'

const ROOT = path.resolve(process.cwd(), '..')
const REF = path.resolve(ROOT, 'data/profiles/CanvasMatte/BC_DecorMatte_P9000_mk_CanvasMatte.icm')
const TGT = process.env.D1_TGT
  ? path.resolve(ROOT, process.env.D1_TGT)
  : path.resolve(ROOT, 'data/profiles/CanvasMatte/BC_Lyve_P9000_mk_CanvasMatte.icm')

async function load(filePath: string) {
  const buf = await fs.readFile(filePath)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  // Wrap IcmParseResult → ProfileData shape expected by loadProfileMatrix.
  const name = path.basename(filePath).replace(/\.(icm|icc)$/i, '')
  return {
    metadata: {
      full_name: name,
      brand: 'BC',
      series: name,
      printer: 'P9000',
      ink: 'mk',
      substrate: 'CanvasMatte',
      parsed_at: new Date().toISOString(),
    },
    raw: r.measurements,
    clean: r.measurements,
    has_spectral: r.hasSpectral,
    patch_count: r.measurements.length,
    wavelengths: r.wavelengths,
  }
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

interface RunOpts {
  label: string
  residualRank: number
  uvBandCount: number
  obaSeparate: boolean
}

async function evalConfig(
  X_A: Float64Array,
  X_B: Float64Array,
  D: Float64Array,
  L: number,
  N: number,
  sampleIds: string[],
  paperWP: ReturnType<typeof paperWPFromBrightestPatch>,
  anchorIdx: number[],
  paperRowIdx: number,
  refName: string,
  tgtName: string,
  opts: RunOpts,
): Promise<{ median: number; p95: number; clampedBands: number; nTest: number }> {
  // D7 OBA-clean if requested.
  let X_A_work = X_A
  let X_B_work = X_B
  let factorsB: Float64Array | undefined
  let emissionB: ReturnType<typeof extractOBAEmission> | undefined
  if (opts.obaSeparate) {
    const paperSpecA = Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L))
    const paperSpecB = Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L))
    const emissionA = extractOBAEmission(paperSpecA)
    emissionB = extractOBAEmission(paperSpecB)
    const factorsA = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
    factorsB = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
    X_A_work = subtractOBA(X_A, L, factorsA, emissionA.emission)
    X_B_work = subtractOBA(X_B, L, factorsB, emissionB.emission)
  }

  const { fit, X_pred, report } = runPaperRatioResidualTransfer({
    X_A: X_A_work,
    X_B: X_B_work,
    D,
    sampleIds,
    anchorIdx,
    paperRowIdx,
    L,
    paperWP,
    refProfile: refName,
    targetProfile: tgtName,
    residualRank: opts.residualRank,
    uvBandCount: opts.uvBandCount,
  })

  // If D7 was on, add the target's emission back before evaluating against raw B.
  let X_pred_final = X_pred
  if (opts.obaSeparate && factorsB && emissionB) {
    X_pred_final = addOBA(X_pred, L, factorsB, emissionB.emission)
  }

  const anchorSet = new Set(anchorIdx)
  const des: number[] = []
  for (let i = 0; i < N; i++) {
    if (anchorSet.has(i)) continue
    const a = Array.from(X_pred_final.subarray(i * L, i * L + L))
    const b = Array.from(X_B.subarray(i * L, i * L + L))
    const la = spectraToLab(a)
    const lb = spectraToLab(b)
    des.push(deltaE00(la[0], la[1], la[2], lb[0], lb[1], lb[2]))
  }
  void report // silence unused
  return {
    median: median(des),
    p95: percentile(des, 95),
    clampedBands: fit.clampedBands.length,
    nTest: des.length,
  }
}

async function main() {
  const ref = await load(REF)
  const tgt = await load(TGT)
  const refMx = loadProfileMatrix(ref)
  const tgtMx = loadProfileMatrix(tgt)
  const aligned = alignByCommonSampleIds(refMx, tgtMx)
  const N = aligned.sampleIds.length
  const L = refMx.L
  console.log(`Aligned ${N} shared patches, L=${L}`)
  if (N < 50) throw new Error('too few shared patches')

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
    X: X_B,
    D,
    channels: 3 as const,
    N,
    L,
    wavelengths: refMx.wavelengths,
    sampleIds: aligned.sampleIds,
    droppedCount: 0,
  }
  const anchors = pickHeuristicAnchors(Baligned)
  const anchorIdx = anchors.meta?.chosenIdx as number[]
  const paperRowIdx = anchorIdx[0]
  const paperSpecB = new Float64Array(L)
  for (let l = 0; l < L; l++) paperSpecB[l] = X_B[paperRowIdx * L + l]
  const paperWP = paperWPFromBrightestPatch(paperSpecB, 1, L, refMx.wavelengths[0])
  console.log(`Anchors k=${anchorIdx.length}, paper row idx ${paperRowIdx}\n`)

  const configs: RunOpts[] = [
    { label: 'D1 OLD (rank=2, uniform clamp, no D7)', residualRank: 2, uvBandCount: 0, obaSeparate: false },
    { label: 'D1 + rank=5 only', residualRank: 5, uvBandCount: 0, obaSeparate: false },
    { label: 'D1 + UV clamp only (rank=2)', residualRank: 2, uvBandCount: 4, obaSeparate: false },
    { label: 'D1 + D7 only (rank=2)', residualRank: 2, uvBandCount: 0, obaSeparate: true },
    { label: 'D1 NEW (rank=5 + UV clamp + D7)', residualRank: 5, uvBandCount: 4, obaSeparate: true },
  ]

  console.log('config'.padEnd(48) + 'median'.padStart(8) + '   P95'.padStart(8) + ' clamped'.padStart(10) + ' nTest'.padStart(8))
  for (const c of configs) {
    const r = await evalConfig(X_A, X_B, D, L, N, aligned.sampleIds, paperWP, anchorIdx, paperRowIdx,
      ref.metadata.full_name, tgt.metadata.full_name, c)
    console.log(
      c.label.padEnd(48) +
        r.median.toFixed(3).padStart(8) +
        r.p95.toFixed(3).padStart(8) +
        String(r.clampedBands).padStart(10) +
        String(r.nTest).padStart(8),
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
