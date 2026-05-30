// frontend/scripts/reorgByMode.ts
//
// Reorganise data/profiles/ into per-Epson-preset subfolders using the canonical
// print-mode mapper. Profile files (.icm/.icc/.cxf) move into data/profiles/<Preset>/;
// non-profile MOAB assets (targ.txt, the Media Settings PDF) move into
// data/profiles/_MOAB_source/.
//
// Tracked files are moved with `git mv` (preserves rename); untracked files with a
// plain rename. Run a dry-run first, then apply:
//   cd frontend
//   npx tsx scripts/reorgByMode.ts            # dry-run, prints the plan
//   npx tsx scripts/reorgByMode.ts --apply    # executes the moves

import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { canonicalPrintMode, presetFolder } from '../src/utils/printMode'

const ROOT = path.resolve(process.cwd(), '..')
const PROFILES = path.resolve(ROOT, 'data/profiles')
const MOAB_SUB = path.join(PROFILES, '2023 Epson SureColor P9000 MOAB Profiles')
const MOAB_ASSET_DIR = path.join(PROFILES, '_MOAB_source')

const PROFILE_EXT = /\.(icm|icc|cxf)$/i
const APPLY = process.argv.includes('--apply')

function isTracked(absPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', absPath], {
      cwd: ROOT,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    return entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name))
  } catch {
    return []
  }
}

interface Move {
  from: string
  to: string
  tracked: boolean
}

async function buildPlan(): Promise<Move[]> {
  const moves: Move[] = []

  // Top-level profile files (Breathing Color).
  for (const f of await listFiles(PROFILES)) {
    if (!PROFILE_EXT.test(f)) continue
    const preset = canonicalPrintMode(path.basename(f))
    moves.push({
      from: f,
      to: path.join(PROFILES, presetFolder(preset), path.basename(f)),
      tracked: isTracked(f),
    })
  }

  // MOAB subfolder: .icc profiles → preset folders; other assets → _MOAB_source.
  for (const f of await listFiles(MOAB_SUB)) {
    const base = path.basename(f)
    if (PROFILE_EXT.test(f)) {
      const preset = canonicalPrintMode(base)
      moves.push({
        from: f,
        to: path.join(PROFILES, presetFolder(preset), base),
        tracked: isTracked(f),
      })
    } else {
      moves.push({ from: f, to: path.join(MOAB_ASSET_DIR, base), tracked: isTracked(f) })
    }
  }

  return moves
}

function rel(p: string): string {
  return path.relative(ROOT, p)
}

async function main() {
  const moves = await buildPlan()
  moves.sort((a, b) => a.to.localeCompare(b.to))

  // Group for a readable plan.
  const byDir = new Map<string, Move[]>()
  for (const m of moves) {
    const d = path.dirname(m.to)
    if (!byDir.has(d)) byDir.set(d, [])
    byDir.get(d)!.push(m)
  }

  console.log(`${APPLY ? 'APPLYING' : 'DRY-RUN'} — ${moves.length} files\n`)
  for (const [dir, ms] of [...byDir.entries()].sort()) {
    console.log(`${rel(dir)}/  (${ms.length})`)
    for (const m of ms) console.log(`    ${m.tracked ? 'git mv' : 'mv    '}  ${path.basename(m.from)}`)
  }

  if (!APPLY) {
    console.log('\nRe-run with --apply to execute.')
    return
  }

  const dirsNeeded = new Set(moves.map((m) => path.dirname(m.to)))
  for (const d of dirsNeeded) await fs.mkdir(d, { recursive: true })

  for (const m of moves) {
    if (m.tracked) {
      execFileSync('git', ['mv', m.from, m.to], { cwd: ROOT, stdio: 'inherit' })
    } else {
      await fs.rename(m.from, m.to)
    }
  }
  console.log(`\nDone. Moved ${moves.length} files.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
