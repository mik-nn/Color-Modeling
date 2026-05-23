// src/lib/dataset/split.ts
//
// Calibration / test splits over an integer index range [0, N). Deterministic
// under a seed so experiment runs are reproducible across sessions.

export type SplitMode =
  | { kind: 'kfold'; k: number; fold: number; seed?: number }
  | { kind: 'random'; testFraction: number; seed?: number }
  | { kind: 'fixed'; calIdx: number[] };

export interface Split {
  /** Indices that go into the calibration / training set. */
  calIdx: Int32Array;
  /** Indices that go into the held-out / test set. */
  testIdx: Int32Array;
}

// Mulberry32 PRNG — small, deterministic, fast. Good enough for shuffles.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffledRange(N: number, seed: number): number[] {
  const arr = Array.from({ length: N }, (_, i) => i);
  const rng = mulberry32(seed);
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Build a calibration / test split over the index range [0, N).
 *
 * - `kfold`: deterministic k-fold partition; `fold` ∈ [0, k) selects which fold
 *   serves as the held-out set.
 * - `random`: shuffle and take `testFraction · N` as test set.
 * - `fixed`: the caller specifies the calibration indices explicitly; the rest
 *   become the test set.
 */
export function splitCalTest(N: number, mode: SplitMode): Split {
  if (N <= 0) throw new Error(`splitCalTest: N must be > 0, got ${N}`);

  if (mode.kind === 'fixed') {
    const calSet = new Set(mode.calIdx);
    for (const i of mode.calIdx) {
      if (!Number.isInteger(i) || i < 0 || i >= N) {
        throw new Error(`splitCalTest(fixed): index ${i} out of range [0, ${N})`);
      }
    }
    const cal = Int32Array.from(mode.calIdx);
    const testArr: number[] = [];
    for (let i = 0; i < N; i++) if (!calSet.has(i)) testArr.push(i);
    return { calIdx: cal, testIdx: Int32Array.from(testArr) };
  }

  if (mode.kind === 'random') {
    if (mode.testFraction <= 0 || mode.testFraction >= 1) {
      throw new Error(`splitCalTest(random): testFraction must be in (0, 1), got ${mode.testFraction}`);
    }
    const shuffled = shuffledRange(N, mode.seed ?? 1);
    const nTest = Math.max(1, Math.round(N * mode.testFraction));
    const testArr = shuffled.slice(0, nTest);
    const calArr = shuffled.slice(nTest);
    return { calIdx: Int32Array.from(calArr), testIdx: Int32Array.from(testArr) };
  }

  // kfold
  const k = mode.k;
  if (k < 2) throw new Error(`splitCalTest(kfold): k must be ≥ 2, got ${k}`);
  if (mode.fold < 0 || mode.fold >= k) {
    throw new Error(`splitCalTest(kfold): fold ${mode.fold} out of range [0, ${k})`);
  }
  const shuffled = shuffledRange(N, mode.seed ?? 1);
  const calArr: number[] = [];
  const testArr: number[] = [];
  // Round-robin: index i goes to fold (i mod k) of the shuffled order.
  for (let pos = 0; pos < N; pos++) {
    const idx = shuffled[pos];
    if (pos % k === mode.fold) testArr.push(idx);
    else calArr.push(idx);
  }
  return { calIdx: Int32Array.from(calArr), testIdx: Int32Array.from(testArr) };
}
