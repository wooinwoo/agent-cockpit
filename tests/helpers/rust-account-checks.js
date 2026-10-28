import { readFile, writeFile, mkdir, stat, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export async function verifyAccountChecks({fixture,sandbox,rustUrl,request,check}) {
  const bases=[fixture.url,rustUrl];
  const homes=[fixture.directory,join(sandbox,'home')];
  const roots=[join(fixture.directory,'data/cockpit'),sandbox];
  const state=join(fixture.directory,'account-cli-mode');
  const log=join(fixture.directory,'account-cli-events');
  await writeFile(log,''); await writeFile(state,'ok');
  for(const home of homes) {
    await mkdir(join(home,'.local/bin'),{recursive:true});
    for(const provider of ['claude','codex']) await writeFile(join(home,'.local/bin',provider),`#!${process.execPath}
const fs=require('node:fs'); const provider=${JSON.stringify(provider)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({provider,args:process.argv.slice(2),home:process.env[provider==='claude'?'CLAUDE_CONFIG_DIR':'CODEX_HOME']})+'\\n');
const mode=fs.readFileSync(${JSON.stringify(state)},'utf8');
if(mode==='fail'){process.stdout.write(JSON.stringify({loggedIn:false}));process.exit(1);}
if(mode==='text'){process.stdout.write('Logged in using ChatGPT\\n');process.exit(0);}
process.stdout.write(JSON.stringify({loggedIn:true,authMethod:'fixture'}));
`,{mode:0o700});
  }
  const records=[];
  const pair=async(path,options)=>Promise.all(bases.map(base=>request(base,path,options)));
  for(const body of [{name:'',provider:'claude'},{name:'bad',provider:'jcode'},{}]) {
    const [node,rust]=await pair('/api/ai-accounts',{method:'POST',body});
    check(rust.status,node.status,'Account invalid input status');check(rust.data,node.data,'Account invalid input error');
  }
  for(const provider of ['claude','codex']) {
    const values=await pair('/api/ai-accounts',{method:'POST',body:{provider,name:` 검증 ${provider} 😀 `,email:' fixture@example.invalid '}});
    for(let i=0;i<values.length;i++) {
      const {status,data}=values[i];check(status,201,'Create owned account');
      check(data.id,createHash('sha256').update(`${provider}\0${data.homePath.toLowerCase()}`).digest('hex').slice(0,16),'Stable path-based account ID');
      check(data.homePath.startsWith(join(roots[i],'ai-accounts')+'/'),true,'Credential directory stays inside own store');
    }
    check({...values[1].data,id:'ID',homePath:'PATH',createdAt:'TIME'},{...values[0].data,id:'ID',homePath:'PATH',createdAt:'TIME'},'Created account metadata matches Node');
    check((await stat(values[1].data.homePath)).mode&0o777,0o700,'Native credential directory is private');
    check((await stat(join(sandbox,'ai-accounts.json'))).mode&0o777,0o600,'Native metadata file is private');
    records.push(values.map(v=>v.data));
    const duplicate=await pair('/api/ai-accounts',{method:'POST',body:{provider,name:`검증 ${provider} 😀`}});
    check(duplicate[1].data,duplicate[0].data,'Duplicate names rejected');
  }
  for(const pairRecords of records) {
    const requestPair=(suffix,body)=>Promise.all(bases.map((base,i)=>request(base,`/api/ai-accounts/${pairRecords[i].id}/${suffix}`,{method:'POST',body})));
    const normalize=data=>({...data,id:'ID'});
    const missing=await requestPair('test',{});
    check(normalize(missing[1].data),normalize(missing[0].data),'Missing credentials return login checklist without launching CLI');
    for(let i=0;i<pairRecords.length;i++) {
      const record=pairRecords[i];await writeFile(join(record.homePath,record.provider==='claude'?'.credentials.json':'auth.json'),'{}');
    }
    for(const mode of ['ok','text','fail']) {
      await writeFile(state,mode);
      const values=await requestPair('test',{});
      check(values[1].status,values[0].status,'Login check status');
      check(normalize(values[1].data),normalize(values[0].data),'Login check success, text and failure match Node');
    }
    await writeFile(state,'ok');
    for(let i=0;i<pairRecords.length;i++) {
      const record=pairRecords[i];
      const data=record.provider==='claude'?{claudeAiOauth:{expiresAt:Date.now()-86_400_000}}:{last_refresh:new Date(Date.now()-40*86_400_000).toISOString()};
      await writeFile(join(record.homePath,record.provider==='claude'?'.credentials.json':'auth.json'),JSON.stringify(data));
    }
    const expired=await requestPair('test',{});
    check(normalize(expired[1].data),normalize(expired[0].data),'Expired or old credentials require attention');
    check(expired[1].data.ok,false,'CLI success does not hide credential warning');
    for(const budget of [1_000_000,1.5,-0.1,9007199254740991,'0x10',null,0,-1,'bad',{}]) {
      const values=await requestPair('budget',{weeklyTokenBudget:budget});
      check(values[1].status,values[0].status,'Budget validation status');
      check(normalize(values[1].data),normalize(values[0].data),'Budget Number and rounding compatibility');
    }
  }
  const events=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);
  check(events.length,16,'Only explicit credential checks invoke the fake CLI');
  for(const event of events) {
    check(event.args,event.provider==='claude'?['auth','status']:['login','status'],'No model request or login action during connection check');
    check(records.flat().some(r=>r.provider===event.provider&&r.homePath===event.home),true,'Connection check selects the correct account environment');
  }
  for(const path of ['/api/ai-accounts/bad/test','/api/ai-accounts/aaaaaaaaaaaaaaaa/test','/api/ai-accounts/bad/budget','/api/ai-accounts/aaaaaaaaaaaaaaaa']) {
    const method=path.endsWith('aaaaaaaaaaaaaaaa')?'DELETE':'POST';
    const values=await pair(path,{method,body:method==='POST'?{}:undefined});
    check(values[1].status,values[0].status,'Invalid or missing account status');check(values[1].data,values[0].data,'Invalid or missing account message');
  }
  // Legacy account arrays remain readable; updates retain valid records. A
  // broken metadata file must never be silently replaced by an empty store.
  const nativeFile=join(sandbox,'ai-accounts.json');
  const saved=await readFile(nativeFile);
  const original=JSON.parse(saved);
  await writeFile(nativeFile,JSON.stringify(original.accounts));
  check((await request(rustUrl,`/api/ai-accounts/${records[0][1].id}/budget`,{method:'POST',body:{weeklyTokenBudget:12}})).status,200,'Legacy array migration');
  check(JSON.parse(await readFile(nativeFile)).accounts.length,2,'Legacy accounts preserved');
  await writeFile(nativeFile,'{broken');
  check((await request(rustUrl,'/api/ai-accounts',{method:'POST',body:{provider:'codex',name:'must not overwrite'}})).status,400,'Reject corrupt account store write');
  check(await readFile(nativeFile,'utf8'),'{broken','Corrupt metadata is preserved');
  await writeFile(nativeFile,saved);
  const outside=join(fixture.directory,'outside-credential');await mkdir(outside);await writeFile(join(outside,'keep'),'preserve');
  const linked=join(sandbox,'ai-accounts','linked');await symlink(outside,linked,'dir');
  const injected={id:'bbbbbbbbbbbbbbbb',name:'invalid link',provider:'codex',homePath:linked};
  await writeFile(nativeFile,JSON.stringify({...original,accounts:[...original.accounts,injected],sentinel:'keep extension'}));
  check((await request(rustUrl,`/api/ai-accounts/${injected.id}/test`,{method:'POST',body:{}})).status,400,'Credential checks reject symlink escape');
  check((await request(rustUrl,`/api/ai-accounts/${injected.id}`,{method:'DELETE'})).status,200,'Remove invalid metadata without following symlink');
  check(await readFile(join(outside,'keep'),'utf8'),'preserve','Deletion preserves outside data');
  check(JSON.parse(await readFile(nativeFile)).sentinel,'keep extension','Account updates preserve unknown metadata');
  for(const pairRecords of records) {
    const results=await Promise.all(bases.map((base,i)=>request(base,`/api/ai-accounts/${pairRecords[i].id}`,{method:'DELETE'})));
    check(results[1].data,results[0].data,'Account deletion matches Node');
    check(await stat(pairRecords[1].homePath).then(()=>true,()=>false),false,'Delete only owned credential directory');
  }
}
