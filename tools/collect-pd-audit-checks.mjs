/** Summarize successful, saved test logs without rerunning or inflating assertion counts. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const base='artifacts/pd-spec-audit/';
const files=['npm-test.log','regression-real.log','browser-real.log'];
const logs=Object.fromEntries(await Promise.all(files.map(async file=>[file,await readFile(resolve(root,base+file),'utf8')])));
const main=logs['npm-test.log'];
function need(file,pattern){const match=logs[file].match(pattern);if(!match)throw new Error(`Missing successful evidence in ${file}: ${pattern}`);return match;}
for(const [file,log] of Object.entries(logs)){
  if(/(?:^|\n)\s*(?:FAIL\b|✘)|\b[1-9]\d* failed\b|[1-9]\d* 失败/u.test(log))throw new Error(`Failure in ${file}`);
}
need('npm-test.log',/版本号一致。/);
const syntax=Number(need('npm-test.log',/语法检查通过（(\d+) 个文件）/)[1]);
const self=Number(need('npm-test.log',/(\d+) passed, 0 failed/)[1]);
need('npm-test.log',/PD specification compliance: 121 passed, 0 failed/);
need('npm-test.log',/10 browser profile checks passed/);
const build=need('npm-test.log',/体积\s+([\d.]+) KB\s+模块\s+(\d+) 个，源码 ([\d.]+) KB/);
const regression=Number(need('regression-real.log',/(\d+) regression checks passed/)[1]);
const browser=Number(need('browser-real.log',/(\d+) browser export checks passed/)[1]);
const e2e=[...main.matchAll(/(\d+) 通过, 0 失败(?:, (\d+) 跳过)?/g)].map(m=>({passed:Number(m[1]),skipped:Number(m[2]||0)}));
if(e2e.length!==6)throw new Error(`Expected six end-to-end flows, got ${e2e.length}`);
need('npm-test.log',/GoodCRC 6 条 · 有效 6 · 已配对 6 · 未配对 0/);
need('npm-test.log',/ID 不符 0\/6.*全部正确/);
const flows=['ATK-C PD','POWER-Z PD SQLite','UFCS SQLite','多文件切换','PD 记录流','UFCS 记录流'];
const results=[
  {name:'npm test：所有串联阶段成功完成',command:'npm test',pass:true,log:base+'npm-test.log'},
  {name:`版本一致性及语法检查：${syntax} 个文件`,pass:true,count:syntax},
  {name:`单文件构建：${build[1]} KB / ${build[2]} 模块 / 源码 ${build[3]} KB`,pass:true},
  {name:`核心自测：${self} 组通过 / 0 失败`,pass:true,count:self},
  {name:'GoodCRC 合成关联：6 个 MessageID 正确配对',pass:true,count:6},
  ...e2e.map((r,i)=>({name:`浏览器 ${flows[i]}：${r.passed} 断言通过、${r.skipped} 跳过`,pass:true,count:r.passed,skipped:r.skipped})),
  {name:`含真实样本数据回归：${regression} 项通过`,command:'node tools/regression.mjs --real',pass:true,count:regression,log:base+'regression-real.log'},
  {name:`含真实样本浏览器与 Node CSV 一致性：${browser} 项通过`,command:'node tools/ui-regression.mjs --real',pass:true,count:browser,log:base+'browser-real.log'}
];
const output={suite:'完整回归、构建与真实样本验证',generatedAt:new Date().toISOString(),passed:results.length,failed:0,results,
  notes:['此处计数表示检查阶段；阶段内的断言数量另列，不能与规范条款数量等同。',`六组端到端流程合计 ${e2e.reduce((n,r)=>n+r.passed,0)} 个断言通过，${e2e.reduce((n,r)=>n+r.skipped,0)} 个因样本缺少对应数据而跳过；跳过不代表通过。`,'日志由本次已成功执行的命令保存；收集器校验成功摘要并保存日志指纹。'],
  logs:Object.fromEntries(Object.entries(logs).map(([file,log])=>[base+file,{sha256:createHash('sha256').update(log).digest('hex')}]))};
await writeFile(resolve(root,base+'final-checks.json'),JSON.stringify(output,null,2)+'\n');
console.log(`Collected ${results.length} successful phases; ${e2e.length} browser flows.`);
