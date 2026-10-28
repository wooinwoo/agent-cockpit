import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';

let fixture, socket;
const until = async read => {
  const end = Date.now()+10_000;
  while (Date.now()<end) { const value = await read(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,50)); }
  throw new Error('Account usage fixture timed out');
};
try {
  fixture = await startPortfolioServer({ runtime:'rust', durable:false });
  await fixture.stop();
  const argumentsFile = join(fixture.directory,'login-arguments.json');
  const fake = join(fixture.project,'claude');
  await writeFile(fake, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(argumentsFile)},JSON.stringify(process.argv.slice(2)));\n`,{mode:0o700});
  fixture.env['BASH_FUNC_claude%%'] = `() { '${fake}' "$@"; }`;
  fixture.env.PATH = `${fixture.project}:${fixture.env.PATH}`;
  const journals = join(fixture.directory,'.jcode/sessions');
  await mkdir(journals,{recursive:true});
  const now = new Date().toISOString();
  const journal = {meta:{provider_key:'openai-oauth',model:'gpt-6.1-sol'},append_messages:[{id:'fixture-one',role:'assistant',timestamp:now,content:'fixture-private-content',token_usage:{input_tokens:1000,output_tokens:100,cache_read_input_tokens:900}}]};
  await writeFile(join(journals,'fixture.journal.jsonl'),JSON.stringify(journal)+'\n');
  const requestUsage = {schema:1,id:'request-one',timestamp:now,provider:'claude',email:'usage@example.invalid',model:'claude-opus-5-5',cache_ttl:'5m',input_tokens:1000,output_tokens:100,cache_read_input_tokens:900,cache_creation_input_tokens:0};
  const openaiUsage = {...requestUsage,id:'openai-workspace-one',provider:'openai',email:'workspaces@example.invalid',account_id:'workspace-one',model:'gpt-6.1-sol'};
  await writeFile(join(fixture.directory,'.jcode/account_usage.jsonl'),[requestUsage,openaiUsage,{...openaiUsage,id:'openai-workspace-two',account_id:'workspace-two',input_tokens:10_000}].map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  await fixture.start();
  const request = async (path,body,headers={}) => {
    const response = await fetch(fixture.url+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(8000)});
    return {status:response.status,data:await response.json()};
  };
  const created = await request('/api/ai-accounts',{name:'사용량 fixture',provider:'claude',email:'usage@example.invalid'});
  assert.equal(created.status,201);
  const account = created.data;
  await writeFile(join(account.homePath,'.credentials.json'),JSON.stringify({claudeAiOauth:{}}));
  const codex = (await request('/api/ai-accounts',{name:'워크스페이스 fixture',provider:'codex',email:'workspaces@example.invalid'})).data;
  await writeFile(join(codex.homePath,'auth.json'),JSON.stringify({tokens:{account_id:'workspace-one'}}));
  await mkdir(join(account.homePath,'projects/demo'),{recursive:true});
  await writeFile(join(account.homePath,'projects/demo/fixture.jsonl'),JSON.stringify({timestamp:now,message:{id:'fixture-request',model:'claude-opus-5-5',usage:{input_tokens:1000,output_tokens:100,cache_read_input_tokens:900}}})+'\n');
  let list;
  await until(async()=>{list=(await request('/api/ai-accounts')).data;return list.accounts[0]?.usage?.query?.code==='login_required'&&list.jcodeCosts?.pricedRequests===1;});
  assert.equal(list.usageRefreshSupported,true);
  assert.ok(list.accounts[0].usage.cost.weekUsd>0);
  assert.ok(list.jcodeCosts.weekUsd>0);
  assert.equal(list.jcodeCosts.accountAttribution,'unavailable');
  assert.equal(list.accounts[0].jcodeCost.pricedRequests,1);
  assert.ok(Math.abs(list.accounts[0].jcodeCost.weekUsd - 0.00618)<1e-10);
  assert.ok(Math.abs(list.accounts.find(a=>a.id===codex.id).jcodeCost.weekUsd - 0.00129)<1e-10,'Same email in a different workspace must not contaminate this account cost');
  assert.equal(list.jcodeCosts.pricedRequests,1,'Request ledger must not be added to overlapping legacy journal subtotal');
  assert.ok(!JSON.stringify(list).includes('fixture-private-content'));
  assert.ok(!JSON.stringify(list).includes(account.homePath));
  assert.equal((await request(`/api/ai-accounts/${account.id}/usage-refresh`,{})).status,200);
  await until(async()=> (await request('/api/ai-accounts')).data.accounts[0]?.usage?.query?.code==='login_required');
  assert.equal((await request('/api/ai-accounts/invalid/usage-refresh',{})).status,400);
  assert.equal((await request('/api/ai-accounts/ffffffffffffffff/usage-refresh',{})).status,404);
  assert.equal((await request(`/api/ai-accounts/${account.id}/usage-refresh`,{},{origin:'https://untrusted.example.invalid'})).status,403);
  const messages=[];
  socket=new WebSocket(fixture.url.replace('http:','ws:'));
  socket.on('message',message=>messages.push(JSON.parse(message)));
  await once(socket,'open');
  await until(()=>messages.some(message=>message.type==='terminals'));
  socket.send(JSON.stringify({type:'create',projectId:'sample',accountId:account.id,loginMode:true,cols:120,rows:30}));
  await until(async()=>{try{return JSON.parse(await readFile(argumentsFile,'utf8'));}catch{return false;}});
  assert.deepEqual(JSON.parse(await readFile(argumentsFile,'utf8')),['auth','login','--claudeai']);
  const duplicate = await request('/api/ai-accounts',{name:'중복 이메일 fixture',provider:'claude',email:'USAGE@example.invalid'});
  assert.equal(duplicate.status,201);
  const duplicatedList = (await request('/api/ai-accounts')).data;
  assert.ok(duplicatedList.accounts.filter(account=>account.provider==='claude').every(account=>!account.jcodeCost),'Ambiguous registered identities must not receive or double-count shared costs');
  console.log(JSON.stringify({status:'passed',checks:['Usage authentication failure is actionable without model calls','Local account and shared jcode API estimates are separated','Refresh route validates account IDs and CSRF','Login terminal invokes the current Claude CLI command','No credentials or prompt text in account responses']}));
} finally {
  socket?.close();
  await fixture?.cleanup();
}
