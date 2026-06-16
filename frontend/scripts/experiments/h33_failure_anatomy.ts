// H33 — Failure anatomy: which patches, which wavelengths, which substrates.
//
// Answers three questions about where the D1 pipeline stops working:
//   (P) WHICH PATCHES are mispredicted — bin test-patch ΔE by gamut sector
//       (binarised C/M/Y → 8 classes) and ink coverage; worst sectors + worst
//       patches per failing pair.
//   (W) WHICH WAVELENGTHS diverge — per-λ mean |residual| (reflectance) for the
//       12 structural failers vs the passers → spectral signature of the cause.
//   (S) WHICH SUBSTRATE PROPERTY predicts failure — per substrate: failing-pair
//       frequency vs paper-white b*/curvature, neutral-ramp spreading curvature,
//       gamut chroma. What separates the hard substrates from the rest.
//
// All at S1 k=13 (the model's best). Non-metallic same-mode pairs.
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h33_failure_anatomy.ts"

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).DOMParser = jsdom.window.DOMParser
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
const WL = Array.from({ length: L }, (_, i) => 380 + i * 10)

const mean = (xs: number[]) => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : NaN
const median = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs: number[]) => { if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r=await parseIcmFile({arrayBuffer:async()=>ab} as any)
    if(!r.hasSpectral||!r.measurements.length)return null
    const name=path.basename(fp).replace(/\.(icm|icc)$/i,'')
    let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
    return {metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
      raw:r.measurements,clean:r.measurements,has_spectral:true,patch_count:r.measurements.length,
      wavelengths:r.wavelengths??WL.slice()}
  } catch { return null }
}
const short = (n: string) => n.replace(/^BC_/, '').replace(/_P9000_.+/, '')

// gamut sector by binarised CMY (>0.5)
const SECTORS = ['light','C','M','Y','C+Y(green)','C+M(blue)','M+Y(red)','C+M+Y(dark)']
function sectorOf(c:number,m:number,y:number): number {
  const C=c>0.5?1:0, M=m>0.5?1:0, Y=y>0.5?1:0
  if(!C&&!M&&!Y) return 0
  if(C&&!M&&!Y) return 1
  if(!C&&M&&!Y) return 2
  if(!C&&!M&&Y) return 3
  if(C&&!M&&Y) return 4
  if(C&&M&&!Y) return 5
  if(!C&&M&&Y) return 6
  return 7
}

interface PatchErr { de:number; ink:number; sector:number; rgb:[number,number,number]; resid:Float64Array }
interface PairEval { key:string; ref:string; tgt:string; pass:boolean; patches:PatchErr[]; perLambdaAbsResid:Float64Array }

function evalPair(pA:LP, pB:LP): PairEval | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al=alignProfiles(loadProfileMatrix(pA as any),loadProfileMatrix(pB as any)); if(al.N<100)return null
  const {N,X_A,X_B,D,sampleIds,wavelengths}=al
  const wl=wavelengths??WL.slice()
  let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  const emA=extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const emB=extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const fA=computeOBAFactorPerPatch(X_A,L,paperRowIdx), fB=computeOBAFactorPerPatch(X_B,L,paperRowIdx)
  const XA_c=subtractOBA(X_A,L,fA,emA.emission), XB_c=subtractOBA(X_B,L,fB,emB.emission)
  const paperWP=paperWPFromBrightestPatch(new Float64Array(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)),1,L,380)
  const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wl,sampleIds,droppedCount:0}
  const anchorIdx=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,K)
  const anchorSet=new Set(anchorIdx)
  const d1=runPaperRatioResidualTransfer({X_A:XA_c,X_B:XB_c,D,sampleIds,anchorIdx,paperRowIdx,L,paperWP,
    refProfile:pA.metadata.full_name,targetProfile:pB.metadata.full_name,residualRank:RANK,knnK:4,uvBandCount:UV})
  const pred=addOBA(d1.X_pred,L,fB,emB.emission)
  const paperB = X_B.subarray(paperRowIdx*L, paperRowIdx*L+L)

  const patches:PatchErr[]=[]; const des:number[]=[]
  const perLam=new Float64Array(L); let cnt=0
  for(let i=0;i<N;i++){ if(anchorSet.has(i))continue
    const pv=Array.from(pred.subarray(i*L,i*L+L)), mv=Array.from(X_B.subarray(i*L,i*L+L))
    const lp=spectraToLab(pv), lm=spectraToLab(mv)
    const de=deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2]); des.push(de)
    const c=(255-D[i*3])/255, m=(255-D[i*3+1])/255, y=(255-D[i*3+2])/255
    const resid=new Float64Array(L)
    for(let l=0;l<L;l++){ const r=(pv[l]-mv[l])/Math.max(paperB[l],1e-3); resid[l]=r; perLam[l]+=Math.abs(r) }
    cnt++
    patches.push({de,ink:c+m+y,sector:sectorOf(c,m,y),rgb:[D[i*3],D[i*3+1],D[i*3+2]],resid})
  }
  for(let l=0;l<L;l++)perLam[l]/=Math.max(cnt,1)
  const med=median(des),p=p95(des)
  return {key:`${short(pA.metadata.full_name)}→${short(pB.metadata.full_name)}`,ref:short(pA.metadata.full_name),
    tgt:short(pB.metadata.full_name),pass:med<=1.5&&p<=3.0,patches,perLambdaAbsResid:perLam}
}

// substrate-level properties
function substrateProps(p:LP): {b_star:number; curvature:number; spreadCurv:number; maxChroma:number} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m=loadProfileMatrix(p as any); const {X,D,N}=m
  let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  const paper=Array.from(X.subarray(paperRowIdx*L,paperRowIdx*L+L))
  const lab=spectraToLab(paper)
  // spectral curvature of paper white = mean |2nd diff|
  let curv=0; for(let l=1;l<L-1;l++)curv+=Math.abs(paper[l+1]-2*paper[l]+paper[l-1]); curv/=(L-2)
  // neutral-ramp spreading curvature at 560 (||c1,c2||)
  const IDX560=18; const pv560=Math.max(paper[IDX560],1e-4)
  const xs:number[]=[],ys:number[]=[]
  for(let i=0;i<N;i++){const r=D[i*3],g=D[i*3+1],b=D[i*3+2]; if(Math.abs(r-g)+Math.abs(g-b)>10)continue
    const a=(765-r-g-b)/765; if(a<0.01)continue; xs.push(a); ys.push(X[i*L+IDX560]/pv560)}
  let c1=0,c2=0
  if(xs.length>=2){ let S11=0,S12=0,S22=0,T1=0,T2=0
    for(let i=0;i<xs.length;i++){const x=xs[i],x2=x*x,rr=ys[i]-1; S11+=x*x;S12+=x*x2;S22+=x2*x2;T1+=x*rr;T2+=x2*rr}
    const det=S11*S22-S12*S12; if(Math.abs(det)>1e-18){c1=(T1*S22-T2*S12)/det;c2=(T2*S11-T1*S12)/det} }
  // max chroma over patches
  let maxC=0; for(let i=0;i<N;i++){const lp=spectraToLab(Array.from(X.subarray(i*L,i*L+L))); const ch=Math.hypot(lp[1],lp[2]); if(ch>maxC)maxC=ch}
  return {b_star:lab[2],curvature:curv,spreadCurv:Math.hypot(c1,c2),maxChroma:maxC}
}

async function main() {
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const pairs:Array<[LP,LP]>=[]
  for(const a of profiles)for(const b of profiles){ if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    const nA=a.metadata.full_name,nB=b.metadata.full_name
    if(nA.includes('AllureAq')||nB.includes('AllureAq'))continue
    if(METALLIC_RE.test(nA)||METALLIC_RE.test(nB))continue
    pairs.push([a,b]) }

  const evals:PairEval[]=[]
  for(const [a,b] of pairs){ const e=evalPair(a,b); if(e)evals.push(e) }
  const fail=evals.filter(e=>!e.pass), pass=evals.filter(e=>e.pass)
  console.log(`Pairs: ${evals.length} (fail ${fail.length}, pass ${pass.length})\n`)

  // ── (P) WHICH PATCHES ───────────────────────────────────────────────────────
  console.log('=== (P) WHICH PATCHES — ΔE by gamut sector (binarised CMY), k=13 ===')
  console.log(`  ${'sector'.padEnd(16)} ${'FAIL n'.padEnd(8)} mean  p95     ${'PASS n'.padEnd(8)} mean  p95`)
  for(let s=0;s<8;s++){
    const f=fail.flatMap(e=>e.patches.filter(p=>p.sector===s).map(p=>p.de))
    const g=pass.flatMap(e=>e.patches.filter(p=>p.sector===s).map(p=>p.de))
    console.log(`  ${SECTORS[s].padEnd(16)} ${String(f.length).padEnd(8)} ${mean(f).toFixed(2)}  ${p95(f).toFixed(2).padEnd(6)}  ${String(g.length).padEnd(8)} ${mean(g).toFixed(2)}  ${p95(g).toFixed(2)}`)
  }
  // worst sector excess (fail mean - pass mean)
  const excess=Array.from({length:8},(_,s)=>{
    const f=mean(fail.flatMap(e=>e.patches.filter(p=>p.sector===s).map(p=>p.de)))
    const g=mean(pass.flatMap(e=>e.patches.filter(p=>p.sector===s).map(p=>p.de)))
    return {s,exc:f-g}
  }).sort((a,b)=>b.exc-a.exc)
  console.log(`  Worst sectors by fail-excess: ${excess.slice(0,3).map(x=>`${SECTORS[x.s]}(+${x.exc.toFixed(2)})`).join(', ')}`)

  // ── (W) WHICH WAVELENGTHS ───────────────────────────────────────────────────
  console.log('\n=== (W) WHICH WAVELENGTHS — mean |residual| (reflectance, paper-normalised) ===')
  const fLam=new Float64Array(L), gLam=new Float64Array(L)
  for(const e of fail)for(let l=0;l<L;l++)fLam[l]+=e.perLambdaAbsResid[l]/fail.length
  for(const e of pass)for(let l=0;l<L;l++)gLam[l]+=e.perLambdaAbsResid[l]/pass.length
  console.log('  λ(nm)  FAIL   PASS   ratio')
  for(let l=0;l<L;l+=3) console.log(`  ${WL[l]}   ${fLam[l].toFixed(3)}  ${gLam[l].toFixed(3)}  ${(fLam[l]/Math.max(gLam[l],1e-4)).toFixed(2)}x`)
  let wMax=0,wl=0; for(let l=0;l<L;l++)if(fLam[l]-gLam[l]>wMax){wMax=fLam[l]-gLam[l];wl=WL[l]}
  console.log(`  Peak fail-excess at λ=${wl}nm (Δ|resid|=${wMax.toFixed(3)})`)

  // ── (S) WHICH SUBSTRATE PROPERTY ────────────────────────────────────────────
  console.log('\n=== (S) WHICH SUBSTRATE — failing-pair frequency vs properties ===')
  const subs=[...new Set(profiles.map(p=>short(p.metadata.full_name)))]
  const freq=new Map<string,number>()
  for(const e of fail)for(const s of [e.ref,e.tgt])freq.set(s,(freq.get(s)??0)+1)
  const propCache=new Map<string,ReturnType<typeof substrateProps>>()
  for(const p of profiles)if(!propCache.has(short(p.metadata.full_name)))propCache.set(short(p.metadata.full_name),substrateProps(p))
  console.log(`  ${'substrate'.padEnd(22)} failN  b*      curv    spreadCurv  maxChroma`)
  for(const s of subs.sort((a,b)=>(freq.get(b)??0)-(freq.get(a)??0))){
    const pr=propCache.get(s)!; const fn=freq.get(s)??0
    if(fn===0 && subs.indexOf(s)>13) continue
    console.log(`  ${s.padEnd(22)} ${String(fn).padEnd(6)} ${pr.b_star.toFixed(2).padStart(6)}  ${pr.curvature.toFixed(4)}  ${pr.spreadCurv.toFixed(3).padStart(6)}      ${pr.maxChroma.toFixed(1)}`)
  }
  // correlation of failN with each property
  const rows=subs.map(s=>({fn:freq.get(s)??0,...propCache.get(s)!}))
  const corr=(key:'b_star'|'curvature'|'spreadCurv'|'maxChroma')=>{
    const xs=rows.map(r=>r.fn), ys=rows.map(r=>Math.abs(r[key]))
    const mx=mean(xs),my=mean(ys); let sxy=0,sx=0,sy=0
    for(let i=0;i<xs.length;i++){const dx=xs[i]-mx,dy=ys[i]-my; sxy+=dx*dy;sx+=dx*dx;sy+=dy*dy}
    return sxy/Math.sqrt(sx*sy)
  }
  console.log(`\n  Pearson r(failN, |property|):  b*=${corr('b_star').toFixed(2)}  curvature=${corr('curvature').toFixed(2)}  spreadCurv=${corr('spreadCurv').toFixed(2)}  maxChroma=${corr('maxChroma').toFixed(2)}`)

  // worst patches across the failing pairs
  console.log('\n=== Worst 12 mispredicted patches (failing pairs) ===')
  const all=fail.flatMap(e=>e.patches.map(p=>({...p,key:e.key})))
  for(const p of all.sort((a,b)=>b.de-a.de).slice(0,12)){
    let wl=0,wm=0; for(let l=0;l<L;l++)if(Math.abs(p.resid[l])>wm){wm=Math.abs(p.resid[l]);wl=WL[l]}
    console.log(`  ΔE=${p.de.toFixed(2)}  RGB(${p.rgb.join(',')}) ${SECTORS[p.sector].padEnd(12)} ink=${p.ink.toFixed(2)}  worstλ=${wl}nm  ${p.key}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
