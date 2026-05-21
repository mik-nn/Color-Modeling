// src/components/PatchCorrelationScatter.tsx
import { useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { MatchedPatchPair } from '../types';

interface Props {
  matchedPatches: MatchedPatchPair[];
  refLabel: string;
  targetLabel: string;
}

type Channel = { key: 'L' | 'a' | 'b'; label: string; domain: [number, number] };

const CHANNELS: Channel[] = [
  { key: 'L', label: 'L*', domain: [0, 100] },
  { key: 'a', label: 'a*', domain: [-60, 60] },
  { key: 'b', label: 'b*', domain: [-60, 60] },
];

function getRef(p: MatchedPatchPair, ch: Channel['key']): number {
  if (ch === 'L') return p.ref.LAB_L;
  if (ch === 'a') return p.ref.LAB_A;
  return p.ref.LAB_B;
}

function getTarget(p: MatchedPatchPair, ch: Channel['key']): number {
  if (ch === 'L') return p.target.LAB_L;
  if (ch === 'a') return p.target.LAB_A;
  return p.target.LAB_B;
}

function linRegression(xs: number[], ys: number[]): { slope: number; intercept: number } {
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
  const sx2 = xs.reduce((sum, x) => sum + x * x, 0);
  const denom = n * sx2 - sx * sx;
  if (denom === 0) return { slope: 1, intercept: 0 };
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { slope, intercept };
}

function pearsonR(xs: number[], ys: number[]): number {
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxy = xs.reduce((sum, x, i) => sum + x * ys[i], 0);
  const sx2 = xs.reduce((sum, x) => sum + x * x, 0);
  const sy2 = ys.reduce((sum, y) => sum + y * y, 0);
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
  return den === 0 ? 0 : num / den;
}

function dotColor(p: MatchedPatchPair): string {
  const r = p.ref.RGB_R;
  const g = p.ref.RGB_G;
  const b = p.ref.RGB_B;
  if (r !== undefined && g !== undefined && b !== undefined) {
    return `rgb(${r},${g},${b})`;
  }
  return '#6366f1';
}

export default function PatchCorrelationScatter({ matchedPatches, refLabel, targetLabel }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current || matchedPatches.length === 0) return;

    const panelW = 240;
    const panelH = 240;
    const margin = { top: 30, right: 16, bottom: 44, left: 44 };
    const innerW = panelW - margin.left - margin.right;
    const innerH = panelH - margin.top - margin.bottom;
    const totalW = panelW * 3 + 16;
    const totalH = panelH;

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', totalW).attr('height', totalH);

    CHANNELS.forEach((ch, ci) => {
      const xs = matchedPatches.map(p => getRef(p, ch.key));
      const ys = matchedPatches.map(p => getTarget(p, ch.key));
      const { slope, intercept } = linRegression(xs, ys);
      const r = pearsonR(xs, ys);

      const g = svg.append('g')
        .attr('transform', `translate(${ci * (panelW + 8) + margin.left}, ${margin.top})`);

      const xScale = d3.scaleLinear().domain(ch.domain).range([0, innerW]);
      const yScale = d3.scaleLinear().domain(ch.domain).range([innerH, 0]);

      // Grid
      g.append('g').call(
        d3.axisBottom(xScale).ticks(4).tickSize(-innerH)
      )
        .attr('transform', `translate(0,${innerH})`)
        .call(ax => ax.select('.domain').remove())
        .call(ax => ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'))
        .call(ax => ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10));

      g.append('g').call(
        d3.axisLeft(yScale).ticks(4).tickSize(-innerW)
      )
        .call(ax => ax.select('.domain').remove())
        .call(ax => ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2'))
        .call(ax => ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10));

      // Identity line y=x
      g.append('line')
        .attr('x1', xScale(ch.domain[0])).attr('y1', yScale(ch.domain[0]))
        .attr('x2', xScale(ch.domain[1])).attr('y2', yScale(ch.domain[1]))
        .attr('stroke', '#ef4444').attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '5,3').attr('opacity', 0.7);

      // Regression line
      const x0 = ch.domain[0];
      const x1 = ch.domain[1];
      g.append('line')
        .attr('x1', xScale(x0)).attr('y1', yScale(slope * x0 + intercept))
        .attr('x2', xScale(x1)).attr('y2', yScale(slope * x1 + intercept))
        .attr('stroke', '#3b82f6').attr('stroke-width', 2).attr('opacity', 0.9);

      // Dots
      g.selectAll('circle')
        .data(matchedPatches)
        .enter().append('circle')
        .attr('cx', p => xScale(getRef(p, ch.key)))
        .attr('cy', p => yScale(getTarget(p, ch.key)))
        .attr('r', 2)
        .attr('fill', p => dotColor(p))
        .attr('fill-opacity', 0.55)
        .attr('stroke', 'none');

      // Panel title
      g.append('text')
        .attr('x', innerW / 2).attr('y', -12)
        .attr('text-anchor', 'middle')
        .attr('fill', '#e5e7eb').attr('font-size', 13).attr('font-weight', 600)
        .text(ch.label);

      // r annotation
      g.append('text')
        .attr('x', innerW - 4).attr('y', 14)
        .attr('text-anchor', 'end')
        .attr('fill', '#60a5fa').attr('font-size', 11)
        .text(`r = ${r.toFixed(4)}`);

      // Slope annotation
      g.append('text')
        .attr('x', innerW - 4).attr('y', 26)
        .attr('text-anchor', 'end')
        .attr('fill', '#9ca3af').attr('font-size', 10)
        .text(`y = ${slope.toFixed(3)}x ${intercept >= 0 ? '+' : ''}${intercept.toFixed(2)}`);

      // X axis label
      g.append('text')
        .attr('x', innerW / 2).attr('y', innerH + 36)
        .attr('text-anchor', 'middle')
        .attr('fill', '#6b7280').attr('font-size', 10)
        .text(`ref ${ch.label}`);

      // Y axis label
      g.append('text')
        .attr('transform', 'rotate(-90)')
        .attr('x', -innerH / 2).attr('y', -32)
        .attr('text-anchor', 'middle')
        .attr('fill', '#6b7280').attr('font-size', 10)
        .text(`target ${ch.label}`);
    });

  }, [matchedPatches, refLabel, targetLabel]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <h3 className="text-sm font-semibold text-gray-300 mb-1">
        Patch correlation: {refLabel} → {targetLabel}
      </h3>
      <p className="text-xs text-gray-500 mb-4">
        Each dot = one matched patch. Red dashed = identity (y=x). Blue = linear fit. Dots colored by actual RGB ink value.
      </p>
      <div className="overflow-x-auto">
        <svg ref={svgRef} className="block" />
      </div>
      <p className="text-xs text-gray-600 mt-3">
        {matchedPatches.length} matched patches. High r (→1) + slope near 1 = strong affine relationship.
      </p>
    </div>
  );
}
