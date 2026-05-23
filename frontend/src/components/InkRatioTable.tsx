// src/components/InkRatioTable.tsx
import { InkRatioResult } from '../types';

interface Props {
  results: InkRatioResult[];
  refLabel: string;
  targetLabel: string;
}

function rColor(r: number): string {
  if (r >= 0.97) return 'text-emerald-400';
  if (r >= 0.90) return 'text-yellow-400';
  return 'text-red-400';
}

function madColor(mad: number): string {
  if (mad <= 0.02) return 'text-emerald-400';
  if (mad <= 0.05) return 'text-yellow-400';
  return 'text-red-400';
}

function cvColor(cv: number): string {
  if (cv <= 0.03) return 'text-emerald-400';
  if (cv <= 0.10) return 'text-yellow-400';
  return 'text-red-400';
}

function fmt(v: number, d = 4): string { return v.toFixed(d); }

export default function InkRatioTable({ results }: Props) {
  const valid = results.filter(r => r.n_100 > 0 && r.n_50 > 0 && r.t_pearson_100 !== undefined);
  const noData = results.filter(r => r.n_100 === 0 || r.n_50 === 0 || r.t_pearson_100 === undefined);

  if (valid.length === 0) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Ink ratio invariance (spectral)</h3>
        <p className="text-xs text-gray-500">No spectral data or no matching 100%/50% patches found.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 overflow-x-auto">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300">Ink ratio invariance — spectral T(λ) test</h3>
        <p className="text-xs text-gray-500 mt-1">
          <span className="font-mono text-gray-400">T(λ) = R_ink(λ) / R_paper(λ)</span>
          {' '}— paper-normalised absorption removes substrate colour, leaves pure ink behaviour.
          High r(T_100) + low MAD → same ink on both substrates absorbs identically → device/substrate separation holds.
        </p>
        <p className="text-xs text-gray-600 mt-1">
          r(T_100/T_50) — ratio of absorption curves: measures whether ink coverage scales consistently across substrates.
          CV(scale) — per-wavelength scale factor CV: low = uniform substrate multiplier (simplest separable model).
        </p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 pr-4 text-gray-500 font-medium">Ch</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium">n 100%</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium">n 50%</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">r(T_100)</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">MAD(T_100)</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">r(T_50)</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">r(T₁₀₀/T₅₀)</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">CV scale</th>
          </tr>
        </thead>
        <tbody>
          {valid.map(row => (
            <tr key={row.channel} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
              <td className="py-2 pr-4 font-mono font-semibold text-gray-200">{row.channel}</td>
              <td className="py-2 px-2 text-right tabular-nums text-gray-400">{row.n_100}</td>
              <td className="py-2 px-2 text-right tabular-nums text-gray-400">{row.n_50}</td>

              <td className={`py-2 px-3 text-right tabular-nums font-mono ${row.t_pearson_100 !== undefined ? rColor(row.t_pearson_100) : 'text-gray-600'}`}>
                {row.t_pearson_100 !== undefined ? fmt(row.t_pearson_100) : '—'}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-mono ${row.t_mad_100 !== undefined ? madColor(row.t_mad_100) : 'text-gray-600'}`}>
                {row.t_mad_100 !== undefined ? fmt(row.t_mad_100) : '—'}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-mono ${row.t_pearson_50 !== undefined ? rColor(row.t_pearson_50) : 'text-gray-600'}`}>
                {row.t_pearson_50 !== undefined ? fmt(row.t_pearson_50) : '—'}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-mono ${row.t_ratio_pearson !== undefined ? rColor(row.t_ratio_pearson) : 'text-gray-600'}`}>
                {row.t_ratio_pearson !== undefined ? fmt(row.t_ratio_pearson) : '—'}
              </td>
              <td className={`py-2 px-3 text-right tabular-nums font-mono ${row.t_scale_cv !== undefined ? cvColor(row.t_scale_cv) : 'text-gray-600'}`}>
                {row.t_scale_cv !== undefined ? (row.t_scale_cv * 100).toFixed(1) + '%' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {noData.length > 0 && (
        <p className="text-xs text-gray-600 mt-3">
          No spectral patches found for: {noData.map(r => r.channel).join(', ')}
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-gray-600">
        <div>
          <p className="text-gray-500 font-medium mb-1">r(T) — T-curve similarity</p>
          <p><span className="text-emerald-400">≥0.97</span> same absorption profile shape</p>
          <p><span className="text-yellow-400">0.90–0.97</span> mostly preserved</p>
          <p><span className="text-red-400">&lt;0.90</span> profile changes with substrate</p>
        </div>
        <div>
          <p className="text-gray-500 font-medium mb-1">MAD(T_100) — absolute deviation</p>
          <p><span className="text-emerald-400">≤0.02</span> &lt;2% reflectance error</p>
          <p><span className="text-yellow-400">0.02–0.05</span> small systematic shift</p>
          <p><span className="text-red-400">&gt;0.05</span> significant substrate-ink interaction</p>
        </div>
        <div>
          <p className="text-gray-500 font-medium mb-1">CV scale — wavelength uniformity</p>
          <p><span className="text-emerald-400">≤3%</span> uniform scalar per substrate → simplest model</p>
          <p><span className="text-yellow-400">3–10%</span> near-uniform</p>
          <p><span className="text-red-400">&gt;10%</span> wavelength-dependent → needs spectral model</p>
        </div>
      </div>
    </div>
  );
}
