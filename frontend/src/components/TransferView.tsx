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
import { detectOBA, obaMismatch, obaMismatchSeverity, type OBAInfo } from '../lib/predict/oba';
import { fitPoolBasis, runPoolPCATransfer } from '../lib/predict/poolPCATransfer';

type PredictorKey = 'A3' | 'D1' | 'B3' | 'A3_vs_D1' | 'ALL';

interface Props {
  profiles: ProfileData[];
}

interface PredictorRun {
  variant: 'A3' | 'D1' | 'B3';
  report: PredictionReport;
  perLambdaR2?: Float64Array;        // A3 only
  residualRank?: number;             // D1 only
  clampedBandCount?: number;         // D1 only
  poolSize?: number;                 // B3 only
  basisRank?: number;                // B3 only
}

type RunResult =
  | { kind: 'error'; error: string }
  | {
      kind: 'ok';
      runs: PredictorRun[];
      anchors: ReturnType<typeof pickHeuristicAnchors>;
      alignedN: number;
      obaRef: OBAInfo;
      obaTarget: OBAInfo;
      obaMismatchScore: number;
    };

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
  const [poolBasisRank, setPoolBasisRank] = useState<number>(6);

  const refProfile = profiles.find(p => p.metadata.full_name === refName);
  const targetProfile = profiles.find(p => p.metadata.full_name === targetName);

  // Pool basis cache: rebuild when the set of loaded profiles changes
  // (excluding the target — pool must be independent of what we predict).
  const poolMatrices = useMemo(() => {
    if (profiles.length < 2) return null;
    return profiles
      .filter(p => p.metadata.full_name !== targetName)
      .map(p => {
        try {
          return loadProfileMatrix(p);
        } catch {
          return null;
        }
      })
      .filter((m): m is NonNullable<typeof m> => m !== null && m.channels === 3);
  }, [profiles, targetName]);

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
      const paperSpecB = new Array<number>(L);
      const paperSpecA = new Array<number>(L);
      for (let l = 0; l < L; l++) {
        paperSpecB[l] = X_B[paperRowIdx * L + l];
        paperSpecA[l] = X_A[paperRowIdx * L + l];
      }
      const startWL = Baligned.wavelengths[0];
      const paperWP = paperWPFromBrightestPatch(
        new Float64Array(paperSpecB), 1, L, startWL,
      );

      // OBA diagnostics for ref + target.
      const obaRef = detectOBA(paperSpecA, { startWL });
      const obaTarget = detectOBA(paperSpecB, { startWL });
      const obaMm = obaMismatch(obaRef, obaTarget);

      const runs: PredictorRun[] = [];

      if (predictor === 'A3' || predictor === 'A3_vs_D1' || predictor === 'ALL') {
        const a3 = runPerLambdaAffineTransfer({
          X_A, X_B, sampleIds: aligned.sampleIds, anchorIdx, L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        });
        runs.push({ variant: 'A3', report: a3.report, perLambdaR2: a3.fit.rSquaredPerLambda });
      }

      if (predictor === 'D1' || predictor === 'A3_vs_D1' || predictor === 'ALL') {
        const d1 = runPaperRatioResidualTransfer({
          X_A, X_B, D: D_B, sampleIds: aligned.sampleIds, anchorIdx, paperRowIdx, L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
          residualRank,
        });
        runs.push({
          variant: 'D1',
          report: d1.report,
          residualRank: d1.fit.residualRank,
          clampedBandCount: d1.fit.clampedBands.length,
        });
      }

      if ((predictor === 'B3' || predictor === 'ALL') && poolMatrices && poolMatrices.length >= 2) {
        // Build the pool basis from every other loaded profile (target excluded).
        // Each pool profile contributes its full N×L spectral matrix.
        const matrices = poolMatrices.map(m => m.X);
        const rowCounts = poolMatrices.map(m => m.N);
        const basis = fitPoolBasis({
          matrices, rowCounts, L,
          p: Math.min(poolBasisRank, L),
        });
        const b3 = runPoolPCATransfer({
          basis,
          X_ref: X_A,
          X_target: X_B,
          sampleIds: aligned.sampleIds,
          anchorIdx, L,
          paperWP,
          refProfile: refProfile.metadata.full_name,
          targetProfile: targetProfile.metadata.full_name,
        });
        runs.push({
          variant: 'B3',
          report: b3.report,
          basisRank: b3.p,
          poolSize: poolMatrices.length,
        });
      }

      return {
        kind: 'ok' as const,
        runs, anchors, alignedN: N,
        obaRef, obaTarget, obaMismatchScore: obaMm,
      };
    } catch (e) {
      return { kind: 'error' as const, error: e instanceof Error ? e.message : String(e) };
    }
  }, [refProfile, targetProfile, predictor, residualRank, poolMatrices, poolBasisRank]);

  if (profiles.length < 2) {
    return (
      <div className="p-6 text-gray-400">
        Load at least two profiles to run cross-substrate transfer.
      </div>
    );
  }

  // Per-profile OBA score for dropdown labels — paper patch detection.
  const profileObaLabel = (p: ProfileData): string => {
    const paper = p.raw.find(m =>
      m.RGB_R === 255 && m.RGB_G === 255 && m.RGB_B === 255 && m.spectra,
    );
    if (!paper || !paper.spectra) return p.metadata.full_name;
    try {
      const startWL = paper.wavelengths?.[0] ?? 380;
      const info = detectOBA(paper.spectra, { startWL });
      return `${p.metadata.full_name}  (OBA ${info.score.toFixed(2)})`;
    } catch {
      return p.metadata.full_name;
    }
  };

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
                {profileObaLabel(p)}
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
                {profileObaLabel(p)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Predictor</span>
          <select
            value={predictor}
            onChange={e => setPredictor(e.target.value as PredictorKey)}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm"
          >
            <option value="ALL">A3 vs D1 vs B3 (3-way)</option>
            <option value="A3_vs_D1">A3 vs D1 (head-to-head)</option>
            <option value="A3">A3 — per-λ affine (baseline)</option>
            <option value="D1">D1 — paper-ratio + PCA residual</option>
            <option value="B3">B3 — pool-PCA (basis from {poolMatrices?.length ?? 0} profiles)</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">D1 residual rank</span>
          <select
            value={residualRank}
            onChange={e => setResidualRank(Number(e.target.value))}
            disabled={!(predictor === 'D1' || predictor === 'A3_vs_D1' || predictor === 'ALL')}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-40"
          >
            <option value={1}>1</option>
            <option value={2}>2 (default)</option>
            <option value={3}>3</option>
            <option value={4}>4</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">B3 basis rank</span>
          <select
            value={poolBasisRank}
            onChange={e => setPoolBasisRank(Number(e.target.value))}
            disabled={!(predictor === 'B3' || predictor === 'ALL')}
            className="mt-1 w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm disabled:opacity-40"
          >
            <option value={3}>3</option>
            <option value={4}>4</option>
            <option value={6}>6 (default)</option>
            <option value={8}>8</option>
            <option value={12}>12</option>
          </select>
        </label>
        <label className="block">
          <span className="text-xs uppercase tracking-wider text-gray-500">Anchor strategy</span>
          <div className="mt-1 px-3 py-2 bg-gray-900 border border-gray-700 rounded text-sm text-gray-400">
            S1 — forced heuristic (13 anchors)
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
          <OBAMismatchTile
            obaRef={result.obaRef}
            obaTarget={result.obaTarget}
            mismatch={result.obaMismatchScore}
          />

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
                if (result.runs.length < 2) return null;
                const sorted = [...result.runs].sort(
                  (u, v) => u.report.medianDE00 - v.report.medianDE00,
                );
                const winner = sorted[0];
                const runnerUp = sorted[1];
                const delta = runnerUp.report.medianDE00 - winner.report.medianDE00;
                return (
                  <div className="mt-3 text-xs text-gray-400">
                    Winner on median ΔE00:{' '}
                    <span className="text-emerald-400 font-semibold">{winner.variant}</span>{' '}
                    by {delta.toFixed(2)} ΔE00 over {runnerUp.variant}.
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
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <div>
                    D1 used PCA residual rank <span className="text-gray-200 font-mono">{run.residualRank}</span>{' '}
                    fit on {run.report.k - 1} non-paper anchors. Lower-rank residual = stronger
                    smoothness assumption on the substrate transform.
                  </div>
                  {run.clampedBandCount !== undefined && run.clampedBandCount > 0 && (
                    <div>
                      Paper-ratio clamp activated on{' '}
                      <span className="text-yellow-300 font-mono">
                        {run.clampedBandCount} / 36
                      </span>{' '}
                      wavelengths (default bounds [0.3, 3.0]). Typically signals
                      OBA mismatch in 380–410 nm — distrust D1 at those bands.
                    </div>
                  )}
                </div>
              )}
              {run.poolSize !== undefined && (
                <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <div>
                    B3 basis built from{' '}
                    <span className="text-gray-200 font-mono">{run.poolSize}</span>{' '}
                    pool profiles (target excluded), truncated to rank{' '}
                    <span className="text-gray-200 font-mono">{run.basisRank ?? '—'}</span>.
                  </div>
                  <div>
                    B3 does NOT use the reference profile — it captures cross-substrate
                    structure shared across the pool. With fewer than 5 pool profiles,
                    or with substrates very unlike the target, B3 degrades to noise.
                  </div>
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

function OBAMismatchTile({
  obaRef, obaTarget, mismatch,
}: {
  obaRef: OBAInfo;
  obaTarget: OBAInfo;
  mismatch: number;
}) {
  const severity = obaMismatchSeverity(mismatch);
  const cls = severity === 'low'
    ? 'border-emerald-700 bg-emerald-950'
    : severity === 'moderate'
      ? 'border-yellow-700 bg-yellow-950'
      : 'border-red-700 bg-red-950';
  const valueCls = severity === 'low'
    ? 'text-emerald-300'
    : severity === 'moderate'
      ? 'text-yellow-300'
      : 'text-red-300';
  const advice = severity === 'low'
    ? 'Substrates have comparable OBA loading. D1 paper-ratio is reliable across all 36 bands.'
    : severity === 'moderate'
      ? 'Moderate OBA mismatch. Expect ratio clamp to activate at 1–3 short-wavelength bands.'
      : 'Strong OBA mismatch. D1 paper-ratio explodes at 380–410 nm without the clamp; with the clamp, expect a few clamped bands and biased prediction in the UV-blue region. A3 may also be unreliable since its per-λ slope cannot capture the non-linear OBA-vs-ink-coverage interaction.';

  return (
    <div className={`border rounded-lg p-4 ${cls}`}>
      <div className="grid grid-cols-3 gap-3 items-end">
        <div>
          <div className="text-xs uppercase tracking-wider text-gray-400">OBA mismatch</div>
          <div className={`text-3xl font-mono mt-1 ${valueCls}`}>
            {mismatch.toFixed(3)}
          </div>
          <div className="text-xs text-gray-400 mt-1">Severity: <span className={valueCls}>{severity}</span></div>
        </div>
        <div className="text-xs text-gray-300 space-y-0.5">
          <div className="text-gray-500 uppercase tracking-wider">Reference</div>
          <div>OBA score: <span className="text-gray-100 font-mono">{obaRef.score.toFixed(3)}</span></div>
          <div>R(380): <span className="text-gray-100 font-mono">{obaRef.r380.toFixed(3)}</span></div>
          <div>R(440): <span className="text-gray-100 font-mono">{obaRef.r440.toFixed(3)}</span></div>
          <div>R(550): <span className="text-gray-100 font-mono">{obaRef.r550.toFixed(3)}</span></div>
        </div>
        <div className="text-xs text-gray-300 space-y-0.5">
          <div className="text-gray-500 uppercase tracking-wider">Target</div>
          <div>OBA score: <span className="text-gray-100 font-mono">{obaTarget.score.toFixed(3)}</span></div>
          <div>R(380): <span className="text-gray-100 font-mono">{obaTarget.r380.toFixed(3)}</span></div>
          <div>R(440): <span className="text-gray-100 font-mono">{obaTarget.r440.toFixed(3)}</span></div>
          <div>R(550): <span className="text-gray-100 font-mono">{obaTarget.r550.toFixed(3)}</span></div>
        </div>
      </div>
      <p className="text-xs text-gray-300 mt-3">{advice}</p>
    </div>
  );
}
