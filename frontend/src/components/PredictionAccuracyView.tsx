// src/components/PredictionAccuracyView.tsx
import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { SpectralModelComparison, SpectralPredictionEvaluation, PredictionModelType } from '../types';

interface Props {
  comparison?: SpectralModelComparison;
  xyzComparison?: SpectralModelComparison;
  refLabel: string;
  targetLabel: string;
}

const MODEL_LABELS: Record<PredictionModelType, string> = {
  multiplicative: 'Multiplicative R_B = a(λ)·R_A',
  poly1:          'Affine R_B = a(λ)·R_A + b(λ)',
  poly2:          'Quadratic (poly2)',
  poly3:          'Cubic (poly3)',
  yn:             'Yule-Nielsen (affine in R^(1/n))',
  xyz_affine:     'XYZ affine X_B = a·X_A + b (per ch.)',
  xyz_poly2:      'XYZ quadratic (poly2 per ch.)',
};

function r2Color(r: number): string {
  if (r >= 0.9990) return 'text-emerald-400';
  if (r >= 0.980)  return 'text-yellow-400';
  return 'text-red-400';
}

function maeColor(mae: number): string {
  if (mae <= 0.005) return 'text-emerald-400';
  if (mae <= 0.020) return 'text-yellow-400';
  return 'text-red-400';
}

// ─── Transfer function chart ─────────────────────────────────────────────────

const COEFF_COLORS = ['#f59e0b', '#3b82f6', '#a855f7', '#22c55e'];
const COEFF_LABELS = (modelType: PredictionModelType, ynN?: number) => {
  if (modelType === 'multiplicative') return ['a(λ)'];
  if (modelType === 'yn') return [`c0(λ)`, `c1(λ) [n=${ynN?.toFixed(1)}]`];
  return ['c0(λ)', 'c1(λ)', 'c2(λ)', 'c3(λ)'];
};

function SlopeChart({ evaluation }: { evaluation: SpectralPredictionEvaluation }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;
    const { poly_coeffs, wavelengths, model_type, yn_n } = evaluation.model;

    // Extract all coefficient series: coeffsByDegree[j] = array over wavelengths
    const degree = poly_coeffs[0]?.length ?? 1;
    const coeffsByDegree: number[][] = Array.from({ length: degree }, (_, j) =>
      poly_coeffs.map(c => c[j] ?? 0)
    );

    // For multiplicative: only index 0 exists (it's stored as c[1] alias — use it directly)
    const series = model_type === 'multiplicative'
      ? [poly_coeffs.map(c => c[1] ?? c[0] ?? 1)]
      : coeffsByDegree;

    const W = 500, H = 220;
    const m = { top: 20, right: 20, bottom: 36, left: 44 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', W).attr('height', H);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

    const xScale = d3.scaleLinear().domain([wavelengths[0], wavelengths[wavelengths.length - 1]]).range([0, iw]);
    const allVals = series.flat();
    const yMin = Math.min(0, d3.min(allVals)! - 0.05);
    const yMax = Math.max(1.5, d3.max(allVals)! + 0.05);
    const yScale = d3.scaleLinear().domain([yMin, yMax]).range([ih, 0]);

    g.append('g').call(d3.axisBottom(xScale).ticks(8).tickSize(-ih))
      .attr('transform', `translate(0,${ih})`)
      .call(ax => { ax.select('.domain').remove(); ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'); ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10); });
    g.append('g').call(d3.axisLeft(yScale).ticks(5).tickSize(-iw))
      .call(ax => { ax.select('.domain').remove(); ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'); ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10); });

    g.append('line').attr('x1', 0).attr('y1', yScale(0)).attr('x2', iw).attr('y2', yScale(0))
      .attr('stroke', '#374151').attr('stroke-width', 1);
    g.append('line').attr('x1', 0).attr('y1', yScale(1)).attr('x2', iw).attr('y2', yScale(1))
      .attr('stroke', '#6b7280').attr('stroke-dasharray', '4,3').attr('stroke-width', 1);

    const labels = COEFF_LABELS(model_type, yn_n);
    const mkLine = d3.line<number>().x((_, i) => xScale(wavelengths[i])).y(v => yScale(v)).curve(d3.curveBasis);

    series.forEach((vals, j) => {
      const color = COEFF_COLORS[j % COEFF_COLORS.length];
      const isDashed = j === 0 && model_type !== 'multiplicative'; // c0 is dashed
      g.append('path').datum(vals)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', j === 1 ? 2.5 : 1.8)
        .attr('stroke-dasharray', isDashed ? '4,2' : 'none')
        .attr('d', mkLine);
    });

    // Legend
    const leg = g.append('g').attr('transform', `translate(${iw - 180}, 4)`);
    labels.forEach((lbl, j) => {
      const color = COEFF_COLORS[j % COEFF_COLORS.length];
      const isDashed = j === 0 && model_type !== 'multiplicative';
      const y = j * 16;
      leg.append('line').attr('x1', 0).attr('y1', y + 6).attr('x2', 18).attr('y2', y + 6)
        .attr('stroke', color).attr('stroke-width', j === 1 ? 2.5 : 1.8)
        .attr('stroke-dasharray', isDashed ? '4,2' : 'none');
      leg.append('text').attr('x', 24).attr('y', y + 10).attr('fill', '#d1d5db').attr('font-size', 11).text(lbl);
    });

    g.append('text').attr('x', iw / 2).attr('y', ih + 30).attr('text-anchor', 'middle').attr('fill', '#6b7280').attr('font-size', 10).text('Wavelength (nm)');

  }, [evaluation]);

  return <svg ref={svgRef} className="block" />;
}

// ─── Per-wavelength coefficients table ───────────────────────────────────────

function CoefficientsTable({ evaluation }: { evaluation: SpectralPredictionEvaluation }) {
  const { poly_coeffs, wavelengths, model_type, yn_n } = evaluation.model;
  const labels = COEFF_LABELS(model_type, yn_n);

  // For multiplicative, poly_coeffs[wi] = [0, a] — show only the a column
  const isMultiplicative = model_type === 'multiplicative';
  const rowData = (i: number): number[] =>
    isMultiplicative ? [poly_coeffs[i][1] ?? 0] : poly_coeffs[i];

  function exportCsv() {
    const header = ['lambda_nm', ...labels].join(',');
    const csvRows = wavelengths.map((wl, i) => [wl, ...rowData(i)].join(','));
    const csv = [header, ...csvRows].join('\n');
    navigator.clipboard.writeText(csv).catch(() => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `coeffs_${model_type}_${evaluation.model.calibration_label.replace(/\s+/g, '_')}.csv`;
      a.click();
    });
  }

  return (
    <details className="mt-4">
      <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-400 select-none">
        Per-wavelength coefficients table ({wavelengths.length} rows × {labels.length} coefficients)
      </summary>
      <div className="mt-3">
        <div className="flex justify-end mb-2">
          <button
            onClick={exportCsv}
            className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 rounded-lg border border-gray-700 transition-colors"
          >
            Copy CSV
          </button>
        </div>
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full text-xs font-mono">
            <thead className="sticky top-0 bg-gray-900">
              <tr className="border-b border-gray-700">
                <th className="text-right py-1 pr-4 text-gray-500 font-medium">λ (nm)</th>
                {labels.map((lbl, j) => (
                  <th key={j} className="text-right py-1 px-3 font-medium" style={{ color: COEFF_COLORS[j % COEFF_COLORS.length] }}>
                    {lbl}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {wavelengths.map((wl, i) => (
                <tr key={wl} className="border-b border-gray-800/40 hover:bg-gray-800/30">
                  <td className="py-1 pr-4 text-right text-gray-400">{wl}</td>
                  {rowData(i).map((v, j) => (
                    <td key={j} className="py-1 px-3 text-right tabular-nums" style={{ color: COEFF_COLORS[j % COEFF_COLORS.length] }}>
                      {v.toFixed(6)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

// ─── R² histogram ────────────────────────────────────────────────────────────

function R2Histogram({ evaluation }: { evaluation: SpectralPredictionEvaluation }) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;
    const r2s = evaluation.patch_results.map(r => r.r2);
    const W = 280, H = 180;
    const m = { top: 16, right: 12, bottom: 32, left: 28 };
    const iw = W - m.left - m.right, ih = H - m.top - m.bottom;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', W).attr('height', H);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

    const xScale = d3.scaleLinear().domain([d3.min(r2s)! - 0.001, 1]).range([0, iw]);
    const bins = d3.bin().domain(xScale.domain() as [number, number]).thresholds(20)(r2s);
    const yScale = d3.scaleLinear().domain([0, d3.max(bins, b => b.length)!]).range([ih, 0]);

    g.append('g').call(d3.axisBottom(xScale).ticks(5))
      .attr('transform', `translate(0,${ih})`)
      .call(ax => { ax.select('.domain').attr('stroke', '#4b5563'); ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10); });

    g.selectAll('rect').data(bins).enter().append('rect')
      .attr('x', d => xScale(d.x0!) + 1)
      .attr('width', d => Math.max(0, xScale(d.x1!) - xScale(d.x0!) - 2))
      .attr('y', d => yScale(d.length))
      .attr('height', d => ih - yScale(d.length))
      .attr('fill', d => (d.x0! >= 0.999 ? '#10b981' : d.x0! >= 0.98 ? '#f59e0b' : '#ef4444'))
      .attr('opacity', 0.8);

    g.append('text').attr('x', iw / 2).attr('y', ih + 26).attr('text-anchor', 'middle').attr('fill', '#6b7280').attr('font-size', 10).text('Per-patch R²');

  }, [evaluation]);

  return <svg ref={svgRef} className="block" />;
}

// ─── Reusable comparison table ───────────────────────────────────────────────

function ComparisonTable({
  comp,
  isXYZ = false,
}: {
  comp: SpectralModelComparison;
  isXYZ?: boolean;
}) {
  const { rows, best_idx } = comp;

  return (
    <div className="overflow-x-auto mb-6">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-700">
            <th className="text-left py-2 pr-3 text-gray-500 font-medium">Model</th>
            <th className="text-left py-2 pr-4 text-gray-500 font-medium">Calibration</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-10">n cal</th>
            <th className="text-right py-2 px-2 text-gray-500 font-medium w-10">n test</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">Mean R²</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">P5 R²</th>
            <th className="text-right py-2 px-3 text-gray-500 font-medium">{isXYZ ? 'MAE XYZ' : 'MAE'}</th>
            {!isXYZ && <th className="text-right py-2 px-2 text-gray-500 font-medium">YN n</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const isBest = i === best_idx;
            return (
              <tr
                key={i}
                className={`border-b border-gray-800/50 transition-colors ${isBest ? 'bg-blue-950/30' : 'hover:bg-gray-800/30'}`}
              >
                <td className="py-2 pr-3 font-mono text-xs">
                  <span className={isBest ? 'text-blue-300 font-semibold' : 'text-gray-300'}>
                    {MODEL_LABELS[row.model_type]}
                  </span>
                  {isBest && <span className="ml-2 text-blue-400 text-xs">★ best</span>}
                </td>
                <td className="py-2 pr-4 text-gray-400 text-xs">{row.calibration_label}</td>
                <td className="py-2 px-2 text-right tabular-nums text-gray-400">{row.n_calibration}</td>
                <td className="py-2 px-2 text-right tabular-nums text-gray-400">{row.n_test}</td>
                <td className={`py-2 px-3 text-right tabular-nums font-mono font-semibold ${r2Color(row.mean_r2)}`}>
                  {row.mean_r2.toFixed(5)}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums font-mono ${r2Color(row.p5_r2)}`}>
                  {row.p5_r2.toFixed(5)}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums font-mono ${maeColor(row.mean_spectral_mae)}`}>
                  {isXYZ
                    ? row.mean_spectral_mae.toFixed(3)
                    : (row.mean_spectral_mae * 100).toFixed(3) + '%'}
                </td>
                {!isXYZ && (
                  <td className="py-2 px-2 text-right tabular-nums text-gray-400 font-mono">
                    {row.yn_n !== undefined ? row.yn_n.toFixed(1) : '—'}
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── XYZ coefficients bar chart ──────────────────────────────────────────────

const XYZ_CHANNEL_LABELS = ['X', 'Y', 'Z'];

function XYZCoeffChart({ evaluation }: { evaluation: SpectralPredictionEvaluation }) {
  const { poly_coeffs } = evaluation.model;
  const degree = poly_coeffs[0]?.length ?? 2;
  const labels = degree === 2 ? ['c0 (offset)', 'c1 (slope)'] : ['c0', 'c1', 'c2'];

  return (
    <div className="text-xs font-mono">
      <table className="border-separate border-spacing-0">
        <thead>
          <tr>
            <th className="text-right pr-4 py-1 text-gray-500 font-medium">Ch</th>
            {labels.map((l, j) => (
              <th key={j} className="text-right px-4 py-1 font-medium" style={{ color: COEFF_COLORS[j] }}>{l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {XYZ_CHANNEL_LABELS.map((ch, i) => (
            <tr key={ch}>
              <td className="text-right pr-4 py-1 text-gray-300 font-semibold">{ch}</td>
              {(poly_coeffs[i] ?? []).map((v, j) => (
                <td key={j} className="text-right px-4 py-1 tabular-nums" style={{ color: COEFF_COLORS[j] }}>
                  {v.toFixed(6)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────

export default function PredictionAccuracyView({ comparison, xyzComparison }: Props) {
  return (
    <div className="space-y-6">
      {/* ── Spectral section ── */}
      {comparison && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-300">
              Spectral prediction R(λ) — Neugebauer-Yule model comparison
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              Per-wavelength fit <span className="font-mono text-gray-400">R_{'{'}targetLabel{'}'}(λ) = f(R_{'{'}refLabel{'}'}(λ))</span>.
              Multiple models × calibration scenarios. Hypothesis: N solid patches predict the full profile.
            </p>
          </div>

          <ComparisonTable comp={comparison} />

          <div className="border-t border-gray-800 pt-5">
            <p className="text-xs text-gray-500 mb-4">
              Best:{' '}
              <span className="text-blue-400 font-medium">{MODEL_LABELS[comparison.best_evaluation.model.model_type]}</span>
              {' · '}{comparison.best_evaluation.model.calibration_label}
              {comparison.best_evaluation.model.yn_n !== undefined &&
                ` · n=${comparison.best_evaluation.model.yn_n.toFixed(1)}`}
            </p>
            <div className="flex flex-wrap gap-6 items-start">
              <div>
                <p className="text-xs text-gray-500 mb-2">Per-wavelength coefficients — flat c1(λ) ≈ uniform substrate scaling</p>
                <SlopeChart evaluation={comparison.best_evaluation} />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-2">R² histogram ({comparison.best_evaluation.n_test} test patches)</p>
                <R2Histogram evaluation={comparison.best_evaluation} />
              </div>
            </div>
            <CoefficientsTable evaluation={comparison.best_evaluation} />
          </div>

          <div className="mt-4 p-3 rounded-xl bg-gray-950 border border-gray-800 text-xs text-gray-400">
            <span className="text-gray-300 font-medium">Verdict: </span>
            {(() => {
              const { rows, best_idx } = comparison;
              const best = rows[best_idx];
              const minimal = rows.filter(r => r.calibration_label.includes('Minimal'));
              const bestMinimal = minimal.length > 0
                ? minimal.reduce((b, r) => r.mean_r2 > b.mean_r2 ? r : b, minimal[0])
                : null;
              if (!best) return '—';
              const parts: string[] = [];
              if (best.mean_r2 >= 0.999) {
                parts.push(`✓ Spectral R²=${best.mean_r2.toFixed(5)} — excellent. Neugebauer-Yule separability confirmed.`);
              } else if (best.mean_r2 >= 0.98) {
                parts.push(`~ Spectral R²=${best.mean_r2.toFixed(5)} — good. Check P5 R²=${best.p5_r2.toFixed(4)} for failure zones.`);
              } else {
                parts.push(`✗ Spectral R²=${best.mean_r2.toFixed(5)} — non-trivial substrate-ink interaction.`);
              }
              if (bestMinimal) {
                parts.push(
                  bestMinimal.mean_r2 >= 0.995
                    ? `Minimal calibration achieves R²=${bestMinimal.mean_r2.toFixed(5)} — sufficient.`
                    : `Minimal calibration drops to R²=${bestMinimal.mean_r2.toFixed(5)} — more primaries needed.`
                );
              }
              return parts.join(' ');
            })()}
          </div>
        </div>
      )}

      {/* ── XYZ section ── */}
      {xyzComparison && (
        <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
          <div className="mb-5">
            <h3 className="text-sm font-semibold text-gray-300">
              XYZ prediction — per-channel polynomial model
            </h3>
            <p className="text-xs text-gray-500 mt-1">
              <span className="font-mono text-gray-400">X_B = f(X_A), Y_B = f(Y_A), Z_B = f(Z_A)</span>
              {' '}— linear tristimulus space. Calibrated from paper + 2-ink solids + 50% halftone.
              MAE in XYZ units (Y=100 for white).
            </p>
          </div>

          <ComparisonTable comp={xyzComparison} isXYZ />

          <div className="border-t border-gray-800 pt-5">
            <p className="text-xs text-gray-500 mb-3">
              Best XYZ model:{' '}
              <span className="text-blue-400 font-medium">{MODEL_LABELS[xyzComparison.best_evaluation.model.model_type]}</span>
              {' · '}{xyzComparison.best_evaluation.model.calibration_label}
            </p>
            <div className="flex flex-wrap gap-8 items-start">
              <div>
                <p className="text-xs text-gray-500 mb-2">Per-channel coefficients</p>
                <XYZCoeffChart evaluation={xyzComparison.best_evaluation} />
              </div>
              <div>
                <p className="text-xs text-gray-500 mb-2">R² histogram ({xyzComparison.best_evaluation.n_test} test patches)</p>
                <R2Histogram evaluation={xyzComparison.best_evaluation} />
              </div>
            </div>
          </div>

          <div className="mt-4 p-3 rounded-xl bg-gray-950 border border-gray-800 text-xs text-gray-400">
            <span className="text-gray-300 font-medium">XYZ verdict: </span>
            {(() => {
              const { rows, best_idx } = xyzComparison;
              const best = rows[best_idx];
              const minimal = rows.find(r => r.calibration_label.includes('paper + 100RG'));
              if (!best) return '—';
              const parts: string[] = [];
              if (best.mean_r2 >= 0.999) {
                parts.push(`✓ XYZ R²=${best.mean_r2.toFixed(5)} — tristimulus prediction excellent.`);
              } else if (best.mean_r2 >= 0.98) {
                parts.push(`~ XYZ R²=${best.mean_r2.toFixed(5)} — good. Colorimetric prediction usable.`);
              } else {
                parts.push(`✗ XYZ R²=${best.mean_r2.toFixed(5)} — per-channel model insufficient; cross-channel coupling present.`);
              }
              if (minimal) {
                parts.push(
                  minimal.mean_r2 >= 0.995
                    ? `5-patch XYZ calibration (paper+100RG+100RB+100GB+50RG) achieves R²=${minimal.mean_r2.toFixed(5)}.`
                    : `5-patch calibration drops to R²=${minimal.mean_r2.toFixed(5)} — Neugebauer primaries needed for XYZ.`
                );
              }
              return parts.join(' ');
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
