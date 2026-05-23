import { describe, it, expect } from 'vitest';
import { D50_PERFECT_WHITE, spectraToLab, xyzToLab, spectraToXYZ, type WhitePointXYZ } from './colormath';

describe('xyzToLab — default vs custom white point', () => {
  it('default WP yields Lab≈(100,0,0) for a perfect diffuser', () => {
    const [L, a, b] = xyzToLab(D50_PERFECT_WHITE[0], D50_PERFECT_WHITE[1], D50_PERFECT_WHITE[2]);
    expect(L).toBeCloseTo(100, 8);
    expect(a).toBeCloseTo(0, 8);
    expect(b).toBeCloseTo(0, 8);
  });

  it('custom WP makes that XYZ map to (100, 0, 0)', () => {
    // Pick a paper-like white at Y=85 (representative of a real substrate under D50).
    const wp: WhitePointXYZ = [
      0.85 * D50_PERFECT_WHITE[0],
      85,
      0.85 * D50_PERFECT_WHITE[2],
    ];
    const [L, a, b] = xyzToLab(wp[0], wp[1], wp[2], wp);
    expect(L).toBeCloseTo(100, 6);
    expect(a).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
  });
});

describe('spectraToLab — paper-relative vs absolute', () => {
  it('a flat 0.85 reflector reads ~ (95, 0, 0) under absolute and (100, 0, 0) under paper-relative', () => {
    const spec = Array.from({ length: 36 }, () => 0.85);
    const labAbs = spectraToLab(spec);
    expect(labAbs[0]).toBeLessThan(100);
    expect(labAbs[0]).toBeGreaterThan(90);

    const paperXYZ = spectraToXYZ(spec);
    const labRel = spectraToLab(spec, 380, paperXYZ);
    expect(labRel[0]).toBeCloseTo(100, 6);
    expect(Math.abs(labRel[1])).toBeLessThan(1e-6);
    expect(Math.abs(labRel[2])).toBeLessThan(1e-6);
  });
});
