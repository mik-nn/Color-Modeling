// src/lib/analyzers/inkRatioAnalyzer.ts
// Tests ink-absorption separability from substrate via paper-normalised spectral T(λ)
// T(λ) = R_ink(λ) / R_paper(λ) — should be substrate-independent if hypothesis holds.

import { MatchedPatchPair, InkRatioResult } from '../../types';

interface ChannelDef {
  name: string;
  full: (r: number, g: number, b: number) => boolean;
  half: (r: number, g: number, b: number) => boolean;
}

const CHANNELS: ChannelDef[] = [
  {
    name: 'R',
    full:  (r, g, b) => r >= 230 && g <= 25 && b <= 25,
    half:  (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b <= 40,
  },
  {
    name: 'G',
    full:  (r, g, b) => r <= 25 && g >= 230 && b <= 25,
    half:  (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b <= 40,
  },
  {
    name: 'B',
    full:  (r, g, b) => r <= 25 && g <= 25 && b >= 230,
    half:  (r, g, b) => r <= 40 && g <= 40 && b >= 100 && b <= 160,
  },
  {
    name: 'RG',
    full:  (r, g, b) => r >= 230 && g >= 230 && b <= 25,
    half:  (r, g, b) => r >= 100 && r <= 160 && g >= 100 && g <= 160 && b <= 40,
  },
  {
    name: 'RB',
    full:  (r, g, b) => r >= 230 && g <= 25 && b >= 230,
    half:  (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b >= 100 && b <= 160,
  },
  {
    name: 'GB',
    full:  (r, g, b) => r <= 25 && g >= 230 && b >= 230,
    half:  (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b >= 100 && b <= 160,
  },
];

function filterPatches(
  patches: MatchedPatchPair[],
  test: (r: number, g: number, b: number) => boolean
): MatchedPatchPair[] {
  return patches.filter(p => test(p.ref.RGB_R ?? 0, p.ref.RGB_G ?? 0, p.ref.RGB_B ?? 0));
}

// Average spectral curve for a group, per substrate side
function avgSpectra(patches: MatchedPatchPair[], side: 'ref' | 'target'): number[] | null {
  const valid = patches.filter(p => (side === 'ref' ? p.ref.spectra : p.target.spectra));
  if (valid.length === 0) return null;
  const len = (side === 'ref' ? valid[0].ref.spectra! : valid[0].target.spectra!).length;
  const sum = new Array(len).fill(0);
  valid.forEach(p => {
    const s = side === 'ref' ? p.ref.spectra! : p.target.spectra!;
    for (let i = 0; i < len; i++) sum[i] += s[i];
  });
  return sum.map(v => v / valid.length);
}

// Element-wise division with epsilon floor: T(λ) = ink(λ) / paper(λ)
function divideSpectra(ink: number[], paper: number[]): number[] {
  return ink.map((v, i) => v / Math.max(paper[i], 0.005));
}

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const cov = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const sx = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0));
  const sy = Math.sqrt(ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return sx === 0 || sy === 0 ? 0 : cov / (sx * sy);
}

function meanAbsDev(a: number[], b: number[]): number {
  return a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;
}

// CV of per-element scale factor: b[i] / a[i]
function scaleCV(a: number[], b: number[]): number {
  const scales = a
    .map((v, i) => (Math.abs(v) > 0.01 ? b[i] / v : null))
    .filter((s): s is number => s !== null && isFinite(s) && s > 0);
  if (scales.length < 2) return 0;
  const mean = scales.reduce((x, y) => x + y, 0) / scales.length;
  const std = Math.sqrt(scales.reduce((s, v) => s + (v - mean) ** 2, 0) / scales.length);
  return mean > 0 ? std / mean : 0;
}

export function analyzeInkRatios(matchedPatches: MatchedPatchPair[]): InkRatioResult[] {
  // Paper baseline spectra
  const paperPatches = filterPatches(matchedPatches, (r, g, b) => r <= 15 && g <= 15 && b <= 15);
  const paperSpec_ref    = avgSpectra(paperPatches, 'ref');
  const paperSpec_target = avgSpectra(paperPatches, 'target');

  return CHANNELS.map(ch => {
    const fullPatches = filterPatches(matchedPatches, ch.full);
    const halfPatches = filterPatches(matchedPatches, ch.half);

    const result: InkRatioResult = {
      channel: ch.name,
      n_100: fullPatches.length,
      n_50:  halfPatches.length,
    };

    if (!paperSpec_ref || !paperSpec_target) return result;

    // Average spectra for 100% and 50% groups
    const spec100_ref    = avgSpectra(fullPatches, 'ref');
    const spec100_target = avgSpectra(fullPatches, 'target');
    const spec50_ref     = avgSpectra(halfPatches, 'ref');
    const spec50_target  = avgSpectra(halfPatches, 'target');

    // T(λ) = R_ink(λ) / R_paper(λ) — paper-normalised absorption
    if (spec100_ref && spec100_target) {
      const T100_ref    = divideSpectra(spec100_ref,    paperSpec_ref);
      const T100_target = divideSpectra(spec100_target, paperSpec_target);

      result.t_pearson_100 = pearsonR(T100_ref, T100_target);
      result.t_mad_100     = meanAbsDev(T100_ref, T100_target);
      result.t_scale_cv    = scaleCV(T100_ref, T100_target);
    }

    if (spec50_ref && spec50_target) {
      const T50_ref    = divideSpectra(spec50_ref,    paperSpec_ref);
      const T50_target = divideSpectra(spec50_target, paperSpec_target);
      result.t_pearson_50 = pearsonR(T50_ref, T50_target);
    }

    // Ratio T_100/T_50 per substrate — should be same on both if absorption scales with ink coverage
    if (spec100_ref && spec50_ref && spec100_target && spec50_target) {
      const T100_ref    = divideSpectra(spec100_ref,    paperSpec_ref);
      const T50_ref     = divideSpectra(spec50_ref,     paperSpec_ref);
      const T100_target = divideSpectra(spec100_target, paperSpec_target);
      const T50_target  = divideSpectra(spec50_target,  paperSpec_target);

      const ratioRef    = divideSpectra(T100_ref,    T50_ref);
      const ratioTarget = divideSpectra(T100_target, T50_target);

      result.t_ratio_pearson = pearsonR(ratioRef, ratioTarget);
    }

    return result;
  });
}
