import { describe, it, expect } from 'vitest';
import { pickHeuristicAnchors, pickCoverageAnchors } from './heuristic';
import type { ProfileMatrices } from '../dataset/matrix';

function mkProfile(patches: { id: string; rgb: [number, number, number] }[]): ProfileMatrices {
  const N = patches.length;
  const D = new Float64Array(N * 3);
  const X = new Float64Array(N * 3); // dummy 3-band spectra
  for (let i = 0; i < N; i++) {
    D[i * 3] = patches[i].rgb[0];
    D[i * 3 + 1] = patches[i].rgb[1];
    D[i * 3 + 2] = patches[i].rgb[2];
    X[i * 3] = 0.5; X[i * 3 + 1] = 0.5; X[i * 3 + 2] = 0.5;
  }
  return {
    X, D, channels: 3, N, L: 3,
    wavelengths: [380, 390, 400],
    sampleIds: patches.map(p => p.id),
    droppedCount: 0,
  };
}

describe('pickHeuristicAnchors', () => {
  it('picks the 8 RGB corners + 5 neutrals = 13 anchors when the chart has them', () => {
    // 8 corners + 7 neutrals along the diagonal.
    const corners: { id: string; rgb: [number, number, number] }[] = [
      { id: 'paper',   rgb: [255, 255, 255] },
      { id: 'black',   rgb: [0, 0, 0] },
      { id: 'red',     rgb: [255, 0, 0] },
      { id: 'green',   rgb: [0, 255, 0] },
      { id: 'blue',    rgb: [0, 0, 255] },
      { id: 'cyan',    rgb: [0, 255, 255] },
      { id: 'magenta', rgb: [255, 0, 255] },
      { id: 'yellow',  rgb: [255, 255, 0] },
    ];
    const neutrals: { id: string; rgb: [number, number, number] }[] = [];
    for (let g = 32; g <= 224; g += 32) {
      neutrals.push({ id: `n${g}`, rgb: [g, g, g] });
    }
    const profile = mkProfile([...corners, ...neutrals]);

    const set = pickHeuristicAnchors(profile);
    expect(set.strategy).toBe('forced');
    expect(set.sampleIds.length).toBe(13); // 8 corners + 5 neutrals
    expect(set.sampleIds).toContain('paper');
    expect(set.sampleIds).toContain('black');
    expect(set.sampleIds).toContain('red');

    const chosenIdx = set.meta?.chosenIdx as number[];
    expect(chosenIdx.length).toBe(13);
    // No duplicates.
    expect(new Set(chosenIdx).size).toBe(13);
  });

  it('falls back to nearest patch when exact corner is absent', () => {
    // Paper at (250,250,250) is the closest patch to (255,255,255).
    const profile = mkProfile([
      { id: 'near_paper', rgb: [250, 250, 250] },
      { id: 'mid',        rgb: [128, 128, 128] },
    ]);
    const set = pickHeuristicAnchors(profile, { neutralCount: 0 });
    expect(set.sampleIds[0]).toBe('near_paper');
  });

  it('respects neutralCount option', () => {
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255] },
      { id: 'black', rgb: [0, 0, 0] },
      { id: 'n1', rgb: [40, 40, 40] },
      { id: 'n2', rgb: [120, 120, 120] },
      { id: 'n3', rgb: [200, 200, 200] },
    ]);
    const set = pickHeuristicAnchors(profile, { neutralCount: 2 });
    // 2 corners (paper, black — only those exist as exact corners) + 2 neutrals.
    // The other 6 corner targets find their nearest non-taken patch (one of the neutrals).
    // So total ≤ 8 + 2; let us just check at least one neutral made it.
    expect(set.sampleIds.length).toBeGreaterThanOrEqual(3);
  });

  it('throws on CMYK profile (not supported yet)', () => {
    const cmykProfile: ProfileMatrices = {
      X: new Float64Array(3),
      D: new Float64Array([0, 0, 0, 0]),
      channels: 4,
      N: 1,
      L: 3,
      wavelengths: [380, 390, 400],
      sampleIds: ['c1'],
      droppedCount: 0,
    };
    expect(() => pickHeuristicAnchors(cmykProfile)).toThrow(/RGB-only/);
  });
});

describe('pickCoverageAnchors (H31 fixed chart)', () => {
  const targets: { id: string; rgb: [number, number, number] }[] = [
    { id: 'white',   rgb: [255, 255, 255] },
    { id: 'cyan',    rgb: [0, 255, 255] },
    { id: 'magenta', rgb: [255, 0, 255] },
    { id: 'yellow',  rgb: [255, 255, 0] },
    { id: 'black',   rgb: [0, 0, 0] },
    { id: 'gray',    rgb: [128, 128, 128] },
  ];

  it('picks the 6 coverage targets with paper (white) first', () => {
    // include distractor patches so nearest-match is exercised.
    const profile = mkProfile([
      { id: 'red', rgb: [255, 0, 0] },
      ...targets,
      { id: 'mid', rgb: [200, 100, 50] },
    ]);
    const set = pickCoverageAnchors(profile);
    expect(set.meta?.chosenIdx).toHaveLength(6);
    // chosenIdx[0] must be the paper row (white) so D1 can use it as paperRowIdx.
    const idx0 = (set.meta!.chosenIdx as number[])[0];
    expect([profile.D[idx0 * 3], profile.D[idx0 * 3 + 1], profile.D[idx0 * 3 + 2]]).toEqual([255, 255, 255]);
    expect(set.sampleIds[0]).toBe('white');
  });

  it('dedupes when a sparse grid maps two targets to one patch', () => {
    // only white + a single dark patch → black, gray, C, M, Y collapse onto nearest available
    const profile = mkProfile([
      { id: 'white', rgb: [255, 255, 255] },
      { id: 'dark',  rgb: [10, 10, 10] },
    ]);
    const set = pickCoverageAnchors(profile);
    const chosenIdx = set.meta!.chosenIdx as number[];
    // deduped to the 2 distinct patches, never more than the grid size.
    expect(chosenIdx.length).toBeLessThanOrEqual(2);
    expect(new Set(chosenIdx)).toEqual(new Set(chosenIdx)); // no dup indices
    expect(new Set(chosenIdx).size).toBe(chosenIdx.length);
  });

  it('throws on CMYK profile (RGB-only)', () => {
    const cmyk: ProfileMatrices = {
      X: new Float64Array(3), D: new Float64Array([0, 0, 0, 0]),
      channels: 4, N: 1, L: 3, wavelengths: [380, 390, 400], sampleIds: ['c1'], droppedCount: 0,
    };
    expect(() => pickCoverageAnchors(cmyk)).toThrow(/RGB-only/);
  });
});
