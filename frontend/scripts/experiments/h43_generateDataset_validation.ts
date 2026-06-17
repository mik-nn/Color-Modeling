// H43 — Integration validation: generateDataset on real ICM profiles.
//
// For each non-metallic same-mode pair (A→B), extract cov6/cov8n anchors
// from B's measured spectra (ground-truth lookup by device RGB), run
// generateDataset(ref=A, anchors=cov6_B), evaluate predicted vs measured B
// on non-anchor patches. Compare pass rate with raw h31/h42 D1 numbers.
// Also run biasWarning and verify it fires correctly on known FAIL pairs.
//
// Expected: cov6 ≈76.9%, cov8n ≈82.7% (matches h42).
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h43_generateDataset_validation.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'
const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix } from '../../src/lib/dataset/matrix'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import { generateDataset } from '../../src/lib/core/generateDataset'
import { computeBiasWarning } from '../../src/lib/core/biasWarning'
import type { ProfileData } from '../../src/types'
import type { AnchorMeasurement } from '../../src/lib/core/generateDataset'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36
const METALLIC_RE = /Silverada|VibranceMetallic/i

const COV6_TARGETS: Array<[number,number,number]> = [
  [255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0],[128,128,128],
]
const COV8N_TARGETS: Array<[number,number,number]> = [
  ...COV6_TARGETS,[64,64,64],[192,192,192],
]

const median = (xs:number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs:number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
const pc = (n:number,t:number) => `${n}/${t} (${(100*n/t).toFixed(1)}%)`

async function walk(dir:string):Promise<string[]> {
  const out:string[]=[]
  let e: import('node:fs').Dirent[]
  try { e = await fs.readdir(dir,{withFileTypes:true}) } catch { return out }
  for (const d of e) {
    const f=path.join(dir,d.name)
    if(d.isDirectory())out.push(...await walk(f))
    else if(d.isFile()&&/\.(icm|icc)$/i.test(d.name))out.push(f)
  }
  return out
}

type LP = ProfileData & { wavelengths: number[] }

async function loadProfile(fp:string):Promise<LP|null> {
  try {
    const buf = await fs.readFile(fp)
    const ab = buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await parseIcmFile({arrayBuffer:async()=>ab} as any)
    if(!r.hasSpectral||!r.measurements.length)return null
    const name = path.basename(fp).replace(/\.(icm|icc)$/i,'')
    let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
    return {
      metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',
        substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
      raw:r.measurements, has_spectral:true, patch_count:r.measurements.length,
      wavelengths:r.wavelengths??Array.from({length:36},(_,i)=>380+i*10),
    }
  } catch { return null }
}

// Extract anchor measurements from a loaded profile at given device targets.
function extractAnchors(
  prof: LP,
  targets: Array<[number,number,number]>,
): AnchorMeasurement[] | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mat = loadProfileMatrix(prof as any)
  const { N, X, D } = mat
  const anchors: AnchorMeasurement[] = []
  for (const [tr,tg,tb] of targets) {
    let best=-1, bestD=Infinity
    for (let i=0;i<N;i++) {
      const d=(D[i*3]-tr)**2+(D[i*3+1]-tg)**2+(D[i*3+2]-tb)**2
      if(d<bestD){bestD=d;best=i}
    }
    if(best<0)return null
    const spectrum = Array.from(X.subarray(best*L,best*L+L))
    anchors.push({device:[D[best*3],D[best*3+1],D[best*3+2]],spectrum})
  }
  return anchors
}

// Evaluate predicted vs ground-truth on non-anchor patches.
function evalPrediction(
  predicted: Float64Array,
  anchorIdx: number[],
  groundTruth: Float64Array, // N×L
  N: number,
): { med: number; p95val: number; pass: boolean } {
  const aset = new Set(anchorIdx)
  const des: number[] = []
  for (let i=0;i<N;i++) {
    if(aset.has(i))continue
    const lp = spectraToLab(Array.from(predicted.subarray(i*L,i*L+L)))
    const lm = spectraToLab(Array.from(groundTruth.subarray(i*L,i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]))
  }
  const med = median(des), p95val = p95(des)
  return { med, p95val, pass: med<=1.5 && p95val<=3.0 }
}

async function main() {
  const files = (await walk(PROFILES_ROOT)).sort()
  const profiles = (
    await Promise.all(
      files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile)
    )
  ).filter(Boolean) as LP[]

  const pairs: Array<[LP,LP]> = []
  for (const a of profiles) for (const b of profiles) {
    if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    if(a.metadata.full_name.includes('AllureAq')||b.metadata.full_name.includes('AllureAq'))continue
    if(METALLIC_RE.test(a.metadata.full_name)||METALLIC_RE.test(b.metadata.full_name))continue
    pairs.push([a,b])
  }
  console.log(`Loaded ${profiles.length} profiles. Non-metallic same-mode pairs: ${pairs.length}\n`)

  let pass6=0, pass8n=0, total=0
  let biasOk=0, biasWarn=0, biasErrors=0
  const failPairs: string[] = []

  for (const [pA, pB] of pairs) {
    // Extract cov6 anchors from B's measured spectra
    const anc6 = extractAnchors(pB, COV6_TARGETS)
    const anc8n = extractAnchors(pB, COV8N_TARGETS)
    if (!anc6 || !anc8n) { console.warn(`skip: anchor extraction failed ${pA.metadata.full_name}→${pB.metadata.full_name}`); continue }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const matB = loadProfileMatrix(pB as any)

    // cov6
    let r6ok = false
    try {
      const res6 = generateDataset({ refs:[pA], anchors:anc6, chartK:6, targetName:pB.metadata.full_name })
      const ev6 = evalPrediction(res6.predicted, res6.anchorIdx, matB.X, matB.N)
      if(ev6.pass)pass6++
      r6ok = ev6.pass
    } catch(e) {
      console.warn(`cov6 error: ${(e as Error).message}`)
    }

    // cov8n
    try {
      const res8 = generateDataset({ refs:[pA], anchors:anc8n, chartK:8, targetName:pB.metadata.full_name })
      const ev8 = evalPrediction(res8.predicted, res8.anchorIdx, matB.X, matB.N)
      if(ev8.pass)pass8n++
    } catch(e) {
      console.warn(`cov8n error: ${(e as Error).message}`)
    }

    // biasWarning on cov6
    try {
      const bw = computeBiasWarning({ refs:[pA], targetAnchors:anc6 })
      if(bw.level==='ok')biasOk++; else biasWarn++
      // Cross-check: FAIL pairs should have biasWarn='hue-sat-bias'
      if(!r6ok && bw.level==='ok') failPairs.push(
        `${pA.metadata.full_name.replace(/^BC_/,'').replace(/_P9000.*/,'')}→${pB.metadata.full_name.replace(/^BC_/,'').replace(/_P9000.*/,'')} [bias=ok but fail]`
      )
    } catch(e) { biasErrors++ }

    total++
  }

  console.log('=== Pass rate via generateDataset ===')
  console.log(`  cov6  (k=6): ${pc(pass6, total)}  (expected ≈76.9%)`)
  console.log(`  cov8n (k=8): ${pc(pass8n, total)}  (expected ≈82.7%)`)
  console.log(`\n=== biasWarning distribution ===`)
  console.log(`  ok: ${biasOk}/${total}  warn: ${biasWarn}/${total}  errors: ${biasErrors}`)
  if(failPairs.length) {
    console.log(`\n=== cov6 FAIL pairs where biasWarning='ok' (potential count-limited, fixable with cov8n) ===`)
    for(const p of failPairs) console.log(`  ${p}`)
  }
}

main().catch(e=>{console.error(e);process.exit(1)})
