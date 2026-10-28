// Private HTTP coverage. No desktop, Microsoft endpoint or Windows Tailscale
// process is launched; each provider and launcher belongs to this fixture.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer } from '../tests/helpers/rust-server.js';
import { generateQRSvg } from '../lib/qr.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const reportPath=join(root,'docs/_local/rust-connections-verification.json');
const report={status:'running',checkedAt:new Date().toISOString(),assertions:0,connectionsIntegrated:false,productionReady:false};
await mkdir(join(root,'docs/_local'),{recursive:true});
await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
const check=(actual,expected,message)=>{assert.deepEqual(actual,expected,message);report.assertions++;};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,message){for(let i=0;i<200;i++){if(await predicate())return;await pause(25)}throw new Error(message)}
const provider=new WebSocketServer({host:'127.0.0.1',port:0});
await once(provider,'listening');
const calls=[],connections=new Set();
let mode='done';
provider.on('connection',(socket,request)=>{
  connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});
  let config;
  socket.on('message',bytes=>{
    const message=bytes.toString();
    if(message.includes('Path:speech.config')){config=message;return}
    const id=/X-RequestId:([^\r]+)/.exec(message)?.[1];
    assert.ok(id,'Private TTS request has an ID');
    const call={id,message,config,headers:request.headers,closed:false};calls.push(call);
    socket.on('close',()=>{call.closed=true});
    if(mode==='hold')return;
    const header=Buffer.from(`X-RequestId:${id}\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n`);
    const size=Buffer.alloc(2);size.writeUInt16BE(header.length);
    const payload=Buffer.from('ID3-private-audio-'+id);
    socket.send(Buffer.concat([size,header,payload]));
    if(mode==='partial'){socket.close();return}
    socket.send(`X-RequestId:${id}\r\nPath:turn.end\r\n\r\n`);
  });
});
let fixture,runtime;
async function request(base,path,body,method=body===undefined?'GET':'POST',headers={}){
  // Fetch rewrites Host to the URL authority. Raw HTTP is necessary to prove
  // acceptance and rejection of the advertised connection addresses.
  return new Promise((resolve,reject)=>{
    const request=httpRequest(new URL(base+path),{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})}},response=>{
      const chunks=[];response.on('error',reject);response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>{
        const bytes=Buffer.concat(chunks),text=bytes.toString();
        let data;try{data=JSON.parse(text)}catch{data=text}
        resolve({status:response.statusCode,data,bytes,headers:new Headers(Object.entries(response.headers).filter(([,value])=>value!==undefined).map(([key,value])=>[key,Array.isArray(value)?value.join(', '):value]))});
      });
    });
    request.setTimeout(15_000,()=>request.destroy(new Error('Private HTTP request timeout')));
    request.on('error',reject);request.end(body===undefined?undefined:JSON.stringify(body));
  });
}
const api=(path,body,method,headers)=>request(runtime.url,path,body,method,headers);
try{
  fixture=await startPortfolioServer({durable:false});
  const sandbox=join(fixture.directory,'rust'),bin=join(fixture.directory,'connection-bin'),launches=join(fixture.directory,'launches.jsonl');
  await mkdir(bin);await writeFile(launches,'');
  await writeFile(join(bin,'gnome-terminal'),`#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(launches)},JSON.stringify(process.argv.slice(2))+'\\n');\n`,{mode:0o700});
  fixture.env.PATH=bin+':'+fixture.env.PATH;
  fixture.env.COCKPIT_PREVIEW_TTS_URL=`ws://127.0.0.1:${provider.address().port}/private-speech`;
  const ips=[{ip:'192.0.2.20',type:'lan'},{ip:'100.64.0.20',type:'tailscale',host:'fixture.invalid'}];
  fixture.env.COCKPIT_PREVIEW_NETWORK_JSON=JSON.stringify(ips);
  const start=()=>startRustServer({root:join(fixture.directory,'app'),directory:sandbox,env:fixture.env});
  runtime=await start();await runtime.stop();
  await writeFile(join(sandbox,'projects.json'),await readFile(join(fixture.directory,'data/cockpit/projects.json')));
  runtime=await start();
  const token=(await readFile(join(sandbox,'.cockpit-token'),'utf8')).trim();
  for(const ip of ['192.0.2.20','100.64.0.20']) {
    const headers={host:`${ip}:${new URL(runtime.url).port}`,'x-forwarded-for':'192.0.2.10',cookie:`cockpit-token=${token}`};
    check((await api('/api/projects',undefined,'GET',headers)).status,200,'Discovered connection hosts work before opening the local connection popup');
  }
  check((await api('/api/projects',undefined,'GET',{host:'192.0.2.99','x-forwarded-for':'192.0.2.10',cookie:`cockpit-token=${token}`})).status,403,'Undiscovered IP hosts remain rejected even with a valid token');
  const unauthenticated=await api('/api/projects',undefined,'GET',{host:'192.0.2.20','x-forwarded-for':'192.0.2.10'});
  check(unauthenticated.headers.get('content-type')?.startsWith('text/html'),true,'An allowed LAN host still requires authentication');
  const lan=await api('/api/lan-info');
  check(lan.status,200,'Local connection information is available');
  check(lan.data.ips,ips,'Connection address order and types reach HTTP unchanged');
  check(lan.data.port,Number(new URL(runtime.url).port),'LAN information uses the actual bound port');
  check(lan.data.token,(await readFile(join(sandbox,'.cockpit-token'),'utf8')).trim(),'LAN information retains the existing private token');
  const remote={'x-forwarded-for':'192.0.2.10',cookie:`cockpit-token=${lan.data.token}`};
  check((await api('/api/lan-info',undefined,'GET',remote)).status,403,'Authenticated remote requests cannot read the LAN token');
  check((await api('/api/qr-code?data=test',undefined,'GET',remote)).status,403,'QR route remains local-only');
  const missing=await api('/api/qr-code');
  check(missing.status,400,'Missing QR data rejected');check(missing.data,'Missing data param','Original missing-data body');
  for(const text of ['private connection','http://192.0.2.20:3847/?token=fixture-only','한글 😀 <>&','x'.repeat(107),'x'.repeat(135),'x'.repeat(231),'x'.repeat(271)]){
    const qr=await api('/api/qr-code?data='+encodeURIComponent(text));
    check(qr.status,200,'QR route succeeds');
    check(qr.data.match(/viewBox="[^"]+"/)?.[0],generateQRSvg(text).match(/viewBox="[^"]+"/)?.[0],'Standard QR encoding preserves the original viewport size');
    check(qr.headers.get('content-type'),'image/svg+xml','QR SVG MIME type');check(qr.headers.get('cache-control'),'no-store','QR token images are not cached');
  }
  check((await api('/api/qr-code?data='+'x'.repeat(272))).status,400,'Too-long QR data is rejected instead of silently truncated');
  for(const body of [{},{text:''},{text:null},{text:false},{text:0}]){
    const [node,rust]=await Promise.all([request(fixture.url,'/api/agent/tts',body),api('/api/agent/tts',body)]);
    check({status:rust.status,data:rust.data},{status:node.status,data:node.data},'Original TTS validation contract');
  }
  check((await api('/api/agent/tts',{text:42})).status,400,'Non-string TTS input fails validation');
  check(calls.length,0,'Invalid input never opens a provider connection');
  const voices=await Promise.all(['first voice','second voice'].map(text=>api('/api/agent/tts',{text})));
  check(calls.length,2,'Concurrent requests use independent provider sockets');
  check(new Set(calls.map(call=>call.id)).size,2,'Concurrent speech requests have distinct IDs');
  for(let index=0;index<voices.length;index++){
    check(voices[index].status,200,'Private voice request succeeds');
    const call=calls.find(call=>call.message.includes(index===0?'first voice':'second voice'));
    check(voices[index].bytes,Buffer.from('ID3-private-audio-'+call.id),'Audio belongs to its own request');
    check(voices[index].headers.get('content-type'),'audio/mpeg','Voice MIME type');
    check(voices[index].headers.get('cache-control'),'no-store','Voice response is not cached');
    check(call.config.includes('audio-24khz-48kbitrate-mono-mp3'),true,'Configured MP3 format preserved');
  }
  await until(()=>calls.every(call=>call.closed),'Completed voice requests close their sockets');
  const text='a'.repeat(797)+'<😀ignored';
  check((await api('/api/agent/tts',{text})).status,200,'UTF-16 boundary request succeeds');
  check(calls.at(-1).message.includes('a'.repeat(797)+'&lt;😀'),true,'800 UTF-16 units are sliced before XML escaping');
  check(calls.at(-1).message.includes('ignored'),false,'Speech beyond the source limit is omitted');
  mode='partial';
  check((await api('/api/agent/tts',{text:'partial'})).status,500,'Partial audio cannot masquerade as completed synthesis');
  mode='done';
  await fixture.stop();
  check((await api('/api/sessions/missing/start',{})).status,404,'Unknown session project rejected');
  const launcherCalls=async()=>{const text=await readFile(launches,'utf8');return text.trim().split('\n').filter(Boolean).map(JSON.parse)};
  for(const [path,body,expected] of [
    ['/api/sessions/sample/start',{resume:true,model:'opus',prompt:'two words'},['--continue','--model','opus','-p','two words']],
    ['/api/sessions/sample/resume',{sessionId:'ABC-123'},['--resume','ABC-123']],
    ['/api/sessions/sample/resume',{sessionId:'oc:foreign'},['--continue']],
  ]){
    const before=(await launcherCalls()).length;
    const response=await api(path,body);
    check({status:response.status,data:response.data},{status:200,data:{launched:true,projectId:'sample'}},'Session launch accepts an explicit desktop transfer');
    await until(async()=>(await launcherCalls()).length===before+1,'Only the private launcher runs');
    const args=(await launcherCalls()).at(-1);
    check(args.slice(0,3),['--','bash','-c'],'Linux terminal invocation uses separate arguments');
    for(const argument of expected)check(args[3].includes("'"+argument+"'"),true,'Each Claude argument is separately quoted');
  }
  mode='hold';const before=calls.length;
  const pending=api('/api/agent/tts',{text:'shutdown-owned'});
  await until(()=>calls.length===before+1,'Held speech request begins');
  await runtime.stop();
  check((await pending).status,500,'Shutdown cancels an in-flight HTTP speech request');
  await until(()=>calls.at(-1).closed,'Shutdown closes the owned provider socket');
  runtime=await start();
  for(let index=0;index<15;index++)check((await api('/api/agent/tts',{})).status,400,'Invalid speech requests count toward the rate limit');
  const limited=await fetch(runtime.url+'/api/agent/tts',{method:'POST',body:'{broken',headers:{'content-type':'application/json'}});
  check(limited.status,429,'TTS rate limit precedes body parsing');
  check(calls.length,before+1,'Rate-limited requests never open provider sockets');
  report.connectionsIntegrated=true;report.status='passed';
}catch(error){report.status='failed';throw error}
finally{
  await runtime?.stop();await fixture?.cleanup();
  for(const socket of connections)socket.terminate();
  await new Promise(resolve=>provider.close(resolve));
  report.checkedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
}
