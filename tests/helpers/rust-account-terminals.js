import {readFile,writeFile,rename,mkdir,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {agentPermissionCommand} from '../../js/agent-permissions.js';

export async function verifyAccountTerminals({api,check,until,observed,directory,fixture,checkpoint,tmux,restart,connect}) {
  const log=join(fixture.project,'account-launch-events');await writeFile(log,'');
  for(const provider of ['codex','claude']) await writeFile(join(fixture.project,provider),`#!${process.execPath}
import fs from 'node:fs';
const provider=${JSON.stringify(provider)},key=provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME';
const args=process.argv.slice(2),kind=provider==='claude'&&(args.includes('-p')||args.includes('--print'))?'model':'terminal';
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({kind,provider,args,home:process.env[key],other:process.env[provider==='claude'?'CODEX_HOME':'CLAUDE_CONFIG_DIR']||'',nested:process.env.CLAUDECODE||'',id:process.env.COCKPIT_TERM_ID,pid:process.pid})+'\\n');
if(kind==='model'){process.stdout.write('Fixture account summary\\n');process.exit(0);}
process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('\\x1b[2J\\x1b[H'+(provider==='claude'?'❯\\r\\n? for shortcuts':'› Ask Codex to do anything\\r\\nGPT-6.1-Sol xhigh'));
`,{mode:0o700});
  await restart({clearShellFunctions:true,inheritedProviderHomes:true});
  let client=await connect();
  // Background Claude print-mode summaries share the fake CLI, but are not
  // terminal launches. Keep them in the log without counting them as restores.
  const events=async()=>(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse).filter(event=>event.kind==='terminal');
  const send=(path,method,body)=>api(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const boardFile=join(directory,'.cockpit-board.json');const original=(await api('/api/board')).data;
  const created=[];const accounts=[];
  const hubFile=join(directory,'home/.codex-account-launcher/profiles.json');
  const create=async(options)=>{
    const cursor=client.messages.length;
    client.send({type:'create',projectId:'sample',cols:120,rows:30,...options});
    const message=await until(()=>client.messages.slice(cursor).find(m=>m.type==='created'||m.type==='error'),'Account terminal creation');
    if(message.type==='error')throw new Error(message.message);
    created.push(message.termId);await observed(message.termId,'idle');return message;
  };
  try {
    for(const provider of ['claude','codex']) {
      const result=await send('/api/ai-accounts','POST',{provider,name:`계정 ${provider}`});check(result.status,201,'Create terminal account before login');accounts.push(result.data);
      for(const mode of provider==='claude'?['default','edits','auto','full']:['default','workspace','network','full']) {
        const permissions={claude:'default',codex:'default',[provider]:mode};
        check((await send('/api/board/permissions','PUT',permissions)).status,200,'Persist selected launch permission');
        const terminal=await create({accountId:result.data.id,command:'node ignored'});
        const record=await until(async()=>(await events()).find(e=>e.id===terminal.termId),'Fake account execution');
        check(record.provider,provider,'Selected account overrides unrelated message command');
        check(record.home,result.data.homePath,'Account-specific CLI home');
        check(record.other,'','Other provider home is removed');check(record.nested,'','Nested-session marker is removed');
        const expected=agentPermissionCommand(provider,permissions);
        check(terminal.command,expected,'Permission preset matches original Node launcher');
        check(record.args,expected.split(' ').slice(1),'Exact preset reaches fake CLI');
        check(terminal.account,{id:result.data.id,name:result.data.name,provider},'UI gets account identity without credential path');
        client.send({type:'kill',termId:terminal.termId});await client.wait(m=>m.type==='exit'&&m.termId===terminal.termId);
      }
      const login=await create({accountId:result.data.id,loginMode:true});
      check(login.command,`${provider} login`,'Login mode does not inherit permission flags');
      check((await events()).find(e=>e.id===login.termId).args,['login'],'Login command sent once');
    }
    const hubHome=join(directory,'home/hub-cli');
    await mkdir(hubHome,{recursive:true});await mkdir(join(directory,'home/.codex-account-launcher'),{recursive:true});
    const hubProfile={provider:'claude',name:'허브 실행',claudeConfigDir:hubHome};
    const hubId=createHash('sha256').update(`claude\0${hubHome.toLowerCase()}`).digest('hex').slice(0,16);
    await writeFile(hubFile,JSON.stringify({profiles:[hubProfile]}));
    const rejected=async(expected)=>{
      const cursor=client.messages.length;client.send({type:'create',projectId:'sample',accountId:hubId,cols:120,rows:30});
      const message=await until(()=>client.messages.slice(cursor).find(m=>m.type==='created'||m.type==='error'),'Hub launch preconditions');
      check(message.type,'error','Hub precondition prevents a terminal launch');
      check(message.message.includes(expected),true,'Hub precondition preserves original error');
    };
    await rejected('login required');
    await writeFile(join(hubHome,'.credentials.json'),'{}');
    await writeFile(hubFile,JSON.stringify({profiles:[{...hubProfile,lastLimitsError:'fixture warning'}]}));
    await rejected('status check required');
    await writeFile(hubFile,JSON.stringify({profiles:[hubProfile]}));
    const hub=await create({accountId:hubId});
    const hubRun=await until(async()=>(await events()).find(e=>e.id===hub.termId),'Hub account CLI execution');
    check(hubRun.home,hubHome,'Hub launch selects exact referenced credential home');
    check(hubRun.other,'','Hub launch clears other provider home');
    check(hub.account,{id:hubId,name:hubProfile.name,provider:'claude'},'Hub identity reaches the terminal UI');
    client.send({type:'kill',termId:hub.termId});await client.wait(m=>m.type==='exit'&&m.termId===hub.termId);
    // Custom commands retain their own flags under saved presets.
    const custom=await create({command:'codex --no-daemon'});
    check(custom.command,'codex --no-daemon','Explicit command is not rewritten by preset');
    client.send({type:'kill',termId:custom.termId});await client.wait(m=>m.type==='exit'&&m.termId===custom.termId);
    const saved=(await checkpoint()).terminals.filter(t=>accounts.some(a=>a.id===t.accountId));
    check(saved.length,2,'Both login sessions persist account IDs');
    const pids=saved.map(t=>tmux(t.durableId,['display-message','-p','-t','main','#{pane_pid}']));
    const before=(await events()).length;
    const accountFile=join(directory,'ai-accounts.json');const metadata=await readFile(accountFile);
    await writeFile(accountFile,JSON.stringify({accounts:[],budgets:{}}));
    await restart();client=await connect();
    for(let i=0;i<saved.length;i++) {
      check(client.initial.active.find(t=>t.termId===saved[i].termId)?.account,saved[i].account,'Live pane reconnect does not require account record');
      check(tmux(saved[i].durableId,['display-message','-p','-t','main','#{pane_pid}']),pids[i],'Account reconnect preserves existing process');
    }
    check((await events()).length,before,'Reconnect never repeats login');
    // If both pane and account record are absent, defer the saved terminal;
    // restoring account metadata lets the normal timer finish restoration.
    client.ws.close();await restart({beforeStart:()=>{for(const term of saved)tmux(term.durableId,['kill-server']);}});
    client=await connect();
    check(client.initial.active.some(t=>saved.some(s=>s.termId===t.termId)),false,'Missing account prevents new credential-less launch');
    check((await checkpoint()).terminals.filter(t=>saved.some(s=>s.termId===t.termId)).length,2,'Deferred account terminals remain in checkpoint');
    await writeFile(accountFile+'.next',metadata);await rename(accountFile+'.next',accountFile);
    await until(async()=>(await events()).length===before+2,'Deferred account restore after metadata returns',45_000);
    const restored=(await events()).slice(before);
    check(restored.map(e=>e.args),[[],[]],'Restored login terminals launch provider without repeating login flow');
    for(const record of restored)check(record.home,accounts.find(a=>a.provider===record.provider).homePath,'Cold restore keeps selected account environment');
  } finally {
    await writeFile(boardFile,JSON.stringify(original));client=await connect();
    for(const id of created)client.send({type:'kill',termId:id});
    for(const account of accounts)await api(`/api/ai-accounts/${account.id}`,{method:'DELETE'});
    await unlink(hubFile).catch(()=>{});
  }
}
