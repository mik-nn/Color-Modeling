// frontend/scripts/h22_train.ts
//
// H22 — Cross-substrate spectral transfer MLP.
//
// Architecture (simple, effective):
//   input = concat([query_src_norm(36), query_cmy(3), mean_anchor_feats(75)]) = 114 dims
//   Dense(256,relu) → Dense(128,relu) → Dense(64,relu) → Dense(36,sigmoid)
//
// mean_anchor_feats = element-wise mean of k anchor vectors,
//   each anchor_j = [src_j_norm(36), tgt_j_norm(36), CMY_j(3)]
//
// Paper-normalised: all spectra divided by paper-white of their own profile.
// OBA: subtracted before normalisation, re-added after prediction.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/h22_train.ts 2>&1 | tee /tmp/h22_train.log"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import * as tf from '@tensorflow/tfjs-node'
import { parseIcmFile } from '../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles } from '../src/lib/dataset/matrix'
import { pickHeuristicAnchors } from '../src/lib/sampling/heuristic'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../src/lib/colormath'
import { canonicalPrintMode } from '../src/utils/printMode'
import type { ProfileData } from '../src/types'

const ROOT           = path.resolve(process.cwd(), '..')
const PROFILES_ROOT  = path.resolve(ROOT, 'data/profiles')
const WEIGHTS_OUT    = path.resolve(process.cwd(), 'data/cae-input/h22_weights.json')
const L              = 36
const DELTA_DIM      = 39   // mean(tgt_norm - src_norm)(36) + mean_cmy(3)
const QUERY_DIM      = 39   // src_norm(36) + cmy(3)
const INPUT_DIM      = QUERY_DIM + DELTA_DIM + 1  // 79  (+1 for k_norm)
const K_TRAIN_LIST   = [5, 8, 13]
const K_MAX          = 13
const BATCH_SIZE     = 1024
const EPOCHS         = 200
const LR             = 3e-4
const VAL_SUBSTRATES = ['DecorMatte', 'Silverada', 'VibranceLuster']

// ── Stats ────────────────────────────────────────────────────────────────────

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

// ── Profile loading ──────────────────────────────────────────────────────────

async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  let e: import('node:fs').Dirent[]
  try { e = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const d of e) {
    const f = path.join(dir, d.name)
    if (d.isDirectory()) out.push(...await walk(f))
    else if (d.isFile() && /\.(icm|icc)$/i.test(d.name)) out.push(f)
  }
  return out
}

async function loadProfile(fp: string): Promise<(ProfileData & { wavelengths: number[] }) | null> {
  try {
    const buf = await fs.readFile(fp)
    const ab  = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
    if (!r.hasSpectral || !r.measurements.length) return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i, '')
    let preset: string
    try { preset = canonicalPrintMode(name) } catch { return null }
    return {
      metadata: { full_name: name, brand: name.startsWith('BC') ? 'BC' : 'MOAB',
        series: name, printer: 'P9000', ink: 'mk', substrate: name,
        parsed_at: new Date().toISOString(), printMode: preset },
      raw: r.measurements, clean: r.measurements,
      has_spectral: true, patch_count: r.measurements.length,
      wavelengths: r.wavelengths ?? Array.from({ length: 36 }, (_, i) => 380 + i * 10),
    }
  } catch { return null }
}

// ── Pair helpers ─────────────────────────────────────────────────────────────

interface AlignedPair {
  N: number; X_A: Float64Array; X_B: Float64Array; D: Float64Array
  paA: Float32Array; paB: Float32Array  // paper-white (OBA-subtracted) per profile
  anchorIdx13: number[]                 // first 13 heuristic anchors
  paperRowIdx: number
  emB: { emission: Float64Array }
  fB: Float64Array
}

function alignPair(
  profA: ProfileData & { wavelengths: number[] },
  profB: ProfileData & { wavelengths: number[] },
): AlignedPair | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < 100) return null
  const { N, X_A, X_B, D } = al

  let paperRowIdx = 0
  for (let i = 0; i < N; i++) {
    if (D[i*3]===255 && D[i*3+1]===255 && D[i*3+2]===255) { paperRowIdx = i; break }
  }
  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)

  // Update X_A/X_B in-place with OBA-subtracted versions (create new buffers)
  const XA_c = subtractOBA(X_A, L, fA, emA.emission)
  const XB_c = subtractOBA(X_B, L, fB, emB.emission)

  const paA = new Float32Array(L), paB = new Float32Array(L)
  for (let l = 0; l < L; l++) {
    paA[l] = Math.max(XA_c[paperRowIdx*L+l], 1e-4)
    paB[l] = Math.max(XB_c[paperRowIdx*L+l], 1e-4)
  }

  const tgt = { X: X_B, D, channels: 3 as const, N, L,
    wavelengths: al.wavelengths ?? [], sampleIds: al.sampleIds, droppedCount: 0 }
  const anchorIdx13 = (pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0, 13)

  return { N, X_A: XA_c, X_B: XB_c, D, paA, paB, anchorIdx13, paperRowIdx, emB, fB }
}

// Build flat input vector for one patch:
//   query(39) = [src_norm(36), cmy(3)]
//   mean_delta(39) = [mean(tgt_j_norm - src_j_norm)(36), mean_cmy(3)]
//   k_norm(1) = k / K_MAX
//   total = 79 dims
function buildInputVec(
  pairData: AlignedPair, patchIdx: number, k: number,
): Float32Array {
  const { X_A, X_B, D, paA, paB, anchorIdx13 } = pairData
  const anchorIdx = anchorIdx13.slice(0, k)
  const vec = new Float32Array(INPUT_DIM)

  // query: src_norm + CMY
  for (let l = 0; l < L; l++) vec[l] = X_A[patchIdx*L+l] / paA[l]
  vec[L]   = (255 - D[patchIdx*3]) / 255
  vec[L+1] = (255 - D[patchIdx*3+1]) / 255
  vec[L+2] = (255 - D[patchIdx*3+2]) / 255

  // mean_delta: mean(tgt_j_norm - src_j_norm) + mean_cmy
  const meanDelta = new Float32Array(DELTA_DIM)
  for (const ai of anchorIdx) {
    for (let l = 0; l < L; l++) {
      meanDelta[l] += (X_B[ai*L+l] / paB[l]) - (X_A[ai*L+l] / paA[l])
    }
    meanDelta[L]   += (255 - D[ai*3]) / 255
    meanDelta[L+1] += (255 - D[ai*3+1]) / 255
    meanDelta[L+2] += (255 - D[ai*3+2]) / 255
  }
  for (let d = 0; d < DELTA_DIM; d++) meanDelta[d] /= k
  vec.set(meanDelta, QUERY_DIM)

  // k_norm
  vec[QUERY_DIM + DELTA_DIM] = k / K_MAX
  return vec
}

// ── Dataset building ──────────────────────────────────────────────────────────

interface TrainPair { profA: ProfileData & { wavelengths: number[] }; profB: ProfileData & { wavelengths: number[] } }

// k-augmentation: generate samples for each k in kList, non-anchor patches vary by k
function buildDataset(pairs: TrainPair[], kList: number[]): { inputs: Float32Array; targets: Float32Array; n: number } {
  const allX: Float32Array[] = [], allY: Float32Array[] = []
  for (const { profA, profB } of pairs) {
    const pd = alignPair(profA, profB)
    if (!pd) continue
    for (const k of kList) {
      const anchorSet = new Set(pd.anchorIdx13.slice(0, k))
      for (let i = 0; i < pd.N; i++) {
        if (anchorSet.has(i)) continue
        allX.push(buildInputVec(pd, i, k))
        const y = new Float32Array(L)
        for (let l = 0; l < L; l++) y[l] = pd.X_B[i*L+l] / pd.paB[l]
        allY.push(y)
      }
    }
  }
  const n = allX.length
  const inputs  = new Float32Array(n * INPUT_DIM)
  const targets = new Float32Array(n * L)
  for (let i = 0; i < n; i++) {
    inputs.set(allX[i], i * INPUT_DIM)
    targets.set(allY[i], i * L)
  }
  return { inputs, targets, n }
}

// ── Model ────────────────────────────────────────────────────────────────────

function buildModel(): tf.Sequential {
  const m = tf.sequential({ name: 'h22' })
  m.add(tf.layers.dense({ units: 256, activation: 'relu', inputShape: [INPUT_DIM] }))
  m.add(tf.layers.dense({ units: 128, activation: 'relu' }))
  m.add(tf.layers.dense({ units: 64,  activation: 'relu' }))
  m.add(tf.layers.dense({ units: L,   activation: 'sigmoid' }))
  m.compile({ optimizer: tf.train.adam(LR), loss: 'meanSquaredError' })
  return m
}

// ── Evaluation ───────────────────────────────────────────────────────────────

async function evalPairs(
  pairs: TrainPair[],
  model: tf.Sequential,
  kList: number[],
  label: string,
): Promise<void> {
  console.log(`\n  ${label}`)
  for (const k of kList) {
    const des: number[] = []; let pass = 0, total = 0
    for (const { profA, profB } of pairs) {
      const pd = alignPair(profA, profB)
      if (!pd) continue
      const anchorSet = new Set(pd.anchorIdx13.slice(0, k))
      const testIdx = Array.from({ length: pd.N }, (_, i) => i).filter(i => !anchorSet.has(i))
      const nTest = testIdx.length
      const inputs = new Float32Array(nTest * INPUT_DIM)
      for (let t = 0; t < nTest; t++) inputs.set(buildInputVec(pd, testIdx[t], k), t * INPUT_DIM)
      const inT   = tf.tensor2d(inputs, [nTest, INPUT_DIM])
      const predT = model.predict(inT) as tf.Tensor2D
      const predData = await predT.data() as Float32Array
      tf.dispose([inT, predT])

      const pairDes: number[] = []
      for (let t = 0; t < nTest; t++) {
        const src = testIdx[t]
        // Single-patch OBA factor for this patch index
        const fSingle = new Float64Array([pd.fB[src]])

        const predClean = new Float64Array(L)
        for (let l = 0; l < L; l++) predClean[l] = predData[t*L+l] * pd.paB[l]
        const predAbs = Array.from(addOBA(predClean, L, fSingle, pd.emB.emission))

        const measClean = new Float64Array(L)
        for (let l = 0; l < L; l++) measClean[l] = pd.X_B[src*L+l]
        const measAbs = Array.from(addOBA(measClean, L, fSingle, pd.emB.emission))

        const lp = spectraToLab(predAbs), lm = spectraToLab(measAbs)
        const de = deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2])
        des.push(de); pairDes.push(de)
      }
      const pMed = median(pairDes), pP95 = p95(pairDes)
      total++; if (pMed <= 1.5 && pP95 <= 3.0) pass++
    }
    console.log(`    k=${k}: pass=${pass}/${total} (${(100*pass/total).toFixed(1)}%)  med=${median(des).toFixed(3)}  P95=${p95(des).toFixed(3)}`)
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading profiles...')
  const allFiles = await walk(PROFILES_ROOT)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as Array<ProfileData & { wavelengths: number[] }>
  const bc = profiles.filter(p => p.metadata.brand === 'BC' && !p.metadata.full_name.includes('AllureAq'))
  console.log(`BC profiles (no AllureAq): ${bc.length}`)

  const isVal = (p: ProfileData) => VAL_SUBSTRATES.some(v => p.metadata.full_name.includes(v))
  const trainP = bc.filter(p => !isVal(p))
  const valP   = bc.filter(p =>  isVal(p))
  console.log(`Train substrates: ${trainP.length}  Val substrates: ${valP.length}`)

  const makePairs = (src: typeof bc, tgt?: typeof bc): TrainPair[] => {
    const pool = tgt ?? src
    const out: TrainPair[] = []
    for (const a of src) for (const b of pool) {
      if (a === b || a.metadata.printMode !== b.metadata.printMode) continue
      out.push({ profA: a, profB: b })
    }
    return out
  }
  const trainPairs = makePairs(trainP)
  const valPairs   = makePairs(valP, bc).filter(p => isVal(p.profA) || isVal(p.profB))
  const allPairs   = makePairs(bc)
  console.log(`Train pairs: ${trainPairs.length}  Val pairs: ${valPairs.length}`)

  console.log('\nBuilding training dataset (k-augmented: 5+8+13)...')
  const { inputs: Xtrain, targets: Ytrain, n: nTrain } = buildDataset(trainPairs, K_TRAIN_LIST)
  console.log(`  Train samples: ${nTrain}`)

  const model = buildModel()
  model.summary()

  console.log('\nTraining...')
  await model.fit(
    tf.tensor2d(Xtrain, [nTrain, INPUT_DIM]),
    tf.tensor2d(Ytrain, [nTrain, L]),
    {
      batchSize: BATCH_SIZE, epochs: EPOCHS,
      validationSplit: 0.05,
      callbacks: {
        onEpochEnd: async (epoch, logs) => {
          if ((epoch + 1) % 20 === 0) {
            process.stdout.write(`  Epoch ${epoch+1}/${EPOCHS}  loss=${logs?.loss.toFixed(6)}  val_loss=${logs?.val_loss?.toFixed(6) ?? 'n/a'}\n`)
          }
        },
      },
    },
  )

  console.log('\n── Evaluation ──────────────────────────────────────────────────────')
  await evalPairs(valPairs,  model, [5, 8, 13], 'Validation (held-out substrates):')
  await evalPairs(allPairs,  model, [5, 8, 13], 'All same-mode BC pairs:')

  // Compare D1 baseline on all pairs
  console.log('\n  D1 baseline reference (from H19c): k=8=78.1%, k=13=83.3%')
  console.log('  H22 gate: k=5 ≥ 78.1%  (H22a)  |  k=8 ≥ 90%  (H22b)')

  // Save weights
  const wData: Record<string, number[]> = {}
  for (const layer of model.layers) {
    for (const w of layer.getWeights()) {
      wData[w.name] = Array.from(await w.data() as Float32Array)
    }
  }
  await fs.writeFile(WEIGHTS_OUT, JSON.stringify({
    arch: 'h22_delta_mlp_kaug', k_list: K_TRAIN_LIST, L,
    INPUT_DIM, model_config: model.toJSON(),
    weights: wData,
  }))
  console.log(`\nWeights saved → ${WEIGHTS_OUT}`)
}

main().catch(console.error)
