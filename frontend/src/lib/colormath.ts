// src/lib/colormath.ts
// Linear color math: spectral → XYZ, Lab → XYZ under D50/2°

import type { WhitePointXYZ } from '../types';
export type { WhitePointXYZ };

// CIE 1931 2° standard observer CMFs at 10nm intervals, 380–730nm
const CMF_X = [
  0.001368, 0.004243, 0.014310, 0.043510, 0.134380, 0.283900, 0.348280, 0.336200, 0.290800,
  0.195360, 0.095640, 0.032010, 0.004900, 0.009300, 0.063270, 0.165500, 0.290400, 0.433450,
  0.594500, 0.762100, 0.916300, 1.026300, 1.062200, 1.045600, 0.971600, 0.854450, 0.708600,
  0.574200, 0.415400, 0.302400, 0.218000, 0.143700, 0.095800, 0.063700, 0.041900, 0.028700,
];
const CMF_Y = [
  0.000039, 0.000120, 0.000396, 0.001210, 0.004000, 0.011600, 0.023000, 0.038000, 0.060000,
  0.090980, 0.139020, 0.208020, 0.323000, 0.503000, 0.710000, 0.862000, 0.954000, 0.994950,
  0.995000, 0.952000, 0.870000, 0.757000, 0.631000, 0.503000, 0.381000, 0.265000, 0.175000,
  0.107000, 0.061000, 0.032000, 0.017000, 0.008210, 0.004102, 0.002091, 0.001047, 0.000520,
];
const CMF_Z = [
  0.006450, 0.020050, 0.067850, 0.207400, 0.645600, 1.385600, 1.747060, 1.772110, 1.669200,
  1.287640, 0.812950, 0.465180, 0.272000, 0.158200, 0.078250, 0.042160, 0.020300, 0.008750,
  0.003900, 0.002100, 0.001650, 0.001100, 0.000800, 0.000340, 0.000190, 0.000050, 0.000020,
  0.000050, 0.000030, 0.000050, 0.000010, 0.000000, 0.000000, 0.000000, 0.000000, 0.000000,
];
const D50 = [
  23.942, 28.022, 31.493, 38.031, 43.207, 52.088, 64.458, 67.989, 76.221, 84.854,
  92.023, 97.420, 99.858, 100.000, 97.997, 97.478, 97.746, 97.278, 97.783, 95.756,
  97.434, 96.785, 97.010, 95.785, 95.694, 95.688, 92.949, 89.937, 88.200, 87.244,
  84.374, 82.831, 80.019, 80.460, 79.174, 79.048,
];

// D50 normalisation constant: Σ D50[i] * CMF_Y[i]
const K_NORM = D50.reduce((s, d, i) => s + d * CMF_Y[i], 0);

/**
 * Convert reflectance spectrum → CIE XYZ (D50/2°).
 * Returns [X, Y, Z] as percentages (Y=100 for perfect white).
 * reflectance: values 0–1, 10nm step starting at startWL.
 */
export function spectraToXYZ(reflectance: number[], startWL = 380): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let ci = 0; ci < 36; ci++) {
    const wl = 380 + ci * 10;
    const ri = (wl - startWL) / 10;
    if (ri < 0 || ri >= reflectance.length) continue;
    const R = reflectance[ri];
    const d = D50[ci];
    X += R * d * CMF_X[ci];
    Y += R * d * CMF_Y[ci];
    Z += R * d * CMF_Z[ci];
  }
  const s = 100 / K_NORM;
  return [X * s, Y * s, Z * s];
}

// D50 white point — derived from the same SPD + CMF tables (Y=1 normalised).
// Must match the normalization used in spectraToXYZ to keep round-trips consistent.
const D50_WP: [number, number, number] = [
  D50.reduce((s, d, i) => s + d * CMF_X[i], 0) / K_NORM,
  1.0,
  D50.reduce((s, d, i) => s + d * CMF_Z[i], 0) / K_NORM,
];
const CBRT_DELTA = 6 / 29;

function labF_inv(t: number): number {
  return t > CBRT_DELTA ? t * t * t : 3 * CBRT_DELTA * CBRT_DELTA * (t - 4 / 29);
}

/**
 * CIE Lab (D50/2°) → XYZ, Y=100 normalised (same scale as spectraToXYZ).
 */
export function labToXYZ(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  return [
    labF_inv(a / 500 + fy) * D50_WP[0] * 100,
    labF_inv(fy)           * D50_WP[1] * 100,
    labF_inv(fy - b / 200) * D50_WP[2] * 100,
  ];
}

// Forward Lab function (XYZ → Lab)
function labF(t: number): number {
  const delta = 6 / 29;
  return t > delta * delta * delta ? Math.cbrt(t) : t / (3 * delta * delta) + 4 / 29;
}

/**
 * Default white point on the Y=100 scale — D50 illuminant against a perfect diffuser,
 * derived from the same SPD + CMF tables as spectraToXYZ (so a perfect reflector
 * lands at Lab=(100, 0, 0) under this default).
 */
export const D50_PERFECT_WHITE: WhitePointXYZ = [
  D50_WP[0] * 100,
  100,
  D50_WP[2] * 100,
];

/**
 * CIE XYZ (Y=100 scale) → CIE Lab against an explicit white point.
 *
 * Default `wp = D50_PERFECT_WHITE` keeps the historical behaviour: a perfect
 * diffuser under D50 lands at Lab=(100, 0, 0). Passing a substrate-derived
 * white point (e.g. the paper patch's XYZ) yields paper-relative Lab where the
 * paper sample itself sits at (100, 0, 0).
 */
export function xyzToLab(
  X: number,
  Y: number,
  Z: number,
  wp: WhitePointXYZ = D50_PERFECT_WHITE,
): [number, number, number] {
  const fx = labF(X / wp[0]);
  const fy = labF(Y / wp[1]);
  const fz = labF(Z / wp[2]);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/**
 * Reflectance spectrum → CIE Lab.
 *
 * Pass `wp` to evaluate Lab against a substrate-derived white point. Default is
 * D50 perfect-white (matches historic xyzToLab(X,Y,Z) behaviour).
 */
export function spectraToLab(
  reflectance: number[],
  startWL = 380,
  wp?: WhitePointXYZ,
): [number, number, number] {
  return xyzToLab(...spectraToXYZ(reflectance, startWL), wp);
}

/**
 * CIEDE2000 color difference between two CIE Lab colors.
 */
export function deltaE00(L1: number, a1: number, b1: number, L2: number, a2: number, b2: number): number {
  const C1ab = Math.sqrt(a1 * a1 + b1 * b1);
  const C2ab = Math.sqrt(a2 * a2 + b2 * b2);
  const avgCab = (C1ab + C2ab) / 2;
  const avgCab7 = avgCab ** 7;
  const G = 0.5 * (1 - Math.sqrt(avgCab7 / (avgCab7 + 25 ** 7)));

  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);

  const deg = 180 / Math.PI;
  let h1p = Math.atan2(b1, a1p) * deg;
  if (h1p < 0) h1p += 360;
  let h2p = Math.atan2(b2, a2p) * deg;
  if (h2p < 0) h2p += 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;

  let dhp: number;
  if (C1p * C2p === 0) {
    dhp = 0;
  } else {
    const diff = h2p - h1p;
    if (Math.abs(diff) <= 180) dhp = diff;
    else if (diff > 180) dhp = diff - 360;
    else dhp = diff + 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * Math.PI / 180);

  const avgLp = (L1 + L2) / 2;
  const avgCp = (C1p + C2p) / 2;

  let avgHp: number;
  if (C1p * C2p === 0) {
    avgHp = h1p + h2p;
  } else if (Math.abs(h1p - h2p) <= 180) {
    avgHp = (h1p + h2p) / 2;
  } else if (h1p + h2p < 360) {
    avgHp = (h1p + h2p + 360) / 2;
  } else {
    avgHp = (h1p + h2p - 360) / 2;
  }

  const rad = Math.PI / 180;
  const T = 1
    - 0.17 * Math.cos((avgHp - 30) * rad)
    + 0.24 * Math.cos(2 * avgHp * rad)
    + 0.32 * Math.cos((3 * avgHp + 6) * rad)
    - 0.20 * Math.cos((4 * avgHp - 63) * rad);

  const SL = 1 + 0.015 * (avgLp - 50) ** 2 / Math.sqrt(20 + (avgLp - 50) ** 2);
  const SC = 1 + 0.045 * avgCp;
  const SH = 1 + 0.015 * avgCp * T;

  const avgCp7 = avgCp ** 7;
  const RC = 2 * Math.sqrt(avgCp7 / (avgCp7 + 25 ** 7));
  const dTheta = 30 * Math.exp(-Math.pow((avgHp - 275) / 25, 2));
  const RT = -Math.sin(2 * dTheta * rad) * RC;

  return Math.sqrt(
    (dLp / SL) ** 2 +
    (dCp / SC) ** 2 +
    (dHp / SH) ** 2 +
    RT * (dCp / SC) * (dHp / SH),
  );
}

