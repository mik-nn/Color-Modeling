// H40 — Failing-pair tail anatomy: how much is actually fine, and what do the
// wrong patches look like? (user questions, 2026-06-16)
//
// For the 12 structural failers (fail @ S1 k=13):
//   (A) Per-pair pass FRACTION at the patch level (ΔE ≤ 2 / ≤ 3 / > 5) — even a
//       "failing" pair predicts most of the chart correctly; quantify it.
//   (B) Error decomposition on the bad tail (ΔE > 3): signed ΔL, ΔC, Δh.
//       Is the tail a hue rotation (color cast), a chroma collapse, or lightness?
//   (C) Posterization — predicted gradation compressed vs measured? Ratio of
//       adjacent-step ΔE (pred / meas) along neutral + single-channel ramps.
//       ratio < 1 ⇒ banding / gradation loss.
//   (D) Solarization — tone inversion? Count ramp steps where predicted L*
//       moves OPPOSITE to measured (and per-band reflectance sign flips).
//   (E) Neighbour coherence — is each bad patch a smooth local bias (whole region
//       shifted, recoverable) or an isolated jump (posterization/solarization)?
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h40_failtail_anatomy.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
;(globalThis as any).DOMParser = jsdom.window.DOMParser
;(globalThis as any).XMLSerializer = jsdom.window.XMLSerializer

import { parseIcmFile } from '../../src/lib/parsers/icmParser'
import { loadProfileMatrix, alignProfiles } from '../../src/lib/dataset/matrix'
import { pickHeuristicAnchors } from '../../src/lib/sampling/heuristic'
import { runPaperRatioResidualTransfer } from '../../src/lib/predict/paperRatioResidual'
import { paperWPFromBrightestPatch } from '../../src/lib/predict/perLambdaAffine'
import {
  extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA,
} from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, RANK = 5, UV = 4, K = 13
const METALLIC_RE = /Silverada|VibranceMetallic/i

const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN
const median = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }
const dhSigned = (hPred: number, hMeas: number) => { let d=hPred-hMeas; while(d>180)d-=360; while(d<-180)d+=360; return d }

async function walk(dir: string): Promise<string[]> {
  const out:string[]=[]; let e:import('node:fs').Dirent[]
  try{e=await fs.readdir(dir,{withFileTypes:true})}catch{return out}
  for(const d of e){const f=path.join(dir,d.name); if(d.isDirectory())out.push(...await walk(f)); else if(d.isFile()&&/\.(icm|icc)$/i.test(d.name))out.push(f)}
  return out
}
type LP = ProfileData & { wavelengths: number[] }
async function loadProfile(fp: string): Promise<LP | null> {
  try {
    const buf=await fs.readFile(fp); const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)
    const r=await parseIcmFile({arrayBuffer:async()=>ab} as any)
    if(!r.hasSpectral||!r.measurements.length)return null
    const name=path.basename(fp).replace(/\.(icm|icc)$/i,'')
    let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
    return {metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
      raw:r.measurements,clean:r.measurements,has_spectral:true,patch_count:r.measurements.length,
      wavelengths:r.wavelengths??Array.from({length:36},(_,i)=>380+i*10)}
  } catch { return null }
}
const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '').replace(/_P9000$/, '')

interface Patch {
  de:number; dL:number; dC:number; dh:number; rgb:[number,number,number]; ink:number
  Lm:number; Lp:number; Cm:number; Cp:number; isAnchor:boolean; idx:number
  predSpec:Float64Array; measSpec:Float64Array
}
interface PairAna { key:string; med:number; p95:number; patches:Patch[]; N:number }

function analysePair(pA:LP, pB:LP): PairAna | null {
  const al=alignProfiles(loadProfileMatrix(pA as any),loadProfileMatrix(pB as any)); if(al.N<100)return null
  const {N,X_A,X_B,D,sampleIds,wavelengths}=al
  let pr=0;for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){pr=i;break}
  const emA=extractOBAEmission(Array.from(X_A.subarray(pr*L,pr*L+L))),emB=extractOBAEmission(Array.from(X_B.subarray(pr*L,pr*L+L)))
  const fA=computeOBAFactorPerPatch(X_A,L,pr),fB=computeOBAFactorPerPatch(X_B,L,pr)
  const XA_c=subtractOBA(X_A,L,fA,emA.emission),XB_c=subtractOBA(X_B,L,fB,emB.emission)
  const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(pr*L,pr*L+L)),1,L,380)
  const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wavelengths??[],sampleIds,droppedCount:0}
  const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K); const aset=new Set(anchorIdx)
  const d1=runPaperRatioResidualTransfer({X_A:XA_c,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx:pr,L,paperWP,refProfile:'A',targetProfile:'B',residualRank:RANK,knnK:4,uvBandCount:UV})
  const pred=addOBA(d1.X_pred,L,fB,emB.emission)
  const patches:Patch[]=[]; const testDe:number[]=[]
  for(let i=0;i<N;i++){
    const pv=Array.from(pred.subarray(i*L,i*L+L)), mv=Array.from(X_B.subarray(i*L,i*L+L))
    const lp=spectraToLab(pv), lm=spectraToLab(mv)
    const Cp=Math.hypot(lp[1],lp[2]),Cm=Math.hypot(lm[1],lm[2])
    const hp=Math.atan2(lp[2],lp[1])*180/Math.PI,hm=Math.atan2(lm[2],lm[1])*180/Math.PI
    const de=deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])
    const isA=aset.has(i); if(!isA)testDe.push(de)
    patches.push({de,dL:lp[0]-lm[0],dC:Cp-Cm,dh:dhSigned(hp,hm),
      rgb:[D[i*3],D[i*3+1],D[i*3+2]],ink:(765-D[i*3]-D[i*3+1]-D[i*3+2])/765,
      Lm:lm[0],Lp:lp[0],Cm,Cp,isAnchor:isA,idx:i,predSpec:new Float64Array(pv),measSpec:new Float64Array(mv)})
  }
  return {key:`${short(pA.metadata.full_name)}→${short(pB.metadata.full_name)}`,med:median(testDe),p95:p95(testDe),patches,N}
}

// posterization on a ramp: ratio of adjacent-step ΔE (pred / meas)
function rampPoster(patches:Patch[], filt:(p:Patch)=>boolean): {ratio:number; inv:number; n:number} {
  const seq=patches.filter(filt).sort((a,b)=>a.ink-b.ink)
  if(seq.length<3)return {ratio:NaN,inv:0,n:seq.length}
  let predStep=0,measStep=0,inv=0
  for(let i=1;i<seq.length;i++){
    const a=seq[i-1],b=seq[i]
    const predD=deltaE00(a.Lp,...labAB(a.predSpec),b.Lp,...labAB(b.predSpec))
    const measD=deltaE00(a.Lm,...labAB(a.measSpec),b.Lm,...labAB(b.measSpec))
    predStep+=predD; measStep+=measD
    // solarization: measured L* decreases with ink (b darker), predicted goes opposite
    if((b.Lm-a.Lm)*(b.Lp-a.Lp)<-0.5)inv++
  }
  return {ratio:measStep>1e-6?predStep/measStep:NaN, inv, n:seq.length}
}
function labAB(spec:Float64Array):[number,number]{const l=spectraToLab(Array.from(spec));return[l[1],l[2]]}
const isNeutral=(p:Patch)=>Math.abs(p.rgb[0]-p.rgb[1])+Math.abs(p.rgb[1]-p.rgb[2])<=10 && p.ink>0.01
// single-channel-ish: dominant ink channel ramp (one device channel low, others≈high)
const isCyanRamp=(p:Patch)=>p.rgb[1]>200&&p.rgb[2]>200&&p.rgb[0]<240
const isMagRamp=(p:Patch)=>p.rgb[0]>200&&p.rgb[2]>200&&p.rgb[1]<240
const isYelRamp=(p:Patch)=>p.rgb[0]>200&&p.rgb[1]>200&&p.rgb[2]<240

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  // find the failing pairs
  const fails:PairAna[]=[]
  for(const a of profiles)for(const b of profiles){ if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    const nA=a.metadata.full_name,nB=b.metadata.full_name
    if(nA.includes('AllureAq')||nB.includes('AllureAq'))continue
    if(METALLIC_RE.test(nA)||METALLIC_RE.test(nB))continue
    const an=analysePair(a,b); if(!an)continue
    if(!(an.med<=1.5&&an.p95<=3.0))fails.push(an) }
  console.log(`Failing pairs: ${fails.length}\n`)

  // ── (A) per-pair pass fraction ────────────────────────────────────────────
  console.log('=== (A) Even failing pairs predict most of the chart — patch-level pass fraction ===')
  console.log(`  ${'pair'.padEnd(34)} ${'med/p95'.padEnd(12)} %ΔE≤2  %ΔE≤3  %ΔE>5  worst`)
  for(const f of fails){
    const t=f.patches.filter(p=>!p.isAnchor)
    const le2=100*t.filter(p=>p.de<=2).length/t.length
    const le3=100*t.filter(p=>p.de<=3).length/t.length
    const gt5=100*t.filter(p=>p.de>5).length/t.length
    const worst=Math.max(...t.map(p=>p.de))
    console.log(`  ${f.key.padEnd(34)} ${`${f.med.toFixed(2)}/${f.p95.toFixed(2)}`.padEnd(12)} ${le2.toFixed(0).padStart(4)}   ${le3.toFixed(0).padStart(4)}   ${gt5.toFixed(0).padStart(4)}   ${worst.toFixed(1)}`)
  }
  const allT=fails.flatMap(f=>f.patches.filter(p=>!p.isAnchor))
  console.log(`  ─ aggregate: %ΔE≤2=${(100*allT.filter(p=>p.de<=2).length/allT.length).toFixed(1)}  %ΔE≤3=${(100*allT.filter(p=>p.de<=3).length/allT.length).toFixed(1)}  %ΔE>5=${(100*allT.filter(p=>p.de>5).length/allT.length).toFixed(1)}`)

  // ── (B) tail error decomposition ──────────────────────────────────────────
  console.log('\n=== (B) Bad tail (ΔE>3) decomposition — hue shift / chroma / lightness ===')
  console.log(`  ${'pair'.padEnd(34)} nTail  meanΔL  meanΔC  meanΔh°  |Δh|>5%  ΔC<-1%(desat)`)
  for(const f of fails){
    const tail=f.patches.filter(p=>!p.isAnchor&&p.de>3)
    if(!tail.length){console.log(`  ${f.key.padEnd(34)} 0`);continue}
    const hueShift=100*tail.filter(p=>Math.abs(p.dh)>5).length/tail.length
    const desat=100*tail.filter(p=>p.dC<-1).length/tail.length
    console.log(`  ${f.key.padEnd(34)} ${String(tail.length).padStart(4)}  ${mean(tail.map(p=>p.dL)).toFixed(2).padStart(6)}  ${mean(tail.map(p=>p.dC)).toFixed(2).padStart(6)}  ${mean(tail.map(p=>p.dh)).toFixed(1).padStart(6)}   ${hueShift.toFixed(0).padStart(3)}     ${desat.toFixed(0).padStart(3)}`)
  }
  const allTail=fails.flatMap(f=>f.patches.filter(p=>!p.isAnchor&&p.de>3))
  console.log(`  ─ aggregate tail (n=${allTail.length}): meanΔL=${mean(allTail.map(p=>p.dL)).toFixed(2)} meanΔC=${mean(allTail.map(p=>p.dC)).toFixed(2)} meanΔh=${mean(allTail.map(p=>p.dh)).toFixed(1)}°`)
  console.log(`    dominant mode: ${classifyTail(allTail)}`)

  // ── (C/D) posterization + solarization on ramps ───────────────────────────
  console.log('\n=== (C/D) Posterization (pred/meas gradient ratio, <1=banding) + Solarization (L* inversions) ===')
  console.log(`  ${'pair'.padEnd(34)} neutral(ratio,inv)  cyan      magenta   yellow`)
  for(const f of fails){
    const ne=rampPoster(f.patches,isNeutral), cy=rampPoster(f.patches,isCyanRamp), mg=rampPoster(f.patches,isMagRamp), ye=rampPoster(f.patches,isYelRamp)
    const fmt=(r:{ratio:number;inv:number;n:number})=>`${isNaN(r.ratio)?'  -  ':r.ratio.toFixed(2)}/${r.inv}`
    console.log(`  ${f.key.padEnd(34)} ${fmt(ne).padEnd(18)}  ${fmt(cy).padEnd(8)}  ${fmt(mg).padEnd(8)}  ${fmt(ye)}`)
  }
  console.log('  (ratio = Σ pred adjacent ΔE / Σ meas adjacent ΔE; inv = # steps L* moves opposite to measured)')

  // ── (E) neighbour coherence: bias vs isolated jumps ───────────────────────
  console.log('\n=== (E) Neighbour coherence — is the tail a smooth local bias or isolated jumps? ===')
  for(const f of fails.slice(0,4)){
    // for each bad patch, nearest device neighbour (any), measure how aligned their error vectors are
    const bad=f.patches.filter(p=>!p.isAnchor&&p.de>3)
    let aligned=0,total=0
    for(const p of bad){
      let best=-1,bd=Infinity
      for(const q of f.patches){ if(q.idx===p.idx)continue
        const d=Math.abs(q.rgb[0]-p.rgb[0])+Math.abs(q.rgb[1]-p.rgb[1])+Math.abs(q.rgb[2]-p.rgb[2])
        if(d>0&&d<bd){bd=d;best=q.idx} }
      if(best<0)continue
      const q=f.patches.find(x=>x.idx===best)!
      // error-vector cosine in (dL,dC,dh) space
      const dot=p.dL*q.dL+p.dC*q.dC+p.dh*q.dh
      const np=Math.hypot(p.dL,p.dC,p.dh),nq=Math.hypot(q.dL,q.dC,q.dh)
      if(np>0.5&&nq>0.5){total++; if(dot/(np*nq)>0.6)aligned++}
    }
    console.log(`  ${f.key.padEnd(34)} neighbour error-vector aligned: ${total?(100*aligned/total).toFixed(0):'-'}% (${aligned}/${total}) → ${total&&aligned/total>0.6?'SMOOTH BIAS (recoverable)':'mixed/isolated'}`)
  }

  // example worst patches with full decomposition
  console.log('\n=== Worst 10 patches: nature of error ===')
  const worst=allT.sort((a,b)=>b.de-a.de).slice(0,10)
  console.log(`  ΔE    RGB             ink   ΔL     ΔC     Δh°    nature`)
  for(const p of worst){
    const nat = Math.abs(p.dh)>5 ? `HUE-SHIFT ${p.dh>0?'+':''}${p.dh.toFixed(0)}°`
              : p.dC<-1.5 ? 'DESATURATED (toward gray)'
              : p.dC>1.5 ? 'OVERSATURATED'
              : Math.abs(p.dL)>2 ? (p.dL>0?'TOO LIGHT':'TOO DARK') : 'mixed'
    console.log(`  ${p.de.toFixed(1).padStart(4)}  (${p.rgb.join(',').padEnd(11)}) ${p.ink.toFixed(2)}  ${p.dL.toFixed(1).padStart(5)}  ${p.dC.toFixed(1).padStart(5)}  ${p.dh.toFixed(0).padStart(5)}   ${nat}`)
  }
}
function classifyTail(tail:Patch[]):string{
  const hue=tail.filter(p=>Math.abs(p.dh)>5).length/tail.length
  const desat=tail.filter(p=>p.dC<-1).length/tail.length
  const light=tail.filter(p=>Math.abs(p.dL)>2).length/tail.length
  const parts=[`hue-shift ${(100*hue).toFixed(0)}%`,`desat ${(100*desat).toFixed(0)}%`,`lightness ${(100*light).toFixed(0)}%`]
  return parts.join(', ')
}
main().catch(e => { console.error(e); process.exit(1) })
