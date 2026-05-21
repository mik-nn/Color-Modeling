// src/components/InkLimitSection.tsx
import React, { useMemo, useState, useEffect, useRef } from 'react';
import * as d3 from 'd3';
import { ProfileData, MatchedPatchPair } from '../types';
import { runXYZModelComparison } from '../lib/analyzers/spectralPredictor';
import { filterNeugebauerPrimaries, buildCGATS, downloadCGATS } from '../lib/cgatsExport';
import { autoDetectLimits, rescaleMatchedPatches, type RampErrors, type RampPoint } from '../lib/analyzers/limitsAnalyzer';

// ─── Ink limits (CMY ink coverage, 0–255) ────────────────────────────────────
// Convention: 255 = paper/no ink, 0 = maximum ink (device channel value)
//   C ink = 255 – R_channel,  M ink = 255 – G_channel,  Y ink = 255 – B_channel
//
// Primary limits (C/M/Y): apply only to the corresponding single-ink ramp.
// Overprint limits (CM/CY/MY): apply to paired-ink secondary ramps with AND logic —
//   patch excluded when BOTH inks simultaneously exceed the overprint limit.
//   (Matches domain.ts in RGB-Calibration: (C > cmMax && M > cmMax) etc.)
//
// 255 = no restriction on that axis.

export interface InkLimits {
  C: number; M: number; Y: number;    // primary ramp limits
  CM: number; CY: number; MY: number; // overprint (secondary) ramp limits
}
export const NO_LIMIT: InkLimits = { C: 255, M: 255, Y: 255, CM: 255, CY: 255, MY: 255 };

// Domain predicate matching isOutOfDomain() in RGB-Calibration/domain.ts
export function isOutOfDomain(C: number, M: number, Y: number, l: InkLimits): boolean {
  return C > l.C || M > l.M || Y > l.Y ||
    (C > l.CM && M > l.CM) ||   // CM overprint (= B ramp)
    (C > l.CY && Y > l.CY) ||   // CY overprint (= G ramp)
    (M > l.MY && Y > l.MY);     // MY overprint (= R ramp)
}

// ─── Ramp definitions ────────────────────────────────────────────────────────

interface RampDef {
  id: string;
  color: string;
  label: string;
  test:   (r: number, g: number, b: number) => boolean;
  key:    (r: number, g: number, b: number) => number;
  limVal: (l: InkLimits) => number;
  isOver: (r: number, g: number, b: number, l: InkLimits) => boolean;
}

// Separation of concerns:
//   Primary C/M/Y limits → fade ONLY the single-ink ramp (no cross-effect).
//   Overprint CM/CY/MY limits → fade ONLY the paired-ink secondary ramp (AND logic).
//
const RAMP_DEFS: RampDef[] = [
  { id: 'C', color: '#22d3ee', label: 'C',
    test:   (_r, g, b) => g === 255 && b === 255,
    key:    (r)         => 255 - r,
    limVal: l => l.C,
    isOver: (r, _g, _b, l) => (255 - r) > l.C },
  { id: 'M', color: '#c084fc', label: 'M',
    test:   (r, _g, b) => r === 255 && b === 255,
    key:    (_r, g)     => 255 - g,
    limVal: l => l.M,
    isOver: (_r, g, _b, l) => (255 - g) > l.M },
  { id: 'Y', color: '#facc15', label: 'Y',
    test:   (r, g, _b) => r === 255 && g === 255,
    key:    (_r, _g, b) => 255 - b,
    limVal: l => l.Y,
    isOver: (_r, _g, b, l) => (255 - b) > l.Y },
  // R ramp: R=255, G=B → M+Y inks co-vary → MY overprint limit, AND logic
  { id: 'R', color: '#ef4444', label: 'R',
    test:   (r, g, b) => r === 255 && g === b,
    key:    (_r, g)    => 255 - g,
    limVal: l => l.MY,
    isOver: (_r, g, b, l) => (255 - g) > l.MY && (255 - b) > l.MY },
  // G ramp: G=255, R=B → C+Y inks co-vary → CY overprint limit, AND logic
  { id: 'G', color: '#4ade80', label: 'G',
    test:   (r, g, b) => g === 255 && r === b,
    key:    (r)        => 255 - r,
    limVal: l => l.CY,
    isOver: (r, _g, b, l) => (255 - r) > l.CY && (255 - b) > l.CY },
  // B ramp: B=255, R=G → C+M inks co-vary → CM overprint limit, AND logic
  { id: 'B', color: '#60a5fa', label: 'B',
    test:   (r, g, b) => b === 255 && r === g,
    key:    (r)        => 255 - r,
    limVal: l => l.CM,
    isOver: (r, g, _b, l) => (255 - r) > l.CM && (255 - g) > l.CM },
];

// ─── a*b* ramp plot ──────────────────────────────────────────────────────────

function AbRampPlot({
  profiles,
  inkLimits,
}: {
  profiles: ProfileData[];
  inkLimits: InkLimits[];
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!svgRef.current) return;

    const W = 480, H = 460;
    const m = { top: 20, right: 110, bottom: 44, left: 44 };
    const iw = W - m.left - m.right;
    const ih = H - m.top - m.bottom;

    const allA: number[] = [];
    const allB: number[] = [];
    profiles.forEach(p => p.clean.forEach(ms => {
      allA.push(ms.LAB_A);
      allB.push(ms.LAB_B);
    }));
    const pad = 6;
    const aExt = d3.extent(allA) as [number, number];
    const bExt = d3.extent(allB) as [number, number];

    const xScale = d3.scaleLinear().domain([aExt[0] - pad, aExt[1] + pad]).range([0, iw]);
    const yScale = d3.scaleLinear().domain([bExt[0] - pad, bExt[1] + pad]).range([ih, 0]);

    const svg = d3.select(svgRef.current);
    svg.selectAll('*').remove();
    svg.attr('width', W).attr('height', H);
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

    // Grid
    g.append('g').call(d3.axisBottom(xScale).ticks(8).tickSize(-ih))
      .attr('transform', `translate(0,${ih})`)
      .call(ax => {
        ax.select('.domain').remove();
        ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2');
        ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10);
      });
    g.append('g').call(d3.axisLeft(yScale).ticks(8).tickSize(-iw))
      .call(ax => {
        ax.select('.domain').remove();
        ax.selectAll('.tick line').attr('stroke', '#374151').attr('stroke-dasharray', '2,2');
        ax.selectAll('.tick text').attr('fill', '#9ca3af').attr('font-size', 10);
      });

    // Zero lines
    const x0 = xScale(0), y0 = yScale(0);
    g.append('line').attr('x1', x0).attr('y1', 0).attr('x2', x0).attr('y2', ih)
      .attr('stroke', '#4b5563').attr('stroke-width', 1);
    g.append('line').attr('x1', 0).attr('y1', y0).attr('x2', iw).attr('y2', y0)
      .attr('stroke', '#4b5563').attr('stroke-width', 1);

    // Ramps for each profile
    profiles.forEach((profile, pi) => {
      const lim = inkLimits[pi] ?? NO_LIMIT;
      const isDashed = pi === 1;
      const sw = pi === 0 ? 2.2 : 1.6;

      RAMP_DEFS.forEach(ramp => {
        const patches = profile.clean
          .filter(ms =>
            ms.RGB_R !== undefined && ms.RGB_G !== undefined && ms.RGB_B !== undefined &&
            ramp.test(ms.RGB_R, ms.RGB_G, ms.RGB_B)
          )
          .sort((a, b) =>
            ramp.key(a.RGB_R!, a.RGB_G!, a.RGB_B!) - ramp.key(b.RGB_R!, b.RGB_G!, b.RGB_B!)
          );

        if (patches.length < 2) return;

        const mkLine = d3.line<typeof patches[0]>()
          .x(d => xScale(d.LAB_A))
          .y(d => yScale(d.LAB_B))
          .curve(d3.curveCatmullRom);

        const isOver = (ms: typeof patches[0]) =>
          ramp.isOver(ms.RGB_R ?? 0, ms.RGB_G ?? 0, ms.RGB_B ?? 0, lim);

        const inLim  = patches.filter(ms => !isOver(ms));
        const beyond = patches.filter(ms =>  isOver(ms));

        if (inLim.length >= 2) {
          g.append('path').datum(inLim)
            .attr('fill', 'none')
            .attr('stroke', ramp.color)
            .attr('stroke-width', sw)
            .attr('stroke-dasharray', isDashed ? '6,3' : 'none')
            .attr('opacity', 0.9)
            .attr('d', mkLine);
        }

        if (beyond.length >= 1) {
          const bridgeData = inLim.length > 0 ? [inLim[inLim.length - 1], ...beyond] : beyond;
          if (bridgeData.length >= 2) {
            g.append('path').datum(bridgeData)
              .attr('fill', 'none')
              .attr('stroke', ramp.color)
              .attr('stroke-width', sw)
              .attr('stroke-dasharray', '2,4')
              .attr('opacity', 0.30)
              .attr('d', mkLine);
          }
        }

        // Markers: paper (0 ink), 50% of limit, at limit
        const limV = ramp.limVal(lim);
        const nearestByVal = (target: number) =>
          patches.reduce((best, ms) => {
            const bv = ramp.key(best.RGB_R!, best.RGB_G!, best.RGB_B!);
            const mv = ramp.key(ms.RGB_R!, ms.RGB_G!, ms.RGB_B!);
            return Math.abs(mv - target) < Math.abs(bv - target) ? ms : best;
          });
        const seen = new Set<typeof patches[0]>();
        [0, limV * 0.5, limV].forEach((target, ti) => {
          const ms = nearestByVal(target);
          if (seen.has(ms)) return;
          seen.add(ms);
          const over = isOver(ms);
          g.append('circle')
            .attr('cx', xScale(ms.LAB_A))
            .attr('cy', yScale(ms.LAB_B))
            .attr('r', ti === 0 ? 3 : 4.5)
            .attr('fill', over ? '#1f2937' : ramp.color)
            .attr('stroke', ramp.color)
            .attr('stroke-width', 1.2)
            .attr('opacity', over ? 0.4 : 0.95);
        });
      });
    });

    // Axis labels
    g.append('text').attr('x', iw / 2).attr('y', ih + 34)
      .attr('text-anchor', 'middle').attr('fill', '#9ca3af').attr('font-size', 11).text('a*');
    g.append('text').attr('transform', `translate(-34, ${ih / 2}) rotate(-90)`)
      .attr('text-anchor', 'middle').attr('fill', '#9ca3af').attr('font-size', 11).text('b*');

    // Legend: ramps
    const leg = svg.append('g').attr('transform', `translate(${W - m.right + 12}, ${m.top + 4})`);
    RAMP_DEFS.forEach((ramp, i) => {
      const y = i * 19;
      leg.append('line').attr('x1', 0).attr('y1', y + 6).attr('x2', 18).attr('y2', y + 6)
        .attr('stroke', ramp.color).attr('stroke-width', 2.2);
      leg.append('text').attr('x', 24).attr('y', y + 10).attr('fill', '#d1d5db').attr('font-size', 11)
        .text(ramp.label);
    });

    if (profiles.length === 2) {
      const yOff = RAMP_DEFS.length * 19 + 14;
      leg.append('text').attr('x', 0).attr('y', yOff).attr('fill', '#6b7280').attr('font-size', 10)
        .text('— P1 (ref)');
      leg.append('text').attr('x', 0).attr('y', yOff + 14).attr('fill', '#6b7280').attr('font-size', 10)
        .text('- - P2 (tgt)');
    }

    // Ink limit cut-off annotation (only when any limit is actually active)
    const anyLimited = inkLimits.some(l => l.C < 255 || l.M < 255 || l.Y < 255 || l.CM < 255 || l.CY < 255 || l.MY < 255);
    if (anyLimited) {
      leg.append('text').attr('x', 0).attr('y', (RAMP_DEFS.length * 19) + (profiles.length === 2 ? 46 : 18))
        .attr('fill', '#6b7280').attr('font-size', 9).text('··· beyond limit');
    }

  }, [profiles, inkLimits]);

  return <svg ref={svgRef} className="block" />;
}

// ─── Ink limit slider row (CMY ink coverage, 0–255) ──────────────────────────
// value = max allowed ink (255 = no restriction, 0 = paper only)

function snapToNearest(v: number, vals: number[]): number {
  if (!vals.length) return v;
  return vals.reduce((best, cur) =>
    Math.abs(cur - v) < Math.abs(best - v) ? cur : best
  );
}

function LimitRow({
  channel,
  color,
  value,
  onChange,
  availableVals,
}: {
  channel: 'C' | 'M' | 'Y' | 'CM' | 'CY' | 'MY';
  color: string;
  value: number;    // max allowed ink: 255 = no restriction
  onChange: (v: number) => void;
  availableVals?: number[];
}) {
  const handleChange = (v: number) => {
    if (v >= 255) { onChange(255); return; } // no restriction — skip snap
    onChange(availableVals?.length ? snapToNearest(v, availableVals) : v);
  };

  return (
    <div className="flex items-center gap-3 mb-2">
      <span className="w-3 text-xs font-bold tabular-nums" style={{ color }}>{channel}</span>
      <input
        type="range" min={0} max={255} step={1} value={value}
        onChange={e => handleChange(+e.target.value)}
        className="flex-1 h-1 appearance-none rounded cursor-pointer"
        style={{ accentColor: color }}
      />
      <input
        type="number" min={0} max={255} value={value}
        onChange={e => handleChange(Math.min(255, Math.max(0, +e.target.value)))}
        className="w-14 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 tabular-nums"
      />
    </div>
  );
}

// ─── Mini result rows ─────────────────────────────────────────────────────────

function MiniResultTable({
  label,
  nPatches,
  comparison,
}: {
  label: string;
  nPatches: number;
  comparison: ReturnType<typeof runXYZModelComparison>;
}) {
  if (!comparison) return null;
  return (
    <div className="mt-3 p-3 rounded-xl bg-gray-950 border border-gray-800">
      <p className="text-xs font-medium text-gray-400 mb-2">
        {label} <span className="text-gray-500">({nPatches} patches)</span>
      </p>
      <table className="w-full text-xs font-mono">
        <tbody>
          {comparison.rows.map((row, i) => {
            const isBest = i === comparison.best_idx;
            const r2Color = row.mean_r2 >= 0.999 ? 'text-emerald-400' : row.mean_r2 >= 0.98 ? 'text-yellow-400' : 'text-red-400';
            return (
              <tr key={i} className={isBest ? '' : 'opacity-60'}>
                <td className="pr-3 py-0.5 text-gray-400 text-xs truncate max-w-[160px]">
                  {isBest && <span className="text-blue-400 mr-1">★</span>}
                  {row.calibration_label.replace('XYZ: ', '')}
                </td>
                <td className={`text-right tabular-nums ${r2Color}`}>R²={row.mean_r2.toFixed(4)}</td>
                <td className="text-right tabular-nums text-gray-500 pl-3">MAE={row.mean_spectral_mae.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── ΔE error table per primary ramp ─────────────────────────────────────────

const RAMP_COLORS: Record<string, string> = { C: '#22d3ee', M: '#c084fc', Y: '#facc15' };

function RampErrorTable({
  label,
  errors,
  threshold,
}: {
  label: string;
  errors: RampErrors;
  threshold: number;
}) {
  const rows = (['C', 'M', 'Y'] as const).map(ch => {
    const pts = errors[ch];
    if (!pts.length) return null;
    const maxDE = Math.max(...pts.map(p => p.de));
    const limit = pts.filter(p => p.de <= threshold);
    const limitInk = limit.length ? limit[limit.length - 1].ink : 0;
    const over = pts.some(p => p.de > threshold);
    return { ch, pts, maxDE, limitInk, over };
  }).filter(Boolean) as Array<{ ch: 'C'|'M'|'Y'; pts: RampPoint[]; maxDE: number; limitInk: number; over: boolean }>;

  if (!rows.length) return null;

  return (
    <div className="mt-2 p-3 rounded-xl bg-gray-950 border border-gray-800 text-xs">
      <p className="font-medium text-gray-400 mb-2">{label} — Neugebauer ΔE per ramp</p>
      <table className="w-full font-mono">
        <thead>
          <tr className="text-gray-600">
            <th className="text-left pr-3">ramp</th>
            <th className="text-right pr-3">limit ink</th>
            <th className="text-right pr-3">max ΔE</th>
            <th className="text-right">status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ch, limitInk, maxDE, over }) => (
            <tr key={ch}>
              <td className="pr-3 py-0.5 font-bold" style={{ color: RAMP_COLORS[ch] }}>{ch}</td>
              <td className="text-right pr-3 tabular-nums text-gray-300">
                {over ? limitInk : '255'} / 255
              </td>
              <td className={`text-right pr-3 tabular-nums ${maxDE > threshold ? 'text-red-400' : 'text-emerald-400'}`}>
                {maxDE.toFixed(2)}
              </td>
              <td className="text-right">
                {over
                  ? <span className="text-yellow-400">overflow at {Math.round(limitInk / 255 * 100)}%</span>
                  : <span className="text-emerald-400">✓ all within</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

interface Props {
  profiles: ProfileData[];
  matchedPatches: MatchedPatchPair[];
  limitsRef: InkLimits;
  setLimitsRef: React.Dispatch<React.SetStateAction<InkLimits>>;
  limitsTarget: InkLimits;
  setLimitsTarget: React.Dispatch<React.SetStateAction<InkLimits>>;
  deThreshold: number;
  setDeThreshold: React.Dispatch<React.SetStateAction<number>>;
}

export default function InkLimitSection({
  profiles,
  matchedPatches,
  limitsRef,
  setLimitsRef,
  limitsTarget,
  setLimitsTarget,
  deThreshold,
  setDeThreshold,
}: Props) {
  const [rampErrors, setRampErrors] = useState<{ ref?: RampErrors; target?: RampErrors }>({});

  const inkLimitsList = profiles.length >= 2
    ? [limitsRef, limitsTarget]
    : [limitsRef];

  const isFiltered =
    limitsRef.C < 255 || limitsRef.M < 255 || limitsRef.Y < 255 ||
    limitsRef.CM < 255 || limitsRef.CY < 255 || limitsRef.MY < 255 ||
    (profiles.length >= 2 && (
      limitsTarget.C < 255 || limitsTarget.M < 255 || limitsTarget.Y < 255 ||
      limitsTarget.CM < 255 || limitsTarget.CY < 255 || limitsTarget.MY < 255
    ));

  // Uses same logic as isOutOfDomain() in RGB-Calibration/domain.ts:
  //   primary limits use simple >, overprint limits use AND (both channels must exceed).
  const filteredPatches = useMemo(() => {
    if (!isFiltered) return matchedPatches;
    return matchedPatches.filter(p => {
      const rC = 255-(p.ref.RGB_R??255), rM = 255-(p.ref.RGB_G??255), rY = 255-(p.ref.RGB_B??255);
      const tC = 255-(p.target.RGB_R??255), tM = 255-(p.target.RGB_G??255), tY = 255-(p.target.RGB_B??255);
      return !isOutOfDomain(rC, rM, rY, limitsRef) && !isOutOfDomain(tC, tM, tY, limitsTarget);
    });
  }, [matchedPatches, limitsRef, limitsTarget, isFiltered]);

  // Rescale filtered patches so limit → 255 (= 100% ink) before model fit.
  // This normalises the ink axis and makes cross-profile comparison fair.
  const scaledForModel = useMemo(() =>
    rescaleMatchedPatches(filteredPatches, limitsRef, limitsTarget),
    [filteredPatches, limitsRef, limitsTarget]
  );

  const xyzFull     = useMemo(() => runXYZModelComparison(matchedPatches), [matchedPatches]);
  const xyzFiltered = useMemo(() => {
    if (!isFiltered || scaledForModel.length < 8) return null;
    return runXYZModelComparison(scaledForModel);
  }, [scaledForModel, isFiltered]);

  const countInRef = useMemo(() => {
    const source = matchedPatches.length > 0
      ? matchedPatches.map(p => p.ref)
      : (profiles[0]?.clean ?? []);
    return source.filter(ms => {
      const C = 255-(ms.RGB_R??255), M = 255-(ms.RGB_G??255), Y = 255-(ms.RGB_B??255);
      return !isOutOfDomain(C, M, Y, limitsRef);
    }).length;
  }, [matchedPatches, profiles, limitsRef]);

  const countInTarget = useMemo(() =>
    matchedPatches.filter(p => {
      const C = 255-(p.target.RGB_R??255), M = 255-(p.target.RGB_G??255), Y = 255-(p.target.RGB_B??255);
      return !isOutOfDomain(C, M, Y, limitsTarget);
    }).length,
    [matchedPatches, limitsTarget]
  );

  // Neugebauer primary patches per profile (from raw data — no outlier removal)
  const neugebauerByProfile = useMemo(() =>
    profiles.map(p => filterNeugebauerPrimaries(p.raw)),
    [profiles]
  );

  // Primary C/M/Y snap: all clean measurements.
  // Overprint CM/CY/MY snap: from raw Neugebauer primaries (same source as primaries table),
  // with fallback to corresponding primary ramp steps when secondary ramp has few patches.
  const availableByChannel = useMemo(() => {
    const sets = {
      C: new Set<number>([255]), M: new Set<number>([255]), Y: new Set<number>([255]),
      CM: new Set<number>([255]), CY: new Set<number>([255]), MY: new Set<number>([255]),
    };
    profiles.forEach(p => {
      p.clean.forEach(ms => {
        if (ms.RGB_R !== undefined) sets.C.add(255 - ms.RGB_R);
        if (ms.RGB_G !== undefined) sets.M.add(255 - ms.RGB_G);
        if (ms.RGB_B !== undefined) sets.Y.add(255 - ms.RGB_B);
      });

      const primaries = filterNeugebauerPrimaries(p.raw);
      primaries.forEach(ms => {
        const r = ms.RGB_R, g = ms.RGB_G, b = ms.RGB_B;
        if (r === undefined || g === undefined || b === undefined) return;
        if (b === 255 && r === g) sets.CM.add(255 - r);   // B ramp (CM overprint)
        if (g === 255 && r === b) sets.CY.add(255 - r);   // G ramp (CY overprint)
        if (r === 255 && g === b) sets.MY.add(255 - g);   // R ramp (MY overprint)
      });

      // Fallback: if secondary ramp has ≤3 snap values (sentinel + ≤2 patches),
      // use the matching primary ramp steps — same ink scale, meaningful AND-logic thresholds.
      //   MY (R ramp: M=Y co-vary) → M primary steps (r=255, b=255, g varies)
      //   CY (G ramp: C=Y co-vary) → C primary steps (g=255, b=255, r varies)
      //   CM (B ramp: C=M co-vary) → C primary steps (same axis)
      if (sets.MY.size <= 3)
        primaries.filter(ms => ms.RGB_R === 255 && ms.RGB_B === 255)
          .forEach(ms => { if (ms.RGB_G !== undefined) sets.MY.add(255 - ms.RGB_G); });
      if (sets.CY.size <= 3)
        primaries.filter(ms => ms.RGB_G === 255 && ms.RGB_B === 255)
          .forEach(ms => { if (ms.RGB_R !== undefined) sets.CY.add(255 - ms.RGB_R); });
      if (sets.CM.size <= 3)
        primaries.filter(ms => ms.RGB_G === 255 && ms.RGB_B === 255)
          .forEach(ms => { if (ms.RGB_R !== undefined) sets.CM.add(255 - ms.RGB_R); });

    });
    const sort = (s: Set<number>) => Array.from(s).sort((a, b) => a - b);
    return { C: sort(sets.C), M: sort(sets.M), Y: sort(sets.Y), CM: sort(sets.CM), CY: sort(sets.CY), MY: sort(sets.MY) };
  }, [profiles]);

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-2xl p-6">
      <div className="mb-5">
        <h3 className="text-sm font-semibold text-gray-300">
          Neugebauer primaries — a*b* ramps &amp; ink limit
        </h3>
        <p className="text-xs text-gray-500 mt-1">
          Ink ramps 0→100% in a*b* space. Hue shift visible as curve bend — ink overflow zone
          breaks Neugebauer linearity. Set CMY limits to exclude overflow from model calibration.
        </p>
      </div>

      <div className="flex flex-wrap gap-6 items-start">
        {/* a*b* plot */}
        <div className="shrink-0">
          <AbRampPlot profiles={profiles} inkLimits={inkLimitsList} />
        </div>

        {/* Controls + results */}
        <div className="flex-1 min-w-[260px] space-y-6">
          {/* Limit sliders — ref profile */}
          <div>
            <p className="text-xs font-semibold text-gray-400 mb-1">
              {profiles.length >= 2 ? 'Reference' : 'Ink limit'}:{' '}
              <span className="text-gray-300 font-normal">{profiles[0]?.metadata.substrate}</span>
            </p>
            <p className="text-xs text-gray-600 mb-3">max C/M/Y ink (255 = no restriction)</p>
            <LimitRow channel="C" color="#22d3ee" value={limitsRef.C}
              onChange={v => setLimitsRef(p => ({ ...p, C: v }))}
              availableVals={availableByChannel.C} />
            <LimitRow channel="M" color="#c084fc" value={limitsRef.M}
              onChange={v => setLimitsRef(p => ({ ...p, M: v }))}
              availableVals={availableByChannel.M} />
            <LimitRow channel="Y" color="#facc15" value={limitsRef.Y}
              onChange={v => setLimitsRef(p => ({ ...p, Y: v }))}
              availableVals={availableByChannel.Y} />
            <p className="text-xs text-gray-700 mt-3 mb-1">Overprint limits (R/G/B ramps)</p>
            <LimitRow channel="MY" color="#ef4444" value={limitsRef.MY}
              onChange={v => setLimitsRef(p => ({ ...p, MY: v }))}
              availableVals={availableByChannel.MY} />
            <LimitRow channel="CY" color="#4ade80" value={limitsRef.CY}
              onChange={v => setLimitsRef(p => ({ ...p, CY: v }))}
              availableVals={availableByChannel.CY} />
            <LimitRow channel="CM" color="#60a5fa" value={limitsRef.CM}
              onChange={v => setLimitsRef(p => ({ ...p, CM: v }))}
              availableVals={availableByChannel.CM} />
            <p className="text-xs text-gray-600 mt-1">
              Patches within limit: <span className="text-gray-400">{countInRef}</span> / {matchedPatches.length > 0 ? matchedPatches.length : (profiles[0]?.clean.length ?? 0)}
            </p>
            <button
              onClick={() => {
                const patches = neugebauerByProfile[0];
                const cgats = buildCGATS(patches, profiles[0]);
                downloadCGATS(cgats, `${profiles[0].metadata.substrate}_neugebauer.txt`);
              }}
              className="mt-2 text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-cyan-400 hover:text-cyan-300 rounded border border-gray-700 transition-colors"
            >
              ↓ Primaries CGATS ({neugebauerByProfile[0]?.length ?? 0} patches)
            </button>
          </div>

          {/* Limit sliders — target profile */}
          {profiles.length >= 2 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 mb-1">
                Target:{' '}
                <span className="text-gray-300 font-normal">{profiles[1].metadata.substrate}</span>
              </p>
              <p className="text-xs text-gray-600 mb-3">max C/M/Y ink (255 = no restriction)</p>
              <LimitRow channel="C" color="#22d3ee" value={limitsTarget.C}
                onChange={v => setLimitsTarget(p => ({ ...p, C: v }))}
                availableVals={availableByChannel.C} />
              <LimitRow channel="M" color="#c084fc" value={limitsTarget.M}
                onChange={v => setLimitsTarget(p => ({ ...p, M: v }))}
                availableVals={availableByChannel.M} />
              <LimitRow channel="Y" color="#facc15" value={limitsTarget.Y}
                onChange={v => setLimitsTarget(p => ({ ...p, Y: v }))}
                availableVals={availableByChannel.Y} />
              <p className="text-xs text-gray-700 mt-3 mb-1">Overprint limits (R/G/B ramps)</p>
              <LimitRow channel="MY" color="#ef4444" value={limitsTarget.MY}
                onChange={v => setLimitsTarget(p => ({ ...p, MY: v }))}
                availableVals={availableByChannel.MY} />
              <LimitRow channel="CY" color="#4ade80" value={limitsTarget.CY}
                onChange={v => setLimitsTarget(p => ({ ...p, CY: v }))}
                availableVals={availableByChannel.CY} />
              <LimitRow channel="CM" color="#60a5fa" value={limitsTarget.CM}
                onChange={v => setLimitsTarget(p => ({ ...p, CM: v }))}
                availableVals={availableByChannel.CM} />
              <p className="text-xs text-gray-600 mt-1">
                Patches within limit: <span className="text-gray-400">{countInTarget}</span> / {matchedPatches.length}
              </p>

              <button
                onClick={() => {
                  const patches = neugebauerByProfile[1];
                  const cgats = buildCGATS(patches, profiles[1]);
                  downloadCGATS(cgats, `${profiles[1].metadata.substrate}_neugebauer.txt`);
                }}
                className="mt-2 text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-cyan-400 hover:text-cyan-300 rounded border border-gray-700 transition-colors"
              >
                ↓ Primaries CGATS ({neugebauerByProfile[1]?.length ?? 0} patches)
              </button>
            </div>
          )}

          {/* Auto-detect + reset */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-500">ΔE threshold:</span>
              <input
                type="number" min={0.5} max={10} step={0.5} value={deThreshold}
                onChange={e => setDeThreshold(Math.max(0.5, +e.target.value))}
                className="w-16 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
              />
            </div>
            <div className="flex gap-2 flex-wrap">
              <button
                onClick={() => {
                  const refResult = autoDetectLimits(profiles[0], deThreshold);
                  setRampErrors(prev => ({ ...prev, ref: refResult.errors }));
                  setLimitsRef(p => ({ ...p, ...refResult.limits }));
                  if (profiles.length >= 2) {
                    const tgtResult = autoDetectLimits(profiles[1], deThreshold);
                    setRampErrors(prev => ({ ...prev, target: tgtResult.errors }));
                    setLimitsTarget(p => ({ ...p, ...tgtResult.limits }));
                  }
                }}
                className="text-xs px-3 py-1 bg-blue-900 hover:bg-blue-800 text-blue-300 rounded border border-blue-700 transition-colors"
              >
                Auto-detect limits
              </button>
              {isFiltered && (
                <button
                  onClick={() => { setLimitsRef(NO_LIMIT); setLimitsTarget(NO_LIMIT); setRampErrors({}); }}
                  className="text-xs px-3 py-1 bg-gray-800 hover:bg-gray-700 text-gray-400 rounded border border-gray-700 transition-colors"
                >
                  Reset
                </button>
              )}
            </div>
          </div>

          {/* ΔE tables per primary ramp */}
          {rampErrors.ref && (
            <RampErrorTable label={profiles[0]?.metadata.substrate ?? 'Ref'} errors={rampErrors.ref} threshold={deThreshold} />
          )}
          {rampErrors.target && (
            <RampErrorTable label={profiles[1]?.metadata.substrate ?? 'Target'} errors={rampErrors.target} threshold={deThreshold} />
          )}

          {/* Model results */}
          {matchedPatches.length >= 8 && (
            <MiniResultTable
              label="XYZ model — full (no limit)"
              nPatches={matchedPatches.length}
              comparison={xyzFull}
            />
          )}

          {isFiltered && filteredPatches.length >= 8 && (
            <MiniResultTable
              label="XYZ model — within ink limit"
              nPatches={filteredPatches.length}
              comparison={xyzFiltered}
            />
          )}

          {isFiltered && matchedPatches.length >= 8 && filteredPatches.length < 8 && (
            <p className="text-xs text-red-400">
              Only {filteredPatches.length} patches within limit — loosen limits for model fit.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
