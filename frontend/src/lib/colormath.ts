// src/lib/colormath.ts
// Linear color math: spectral → XYZ, Lab → XYZ under D50/2°

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
