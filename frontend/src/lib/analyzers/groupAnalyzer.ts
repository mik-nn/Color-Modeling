// src/lib/analyzers/groupAnalyzer.ts
import { MatchedPatchPair, PatchGroupResult } from '../../types';

interface GroupDef {
  name: string;
  description: string;
  test: (r: number, g: number, b: number) => boolean;
}

const PATCH_GROUPS: GroupDef[] = [
  {
    name: 'Paper',
    description: 'Near-paper (≤15 all channels)',
    test: (r, g, b) => r <= 15 && g <= 15 && b <= 15,
  },
  {
    name: 'Neutral',
    description: 'Neutral axis |R−G|≤20, |G−B|≤20',
    test: (r, g, b) => Math.abs(r - g) <= 20 && Math.abs(g - b) <= 20,
  },
  {
    name: '100% R',
    description: 'R≥230, G≤25, B≤25',
    test: (r, g, b) => r >= 230 && g <= 25 && b <= 25,
  },
  {
    name: '100% G',
    description: 'R≤25, G≥230, B≤25',
    test: (r, g, b) => r <= 25 && g >= 230 && b <= 25,
  },
  {
    name: '100% B',
    description: 'R≤25, G≤25, B≥230',
    test: (r, g, b) => r <= 25 && g <= 25 && b >= 230,
  },
  {
    name: '100% RG',
    description: 'Yellow: R≥230, G≥230, B≤25',
    test: (r, g, b) => r >= 230 && g >= 230 && b <= 25,
  },
  {
    name: '100% RB',
    description: 'Magenta: R≥230, G≤25, B≥230',
    test: (r, g, b) => r >= 230 && g <= 25 && b >= 230,
  },
  {
    name: '100% GB',
    description: 'Cyan: R≤25, G≥230, B≥230',
    test: (r, g, b) => r <= 25 && g >= 230 && b >= 230,
  },
  {
    name: '50% R',
    description: 'R 100–160, G≤40, B≤40',
    test: (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b <= 40,
  },
  {
    name: '50% G',
    description: 'G 100–160, R≤40, B≤40',
    test: (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b <= 40,
  },
  {
    name: '50% B',
    description: 'B 100–160, R≤40, G≤40',
    test: (r, g, b) => r <= 40 && g <= 40 && b >= 100 && b <= 160,
  },
  {
    name: '50% RG',
    description: 'Mid-Yellow: R 100–160, G 100–160, B≤40',
    test: (r, g, b) => r >= 100 && r <= 160 && g >= 100 && g <= 160 && b <= 40,
  },
  {
    name: '50% RB',
    description: 'Mid-Magenta: R 100–160, G≤40, B 100–160',
    test: (r, g, b) => r >= 100 && r <= 160 && g <= 40 && b >= 100 && b <= 160,
  },
  {
    name: '50% GB',
    description: 'Mid-Cyan: R≤40, G 100–160, B 100–160',
    test: (r, g, b) => r <= 40 && g >= 100 && g <= 160 && b >= 100 && b <= 160,
  },
];

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 2) return 0;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sx2 = xs.reduce((s, x) => s + x * x, 0);
  const sy2 = ys.reduce((s, y) => s + y * y, 0);
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

function linReg(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  if (n < 2) return { slope: 1, intercept: 0 };
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const sx2 = xs.reduce((s, x) => s + x * x, 0);
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return { slope: 1, intercept: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  return { slope, intercept: (sy - slope * sx) / n };
}

function analyzeGroupPatches(patches: MatchedPatchPair[]): Omit<PatchGroupResult, 'name' | 'description'> {
  const n = patches.length;

  if (n < 2) {
    return {
      n_patches: n,
      pearson_r: 0,
      r_squared_L: 0,
      slope_L: 0,
      intercept_L: 0,
      mean_delta_L: n === 1 ? patches[0].target.LAB_L - patches[0].ref.LAB_L : 0,
      mean_delta_a: n === 1 ? patches[0].target.LAB_A - patches[0].ref.LAB_A : 0,
      mean_delta_b: n === 1 ? patches[0].target.LAB_B - patches[0].ref.LAB_B : 0,
    };
  }

  const refAll = patches.flatMap(p => [p.ref.LAB_L, p.ref.LAB_A, p.ref.LAB_B]);
  const tgtAll = patches.flatMap(p => [p.target.LAB_L, p.target.LAB_A, p.target.LAB_B]);

  const refL = patches.map(p => p.ref.LAB_L);
  const tgtL = patches.map(p => p.target.LAB_L);

  const pearson_r = pearsonR(refAll, tgtAll);
  const rL = pearsonR(refL, tgtL);
  const r_squared_L = rL * rL;
  const { slope, intercept } = linReg(refL, tgtL);

  const mean_delta_L = patches.reduce((s, p) => s + (p.target.LAB_L - p.ref.LAB_L), 0) / n;
  const mean_delta_a = patches.reduce((s, p) => s + (p.target.LAB_A - p.ref.LAB_A), 0) / n;
  const mean_delta_b = patches.reduce((s, p) => s + (p.target.LAB_B - p.ref.LAB_B), 0) / n;

  const refSpec: number[] = [];
  const tgtSpec: number[] = [];
  patches.forEach(p => {
    if (p.ref.spectra && p.target.spectra && p.ref.spectra.length === p.target.spectra.length) {
      refSpec.push(...p.ref.spectra);
      tgtSpec.push(...p.target.spectra);
    }
  });

  return {
    n_patches: n,
    pearson_r,
    r_squared_L,
    slope_L: slope,
    intercept_L: intercept,
    mean_delta_L,
    mean_delta_a,
    mean_delta_b,
    spectral_pearson: refSpec.length > 0 ? pearsonR(refSpec, tgtSpec) : undefined,
  };
}

export function analyzeByGroups(matchedPatches: MatchedPatchPair[]): PatchGroupResult[] {
  return PATCH_GROUPS.map(def => {
    const filtered = matchedPatches.filter(p => {
      const r = p.ref.RGB_R ?? 0;
      const g = p.ref.RGB_G ?? 0;
      const b = p.ref.RGB_B ?? 0;
      return def.test(r, g, b);
    });

    return {
      name: def.name,
      description: def.description,
      ...analyzeGroupPatches(filtered),
    };
  });
}
