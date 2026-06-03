// src/lib/predict/caeTrain.ts
//
// CAE training with learnable substrate descriptor (OBA + Paper WP).
// For now: loss computation only (no backprop). User trains via repeated forward passes
// to minimize loss via random search / grid search. Weights can be manually tuned.
//
// Future: implement full backprop. For now, focus on UI/UX and weight save/load.

import type { PredictionReport, WhitePointXYZ } from '../../types'
import { evaluatePrediction } from '../dataset/evaluate'

export interface CAEWeightsLearnable {
  schema_version: number
  variant: 'learned_desc'
  substrate_fc1_weight: number[][]
  substrate_fc1_bias: number[]
  substrate_fc2_weight: number[][]
  substrate_fc2_bias: number[]
  encoder_fc1_weight: number[][]
  encoder_fc1_bias: number[]
  encoder_fc2_weight: number[][]
  encoder_fc2_bias: number[]
  decoder_fc1_weight: number[][]
  decoder_fc1_bias: number[]
  decoder_fc2_weight: number[][]
  decoder_fc2_bias: number[]
  best_test_mse: number
  training_history: { epoch: number; loss: number }[]
}

// ─── Forward pass with learnable descriptor ──────────────────────────────

function matVec(W: number[][], x: Float64Array, b: number[], out: Float64Array): Float64Array {
  const outDim = W.length
  const inDim = W[0].length
  for (let i = 0; i < outDim; i++) {
    let s = b[i]
    const row = W[i]
    for (let j = 0; j < inDim; j++) s += row[j] * x[j]
    out[i] = s
  }
  return out
}

function relu(x: Float64Array): Float64Array {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0
  return x
}

function concat(...arrays: ArrayLike<number>[]): Float64Array {
  let total = 0
  for (const a of arrays) total += a.length
  const out = new Float64Array(total)
  let pos = 0
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) out[pos + i] = a[i]
    pos += a.length
  }
  return out
}

export class CAEForwardLearnable {
  readonly w: {
    substrate_fc1_weight: number[][]
    substrate_fc1_bias: number[]
    substrate_fc2_weight: number[][]
    substrate_fc2_bias: number[]
    encoder_fc1_weight: number[][]
    encoder_fc1_bias: number[]
    encoder_fc2_weight: number[][]
    encoder_fc2_bias: number[]
    decoder_fc1_weight: number[][]
    decoder_fc1_bias: number[]
    decoder_fc2_weight: number[][]
    decoder_fc2_bias: number[]
  }
  private subHidden: Float64Array
  private subOut: Float64Array
  private encHidden: Float64Array
  private encOut: Float64Array
  private decHidden: Float64Array
  private decOut: Float64Array

  constructor(weights: CAEWeightsLearnable) {
    this.w = weights
    this.subHidden = new Float64Array(32)
    this.subOut = new Float64Array(8)
    this.encHidden = new Float64Array(64)
    this.encOut = new Float64Array(16)
    this.decHidden = new Float64Array(64)
    this.decOut = new Float64Array(36)
  }

  encodeSubstrate(paper: ArrayLike<number>, descriptor: ArrayLike<number>): Float64Array {
    const x = concat(paper, descriptor)
    const h = matVec(this.w.substrate_fc1_weight, x, this.w.substrate_fc1_bias, this.subHidden)
    relu(h)
    matVec(this.w.substrate_fc2_weight, h, this.w.substrate_fc2_bias, this.subOut)
    return Float64Array.from(this.subOut)
  }

  encodeSpectrum(
    r: ArrayLike<number>,
    rgb: ArrayLike<number>,
    subLat: ArrayLike<number>,
  ): Float64Array {
    const x = concat(r, rgb, subLat)
    const h = matVec(this.w.encoder_fc1_weight, x, this.w.encoder_fc1_bias, this.encHidden)
    relu(h)
    matVec(this.w.encoder_fc2_weight, h, this.w.encoder_fc2_bias, this.encOut)
    return Float64Array.from(this.encOut)
  }

  decode(inkLat: ArrayLike<number>, rgb: ArrayLike<number>, subLat: ArrayLike<number>): Float64Array {
    const x = concat(inkLat, rgb, subLat)
    const h = matVec(this.w.decoder_fc1_weight, x, this.w.decoder_fc1_bias, this.decHidden)
    relu(h)
    matVec(this.w.decoder_fc2_weight, h, this.w.decoder_fc2_bias, this.decOut)
    return Float64Array.from(this.decOut)
  }
}

// ─── Training interface ────────────────────────────────────────────────────

export interface CAETrainInput {
  X_A: Float64Array
  X_B: Float64Array
  D: Float64Array
  paper_A: number[]
  paper_B: number[]
  descriptors_A: Float64Array[]
  descriptors_B: Float64Array[]
  anchorIdx: number[]
  L: number
  sampleIds: string[]
  paperWP: WhitePointXYZ
  refProfile: string
  targetProfile: string
  learningRate: number
  epochs: number
  onEpoch?: (epoch: number, loss: number) => void
}

export interface CAETrainResult {
  weights: CAEWeightsLearnable
  finalLoss: number
  history: { epoch: number; loss: number }[]
  report: PredictionReport
}

/**
 * Train CAE with learnable descriptor.
 * Currently: loss-only, no backprop (placeholder for backprop implementation).
 * Shows loss curve over epochs for UI feedback.
 */
export async function trainCAELearnable(input: CAETrainInput): Promise<CAETrainResult> {
  const {
    X_A,
    X_B,
    D,
    paper_A,
    paper_B,
    descriptors_A,
    descriptors_B,
    anchorIdx,
    L,
    sampleIds,
    paperWP,
    refProfile,
    targetProfile,
    epochs,
    onEpoch,
  } = input

  const N = sampleIds.length

  const weights: CAEWeightsLearnable = {
    schema_version: 1,
    variant: 'learned_desc',
    substrate_fc1_weight: initMatrix(32, 40, 0.01),
    substrate_fc1_bias: new Array(32).fill(0),
    substrate_fc2_weight: initMatrix(8, 32, 0.01),
    substrate_fc2_bias: new Array(8).fill(0),
    encoder_fc1_weight: initMatrix(64, 47, 0.01),
    encoder_fc1_bias: new Array(64).fill(0),
    encoder_fc2_weight: initMatrix(16, 64, 0.01),
    encoder_fc2_bias: new Array(16).fill(0),
    decoder_fc1_weight: initMatrix(64, 27, 0.01),
    decoder_fc1_bias: new Array(64).fill(0),
    decoder_fc2_weight: initMatrix(36, 64, 0.01),
    decoder_fc2_bias: new Array(36).fill(0),
    best_test_mse: Infinity,
    training_history: [],
  }

  const history: { epoch: number; loss: number }[] = []
  const fwd = new CAEForwardLearnable(weights)
  const rgb = new Float64Array(3)

  for (let epoch = 0; epoch < epochs; epoch++) {
    let epochLoss = 0

    for (let i = 0; i < N; i++) {
      const r_a_row = Array.from(X_A.subarray(i * L, i * L + L))
      const r_b_true = X_B.subarray(i * L, i * L + L)
      rgb[0] = D[i * 3] / 255
      rgb[1] = D[i * 3 + 1] / 255
      rgb[2] = D[i * 3 + 2] / 255

      const sub_a = fwd.encodeSubstrate(paper_A, descriptors_A[i])
      const sub_b = fwd.encodeSubstrate(paper_B, descriptors_B[i])
      const ink_a = fwd.encodeSpectrum(r_a_row, rgb, sub_a)
      const pred = fwd.decode(ink_a, rgb, sub_b)

      let loss = 0
      for (let l = 0; l < L; l++) {
        const err = pred[l] - r_b_true[l]
        loss += err * err
      }
      epochLoss += loss / L
    }

    epochLoss /= N
    history.push({ epoch, loss: epochLoss })
    if (onEpoch) onEpoch(epoch, epochLoss)

    if (epoch % 20 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  // Evaluate
  const anchorSet = new Set(anchorIdx)
  const testIdx: number[] = []
  for (let i = 0; i < N; i++) if (!anchorSet.has(i)) testIdx.push(i)
  const nTest = testIdx.length
  const X_pred_test = new Float64Array(nTest * L)
  const X_true_test = new Float64Array(nTest * L)
  const sids: string[] = new Array(nTest)

  for (let t = 0; t < nTest; t++) {
    const i = testIdx[t]
    sids[t] = sampleIds[i]
    const r_a = Array.from(X_A.subarray(i * L, i * L + L))
    rgb[0] = D[i * 3] / 255
    rgb[1] = D[i * 3 + 1] / 255
    rgb[2] = D[i * 3 + 2] / 255
    const sub_a = fwd.encodeSubstrate(paper_A, descriptors_A[i])
    const sub_b = fwd.encodeSubstrate(paper_B, descriptors_B[i])
    const ink_a = fwd.encodeSpectrum(r_a, rgb, sub_a)
    const pred = fwd.decode(ink_a, rgb, sub_b)
    for (let l = 0; l < L; l++) {
      X_pred_test[t * L + l] = Math.max(0, Math.min(1, pred[l]))
      X_true_test[t * L + l] = X_B[i * L + l]
    }
  }

  const report = evaluatePrediction({
    variant: `CAE_LEARNED_DESC_k${anchorIdx.length}`,
    k: anchorIdx.length,
    XPred: X_pred_test,
    XTrue: X_true_test,
    L,
    sampleIds: sids,
    paperWP,
    refProfile,
    targetProfile,
  })

  weights.training_history = history
  weights.best_test_mse = report.meanRMS ** 2

  return { weights, finalLoss: history[history.length - 1]?.loss ?? Infinity, history, report }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function initMatrix(rows: number, cols: number, scale: number): number[][] {
  const m: number[][] = []
  for (let i = 0; i < rows; i++) {
    const row: number[] = []
    for (let j = 0; j < cols; j++) {
      row.push((Math.random() - 0.5) * scale)
    }
    m.push(row)
  }
  return m
}
