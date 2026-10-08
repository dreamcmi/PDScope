/** Validate report data/links and its actual offline desktop/narrow-browser rendering. */
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base=resolve(root,'artifacts/pd-spec-audit');
const snapshot=JSON.parse(await readFile(resolve(root,'doc/data/pd-standards-audit.json'),'utf8'));
const html=await readFile(resolve(root,'doc/pd-standards-audit.html'),'utf8');
const results=[];
const record=(name,extra={})=>results.push({name,pass:true,...extra});
assert.equal(snapshot.features.length,65);
assert.equal(new Set(snapshot.features.map(f=>f.id)).size,65);
for(const feature of snapshot.features){
  for(const version of ['2.0','3.0','3.1','3.2']){
    const row=feature.versions[version];assert.ok(row.status);assert.ok(row.refs.length,feature.id+'/'+version);
    for(const ref of row.refs){const page=Number(String(ref.page).match(/\d+/)?.[0]);assert.ok(page>=1&&page<=snapshot.sources[version].pages);}
  }
  assert.ok(feature.code.length,feature.id+' code');
  assert.ok(feature.evidence.length,feature.id+' evidence');
}
for(const item of [...snapshot.features,...snapshot.findings])for(const code of item.code){
  const lines=(await readFile(resolve(root,code.file),'utf8')).split(/\r?\n/);
  assert.ok(code.start>0&&code.start<=lines.length);
  if(code.anchor)assert.ok(lines[code.start-1].includes(code.anchor),`${code.file}:${code.start} anchor`);
  assert.equal(code.excerpt.split('\n')[0],`${code.start}  ${lines[code.start-1]}`);
}
record('65 个功能项：四版本引用、证据、唯一 ID 和当前代码片段均有效');
for(const [file,hash] of Object.entries(snapshot.hashes)){
  const bytes=await readFile(resolve(root,file));
  assert.equal(createHash('sha256').update(bytes).digest('hex'),hash,file+' snapshot drift');
}
record('原文和代码指纹匹配报告快照');
const hrefs=[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);
const ids=new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]));
for(const href of hrefs){
  if(href.startsWith('#')){assert.ok(ids.has(href.slice(1)),href);continue;}
  const path=decodeURI(href.split('#')[0].replaceAll('&amp;','&'));
  assert.ok((await stat(resolve(root,'doc',path))).isFile(),href);
  if(href.includes('#page=')){
    const source=Object.values(snapshot.sources).find(s=>resolve(root,s.file)===resolve(root,'doc',path));
    assert.ok(source,href);const page=Number(href.split('#page=')[1]);assert.ok(page>=1&&page<=source.pages,href);
  }
}
record(`全部 ${hrefs.length} 个本地链接和页码锚点有效`);
const expr=`(()=>{
  const checks=[];const ok=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
  const all=[...document.querySelectorAll('.feature-card')];
  ok('report API and 65 cards',window.PDScopeAudit?.ready&&all.length===65);
  ok('desktop/narrow no document overflow '+innerWidth+'/'+document.documentElement.scrollWidth+' '+JSON.stringify([...document.querySelectorAll('main *')].filter(e=>!e.closest('.table-scroll,pre')&&e.getBoundingClientRect().right>innerWidth+1).slice(0,10).map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right,text:e.textContent.slice(0,100)}))),document.documentElement.scrollWidth<=innerWidth+1);
  ok('nine navigation targets',[...document.querySelectorAll('nav a[href^="#"]')].every(a=>document.querySelector(a.getAttribute('href'))));
  const version=document.querySelector('#version'),status=document.querySelector('#status'),search=document.querySelector('#search');
  for(const v of ['2.0','3.0','3.1','3.2']){version.value=v;status.value='部分实现';status.dispatchEvent(new Event('input',{bubbles:true}));
    const expected=all.filter(a=>JSON.parse(a.dataset.status)[v]==='部分实现').length;
    ok('status filter '+v,all.filter(a=>!a.hidden).length===expected&&expected>0);
  }
  document.querySelector('#reset').click();search.value='SPR AVS';search.dispatchEvent(new Event('input',{bubbles:true}));
  ok('SPR AVS search finds feature',all.some(a=>!a.hidden&&a.querySelector('h3').textContent.includes('SPR AVS')));
  search.value='__no_such_feature__';search.dispatchEvent(new Event('input',{bubbles:true}));
  ok('empty filter state',all.every(a=>a.hidden)&&getComputedStyle(document.querySelector('#empty')).display!=='none');
  document.querySelector('#reset').click();ok('filter reset',all.every(a=>!a.hidden));
  const code=document.querySelector('.feature-card details.code');code.open=true;ok('code expands',getComputedStyle(code.querySelector('pre')).display!=='none');code.open=false;
  window.scrollTo(0,0);return {checks,width:innerWidth,cards:all.length,fixed:document.querySelectorAll('.finding .badge.ok').length};
})()`;
for(const [label,width,height,dbg] of [['desktop',1680,1000,212],['narrow',390,844,213]]){
  const screenshot=`artifacts/pd-spec-audit/report-${label}.png`;
  const run=spawnSync(process.execPath,['tools/e2e.mjs','--file','doc/pd-standards-audit.html','--width',String(width),'--height',String(height),'--dbg',String(dbg),'--eval',expr,'--out',screenshot],{cwd:root,encoding:'utf8',timeout:60000});
  await writeFile(resolve(base,`report-${label}.log`),(run.stdout||'')+(run.stderr||''));
  assert.equal(run.status,0,(run.stdout||'')+(run.stderr||''));
  assert.match(run.stdout,new RegExp('"width": '+width));
  record(`${label} 离线浏览器：筛选、导航、代码展开及布局通过`,{screenshot});
}
const output={suite:'HTML 报告内容、链接与浏览器验证',generatedAt:new Date().toISOString(),passed:results.length,failed:0,results};
await writeFile(resolve(base,'report-qa-results.json'),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify(output,null,2));
