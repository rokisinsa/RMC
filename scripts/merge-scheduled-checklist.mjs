#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const arg=n=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:null};
const read=p=>JSON.parse(fs.readFileSync(p,"utf8"));
const ms=x=>{const n=Date.parse(x||"");return Number.isFinite(n)?n:0};
const summary=checks=>{
  const x={pass:0,fail:0,blocked:0,pending:0,total:41};
  for(const c of checks)x[c.status]=(x[c.status]||0)+1;
  return x;
};
function mergeRun(current,incoming){
  if(!current) return incoming;
  if(current.status==="passed" && incoming.status!=="passed") return current;
  const byId=new Map((current.checks||[]).map(c=>[c.id,c]));
  for(const c of incoming.checks||[]){
    const old=byId.get(c.id);
    if(!old){byId.set(c.id,c);continue;}
    if(c.status==="pending" && old.status!=="pending") continue;
    if(ms(c.checked_at)>=ms(old.checked_at)) byId.set(c.id,c);
  }
  const checks=[...byId.values()].sort((a,b)=>a.id-b.id);
  const s=summary(checks);
  let status="running";
  if(checks[40]?.status==="pass" && s.pass===41) status="passed";
  else if(s.fail>0) status="failed";
  else if(s.blocked>0) status="blocked";
  const preserveProdBlocker=(current.blockers||[]).includes("production_validator_failed") && checks.slice(23,36).some(c=>c.status==="fail");
  let blockers=[...(incoming.blockers||[])];
  if(preserveProdBlocker) blockers.push("production_validator_failed");
  if(status==="passed") blockers=[];
  blockers=[...new Set(blockers)];
  return {
    ...current,
    ...incoming,
    prior_blockers: incoming.prior_blockers ?? current.prior_blockers ?? [],
    start_sha: current.start_sha || incoming.start_sha || null,
    end_sha: incoming.end_sha || current.end_sha || null,
    started_at: current.started_at || incoming.started_at,
    finished_at: status==="passed" ? (incoming.finished_at||current.finished_at) : (incoming.finished_at||current.finished_at||null),
    checks,summary:s,status,blockers,
    updated_at: ms(incoming.updated_at)>=ms(current.updated_at)?incoming.updated_at:current.updated_at
  };
}
function mergeDb(dst,src,runId){
  const incoming=(src.runs||[]).find(r=>r.run_id===runId);
  if(!incoming) throw new Error("incoming run missing: "+runId);
  const existing=(dst.runs||[]).find(r=>r.run_id===runId);
  const merged=mergeRun(existing,incoming);
  const map=new Map((dst.runs||[]).map(r=>[r.run_id,r]));
  map.set(runId,merged);
  const runs=[...map.values()].sort((a,b)=>ms(a.scheduled_for)-ms(b.scheduled_for)||String(a.run_id).localeCompare(String(b.run_id))).slice(-40);
  const eligible=runs.filter(r=>ms(r.scheduled_for)<=Date.now()+2*60*60*1000);
  const latest=(eligible.length?eligible:runs).at(-1)||null;
  return {schema_version:1,latest_run_id:latest?.run_id||null,runs};
}
function main(){
  const incomingPath=path.resolve(ROOT,arg("--incoming")||"");
  const targetPath=path.resolve(ROOT,arg("--target")||"data/scheduled-update-checklist.json");
  const runId=arg("--run-id");
  if(!runId||!arg("--incoming")) throw new Error("--incoming and --run-id required");
  const src=read(incomingPath);
  let dst={schema_version:1,latest_run_id:null,runs:[]};
  try{dst=read(targetPath)}catch{}
  const out=mergeDb(dst,src,runId);
  fs.mkdirSync(path.dirname(targetPath),{recursive:true});
  fs.writeFileSync(targetPath,JSON.stringify(out,null,2)+"\n");
  const r=out.runs.find(x=>x.run_id===runId);
  console.log(JSON.stringify({run_id:runId,status:r.status,summary:r.summary,latest_run_id:out.latest_run_id,blockers:r.blockers},null,2));
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main();
export {mergeRun,mergeDb};
