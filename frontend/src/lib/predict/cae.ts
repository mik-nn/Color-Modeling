// src/lib/predict/cae.ts
//
// Pure-TS forward pass for the Conditional Autoencoder trained by
// python/cae/. Loads weights from a JSON file shipped under
// frontend/src/data/cae_weights_<variant>.json.
//
// Architecture (must match python/cae/model.py):
//   substrate encoder:  [paper(36) + onehot_id(N)] → Linear(_, 32) → ReLU → Linear(32, 8)
//   spectrum encoder:   [R(36) + RGB(3) + sub_lat(8)] → Linear(47, 64) → ReLU → Linear(64, 16)
//   decoder:            [ink_lat(16) + RGB(3) + sub_lat(8)] → Linear(27, 64) → ReLU → Linear(64, 36)
//
// All weights are stored row-major in JSON as 2-D arrays (out × in) and
// 1-D bias arrays.

import type { PredictionReport, WhitePointXYZ } from '../../types';
import { evaluatePrediction } from '../dataset/evaluate';

// ─── Weight payload shape ──────────────────────────────────────────────────

export interface CAEWeightLayers {
  'substrate_fc1.weight': number[][];
  'substrate_fc1.bias': number[];
  'substrate_fc2.weight': number[][];
  'substrate_fc2.bias': number[];
  'encoder_fc1.weight': number[][];
  'encoder_fc1.bias': number[];
  'encoder_fc2.weight': number[][];
  'encoder_fc2.bias': number[];
  'decoder_fc1.weight': number[][];
  'decoder_fc1.bias': number[];
  'decoder_fc2.weight': number[][];
  'decoder_fc2.bias': number[];
}

export interface CAEArch {
  spectral_dim: number;
  rgb_dim: number;
  substrate_latent_dim: number;
  ink_latent_dim: number;
  hidden_dim: number;
  n_substrate_ids: number;
}

export interface CAEWeights {
  schema_version: number;
  variant: 'raw' | 'd7';
  arch: CAEArch;
  id_table: Record<string, number>;
  null_id: number;
  split: { train: string[]; test: string[] };
  best_test_mse: number;
  layers: CAEWeightLayers;
}

// ─── Tiny matrix-multiply helpers (row-major dense) ────────────────────────

function matVec(W: number[][], x: Float64Array, b: number[], out: Float64Array): Float64Array {
  const outDim = W.length;
  const inDim = W[0].length;
  for (let i = 0; i < outDim; i++) {
    let s = b[i];
    const row = W[i];
    for (let j = 0; j < inDim; j++) s += row[j] * x[j];
    out[i] = s;
  }
  return out;
}

function relu(x: Float64Array): Float64Array {
  for (let i = 0; i < x.length; i++) if (x[i] < 0) x[i] = 0;
  return x;
}

function concat(...arrays: ArrayLike<number>[]): Float64Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Float64Array(total);
  let pos = 0;
  for (const a of arrays) {
    for (let i = 0; i < a.length; i++) out[pos + i] = a[i];
    pos += a.length;
  }
  return out;
}

function oneHot(id: number, n: number): Float64Array {
  const out = new Float64Array(n);
  if (id >= 0 && id < n) out[id] = 1;
  return out;
}

// ─── Forward pass ──────────────────────────────────────────────────────────

class CAEForward {
  private readonly w: CAEWeightLayers;
  private readonly arch: CAEArch;
  // Pre-allocated scratch buffers — reused across patches.
  private subHidden: Float64Array;
  private subOut: Float64Array;
  private encHidden: Float64Array;
  private encOut: Float64Array;
  private decHidden: Float64Array;
  private decOut: Float64Array;

  constructor(weights: CAEWeights) {
    this.w = weights.layers;
    this.arch = weights.arch;
    this.subHidden = new Float64Array(32);
    this.subOut = new Float64Array(this.arch.substrate_latent_dim);
    this.encHidden = new Float64Array(this.arch.hidden_dim);
    this.encOut = new Float64Array(this.arch.ink_latent_dim);
    this.decHidden = new Float64Array(this.arch.hidden_dim);
    this.decOut = new Float64Array(this.arch.spectral_dim);
  }

  encodeSubstrate(paper: ArrayLike<number>, subId: number): Float64Array {
    const x = concat(paper, oneHot(subId, this.arch.n_substrate_ids));
    relu(matVec(this.w['substrate_fc1.weight'], x, this.w['substrate_fc1.bias'], this.subHidden));
    matVec(this.w['substrate_fc2.weight'], this.subHidden, this.w['substrate_fc2.bias'], this.subOut);
    // copy out so caller can mutate scratch later
    return Float64Array.from(this.subOut);
  }

  encodeSpectrum(r: ArrayLike<number>, rgb: ArrayLike<number>, subLat: ArrayLike<number>): Float64Array {
    const x = concat(r, rgb, subLat);
    relu(matVec(this.w['encoder_fc1.weight'], x, this.w['encoder_fc1.bias'], this.encHidden));
    matVec(this.w['encoder_fc2.weight'], this.encHidden, this.w['encoder_fc2.bias'], this.encOut);
    return Float64Array.from(this.encOut);
  }

  decode(inkLat: ArrayLike<number>, rgb: ArrayLike<number>, subLat: ArrayLike<number>): Float64Array {
    const x = concat(inkLat, rgb, subLat);
    relu(matVec(this.w['decoder_fc1.weight'], x, this.w['decoder_fc1.bias'], this.decHidden));
    matVec(this.w['decoder_fc2.weight'], this.decHidden, this.w['decoder_fc2.bias'], this.decOut);
    return Float64Array.from(this.decOut);
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

export interface CAERunInput {
  weights: CAEWeights;
  /** Full reference spectra N × L. */
  X_A: Float64Array;
  /** Full target spectra N × L (ground truth; only anchorIdx rows would be observable in practice). */
  X_B: Float64Array;
  /** N × 3 RGB device values 0–255 (shared between A and B by chart construction). */
  D: Float64Array;
  /** Length-L paper spectrum of A (row at paperRowIdx). */
  paper_A: number[];
  /** Length-L paper spectrum of B. */
  paper_B: number[];
  sampleIds: string[];
  anchorIdx: number[] | Int32Array;
  paperRowIdx: number;
  L: number;
  paperWP: WhitePointXYZ;
  refProfile: string;
  targetProfile: string;
  /**
   * The substrate IDs we look up in weights.id_table. If the profile name
   * is unknown (held-out), we use weights.null_id. The model's ID-dropout
   * during training ensures graceful behaviour at the null slot.
   */
}

export interface CAERunResult {
  X_pred: Float64Array;
  report: PredictionReport;
  /** True when the target profile was in the training split. */
  targetInTrain: boolean;
  /** True when the reference profile was in the training split. */
  refInTrain: boolean;
  /** Resolved substrate IDs used at inference (-1 if null). */
  idA: number;
  idB: number;
}

/**
 * Run the trained CAE on a (ref, target) pair. The substrate-ID slots are
 * filled from weights.id_table when the profile name matches a training
 * profile; held-out profiles fall back to weights.null_id so the
 * paper-spectrum branch carries the substrate identity.
 *
 * Anchors are ignored in this baseline version — the model predicts from
 * the paper spectrum alone. A future revision can add few-shot fine-tune
 * of substrate_latent_B on the anchor residuals.
 */
export function runCAETransfer(input: CAERunInput): CAERunResult {
  const { weights, X_A, X_B, D, paper_A, paper_B, sampleIds, paperWP, L,
          refProfile, targetProfile } = input;
  const N = sampleIds.length;
  if (X_A.length !== N * L || X_B.length !== N * L) {
    throw new Error('runCAETransfer: matrix shape mismatch');
  }
  if (D.length !== N * 3) {
    throw new Error(`runCAETransfer: D shape mismatch — expected ${N * 3}, got ${D.length}`);
  }
  const idA = weights.id_table[refProfile] ?? weights.null_id;
  const idB = weights.id_table[targetProfile] ?? weights.null_id;
  const refInTrain = idA !== weights.null_id;
  const targetInTrain = idB !== weights.null_id;

  const fwd = new CAEForward(weights);
  const subA = fwd.encodeSubstrate(paper_A, idA);
  const subB = fwd.encodeSubstrate(paper_B, idB);

  const X_pred = new Float64Array(N * L);
  const rRow = new Float64Array(L);
  const rgb = new Float64Array(3);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) rRow[l] = X_A[i * L + l];
    rgb[0] = D[i * 3] / 255;
    rgb[1] = D[i * 3 + 1] / 255;
    rgb[2] = D[i * 3 + 2] / 255;
    const ink = fwd.encodeSpectrum(rRow, rgb, subA);
    const pred = fwd.decode(ink, rgb, subB);
    for (let l = 0; l < L; l++) {
      const v = pred[l];
      X_pred[i * L + l] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  // Evaluate on non-anchor patches.
  const anchorIdx = Array.from(input.anchorIdx);
  const anchorSet = new Set(anchorIdx);
  const testIdx: number[] = [];
  for (let i = 0; i < N; i++) if (!anchorSet.has(i)) testIdx.push(i);
  const nTest = testIdx.length;
  const XPredTest = new Float64Array(nTest * L);
  const XTrueTest = new Float64Array(nTest * L);
  const sids: string[] = new Array(nTest);
  for (let t = 0; t < nTest; t++) {
    const src = testIdx[t];
    sids[t] = sampleIds[src];
    for (let l = 0; l < L; l++) {
      XPredTest[t * L + l] = X_pred[src * L + l];
      XTrueTest[t * L + l] = X_B[src * L + l];
    }
  }
  const report = evaluatePrediction({
    variant: `CAE_${weights.variant.toUpperCase()}${refInTrain ? '' : '_heldRef'}${targetInTrain ? '' : '_heldTgt'}`,
    k: anchorIdx.length,
    XPred: XPredTest,
    XTrue: XTrueTest,
    L,
    sampleIds: sids,
    paperWP,
    refProfile,
    targetProfile,
  });

  return { X_pred, report, refInTrain, targetInTrain, idA, idB };
}
