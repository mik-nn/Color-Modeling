// src/lib/predict/batchEval.ts
//
// Batch cross-substrate evaluation: run the production D1 transfer for every
// same-mode pair among a set of loaded profiles and report pass/fail under the
// H4 gate (median ΔE00 ≤ 1.5 AND p95 ≤ 3.0). Surfaces the aggregate pass-rate
// that the single-pair UI cannot show (the "88%" of H4) and pinpoints which
// pairs fail.
//
// This mirrors the validated script path (h33/h36/etc.): S1 k anchors, OBA
// separation, paper-relative ratio + PCA residual, OBA added back before ΔE.

import { loadProfileMatrix, alignProfiles } from '../dataset/matrix';
import { pickHeuristicAnchors } from '../sampling/heuristic';
import { runPaperRatioResidualTransfer } from './paperRatioResidual';
import { paperWPFromBrightestPatch } from './perLambdaAffine';
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from './obaSeparator';
import { spectraToLab, deltaE00 } from '../colormath';
import { canonicalPrintMode } from '../../utils/printMode';
import type { ProfileData } from '../../types';

export interface BatchEvalOptions {
  /** Anchor count (S1 heuristic, default 13). */
  anchorK?: number;
  /** D1 PCA residual rank (default 5). */
  residualRank?: number;
  /** Apply D7 OBA separation (default true). */
  obaSeparate?: boolean;
  /** Gate thresholds (default median ≤ 1.5, p95 ≤ 3.0). */
  medGate?: number;
  p95Gate?: number;
  /** Minimum aligned patches to attempt a pair (default 100). */
  minAligned?: number;
}

export interface PairResult {
  ref: string;     // full_name
  tgt: string;     // full_name
  mode: string;
  median: number;
  p95: number;
  pass: boolean;
  /** Set when the pair could not be evaluated (alignment/parse). */
  skipped?: string;
}

export interface BatchEvalResult {
  pairs: PairResult[];
  /** Per-mode aggregate. */
  byMode: Array<{ mode: string; passed: number; total: number; passRate: number }>;
  passed: number;
  total: number;
  passRate: number;
}

const median = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const p95v = (xs: number[]): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(0.95 * (s.length - 1)))];
};

function modeOf(p: ProfileData): string | null {
  try { return canonicalPrintMode(p.metadata); } catch { return null; }
}

/**
 * Evaluate every ordered same-mode pair (ref ≠ tgt) among `profiles`. RGB-only.
 * Returns per-pair pass/fail plus per-mode and overall pass-rate.
 */
export function evalLoadedPairs(profiles: ProfileData[], opts: BatchEvalOptions = {}): BatchEvalResult {
  const K = opts.anchorK ?? 13;
  const rank = opts.residualRank ?? 5;
  const oba = opts.obaSeparate ?? true;
  const medGate = opts.medGate ?? 1.5;
  const p95Gate = opts.p95Gate ?? 3.0;
  const minAligned = opts.minAligned ?? 100;

  // Pre-load matrices once.
  const loaded = profiles
    .map((p) => {
      try {
        const m = loadProfileMatrix(p);
        const mode = modeOf(p);
        return m.channels === 3 && mode ? { p, m, mode } : null;
      } catch { return null; }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const pairs: PairResult[] = [];
  for (const a of loaded) {
    for (const b of loaded) {
      if (a === b || a.mode !== b.mode) continue;
      const ref = a.p.metadata.full_name;
      const tgt = b.p.metadata.full_name;
      try {
        const al = alignProfiles(a.m, b.m);
        const L = a.m.L;
        if (al.N < minAligned) { pairs.push({ ref, tgt, mode: a.mode, median: NaN, p95: NaN, pass: false, skipped: `only ${al.N} aligned` }); continue; }
        const { N, X_A, X_B, D, sampleIds, wavelengths } = al;
        let paperRowIdx = 0;
        for (let i = 0; i < N; i++) if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break; }

        let XA = X_A, XB = X_B;
        let fB: Float64Array | undefined, emB: Float64Array | undefined;
        if (oba) {
          const startWL = wavelengths?.[0] ?? 380;
          const emAo = extractOBAEmission(Array.from(X_A.subarray(paperRowIdx * L, paperRowIdx * L + L)), { startWL });
          const emBo = extractOBAEmission(Array.from(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)), { startWL });
          const fA = computeOBAFactorPerPatch(X_A, L, paperRowIdx, { startWL });
          fB = computeOBAFactorPerPatch(X_B, L, paperRowIdx, { startWL });
          emB = emBo.emission;
          XA = subtractOBA(X_A, L, fA, emAo.emission);
          XB = subtractOBA(X_B, L, fB, emBo.emission);
        }
        const paperWP = paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx * L, paperRowIdx * L + L)), 1, L, wavelengths?.[0] ?? 380);
        const tgtMat = { X: X_B, D, channels: 3 as const, N, L, wavelengths: wavelengths ?? [], sampleIds, droppedCount: 0 };
        const anchorIdx = (pickHeuristicAnchors(tgtMat).meta?.chosenIdx as number[]).slice(0, K);
        const aset = new Set(anchorIdx);
        const d1 = runPaperRatioResidualTransfer({
          X_A: XA, X_B: XB, D, sampleIds, anchorIdx, paperRowIdx, L, paperWP,
          refProfile: ref, targetProfile: tgt, residualRank: rank, knnK: 4, uvBandCount: 4,
        });
        const pred = oba && fB && emB ? addOBA(d1.X_pred, L, fB, emB) : d1.X_pred;
        const des: number[] = [];
        for (let i = 0; i < N; i++) {
          if (aset.has(i)) continue;
          const lp = spectraToLab(Array.from(pred.subarray(i * L, i * L + L)));
          const lm = spectraToLab(Array.from(X_B.subarray(i * L, i * L + L)));
          des.push(deltaE00(lp[0], lp[1], lp[2], lm[0], lm[1], lm[2]));
        }
        const med = median(des), p = p95v(des);
        pairs.push({ ref, tgt, mode: a.mode, median: med, p95: p, pass: med <= medGate && p <= p95Gate });
      } catch (e) {
        pairs.push({ ref, tgt, mode: a.mode, median: NaN, p95: NaN, pass: false, skipped: (e as Error).message });
      }
    }
  }

  const evaluated = pairs.filter((p) => !p.skipped);
  const modes = [...new Set(evaluated.map((p) => p.mode))].sort();
  const byMode = modes.map((mode) => {
    const ms = evaluated.filter((p) => p.mode === mode);
    const passed = ms.filter((p) => p.pass).length;
    return { mode, passed, total: ms.length, passRate: ms.length ? passed / ms.length : 0 };
  });
  const passed = evaluated.filter((p) => p.pass).length;
  const total = evaluated.length;
  return { pairs, byMode, passed, total, passRate: total ? passed / total : 0 };
}
