// src/components/GroupBreakdownTable.tsx
import { PatchGroupResult } from '../types';

interface Props {
  groups: PatchGroupResult[];
  globalSlopeL: number;
}

function rColor(r: number): string {
  if (r >= 0.95) return 'text-emerald-400';
  if (r >= 0.80) return 'text-yellow-400';
  return 'text-red-400';
}

function slopeColor(slope: number, globalSlope: number): string {
  const dev = Math.abs(slope - globalSlope);
  if (dev <= 0.05) return 'text-emerald-400';
  if (dev <= 0.15) return 'text-yellow-400';
  return 'text-red-400';
}

function deltaColor(d: number): string {
  const a = Math.abs(d);
  if (a <= 2) return 'text-gray-300';
  if (a <= 5) return 'text-yellow-400';
  return 'text-red-400';
}

function slopeBar(slope: number): JSX.Element {
  // Show deviation from 1.0 as mini bar
  const clamped = Math.max(0.5, Math.min(1.5, slope));
  const pct = (clamped - 0.5) / 1.0 * 100; // 0–100 where 50 = slope 1.0
  const color = Math.abs(slope - 1.0) <= 0.05 ? 'bg-emerald-500' : Math.abs(slope - 1.0) <= 0.15 ? 'bg-yellow-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-1.5 min-w-[80px]">
      <div className="flex-1 h-1.5 bg-gray-800 rounded-full relative">
        <div className="absolute top-0 bottom-0 w-px bg-gray-500" style={{ left: '50%' }} />
        <div
          className={`h-full rounded-full ${color}`}
          style={{ width: `${Math.min(100, Math.abs(pct - 50) * 2)}%`, marginLeft: pct < 50 ? `${pct}%` : '50%' }}
        />
      </div>
      <span className="text-xs tabular-nums w-10 text-right">{slope.toFixed(3)}</span>
    </div>
  );
}

function fmt(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

function sign(n: number): string {
  return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
}

export default function GroupBreakdownTable({ groups, globalSlopeL }: Props) {
  const nonEmpty = groups.filter(g => g.n_patches > 0);
  const empty = groups.filter(g => g.n_patches === 0);

  const hasSpectral = nonEmpty.some(g => g.spectral_pearson !== undefined);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6 overflow-x-auto">
      <div className="mb-4">
        <h3 className="text-sm font-semibold text-gray-300">Group-by-group linearity breakdown</h3>
        <p className="text-xs text-gray-500 mt-1">
          Consistent slope across all groups → global affine transform holds.
          Varying slope → per-region correction needed.
          Global slope reference: <span className="text-gray-300 font-mono">{globalSlopeL.toFixed(3)}</span>
        </p>
      </div>

      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-800">
            <th className="text-left py-2 pr-3 text-gray-500 font-medium w-24">Group</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-10">n</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-16">r (Lab)</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-16">R² L*</th>
            <th className="py-2 px-2 text-gray-500 font-medium w-32">Slope L*</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-14">ΔL̄</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-14">Δā</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-14">Δb̄</th>
            {hasSpectral && (
              <th className="text-right py-2 px-2 text-gray-500 font-medium w-16">r (spec)</th>
            )}
          </tr>
        </thead>
        <tbody>
          {nonEmpty.map(g => (
            <tr key={g.name} className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors">
              <td className="py-2 pr-3 font-mono text-gray-200 font-medium">{g.name}</td>
              <td className="py-2 px-2 text-right tabular-nums text-gray-400">{g.n_patches}</td>
              <td className={`py-2 px-2 text-right tabular-nums font-mono ${g.n_patches >= 3 ? rColor(g.pearson_r) : 'text-gray-600'}`}>
                {g.n_patches >= 3 ? fmt(g.pearson_r) : '—'}
              </td>
              <td className={`py-2 px-2 text-right tabular-nums font-mono ${g.n_patches >= 3 ? rColor(g.r_squared_L) : 'text-gray-600'}`}>
                {g.n_patches >= 3 ? fmt(g.r_squared_L) : '—'}
              </td>
              <td className={`py-2 px-2 ${g.n_patches >= 3 ? slopeColor(g.slope_L, globalSlopeL) : 'text-gray-600'}`}>
                {g.n_patches >= 3 ? slopeBar(g.slope_L) : <span className="text-xs">—</span>}
              </td>
              <td className={`py-2 px-2 text-right tabular-nums font-mono ${deltaColor(g.mean_delta_L)}`}>
                {sign(g.mean_delta_L)}
              </td>
              <td className={`py-2 px-2 text-right tabular-nums font-mono ${deltaColor(g.mean_delta_a)}`}>
                {sign(g.mean_delta_a)}
              </td>
              <td className={`py-2 px-2 text-right tabular-nums font-mono ${deltaColor(g.mean_delta_b)}`}>
                {sign(g.mean_delta_b)}
              </td>
              {hasSpectral && (
                <td className={`py-2 px-2 text-right tabular-nums font-mono ${g.spectral_pearson !== undefined ? rColor(g.spectral_pearson) : 'text-gray-600'}`}>
                  {g.spectral_pearson !== undefined ? fmt(g.spectral_pearson) : '—'}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {empty.length > 0 && (
        <p className="text-xs text-gray-600 mt-3">
          No patches found for: {empty.map(g => g.name).join(', ')}
        </p>
      )}

      <div className="mt-4 flex gap-6 text-xs text-gray-600">
        <span><span className="text-emerald-400">■</span> r ≥ 0.95 · slope deviation ≤ 0.05</span>
        <span><span className="text-yellow-400">■</span> r 0.80–0.95 · slope dev 0.05–0.15</span>
        <span><span className="text-red-400">■</span> r &lt; 0.80 · slope dev &gt; 0.15</span>
      </div>
    </div>
  );
}
