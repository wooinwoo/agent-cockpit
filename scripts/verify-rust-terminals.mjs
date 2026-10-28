import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile,writeFile,mkdir,readdir,rename } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startPortfolioServer } from '../tests/helpers/portfolio-server.js';
import { startRustServer, rustBuildProfile } from '../tests/helpers/rust-server.js';
import { workerScreenState } from '../lib/board-workers.js';
import { verifyControlTerminals } from '../tests/helpers/rust-control-terminals.js';
import { verifyInputTerminals } from '../tests/helpers/rust-input-terminals.js';
import { verifyWorkerTerminals } from '../tests/helpers/rust-worker-terminals.js';
import { verifySupervisorTerminals } from '../tests/helpers/rust-supervisor-terminals.js';
import { verifyAccountTerminals } from '../tests/helpers/rust-account-terminals.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const inputOnly=process.argv.includes('--input-only');
const workersOnly=process.argv.includes('--workers-only');
const supervisorsOnly=process.argv.includes('--supervisors-only');
const accountsOnly=process.argv.includes('--accounts-only');
const activityOnly=process.argv.includes('--activity-only')||inputOnly||workersOnly||supervisorsOnly||accountsOnly;
const fixture=await startPortfolioServer({durable:true});
const directory=join(fixture.directory,'rust-terminal');
const env={...fixture.env,PATH:`${fixture.project}:${fixture.env.PATH}`,COCKPIT_DURABLE_TERMINALS:'1'};
const tmuxEnv={...env,TMUX_TMPDIR:join(directory,'tmux')};
let server;
const clients=[];
let assertions=0;
const check=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);assertions++;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const quote=text=>`'${text.replaceAll("'","'\\''")}'`;
async function until(fn,label,timeout=10000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) {const result=await fn();if(result)return result;await sleep(40);}
  throw new Error(`Timed out: ${label}`);
}
async function api(path,options={}) {
  const response=await fetch(server.url+path,{...options,signal:AbortSignal.timeout(5000)});
  return {status:response.status,data:await response.json()};
}
async function connect(headers={}) {
  const ws=new WebSocket(server.url.replace('http:','ws:'),{headers,handshakeTimeout:3000});
  const messages=[];
  ws.on('message',data=>{messages.push(JSON.parse(data));});
  await once(ws,'open');
  const client={ws,messages,send:value=>ws.send(JSON.stringify(value)),wait:predicate=>until(()=>messages.find(predicate),'WebSocket message')};
  client.output=(id,marker)=>until(()=>messages.filter(m=>m.type==='output'&&m.termId===id).map(m=>m.data).join('').includes(marker),`Output ${marker}`);
  clients.push(client);
  client.initial=await client.wait(m=>m.type==='terminals');
  return client;
}
async function rejectSocket(headers) {
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(server.url.replace('http:','ws:'),{headers,handshakeTimeout:3000});
    ws.once('unexpected-response',(_request,response)=>{response.resume();ws.terminate();resolve(response.statusCode);});
    ws.once('open',()=>{ws.close();reject(new Error('Unauthorized WebSocket accepted'));});
    ws.on('error',reject);
  });
}
async function close(client) {
  if (client.ws.readyState>=WebSocket.CLOSING)return;
  const closed=once(client.ws,'close');client.ws.close();await closed;
}
async function checkpoint() {return JSON.parse(await readFile(join(directory,'session-state.json'),'utf8'));}
function tmux(id,args) {
  assert.match(id,/^[a-f0-9]{24}$/);
  return execFileSync('/usr/bin/tmux',['-L',`cockpit-${id}`,...args],{env:tmuxEnv,encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']}).trim();
}
async function input(client,id,data,receipt) {
  client.send({type:'input',termId:id,data,requestId:receipt});
  const ack=await client.wait(m=>m.type==='input-result'&&m.requestId===receipt);
  check(ack.accepted,true,`Input ${receipt}`);
}

try {
  const states=JSON.parse(await readFile(join(root,'tests/fixtures/rust-activity.json'),'utf8'));
  for(const item of states)check(workerScreenState({current:item.current!==false,lines:item.lines},item.agent,item),item.expected,'Shared Node screen-state contract');
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  check((await api('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'sample',name:'Sample',path:fixture.project})})).status,201,'Register terminal project');
  if(!activityOnly) {
  const token=await readFile(join(directory,'.cockpit-token'),'utf8');
  check(await rejectSocket({Host:'attacker.invalid'}),403,'WS DNS rebinding');
  check(await rejectSocket({Origin:'https://attacker.invalid'}),403,'WS foreign origin');
  check(await rejectSocket({'x-forwarded-for':'100.64.2.1'}),403,'WS proxy requires token');
  const remote=await connect({'x-forwarded-for':'100.64.2.1',Cookie:`cockpit-token=${token}`,Origin:server.url});
  check(remote.initial.active,[],'Authenticated remote WS');await close(remote);

  const one=await connect(),two=await connect();
  one.send({type:'create',projectId:'missing'});
  check((await one.wait(m=>m.type==='error')).message,'Unknown project','Reject unknown project');
  one.send({type:'create',projectId:'sample',cwd:fixture.directory});
  check((await one.wait(m=>m.type==='error'&&m.message.includes('cwd'))).message,'cwd must be inside project directory','Reject outside cwd');
  const counter=join(fixture.project,'one-shot.txt');
  const command=`node -e "require('fs').appendFileSync('${counter}','x')"`;
  one.send({type:'create',projectId:'sample',command,cols:80,rows:24});
  const created=await one.wait(m=>m.type==='created');
  const id=created.termId;
  check(created.durable,true,'Durable terminal');
  check((await two.wait(m=>m.type==='created')).termId,id,'Creation broadcast');
  check(created.alias,'ai1','Initial alias');
  const addTask = termId => api('/api/board/tasks', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'세션 업무',termId})});
  check((await addTask(created.alias)).status,400,'Session checklist requires fixed ID rather than alias');
  const ownedTask = await addTask(id);
  check(ownedTask.status,201,'Live terminal checklist creation');
  check(ownedTask.data.task.termId,id,'Checklist retains terminal fixed ID');
  await until(async()=>{try{return await readFile(counter,'utf8')==='x';}catch{return false;}},'one-shot initial launch');
  const saved=(await checkpoint()).terminals.find(t=>t.termId===id);
  const durable=saved.durableId;
  const pane=tmux(durable,['display-message','-p','-t','main','#{pane_pid}']);
  const dimensions=()=>tmux(durable,['display-message','-p','-t','main','#{pane_width} #{pane_height}']);
  await until(()=>dimensions()==='80 24','initial resize');
  check(tmux(durable,['show-options','-gv','mouse']),'on','Mouse enabled');
  check(tmux(durable,['list-keys','-T','root','WheelUpPane']).includes('PPage'),true,'Codex wheel fallback');
  two.send({type:'resize',termId:id,cols:40,rows:10});await sleep(150);check(dimensions(),'80 24','Non-owner resize ignored');
  two.send({type:'focus',termId:id,cols:99,rows:27});await until(()=>dimensions()==='99 27','focus claims resize');
  one.send({type:'resize',termId:id,cols:20,rows:5});await sleep(150);check(dimensions(),'99 27','Previous owner resize ignored');
  await close(two);
  one.send({type:'resize',termId:id,cols:90,rows:25});await until(()=>dimensions()==='90 25','disconnected owner releases resize');
  await input(one,id,`printf 'TERM=%s\\n' "$COCKPIT_TERM_ID"\r`,'env-check');
  await one.output(id,`TERM=${id}`);assertions++;
  await input(one,id,"printf '한%s글\\n' '😀'\r",'unicode-check');
  await one.output(id,'한😀글');assertions++;
  check((await api(`/api/terminals/${created.alias}/screen?lines=500`)).data.termId,id,'Alias screen');
  const forbidden=await fetch(server.url+`/api/terminals/${id}/screen`,{headers:{'x-forwarded-for':'100.64.2.1',cookie:`cockpit-token=${token}`}});
  check(forbidden.status,403,'Remote screen read blocked');
  one.send({type:'input',termId:'missing',data:'hello',requestId:'missing-input'});
  check((await one.wait(m=>m.requestId==='missing-input')).accepted,false,'Missing input rejected with receipt');
  one.send({type:'input',termId:id,data:'x'.repeat(1_000_001),requestId:'oversize'});
  check((await one.wait(m=>m.requestId==='oversize')).accepted,false,'Oversize input rejected');

  const subdir=join(fixture.project,'작업 폴더');await mkdir(subdir);
  await input(one,id,`cd ${quote(subdir)}; export RUST_RESTART_MARK=preserved; printf 'READY_%s\\n' restart\r`,'prepare-restart');
  await one.output(id,'READY_restart');
  await close(one);
  check((await api('/api/terminals')).data.terminals.length,1,'Disconnect preserves terminal');
  const reconnect=await connect();
  check(reconnect.initial.active[0].termId,id,'Reconnect identity');
  check(reconnect.initial.active[0].buffer.includes('한😀글'),true,'Reconnect Unicode replay');
  check((await api(`/api/terminals/${id}/conversation`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({held:true})})).status,200,'Persist conversation guard before forced stop');

  await until(async()=>(await checkpoint()).terminals[0].cwd===subdir,'Periodic cwd checkpoint before forced stop',40000);
  const crashed=once(server.child,'exit');server.child.kill('SIGKILL');await crashed;
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  const recovered=await connect();
  check(recovered.initial.active[0].termId,id,'Forced stop preserves terminal identity');
  check((await api('/api/terminals')).data.terminals.find(t=>t.termId===id).conversationHeld,true,'Forced stop restores conversation guard');
  check(tmux(durable,['display-message','-p','-t','main','#{pane_pid}']),pane,'Forced stop preserves running process');

  await server.stop();
  check(tmux(durable,['display-message','-p','-t','main','#{pane_pid}']),pane,'Server stop preserves tmux process');
  check((await checkpoint()).terminals[0].cwd,subdir,'Checkpoint saves actual cwd');
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  // No WS yet: an ordinary shutdown must preserve the pending checkpoint.
  await server.stop();
  check((await checkpoint()).terminals.length,1,'Stop before first WS preserves checkpoint');
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  const resumed=await connect();
  check(resumed.initial.idMap[id],id,'Restart maps fixed identity');
  check(resumed.initial.active[0].alias,'ai1','Restart preserves alias');
  check((await api('/api/terminals')).data.terminals.find(t=>t.termId===id).conversationHeld,true,'Graceful restart preserves conversation guard');
  check((await api(`/api/terminals/${id}/conversation`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({held:false})})).status,200,'Release restored guard');
  check((await api('/api/board')).data.tasks[0].termId,id,'Board ownership survives terminal/server restart');
  check(tmux(durable,['display-message','-p','-t','main','#{pane_pid}']),pane,'Restart reattaches same process');
  await input(resumed,id,`printf 'CONT=%s\\n' "$RUST_RESTART_MARK"\r`,'continued');
  await resumed.output(id,'CONT=preserved');assertions++;
  check(await readFile(counter,'utf8'),'x','Resumed terminal does not rerun launcher');

  await server.stop();
  tmux(durable,['kill-server']);
  const cold=await checkpoint();cold.timestamp=Date.now()-8*24*3600000;
  // Duplicate legacy rows must not attach the same pane twice.
  cold.terminals.push({...cold.terminals[0]});
  await writeFile(join(directory,'session-state.json'),JSON.stringify(cold));
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  const rebooted=await connect();
  check(rebooted.initial.active.length,1,'Duplicate checkpoint does not duplicate terminal');
  check(rebooted.initial.active[0].termId,id,'Old checkpoint survives cold boot');
  await input(rebooted,id,"printf 'COLD_%s\\n' alive\r",'cold-alive');
  await rebooted.output(id,'COLD_alive');assertions++;
  check(await readFile(counter,'utf8'),'x','Cold boot does not rerun one-shot job');
  rebooted.send({type:'kill',termId:id});
  await rebooted.wait(m=>m.type==='exit'&&m.termId===id);
  check((await api('/api/terminals')).data.terminals,[],'Explicit kill removes terminal');
  check((await checkpoint()).terminals,[],'Explicit kill persists removal');
  let alive=true;try{tmux(durable,['has-session','-t','main']);}catch{alive=false;}
  check(alive,false,'Explicit kill stops only fixture tmux');

  const deferredPath=join(fixture.directory,'deferred-project');
  await mkdir(deferredPath);
  check((await api('/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'한글',name:'한글',path:deferredPath})})).status,201,'Register Unicode project');
  rebooted.send({type:'create',projectId:'한글'});
  const korean=await rebooted.wait(m=>m.type==='created'&&m.projectId==='한글');
  check(korean.termId.startsWith('한글-'),true,'Unicode project creates terminal');
  check((await api(`/api/terminals/${encodeURIComponent(korean.termId)}/screen`)).data.termId,korean.termId,'Unicode terminal REST lookup');
  check((await api(`/api/projects/${encodeURIComponent('한글')}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'이름 변경'})})).status,200,'Unicode project update');
  check((await api(`/api/projects/${encodeURIComponent('한글')}/scripts`)).status,200,'Unicode project scripts lookup');
  rebooted.send({type:'kill',termId:korean.termId});
  await rebooted.wait(m=>m.type==='exit'&&m.termId===korean.termId);
  await server.stop();
  await writeFile(join(directory,'session-state.json'),JSON.stringify({terminals:[{termId:'한글-fixed',projectId:'한글',alias:'ai9',cwd:deferredPath,command:'',durableId:''}]}));
  await rename(deferredPath,deferredPath+'-offline');
  const plainEnv={...env,COCKPIT_DURABLE_TERMINALS:'0'};
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env:plainEnv});
  const waiting=await connect();
  check(waiting.initial.active,[],'Unavailable directory defers restore');
  await rename(deferredPath+'-offline',deferredPath);
  await until(()=>waiting.messages.some(m=>m.type==='terminals'&&m.active.some(t=>t.termId==='한글-fixed')),'Periodic deferred restore broadcast',40000);
  check((await api('/api/terminals')).data.terminals[0].termId,'한글-fixed','Deferred retry keeps Unicode identity');
  const plainCwd=join(deferredPath,'변경 경로');await mkdir(plainCwd);
  await input(waiting,'한글-fixed',`cd ${quote(plainCwd)}; printf 'PLAIN_%s\\n' ready\r`,'plain-cwd');
  await waiting.output('한글-fixed','PLAIN_ready');
  await server.stop();
  check((await checkpoint()).terminals[0].cwd,plainCwd,'Non-durable shutdown saves actual cwd');
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env:plainEnv});
  const plainRestored=await connect();
  check(plainRestored.initial.active[0].termId,'한글-fixed','Non-durable restart preserves Unicode identity');
  await input(plainRestored,'한글-fixed',`printf 'PWD=%s\\n' "$PWD"\r`,'plain-restored');
  await plainRestored.output('한글-fixed',`PWD=${plainCwd}`);assertions++;
  plainRestored.send({type:'kill',termId:'한글-fixed'});
  await plainRestored.wait(m=>m.type==='exit'&&m.termId==='한글-fixed');
  }

  await server.stop();
  server=await startRustServer({root:join(fixture.directory,'app'),directory,env});
  const monitor=await connect();
  const approval=['Do you want to proceed?','1. Yes','2. No'];
  const agentScreens={
    jcode:{i:['3>','~/sample ▱▱ 0% Claude Opus 5.5 xhigh'],b:['3…','~/sample ▱▱ 0% Claude Opus 5.5 xhigh'],a:approval,d:['3>','사용자 작성 중인 둘째 줄'],e:['invalid_request_error','3>']},
    claude:{i:['❯','? for shortcuts'],b:['✻ Working…','❯'],a:approval,d:['❯','사용자 작성 중인 둘째 줄'],e:['❯','unexpected warning']},
    codex:{i:['› Ask Codex to do anything','GPT-6.1-Sol xhigh'],b:['Working (esc to interrupt)','›'],a:approval,d:['›','사용자 작성 중인 둘째 줄'],e:['Reconnecting…','›']},
    vim:{i:['3>'],b:['3…'],a:approval,d:['draft'],e:['error']},
  };
  async function observed(id,expected) {
    const start=Date.now();
    let last;
    const observation=await until(async()=>{
      const activity=(await api('/api/terminals?activity=1')).data.terminals.find(t=>t.termId===id)?.activity;
      last=activity;
      return activity?.state===expected?activity:null;
    },`Activity ${expected}`).catch(async error=>{
      const screen=(await api(`/api/terminals/${id}/screen?lines=12`)).data;
      const saved=(await checkpoint()).terminals.find(t=>t.termId===id);
      const pane=saved?.durableId?tmux(saved.durableId,['display-message','-p','-t','main','#{pane_pid} #{pane_dead} #{pane_current_command}']):'';
      const processes=[];
      const queue=pane?[Number(pane.split(' ')[0])]:[];
      for(let index=0;index<queue.length&&index<8;index++) {
        const pid=queue[index];
        const stat=await readFile(`/proc/${pid}/stat`,'utf8').catch(()=>'?');
        processes.push({pid,stat});
        const children=await readFile(`/proc/${pid}/task/${pid}/children`,'utf8').catch(()=>'');
        queue.push(...children.split(/\s+/).filter(Boolean).map(Number));
      }
      throw new Error(`${error.message}; last=${JSON.stringify(last)}; screen=${JSON.stringify(screen)}; pane=${pane}; processes=${JSON.stringify(processes)}`);
    });
    check(observation.state,expected,'Current terminal state');
    check(observation.observedAt>=start,true,'Fresh observation timestamp');
    return observation;
  }
  for(const [agent,screens] of Object.entries(agentScreens)) {
    await writeFile(join(fixture.project,agent),`#!${process.execPath}\nconst screens=${JSON.stringify(screens)};\nfunction render(key){process.stdout.write('\\x1b[2J\\x1b[H'+screens[key].join('\\r\\n'));}\nprocess.stdin.setRawMode(true);process.stdin.resume();render('i');\nprocess.on('SIGCONT',()=>{process.stdin.setRawMode(true);render('i');});\nprocess.stdin.on('data',chunk=>{for(const key of chunk.toString()){if(key==='q')process.exit(0);if(key==='z')process.kill(process.pid,'SIGSTOP');if(screens[key])render(key);}});\n`,{mode:0o700});
  }
  for(const agent of inputOnly||workersOnly||supervisorsOnly||accountsOnly?[]:Object.keys(agentScreens)) {
    const index=monitor.messages.length;
    monitor.send({type:'create',projectId:'sample',command:`node ${agent}${agent==='vim'?' jcode':''}`,cols:160,rows:35});
    const created=await until(()=>monitor.messages.slice(index).find(m=>m.type==='created'),'Fake agent terminal');
    const id=created.termId;
    const first=await observed(id,agent==='vim'?'offline':'idle');
    check(first.agent,agent==='vim'?'':agent,'Detect foreground executable');
    if(agent!=='vim') {
      await monitor.wait(m=>m.type==='agent-status'&&m.termId===id&&m.agentCommand===agent);assertions++;
      for(const [key,state] of [['b','busy'],['a','approval'],['i','idle'],['d','unknown'],['e','unknown'],['i','idle']]) {
        await input(monitor,id,key,`${agent}-${key}-${assertions}`);
        await observed(id,state);
      }
      if(agent==='jcode') {
        await verifyControlTerminals({api,check,monitor,until,observed,id,alias:created.alias,directory});
        await input(monitor,id,'z','stop-fake-agent');await observed(id,'offline');
        await input(monitor,id,'fg\r','resume-fake-agent');await observed(id,'idle');
        const socket=(await checkpoint()).terminals.find(t=>t.termId===id).durableId;
        tmux(socket,['rename-session','-t','main','observation-unavailable']);
        await observed(id,'unknown');
        tmux(socket,['rename-session','-t','observation-unavailable','main']);
        await observed(id,'idle');
      }
      const replay=(await api(`/api/terminals/${id}/screen?lines=500`)).data;
      check(replay.lines.some(line=>line.includes('Do you want to proceed')),true,'History still contains dismissed approval');
      await observed(id,'idle');
      // A shell can restore canonical input while resuming a stopped Node TTY.
      // Submit the fixture's exit key in either mode, as a user would press Enter.
      await input(monitor,id,'q\r',`${agent}-exit`);
      await observed(id,'offline');
    }
    monitor.send({type:'kill',termId:id});
    await monitor.wait(m=>m.type==='exit'&&m.termId===id);
  }
  if(!workersOnly&&!supervisorsOnly&&!accountsOnly) await verifyInputTerminals({ api, check, monitor, until, observed, directory, project: fixture.project, checkpoint, input, url: server.url, tmux });
  if(!inputOnly&&!workersOnly&&!supervisorsOnly&&!accountsOnly) {
  const blocked=[];
  for(let index=0;index<4;index++) {
    const cursor=monitor.messages.length;
    monitor.send({type:'create',projectId:'sample',command:index===3?'node jcode':'',cols:100,rows:30});
    const created=await until(()=>monitor.messages.slice(cursor).find(m=>m.type==='created'),'Observation isolation terminal');
    blocked.push(created.termId);
  }
  await observed(blocked[3],'idle');
  const paused=[];
  try {
    const saved=await checkpoint();
    for(const id of blocked.slice(0,3)) {
      const socket=saved.terminals.find(t=>t.termId===id).durableId;
      const pid=Number(tmux(socket,['display-message','-p','-t','main','#{pid}']));
      assert.ok(Number.isInteger(pid)&&pid>0);
      process.kill(pid,'SIGSTOP');paused.push(pid);
    }
    const result=await fetch(server.url+'/api/terminals?activity=1',{signal:AbortSignal.timeout(2800)}).then(r=>r.json());
    check(result.terminals.find(t=>t.termId===blocked[3]).activity.state,'idle','Hung tmux observers do not block a healthy session');
    for(const id of blocked.slice(0,3))check(result.terminals.find(t=>t.termId===id).activity.state,'unknown','Unresponsive observation is unknown');
    const pendingConfig=api('/api/board/review',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({target:blocked[0],autoRecover:false})});
    await sleep(100);
    const editing=await fetch(server.url+'/api/board/note',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:'조회가 멈춰도 편집 가능'}),signal:AbortSignal.timeout(700)});
    check(editing.status,200,'Stalled control observation does not hold board file lock');
    check((await pendingConfig).status,400,'Unavailable manager cannot be configured');
  } finally {for(const pid of paused)process.kill(pid,'SIGCONT');}
  for(const id of blocked) {monitor.send({type:'kill',termId:id});await monitor.wait(m=>m.type==='exit'&&m.termId===id);}
  }
  if(workersOnly||!activityOnly) await verifyWorkerTerminals({ api, check, until, observed, directory, fixture, monitor, checkpoint, tmux, connect, url:()=>server.url,
    restart:async()=>{await server.stop();server=await startRustServer({root:join(fixture.directory,'app'),directory,env});} });
  if(supervisorsOnly||!activityOnly) await verifySupervisorTerminals({api,check,until,observed,directory,fixture,checkpoint,tmux,connect,url:()=>server.url,
    restart:async extra=>{await server.stop();Object.assign(env,extra);server=await startRustServer({root:join(fixture.directory,'app'),directory,env});}});
  if(accountsOnly||!activityOnly) await verifyAccountTerminals({api,check,until,observed,directory,fixture,checkpoint,tmux,connect,
    restart:async options=>{await server.stop();if(options?.clearShellFunctions){delete env['BASH_FUNC_codex%%'];delete env['BASH_FUNC_claude%%'];}if(options?.inheritedProviderHomes)Object.assign(env,{CLAUDE_CONFIG_DIR:join(directory,'unselected-claude'),CODEX_HOME:join(directory,'unselected-codex'),CLAUDECODE:'fixture-parent'});await options?.beforeStart?.();server=await startRustServer({root:join(fixture.directory,'app'),directory,env});}});
  const report={checkedAt:new Date().toISOString(),buildProfile:rustBuildProfile,assertions,scope:accountsOnly?'account-terminals':supervisorsOnly?'supervisor-recovery':workersOnly?'autonomous-workers':inputOnly?'guarded-input':activityOnly?'activity':'transport-and-activity',transport:'native Rust PTY/WebSocket',productionReady:false};
  await mkdir(join(root,'docs/_local'),{recursive:true});
  await writeFile(join(root,`docs/_local/rust-${accountsOnly?'accounts':supervisorsOnly?'supervisors':workersOnly?'workers':inputOnly?'input':activityOnly?'activity':'terminal'}-verification.json`),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  for(const client of clients)client.ws.terminate();
  await server?.stop();
  // Only inspect and stop sockets beneath this run's private TMUX_TMPDIR.
  for(const folder of await readdir(tmuxEnv.TMUX_TMPDIR).catch(()=>[])) {
    if(!/^tmux-\d+$/.test(folder))continue;
    for(const name of await readdir(join(tmuxEnv.TMUX_TMPDIR,folder)).catch(()=>[])) {
      if(!/^cockpit-[a-f0-9]{24}$/.test(name))continue;
      try{tmux(name.slice(8),['kill-server']);}catch{}
    }
  }
  await fixture.cleanup();
}
