// spreading.ts — Per-channel CMY ink spreading (dot gain) for RGB profiles.
//
// Polynomial mode: u_eff = a*u^2 + (1-a)*u  (1 DOF per channel)
// f(0)=0, f(1)=1 for any a.  Monotone when a >= -0.5.
//
// Ported from Color_Modeling/app/model/spreading.py, reduced to 3 channels (K=0).

export interface SpreadingParams3 {
  // [a_C, a_M, a_Y] — polynomial coefficient per channel
  // a=0 → identity (no dot gain)
  theta: [number, number, number];
}

export const IDENTITY_SPREADING: SpreadingParams3 = { theta: [0, 0, 0] };

// u_eff = a*u^2 + (1-a)*u, clamped to [0,1]
function spreadPoly(u: number, a: number): number {
  const v = a * u * u + (1 - a) * u;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Apply per-channel polynomial spreading to CMY batch.
 * cmy: Float64Array (N × 3), values in [0,1]
 * Returns new Float64Array (N × 3)
 */
export function applySpreading3(
  cmy: Float64Array,
  params: SpreadingParams3,
  N: number,
): Float64Array {
  const [aC, aM, aY] = params.theta;
  const out = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    out[i * 3 + 0] = spreadPoly(cmy[i * 3 + 0], aC);
    out[i * 3 + 1] = spreadPoly(cmy[i * 3 + 1], aM);
    out[i * 3 + 2] = spreadPoly(cmy[i * 3 + 2], aY);
  }
  return out;
}

/** Pack [a_C, a_M, a_Y] into flat array for optimizer. */
export function packTheta3(params: SpreadingParams3): number[] {
  return [...params.theta];
}

/** Unpack flat optimizer vector [a_C, a_M, a_Y] to SpreadingParams3. */
export function unpackTheta3(flat: number[]): SpreadingParams3 {
  return { theta: [flat[0], flat[1], flat[2]] };
}

/**
 * Soft monotonicity penalty — sum of squared negative slopes.
 * Polynomial u_eff = a*u^2 + (1-a)*u is monotone when a >= -0.5.
 * Penalty = Σ max(0, -a - 0.5)^2 over channels.
 */
export function monotonicityPenalty3(params: SpreadingParams3): number {
  let p = 0;
  for (const a of params.theta) {
    const v = -a - 0.5;
    if (v > 0) p += v * v;
  }
  return p;
}
