// src/lib/sampling/greedy.ts
//
// S2 — Greedy adaptive anchor selection.
//
// Starts from a seed anchor set (typically S1 forced heuristic) and grows it
// one patch at a time. Each iteration:
//   1. Run a user-supplied predictor with the current anchor set.
//   2. Inspect the held-out evaluation report.
//   3. If `medianDE00 ≤ targetMedianDE` or `currentK ≥ maxK` — stop.
//   4. Otherwise add the worst-ΔE00 patch (from `report.worstPatchSampleIds[0]`)
//      to the anchor set and loop.
//
// The predictor is treated as a pure function `(anchorIdx) -> PredictionReport`.
// This lets the same greedy machinery wrap A3, D1, or B3 without coupling
// to any specific math module.
//
// Pros: ends with the smallest anchor set that meets the user's ΔE budget for
// the chosen predictor + substrate pair. The trajectory exposes "how hard"
// the substrate transform is — flat curve = saturating, steep = high-info.
// Cons: greedy ≠ optimal; one bad anchor early on may take several iterations
// to recover from. Re-fitting cost ≈ k iterations × per-fit cost.

import type { PredictionReport } from '../../types';

/**
 * Predictor callback: given a list of row indices to use as anchors, run the
 * fit, evaluate on the non-anchor subset, and return the standard report.
 *
 * `sampleIds` is supplied so the greedy loop can translate
 * `report.worstPatchSampleIds[0]` back into a row index.
 */
export type GreedyPredictor = (anchorIdx: number[]) => PredictionReport;

export interface GreedyOptions {
  /** Predictor function — see above. */
  predict: GreedyPredictor;
  /** Initial anchor row indices (e.g. from S1 forced set). */
  seedAnchors: number[];
  /** All sample IDs in row-index order — for sampleId → rowIdx lookup. */
  sampleIds: string[];
  /** Target median ΔE00 — stop as soon as the report meets or beats this. */
  targetMedianDE: number;
  /**
   * Hard cap on anchor count to keep wall-clock bounded. Default 60 to keep
   * the UI responsive (each iteration is a full predictor re-fit + eval).
   */
  maxK?: number;
  /**
   * Optional progress callback invoked after each iteration (after the
   * report is computed and before the next anchor is added).
   */
  onIteration?: (step: GreedyStep) => void;
}

export interface GreedyStep {
  /** Iteration index, 0-based. Iteration 0 = predict-with-seed-only. */
  iteration: number;
  /** Anchor count used in this iteration. */
  k: number;
  /** Predictor report at this k. */
  report: PredictionReport;
  /** Row index of the patch picked to add for the NEXT iteration. -1 if stopping. */
  addedRowIdx: number;
}

export interface GreedyResult {
  /** Final anchor list (seed + every patch added during the loop). */
  finalAnchors: number[];
  /** Row indices added by the greedy loop, in order. */
  addedOrder: number[];
  /** Per-iteration history (one entry per predictor call). */
  trajectory: GreedyStep[];
  /** True if `targetMedianDE` was met before `maxK` was hit. */
  converged: boolean;
  /** Final report (== last trajectory entry's report). */
  finalReport: PredictionReport;
}

export function runGreedyActiveAnchors(opts: GreedyOptions): GreedyResult {
  const {
    predict, seedAnchors, sampleIds, targetMedianDE,
    maxK = 60, onIteration,
  } = opts;

  if (seedAnchors.length < 1) {
    throw new Error('runGreedyActiveAnchors: seedAnchors must be non-empty');
  }
  if (maxK < seedAnchors.length) {
    throw new Error(
      `runGreedyActiveAnchors: maxK=${maxK} < seedAnchors.length=${seedAnchors.length}`,
    );
  }

  // Build SAMPLE_ID -> row index map once.
  const idToRow = new Map<string, number>();
  for (let i = 0; i < sampleIds.length; i++) idToRow.set(sampleIds[i], i);

  const anchors = [...seedAnchors];
  const inAnchors = new Set<number>(anchors);
  const trajectory: GreedyStep[] = [];
  const addedOrder: number[] = [];

  let iteration = 0;
  let converged = false;
  let lastReport: PredictionReport | null = null;

  while (true) {
    const report = predict(anchors);
    lastReport = report;

    // Find first worst-patch SAMPLE_ID that maps to a row not already in anchors.
    let nextRow = -1;
    for (const sid of report.worstPatchSampleIds) {
      const r = idToRow.get(sid);
      if (r !== undefined && !inAnchors.has(r)) {
        nextRow = r;
        break;
      }
    }

    const step: GreedyStep = {
      iteration,
      k: anchors.length,
      report,
      addedRowIdx: nextRow,
    };
    trajectory.push(step);
    onIteration?.(step);

    // Stop conditions, in priority order:
    //   1. Met target — converged.
    //   2. Cap reached — give up.
    //   3. No candidate patch found — give up (held-out empty or all in anchors).
    if (report.medianDE00 <= targetMedianDE) {
      converged = true;
      break;
    }
    if (anchors.length >= maxK) break;
    if (nextRow < 0) break;

    anchors.push(nextRow);
    inAnchors.add(nextRow);
    addedOrder.push(nextRow);
    iteration++;
  }

  return {
    finalAnchors: anchors,
    addedOrder,
    trajectory,
    converged,
    finalReport: lastReport!,
  };
}
