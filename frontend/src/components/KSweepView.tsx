// src/components/KSweepView.tsx
// k-sweep experiment UI: launch a Web Worker to run the sweep over all loaded
// profiles, then visualise pass-fraction and median-of-medians vs k.

import { useRef, useState, useEffect } from 'react'
import * as d3 from 'd3'
import type { ProfileData } from '../types'
import type {
  KSweepPredictor,
  AnchorStrategy,
  PairSlice,
  KSweepRow,
  KSweepResult,
} from '../lib/experiments/kSweep'

interface Props {
  profiles: ProfileData[]
}

const DEFAULT_K_GRID = [3, 5, 8, 13, 20, 30]
const MEDIAN_GATE = 1.5
const P95_GATE = 3.0
const PASS_GATE = 0.8

// Line colours per (predictor, strategy) combo.
const LINE_COLORS: Record<string, string> = {
  'D1|greedy': '#60a5fa',    // blue
  'D1|dOptimal': '#93c5fd',  // light-blue
  'C7|greedy': '#f97316',    // orange
  'C7|dOptimal': '#fb923c',  // light-orange
}
const LINE_DASHES: Record<string, string> = {
  greedy: 'none',
  dOptimal: '6,4',
}

type RunState = 'idle' | 'running' | 'done' | 'error'

export default function KSweepView({ profiles }: Props) {
  // Controls
  const [predictors, setPredictors] = useState<KSweepPredictor[]>(['D1', 'C7'])
  const [strategies, setStrategies] = useState<AnchorStrategy[]>(['greedy', 'dOptimal'])
  const [slice, setSlice] = useState<PairSlice | 'both'>('both')
  const [maxPairs, setMaxPairs] = useState(60)

  // Run state
  const [runState, setRunState] = useState<RunState>('idle')
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState<KSweepResult | null>(null)
  const [errorMsg, setErrorMsg] = useState('')
  const workerRef = useRef<Worker | null>(null)

  // D3 chart refs
  const passChartRef = useRef<SVGSVGElement>(null)
  const medianChartRef = useRef<SVGSVGElement>(null)

  const startRun = () => {
    if (profiles.length < 2) return
    workerRef.current?.terminate()
    setRunState('running')
    setProgress({ done: 0, total: 0 })
    setResult(null)
    setErrorMsg('')

    const worker = new Worker(
      new URL('../lib/experiments/kSweep.worker.ts', import.meta.url),
      { type: 'module' },
    )
    workerRef.current = worker

    worker.onmessage = (e) => {
      const msg = e.data
      if (msg.type === 'progress') {
        setProgress({ done: msg.done, total: msg.total })
      } else if (msg.type === 'done') {
        setRunState('done')
        setResult(msg.result)
        worker.terminate()
      } else if (msg.type === 'error') {
        setRunState('error')
        setErrorMsg(msg.message)
        worker.terminate()
      }
    }
    worker.onerror = (e) => {
      setRunState('error')
      setErrorMsg(e.message ?? 'Worker error')
      worker.terminate()
    }

    worker.postMessage({
      type: 'start',
      profiles,
      opts: {
        predictors,
        anchorStrategies: strategies,
        kGrid: DEFAULT_K_GRID,
        maxPairsPerSlice: maxPairs,
        medianGate: MEDIAN_GATE,
        p95Gate: P95_GATE,
        passGate: PASS_GATE,
      },
    })
  }

  const stopRun = () => {
    workerRef.current?.terminate()
    setRunState('idle')
  }

  // Cleanup on unmount
  useEffect(() => () => { workerRef.current?.terminate() }, [])

  // Draw charts when result changes
  useEffect(() => {
    if (!result || !passChartRef.current || !medianChartRef.current) return

    const slicesShown: PairSlice[] =
      slice === 'both' ? ['same-mode', 'cross-mode'] : [slice]

    const rows = result.perK.filter(r => slicesShown.includes(r.slice))

    drawLineChart({
      svgEl: passChartRef.current,
      rows,
      yAccessor: r => r.passFraction,
      yLabel: 'Pass fraction (H4)',
      yDomain: [0, 1],
      refLine: { value: PASS_GATE, label: `${PASS_GATE * 100}% gate` },
      slicesShown,
    })

    drawLineChart({
      svgEl: medianChartRef.current,
      rows,
      yAccessor: r => r.medianOfMedians,
      yLabel: 'Median of medians ΔE00',
      yDomain: [0, d3.max(rows, r => r.medianOfMedians) ?? 5],
      refLine: { value: MEDIAN_GATE, label: `${MEDIAN_GATE} gate` },
      slicesShown,
    })
  }, [result, slice])

  const canRun = profiles.length >= 2 && runState !== 'running'

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">k-Sweep: min patches to meet H4</h2>
      <p className="text-sm text-gray-400">
        For each profile pair, runs greedy (worst-patch) and D-optimal (SVD-based) anchor
        selection. Measures pass-fraction and median ΔE00 across k ∈{' '}
        {DEFAULT_K_GRID.join(', ')}. H4 gate: median ≤ {MEDIAN_GATE} AND P95 ≤ {P95_GATE}; ≥{' '}
        {PASS_GATE * 100}% of pairs must pass.
      </p>

      {/* Controls */}
      <div className="flex flex-wrap gap-6 bg-gray-900 rounded-lg p-4 text-sm">
        {/* Predictors */}
        <fieldset>
          <legend className="text-gray-400 mb-1">Predictors</legend>
          {(['D1', 'C7'] as KSweepPredictor[]).map(p => (
            <label key={p} className="flex items-center gap-1.5 mr-3 inline-flex">
              <input
                type="checkbox"
                checked={predictors.includes(p)}
                onChange={e =>
                  setPredictors(prev =>
                    e.target.checked ? [...prev, p] : prev.filter(x => x !== p),
                  )
                }
              />
              {p}
            </label>
          ))}
        </fieldset>

        {/* Strategies */}
        <fieldset>
          <legend className="text-gray-400 mb-1">Anchor strategy</legend>
          {(['greedy', 'dOptimal'] as AnchorStrategy[]).map(s => (
            <label key={s} className="flex items-center gap-1.5 mr-3 inline-flex">
              <input
                type="checkbox"
                checked={strategies.includes(s)}
                onChange={e =>
                  setStrategies(prev =>
                    e.target.checked ? [...prev, s] : prev.filter(x => x !== s),
                  )
                }
              />
              {s === 'greedy' ? 'Greedy (worst-patch)' : 'D-optimal (SVD)'}
            </label>
          ))}
        </fieldset>

        {/* Slice */}
        <fieldset>
          <legend className="text-gray-400 mb-1">Slice</legend>
          {(['both', 'same-mode', 'cross-mode'] as const).map(s => (
            <label key={s} className="flex items-center gap-1.5 mr-3 inline-flex">
              <input type="radio" name="slice" checked={slice === s} onChange={() => setSlice(s)} />
              {s}
            </label>
          ))}
        </fieldset>

        {/* Max pairs */}
        <fieldset>
          <legend className="text-gray-400 mb-1">Max pairs / slice</legend>
          <input
            type="number"
            min={2}
            max={702}
            value={maxPairs}
            onChange={e => setMaxPairs(Number(e.target.value))}
            className="w-20 bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-center"
          />
        </fieldset>

        {/* Run / Stop */}
        <div className="flex items-end gap-2">
          <button
            onClick={startRun}
            disabled={!canRun}
            className="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:bg-gray-700 rounded font-medium"
          >
            Run
          </button>
          {runState === 'running' && (
            <button
              onClick={stopRun}
              className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 rounded"
            >
              Stop
            </button>
          )}
        </div>
      </div>

      {/* Progress */}
      {runState === 'running' && (
        <div className="space-y-1">
          <div className="text-sm text-gray-400">
            Processing pairs: {progress.done} / {progress.total || '…'}
          </div>
          {progress.total > 0 && (
            <div className="h-2 bg-gray-800 rounded overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all"
                style={{ width: `${(progress.done / progress.total) * 100}%` }}
              />
            </div>
          )}
        </div>
      )}

      {runState === 'error' && (
        <div className="p-3 bg-red-950 border border-red-800 rounded text-red-300 text-sm">
          Error: {errorMsg}
        </div>
      )}

      {/* Charts */}
      {result && (
        <div className="space-y-8">
          <div className="bg-gray-900 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">
              Pass-fraction vs k (H4 gate: median ≤ {MEDIAN_GATE} AND P95 ≤ {P95_GATE})
            </h3>
            <svg ref={passChartRef} className="w-full" />
          </div>

          <div className="bg-gray-900 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-300 mb-2">
              Median-of-medians ΔE00 vs k
            </h3>
            <svg ref={medianChartRef} className="w-full" />
          </div>

          {/* Summary table */}
          <MinKTable result={result} slice={slice} />

          {/* CSV export */}
          <button
            onClick={() => exportCsv(result)}
            className="text-sm px-3 py-1.5 bg-gray-800 hover:bg-gray-700 rounded"
          >
            Export CSV
          </button>
        </div>
      )}
    </div>
  )
}

// ─── D3 line chart ────────────────────────────────────────────────────────────

interface ChartOpts {
  svgEl: SVGSVGElement
  rows: KSweepRow[]
  yAccessor: (r: KSweepRow) => number
  yLabel: string
  yDomain: [number, number]
  refLine: { value: number; label: string }
  slicesShown: PairSlice[]
}

function drawLineChart(opts: ChartOpts) {
  const { svgEl, rows, yAccessor, yLabel, yDomain, refLine, slicesShown } = opts

  const W = svgEl.clientWidth || 600
  const H = 280
  const margin = { top: 20, right: 160, bottom: 40, left: 52 }
  const innerW = W - margin.left - margin.right
  const innerH = H - margin.top - margin.bottom

  d3.select(svgEl).selectAll('*').remove()
  const svg = d3.select(svgEl)
    .attr('viewBox', `0 0 ${W} ${H}`)
    .attr('height', H)

  const g = svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`)

  const allKs = [...new Set(rows.map(r => r.k))].sort((a, b) => a - b)

  const xScale = d3.scaleLinear().domain([allKs[0] ?? 0, allKs[allKs.length - 1] ?? 30])
    .range([0, innerW])
  const yScale = d3.scaleLinear().domain(yDomain).range([innerH, 0]).clamp(true)

  // Axes
  g.append('g').attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).tickValues(allKs))
    .selectAll('text').style('fill', '#9ca3af').style('font-size', '11px')
  g.append('g').call(d3.axisLeft(yScale).ticks(5))
    .selectAll('text').style('fill', '#9ca3af').style('font-size', '11px')

  // Grid
  g.append('g').attr('class', 'grid').call(
    d3.axisLeft(yScale).ticks(5).tickSize(-innerW).tickFormat(() => ''),
  ).selectAll('line').style('stroke', '#374151').style('stroke-dasharray', '3,3')
  g.select('.grid .domain').remove()

  // Axis labels
  g.append('text').attr('x', innerW / 2).attr('y', innerH + 34)
    .attr('text-anchor', 'middle').style('fill', '#9ca3af').style('font-size', '11px')
    .text('k (anchors)')
  g.append('text').attr('transform', 'rotate(-90)')
    .attr('x', -innerH / 2).attr('y', -40)
    .attr('text-anchor', 'middle').style('fill', '#9ca3af').style('font-size', '11px')
    .text(yLabel)

  // Reference line
  g.append('line')
    .attr('x1', 0).attr('x2', innerW)
    .attr('y1', yScale(refLine.value)).attr('y2', yScale(refLine.value))
    .style('stroke', '#6b7280').style('stroke-dasharray', '8,4').style('stroke-width', 1)
  g.append('text').attr('x', innerW + 4).attr('y', yScale(refLine.value) + 4)
    .style('fill', '#6b7280').style('font-size', '10px').text(refLine.label)

  // Group rows by (predictor, strategy, slice)
  type LineKey = string
  const grouped = new Map<LineKey, KSweepRow[]>()
  for (const row of rows) {
    const key = `${row.predictor}|${row.anchorStrategy}|${row.slice}`
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key)!.push(row)
  }

  const lineGen = d3.line<KSweepRow>()
    .x(r => xScale(r.k))
    .y(r => yScale(yAccessor(r)))
    .defined(r => !isNaN(yAccessor(r)))

  const legendItems: { label: string; color: string; dash: string }[] = []

  for (const [key, lineRows] of grouped) {
    const [pred, strat, ls] = key.split('|') as [KSweepPredictor, AnchorStrategy, PairSlice]
    if (!slicesShown.includes(ls)) continue
    const color = LINE_COLORS[`${pred}|${strat}`] ?? '#ffffff'
    const dash = LINE_DASHES[strat] ?? 'none'
    const sorted = lineRows.slice().sort((a, b) => a.k - b.k)

    g.append('path')
      .datum(sorted)
      .attr('fill', 'none')
      .attr('stroke', color)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', dash)
      .attr('d', lineGen)

    // Dots — selectAll(null) so the pipe chars in key never hit the CSS parser.
    g.selectAll(null)
      .data(sorted)
      .join('circle')
      .attr('cx', r => xScale(r.k))
      .attr('cy', r => yScale(yAccessor(r)))
      .attr('r', 3)
      .attr('fill', color)

    legendItems.push({
      label: `${pred} ${strat} ${ls === 'same-mode' ? 'S' : 'X'}`,
      color,
      dash,
    })
  }

  // Legend
  const leg = g.append('g').attr('transform', `translate(${innerW + 10},0)`)
  legendItems.forEach((item, i) => {
    const gy = leg.append('g').attr('transform', `translate(0,${i * 18})`)
    gy.append('line').attr('x1', 0).attr('x2', 20).attr('y1', 6).attr('y2', 6)
      .attr('stroke', item.color).attr('stroke-width', 2)
      .attr('stroke-dasharray', item.dash)
    gy.append('text').attr('x', 24).attr('y', 10)
      .style('fill', '#d1d5db').style('font-size', '10px').text(item.label)
  })
}

// ─── Summary table ────────────────────────────────────────────────────────────

function MinKTable({
  result,
  slice,
}: {
  result: KSweepResult
  slice: PairSlice | 'both'
}) {
  const slicesShown: PairSlice[] =
    slice === 'both' ? ['same-mode', 'cross-mode'] : [slice]

  const entries = result.minKToPass.filter(m => slicesShown.includes(m.slice))
  if (entries.length === 0) return null

  return (
    <div className="bg-gray-900 rounded-lg p-4 overflow-auto">
      <h3 className="text-sm font-medium text-gray-300 mb-3">
        Min k for ≥{PASS_GATE * 100}% pairs to pass H4 gate
      </h3>
      <table className="text-sm w-full">
        <thead>
          <tr className="text-gray-400 border-b border-gray-700">
            <th className="text-left pb-1 pr-4">Predictor</th>
            <th className="text-left pb-1 pr-4">Strategy</th>
            <th className="text-left pb-1 pr-4">Slice</th>
            <th className="text-right pb-1">Min k</th>
            <th className="text-right pb-1 pl-4">Best pass% at max k</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((m, i) => {
            const bestRow = result.perK
              .filter(r => r.predictor === m.predictor && r.anchorStrategy === m.anchorStrategy && r.slice === m.slice)
              .sort((a, b) => b.k - a.k)[0]
            return (
              <tr key={i} className="border-b border-gray-800">
                <td className="py-1 pr-4">{m.predictor}</td>
                <td className="py-1 pr-4 text-gray-300">{m.anchorStrategy}</td>
                <td className="py-1 pr-4 text-gray-300">{m.slice}</td>
                <td className="py-1 text-right">
                  {m.k === null ? (
                    <span className="text-red-400">—</span>
                  ) : (
                    <span className="text-green-400 font-semibold">{m.k}</span>
                  )}
                </td>
                <td className="py-1 text-right pl-4 text-gray-300">
                  {bestRow ? `${(bestRow.passFraction * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── CSV export ───────────────────────────────────────────────────────────────

function exportCsv(result: KSweepResult) {
  const header = 'predictor,anchorStrategy,slice,k,medianOfMedians,p95OfMedians,passFraction,nPairs'
  const rows = result.perK.map(r =>
    [r.predictor, r.anchorStrategy, r.slice, r.k,
     r.medianOfMedians.toFixed(4), r.p95OfMedians.toFixed(4),
     r.passFraction.toFixed(4), r.nPairs].join(','),
  )
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'ksweep.csv'
  a.click()
  URL.revokeObjectURL(url)
}
