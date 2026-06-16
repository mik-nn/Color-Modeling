// frontend/scripts/h28_train.ts
//
// H28 — Per-anchor device-space attention (learned IDW analogue).
//
// H26/H27 root cause: H22 mean-pools the k anchor deltas into one global
// vector, discarding device-space locality — exactly what D1's Layer-3 IDW
// supplies (+12.5 pp, H27). H28 replaces the mean pool with a learned
// attention over INDIVIDUAL anchors, keyed on device coordinates, so the
// network weights nearby anchors more (soft, cross-substrate-trained IDW).
//
// Per query patch q (normalised src spectrum s_q∈R36, device CMY c_q∈R3) and
// k anchors each (s_j, t_j, c_j):
//   delta_j  = t_j - s_j
//   score_j  = (Wq·c_q)·(Wk·c_j)/sqrt(d)        (d = attention dim)
//   a_j      = softmax_j(score_j) over real anchors (k<K_MAX padded+masked)
//   attended = Σ_j a_j · delta_j
//   corr     = ALPHA · tanh(MLP([s_q, c_q, attended]))
//   pred     = relu(s_q + attended + corr)       (residual form, mirrors D1)
//
// OBA + paper-norm handling and the leave-out-substrate split match h22_train.ts.
// Loss = MSE in normalised reflectance. k-augmented over {5,8,13}.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/h28_train.ts 2>&1 | tee /tmp/h28_train.log"

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
const WEIGHTS_OUT    = path.resolve(process.cwd(), 'data/cae-input/h28_weights.json')
const L              = 36
const C              = 3            // CMY device dims
const K_MAX          = 13           // fixed anchor slots (padded + masked)
const ATTN_DIM       = 8            // attention projection dim d
const HEAD_HID       = 64           // correction-MLP hidden width
const ALPHA          = 0.25         // correction scale (tanh-bounded)
const K_TRAIN_LIST   = [5, 8, 13]
const BATCH_SIZE     = 1024
const EPOCHS         = 200
const LR             = 3e-4
const VAL_SUBSTRATES = ['DecorMatte', 'Silverada', 'VibranceLuster']

// ── Stats ────────────────────────────────────────────────────────────────────

const median = (xs: number[]): number => {
  if (!xs.length) return NaN
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const p95 = (xs: number[]): number => {
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

type LP = ProfileData & { wavelengths: number[] }

async function loadProfile(fp: string): Promise<LP | null> {
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

// ── Pair helpers (OBA-subtracted, paper-normalised) ──────────────────────────

interface AlignedPair {
  N: number; X_A: Float64Array; X_B: Float64Array; D: Float64Array
  paA: Float32Array; paB: Float32Array
  anchorIdx13: number[]; paperRowIdx: number
  emB: { emission: Float64Array }; fB: Float64Array
}

function alignPair(profA: LP, profB: LP): AlignedPair | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al = alignProfiles(loadProfileMatrix(profA as any), loadProfileMatrix(profB as any))
  if (al.N < 100) return null
  const { N, X_A, X_B, D } = al

  let paperRowIdx = 0
  for (let i = 0; i < N; i++)
    if (D[i*3]===255 && D[i*3+1]===255 && D[i*3+2]===255) { paperRowIdx = i; break }

  const emA = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const emB = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)))
  const fA  = computeOBAFactorPerPatch(X_A, L, paperRowIdx)
  const fB  = computeOBAFactorPerPatch(X_B, L, paperRowIdx)
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

// ── Per-sample feature blocks ────────────────────────────────────────────────
//
// Each sample contributes flat blocks (padded to K_MAX anchors):
//   sq[L]              query normalised src spectrum
//   cq[C]              query device CMY
//   adelta[K_MAX*L]    per-anchor delta (tgt_norm - src_norm); zero on pad
//   acmy[K_MAX*C]      per-anchor device CMY; zero on pad
//   amask[K_MAX]       1 real / 0 pad
//   y[L]               target normalised tgt spectrum

const cmy = (D: Float64Array, i: number): [number, number, number] =>
  [(255 - D[i*3]) / 255, (255 - D[i*3+1]) / 255, (255 - D[i*3+2]) / 255]

interface Sample {
  sq: Float32Array; cq: Float32Array
  adelta: Float32Array; acmy: Float32Array; amask: Float32Array
  y: Float32Array
}

function buildSample(pd: AlignedPair, i: number, k: number): Sample {
  const { X_A, X_B, D, paA, paB, anchorIdx13 } = pd
  const sq = new Float32Array(L), y = new Float32Array(L)
  for (let l = 0; l < L; l++) { sq[l] = X_A[i*L+l] / paA[l]; y[l] = X_B[i*L+l] / paB[l] }
  const cq = Float32Array.from(cmy(D, i))

  const adelta = new Float32Array(K_MAX * L)
  const acmy   = new Float32Array(K_MAX * C)
  const amask  = new Float32Array(K_MAX)
  const anchors = anchorIdx13.slice(0, k)
  for (let j = 0; j < anchors.length; j++) {
    const ai = anchors[j]
    for (let l = 0; l < L; l++)
      adelta[j*L+l] = (X_B[ai*L+l] / paB[l]) - (X_A[ai*L+l] / paA[l])
    const c = cmy(D, ai)
    acmy[j*C] = c[0]; acmy[j*C+1] = c[1]; acmy[j*C+2] = c[2]
    amask[j] = 1
  }
  return { sq, cq, adelta, acmy, amask, y }
}

interface TrainPair { profA: LP; profB: LP }

interface Batched {
  sq: Float32Array; cq: Float32Array
  adelta: Float32Array; acmy: Float32Array; amask: Float32Array
  y: Float32Array; n: number
}

function buildDataset(pairs: TrainPair[], kList: number[]): Batched {
  const S: Sample[] = []
  for (const { profA, profB } of pairs) {
    const pd = alignPair(profA, profB)
    if (!pd) continue
    for (const k of kList) {
      const aset = new Set(pd.anchorIdx13.slice(0, k))
      for (let i = 0; i < pd.N; i++) {
        if (aset.has(i)) continue
        S.push(buildSample(pd, i, k))
      }
    }
  }
  const n = S.length
  const out: Batched = {
    sq: new Float32Array(n * L), cq: new Float32Array(n * C),
    adelta: new Float32Array(n * K_MAX * L), acmy: new Float32Array(n * K_MAX * C),
    amask: new Float32Array(n * K_MAX), y: new Float32Array(n * L), n,
  }
  for (let i = 0; i < n; i++) {
    out.sq.set(S[i].sq, i * L); out.cq.set(S[i].cq, i * C)
    out.adelta.set(S[i].adelta, i * K_MAX * L); out.acmy.set(S[i].acmy, i * K_MAX * C)
    out.amask.set(S[i].amask, i * K_MAX); out.y.set(S[i].y, i * L)
  }
  return out
}

// ── Model parameters (manual; custom attention needs a hand-built graph) ─────

const glorot = (fanIn: number, fanOut: number): tf.Tensor =>
  tf.randomUniform([fanIn, fanOut], -Math.sqrt(6/(fanIn+fanOut)), Math.sqrt(6/(fanIn+fanOut)))

const params = {
  Wq:  tf.variable(glorot(C, ATTN_DIM), true, 'Wq'),
  Wk:  tf.variable(glorot(C, ATTN_DIM), true, 'Wk'),
  W1:  tf.variable(glorot(L + C + L, HEAD_HID), true, 'W1'),
  b1:  tf.variable(tf.zeros([HEAD_HID]), true, 'b1'),
  W2:  tf.variable(glorot(HEAD_HID, L), true, 'W2'),
  b2:  tf.variable(tf.zeros([L]), true, 'b2'),
}
const paramList = Object.values(params)

// Forward pass. Inputs are batched tensors:
//   sq [B,L]  cq [B,C]  adelta [B,K,L]  acmy [B,K,C]  amask [B,K]
function forward(
  sq: tf.Tensor2D, cq: tf.Tensor2D,
  adelta: tf.Tensor3D, acmy: tf.Tensor3D, amask: tf.Tensor2D,
): tf.Tensor2D {
  return tf.tidy(() => {
    const B = sq.shape[0]
    // Attention scores on device coords: q[B,d], k[B,K,d]
    const q = tf.matMul(cq, params.Wq)                         // [B,d]
    const kk = tf.matMul(acmy.reshape([B*K_MAX, C]), params.Wk)
      .reshape([B, K_MAX, ATTN_DIM])                           // [B,K,d]
    // score[B,K] = Σ_d q·k / sqrt(d)
    const score = tf.sum(tf.mul(kk, q.reshape([B, 1, ATTN_DIM])), 2)
      .div(Math.sqrt(ATTN_DIM))                                // [B,K]
    // masked softmax: set pad scores to -1e9 before softmax
    const masked = tf.add(score, tf.mul(tf.sub(1, amask), -1e9))
    const attn = tf.softmax(masked, 1)                         // [B,K]
    // attended delta = Σ_j attn_j · adelta_j  → [B,L]
    const attended = tf.sum(tf.mul(adelta, attn.reshape([B, K_MAX, 1])), 1)
    // correction MLP on [sq, cq, attended]
    const h = tf.relu(tf.add(tf.matMul(
      tf.concat([sq, cq, attended], 1), params.W1), params.b1))
    const corr = tf.mul(tf.tanh(tf.add(tf.matMul(h, params.W2), params.b2)), ALPHA)
    // residual prediction, clamp ≥ 0
    return tf.relu(tf.add(tf.add(sq, attended), corr)) as tf.Tensor2D
  })
}

// ── Evaluation ───────────────────────────────────────────────────────────────

async function evalPairs(pairs: TrainPair[], kList: number[], label: string,
                         spotlight?: Set<string>): Promise<Map<string, boolean>> {
  console.log(`\n  ${label}`)
  const passMap = new Map<string, boolean>()
  for (const k of kList) {
    const des: number[] = []; let pass = 0, total = 0
    for (const { profA, profB } of pairs) {
      const pd = alignPair(profA, profB)
      if (!pd) continue
      const aset = new Set(pd.anchorIdx13.slice(0, k))
      const testIdx = Array.from({ length: pd.N }, (_, i) => i).filter(i => !aset.has(i))
      const nT = testIdx.length
      const S = testIdx.map(i => buildSample(pd, i, k))
      const sq = new Float32Array(nT*L), cq = new Float32Array(nT*C)
      const ad = new Float32Array(nT*K_MAX*L), ac = new Float32Array(nT*K_MAX*C)
      const am = new Float32Array(nT*K_MAX)
      for (let t = 0; t < nT; t++) {
        sq.set(S[t].sq, t*L); cq.set(S[t].cq, t*C)
        ad.set(S[t].adelta, t*K_MAX*L); ac.set(S[t].acmy, t*K_MAX*C); am.set(S[t].amask, t*K_MAX)
      }
      const predT = forward(
        tf.tensor2d(sq, [nT, L]), tf.tensor2d(cq, [nT, C]),
        tf.tensor3d(ad, [nT, K_MAX, L]), tf.tensor3d(ac, [nT, K_MAX, C]),
        tf.tensor2d(am, [nT, K_MAX]))
      const pred = await predT.data() as Float32Array
      predT.dispose()

      const pairDes: number[] = []
      for (let t = 0; t < nT; t++) {
        const src = testIdx[t]
        const fSingle = new Float64Array([pd.fB[src]])
        const predClean = new Float64Array(L), measClean = new Float64Array(L)
        for (let l = 0; l < L; l++) {
          predClean[l] = pred[t*L+l] * pd.paB[l]
          measClean[l] = pd.X_B[src*L+l]
        }
        const pa = Array.from(addOBA(predClean, L, fSingle, pd.emB.emission))
        const ma = Array.from(addOBA(measClean, L, fSingle, pd.emB.emission))
        const lp = spectraToLab(pa), lm = spectraToLab(ma)
        const de = deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2])
        des.push(de); pairDes.push(de)
      }
      const pMed = median(pairDes), pP95 = p95(pairDes)
      total++; const ok = pMed <= 1.5 && pP95 <= 3.0; if (ok) pass++
      const key = `${profA.metadata.full_name}→${profB.metadata.full_name}`
      if (k === 13) passMap.set(key, ok)
      if (spotlight && k === 13) {
        const rn = profA.metadata.full_name.replace(/^BC_/, '').replace(/_P9000_.+/, '')
        const tn = profB.metadata.full_name.replace(/^BC_/, '').replace(/_P9000_.+/, '')
        if ([...spotlight].some(s => key.includes(s)))
          console.log(`      ◆ ${rn.padEnd(18)}→ ${tn.padEnd(18)} med=${pMed.toFixed(2)} p95=${pP95.toFixed(2)} ${ok?'PASS':'fail'}`)
      }
    }
    console.log(`    k=${k}: pass=${pass}/${total} (${(100*pass/total).toFixed(1)}%)  med=${median(des).toFixed(3)}  P95=${p95(des).toFixed(3)}`)
  }
  return passMap
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Loading profiles...')
  const allFiles = await walk(PROFILES_ROOT)
  const profiles = (await Promise.all(allFiles.map(loadProfile))).filter(Boolean) as LP[]
  const bc = profiles.filter(p => p.metadata.brand === 'BC' && !p.metadata.full_name.includes('AllureAq'))
  console.log(`BC profiles (no AllureAq): ${bc.length}`)

  const isVal = (p: ProfileData) => VAL_SUBSTRATES.some(v => p.metadata.full_name.includes(v))
  const trainP = bc.filter(p => !isVal(p))
  const valP   = bc.filter(p =>  isVal(p))
  console.log(`Train substrates: ${trainP.length}  Val substrates: ${valP.length}`)

  const makePairs = (src: LP[], pool?: LP[]): TrainPair[] => {
    const P = pool ?? src, out: TrainPair[] = []
    for (const a of src) for (const b of P) {
      if (a === b || a.metadata.printMode !== b.metadata.printMode) continue
      out.push({ profA: a, profB: b })
    }
    return out
  }
  // Gates pre-registered against the 104 NON-metallic same-mode pairs (H26/H27).
  const METALLIC_RE = /Silverada|VibranceMetallic/i
  const nonMetallic = (p: TrainPair) =>
    !METALLIC_RE.test(p.profA.metadata.full_name) && !METALLIC_RE.test(p.profB.metadata.full_name)
  const trainPairs = makePairs(trainP)
  const valPairs   = makePairs(valP, bc).filter(p => isVal(p.profA) || isVal(p.profB))
  const allPairs   = makePairs(bc).filter(nonMetallic)
  console.log(`Train pairs: ${trainPairs.length}  Val pairs: ${valPairs.length}  Non-metallic eval pairs: ${allPairs.length}`)

  console.log('\nBuilding training dataset (k-augmented: 5+8+13)...')
  const ds = buildDataset(trainPairs, K_TRAIN_LIST)
  console.log(`  Train samples: ${ds.n}`)

  const opt = tf.train.adam(LR)
  const idx = Array.from({ length: ds.n }, (_, i) => i)

  console.log('\nTraining...')
  for (let epoch = 0; epoch < EPOCHS; epoch++) {
    // shuffle
    for (let i = ds.n - 1; i > 0; i--) { const j = (Math.random()*(i+1))|0; [idx[i], idx[j]] = [idx[j], idx[i]] }
    let epochLoss = 0, nb = 0
    for (let s = 0; s < ds.n; s += BATCH_SIZE) {
      const bi = idx.slice(s, s + BATCH_SIZE), B = bi.length
      const sq = new Float32Array(B*L), cq = new Float32Array(B*C)
      const ad = new Float32Array(B*K_MAX*L), ac = new Float32Array(B*K_MAX*C)
      const am = new Float32Array(B*K_MAX), yy = new Float32Array(B*L)
      for (let t = 0; t < B; t++) {
        const i = bi[t]
        sq.set(ds.sq.subarray(i*L, i*L+L), t*L)
        cq.set(ds.cq.subarray(i*C, i*C+C), t*C)
        ad.set(ds.adelta.subarray(i*K_MAX*L, i*K_MAX*L+K_MAX*L), t*K_MAX*L)
        ac.set(ds.acmy.subarray(i*K_MAX*C, i*K_MAX*C+K_MAX*C), t*K_MAX*C)
        am.set(ds.amask.subarray(i*K_MAX, i*K_MAX+K_MAX), t*K_MAX)
        yy.set(ds.y.subarray(i*L, i*L+L), t*L)
      }
      const tSq = tf.tensor2d(sq, [B, L]), tCq = tf.tensor2d(cq, [B, C])
      const tAd = tf.tensor3d(ad, [B, K_MAX, L]), tAc = tf.tensor3d(ac, [B, K_MAX, C])
      const tAm = tf.tensor2d(am, [B, K_MAX]), tY = tf.tensor2d(yy, [B, L])
      const lossT = opt.minimize(() => {
        const pred = forward(tSq, tCq, tAd, tAc, tAm)
        return tf.losses.meanSquaredError(tY, pred) as tf.Scalar
      }, true, paramList) as tf.Scalar
      epochLoss += (await lossT.data())[0]; nb++
      tf.dispose([tSq, tCq, tAd, tAc, tAm, tY, lossT])
    }
    if ((epoch + 1) % 20 === 0)
      console.log(`  Epoch ${epoch+1}/${EPOCHS}  loss=${(epochLoss/nb).toExponential(3)}`)
  }

  console.log('\n── Evaluation ──────────────────────────────────────────────────────')
  const d1only = new Set(['17MGloss', '17MSatin', 'PhotoPeelGloss'])
  await evalPairs(valPairs, [5, 8, 13], 'Validation (held-out substrates):')
  const allPass = await evalPairs(allPairs, [5, 8, 13], 'All same-mode BC pairs:', d1only)

  console.log('\n  Reference — H22 k=5 S1: 84.6%  |  D1 k=13: 88.5%  |  D1 noL3: 76.0% (H27)')
  console.log('  Gate H28a: all-pairs k=5 ≥ 84.6%   Gate H28b: recover ≥2/3 H27 D1-only pairs')

  // H28b check on the 3 H27 D1-only directed pairs.
  const D1_ONLY_PAIRS: Array<[string, string]> = [
    ['17MGloss', 'Crystalline'], ['17MSatin', 'Crystalline'], ['PhotoPeelGloss', 'VibranceGloss'],
  ]
  let recovered = 0
  console.log('\n  H28b — H27 D1-only pairs (k=13):')
  for (const [a, b] of D1_ONLY_PAIRS) {
    const hit = [...allPass.entries()].find(([key]) => key.includes(a) && key.includes(b))
    const ok = hit?.[1] ?? false
    if (ok) recovered++
    console.log(`    ${a}→${b}: ${ok ? 'PASS ✓' : 'fail ✗'}`)
  }
  console.log(`  Recovered ${recovered}/3 → Gate H28b ${recovered >= 2 ? 'PASS' : 'FAIL'}`)

  // Save weights
  const wData: Record<string, number[]> = {}
  for (const [k, v] of Object.entries(params)) wData[k] = Array.from(await v.data() as Float32Array)
  await fs.writeFile(WEIGHTS_OUT, JSON.stringify({
    arch: 'h28_anchor_attention', L, C, K_MAX, ATTN_DIM, HEAD_HID, ALPHA,
    k_list: K_TRAIN_LIST, weights: wData,
  }))
  console.log(`\nWeights saved → ${WEIGHTS_OUT}`)
}

main().catch(e => { console.error(e); process.exit(1) })
