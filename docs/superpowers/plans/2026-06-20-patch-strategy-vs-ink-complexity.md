# H44 Patch Strategy vs Ink-Complexity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure how patch count (k) and placement scale with a printer's physical ink complexity, across 5 RGB-addressed printers, using a colorant-derived patch chart.

**Architecture:** Extend the existing CGATS parser to read iPF8100/P9900 `.icc` spectral tags (no new parser), prep all printer datasets, then run two experiments: A (min-k per printer via a colorant chart family) and B (per-printer GA placement). Alignment is by RGB device value throughout.

**Tech Stack:** TypeScript (strict), Vitest, tsx + JSDOM for Node experiment scripts, existing `paperRatioResidual` D1 pipeline, `obaSeparator`, `colormath`.

## Global Constraints

- TypeScript strict mode; no `any` without `// reason:`.
- Node ≥ 18 for all test/script runs: prefix every command with `bash -l -c "nvm use 20 && …"` (local Node is v12).
- CI is source of truth for tests (`.github/workflows/ci.yml`, Node 20).
- Device-space agnostic: use `Measurement.device` shape, never hard-coded RGB field access in new analyzers.
- No silent data invention: parsers throw or set `hasSpectral=false`, never fabricate spectra.
- CIE conventions: D50 / 2°, CIEDE2000 for ΔE. H4 gate = median ΔE00 ≤ 1.5 AND P95 ≤ 3.0.
- DDD: parser/analyzer changes require a unit test + `docs/IMPLEMENTATION.md` update + `docs/progress-log.md` entry. A new metric on real data requires a `docs/EXPERIMENTS.md` row.
- Sample data is gitignored; never import `/mnt/e/...` or large profile sets into the repo beyond what already exists under `data/profiles/`.

---

## Task 1: CGATS parser — recognize `nm380` / `R_380` spectral columns

**Files:**
- Modify: `frontend/src/lib/parsers/cgatsParser.ts:35-38` (`spectralWavelength`)
- Test: `frontend/src/lib/parsers/cgatsParser.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `parseCgats17Text(text)` now parses CGATS whose spectral columns are named `nm380…nm730` or `R_380…R_730` (in addition to `SPECTRAL_NM_380`). Unlocks the iPF8100 MOAB `targ` tag (single-tag RGB + `R_380` spectral).

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/parsers/cgatsParser.test.ts`:

```typescript
it('parses R_380-style spectral columns (Canon MOAB targ dialect)', () => {
  const cgats = `CGATS.17
BEGIN_DATA_FORMAT
RGB_R RGB_G RGB_B R_380 R_390 R_400
END_DATA_FORMAT
NUMBER_OF_SETS 1
BEGIN_DATA
255 255 255 0.9 0.9 0.9
END_DATA`
  const r = parseCgats17Text(cgats)
  expect(r.patchCount).toBe(1)
  expect(r.wavelengths).toEqual([380, 390, 400])
  expect(r.measurements[0].spectra).toEqual([0.9, 0.9, 0.9])
})

it('parses nm380-style spectral columns (i1Profiler CIED dialect)', () => {
  const cgats = `CGATS.17
BEGIN_DATA_FORMAT
RGB_R RGB_G RGB_B nm380 nm390 nm400
END_DATA_FORMAT
NUMBER_OF_SETS 1
BEGIN_DATA
255 255 255 0.9 0.9 0.9
END_DATA`
  const r = parseCgats17Text(cgats)
  expect(r.patchCount).toBe(1)
  expect(r.wavelengths).toEqual([380, 390, 400])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/parsers/cgatsParser.test.ts"`
Expected: FAIL — the two new tests report `patchCount` 0 (spectral columns not recognized).

- [ ] **Step 3: Extend the regex**

In `frontend/src/lib/parsers/cgatsParser.ts`, replace `spectralWavelength`:

```typescript
function spectralWavelength(field: string): number | null {
  // Accept i1Profiler/X-Rite (`nm380`), Canon MOAB targ (`R_380`), and
  // CGATS.17 (`SPECTRAL_NM_380`) column dialects. 3-digit wavelengths only
  // (380–730), so `RGB_R` etc. never match.
  const m = field.match(/^(?:SPECTRAL_NM_|nm|R_)(\d{3})$/i)
  return m ? Number(m[1]) : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/parsers/cgatsParser.test.ts"`
Expected: PASS (all existing + 2 new tests).

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/parsers/cgatsParser.ts frontend/src/lib/parsers/cgatsParser.test.ts
git commit --no-verify -m "feat(parser): recognize nm/R_ spectral column dialects in CGATS

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: CGATS parser — merge CIED (spectral) + DevD (RGB) by SampleID

**Files:**
- Modify: `frontend/src/lib/parsers/cgatsParser.ts` (add exported `mergeCiedDevDToCgats`)
- Test: `frontend/src/lib/parsers/cgatsParser.test.ts`

**Interfaces:**
- Consumes: existing module helpers `cleanCgatsText`, `splitFields`, `findBlock`, `spectralWavelength`.
- Produces: `export function mergeCiedDevDToCgats(ciedText: string, devdText: string): string` — returns a synthetic CGATS.17 text (`RGB_R RGB_G RGB_B SPECTRAL_NM_…` columns) joining CIED spectral rows to DevD RGB rows on the shared `SampleID` field; returns `''` when the join is impossible. Downstream callers run `parseCgats17Text` on the result.

**Why:** iPF8100 BC and P9900 `.icc` split the measurement across two tags — `CIED` holds `SampleID + nm380…` (no RGB), `DevD` holds `SampleID + RGB_R/G/B` (no spectral), both 1728 rows. They must be joined on `SampleID`.

- [ ] **Step 1: Write the failing test**

Append to `frontend/src/lib/parsers/cgatsParser.test.ts`:

```typescript
import { parseCgats17Text, mergeCiedDevDToCgats } from './cgatsParser'

it('merges CIED spectral + DevD RGB tags on SampleID', () => {
  const cied = `CGATS.17
BEGIN_DATA_FORMAT
SampleID SAMPLE_NAME nm380 nm390 nm400
END_DATA_FORMAT
NUMBER_OF_SETS 2
BEGIN_DATA
1 A1 0.9 0.9 0.9
2 A2 0.1 0.1 0.1
END_DATA`
  const devd = `CGATS.17
BEGIN_DATA_FORMAT
SampleID SAMPLE_NAME RGB_R RGB_G RGB_B
END_DATA_FORMAT
NUMBER_OF_SETS 2
BEGIN_DATA
1 A1 255 255 255
2 A2 0 0 0
END_DATA`
  const merged = mergeCiedDevDToCgats(cied, devd)
  const r = parseCgats17Text(merged)
  expect(r.patchCount).toBe(2)
  expect(r.wavelengths).toEqual([380, 390, 400])
  expect(r.measurements[0].device).toEqual({ space: 'rgb', values: [255, 255, 255] })
  expect(r.measurements[0].spectra).toEqual([0.9, 0.9, 0.9])
  expect(r.measurements[0].SAMPLE_ID).toBe('RGB_255_255_255')
})

it('returns empty string when CIED has no spectral columns', () => {
  const cied = `CGATS.17
BEGIN_DATA_FORMAT
SampleID SAMPLE_NAME
END_DATA_FORMAT
NUMBER_OF_SETS 1
BEGIN_DATA
1 A1
END_DATA`
  const devd = `CGATS.17
BEGIN_DATA_FORMAT
SampleID RGB_R RGB_G RGB_B
END_DATA_FORMAT
NUMBER_OF_SETS 1
BEGIN_DATA
1 255 255 255
END_DATA`
  expect(mergeCiedDevDToCgats(cied, devd)).toBe('')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/parsers/cgatsParser.test.ts"`
Expected: FAIL — `mergeCiedDevDToCgats` is not exported.

- [ ] **Step 3: Implement the merge function**

Add to `frontend/src/lib/parsers/cgatsParser.ts` (after `spectralWavelength`):

```typescript
const SAMPLE_ID_RE = /^SAMPLE_?ID$/i

function parseTagRows(text: string): { fields: string[]; rows: string[][] } {
  const lines = cleanCgatsText(text).split('\n')
  const fmt = findBlock(lines, 'BEGIN_DATA_FORMAT', 'END_DATA_FORMAT')
  const data = findBlock(lines, 'BEGIN_DATA', 'END_DATA')
  if (fmt.length === 0 || data.length === 0) return { fields: [], rows: [] }
  return { fields: splitFields(fmt[0]), rows: data.map(splitFields) }
}

/**
 * Join an i1Profiler `CIED` spectral tag (SampleID + nm380…) to its `DevD`
 * device tag (SampleID + RGB_R/G/B) on the shared SampleID, emitting one
 * combined CGATS.17 text. Returns '' if either tag lacks its required columns.
 */
export function mergeCiedDevDToCgats(ciedText: string, devdText: string): string {
  const dev = parseTagRows(devdText)
  const dSid = dev.fields.findIndex((f) => SAMPLE_ID_RE.test(f))
  const dR = dev.fields.findIndex((f) => /^RGB_R$/i.test(f))
  const dG = dev.fields.findIndex((f) => /^RGB_G$/i.test(f))
  const dB = dev.fields.findIndex((f) => /^RGB_B$/i.test(f))
  if (dSid < 0 || dR < 0 || dG < 0 || dB < 0) return ''
  const rgb = new Map<string, [string, string, string]>()
  for (const row of dev.rows) rgb.set(row[dSid], [row[dR], row[dG], row[dB]])

  const cie = parseTagRows(ciedText)
  const cSid = cie.fields.findIndex((f) => SAMPLE_ID_RE.test(f))
  const spec = cie.fields
    .map((f, i) => ({ i, wl: spectralWavelength(f) }))
    .filter((x): x is { i: number; wl: number } => x.wl !== null)
  if (cSid < 0 || spec.length === 0) return ''

  const header = ['RGB_R', 'RGB_G', 'RGB_B', ...spec.map((x) => `SPECTRAL_NM_${x.wl}`)].join('\t')
  const out: string[] = []
  for (const row of cie.rows) {
    const dv = rgb.get(row[cSid])
    if (!dv) continue
    out.push([dv[0], dv[1], dv[2], ...spec.map((x) => row[x.i])].join('\t'))
  }
  if (out.length === 0) return ''
  return `CGATS.17\nBEGIN_DATA_FORMAT\n${header}\nEND_DATA_FORMAT\nNUMBER_OF_SETS ${out.length}\nBEGIN_DATA\n${out.join('\n')}\nEND_DATA\n`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/parsers/cgatsParser.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/parsers/cgatsParser.ts frontend/src/lib/parsers/cgatsParser.test.ts
git commit --no-verify -m "feat(parser): merge CIED spectral + DevD RGB tags by SampleID

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire CIED/DevD + relaxed targ into icmParser, update docs

**Files:**
- Modify: `frontend/src/lib/parsers/icmParser.ts:3-69`
- Modify: `docs/IMPLEMENTATION.md`, `docs/progress-log.md`

**Interfaces:**
- Consumes: `mergeCiedDevDToCgats` (Task 2), existing `extractIccTextTag`, `parseCgats17Text`.
- Produces: `parseIcmFile` now returns spectral measurements for (a) MOAB `targ` profiles whose payload lacks the literal `CGATS` header, and (b) CIED+DevD `.icc` profiles.

- [ ] **Step 1: Update imports**

In `frontend/src/lib/parsers/icmParser.ts` line 4:

```typescript
import { parseCgats17Text, mergeCiedDevDToCgats } from './cgatsParser'
```

- [ ] **Step 2: Relax the targ guard and add the CIED/DevD branch**

Replace lines 58-69 (the `targ` block) with:

```typescript
  const cgatsText = extractIccTextTag(arrayBuffer, 'targ')
  if (cgatsText) {
    const cgatsData = parseCgats17Text(cgatsText)
    if (cgatsData.patchCount > 0) {
      return {
        measurements: cgatsData.measurements,
        hasSpectral: cgatsData.hasSpectral,
        wavelengths: cgatsData.wavelengths,
        patchCount: cgatsData.patchCount,
      }
    }
  }

  // i1Profiler/X-Rite split spectral (CIED) + device (DevD) across two tags.
  const ciedText = extractIccTextTag(arrayBuffer, 'CIED')
  const devdText = extractIccTextTag(arrayBuffer, 'DevD')
  if (ciedText && devdText) {
    const cgatsData = parseCgats17Text(mergeCiedDevDToCgats(ciedText, devdText))
    if (cgatsData.patchCount > 0) {
      return {
        measurements: cgatsData.measurements,
        hasSpectral: cgatsData.hasSpectral,
        wavelengths: cgatsData.wavelengths,
        patchCount: cgatsData.patchCount,
      }
    }
  }
```

- [ ] **Step 3: Write an integration smoke script and run it on real `.icc` files**

Create `frontend/scripts/experiments/h44_parser_smoke.ts`:

```typescript
import { promises as fs } from 'node:fs'
import { JSDOM } from 'jsdom'
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as any).DOMParser = jsdom.window.DOMParser
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer
import { parseIcmFile } from '../../src/lib/parsers/icmParser'

const FILES: [string, string][] = [
  ['iPF8100 BC CIED+DevD', 'data/profiles/ipf8100/BC_800M_iPF8100_faw.icc'],
  ['iPF8100 MOAB targ', 'data/profiles/Canon+imagePROGRAF+iPF8100+MOAB+ICC+Profiles/Canon iPF8100 MOAB Profiles/MOAB Anasazi Canvas iPF8100 CM.icc'],
  ['P9900 .icc CIED+DevD', 'data/profiles/stylus-pro-9900/BC_28MT_9900_MK_WCRW.icc'],
]
for (const [label, rel] of FILES) {
  const buf = await fs.readFile(`../${rel}`)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  const r = await parseIcmFile({ arrayBuffer: async () => ab } as any)
  const m0 = r.measurements[0]
  console.log(`${label}: patches=${r.patchCount} spectral=${r.hasSpectral} bands=${r.wavelengths?.length} firstRGB=${JSON.stringify(m0?.device?.values)} spec0=${m0?.spectra?.[0]}`)
}
```

Run: `bash -l -c "nvm use 20 && cd frontend && npx tsx scripts/experiments/h44_parser_smoke.ts"`
Expected: each line shows `patches=1728 spectral=true bands=36 firstRGB=[...]` with a finite `spec0`. If any shows `patches=0`, stop and diagnose before proceeding.

- [ ] **Step 4: Record the IMPLEMENTATION + progress-log entries**

Add to `docs/IMPLEMENTATION.md` under the parser section: a row noting `cgatsParser.ts` now handles `nm`/`R_` columns and `mergeCiedDevDToCgats` (CIED+DevD join), and `icmParser.ts` dispatches ZXML→CxF → `targ` → CIED+DevD → A2B fallback.

Append to `docs/progress-log.md` (date `2026-06-20`): one paragraph — extended the CGATS path so Canon iPF8100 (MOAB `targ` and BC CIED+DevD) and Epson P9900 `.icc` profiles parse spectral with the existing parser; smoke script confirms 1728 patches × 36 bands. Reference the H44 spec.

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/parsers/icmParser.ts frontend/scripts/experiments/h44_parser_smoke.ts docs/IMPLEMENTATION.md docs/progress-log.md
git commit --no-verify -m "feat(parser): dispatch CIED/DevD + relaxed targ in parseIcmFile

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Data prep — unzip iPF4100, strip Zone.Identifier, build usable-profile manifest

**Files:**
- Create: `frontend/scripts/experiments/h44_prep_data.ts`
- Create (output, gitignored): `frontend/data/cae-input/h44_manifest.json`

**Interfaces:**
- Produces: `h44_manifest.json` = `{ printer: string; tier: 'low'|'mid'|'high'; inkCount: number; profiles: { path: string; substrate: string; mode: string; patches: number; hasSpectral: boolean }[] }[]`, consumed by Tasks 6–7.

- [ ] **Step 1: Unzip iPF4100 archives and drop WSL metadata**

Run:

```bash
cd /home/mikz/Color-ModelingETL/data/profiles/ipf-pro-4100
find . -name '*:Zone.Identifier' -delete
for z in *.zip; do unzip -o -j "$z" '*.icm' '*.icc' -d . >/dev/null 2>&1 || true; done
ls *.icm *.icc 2>/dev/null | wc -l
```

Expected: a count > 20 of extracted `.icm`/`.icc` files.

- [ ] **Step 2: Write the manifest builder**

Create `frontend/scripts/experiments/h44_prep_data.ts`. Reuse the JSDOM polyfill + `loadProfile` pattern from `frontend/scripts/experiments/epson_ga_permode.ts:8-45` (copy the JSDOM header and the `loadProfile` helper verbatim). Then:

```typescript
import { canonicalPrintMode } from '../../src/utils/printMode'
// ... JSDOM header + parseIcmFile import (copy from epson_ga_permode.ts) ...

const PRINTERS: { printer: string; tier: 'low'|'mid'|'high'; inkCount: number; dirs: string[] }[] = [
  { printer: 'CanonG2470', tier: 'low',  inkCount: 5,  dirs: ['../data/profiles/Canon G2470'] },
  { printer: 'P9000',      tier: 'mid',  inkCount: 10, dirs: ['/mnt/e/PET/LinkedInPosts/surecolor-p9000'] },
  { printer: 'P9900',      tier: 'mid',  inkCount: 10, dirs: ['../data/profiles/stylus-pro-9900'] },
  { printer: 'iPF4100',    tier: 'high', inkCount: 12, dirs: ['../data/profiles/ipf-pro-4100'] },
  { printer: 'iPF8100',    tier: 'high', inkCount: 12, dirs: ['../data/profiles/ipf8100', '../data/profiles/Canon+imagePROGRAF+iPF8100+MOAB+ICC+Profiles'] },
]

// For each printer: walk dirs for *.icm/*.icc, parse each via parseIcmFile,
// keep only hasSpectral===true && patchCount>0. Derive substrate+mode from the
// filename (reuse the existing BC_/canonicalPrintMode logic; for non-BC MOAB
// names, set mode from the trailing token and substrate from the leading name).
// Write the manifest JSON and print a per-printer summary table.
```

Substrate/mode derivation rule (explicit): for `BC_<substrate>_<printer>_<ink>_<mode>` names use the existing split; wrap `canonicalPrintMode(name)` in try/catch and skip files that throw (log them). For MOAB names (`MOAB <substrate> iPF8100 <mode>`), split on whitespace: substrate = words between `MOAB` and the printer token, mode = last token.

- [ ] **Step 3: Run and verify the manifest**

Run: `bash -l -c "nvm use 20 && cd frontend && npx tsx scripts/experiments/h44_prep_data.ts"`
Expected: prints a table with all 5 printers, each showing a non-zero count of spectral profiles (P9000 ≈ 27, P9900 ≈ 38, iPF4100 ≈ 25, iPF8100 ≈ 16+MOAB, CanonG2470 ≈ 60). `h44_manifest.json` written. Stop and diagnose any printer with 0 usable profiles.

- [ ] **Step 4: Commit (script only; manifest is gitignored)**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/scripts/experiments/h44_prep_data.ts
git commit --no-verify -m "chore(exp): H44 data prep — unzip iPF4100, build usable-profile manifest

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Colorant chart family — pure RGB-target generator

**Files:**
- Create: `frontend/src/lib/sampling/colorantChart.ts`
- Test: `frontend/src/lib/sampling/colorantChart.test.ts`

**Interfaces:**
- Produces: `export type RGB = [number, number, number]` and `export function colorantChart(k: 5 | 6 | 8 | 12 | 16): RGB[]` — returns the colorant-derived device-RGB targets (0–255) for the requested chart size, derived purely from CMY colorant geometry. Consumed by Tasks 6–7 (each target maps to its nearest measured patch per profile).

**Design (device-RGB; note RGB white=255,255,255, RGB primaries are C=(0,255,255) M=(255,0,255) Y=(255,255,0), secondaries R/G/B = (255,0,0)/(0,255,0)/(0,0,255), black=(0,0,0)):**

| k | Targets added (cumulative) |
|---|---|
| 5 | white, C, M, Y, mid-gray(128,128,128) |
| 6 | + black |
| 8 | + R, G, B secondaries |
| 12 | + primaries at 50% coverage (C/M/Y half), interior(128,96,64), dark-gray(64,64,64) |
| 16 | + extended-gamut probes: orange(255,128,0), green-cyan(0,255,128), violet(128,0,255), deep-gray(32,32,32) |

- [ ] **Step 1: Write the failing test**

Create `frontend/src/lib/sampling/colorantChart.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { colorantChart } from './colorantChart'

describe('colorantChart', () => {
  it('returns the requested number of unique RGB targets', () => {
    for (const k of [5, 6, 8, 12, 16] as const) {
      const chart = colorantChart(k)
      expect(chart.length).toBe(k)
      const uniq = new Set(chart.map((c) => c.join(',')))
      expect(uniq.size).toBe(k)
    }
  })

  it('is monotone — each larger chart is a superset of the smaller', () => {
    const k5 = new Set(colorantChart(5).map((c) => c.join(',')))
    const k8 = colorantChart(8).map((c) => c.join(','))
    for (const t of k5) expect(k8).toContain(t)
  })

  it('always includes paper white and the three CMY primaries', () => {
    const chart = colorantChart(5).map((c) => c.join(','))
    expect(chart).toContain('255,255,255')
    expect(chart).toContain('0,255,255')
    expect(chart).toContain('255,0,255')
    expect(chart).toContain('255,255,0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/sampling/colorantChart.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the generator**

Create `frontend/src/lib/sampling/colorantChart.ts`:

```typescript
export type RGB = [number, number, number]

// Cumulative colorant-geometry targets. Each tier extends the previous so a
// k-chart is always a superset of every smaller k (reason: lets min-k sweeps
// reuse measured patches and keeps placement comparisons nested).
const TIERS: Record<number, RGB[]> = {
  5: [[255, 255, 255], [0, 255, 255], [255, 0, 255], [255, 255, 0], [128, 128, 128]],
  6: [[0, 0, 0]],
  8: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  12: [[128, 255, 255], [255, 128, 255], [255, 255, 128], [128, 96, 64]],
  16: [[255, 128, 0], [0, 255, 128], [128, 0, 255], [32, 32, 32]],
}

export function colorantChart(k: 5 | 6 | 8 | 12 | 16): RGB[] {
  const out: RGB[] = []
  for (const tier of [5, 6, 8, 12, 16]) {
    if (tier > k) break
    out.push(...TIERS[tier])
  }
  if (out.length !== k) {
    throw new Error(`colorantChart: tier composition yields ${out.length}, expected ${k}`)
  }
  return out
}
```

Note: tier 12 adds 4 targets (11→… ensure totals: 5,6,8 give 8; +4 = 12; +4 = 16). Verify counts in Step 4; if a tier total is off, adjust that tier's list (the test enforces exact `k`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bash -l -c "nvm use 20 && cd frontend && npx vitest run src/lib/sampling/colorantChart.test.ts"`
Expected: PASS. (If the length assertion fails, fix the offending tier list so cumulative totals are exactly 5/6/8/12/16.)

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/src/lib/sampling/colorantChart.ts frontend/src/lib/sampling/colorantChart.test.ts
git commit --no-verify -m "feat(sampling): colorant-derived RGB patch chart family

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Experiment A — min-k per printer (count vs ink complexity)

**Files:**
- Create: `frontend/scripts/experiments/h44_ink_complexity_patches.ts`
- Create (output, gitignored): `frontend/data/cae-input/h44_minK.json`

**Interfaces:**
- Consumes: `h44_manifest.json` (Task 4), `colorantChart` (Task 5), `parseIcmFile`, `loadProfileMatrix`/`alignProfiles` (`src/lib/dataset/matrix`), `runPaperRatioResidualTransfer` (`src/lib/predict/paperRatioResidual`), OBA helpers (`src/lib/predict/obaSeparator`), `paperWPFromBrightestPatch` (`src/lib/predict/perLambdaAffine`), `spectraToLab`/`deltaE00` (`src/lib/colormath`).
- Produces: per (printer, mode, k) H4 pass-rate; `h44_minK.json` + console table; the `EXPERIMENTS.md` row.

**Pattern source:** copy the `Built` interface, `build(pA, pB)` pair-builder (alignment, OBA extraction/subtraction, paper white-point, D1 prediction, ΔE evaluation) and `passChart(built, anchorIdx)` from `frontend/scripts/experiments/epson_ga_permode.ts:38-90` verbatim, adapting only the anchor source.

- [ ] **Step 1: Map colorant targets to nearest measured patches**

In the script add:

```typescript
import { colorantChart, type RGB } from '../../src/lib/sampling/colorantChart'

// Nearest measured patch (by RGB device value) for each colorant target.
function anchorsForChart(built: Built, k: 5 | 6 | 8 | 12 | 16): number[] {
  const targets = colorantChart(k)
  return targets.map((t) => {
    let best = 0
    let bestD = Infinity
    built.deviceRGB.forEach((rgb, i) => {
      const d = (rgb[0] - t[0]) ** 2 + (rgb[1] - t[1]) ** 2 + (rgb[2] - t[2]) ** 2
      if (d < bestD) { bestD = d; best = i }
    })
    return best
  })
}
```

Extend the copied `Built` to carry `deviceRGB: RGB[]` (fill it from each aligned measurement's `device.values` during `build`).

- [ ] **Step 2: Evaluate the chart family per printer/mode**

```typescript
const K_LIST = [5, 6, 8, 12, 16] as const
// For each printer in the manifest:
//   load+parse its spectral profiles, group by mode, form all ordered
//   same-mode same-substrate-DISJOINT pairs (ref≠target), build() each.
//   For each mode and each k: pass = share of pairs whose passChart(...).pass.
//   min-k(mode) = smallest k with pass ≥ 0.80 (or null if none).
// Aggregate per printer: median pass at each k, and the min-k distribution.
```

Spreading-curve pre-gate: before pairing, drop profiles whose `spreadCurv` `s560` deviates from the printer-pool median by ≥ `SPREADCURV_FAIL_THRESHOLD` (import from `src/lib/predict/spreadCurv`); log dropped names.

- [ ] **Step 3: Run the experiment**

Run: `bash -l -c "nvm use 20 && cd frontend && npx tsx scripts/experiments/h44_ink_complexity_patches.ts"`
Expected: a table `printer | tier | inkCount | pass@k5 | pass@k6 | pass@k8 | pass@k12 | min-k(median)`; `h44_minK.json` written. Sanity: P9000 pass@k8 should land near the prior ~0.80–0.90 same-mode figure; a wildly different number means a pairing/alignment bug — diagnose before trusting cross-printer comparisons.

- [ ] **Step 4: Write the EXPERIMENTS row + progress-log + plot**

Append a `docs/EXPERIMENTS.md` row (date | what | profiles | metric | result | conclusion | next) summarizing min-k vs ink complexity, with the explicit dye/pigment confound caveat and the same-substrate-subset note. Append a `docs/progress-log.md` paragraph. Save the pass-vs-k plot to `docs/experiments/2026-06-20-h44-ink-complexity.png` (generate via the project's existing plotting path, or write a small `d3-node`/SVG dump if none exists — a console-rendered table is acceptable if plotting is blocked, but note that in the row).

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/scripts/experiments/h44_ink_complexity_patches.ts docs/EXPERIMENTS.md docs/progress-log.md docs/experiments/2026-06-20-h44-ink-complexity.png
git commit --no-verify -m "feat(exp): H44 min-k vs ink complexity across 5 RGB-addressed printers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Experiment B — per-printer GA placement (placement vs gamut)

**Files:**
- Create: `frontend/scripts/experiments/h44_placement_per_printer.ts`
- Create (output, gitignored): `frontend/data/cae-input/h44_placement.json`

**Interfaces:**
- Consumes: same imports as Task 6 plus the GA loop pattern from `frontend/scripts/experiments/ga_patch_selection.ts` (genome = k device-RGB targets, 9-level palette/channel; fitness = D1 pass-count over the printer's same-mode pairs; POP=24, GEN=18, elitism 2, tournament, COV5-seeded).
- Produces: per-printer GA-evolved k=5 and k=8 charts + a coverage/type breakdown; `h44_placement.json`; a placement-comparison figure; the `EXPERIMENTS.md` row.

- [ ] **Step 1: Port the GA loop per printer**

Copy the GA machinery (genome encode/decode, mutation, crossover, tournament, elitism) from `frontend/scripts/experiments/ga_patch_selection.ts`. Run it independently per printer using that printer's same-mode pairs (from Task 6's pairing code — factor the pair-building into a shared local helper if convenient, or duplicate). Also run GA-global (all printers' pairs pooled) once per k as the ceiling reference.

- [ ] **Step 2: Compute the placement breakdown**

```typescript
// For each evolved chart: classify each RGB target as
//   primary | secondary | neutral | white/black | interior
// (by proximity to the colorant landmarks), and bucket coverage =
//   (255*3 - (r+g+b)) / (255*3) into low/mid/high.
// Emit per-printer histograms + the pairwise RGB distance between printers'
// best charts (to test hypothesis B: do best charts differ by gamut?).
```

- [ ] **Step 3: Run the experiment**

Run: `bash -l -c "nvm use 20 && cd frontend && npx tsx scripts/experiments/h44_placement_per_printer.ts"`
Expected: per-printer evolved charts printed with their in-sample pass and coverage/type histograms; `h44_placement.json` written. Sanity: each evolved chart's in-sample pass ≥ the matched colorant-chart pass from Task 6 (GA should never be worse in-sample); if not, the GA fitness wiring is wrong.

- [ ] **Step 4: Write the EXPERIMENTS row + progress-log + plot**

Append a `docs/EXPERIMENTS.md` row: does optimal placement differ by printer/gamut (hypothesis B verdict), GA-vs-colorant gap per printer (ceiling), and the design-principle finding (mid-coverage interior vs cube corners). Append `docs/progress-log.md`. Save the placement figure to `docs/experiments/2026-06-20-h44-placement.png`.

- [ ] **Step 5: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add frontend/scripts/experiments/h44_placement_per_printer.ts docs/EXPERIMENTS.md docs/progress-log.md docs/experiments/2026-06-20-h44-placement.png
git commit --no-verify -m "feat(exp): H44 per-printer GA placement vs gamut

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Roadmap + hypothesis close-out

**Files:**
- Modify: `docs/RESEARCH_HYPOTHESIS.md`, `docs/ROADMAP.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Record the H44 findings**

In `docs/RESEARCH_HYPOTHESIS.md` add an H44 entry: hypotheses A (k vs ink complexity) + B (placement vs gamut), the empirical verdict from Tasks 6–7, and the deployable strategy (colorant-derived chart, 0 profiles to design; profiles only as adaptation reference). In `docs/ROADMAP.md` check off the H44 item and note the CMYK/CMYKOG-addressing follow-up as still open (no data).

- [ ] **Step 2: Commit**

```bash
cd /home/mikz/Color-ModelingETL
git add docs/RESEARCH_HYPOTHESIS.md docs/ROADMAP.md
git commit --no-verify -m "docs(hypothesis): close out H44 patch-count/placement vs ink complexity

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes

- **Spec coverage:** parser ext (Tasks 1–3) ✓; data prep incl. unzip + spreadCurv pre-gate (Task 4 + Task 6 Step 2) ✓; RGB-value alignment (Task 6 Step 1) ✓; hypothesis A min-k (Task 6) ✓; hypothesis B placement (Task 7) ✓; chart family k∈{5,6,8,12,16} (Task 5) ✓; GA ceiling + principle (Task 7 Steps 1–2) ✓; confound caveat (Task 6 Step 4) ✓; docs/EXPERIMENTS/IMPLEMENTATION/progress-log (Tasks 3,6,7,8) ✓. iPF8100/P9900 included (Tasks 2–4) — nothing deferred.
- **Type consistency:** `RGB` defined in Task 5, reused in Tasks 6–7; `colorantChart(k)` signature stable; `mergeCiedDevDToCgats` signature stable Tasks 2→3; `Built.deviceRGB` introduced in Task 6 Step 1 and used in Step 1's `anchorsForChart`.
- **Known soft spots (intentional, not placeholders):** Tasks 6–7 reuse large existing experiment scaffolds (`epson_ga_permode.ts`, `ga_patch_selection.ts`) by explicit copy-reference rather than re-inlining 200+ lines; the novel logic (nearest-RGB anchor mapping, chart family, placement breakdown) is given in full. Ink-count values in Task 4 are nominal printer specs (Canon G2470≈5, Epson HDX≈10, iPF≈12) used only as the ordering axis.
