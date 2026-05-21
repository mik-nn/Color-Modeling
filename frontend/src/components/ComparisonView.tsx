// src/components/ComparisonView.tsx
import { useEffect, useMemo, useState } from 'react';
import { ProfileData, LinearityResult } from '../types';
import LabScatterPlot from './LabScatterPlot';
import SpectralCurves from './SpectralCurves';
import PatchCorrelationScatter from './PatchCorrelationScatter';
import GroupBreakdownTable from './GroupBreakdownTable';
import InkRatioTable from './InkRatioTable';
import PredictionAccuracyView from './PredictionAccuracyView';
import InkLimitSection, { InkLimits, NO_LIMIT, isOutOfDomain } from './InkLimitSection';
import { analyzeLinearity, analyzeLinearityFromPatches } from '../lib/analyzers/linearityAnalyzer';
import { analyzeByGroups } from '../lib/analyzers/groupAnalyzer';
import { analyzeInkRatios } from '../lib/analyzers/inkRatioAnalyzer';
import { runModelComparison, runXYZModelComparison } from '../lib/analyzers/spectralPredictor';
import { runCYNSNComparison, CYNSNComparisonResult } from '../lib/analyzers/cynsn';
import { useProfileStore } from '../store/useProfileStore';

interface ComparisonViewProps {
  profiles: ProfileData[];
  onRemove: (fullName: string) => void;
}

function MetricCard({
  label,
  value,
  sub,
  good,
}: {
  label: string;
  value: string;
  sub: string;
  good?: boolean | null;
}) {
  const color =
    good === true ? 'text-emerald-400' : good === false ? 'text-red-400' : 'text-white';
  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl p-5">
      <p className="text-gray-400 text-sm">{label}</p>
      <p className={`text-4xl font-semibold mt-2 ${color}`}>{value}</p>
      <p className="text-xs text-gray-500 mt-1">{sub}</p>
    </div>
  );
}

export default function ComparisonView({ profiles, onRemove }: ComparisonViewProps) {
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const setLinearityResult = useProfileStore(state => state.setLinearityResult);

  // ── Ink limit state (lifted from InkLimitSection) ──────────────────────────
  const [limitsRef,    setLimitsRef]    = useState<InkLimits>(NO_LIMIT);
  const [limitsTarget, setLimitsTarget] = useState<InkLimits>(NO_LIMIT);
  const [deThreshold,  setDeThreshold]  = useState(2.0);

  // Reset limits when profiles change to avoid stale limits on a new pair
  useEffect(() => {
    setLimitsRef(NO_LIMIT);
    setLimitsTarget(NO_LIMIT);
  }, [profiles[0]?.metadata.full_name, profiles[1]?.metadata.full_name]);

  // ── Full match (used by InkLimitSection a*b* plot + CGATS export) ──────────
  const analysis = useMemo((): LinearityResult | null => {
    if (profiles.length !== 2) return null;
    setAnalysisError(null);
    try {
      return analyzeLinearity(profiles[0], profiles[1]);
    } catch (e) {
      setAnalysisError(e instanceof Error ? e.message : String(e));
      return null;
    }
  }, [profiles]);

  // ── Filter matched patches by current ink limits ───────────────────────────
  const filteredMatchedPatches = useMemo(() => {
    const all = analysis?.matched_patches ?? [];
    if (all.length === 0) return all;
    return all.filter(p => {
      const rC = 255 - (p.ref.RGB_R ?? 255);
      const rM = 255 - (p.ref.RGB_G ?? 255);
      const rY = 255 - (p.ref.RGB_B ?? 255);
      const tC = 255 - (p.target.RGB_R ?? 255);
      const tM = 255 - (p.target.RGB_G ?? 255);
      const tY = 255 - (p.target.RGB_B ?? 255);
      return !isOutOfDomain(rC, rM, rY, limitsRef) && !isOutOfDomain(tC, tM, tY, limitsTarget);
    });
  }, [analysis, limitsRef, limitsTarget]);

  // ── All downstream metrics computed on filtered patches ────────────────────
  const filteredAnalysis = useMemo((): LinearityResult | null => {
    if (profiles.length !== 2 || filteredMatchedPatches.length < 10) return null;
    try {
      return analyzeLinearityFromPatches(
        filteredMatchedPatches,
        profiles[0].metadata.substrate,
        profiles[1].metadata.substrate
      );
    } catch {
      return null;
    }
  }, [filteredMatchedPatches, profiles]);

  useEffect(() => {
    setLinearityResult(filteredAnalysis);
  }, [filteredAnalysis, setLinearityResult]);

  const groupBreakdown = useMemo(() => {
    if (filteredMatchedPatches.length === 0) return null;
    return analyzeByGroups(filteredMatchedPatches);
  }, [filteredMatchedPatches]);

  const inkRatios = useMemo(() => {
    if (filteredMatchedPatches.length === 0) return null;
    return analyzeInkRatios(filteredMatchedPatches);
  }, [filteredMatchedPatches]);

  const modelComparison = useMemo(() => {
    if (filteredMatchedPatches.length === 0) return null;
    return runModelComparison(filteredMatchedPatches);
  }, [filteredMatchedPatches]);

  const xyzComparison = useMemo(() => {
    if (filteredMatchedPatches.length === 0) return null;
    return runXYZModelComparison(filteredMatchedPatches);
  }, [filteredMatchedPatches]);

  // CYNSN: within-profile model — fit ref, then fit target
  const cysnRef = useMemo((): CYNSNComparisonResult | null => {
    if (profiles.length < 2 || filteredMatchedPatches.length < 16) return null;
    return runCYNSNComparison(filteredMatchedPatches, false);
  }, [filteredMatchedPatches, profiles.length]);

  const cysnTarget = useMemo((): CYNSNComparisonResult | null => {
    if (profiles.length < 2 || filteredMatchedPatches.length < 16) return null;
    return runCYNSNComparison(filteredMatchedPatches, true);
  }, [filteredMatchedPatches, profiles.length]);

  const isFiltered =
    limitsRef.C < 255 || limitsRef.M < 255 || limitsRef.Y < 255 ||
    limitsRef.CM < 255 || limitsRef.CY < 255 || limitsRef.MY < 255 ||
    (profiles.length >= 2 && (
      limitsTarget.C < 255 || limitsTarget.M < 255 || limitsTarget.Y < 255 ||
      limitsTarget.CM < 255 || limitsTarget.CY < 255 || limitsTarget.MY < 255
    ));

  // Alias: filtered analysis for display (falls back to full analysis if not enough filtered patches)
  const displayAnalysis = filteredAnalysis ?? (isFiltered ? null : analysis);

  if (profiles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center">
        <div>
          <div className="text-6xl mb-6 opacity-20">📊</div>
          <h3 className="text-2xl font-medium text-gray-400 mb-3">
            Select profiles to compare
          </h3>
          <p className="text-gray-500 max-w-md">
            Load .icm profiles and select 1–2 to run linearity analysis,
            color distribution, and spectral inspection.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-10 pb-12">
      <div>
        <h2 className="text-3xl font-semibold mb-2">Profile Comparison</h2>
        <p className="text-gray-400">
          {profiles.length} profile{profiles.length > 1 ? 's' : ''} selected for analysis
        </p>
      </div>

      {/* Profile cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {profiles.map((profile, index) => (
          <div
            key={profile.metadata.full_name}
            className="bg-gray-900 border border-gray-700 rounded-2xl p-6 hover:border-gray-600 transition-colors"
          >
            <div className="flex justify-between items-start mb-6">
              <div>
                <span className="inline-block px-3 py-1 text-xs font-medium rounded-full mb-3 bg-gradient-to-r from-blue-500/20 to-purple-500/20 text-blue-400">
                  {index === 0 ? 'REFERENCE' : 'TARGET'}
                </span>
                <h3 className="text-xl font-semibold text-white">{profile.metadata.substrate}</h3>
                <p className="text-sm text-gray-400 mt-1 font-mono break-all">
                  {profile.metadata.full_name}
                </p>
              </div>
              <button
                onClick={() => onRemove(profile.metadata.full_name)}
                className="text-gray-400 hover:text-red-500 text-3xl leading-none transition-colors"
              >
                ×
              </button>
            </div>

            <div className="grid grid-cols-2 gap-y-4 text-sm">
              <div>
                <span className="text-gray-500 block">Patches</span>
                <p className="text-lg font-semibold text-white">{profile.patch_count}</p>
              </div>
              <div>
                <span className="text-gray-500 block">Spectral data</span>
                <p className={`text-lg font-semibold ${profile.has_spectral ? 'text-emerald-400' : 'text-gray-500'}`}>
                  {profile.has_spectral ? 'Present' : 'Absent'}
                </p>
              </div>
              <div>
                <span className="text-gray-500 block">Series</span>
                <p className="text-white">{profile.metadata.series}</p>
              </div>
              <div>
                <span className="text-gray-500 block">Printer / Mode</span>
                <p className="text-white">
                  {profile.metadata.printer} · {profile.metadata.ink}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* ── Ink limit section — TOP: set domain before all analysis ─────────── */}
      {profiles.length >= 1 && (
        <InkLimitSection
          profiles={profiles}
          matchedPatches={analysis?.matched_patches ?? []}
          limitsRef={limitsRef}
          setLimitsRef={setLimitsRef}
          limitsTarget={limitsTarget}
          setLimitsTarget={setLimitsTarget}
          deThreshold={deThreshold}
          setDeThreshold={setDeThreshold}
        />
      )}

      {/* ── Patch count within limits ─────────────────────────────────────── */}
      {isFiltered && analysis?.matched_patches && (
        <div className="px-1 text-xs text-gray-500">
          Analysis scope:{' '}
          <span className="text-gray-300 font-medium">{filteredMatchedPatches.length}</span>
          {' '}/ {analysis.matched_patches.length} matched patches within ink limits
          {filteredMatchedPatches.length < 10 && (
            <span className="ml-2 text-red-400">— too few for analysis, loosen limits</span>
          )}
        </div>
      )}

      {/* ── Linearity analysis — all metrics on filtered patches ─────────── */}
      {profiles.length === 2 && (
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8">
          <h3 className="text-lg font-semibold mb-2">Transfer linearity analysis</h3>
          {displayAnalysis ? (
            <>
              <p className="text-xs text-gray-500 mb-6">
                {displayAnalysis.n_patches_used} patches
                {isFiltered && (
                  <span className="ml-1 text-blue-400">· within ink limits</span>
                )}
                {' '}•{' '}
                <span
                  className={
                    displayAnalysis.linearity_confidence === 'high'
                      ? 'text-emerald-400'
                      : displayAnalysis.linearity_confidence === 'medium'
                      ? 'text-yellow-400'
                      : 'text-red-400'
                  }
                >
                  {displayAnalysis.linearity_confidence.toUpperCase()} confidence
                </span>
              </p>

              {/* Primary: linear spaces */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {displayAnalysis.spectral_pearson_corr !== undefined && (
                  <MetricCard
                    label="Spectral r"
                    value={displayAnalysis.spectral_pearson_corr.toFixed(4)}
                    sub="Pearson r — all patches × all λ (linear)"
                    good={displayAnalysis.spectral_pearson_corr > 0.97}
                  />
                )}
                {displayAnalysis.xyz_pearson_corr !== undefined && (
                  <MetricCard
                    label="XYZ r"
                    value={displayAnalysis.xyz_pearson_corr.toFixed(4)}
                    sub="Pearson r in XYZ tristimulus (linear)"
                    good={displayAnalysis.xyz_pearson_corr > 0.97}
                  />
                )}
                {displayAnalysis.mean_spectral_r2 !== undefined && (
                  <MetricCard
                    label="Per-patch spec R²"
                    value={displayAnalysis.mean_spectral_r2.toFixed(4)}
                    sub="Mean R² of R_target = f(R_ref) per patch"
                    good={displayAnalysis.mean_spectral_r2 > 0.98}
                  />
                )}
                {displayAnalysis.spectral_slope_cv !== undefined && (
                  <MetricCard
                    label="Slope CV λ"
                    value={(displayAnalysis.spectral_slope_cv * 100).toFixed(1) + '%'}
                    sub="CV of a(λ) across wavelengths — low = flat substrate effect"
                    good={displayAnalysis.spectral_slope_cv < 0.05}
                  />
                )}
              </div>

              {/* Secondary: perceptual (informational) */}
              <details className="mt-4">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400 select-none">
                  Perceptual metrics (Lab — non-linear, informational only)
                </summary>
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mt-3">
                  <MetricCard
                    label="Lab Pearson r"
                    value={displayAnalysis.pearson_corr_lab.toFixed(4)}
                    sub="Non-linear space — for reference only"
                    good={null}
                  />
                  {displayAnalysis.mean_deltaE_after_correction !== undefined && isFinite(displayAnalysis.mean_deltaE_after_correction) && (
                    <MetricCard
                      label="ΔE after offset"
                      value={displayAnalysis.mean_deltaE_after_correction.toFixed(2)}
                      sub="Mean ΔE after global Lab offset correction"
                      good={displayAnalysis.mean_deltaE_after_correction < 3}
                    />
                  )}
                </div>
              </details>

              <div className="mt-4 p-4 rounded-xl bg-gray-950 border border-gray-800 text-sm">
                <p className="text-gray-400">
                  <span className="text-gray-300 font-medium">Hypothesis check (linear spaces): </span>
                  {(() => {
                    const r = displayAnalysis.spectral_pearson_corr ?? displayAnalysis.xyz_pearson_corr ?? 0;
                    const r2 = displayAnalysis.mean_spectral_r2 ?? 0;
                    if (r > 0.97 && r2 > 0.98)
                      return `✓ Strong: spectral r=${r.toFixed(4)}, per-patch R²=${r2.toFixed(4)} — affine device/substrate separation is plausible.`;
                    if (r > 0.90)
                      return `~ Moderate: r=${r.toFixed(4)} — partial linear structure. Check T(λ) table for which channels deviate.`;
                    if (r > 0)
                      return `✗ Weak: r=${r.toFixed(4)} — affine model insufficient for this substrate pair.`;
                    return 'No spectral data — load ICM profiles with embedded CxF/ZXML to enable spectral analysis.';
                  })()}
                  {displayAnalysis.spectral_slope_cv !== undefined &&
                    ` Slope CV ${(displayAnalysis.spectral_slope_cv * 100).toFixed(1)}% — ${displayAnalysis.spectral_slope_cv < 0.05 ? 'substrate acts as near-uniform spectral multiplier (simplest model works).' : displayAnalysis.spectral_slope_cv < 0.15 ? 'moderate wavelength variation in substrate effect.' : 'strong spectral shape change — per-wavelength model needed.'}`}
                </p>
              </div>
            </>
          ) : (
            <div className="text-center py-6">
              {analysisError ? (
                <p className="text-red-400 text-sm">{analysisError}</p>
              ) : isFiltered && filteredMatchedPatches.length < 10 ? (
                <p className="text-yellow-400 text-sm">
                  Only {filteredMatchedPatches.length} patches within current ink limits — loosen limits to enable analysis.
                </p>
              ) : (
                <p className="text-gray-500 text-sm">Computing…</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Patch correlation scatter */}
      {filteredMatchedPatches.length > 0 && profiles.length === 2 && (
        <PatchCorrelationScatter
          matchedPatches={filteredMatchedPatches}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* Group breakdown */}
      {groupBreakdown && filteredAnalysis && (
        <GroupBreakdownTable
          groups={groupBreakdown}
          globalSlopeL={(() => {
            const g = groupBreakdown.find(g => g.name === 'Neutral' && g.n_patches >= 3);
            return g?.slope_L ?? 1.0;
          })()}
        />
      )}

      {/* Ink ratio invariance */}
      {inkRatios && profiles.length === 2 && (
        <InkRatioTable
          results={inkRatios}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* Neugebauer-Yule spectral prediction */}
      {(modelComparison || xyzComparison) && profiles.length === 2 && (
        <PredictionAccuracyView
          comparison={modelComparison ?? undefined}
          xyzComparison={xyzComparison ?? undefined}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* CYNSN within-profile model */}
      {profiles.length === 2 && (cysnRef || cysnTarget) && (
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8">
          <h3 className="text-lg font-semibold mb-1">Within-profile CYNSN prediction</h3>
          <p className="text-xs text-gray-500 mb-6">
            YNSN / CYNSN-2 fitted independently per profile.
            Confirms whether the physics model can predict spectra from device RGB codes within a single profile.
            Threshold: median ΔE00 &lt; 2.0 → good, &lt; 3.0 → acceptable.
          </p>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {[
              { label: profiles[0].metadata.substrate, result: cysnRef },
              { label: profiles[1].metadata.substrate, result: cysnTarget },
            ].map(({ label, result }) =>
              result ? (
                <div key={label} className="bg-gray-950 border border-gray-800 rounded-xl p-5">
                  <p className="text-sm font-medium text-gray-300 mb-4">{label}</p>
                  <p className="text-xs text-gray-500 mb-3">
                    cal: {result.n_cal} / test: {result.n_test} patches (50/50 split)
                  </p>
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-gray-500 border-b border-gray-800">
                        <th className="text-left pb-2">Model</th>
                        <th className="text-right pb-2">n</th>
                        <th className="text-right pb-2">Median ΔE00</th>
                        <th className="text-right pb-2">P95 ΔE00</th>
                        <th className="text-right pb-2">RMS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.evaluations.map((ev, i) => {
                        const isBest = i === result.best_idx;
                        const good = ev.median_de00 < 2.0;
                        const ok = ev.median_de00 < 3.0;
                        const deColor = good ? 'text-emerald-400' : ok ? 'text-yellow-400' : 'text-red-400';
                        return (
                          <tr
                            key={ev.model_label}
                            className={`border-b border-gray-800/50 ${isBest ? 'bg-blue-950/30' : ''}`}
                          >
                            <td className="py-2 pr-3">
                              <span className="font-mono text-xs">{ev.model_label}</span>
                              {isBest && (
                                <span className="ml-2 text-[10px] text-blue-400 bg-blue-900/40 px-1 rounded">best</span>
                              )}
                            </td>
                            <td className="text-right py-2 text-gray-300 font-mono text-xs">{ev.n_exponent.toFixed(2)}</td>
                            <td className={`text-right py-2 font-mono text-xs font-semibold ${deColor}`}>
                              {ev.median_de00.toFixed(2)}
                            </td>
                            <td className={`text-right py-2 font-mono text-xs ${ok ? 'text-gray-300' : 'text-red-400'}`}>
                              {ev.p95_de00.toFixed(2)}
                            </td>
                            <td className="text-right py-2 text-gray-400 font-mono text-xs">
                              {ev.rms_mean.toFixed(4)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null
            )}
          </div>
        </div>
      )}

      {/* LAB Scatter Plot */}
      <LabScatterPlot profiles={profiles} />

      {/* Spectral Curves */}
      <SpectralCurves profiles={profiles} />
    </div>
  );
}
