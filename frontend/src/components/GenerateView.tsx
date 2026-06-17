/**
 * GenerateView — production UI for few-patch substrate dataset generation.
 *
 * Workflow:
 *   1. Select 1+ reference profiles (same print mode).
 *   2. Choose coverage chart tier (k=6/8/12).
 *   3. Print the displayed patch targets on the new substrate.
 *   4. Measure with a spectrophotometer; export as CGATS.17.
 *   5. Upload the anchor CGATS — matched patches are highlighted green.
 *   6. A biasWarning banner appears (ok / hue-sat-bias).
 *   7. Click "Generate" → D1 or pool-PCA prediction runs (~100 ms).
 *   8. Click "Export CGATS" to download the predicted 905-patch dataset.
 *
 * No experiment code — this is the production entry point.
 */

import { useState, useMemo } from 'react'
import type { ProfileData } from '../types'
import { canonicalPrintMode } from '../utils/printMode'
import { generateDataset } from '../lib/core/generateDataset'
import { computeBiasWarning } from '../lib/core/biasWarning'
import { downloadDatasetCGATS } from '../lib/core/cgatsDataset'
import { loadMultipleProfiles } from '../lib/dataLoader'
import type { AnchorMeasurement, GenerateDatasetResult } from '../lib/core/generateDataset'
import type { BiasWarning } from '../lib/core/biasWarning'

// --------------------------------------------------------------------------
// Coverage chart patch targets per tier
// --------------------------------------------------------------------------

const COV6_TARGETS: Array<[number, number, number]> = [
  [255, 255, 255], // paper white
  [0, 255, 255],   // cyan
  [255, 0, 255],   // magenta
  [255, 255, 0],   // yellow
  [0, 0, 0],       // black
  [128, 128, 128], // neutral gray
]
const COV8N_TARGETS: Array<[number, number, number]> = [
  ...COV6_TARGETS,
  [64, 64, 64],    // dark gray
  [192, 192, 192], // light gray
]
const COVERAGE_TARGETS: Record<6 | 8 | 12, Array<[number, number, number]>> = {
  6: COV6_TARGETS,
  8: COV8N_TARGETS,
  12: [
    ...COV8N_TARGETS,
    [255, 0, 0],     // red (secondary)
    [0, 255, 0],     // green (secondary)
    [0, 0, 255],     // blue (secondary)
    [255, 128, 128], // light red
  ],
}

const TARGET_LABEL: Record<string, string> = {
  '255,255,255': 'Paper white',
  '0,255,255':   'Cyan',
  '255,0,255':   'Magenta',
  '255,255,0':   'Yellow',
  '0,0,0':       'Black',
  '128,128,128': 'Gray 50%',
  '64,64,64':    'Gray 25%',
  '192,192,192': 'Gray 75%',
  '255,0,0':     'Red',
  '0,255,0':     'Green',
  '0,0,255':     'Blue',
  '255,128,128': 'Light Red',
}

function targetKey(t: [number, number, number]): string {
  return t.join(',')
}
function targetLabel(t: [number, number, number]): string {
  return TARGET_LABEL[targetKey(t)] ?? `RGB(${t[0]},${t[1]},${t[2]})`
}

// --------------------------------------------------------------------------
// Minimal CGATS.17 parser — extracts RGB + spectral columns
// --------------------------------------------------------------------------

function parseCGATSAnchors(text: string): AnchorMeasurement[] {
  const lines = text.split(/\r?\n/)
  let inFormat = false
  let inData = false
  const fields: string[] = []
  const anchors: AnchorMeasurement[] = []

  for (const raw of lines) {
    const line = raw.trim()
    if (line === 'BEGIN_DATA_FORMAT') { inFormat = true; continue }
    if (line === 'END_DATA_FORMAT') { inFormat = false; continue }
    if (line === 'BEGIN_DATA') { inData = true; continue }
    if (line === 'END_DATA') { inData = false; continue }

    if (inFormat && line) {
      fields.push(...line.split(/\s+/).filter(Boolean))
      continue
    }

    if (inData && line) {
      const cols = line.split(/\t| {2,}/).filter(Boolean)
      if (cols.length < fields.length) continue

      const get = (name: string): number | undefined => {
        const i = fields.indexOf(name)
        return i >= 0 ? parseFloat(cols[i]) : undefined
      }

      let r = get('RGB_R'), g = get('RGB_G'), b = get('RGB_B')
      if (r === undefined || g === undefined || b === undefined) continue
      r = Math.round(r); g = Math.round(g); b = Math.round(b)

      // Extract spectral bands 380–730nm (36 bands, 10nm step)
      const spectrum: number[] = []
      for (let wl = 380; wl <= 730; wl += 10) {
        const v = get(`SPECTRAL_NM_${wl}`)
        if (v === undefined) break
        // CGATS stores 0–100%; normalise to 0–1
        spectrum.push(v > 1 ? v / 100 : v)
      }
      if (spectrum.length !== 36) continue

      anchors.push({ device: [r, g, b], spectrum })
    }
  }
  return anchors
}

// --------------------------------------------------------------------------
// Small UI atoms
// --------------------------------------------------------------------------

function Badge({ color, children }: { color: 'green' | 'gray' | 'yellow' | 'red'; children: React.ReactNode }) {
  const cls: Record<string, string> = {
    green:  'bg-green-900/60 text-green-300 border border-green-700',
    gray:   'bg-gray-800 text-gray-400 border border-gray-700',
    yellow: 'bg-yellow-900/60 text-yellow-300 border border-yellow-700',
    red:    'bg-red-900/60 text-red-300 border border-red-700',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono ${cls[color]}`}>
      {children}
    </span>
  )
}

function BiasWarningBanner({ warning }: { warning: BiasWarning }) {
  if (warning.level === 'ok') {
    return (
      <div className="rounded-lg border border-green-700 bg-green-900/30 p-4 text-sm text-green-200">
        <span className="font-semibold mr-2">✓ Compatible</span>
        {warning.message}
      </div>
    )
  }
  const isIncompat = warning.level === 'incompatible'
  return (
    <div className={`rounded-lg border p-4 text-sm ${
      isIncompat
        ? 'border-red-700 bg-red-900/30 text-red-200'
        : 'border-yellow-600 bg-yellow-900/30 text-yellow-200'
    }`}>
      <div className="font-semibold mb-1">
        {isIncompat ? '✗ Incompatible substrates' : '⚠ Hue/Saturation Bias risk'}
      </div>
      <p>{warning.message}</p>
      {warning.recommendedReference && (
        <p className="mt-2 text-xs opacity-80">
          Recommended reference: <span className="font-mono">{warning.recommendedReference}</span>
        </p>
      )}
    </div>
  )
}

// --------------------------------------------------------------------------
// Main component
// --------------------------------------------------------------------------

interface Props {
  profiles: ProfileData[]
}

type ChartK = 6 | 8 | 12

export default function GenerateView({ profiles }: Props) {
  const [selectedRefs, setSelectedRefs] = useState<string[]>([])
  const [chartK, setChartK] = useState<ChartK>(6)
  const [anchors, setAnchors] = useState<AnchorMeasurement[]>([])
  const [anchorError, setAnchorError] = useState<string | null>(null)
  const [targetName, setTargetName] = useState('NewSubstrate')
  const [result, setResult] = useState<GenerateDatasetResult | null>(null)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)
  // Profiles loaded directly in this view (ICM/ICC/CxF) — not via sidebar
  const [localRefs, setLocalRefs] = useState<ProfileData[]>([])
  const [refLoadError, setRefLoadError] = useState<string | null>(null)
  const [refLoading, setRefLoading] = useState(false)

  // Combined pool: sidebar + locally loaded
  const allProfiles = useMemo(() => {
    const seen = new Set<string>()
    const out: ProfileData[] = []
    for (const p of [...profiles, ...localRefs]) {
      if (!seen.has(p.metadata.full_name)) {
        seen.add(p.metadata.full_name)
        out.push(p)
      }
    }
    return out
  }, [profiles, localRefs])

  // Group by print mode (accept all profiles, group "unknown" separately)
  const profilesByMode = useMemo(() => {
    const map = new Map<string, ProfileData[]>()
    for (const p of allProfiles) {
      let mode: string
      try { mode = canonicalPrintMode(p.metadata) } catch { mode = '(unknown mode)' }
      const arr = map.get(mode) ?? []
      arr.push(p)
      map.set(mode, arr)
    }
    return map
  }, [allProfiles])

  const refProfiles = useMemo(
    () => selectedRefs.map((n) => allProfiles.find((p) => p.metadata.full_name === n)!).filter(Boolean),
    [selectedRefs, allProfiles],
  )

  // Handle direct ICM/ICC/CxF upload in ref section
  async function handleRefFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
    if (!files.length) return
    setRefLoadError(null)
    setRefLoading(true)
    e.target.value = ''
    try {
      const loaded = await loadMultipleProfiles(files)
      if (!loaded.length) throw new Error('No profiles loaded — check file format (ICM/ICC/CxF)')
      setLocalRefs((prev) => {
        const seen = new Set(prev.map((p) => p.metadata.full_name))
        return [...prev, ...loaded.filter((p) => !seen.has(p.metadata.full_name))]
      })
      // Auto-select newly loaded profiles
      setSelectedRefs((prev) => {
        const cur = new Set(prev)
        for (const p of loaded) cur.add(p.metadata.full_name)
        return Array.from(cur)
      })
    } catch (err) {
      setRefLoadError(err instanceof Error ? err.message : 'Load error')
    } finally {
      setRefLoading(false)
    }
  }

  // Check anchor coverage
  const targets = COVERAGE_TARGETS[chartK]
  const matchedKeys = useMemo(() => {
    const matched = new Set<string>()
    for (const t of targets) {
      const key = targetKey(t)
      const found = anchors.some(
        (a) => a.device[0] === t[0] && a.device[1] === t[1] && a.device[2] === t[2],
      )
      if (found) matched.add(key)
    }
    return matched
  }, [anchors, targets])

  const allMatched = matchedKeys.size >= Math.min(targets.length, chartK)
  const canGenerate = refProfiles.length >= 1 && allMatched && !generating

  // biasWarning: compute when refs + anchors present (lazy, on generation readiness)
  const biasWarning = useMemo<BiasWarning | null>(() => {
    if (!refProfiles.length || anchors.length < 3) return null
    try {
      return computeBiasWarning({ refs: refProfiles, targetAnchors: anchors })
    } catch { return null }
  }, [refProfiles, anchors])

  // Toggle ref selection
  function toggleRef(name: string) {
    setSelectedRefs((prev) =>
      prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
    )
    setResult(null)
  }

  // Handle CGATS file upload
  async function handleAnchorFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    setAnchorError(null)
    setResult(null)
    try {
      const text = await file.text()
      const parsed = parseCGATSAnchors(text)
      if (!parsed.length) throw new Error('No valid rows found — check CGATS format (needs RGB_R/G/B + SPECTRAL_NM_380…730)')
      setAnchors(parsed)
    } catch (err) {
      setAnchorError(err instanceof Error ? err.message : 'Parse error')
      setAnchors([])
    }
    e.target.value = ''
  }

  // Handle Generate
  function handleGenerate() {
    if (!canGenerate) return
    setGenerating(true)
    setGenError(null)
    setResult(null)
    setTimeout(() => {
      try {
        const r = generateDataset({ refs: refProfiles, anchors, chartK, targetName })
        setResult(r)
      } catch (err) {
        setGenError(err instanceof Error ? err.message : 'Generation failed')
      } finally {
        setGenerating(false)
      }
    }, 0)
  }

  // Handle Export
  function handleExport() {
    if (!result) return
    downloadDatasetCGATS(result, {
      targetName,
      refName: refProfiles.map((r) => r.metadata.full_name).join(', '),
      markAnchors: true,
    })
  }

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h2 className="text-xl font-semibold mb-1">Generate Substrate Dataset</h2>
        <p className="text-sm text-gray-400">
          Predict a full 905-patch spectral dataset for a new substrate using {chartK} measured anchor patches.
        </p>
      </div>

      {/* Step 1: Reference profiles */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          1 · Reference profiles (same print mode)
        </h3>

        {/* Direct upload — works alongside or instead of sidebar */}
        <label className="flex items-center gap-3 cursor-pointer">
          <span className={`px-4 py-2 rounded border text-sm transition-colors ${
            refLoading
              ? 'border-gray-700 text-gray-500 bg-gray-800 cursor-wait'
              : 'border-gray-600 text-gray-300 bg-gray-800 hover:border-gray-400'
          }`}>
            {refLoading ? 'Loading…' : '+ Load reference profiles'}
          </span>
          <input
            type="file"
            accept=".icm,.icc,.cxf,.cxfz"
            multiple
            className="hidden"
            onChange={handleRefFiles}
            disabled={refLoading}
          />
          <span className="text-xs text-gray-500">ICM · ICC · CxF</span>
        </label>
        {refLoadError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded px-3 py-2">
            {refLoadError}
          </p>
        )}

        {allProfiles.length === 0 ? (
          <p className="text-sm text-gray-600 italic">No profiles loaded yet.</p>
        ) : (
          <div className="space-y-4">
            {Array.from(profilesByMode.entries()).map(([mode, modeProfiles]) => (
              <div key={mode}>
                <div className="text-xs text-gray-500 mb-1.5">{mode}</div>
                <div className="flex flex-wrap gap-2">
                  {modeProfiles.map((p) => {
                    const name = p.metadata.full_name
                    const sel = selectedRefs.includes(name)
                    const isLocal = localRefs.some((r) => r.metadata.full_name === name)
                    const label = name
                      .replace(/^BC_/, '')
                      .replace(/_P9000.*/i, '')
                      .replace(/^@/, '')
                    return (
                      <button
                        key={name}
                        onClick={() => toggleRef(name)}
                        className={`px-3 py-1.5 rounded text-xs font-mono transition-colors border ${
                          sel
                            ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                            : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                        }`}
                        title={name}
                      >
                        {label}
                        {isLocal && !sel && <span className="ml-1 text-gray-500 text-[10px]">↑</span>}
                        {sel && <span className="ml-1.5 text-blue-400">✓</span>}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
        {selectedRefs.length > 0 && (
          <p className="text-xs text-blue-400">
            {selectedRefs.length} reference{selectedRefs.length > 1 ? 's' : ''} selected →{' '}
            {selectedRefs.length === 1 ? 'D1 pipeline' : 'pool-PCA pipeline'}
          </p>
        )}
      </section>

      {/* Step 2: Chart tier */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          2 · Coverage chart tier
        </h3>
        <div className="flex gap-3">
          {([6, 8, 12] as ChartK[]).map((k) => {
            const pct = k === 6 ? '75%' : k === 8 ? '83%' : '89%'
            return (
              <button
                key={k}
                onClick={() => { setChartK(k); setResult(null) }}
                className={`px-4 py-2 rounded border text-sm transition-colors ${
                  chartK === k
                    ? 'bg-blue-600/20 border-blue-500 text-blue-200'
                    : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500'
                }`}
              >
                <span className="font-mono font-semibold">{k} patches</span>
                <span className="ml-2 text-xs opacity-70">≈{pct} pass</span>
              </button>
            )
          })}
        </div>

        {/* Patch target table */}
        <div className="rounded-lg border border-gray-700 overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-gray-800 text-gray-400">
                <th className="px-3 py-2 text-left">#</th>
                <th className="px-3 py-2 text-left">Label</th>
                <th className="px-3 py-2 text-left">RGB</th>
                <th className="px-3 py-2 text-left font-mono">R</th>
                <th className="px-3 py-2 text-left font-mono">G</th>
                <th className="px-3 py-2 text-left font-mono">B</th>
                <th className="px-3 py-2 text-left">Anchor status</th>
              </tr>
            </thead>
            <tbody>
              {targets.map((t, i) => {
                const key = targetKey(t)
                const matched = matchedKeys.has(key)
                return (
                  <tr key={key} className={`border-t border-gray-800 ${matched ? 'bg-green-900/10' : ''}`}>
                    <td className="px-3 py-1.5 text-gray-500">{i + 1}</td>
                    <td className="px-3 py-1.5 text-gray-200">{targetLabel(t)}</td>
                    <td className="px-3 py-1.5">
                      <span
                        className="inline-block w-5 h-5 rounded border border-gray-600 mr-2 align-middle"
                        style={{ backgroundColor: `rgb(${t[0]},${t[1]},${t[2]})` }}
                      />
                    </td>
                    <td className="px-3 py-1.5 font-mono text-gray-300">{t[0]}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-300">{t[1]}</td>
                    <td className="px-3 py-1.5 font-mono text-gray-300">{t[2]}</td>
                    <td className="px-3 py-1.5">
                      {matched
                        ? <Badge color="green">matched</Badge>
                        : anchors.length > 0
                        ? <Badge color="red">missing</Badge>
                        : <Badge color="gray">–</Badge>
                      }
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Step 3: Anchor CGATS upload */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          3 · Upload anchor measurements (CGATS.17)
        </h3>
        <p className="text-xs text-gray-500">
          Print the {chartK} patches above on the new substrate. Measure with a spectrophotometer.
          Export as CGATS.17 with fields: SAMPLE_ID, RGB_R/G/B, SPECTRAL_NM_380 … SPECTRAL_NM_730.
        </p>
        <label className="flex items-center gap-3 cursor-pointer">
          <span className="px-4 py-2 rounded border border-gray-600 text-sm text-gray-300 bg-gray-800 hover:border-gray-400 transition-colors">
            Choose CGATS file
          </span>
          <input
            type="file"
            accept=".txt,.cgats,.it8"
            className="hidden"
            onChange={handleAnchorFile}
          />
          {anchors.length > 0 && (
            <span className="text-sm text-green-400">
              {anchors.length} patches loaded · {matchedKeys.size}/{targets.length} targets matched
            </span>
          )}
        </label>
        {anchorError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded px-3 py-2">
            {anchorError}
          </p>
        )}
      </section>

      {/* bias warning */}
      {biasWarning && (
        <section>
          <BiasWarningBanner warning={biasWarning} />
        </section>
      )}

      {/* Step 4: Target name + Generate */}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold uppercase tracking-widest text-gray-400">
          4 · Generate
        </h3>
        <div className="flex items-center gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Target substrate name</label>
            <input
              type="text"
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              className="px-3 py-1.5 rounded border border-gray-600 bg-gray-800 text-sm text-gray-100 w-60 focus:border-blue-500 outline-none"
              placeholder="e.g. AllureAqueous"
            />
          </div>
          <div className="pt-5">
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              className={`px-6 py-2 rounded text-sm font-medium transition-colors ${
                canGenerate
                  ? 'bg-blue-600 hover:bg-blue-500 text-white'
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed'
              }`}
            >
              {generating ? 'Generating…' : 'Generate dataset'}
            </button>
          </div>
        </div>
        {!canGenerate && !generating && (
          <ul className="text-xs text-gray-500 space-y-0.5 ml-1">
            {refProfiles.length === 0 && <li>· Select at least one reference profile</li>}
            {!allMatched && anchors.length === 0 && <li>· Upload anchor measurements</li>}
            {!allMatched && anchors.length > 0 && (
              <li>· Missing patches: {targets.filter((t) => !matchedKeys.has(targetKey(t))).map(targetLabel).join(', ')}</li>
            )}
          </ul>
        )}
        {genError && (
          <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded px-3 py-2">
            {genError}
          </p>
        )}
      </section>

      {/* Step 5: Results + Export */}
      {result && (
        <section className="space-y-4">
          <div className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-200">Result</h3>
            <div className="flex gap-6 text-sm">
              <div>
                <div className="text-xs text-gray-400 mb-0.5">Patches predicted</div>
                <div className="font-mono text-gray-100">{result.sampleIds.length}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-0.5">Anchor patches</div>
                <div className="font-mono text-gray-100">{result.anchorIdx.length}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-0.5">Pipeline</div>
                <div className="font-mono text-blue-300">{result.path}</div>
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-0.5">Expected pass rate</div>
                <div className="font-mono text-gray-100">
                  {result.anchorIdx.length <= 6 ? '~75%' : result.anchorIdx.length <= 8 ? '~83%' : '~89%'}
                </div>
              </div>
            </div>

            {biasWarning && biasWarning.level !== 'ok' && (
              <p className="text-xs text-yellow-400">
                ⚠ Bias detected — exported CGATS may have chromatic errors in high-saturation regions.
              </p>
            )}

            <button
              onClick={handleExport}
              className="px-5 py-2 rounded border border-blue-600 text-blue-300 text-sm font-medium hover:bg-blue-600/20 transition-colors"
            >
              ↓ Export CGATS ({result.sampleIds.length} patches)
            </button>
          </div>
        </section>
      )}
    </div>
  )
}
