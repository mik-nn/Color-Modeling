import { describe, it, expect } from 'vitest';
import { pickChannelRampAnchors } from './channelRamp';
import type { ProfileMatrices } from '../dataset/matrix';

function mkProfile(patches: { id: string; rgb: [number, number, number] }[]): ProfileMatrices {
  const N = patches.length;
  const D = new Float64Array(N * 3);
  for (let i = 0; i < N; i++) {
    D[i * 3]     = patches[i].rgb[0];
    D[i * 3 + 1] = patches[i].rgb[1];
    D[i * 3 + 2] = patches[i].rgb[2];
  }
  return {
    X: new Float64Array(N * 2),
    D, channels: 3, N, L: 2,
    wavelengths: [380, 390],
    sampleIds: patches.map(p => p.id),
    droppedCount: 0,
  };
}

describe('pickChannelRampAnchors', () => {
  it('picks paper + cyan ramp levels in order', () => {
    const profile = mkProfile([
      { id: 'paper',    rgb: [255, 255, 255] },
      { id: 'c25',      rgb: [192, 255, 255] },
      { id: 'c50',      rgb: [128, 255, 255] },
      { id: 'c75',      rgb: [ 64, 255, 255] },
      { id: 'c100',     rgb: [  0, 255, 255] },
      { id: 'distract', rgb: [128,   0,   0] },
    ]);
    const a = pickChannelRampAnchors(profile, { channel: 'C' });
    expect(a.sampleIds).toEqual(['paper', 'c25', 'c50', 'c75', 'c100']);
    expect((a.meta?.labels as string[])).toEqual(
      ['paper', 'C_192', 'C_128', 'C_64', 'C_0'],
    );
  });

  it('honours custom levels', () => {
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255] },
      { id: 'y50',   rgb: [255, 255, 128] },
      { id: 'y100',  rgb: [255, 255,   0] },
    ]);
    const a = pickChannelRampAnchors(profile, { channel: 'Y', levels: [128, 0] });
    expect(a.sampleIds).toEqual(['paper', 'y50', 'y100']);
  });

  it('picks nearest patch when exact ramp level absent', () => {
    const profile = mkProfile([
      { id: 'paper',  rgb: [255, 255, 255] },
      { id: 'm_near', rgb: [255, 130, 255] }, // near M=128 target
    ]);
    const a = pickChannelRampAnchors(profile, { channel: 'M', levels: [128] });
    expect(a.sampleIds).toEqual(['paper', 'm_near']);
  });

  it('does not pick the same patch twice', () => {
    // Only paper exists — the ramp pick still must avoid double-counting it.
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255] },
      { id: 'far',   rgb: [128, 128, 128] },
    ]);
    const a = pickChannelRampAnchors(profile, { channel: 'C', levels: [255] });
    expect(new Set(a.sampleIds).size).toBe(a.sampleIds.length);
  });

  it('throws on CMYK profile', () => {
    const p: ProfileMatrices = {
      X: new Float64Array(2), D: new Float64Array(4), channels: 4, N: 1, L: 2,
      wavelengths: [380, 390], sampleIds: ['x'], droppedCount: 0,
    };
    expect(() => pickChannelRampAnchors(p, { channel: 'C' })).toThrow(/RGB-only/);
  });

  it('neutral ramp picks gray patches', () => {
    const profile = mkProfile([
      { id: 'paper', rgb: [255, 255, 255] },
      { id: 'g192',  rgb: [192, 192, 192] },
      { id: 'g128',  rgb: [128, 128, 128] },
      { id: 'g64',   rgb: [ 64,  64,  64] },
      { id: 'g0',    rgb: [  0,   0,   0] },
    ]);
    const a = pickChannelRampAnchors(profile, { channel: 'neutral' });
    expect(a.sampleIds).toEqual(['paper', 'g192', 'g128', 'g64', 'g0']);
  });
});
