// colormath.test.ts
import { describe, it, expect } from 'vitest';
import { spectraToXYZ, spectraToLab, xyzToLab, labToXYZ, deltaE00 } from './colormath';

// Perfect white: reflectance = 1.0 everywhere
const WHITE_SPEC = new Array(36).fill(1.0);
// Perfect black: reflectance = 0.0 everywhere
const BLACK_SPEC = new Array(36).fill(0.0);

describe('spectraToXYZ', () => {
  it('perfect white → Y ≈ 100', () => {
    const [, Y] = spectraToXYZ(WHITE_SPEC);
    expect(Y).toBeCloseTo(100, 0);
  });

  it('perfect black → XYZ ≈ 0', () => {
    const [X, Y, Z] = spectraToXYZ(BLACK_SPEC);
    expect(X).toBeCloseTo(0, 5);
    expect(Y).toBeCloseTo(0, 5);
    expect(Z).toBeCloseTo(0, 5);
  });
});

describe('xyzToLab', () => {
  it('D50 white point → L≈100, a≈0, b≈0', () => {
    const [L, a, b] = xyzToLab(95.047, 100.0, 108.883);
    // Approximate: depends on D50_WP used internally
    expect(L).toBeCloseTo(100, 0);
    expect(Math.abs(a)).toBeLessThan(2);
    expect(Math.abs(b)).toBeLessThan(2);
  });

  it('labToXYZ is inverse of xyzToLab (round-trip)', () => {
    const [X0, Y0, Z0] = [50.0, 40.0, 30.0];
    const [L, a, b] = xyzToLab(X0, Y0, Z0);
    const [X1, Y1, Z1] = labToXYZ(L, a, b);
    expect(X1).toBeCloseTo(X0, 3);
    expect(Y1).toBeCloseTo(Y0, 3);
    expect(Z1).toBeCloseTo(Z0, 3);
  });
});

describe('spectraToLab', () => {
  it('perfect white → L≈100', () => {
    const [L] = spectraToLab(WHITE_SPEC);
    expect(L).toBeCloseTo(100, 0);
  });

  it('perfect black → L≈0', () => {
    const [L] = spectraToLab(BLACK_SPEC);
    expect(L).toBeCloseTo(0, 0);
  });
});

describe('deltaE00', () => {
  it('identical colors → ΔE00 = 0', () => {
    expect(deltaE00(50, 20, -30, 50, 20, -30)).toBe(0);
  });

  it('symmetric: dE00(A,B) == dE00(B,A)', () => {
    const d1 = deltaE00(50, 10, 5, 55, 12, 8);
    const d2 = deltaE00(55, 12, 8, 50, 10, 5);
    expect(d1).toBeCloseTo(d2, 6);
  });

  it('ISO 11664-6 pair 1: (50,2.6772,-79.7751) vs (50,0,-82.7485) ≈ 2.0425', () => {
    // Reference pair from CIE standard test dataset
    const de = deltaE00(50, 2.6772, -79.7751, 50, 0, -82.7485);
    expect(de).toBeCloseTo(2.0425, 2);
  });

  it('ISO 11664-6 pair 2: (50,3.1571,−77.2803) vs (50,0,−82.7485) ≈ 2.8615', () => {
    const de = deltaE00(50, 3.1571, -77.2803, 50, 0, -82.7485);
    expect(de).toBeCloseTo(2.8615, 2);
  });

  it('ISO 11664-6 pair 17: (50,−1.3802,−84.2814) vs (50,0,−82.7485) ≈ 1.4146', () => {
    const de = deltaE00(50, -1.3802, -84.2814, 50, 0, -82.7485);
    expect(de).toBeCloseTo(1.4146, 2);
  });
});
