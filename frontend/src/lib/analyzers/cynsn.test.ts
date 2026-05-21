// cynsn.test.ts
import { describe, it, expect } from 'vitest';
import {
  demichel3,
  demichel3Batch,
  findCell3,
  buildGridFromColorants3,
  predictSpectra3,
  extractNeugebauerPrimaries3,
  trainCYNSN3,
  evaluateCYNSN3,
  rgbToCmy,
  PRIMARY_ORDER_3D,
} from './cynsn';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build synthetic primaries: each primary is a flat reflectance spectrum. */
function syntheticPrimaries(nL: number): Float64Array {
  const p = new Float64Array(8 * nL);
  // Reflectance values for each of 8 CMY binary corners
  const r = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.1];
  for (let v = 0; v < 8; v++) {
    for (let wi = 0; wi < nL; wi++) p[v * nL + wi] = r[v];
  }
  return p;
}

// ─── rgbToCmy ─────────────────────────────────────────────────────────────────

describe('rgbToCmy', () => {
  it('white (255,255,255) → (0,0,0)', () => {
    expect(rgbToCmy(255, 255, 255)).toEqual([0, 0, 0]);
  });
  it('black (0,0,0) → (1,1,1)', () => {
    expect(rgbToCmy(0, 0, 0)).toEqual([1, 1, 1]);
  });
  it('cyan (0,255,255) → (1,0,0)', () => {
    const [c, m, y] = rgbToCmy(0, 255, 255);
    expect(c).toBeCloseTo(1); expect(m).toBeCloseTo(0); expect(y).toBeCloseTo(0);
  });
});

// ─── demichel3 ────────────────────────────────────────────────────────────────

describe('demichel3', () => {
  it('weights sum to 1 for arbitrary CMY', () => {
    const cases: [number, number, number][] = [
      [0, 0, 0], [1, 1, 1], [0.5, 0.5, 0.5],
      [0.3, 0.6, 0.1], [0.99, 0.01, 0.5],
    ];
    for (const [c, m, y] of cases) {
      const w = demichel3(c, m, y);
      const sum = w.reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it('corner (0,0,0) → w[0]=1, rest=0', () => {
    const w = demichel3(0, 0, 0);
    expect(w[0]).toBe(1);
    for (let i = 1; i < 8; i++) expect(w[i]).toBe(0);
  });

  it('corner (1,1,1) → w[7]=1, rest=0', () => {
    const w = demichel3(1, 1, 1);
    expect(w[7]).toBe(1);
    for (let i = 0; i < 7; i++) expect(w[i]).toBe(0);
  });

  it('all weights non-negative', () => {
    const w = demichel3(0.3, 0.7, 0.5);
    for (const v of w) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe('demichel3Batch', () => {
  it('matches per-point demichel3', () => {
    const pts: [number, number, number][] = [[0.2, 0.5, 0.8], [0, 1, 0.5], [0.9, 0.1, 0.3]];
    const N = pts.length;
    const cmy = new Float64Array(N * 3);
    pts.forEach(([c, m, y], i) => {
      cmy[i * 3] = c; cmy[i * 3 + 1] = m; cmy[i * 3 + 2] = y;
    });
    const W = demichel3Batch(cmy, N);
    for (let i = 0; i < N; i++) {
      const w = demichel3(pts[i][0], pts[i][1], pts[i][2]);
      for (let v = 0; v < 8; v++) {
        expect(W[i * 8 + v]).toBeCloseTo(w[v], 10);
      }
    }
  });
});

// ─── findCell3 ────────────────────────────────────────────────────────────────

describe('findCell3', () => {
  it('n_intervals=1: all samples in cell 0', () => {
    const cmy = new Float64Array([0.3, 0.7, 0.5]);
    const { cell_idx } = findCell3(cmy, 1, 1);
    expect(cell_idx[0]).toBe(0);
    expect(cell_idx[1]).toBe(0);
    expect(cell_idx[2]).toBe(0);
  });

  it('n_intervals=2: midpoint (0.5) goes to cell 1', () => {
    const cmy = new Float64Array([0.5, 0.5, 0.5]);
    const { cell_idx, norm_coords } = findCell3(cmy, 1, 2);
    expect(cell_idx[0]).toBe(1);
    expect(norm_coords[0]).toBeCloseTo(0, 6);
  });

  it('norm_coords in [0,1]', () => {
    const N = 5;
    const cmy = new Float64Array([0, 0.25, 0.5, 0.75, 1.0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5]);
    const { norm_coords } = findCell3(cmy, N, 4);
    for (let i = 0; i < N * 3; i++) {
      expect(norm_coords[i]).toBeGreaterThanOrEqual(0);
      expect(norm_coords[i]).toBeLessThanOrEqual(1);
    }
  });
});

// ─── buildGridFromColorants3 ──────────────────────────────────────────────────

describe('buildGridFromColorants3', () => {
  const nL = 4;
  const primaries = syntheticPrimaries(nL);

  it('n_intervals=1: grid has 2^3=8 nodes', () => {
    const grid = buildGridFromColorants3(primaries, nL, 1, 2.0);
    expect(grid.length).toBe(8 * nL);
  });

  it('n_intervals=2: grid has 3^3=27 nodes', () => {
    const grid = buildGridFromColorants3(primaries, nL, 2, 2.0);
    expect(grid.length).toBe(27 * nL);
  });

  it('grid values in [0,1]', () => {
    const grid = buildGridFromColorants3(primaries, nL, 2, 2.0);
    for (let i = 0; i < grid.length; i++) {
      expect(grid[i]).toBeGreaterThanOrEqual(0);
      expect(grid[i]).toBeLessThanOrEqual(1);
    }
  });

  it('binary corners reproduce primaries (n_intervals=1)', () => {
    // With n_intervals=1, grid nodes ARE the 8 Neugebauer corners.
    // Prediction at corner CMY should match the primary spectrum.
    const grid = buildGridFromColorants3(primaries, nL, 1, 2.0);
    for (let v = 0; v < 8; v++) {
      const [c, m, y] = PRIMARY_ORDER_3D[v];
      const cmy = new Float64Array([c, m, y]);
      const pred = predictSpectra3(grid, nL, 2.0, 1, cmy, 1);
      for (let wi = 0; wi < nL; wi++) {
        expect(pred[wi]).toBeCloseTo(primaries[v * nL + wi], 4);
      }
    }
  });
});

// ─── predictSpectra3 ─────────────────────────────────────────────────────────

describe('predictSpectra3', () => {
  const nL = 4;
  const primaries = syntheticPrimaries(nL);

  it('output shape = N × nL', () => {
    const N = 10;
    const grid = buildGridFromColorants3(primaries, nL, 1, 2.0);
    const cmy = new Float64Array(N * 3).fill(0.5);
    const pred = predictSpectra3(grid, nL, 2.0, 1, cmy, N);
    expect(pred.length).toBe(N * nL);
  });

  it('predicted values in [0,1]', () => {
    const grid = buildGridFromColorants3(primaries, nL, 2, 2.0);
    const cmy = new Float64Array([0.3, 0.6, 0.2]);
    const pred = predictSpectra3(grid, nL, 2.0, 2, cmy, 1);
    for (let i = 0; i < nL; i++) {
      expect(pred[i]).toBeGreaterThanOrEqual(0);
      expect(pred[i]).toBeLessThanOrEqual(1);
    }
  });
});

// ─── extractNeugebauerPrimaries3 ─────────────────────────────────────────────

describe('extractNeugebauerPrimaries3', () => {
  const nL = 4;

  it('extracts each of 8 corners when exact matches exist', () => {
    const N = 8;
    const cmy = new Float64Array(N * 3);
    const spec = new Float64Array(N * nL);
    PRIMARY_ORDER_3D.forEach(([c, m, y], v) => {
      cmy[v * 3] = c; cmy[v * 3 + 1] = m; cmy[v * 3 + 2] = y;
      for (let wi = 0; wi < nL; wi++) spec[v * nL + wi] = 0.1 * (v + 1);
    });
    const { primaries, matched, matchDistances } = extractNeugebauerPrimaries3(cmy, spec, N, nL);
    for (let v = 0; v < 8; v++) {
      // KNN-weighted: nearest is exact match, others are far away.
      // Inverse-distance weight makes nearest dominant → ≈ exact value.
      expect(primaries[v * nL]).toBeCloseTo(0.1 * (v + 1), 1);
      expect(matched[v]).toBe(true);
      expect(matchDistances[v]).toBeCloseTo(0, 6);
    }
  });

  it('reports unmatched corners when no patch within tolerance', () => {
    // Only one patch present, far from all corners
    const cmy = new Float64Array([0.5, 0.5, 0.5]);
    const spec = new Float64Array([0.5, 0.5, 0.5, 0.5]);
    const { matched, matchDistances } = extractNeugebauerPrimaries3(cmy, spec, 1, 4);
    // All 8 corners are sqrt(0.75) ≈ 0.866 away, > exactTol=0.1
    for (let v = 0; v < 8; v++) {
      expect(matched[v]).toBe(false);
      expect(matchDistances[v]).toBeGreaterThan(0.1);
    }
  });
});

// ─── trainCYNSN3 + evaluateCYNSN3 ────────────────────────────────────────────

describe('trainCYNSN3 (synthetic flat-spectrum dataset)', () => {
  // Build a synthetic dataset where primaries are known.
  // YNSN prediction should achieve dE00 ≈ 0 when primaries are exact.
  const nL = 6;
  const wavelengths = Array.from({ length: nL }, (_, i) => 380 + i * 10);
  const N = 24;

  // Generate N random CMY points + spectra using known n=2 and no spreading
  function makeDataset() {
    const primaries = syntheticPrimaries(nL);
    const grid = buildGridFromColorants3(primaries, nL, 1, 2.0);
    const cmy = new Float64Array(N * 3);
    // Spread CMY values across [0,1] range
    for (let i = 0; i < N; i++) {
      cmy[i * 3]     = (i % 4) * 0.3 + 0.05;
      cmy[i * 3 + 1] = ((i >> 2) % 4) * 0.3 + 0.05;
      cmy[i * 3 + 2] = ((i >> 4) % 4) * 0.3 + 0.05;
    }
    // Ground-truth spectra = YNSN prediction
    const spectra = predictSpectra3(grid, nL, 2.0, 1, cmy, N);
    return { cmy, spectra, primaries };
  }

  it('converges and returns valid result structure', () => {
    const { cmy, spectra, primaries } = makeDataset();
    const result = trainCYNSN3(cmy, spectra, N, primaries, wavelengths, { maxIter: 100 });
    expect(result.model).toBeDefined();
    expect(result.model.n_exponent).toBeGreaterThan(0);
    expect(result.model.n_exponent).toBeLessThan(15);
    expect(result.final_loss).toBeGreaterThanOrEqual(0);
    expect(result.n_iterations).toBeGreaterThan(0);
  });

  it('evaluateCYNSN3: median dE00 < 3 on self-consistent synthetic data', () => {
    const { cmy, spectra, primaries } = makeDataset();
    const result = trainCYNSN3(cmy, spectra, N, primaries, wavelengths, { maxIter: 200 });
    const ev = evaluateCYNSN3(result.model, cmy, spectra, N, 'test');
    // With exact primaries and n≈2, model should reproduce spectra accurately
    expect(ev.median_de00).toBeLessThan(3.0);
    expect(ev.rms_mean).toBeLessThan(0.05);
  });
});
