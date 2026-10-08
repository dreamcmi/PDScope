/** Selected PDF baseline through the standalone browser, UI selector, tabs and CSV API. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const dir='artifacts/pd-spec-audit';
await mkdir(dir,{recursive:true});
const fixtureBuild=spawnSync(process.execPath,['tools/make-test-ufcs.mjs','--stream-out',`${dir}/ufcs.ufcsStream`],{encoding:'utf8',timeout:30000});
assert.equal(fixtureBuild.status,0,fixtureBuild.stderr);
const fixture=pathToFileURL(resolve(dir,'profiles.pdStream')).href;
const checks=[];
for(const profile of ['2.0','3.0','3.1','3.2']) {
  const r=spawnSync(process.execPath,['tools/cli.js',`${dir}/profiles.pdStream`,'--csv','--spec',profile],{encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);
  await writeFile(`${dir}/profile-${profile}.csv`,r.stdout.replace(/\n$/,''),'utf8');
  checks.push(`browser/CLI CSV baseline ${profile}`);
}
const refs=Object.fromEntries(['2.0','3.0','3.1','3.2'].map(p=>[p,pathToFileURL(resolve(dir,`profile-${p}.csv`)).href]));
const ufcs=pathToFileURL(resolve(dir,'ufcs.ufcsStream')).href;
const expression=`(async()=>{
  if(!window.PDScope?.ready)throw new Error('PDScope 未就绪');
  const bytes=new Uint8Array(await(await fetch(${JSON.stringify(fixture)})).arrayBuffer());
  const refs=${JSON.stringify(refs)};
  for(const profile of ['2.0','3.0','3.1','3.2']) {
    const r=await window.PDScope.exportCsv({name:'profiles-'+profile+'.pdStream',bytes,specRevision:profile,bom:false});
    const ref=await(await fetch(refs[profile])).text();
    if(r.csv!==ref)throw new Error(profile+' 浏览器/CLI CSV 不一致');
    if(window.PDScope.status().specRevision!==profile)throw new Error('当前文件规范未保存');
    if(document.querySelector('#specRevision').value!==profile)throw new Error('下拉选择未同步');
  }
  await window.PDScope.activateTab(0);
  if(window.PDScope.status().specRevision!=='2.0'||document.querySelector('#specRevision').value!=='2.0')throw new Error('标签间规范配置串用');
  await window.PDScope.setSpecRevision('3.1');
  if(window.PDScope.status().specRevision!=='3.1')throw new Error('API 切换规范失败');
  const select=document.querySelector('#specRevision');select.value='3.2';select.dispatchEvent(new Event('change',{bubbles:true}));
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,30));if(window.PDScope.tabs()[0]?.state==='done'&&window.PDScope.status().specRevision==='3.2')break;}
  if(window.PDScope.tabs()[0]?.state!=='done')throw new Error('下拉切换未完成重解析');
  document.querySelector('#btnReset').click();
  const input=document.querySelector('#fSearch');input.value='Source_Info';input.dispatchEvent(new Event('input',{bubbles:true}));
  await new Promise(r=>setTimeout(r,250));
  const row=[...document.querySelectorAll('#vrows .tr')].find(r=>r.textContent.includes('Source_Info'));
  if(!row)throw new Error('重解析后缺少 3.2 Source_Info');row.click();
  if(!document.querySelector('#detailBody').textContent.includes('SIDO2'))throw new Error('重解析未启用 SIDO2');
  await window.PDScope.activateTab(1);
  if(window.PDScope.status().specRevision!=='3.0')throw new Error('重解析改变了其它标签');
  let rejected=false;try{await window.PDScope.setSpecRevision('3.9');}catch{rejected=true;}
  if(!rejected)throw new Error('无效版本未拒绝');
  const ub=new Uint8Array(await(await fetch(${JSON.stringify(ufcs)})).arrayBuffer());
  await window.PDScope.exportCsv({name:'ufcs.ufcsStream',bytes:ub,bom:false});
  if(!document.querySelector('#specRevision').disabled)throw new Error('UFCS 应禁用 PD 规范选择');
  if(await window.PDScope.setSpecRevision('3.2')!==false)throw new Error('UFCS 应保持本协议解释');
  return {checks:10,profiles:['2.0','3.0','3.1','3.2'],csvMatches:true,selector:true,tabIsolation:true,ufcsUnaffected:true};
})()`;
const r=spawnSync(process.execPath,['tools/e2e.mjs','--file','dist/PDScope.html','--dbg','211','--eval',expression,'--out',`${dir}/profile-browser.png`],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
await writeFile(`${dir}/profile-browser.log`,r.stdout+'\n'+r.stderr,'utf8');
assert.equal(r.status,0,r.error?.message||r.stderr||r.stdout);
checks.push('per-file profile isolation','API reparses current capture','dropdown reparses Source_Info SIDO2','other tabs retain profile','invalid profile rejected','UFCS disables PD profile');
await writeFile(`${dir}/browser-profile-results.json`,JSON.stringify({suite:'browser profiles',passed:checks.length,failed:0,results:checks.map(name=>({name,pass:true}))},null,2)+'\n');
console.log(`${checks.length} browser profile checks passed`);
