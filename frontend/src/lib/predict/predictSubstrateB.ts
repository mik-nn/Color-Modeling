// src/lib/predict/predictSubstrateB.ts
//
// Spectral adaptation: predict all 905 patches on substrate B given:
//   - Full spectral matrix for substrate A
//   - 8 measured anchor patches on substrate B (chosen by the user)
//   - CMY device values for all patches and the anchors
//   - Paper-white spectra for both substrates
//
// Algorithm: "D1+" — paper-ratio first layer + per-λ affine second layer
// + IDW residual correction in CMY device space.
//
// Three-layer decomposition
// ─────────────────────────
//
// Layer 1 — Paper-white ratio (1 parameter per λ, zero-cost anchor):
//
//   r(λ) = paper_B(λ) / paper_A(λ)
//   B̂₁[i, λ] = r(λ) · A[i, λ]
//
//   This single multiplicative factor captures the dominant substrate effect:
//   substrate B reflects more/less light than A at each wavelength in a
//   near-constant ratio. With typical pigmented inks the paper-white ratio
//   explains ≥ 85 % of ΔE variance at k = 0.
//
// Layer 2 — Per-λ affine residual fit on the 8 anchors (2 parameters per λ):
//
//   ε₁[i, λ] = B_true[i, λ] − B̂₁[i, λ]   (observed residual at anchors)
//
//   Fit: ε̂₁(λ) = α(λ) · B̂₁(λ) + β(λ)
//     α(λ), β(λ) = OLS on the k=8 (B̂₁_anchor, ε₁_anchor) pairs.
//
//   Working on residuals rather than raw reflectance improves extrapolation:
//   α(λ) is a small correction around 1 rather than a full scale. With k=8
//   and 2 parameters/λ, the OLS system has 6 df — sufficient for variance
//   estimation but too small to overfit (no regularisation needed at this
//   rank).
//
// Layer 3 — IDW residual correction in CMY device space:
//
//   After applying layers 1+2 globally, each anchor still has a non-zero
//   residual due to device-space nonlinearity. For each non-anchor patch i,
//   interpolate its remaining correction as:
//
//   ε̂₂[i, λ] = Σ_j  w_j(i) · ε₂_anchor[j, λ]
//   where ε₂_anchor[j, λ] = B_true[j, λ] − B̂₁₊₂[j, λ]
//         w_j(i) = (1 / (dist_CMY(i, anchor_j) + ε))^p  normalised to Σw = 1
//         p = 3 (cubic IDW)
//
//   This ensures the 8 anchor predictions are exact (zero residual),
//   and nearby patches in device space get a smoothly interpolated correction.
//   With k=8 anchors spread across device space, the IDW reaches sub-patch
//   accuracy within about one grid step of each anchor.
//
// Complexity: O(N·k·L) — well under 1 ms for N=905, k=8, L=36.

const L = 36;
const IDW_POWER = 3;
const PAPER_GUARD = 1e-4;   // guard against zero paper reflectance
const RATIO_CLAMP_LO = 0.2; // min paper ratio (clamp against OBA extremes)
const RATIO_CLAMP_HI = 5.0; // max paper ratio

// ─── Internal helpers ────────────────────────────────────────────────────────


/**
 * Euclidean distance in CMY device space.
 * device values are expected in [0, 255] (RGB-addressed) or normalised.
 * The function is unit-agnostic — caller responsibility.
 */
function cmyDist(a: Float64Array, aOff: number, b: Float64Array, bOff: number): number {
  const dc = a[aOff]     - b[bOff];
  const dm = a[aOff + 1] - b[bOff + 1];
  const dy = a[aOff + 2] - b[bOff + 2];
  return Math.sqrt(dc * dc + dm * dm + dy * dy);
}

/**
 * OLS slope and intercept for pairs (x_i, y_i).
 * Returns [slope, intercept]. Falls back to slope=1, intercept=mean(y)-mean(x)
 * when variance of x is near zero (degenerate column).
 */
function olsSlopeIntercept(x: number[], y: number[]): [number, number] {
  const n = x.length;
  if (n === 0) return [1, 0];
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) { sumX += x[i]; sumY += y[i]; }
  const mx = sumX / n;
  const my = sumY / n;
  let covXY = 0, varX = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    covXY += dx * (y[i] - my);
    varX  += dx * dx;
  }
  if (varX < 1e-14) return [1, my - mx]; // degenerate: pure offset
  const slope = covXY / varX;
  return [slope, my - slope * mx];
}

// ─── Public interface ─────────────────────────────────────────────────────────

/**
 * Predict reflectance spectra for all N patches on substrate B.
 *
 * Inputs (row-major, 380–730 nm, 10 nm step, reflectance 0–1):
 *   spectra_A        [N × L]   A's measured spectra
 *   spectra_B_anchors [k × L]  B's measured spectra at k anchor patches
 *   device_A          [N × 3]  CMY device values for all patches
 *   device_anchors    [k × 3]  CMY device values for the k anchor patches
 *   paper_A           [L]      A's paper-white spectrum
 *   paper_B           [L]      B's paper-white spectrum
 *
 * Returns Float64Array [N × L] — predicted B spectra, clamped to [0, 1].
 *
 * Assumptions:
 *   - device_anchors are a subset of device_A (matched by device coordinate).
 *   - device values are on a common scale (e.g., both 0–255 or both 0–1).
 *   - Paper patches are included in spectra_A / device_A.
 */
export function predictSubstrateB(
  spectra_A: Float64Array,
  spectra_B_anchors: Float64Array,
  device_A: Float64Array,
  device_anchors: Float64Array,
  paper_A: Float64Array,
  paper_B: Float64Array,
): Float64Array {
  const N = spectra_A.length / L;
  const k = spectra_B_anchors.length / L;

  if (spectra_A.length !== N * L) {
    throw new Error(`predictSubstrateB: spectra_A length ${spectra_A.length} is not a multiple of L=${L}`);
  }
  if (spectra_B_anchors.length !== k * L) {
    throw new Error(`predictSubstrateB: spectra_B_anchors length ${spectra_B_anchors.length} is not a multiple of L=${L}`);
  }
  if (device_A.length !== N * 3) {
    throw new Error(`predictSubstrateB: device_A length ${device_A.length} ≠ N×3 = ${N * 3}`);
  }
  if (device_anchors.length !== k * 3) {
    throw new Error(`predictSubstrateB: device_anchors length ${device_anchors.length} ≠ k×3 = ${k * 3}`);
  }
  if (paper_A.length !== L || paper_B.length !== L) {
    throw new Error(`predictSubstrateB: paper spectra must have length L=${L}`);
  }
  if (k < 1) {
    throw new Error(`predictSubstrateB: need k ≥ 1 anchor patches, got ${k}`);
  }

  // ── Layer 1: paper-white ratio ────────────────────────────────────────────
  // r(λ) = paper_B(λ) / paper_A(λ), clamped against OBA-driven extremes.
  const r = new Float64Array(L);
  for (let l = 0; l < L; l++) {
    const denom = paper_A[l];
    const raw   = denom > PAPER_GUARD ? paper_B[l] / denom : 1.0;
    r[l] = raw < RATIO_CLAMP_LO ? RATIO_CLAMP_LO
         : raw > RATIO_CLAMP_HI ? RATIO_CLAMP_HI
         : raw;
  }

  // B̂₁[i, λ] = r(λ) · A[i, λ]
  const B_hat1 = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      B_hat1[i * L + l] = r[l] * spectra_A[i * L + l];
    }
  }

  // ── Layer 2: per-λ affine residual correction on the k anchor pairs ───────
  //
  // For each anchor j, locate its corresponding row in spectra_A by matching
  // device coordinates, then compute ε₁[j, λ] = B_true[j, λ] − B̂₁[j, λ].
  // Fit: ε̂₁(λ) = α(λ) · B̂₁(λ) + β(λ) via OLS.

  // For each anchor, find its matching row in device_A by minimum CMY distance.
  const anchorRowIdx = new Int32Array(k);
  for (let j = 0; j < k; j++) {
    let bestDist = Infinity;
    let bestIdx  = 0;
    for (let i = 0; i < N; i++) {
      const d = cmyDist(device_anchors, j * 3, device_A, i * 3);
      if (d < bestDist) { bestDist = d; bestIdx = i; }
    }
    anchorRowIdx[j] = bestIdx;
  }

  // Residuals ε₁ at anchors: B_true − B̂₁
  const eps1 = new Float64Array(k * L);
  for (let j = 0; j < k; j++) {
    const rowA = anchorRowIdx[j];
    for (let l = 0; l < L; l++) {
      eps1[j * L + l] = spectra_B_anchors[j * L + l] - B_hat1[rowA * L + l];
    }
  }

  // OLS: fit ε₁(λ) ~ α(λ) · B̂₁(λ) + β(λ) per wavelength.
  const alpha = new Float64Array(L);
  const beta  = new Float64Array(L);

  if (k >= 2) {
    // Sufficient anchors for regression.
    const xBuf = new Array<number>(k);
    const yBuf = new Array<number>(k);
    for (let l = 0; l < L; l++) {
      for (let j = 0; j < k; j++) {
        xBuf[j] = B_hat1[anchorRowIdx[j] * L + l];
        yBuf[j] = eps1[j * L + l];
      }
      [alpha[l], beta[l]] = olsSlopeIntercept(xBuf, yBuf);
    }
  } else {
    // k = 1: no regression possible, use offset-only (α = 0, β = mean ε₁).
    for (let l = 0; l < L; l++) {
      alpha[l] = 0;
      beta[l]  = eps1[l]; // k = 1: eps1[0, l]
    }
  }

  // Apply layers 1+2: B̂₁₊₂[i, λ] = B̂₁[i, λ] + α(λ) · B̂₁[i, λ] + β(λ)
  //                                = (1 + α(λ)) · B̂₁[i, λ] + β(λ)
  const B_hat12 = new Float64Array(N * L);
  for (let i = 0; i < N; i++) {
    for (let l = 0; l < L; l++) {
      B_hat12[i * L + l] = (1 + alpha[l]) * B_hat1[i * L + l] + beta[l];
    }
  }

  // ── Layer 3: IDW residual correction in CMY device space ─────────────────
  //
  // At each anchor j, compute the remaining error after layers 1+2:
  //   ε₂[j, λ] = B_true[j, λ] − B̂₁₊₂[anchorRow_j, λ]
  //
  // Then for every non-anchor patch i, interpolate:
  //   ε̂₂[i, λ] = Σ_j w_j(i) · ε₂[j, λ]
  //
  // This drives anchor residuals to exactly zero and smoothly corrects
  // nearby patches.

  // Residuals ε₂ at anchors.
  const eps2 = new Float64Array(k * L);
  for (let j = 0; j < k; j++) {
    const rowA = anchorRowIdx[j];
    for (let l = 0; l < L; l++) {
      eps2[j * L + l] = spectra_B_anchors[j * L + l] - B_hat12[rowA * L + l];
    }
  }

  // Output buffer — start with B̂₁₊₂, then add IDW correction.
  const out = new Float64Array(B_hat12);

  for (let i = 0; i < N; i++) {
    // Compute IDW weights: w_j = 1 / (dist(i, anchor_j)^p + eps)
    const weights = new Float64Array(k);
    let wSum = 0;
    let exactHit = -1;

    for (let j = 0; j < k; j++) {
      const d = cmyDist(device_A, i * 3, device_anchors, j * 3);
      if (d < 1e-9) {
        // Exact match: this patch IS the anchor — no interpolation needed,
        // use the anchor's own correction directly.
        exactHit = j;
        break;
      }
      const w = 1.0 / Math.pow(d, IDW_POWER);
      weights[j] = w;
      wSum += w;
    }

    if (exactHit >= 0) {
      // Patch is an anchor: apply its exact ε₂.
      for (let l = 0; l < L; l++) {
        out[i * L + l] += eps2[exactHit * L + l];
      }
    } else if (wSum > 0) {
      // Interpolate ε₂ across all anchors weighted by 1/d^p.
      for (let l = 0; l < L; l++) {
        let correction = 0;
        for (let j = 0; j < k; j++) {
          correction += (weights[j] / wSum) * eps2[j * L + l];
        }
        out[i * L + l] += correction;
      }
    }
    // If wSum === 0 (all anchors at same distance = impossible without exactHit),
    // no correction is applied — B̂₁₊₂ is the fallback.
  }

  // Clamp to valid reflectance range [0, 1].
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
  }

  return out;
}
