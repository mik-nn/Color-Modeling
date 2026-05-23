// src/components/TransferView.tsx
//
// Phase 2 + Phase 3 deliverable: cross-substrate transfer with a chooser of
// predictor variants. The user picks a reference profile (full), a target
// profile (treated as if only a few anchors were measured), and a predictor:
//
//   - A3 (per-λ affine):    72 free params, closed-form OLS, baseline.
//   - D1 (paper-ratio + PCA residual): graceful at small k; lowest k for a
//     given ΔE00 target in practice.
//
// Both use the S1 forced anchor strategy (paper + 6 RGB primaries + black +
// 5 neutrals = 13 anchors). Metrics are evaluated on the 905 − 13 = 892
// held-out patches under paper-relative D50/2° Lab.
//
// Honest framing: empirical regression of B(λ, RGB) from A(λ, RGB). No
// physics claim, no "primaries" interpretation on RGB-addressed datasets.

import { useMemo, useState } from 'react';
import type { ProfileData, PredictionReport } from '../types';
import { loadProfileMatrix, alignByCommonSampleIds } from '../lib/dataset/matrix';
import { pickHeuristicAnchors } from '../lib/sampling/heuristic';
import {
  runPerLambdaAffineTransfer,
  paperWPFromBrightestPatch,
} from '../lib/predict/perLambdaAffine';
import { runPaperRatioResidualTransfer } from '../lib/predict/paperRatioResidual';

type PredictorKey = 'A3' | 'D1' | 'A3_vs_D1';

interface Props {
  profiles: ProfileData[];
}

interface PredictorRun {
  variant: 'A3' | 'D1';
  report: PredictionReport;
  perLambdaR2?: Float64Array;        // A3 only
  residualRank?: number;             // D1 only
}

type RunResult =
  | { kind: 'error'; error: string }
  | { kind: 'ok'; runs: PredictorRun[]; anchors: ReturnType<typeof pickHeuristicAnchors>; alignedN: number };

function deColor(de: number): string {
  if (de < 1.5) return 'text-emerald-400';
  if (de < 3.0) return 'text-yellow-400';
  return 'text-red-400';
}

function fmt(n: number, d = 2): string {
  return Number.isFinite(n) ? n.toFixed(d) : '—';
}

export default function TransferView({ profiles }: Props) {
  const [refName, setRefName] = useState<string>('');
  const [targetName, setTargetName] = useState<string>('');
  const [predictor, setPredictor] = useState<PredictorKey>('A3_vs_D1');
  const [residualRank, setResidualRank] = useState<number>(2);

  const refProfile = profiles.find(p => p.metadata.full_name === refName);
  const targetProfile = profiles.find(p => p.metadata.full_name === targetName);

  const result = useMemo<RunResult | null>(() => {
    if (!refProfile || !targetProfile || refProfile === targetProfile) return null;
    try {
      const A = loadProfileMatrix(refProfile);
      const B = loadProfileMatrix(targetProfile);
      const aligned = alignByCommonSampleIds(A, B);
      if (aligned.sampleIds.length < 50) {
        return { kind: 'error' as const, error: `Only ${aligned.sampleIds.length} shared SAMPLE_IDs — pick profiles from the same target chart.` };
      }

      const N = aligned.sampleIds.length;
      const L = A.L;
      const X_A = new Float64Array(N * L);
      const X_B = new Float64Array(N * L);
      const D_B = new Float64Array(N * B.channels);
      for (let i = 0; i < N; i++) {
        const ai = aligned.idxA[i];
        const bi = aligned.idxB[i];
        for (let l = 0; l < L; l++) {
          X_A[i * L + l] = A.X[ai * L + l];
          X_B[i * L + l] = B.X[bi * L + l];
        }
        for (let c = 0; c < B.channels; c++) {
          D_B[i * B.channels + c] = B.D[bi * B.channels + c];
        }
      }

      const Baligned = {
        X: X_B, D: D_B,
        channels: B.channels, N, L,
        wavelengths: B.wavelengths, sampleIds: aligned.sampleIds, droppedCount: 0,
      };

      const anchors = pickHeuristicAnchors(Baligned);
      const anchorIdx = anchors.meta?.chosenIdx as number[];
      const paperRowIdx = anchorIdx[0];

      // Paper-relative WP from the target's paper anchor spectrum.
      const paperSpec = new Array<number>(L);
      for (let l = 0; l < L; l++) paperSpec[l] = X_B[paperRowIdx * L + l];
      const startWL = Baligned.wavelengths[0];
      const paperWP = paperWPFromBrightestPatch(
        new Float64Array(paperSpec), 1, L, startWL,
      );

      const runs: PredictorRun[] = [];

      if (predictor === 'A3' || predictor === 'A3_vs_D1') {
        const a3 = runPerLambdaAffineTransfer({
          X_A, X_B, sampleIds: aligned.sampleIds, anchorIdx, L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        });
        runs.push({ variant: 'A3', report: a3.report, perLambdaR2: a3.fit.rSquaredPerLambda });
      }

      if (predictor === 'D1' || predictor === 'A3_vs_D1') {
        const d1 = runPaperRatioResidualTransfer({
          X_A, X_B, D: D_B, sampleIds: aligned.sampleIds, anchorIdx, paperRowIdx, L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
          residualRank,
        });
        runs.push({ variant: 'D1', report: d1.report, residualRank: d1.fit.residualRank });
      }

      return { kind: 'ok' as const, runs, anchors, alignedN: N };
    } catch (e) {
      return { kind: 'error' as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [refProfile, targetProfile, predictor, residualRank]);

  if (profiles.length < 2) {
    return (
      <div className="p-6 text-gray-400">
        Load at least two profiles to run cross-substrate transfer.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <h2 className="text-xl font-bold mb-1">Cross-substrate transfer (Phase 2 + 3)</h2>
        <p className="text-sm text-gray-400">
          Predicts the full target profile from the reference profile + 13 measured anchors
          on the target (paper, 6 RGB primaries, black, 5 neutrals). Metrics on the 905 − 13 =
          892 held-out patches under paper-relative D50/2°.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Reference (full)</span>
          <select
            value={refName}
            onChange={e => setRefName(e.target.value)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="">— pick reference —</option>
            {profiles.map(p => (
              <option key={p.metadata.full_name} value={p.metadata.full_name}>
                {p.metadata.full_name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Target (only anchors)</span>
          <select
            value={targetName}
            onChange={e => setTargetName(e.target.value)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="">— pick target —</option>
            {profiles.map(p => (
              <option key={p.metadata.full_name} value={p.metadata.full_name}>
                {p.metadata.full_name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Predictor</span>
          <select
            value={predictor}
            onChange={e => setPredictor(e.target.value as PredictorKey)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="A3_vs_D1">A3 vs D1 (head-to-head)</option>
            <option value="A3">A3 — per-λ affine (baseline)</option>
            <option value="D1">D1 — paper-ratio + PCA residual</option>
          </select>
        </label>
        {(predictor === 'D1' || predictor === 'A3_vs_D1') && (
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-gray-500">D1 residual rank</span>
            <select
              value={residualRank}
              onChange={e => setResidualRank(Number(e.target.value))}
              className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
            >
              <option value={1}>1</option>
              <option value={2}>2 (default)</option>
              <option value={3}>3</option>
              <option value={4}>4</option>
            </select>
          </label>
        )}
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Anchor strategy</span>
          <div className="mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-400">
            S1 — forced heuristic (paper + corners + 5 neutrals = 13)
          </div>
        </label>
      </div>

      {result && result.kind === 'error' && (
        <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          {result.error}
        </div>
      )}

      {result && result.kind === 'ok' && result.runs.length > 0 && (
        <div className="space-y-6">
          {result.runs.length > 1 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Head-to-head</h3>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-gray-500">
                  <tr>
                    <th className="text-left py-1">Predictor</th>
                    <th className="text-right py-1">median ΔE00</th>
                    <th className="text-right py-1">P95 ΔE00</th>
                    <th className="text-right py-1">mean R²</th>
                    <th className="text-right py-1">RMS</th>
                    <th className="text-right py-1">k</th>
                  </tr>
                </thead>
                <tbody>
                  {result.runs.map(run => (
                    <tr key={run.variant} className="border-t border-gray-800">
                      <td className="py-2 font-mono">{run.variant}</td>
                      <td className={`text-right py-2 font-mono ${deColor(run.report.medianDE00)}`}>
                        {fmt(run.report.medianDE00)}
                      </td>
                      <td className={`text-right py-2 font-mono ${deColor(run.report.p95DE00)}`}>
                        {fmt(run.report.p95DE00)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-200">
                        {fmt(run.report.meanSpectralR2, 3)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-200">
                        {fmt(run.report.meanRMS, 4)}
                      </td>
                      <td className="text-right py-2 font-mono text-gray-400">{run.report.k}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {(() => {
                if (result.runs.length !== 2) return null;
                const a = result.runs.find(r => r.variant === 'A3');
                const b = result.runs.find(r => r.variant === 'D1');
                if (!a || !b) return null;
                const winner = b.report.medianDE00 < a.report.medianDE00 ? 'D1' : 'A3';
                const delta = Math.abs(b.report.medianDE00 - a.report.medianDE00);
                return (
                  <div className="mt-3 text-xs text-gray-400">
                    Winner on median ΔE00: <span className="text-emerald-400 font-semibold">{winner}</span>{' '}
                    by {delta.toFixed(2)} ΔE00.
                    {winner === 'D1' && b.residualRank !== undefined && ` D1 residual rank used: ${b.residualRank}.`}
                  </div>
                );
              })()}
            </div>
          )}

          {result.runs.map(run => (
            <div key={run.variant} className="space-y-3">
              <h3 className="text-sm uppercase tracking-wider text-gray-500">{run.report.variant}</h3>
              <div className="grid grid-cols-4 gap-3">
                <Metric label="median ΔE00" value={fmt(run.report.medianDE00)} cls={deColor(run.report.medianDE00)} />
                <Metric label="P95 ΔE00" value={fmt(run.report.p95DE00)} cls={deColor(run.report.p95DE00)} />
                <Metric label="mean R²" value={fmt(run.report.meanSpectralR2, 3)} cls="text-gray-200" />
                <Metric label="mean RMS" value={fmt(run.report.meanRMS, 4)} cls="text-gray-200" />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <Metric label="anchors (k)" value={String(run.report.k)} cls="text-gray-200" />
                <Metric label="held-out" value={String(run.report.nTest)} cls="text-gray-200" />
                <Metric label="shared SAMPLE_IDs" value={String(result.alignedN)} cls="text-gray-200" />
              </div>
              <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">Worst 5 patches</div>
                <div className="text-xs font-mono text-gray-400">
                  {run.report.worstPatchSampleIds.join(', ')}
                </div>
              </div>
              {run.perLambdaR2 && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                  <div className="text-xs uppercase tracking-wider text-gray-500 mb-2">
                    Per-λ R² of the affine fit (anchors)
                  </div>
                  <div className="grid grid-cols-6 gap-2 text-xs font-mono">
                    {Array.from(run.perLambdaR2).map((r2, l) => (
                      <div key={l} className="text-gray-400">
                        λ{380 + l * 10}: <span className={r2 > 0.9 ? 'text-emerald-400' : r2 > 0.6 ? 'text-yellow-400' : 'text-red-400'}>
                          {r2.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {run.residualRank !== undefined && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400">
                  D1 used PCA residual rank <span className="text-gray-200 font-mono">{run.residualRank}</span>{' '}
                  fit on {run.report.k - 1} non-paper anchors. Lower-rank residual = stronger
                  smoothness assumption on the substrate transform.
                </div>
              )}
            </div>
          ))}

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <div className="text-xs uppercase tracking-wider text-gray-500 mb-1">
              Anchors used ({result.anchors.sampleIds.length})
            </div>
            <div className="text-xs font-mono text-gray-400 flex flex-wrap gap-2">
              {result.anchors.sampleIds.map((id, i) => {
                const label = (result.anchors.meta?.labels as string[])[i];
                return (
                  <span key={id} className="px-2 py-0.5 bg-gray-800 rounded">
                    {label}: <span className="text-gray-200">{id}</span>
                  </span>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, cls }: { label: string; value: string; cls: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <div className="text-xs uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-2xl font-mono mt-1 ${cls}`}>{value}</div>
    </div>
  );
}
