import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
const j = new JSDOM('<!doctype html>')
;(globalThis as any).DOMParser = j.window.DOMParser
import { extractZxmlCxfXml } from '../src/lib/iccTagScanner'

async function main() {
  const root = '/home/mikz/Color-ModelingETL/data/profiles'
  const dirs = await fs.readdir(root, { withFileTypes: true })
  const rows: { name: string; m0: number; m1: number; m2: number }[] = []
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const sub = path.join(root, d.name)
    for (const f of await fs.readdir(sub)) {
      if (!/\.icm$/i.test(f)) continue
      const buf = await fs.readFile(path.join(sub, f))
      try {
        const xml = await extractZxmlCxfXml(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
        if (!xml) continue
        const m0 = (xml.match(/M0_Measurement/g) || []).length
        const m1 = (xml.match(/M1_Measurement/g) || []).length
        const m2 = (xml.match(/M2_Measurement/g) || []).length
        rows.push({ name: f.replace(/\.icm$/i, ''), m0, m1, m2 })
      } catch {
        // skip
      }
    }
  }
  rows.sort((a, b) => a.name.localeCompare(b.name))
  console.log('profile'.padEnd(50) + ' M0    M1    M2')
  for (const r of rows) {
    console.log(r.name.padEnd(50) + ` ${String(r.m0).padStart(4)}  ${String(r.m1).padStart(4)}  ${String(r.m2).padStart(4)}`)
  }
  const haveM2 = rows.filter((r) => r.m2 > 0)
  const haveM0AndM2 = rows.filter((r) => r.m0 > 0 && r.m2 > 0)
  console.log(`\nTotals: ${rows.length} profiles, M2 present in ${haveM2.length}, M0+M2 in ${haveM0AndM2.length}`)
}
main().catch((e) => { console.error(e); process.exit(1) })
