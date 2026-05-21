// src/components/ComparisonView.tsx
import { useEffect, useMemo, useState } from 'react';
import { ProfileData, LinearityResult } from '../types';
import LabScatterPlot from './LabScatterPlot';
import SpectralCurves from './SpectralCurves';
import PatchCorrelationScatter from './PatchCorrelationScatter';
import GroupBreakdownTable from './GroupBreakdownTable';
import InkRatioTable from './InkRatioTable';
import PredictionAccuracyView from './PredictionAccuracyView';
import InkLimitSection from './InkLimitSection';
import { analyzeLinearity } from '../lib/analyzers/linearityAnalyzer';
import { analyzeByGroups } from '../lib/analyzers/groupAnalyzer';
import { analyzeInkRatios } from '../lib/analyzers/inkRatioAnalyzer';
import { runModelComparison, runXYZModelComparison } from '../lib/analyzers/spectralPredictor';
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

  useEffect(() => {
    setLinearityResult(analysis);
  }, [analysis, setLinearityResult]);

  const groupBreakdown = useMemo(() => {
    if (!analysis?.matched_patches || analysis.matched_patches.length === 0) return null;
    return analyzeByGroups(analysis.matched_patches);
  }, [analysis]);

  const inkRatios = useMemo(() => {
    if (!analysis?.matched_patches || analysis.matched_patches.length === 0) return null;
    return analyzeInkRatios(analysis.matched_patches);
  }, [analysis]);

  const modelComparison = useMemo(() => {
    if (!analysis?.matched_patches || analysis.matched_patches.length === 0) return null;
    return runModelComparison(analysis.matched_patches);
  }, [analysis]);

  const xyzComparison = useMemo(() => {
    if (!analysis?.matched_patches || analysis.matched_patches.length === 0) return null;
    return runXYZModelComparison(analysis.matched_patches);
  }, [analysis]);

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

      {/* Linearity analysis */}
      {profiles.length === 2 && (
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-8">
          <h3 className="text-lg font-semibold mb-2">Transfer linearity analysis</h3>
          {analysis ? (
            <>
              <p className="text-xs text-gray-500 mb-6">
                {analysis.n_patches_used} matched patches •{' '}
                <span
                  className={
                    analysis.linearity_confidence === 'high'
                      ? 'text-emerald-400'
                      : analysis.linearity_confidence === 'medium'
                      ? 'text-yellow-400'
                      : 'text-red-400'
                  }
                >
                  {analysis.linearity_confidence.toUpperCase()} confidence
                </span>
              </p>

              {/* Primary: linear spaces */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {analysis.spectral_pearson_corr !== undefined && (
                  <MetricCard
                    label="Spectral r"
                    value={analysis.spectral_pearson_corr.toFixed(4)}
                    sub="Pearson r — all patches × all λ (linear)"
                    good={analysis.spectral_pearson_corr > 0.97}
                  />
                )}
                {analysis.xyz_pearson_corr !== undefined && (
                  <MetricCard
                    label="XYZ r"
                    value={analysis.xyz_pearson_corr.toFixed(4)}
                    sub="Pearson r in XYZ tristimulus (linear)"
                    good={analysis.xyz_pearson_corr > 0.97}
                  />
                )}
                {analysis.mean_spectral_r2 !== undefined && (
                  <MetricCard
                    label="Per-patch spec R²"
                    value={analysis.mean_spectral_r2.toFixed(4)}
                    sub="Mean R² of R_target = f(R_ref) per patch"
                    good={analysis.mean_spectral_r2 > 0.98}
                  />
                )}
                {analysis.spectral_slope_cv !== undefined && (
                  <MetricCard
                    label="Slope CV λ"
                    value={(analysis.spectral_slope_cv * 100).toFixed(1) + '%'}
                    sub="CV of a(λ) across wavelengths — low = flat substrate effect"
                    good={analysis.spectral_slope_cv < 0.05}
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
                    value={analysis.pearson_corr_lab.toFixed(4)}
                    sub="Non-linear space — for reference only"
                    good={null}
                  />
                  {analysis.mean_deltaE_after_correction !== undefined && isFinite(analysis.mean_deltaE_after_correction) && (
                    <MetricCard
                      label="ΔE after offset"
                      value={analysis.mean_deltaE_after_correction.toFixed(2)}
                      sub="Mean ΔE after global Lab offset correction"
                      good={analysis.mean_deltaE_after_correction < 3}
                    />
                  )}
                </div>
              </details>

              <div className="mt-4 p-4 rounded-xl bg-gray-950 border border-gray-800 text-sm">
                <p className="text-gray-400">
                  <span className="text-gray-300 font-medium">Hypothesis check (linear spaces): </span>
                  {(() => {
                    const r = analysis.spectral_pearson_corr ?? analysis.xyz_pearson_corr ?? 0;
                    const r2 = analysis.mean_spectral_r2 ?? 0;
                    const cv = analysis.spectral_slope_cv;
                    if (r > 0.97 && r2 > 0.98)
                      return `✓ Strong: spectral r=${r.toFixed(4)}, per-patch R²=${r2.toFixed(4)} — affine device/substrate separation is plausible.`;
                    if (r > 0.90)
                      return `~ Moderate: r=${r.toFixed(4)} — partial linear structure. Check T(λ) table for which channels deviate.`;
                    if (r > 0)
                      return `✗ Weak: r=${r.toFixed(4)} — affine model insufficient for this substrate pair.`;
                    return 'No spectral data — load ICM profiles with embedded CxF/ZXML to enable spectral analysis.';
                  })()}
                  {analysis.spectral_slope_cv !== undefined &&
                    ` Slope CV ${(analysis.spectral_slope_cv * 100).toFixed(1)}% — ${analysis.spectral_slope_cv < 0.05 ? 'substrate acts as near-uniform spectral multiplier (simplest model works).' : analysis.spectral_slope_cv < 0.15 ? 'moderate wavelength variation in substrate effect.' : 'strong spectral shape change — per-wavelength model needed.'}`}
                </p>
              </div>
            </>
          ) : (
            <div className="text-center py-6">
              {analysisError ? (
                <p className="text-red-400 text-sm">{analysisError}</p>
              ) : (
                <p className="text-gray-500 text-sm">Computing…</p>
              )}
            </div>
          )}
        </div>
      )}

      {/* Patch correlation scatter — primary hypothesis visualization */}
      {analysis?.matched_patches && analysis.matched_patches.length > 0 && (
        <PatchCorrelationScatter
          matchedPatches={analysis.matched_patches}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* Group breakdown — where does affine hold / break? */}
      {groupBreakdown && analysis && (
        <GroupBreakdownTable
          groups={groupBreakdown}
          globalSlopeL={(() => {
            const g = groupBreakdown.find(g => g.name === 'Neutral' && g.n_patches >= 3);
            return g?.slope_L ?? 1.0;
          })()}
        />
      )}

      {/* Ink ratio invariance — core separability test */}
      {inkRatios && profiles.length === 2 && (
        <InkRatioTable
          results={inkRatios}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* Ink limit analysis — a*b* ramps + overflow detection */}
      {profiles.length >= 1 && (
        <InkLimitSection
          profiles={profiles}
          matchedPatches={analysis?.matched_patches ?? []}
        />
      )}

      {/* Neugebauer-Yule spectral prediction — model comparison */}
      {(modelComparison || xyzComparison) && profiles.length === 2 && (
        <PredictionAccuracyView
          comparison={modelComparison ?? undefined}
          xyzComparison={xyzComparison ?? undefined}
          refLabel={profiles[0].metadata.substrate}
          targetLabel={profiles[1].metadata.substrate}
        />
      )}

      {/* LAB Scatter Plot */}
      <LabScatterPlot profiles={profiles} />

      {/* Spectral Curves */}
      <SpectralCurves profiles={profiles} />
    </div>
  );
}
