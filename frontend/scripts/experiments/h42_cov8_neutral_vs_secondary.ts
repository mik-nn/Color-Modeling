// H42 — cov8: do 2 extra NEUTRAL levels recover the FLIP pairs cheaper than secondaries?
//
// H41 found the cov6→S1-12 gap (12 FLIP pairs) is a heavy-ink P95 tail, recovered
// by S1's extra NEUTRALS. Test whether +2 neutral levels (gray64,gray192) on top of
// cov6 recover those 12 — vs +2 secondaries (red,green) as a control.
//
// Tiers: cov6 | cov8n = cov6+gray64+gray192 | cov8s = cov6+red+green | cov9 = cov6+R+G+B | S1-12
//
// Run: cd frontend && bash -l -c "nvm use 20 && npx tsx scripts/experiments/h42_cov8_neutral_vs_secondary.ts"

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
import { extractOBAEmission, computeOBAFactorPerPatch, subtractOBA, addOBA } from '../../src/lib/predict/obaSeparator'
import { spectraToLab, deltaE00 } from '../../src/lib/colormath'
import { canonicalPrintMode } from '../../src/utils/printMode'
import type { ProfileData } from '../../src/types'

const PROFILES_ROOT = path.resolve(process.cwd(), '..', 'data/profiles')
const L = 36, D1_RANK = 5, D1_UV = 4
const METALLIC_RE = /Silverada|VibranceMetallic/i

const COV6: Array<[number,number,number]> = [[255,255,255],[0,255,255],[255,0,255],[255,255,0],[0,0,0],[128,128,128]]
const COV8N: Array<[number,number,number]> = [...COV6,[64,64,64],[192,192,192]]
const COV8S: Array<[number,number,number]> = [...COV6,[255,0,0],[0,255,0]]
const COV9:  Array<[number,number,number]> = [...COV6,[255,0,0],[0,255,0],[0,0,255]]

const median = (xs:number[])=>{ if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2 }
const p95 = (xs:number[])=>{ if(!xs.length)return NaN; const s=[...xs].sort((a,b)=>a-b); return s[Math.min(s.length-1,Math.round(0.95*(s.length-1)))] }

async function walk(dir:string):Promise<string[]>{ const out:string[]=[]; let e:import('node:fs').Dirent[]
  try{ e=await fs.readdir(dir,{withFileTypes:true}) }catch{ return out }
  for(const d of e){ const f=path.join(dir,d.name); if(d.isDirectory())out.push(...await walk(f)); else if(d.isFile()&&/\.(icm|icc)$/i.test(d.name))out.push(f) } return out }
type LP = ProfileData & { wavelengths:number[] }
async function loadProfile(fp:string):Promise<LP|null>{ try{
  const buf=await fs.readFile(fp); const ab=buf.buffer.slice(buf.byteOffset,buf.byteOffset+buf.byteLength)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r=await parseIcmFile({arrayBuffer:async()=>ab} as any)
  if(!r.hasSpectral||!r.measurements.length)return null
  const name=path.basename(fp).replace(/\.(icm|icc)$/i,''); let preset:string; try{preset=canonicalPrintMode(name)}catch{return null}
  return {metadata:{full_name:name,brand:'BC',series:name,printer:'P9000',ink:'mk',substrate:name,parsed_at:new Date().toISOString(),printMode:preset},
    raw:r.measurements,clean:r.measurements,has_spectral:true,patch_count:r.measurements.length,
    wavelengths:r.wavelengths??Array.from({length:36},(_,i)=>380+i*10)} }catch{return null} }

interface Built{N:number;X_A_clean:Float64Array;X_B_clean:Float64Array;X_B_orig:Float64Array;D:Float64Array;fB:Float64Array;emB:Float64Array;paperRowIdx:number;sampleIds:string[];anchorIdx13:number[]}
function build(pA:LP,pB:LP):Built|null{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const al=alignProfiles(loadProfileMatrix(pA as any),loadProfileMatrix(pB as any)); if(al.N<100)return null
  const {N,X_A,X_B,D,sampleIds,wavelengths}=al; const wl=wavelengths??Array.from({length:L},(_,i)=>380+i*10)
  let paperRowIdx=0; for(let i=0;i<N;i++)if(D[i*3]===255&&D[i*3+1]===255&&D[i*3+2]===255){paperRowIdx=i;break}
  const emA=extractOBAEmission(Array.from(X_A.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const emB=extractOBAEmission(Array.from(X_B.subarray(paperRowIdx*L,paperRowIdx*L+L)))
  const fA=computeOBAFactorPerPatch(X_A,L,paperRowIdx),fB=computeOBAFactorPerPatch(X_B,L,paperRowIdx)
  const X_A_clean=subtractOBA(X_A,L,fA,emA.emission),X_B_clean=subtractOBA(X_B,L,fB,emB.emission)
  const tgt={X:X_B,D,channels:3 as const,N,L,wavelengths:wl,sampleIds,droppedCount:0}
  const anchorIdx13=(pickHeuristicAnchors(tgt).meta?.chosenIdx as number[]).slice(0,13)
  return {N,X_A_clean,X_B_clean,X_B_orig:X_B,D,fB,emB:emB.emission,paperRowIdx,sampleIds,anchorIdx13} }
function covAnchors(b:Built,targets:Array<[number,number,number]>):number[]{ const chosen:number[]=[]
  for(const [tr,tg,tb] of targets){ let best=-1,bestD=Infinity
    for(let i=0;i<b.N;i++){ const dd=(b.D[i*3]-tr)**2+(b.D[i*3+1]-tg)**2+(b.D[i*3+2]-tb)**2; if(dd<bestD){bestD=dd;best=i} }
    if(best>=0&&!chosen.includes(best))chosen.push(best) } return chosen }
function passD1(b:Built,anchorIdx:number[]):boolean{ const aset=new Set(anchorIdx)
  const paperWP=paperWPFromBrightestPatch(new Float64Array(b.X_B_orig.subarray(b.paperRowIdx*L,b.paperRowIdx*L+L)),1,L,380)
  const d1=runPaperRatioResidualTransfer({X_A:b.X_A_clean,X_B:b.X_B_clean,D:b.D,sampleIds:b.sampleIds,anchorIdx,paperRowIdx:b.paperRowIdx,L,paperWP,refProfile:'A',targetProfile:'B',residualRank:D1_RANK,knnK:4,uvBandCount:D1_UV})
  const pred=addOBA(d1.X_pred,L,b.fB,b.emB); const des:number[]=[]
  for(let i=0;i<b.N;i++){ if(aset.has(i))continue
    const lp=spectraToLab(Array.from(pred.subarray(i*L,i*L+L))),lm=spectraToLab(Array.from(b.X_B_orig.subarray(i*L,i*L+L)))
    des.push(deltaE00(lp[0],lp[1],lp[2],lm[0],lm[1],lm[2])) }
  return median(des)<=1.5 && p95(des)<=3.0 }

async function main(){
  const files=(await walk(PROFILES_ROOT)).sort()
  const profiles=(await Promise.all(files.filter(f=>path.basename(f).startsWith('BC_')).map(loadProfile))).filter(Boolean) as LP[]
  const pairs:Array<[LP,LP]>=[]
  for(const a of profiles)for(const b of profiles){ if(a===b||a.metadata.printMode!==b.metadata.printMode)continue
    const nA=a.metadata.full_name,nB=b.metadata.full_name
    if(nA.includes('AllureAq')||nB.includes('AllureAq'))continue
    if(METALLIC_RE.test(nA)||METALLIC_RE.test(nB))continue
    pairs.push([a,b]) }
  console.log(`Non-metallic same-mode pairs: ${pairs.length}\n`)

  const tiers:Record<string,number>={cov6:0,cov8n:0,cov8s:0,cov9:0,s12:0}
  let flipTotal=0; const flipRecover:Record<string,number>={cov8n:0,cov8s:0,cov9:0}
  for(const [pA,pB] of pairs){ const b=build(pA,pB); if(!b)continue
    const p6=passD1(b,covAnchors(b,COV6))
    const p8n=passD1(b,covAnchors(b,COV8N))
    const p8s=passD1(b,covAnchors(b,COV8S))
    const p9=passD1(b,covAnchors(b,COV9))
    const p12=passD1(b,b.anchorIdx13.slice(0,12))
    if(p6)tiers.cov6++; if(p8n)tiers.cov8n++; if(p8s)tiers.cov8s++; if(p9)tiers.cov9++; if(p12)tiers.s12++
    if(!p6&&p12){ flipTotal++; if(p8n)flipRecover.cov8n++; if(p8s)flipRecover.cov8s++; if(p9)flipRecover.cov9++ }
  }
  const n=pairs.length, pc=(x:number)=>`${x} (${(100*x/n).toFixed(1)}%)`
  console.log('=== Pass rate by tier ===')
  console.log(`  cov6  (6): ${pc(tiers.cov6)}`)
  console.log(`  cov8n (8 = cov6+gray64+gray192): ${pc(tiers.cov8n)}`)
  console.log(`  cov8s (8 = cov6+red+green):       ${pc(tiers.cov8s)}`)
  console.log(`  cov9  (9 = cov6+R+G+B):           ${pc(tiers.cov9)}`)
  console.log(`  S1-12 (12):${pc(tiers.s12)}`)
  console.log(`\n=== FLIP recovery (of the ${flipTotal} fail@cov6 & pass@S1-12 pairs) ===`)
  console.log(`  cov8n (+2 neutrals)  recovers: ${flipRecover.cov8n}/${flipTotal}`)
  console.log(`  cov8s (+2 secondary) recovers: ${flipRecover.cov8s}/${flipTotal}`)
  console.log(`  cov9  (+3 secondary) recovers: ${flipRecover.cov9}/${flipTotal}`)
}
main().catch(e=>{console.error(e);process.exit(1)})
