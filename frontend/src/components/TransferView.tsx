// src/components/TransferView.tsx
//
// Phase 2 deliverable: cross-substrate transfer using A3 per-λ affine predictor
// with S1 heuristic anchor set. The user picks a reference profile (full) and a
// target profile (treated as if only a few anchors were measured), then sees
// the prediction quality on the held-out patches of the target.
//
// Honest framing: we do NOT predict any "primaries" or claim physics; this is
// an empirical regression of B(λ, RGB) from A(λ, RGB) via per-wavelength OLS.

import { useMemo, useState } from 'react';
import type { ProfileData } from '../types';
import { loadProfileMatrix, alignByCommonSampleIds } from '../lib/dataset/matrix';
import { pickHeuristicAnchors } from '../lib/sampling/heuristic';
import {
  runPerLambdaAffineTransfer,
  paperWPFromBrightestPatch,
} from '../lib/predict/perLambdaAffine';

interface Props {
  profiles: ProfileData[];
}

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

  const refProfile = profiles.find(p => p.metadata.full_name === refName);
  const targetProfile = profiles.find(p => p.metadata.full_name === targetName);

  const result = useMemo(() => {
    if (!refProfile || !targetProfile || refProfile === targetProfile) return null;
    try {
      const A = loadProfileMatrix(refProfile);
      const B = loadProfileMatrix(targetProfile);
      const aligned = alignByCommonSampleIds(A, B);
      if (aligned.sampleIds.length < 50) {
        return { error: `Only ${aligned.sampleIds.length} shared SAMPLE_IDs — pick profiles from the same target chart.` };
      }

      // Subset both matrices to the common ordering.
      const N = aligned.sampleIds.length;
      const L = A.L;
      const X_A_aligned = new Float64Array(N * L);
      const X_B_aligned = new Float64Array(N * L);
      const D_B_aligned = new Float64Array(N * B.channels);
      for (let i = 0; i < N; i++) {
        const ai = aligned.idxA[i];
        const bi = aligned.idxB[i];
        for (let l = 0; l < L; l++) {
          X_A_aligned[i * L + l] = A.X[ai * L + l];
          X_B_aligned[i * L + l] = B.X[bi * L + l];
        }
        for (let c = 0; c < B.channels; c++) {
          D_B_aligned[i * B.channels + c] = B.D[bi * B.channels + c];
        }
      }

      const Baligned = {
        X: X_B_aligned, D: D_B_aligned,
        channels: B.channels, N, L,
        wavelengths: B.wavelengths, sampleIds: aligned.sampleIds, droppedCount: 0,
      };

      const anchors = pickHeuristicAnchors(Baligned);
      const anchorIdx = anchors.meta?.chosenIdx as number[];

      // Paper-relative white point for ΔE00 — use the brightest patch of the
      // target as a proxy when an exact RGB=(255,255,255) patch is absent.
      // pickHeuristicAnchors already finds the nearest-to-paper patch as
      // anchor 0, so use its spectrum.
      const paperRowIdx = anchorIdx[0];
      const paperSpec = new Array<number>(L);
      for (let l = 0; l < L; l++) paperSpec[l] = X_B_aligned[paperRowIdx * L + l];
      const startWL = Baligned.wavelengths[0];
      const paperWP = paperWPFromBrightestPatch(
        new Float64Array(paperSpec), 1, L, startWL,
      );

      const transfer = runPerLambdaAffineTransfer({
        X_A: X_A_aligned,
        X_B: X_B_aligned,
        sampleIds: aligned.sampleIds,
        anchorIdx,
        L,
        paperWP,
        refProfile: refProfile.metadata.full_name,
        targetProfile: targetProfile.metadata.full_name,
      });

      return { transfer, anchors, alignedN: N };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }, [refProfile, targetProfile]);

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
        <h2 className="text-xl font-bold mb-1">Cross-substrate transfer (Phase 2)</h2>
        <p className="text-sm text-gray-400">
          Predicts the full target profile from the reference profile + 13 measured anchors
          on the target (paper, 6 RGB primaries, black, 5 neutrals). Predictor: per-λ affine
          (A3); anchor strategy: forced heuristic (S1). Metrics on the 905 − 13 = 892
          held-out patches.
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

      {result && 'error' in result && (
        <div className="p-3 rounded-lg bg-red-950 border border-red-800 text-red-300 text-sm">
          {result.error}
        </div>
      )}

      {result && 'transfer' in result && result.transfer && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-3">
            <Metric label="median ΔE00" value={fmt(result.transfer.report.medianDE00)} cls={deColor(result.transfer.report.medianDE00)} />
            <Metric label="P95 ΔE00" value={fmt(result.transfer.report.p95DE00)} cls={deColor(result.transfer.report.p95DE00)} />
            <Metric label="mean R²" value={fmt(result.transfer.report.meanSpectralR2, 3)} cls="text-gray-200" />
            <Metric label="mean RMS" value={fmt(result.transfer.report.meanRMS, 4)} cls="text-gray-200" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Metric label="anchors (k)" value={String(result.transfer.report.k)} cls="text-gray-200" />
            <Metric label="held-out patches" value={String(result.transfer.report.nTest)} cls="text-gray-200" />
            <Metric label="shared SAMPLE_IDs" value={String(result.alignedN)} cls="text-gray-200" />
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Worst 5 patches by ΔE00</h3>
            <div className="text-xs font-mono text-gray-400">
              {result.transfer.report.worstPatchSampleIds.join(', ')}
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">
              Anchors used ({result.anchors.sampleIds.length})
            </h3>
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

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Per-λ affine fit diagnostics</h3>
            <div className="grid grid-cols-6 gap-2 text-xs font-mono">
              {Array.from(result.transfer.fit.rSquaredPerLambda).map((r2, l) => (
                <div key={l} className="text-gray-400">
                  λ{380 + l * 10}: <span className={r2 > 0.9 ? 'text-emerald-400' : r2 > 0.6 ? 'text-yellow-400' : 'text-red-400'}>
                    {r2.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Per-wavelength R² of the affine fit on the {result.transfer.report.k} anchors. High
              everywhere = the substrate transform is well-approximated by a single (slope,
              intercept) per λ. Drops at the long-wavelength end usually mean low variance
              between anchors at those bands.
            </p>
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
