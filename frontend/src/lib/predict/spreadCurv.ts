// src/lib/predict/spreadCurv.ts
//
// spreadCurv — neutral-ramp spreading curvature, an interpretable physical
// descriptor of a substrate's ink-uptake nonlinearity (H36/H37, 2026-06-16).
//
// For the neutral (R≈G≈B) ramp, fit per-wavelength
//     R(λ) / R_paper(λ) = 1 + c1(λ)·a + c2(λ)·a²          a = ink coverage ∈ [0,1]
// and take spreadCurv = ‖c1,c2‖ at 560 nm (scalar) or averaged over all bands
// (broadband). Low spreadCurv ⇒ ink holdout / on-surface (matte canvas); high ⇒
// absorbed (glossy). |Δcurv| between two substrates predicts cross-substrate
// transfer failure:
//   - AUC(Δcurv560 → fail) = 0.84; threshold ≥ 0.137 ⇒ 83% recall, 6.5% FA (H36)
//   - robust down to 3 neutral patches (white/mid/black), AUC 0.85 (H37)
//   - spreadCurv-nearest reference halves transfer p95 vs farthest (H36)
//
// M0-only: uses the profile's primary spectra, so it is immune to the M2/380 nm
// extrapolation artefact.

import type { ProfileMatrices } from '../dataset/matrix';

/** Wavelength index of 560 nm on the standard 380–730 nm / 10 nm grid. */
const IDX_560 = 18;

/** Failure-prediction threshold on |Δcurv560| (Youden-optimal, H36/H37). */
export const SPREADCURV_FAIL_THRESHOLD = 0.137;

export interface SpreadCurv {
  /** ‖c1,c2‖ of the neutral ramp at 560 nm. */
  s560: number;
  /** Mean ‖c1,c2‖ across all wavelength bands. */
  bb: number;
  /** Number of neutral ramp patches the fit used (≥3 required for a quadratic). */
  nNeutrals: number;
}

/** Fit y = 1 + c1·x + c2·x² (no free constant) by least squares. */
function fitQuadNoBias(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  if (n < 3) return [0, 0];
  let S11 = 0, S12 = 0, S22 = 0, T1 = 0, T2 = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i], x2 = x * x, r = ys[i] - 1;
    S11 += x * x; S12 += x * x2; S22 += x2 * x2; T1 += x * r; T2 += x2 * r;
  }
  const det = S11 * S22 - S12 * S12;
  if (Math.abs(det) < 1e-18) return [0, 0];
  return [(T1 * S22 - T2 * S12) / det, (T2 * S11 - T1 * S12) / det];
}

/**
 * Compute spreadCurv for an RGB profile. Returns null when the profile lacks a
 * paper-white patch or fewer than 3 neutral (R≈G≈B) ramp patches.
 */
export function computeSpreadCurv(profile: ProfileMatrices): SpreadCurv | null {
  if (profile.channels !== 3) return null; // RGB-only for now (CMY ink-coverage axis)
  const { X, D, N, L } = profile;

  // paper white: exact (255,255,255) if present, else brightest neutral.
  let paperRowIdx = -1;
  for (let i = 0; i < N; i++) {
    if (D[i * 3] === 255 && D[i * 3 + 1] === 255 && D[i * 3 + 2] === 255) { paperRowIdx = i; break; }
  }
  if (paperRowIdx < 0) {
    let best = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = D[i * 3] + D[i * 3 + 1] + D[i * 3 + 2];
      if (s > best) { best = s; paperRowIdx = i; }
    }
  }
  if (paperRowIdx < 0) return null;

  // neutral ramp rows with their ink coverage a.
  const rows: number[] = [], ai: number[] = [];
  for (let i = 0; i < N; i++) {
    const r = D[i * 3], g = D[i * 3 + 1], b = D[i * 3 + 2];
    if (Math.abs(r - g) + Math.abs(g - b) > 10) continue; // not neutral
    const a = (765 - r - g - b) / 765;
    if (a < 0.01) continue; // skip paper itself (a≈0, the fit anchor)
    rows.push(i); ai.push(a);
  }
  if (rows.length < 3) return null;

  const idx560 = Math.min(IDX_560, L - 1);
  let bbSum = 0, bbCnt = 0, s560 = 0;
  for (let l = 0; l < L; l++) {
    const pv = X[paperRowIdx * L + l];
    if (pv < 1e-5) continue;
    const ys = rows.map((i) => X[i * L + l] / pv);
    const [c1, c2] = fitQuadNoBias(ai, ys);
    const mag = Math.hypot(c1, c2);
    bbSum += mag; bbCnt++;
    if (l === idx560) s560 = mag;
  }
  return { s560, bb: bbCnt ? bbSum / bbCnt : 0, nNeutrals: rows.length };
}

export type CompatRisk = 'ok' | 'warn';

export interface PairCompatibility {
  /** |spreadCurv560(A) − spreadCurv560(B)|. */
  dCurv: number;
  /** 'warn' when dCurv ≥ SPREADCURV_FAIL_THRESHOLD (likely structural failure). */
  risk: CompatRisk;
}

/** Classify a reference/target pair by spreadCurv proximity (H36 failure flag). */
export function classifyPairCompatibility(a: SpreadCurv, b: SpreadCurv): PairCompatibility {
  const dCurv = Math.abs(a.s560 - b.s560);
  return { dCurv, risk: dCurv >= SPREADCURV_FAIL_THRESHOLD ? 'warn' : 'ok' };
}

export interface RankedReference<T> {
  ref: T;
  dCurv: number;
  risk: CompatRisk;
}

/**
 * Rank candidate references by spreadCurv proximity to a target (H36 reference
 * recommender). Nearest first; nearest-curv reference halves transfer p95.
 */
export function rankReferencesByProximity<T>(
  target: SpreadCurv,
  candidates: Array<{ ref: T; curv: SpreadCurv }>,
): Array<RankedReference<T>> {
  return candidates
    .map(({ ref, curv }) => {
      const { dCurv, risk } = classifyPairCompatibility(target, curv);
      return { ref, dCurv, risk };
    })
    .sort((x, y) => x.dCurv - y.dCurv);
}
