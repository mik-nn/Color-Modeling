// frontend/scripts/experiments/h22_anchor_comparison.ts
//
// Compare H22 MLP (k=5 S1 vs k=5 CMY-primary vs k=8) against D1 k=13.
//
// H22 k=5 S1  (default): paper + red(M+Y) + green(C+Y) + blue(C+M) + cyan(C)
// H22 k=5 CMY           : paper + cyan(C) + magenta(M) + yellow(Y) + black(CMY)
//
// Question: does CMY-primary ordering give better per-channel spreading signal?
// And which pairs does H22 uniquely handle vs D1?
//
// OBA flow (matches h22_train.ts):
//   subtract OBA → compute → add OBA back (for both pred and meas)
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h22_anchor_comparison.ts 2>&1 | tee /tmp/h22_anchor.log"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import * as tf from '@tensorflow/tfjs-node'
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

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const WEIGHTS_PATH  = path.resolve(process.cwd(), 'data/cae-input/h22_weights.json')
const MIN_MATCH     = 100
const L             = 36
const D1_RANK       = 5
const D1_UV         = 4
const DELTA_DIM     = 39
const QUERY_DIM     = 39
const INPUT_DIM     = QUERY_DIM + DELTA_DIM + 1   // 79
const K_MAX         = 13
const METALLIC_RE   = /Silverada|VibranceMetallic/i

// CMY-primary-first corner ordering: paper, C, M, Y, black, then RGB binaries
const CMY_CORNERS = [
  { name: 'paper',   rgb: [255, 255, 255] as const },
  { name: 'cyan',    rgb: [  0, 255, 255] as const },  // C only
  { name: 'magenta', rgb: [255,   0, 255] as const },  // M only
  { name: 'yellow',  rgb: [255, 255,   0] as const },  // Y only
  { name: 'black',   rgb: [  0,   0,   0] as const },  // all three
  { name: 'red',     rgb: [255,   0,   0] as const },
  { name: 'green',   rgb: [  0, 255,   0] as const },
  { name: 'blue',    rgb: [  0,   0, 255] as const },
]

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

// ─── Profile loading ──────────────────────────────────────────────────────────

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

type LP = ProfileData & { wavelengths: number[] }

async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r   = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: {
        full_name: name, brand: 'BC', series: name, printer: 'P9000', ink: 'mk',
        substrate: name, parsed_at: new Date().toISOString(), printMode: preset,
      },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

// ─── Pair alignment with OBA separation ──────────────────────────────────────

interface PairData {
  N: number
  X_A_clean: Float64Array   // OBA-subtracted
  X_B_clean: Float64Array   // OBA-subtracted
  X_B_orig:  Float64Array   // original (for D1 measurement comparison)
  D: Float64Array
  paA: Float32Array         // paper white, OBA-subtracted normalised
  paB: Float32Array
  fB:  Float64Array         // per-patch OBA factor for B
  emB: Float64Array         // OBA emission spectrum for B
  anchorIdx13: number[]     // S1 order: paper,R,G,B,cyan,M,Y,black,neutrals×5
  anchorIdxCMY8: number[]   // CMY-primary order (pick first 5 for k=5 test)
  paperRowIdx: number
  sampleIds: string[]
  wavelengths: number[]
}

function buildPairData(pA: LP, pB: LP): PairData | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(pA as any), loadProfileMatrix(pB as any))
  if (al.N < MIN_MATCH) return null
  const { N, X_A, X_B, D, sampleIds, wavelengths } = al
  const wl = wavelengths ?? Array.from({ length: L }, (_, i) => 380 + i * 10)

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

  const paA = new Float32Array(L), paB = new Float32Array(L)
  for (let l = 0; l < L; l++) {
    paA[l] = Math.max(X_A_clean[paperRowIdx*L+l], 1e-4)
    paB[l] = Math.max(X_B_clean[paperRowIdx*L+l], 1e-4)
  }

  const tgtMat = { X: X_B, D, channels: 3 as const, N, L, wavelengths: wl, sampleIds, droppedCount: 0 }
  const anchorIdx13   = (pickHeuristicAnchors(tgtMat).meta?.chosenIdx as number[]).slice(0, 13)
  const anchorIdxCMY8 = (pickHeuristicAnchors(tgtMat, { corners: CMY_CORNERS }).meta?.chosenIdx as number[]).slice(0, 8)

  return {
    N, X_A_clean, X_B_clean, X_B_orig: X_B, D, paA, paB,
    fB, emB: emB.emission,
    anchorIdx13, anchorIdxCMY8,
    paperRowIdx, sampleIds, wavelengths: wl,
  }
}

// ─── D1 evaluation ────────────────────────────────────────────────────────────

function evalD1(pd: PairData, refName: string, tgtName: string): { med: number; p95v: number; pass: boolean } {
  const anchorIdx = pd.anchorIdx13
  const anchorSet = new Set(anchorIdx)
  const paperWP   = paperWPFromBrightestPatch(
    new Float64Array(pd.X_B_orig.subarray(pd.paperRowIdx*L, pd.paperRowIdx*L+L)), 1, L, 380)

  const d1 = runPaperRatioResidualTransfer({
    X_A: pd.X_A_clean, X_B: pd.X_B_clean, D: pd.D,
    sampleIds: pd.sampleIds, anchorIdx, paperRowIdx: pd.paperRowIdx, L,
    paperWP, refProfile: refName, targetProfile: tgtName,
    residualRank: D1_RANK, knnK: 4, uvBandCount: D1_UV,
  })

  // d1.X_pred is clean (OBA-free); add OBA back then compare against original X_B_orig
  const X_pred_abs = addOBA(d1.X_pred, L, pd.fB, pd.emB)

  const des: number[] = []
  for (let i = 0; i < pd.N; i++) {
    if (anchorSet.has(i)) continue
    const pred = Array.from(X_pred_abs.subarray(i*L, i*L+L))
    const meas = Array.from(pd.X_B_orig.subarray(i*L, i*L+L))
    const lp = spectraToLab(pred), lm = spectraToLab(meas)
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95v = p95(des)
  return { med, p95v, pass: med <= 1.5 && p95v <= 3.0 }
}

// ─── H22 evaluation ───────────────────────────────────────────────────────────

function buildVec(pd: PairData, patchIdx: number, anchorIdx: number[]): Float32Array {
  const k = anchorIdx.length
  const { X_A_clean: X_A, X_B_clean: X_B, D, paA, paB } = pd
  const vec = new Float32Array(INPUT_DIM)
  // query: src_norm(36) + cmy(3)
  for (let l = 0; l < L; l++) vec[l] = X_A[patchIdx*L+l] / paA[l]
  vec[L]   = (255 - D[patchIdx*3])   / 255
  vec[L+1] = (255 - D[patchIdx*3+1]) / 255
  vec[L+2] = (255 - D[patchIdx*3+2]) / 255
  // mean_delta: mean over anchors of (tgt_norm - src_norm) + mean_anchor_cmy
  const md = new Float32Array(DELTA_DIM)
  for (const ai of anchorIdx) {
    for (let l = 0; l < L; l++) md[l] += (X_B[ai*L+l] / paB[l]) - (X_A[ai*L+l] / paA[l])
    md[L]   += (255 - D[ai*3])   / 255
    md[L+1] += (255 - D[ai*3+1]) / 255
    md[L+2] += (255 - D[ai*3+2]) / 255
  }
  for (let d = 0; d < DELTA_DIM; d++) md[d] /= k
  vec.set(md, QUERY_DIM)
  vec[QUERY_DIM + DELTA_DIM] = k / K_MAX
  return vec
}

async function evalH22(
  pd: PairData, model: tf.Sequential, anchorIdx: number[],
): Promise<{ med: number; p95v: number; pass: boolean }> {
  const anchorSet = new Set(anchorIdx)
  const testIdx   = Array.from({ length: pd.N }, (_, i) => i).filter(i => !anchorSet.has(i))
  const nTest     = testIdx.length

  const inputs = new Float32Array(nTest * INPUT_DIM)
  for (let t = 0; t < nTest; t++) inputs.set(buildVec(pd, testIdx[t], anchorIdx), t * INPUT_DIM)

  const inT   = tf.tensor2d(inputs, [nTest, INPUT_DIM])
  const predT = model.predict(inT) as tf.Tensor2D
  const pred  = await predT.data() as Float32Array
  tf.dispose([inT, predT])

  const des: number[] = []
  for (let t = 0; t < nTest; t++) {
    const si = testIdx[t]
    // Denormalize: pred_norm * paB → pred_clean
    const predClean = new Float64Array(L)
    for (let l = 0; l < L; l++) predClean[l] = pred[t*L+l] * pd.paB[l]
    // Add OBA back for both prediction and measurement
    const fSingle = new Float64Array([pd.fB[si]])
    const predAbs = Array.from(addOBA(predClean, L, fSingle, pd.emB))
    const measClean = new Float64Array(pd.X_B_clean.subarray(si*L, si*L+L))
    const measAbs   = Array.from(addOBA(measClean, L, fSingle, pd.emB))
    const lp = spectraToLab(predAbs), lm = spectraToLab(measAbs)
    des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]))
  }
  const med = median(des), p95v = p95(des)
  return { med, p95v, pass: med <= 1.5 && p95v <= 3.0 }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading profiles...')
  const files    = (await walk(PROFILES_ROOT)).sort()
  const profiles = (
    await Promise.all(
      files.filter(f => path.basename(f).startsWith('BC_')).map(loadProfile)
    )
  ).filter(Boolean) as LP[]
  console.log(`BC profiles loaded: ${profiles.length}`)

  console.log('Loading H22 weights...')
  const raw       = JSON.parse(await fs.readFile(WEIGHTS_PATH, 'utf8'))
  const modelConf = typeof raw.model_config === 'string'
    ? JSON.parse(raw.model_config) : raw.model_config
  const model     = await tf.models.modelFromJSON(modelConf) as tf.Sequential
  // Set weights: get names+shapes, build new tensors, assign, dispose the inputs
  const wMeta    = model.layers.flatMap(l => l.getWeights().map(w => ({ name: w.name, shape: w.shape })))
  const newTensors = wMeta.map(m => tf.tensor(raw.weights[m.name] as number[], m.shape))
  model.setWeights(newTensors)
  newTensors.forEach(t => t.dispose())
  console.log('H22 model loaded.')

  interface Row {
    ref: string; tgt: string; mode: string
    d1_med:    number; d1_p95:    number; d1_pass:    boolean
    s1k5_med:  number; s1k5_p95:  number; s1k5_pass:  boolean
    cmyk5_med: number; cmyk5_p95: number; cmyk5_pass: boolean
    s1k8_med:  number; s1k8_p95:  number; s1k8_pass:  boolean
  }

  const rows: Row[] = []
  let done = 0
  for (const pA of profiles) {
    for (const pB of profiles) {
      if (pA === pB) continue
      if (pA.metadata.printMode !== pB.metadata.printMode) continue
      const nA = pA.metadata.full_name, nB = pB.metadata.full_name
      if (nA.includes('AllureAq') || nB.includes('AllureAq')) continue
      if (METALLIC_RE.test(nA) || METALLIC_RE.test(nB)) continue

      const pd = buildPairData(pA, pB)
      if (!pd) continue

      const d1    = evalD1(pd, nA, nB)
      const s1k5  = await evalH22(pd, model, pd.anchorIdx13.slice(0, 5))
      const cmyk5 = await evalH22(pd, model, pd.anchorIdxCMY8.slice(0, 5))
      const s1k8  = await evalH22(pd, model, pd.anchorIdx13.slice(0, 8))

      rows.push({
        ref: nA, tgt: nB, mode: pA.metadata.printMode,
        d1_med: d1.med, d1_p95: d1.p95v, d1_pass: d1.pass,
        s1k5_med: s1k5.med, s1k5_p95: s1k5.p95v, s1k5_pass: s1k5.pass,
        cmyk5_med: cmyk5.med, cmyk5_p95: cmyk5.p95v, cmyk5_pass: cmyk5.pass,
        s1k8_med: s1k8.med, s1k8_p95: s1k8.p95v, s1k8_pass: s1k8.pass,
      })
      done++
      process.stdout.write(`\r${done} pairs evaluated...`)
    }
  }
  console.log()

  const n      = rows.length
  const d1n    = rows.filter(r => r.d1_pass).length
  const s1k5n  = rows.filter(r => r.s1k5_pass).length
  const cmyk5n = rows.filter(r => r.cmyk5_pass).length
  const s1k8n  = rows.filter(r => r.s1k8_pass).length

  console.log(`\n=== Pass rates (${n} non-metallic same-mode pairs) ===`)
  console.log(`  D1  k=13              : ${d1n}/${n} = ${(100*d1n/n).toFixed(1)}%`)
  console.log(`  H22 k=5  S1 (RGB bins): ${s1k5n}/${n} = ${(100*s1k5n/n).toFixed(1)}%`)
  console.log(`  H22 k=5  CMY-primary  : ${cmyk5n}/${n} = ${(100*cmyk5n/n).toFixed(1)}%`)
  console.log(`  H22 k=8  S1           : ${s1k8n}/${n} = ${(100*s1k8n/n).toFixed(1)}%`)

  const both    = rows.filter(r =>  r.d1_pass &&  r.s1k5_pass).length
  const d1only  = rows.filter(r =>  r.d1_pass && !r.s1k5_pass).length
  const h22only = rows.filter(r => !r.d1_pass &&  r.s1k5_pass).length
  const neither = rows.filter(r => !r.d1_pass && !r.s1k5_pass).length
  console.log('\n=== D1 k=13 vs H22 k=5 S1 cross-tab ===')
  console.log(`  Both pass   : ${both}`)
  console.log(`  D1 only     : ${d1only}   ← D1 advantage`)
  console.log(`  H22 only    : ${h22only}   ← H22 captures nonlinearity`)
  console.log(`  Both fail   : ${neither}`)

  const cmyGains = rows.filter(r => !r.s1k5_pass &&  r.cmyk5_pass).length
  const cmyLoses = rows.filter(r =>  r.s1k5_pass && !r.cmyk5_pass).length
  console.log('\n=== CMY-primary k=5 vs S1 k=5 ===')
  console.log(`  CMY gains (S1 fails → CMY passes): ${cmyGains}`)
  console.log(`  CMY loses (S1 passes → CMY fails): ${cmyLoses}`)

  console.log('\n=== D1 passes, H22 k=5 S1 fails ===')
  for (const r of rows.filter(r => r.d1_pass && !r.s1k5_pass).sort((a, b) => b.s1k5_p95 - a.s1k5_p95)) {
    const rn = r.ref.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tn = r.tgt.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tag = r.cmyk5_pass ? ' ←CMY-fixes' : ''
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  D1:${r.d1_p95.toFixed(2)}  S1:${r.s1k5_p95.toFixed(2)}  CMY:${r.cmyk5_p95.toFixed(2)}${tag}`)
  }

  console.log('\n=== H22 k=5 S1 passes, D1 fails ===')
  for (const r of rows.filter(r => !r.d1_pass && r.s1k5_pass).sort((a, b) => a.d1_p95 - b.d1_p95)) {
    const rn = r.ref.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tn = r.tgt.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  D1:med=${r.d1_med.toFixed(2)} p95=${r.d1_p95.toFixed(2)}  H22:med=${r.s1k5_med.toFixed(2)} p95=${r.s1k5_p95.toFixed(2)}`)
  }

  console.log('\n=== Both fail ===')
  for (const r of rows.filter(r => !r.d1_pass && !r.s1k5_pass).sort((a, b) => b.d1_p95 - a.d1_p95)) {
    const rn = r.ref.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    const tn = r.tgt.replace(/^BC_/, '').replace(/_P9000_.+/, '')
    console.log(`  ${rn.padEnd(22)} → ${tn.padEnd(22)}  D1:${r.d1_med.toFixed(2)}/${r.d1_p95.toFixed(2)}  S1:${r.s1k5_med.toFixed(2)}/${r.s1k5_p95.toFixed(2)}  CMY:${r.cmyk5_med.toFixed(2)}/${r.cmyk5_p95.toFixed(2)}`)
  }

  console.log('\n=== By print mode ===')
  for (const mode of [...new Set(rows.map(r => r.mode))].sort()) {
    const mr = rows.filter(r => r.mode === mode)
    const nm = mr.length
    if (!nm) continue
    console.log(`  ${mode.padEnd(26)}  D1=${mr.filter(r=>r.d1_pass).length}/${nm}  S1k5=${mr.filter(r=>r.s1k5_pass).length}/${nm}  CMYk5=${mr.filter(r=>r.cmyk5_pass).length}/${nm}  S1k8=${mr.filter(r=>r.s1k8_pass).length}/${nm}`)
  }
}

main().catch(console.error)
