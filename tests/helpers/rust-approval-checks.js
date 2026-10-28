import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function verifyApprovalChecks({fixture,sandbox,rustUrl,request,check}) {
  const env={...fixture.env,TMUX_TMPDIR:join(sandbox,'tmux')};
  const tmux=args=>execFileSync('/usr/bin/tmux',['-L','approve-bot',...args],{env,encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
  const path='/api/board/approval-watcher';
  const heartbeat=join(sandbox,'approve-cockpit-sessions.heartbeat');
  const snapshot=await request(rustUrl,path);
  check(snapshot.status,200,'Approval watcher status route');
  check(snapshot.data,{state:'stopped',canStop:false,script:'/tmp/approve-cockpit-sessions.sh',targets:['ai1','ai4','ai6','ai7'],intervalSeconds:3,heartbeat:null},'No private approval process is stopped, not unknown');
  const at='2026-01-01T09:00:00+09:00';
  await writeFile(heartbeat,`${at} read_ok=4 sent_total=12 cleared_total=bad`);
  check((await request(rustUrl,path)).data.heartbeat,{at:Date.parse(at),stale:true,readOk:4,sent:12,cleared:null},'Heartbeat fields remain independent of process state');
  const token=await readFile(join(sandbox,'.cockpit-token'),'utf8');
  for(const method of ['GET','POST']) {
    const route=method==='GET'?path:path+'/stop';
    const response=await request(rustUrl,route,{method,headers:{'x-forwarded-for':'100.64.1.2',Cookie:`cockpit-token=${token}`,Origin:rustUrl}});
    check(response.status,403,'Approval script control is local only even after authentication');
  }
  let created=false;
  try {
    // A harmless private process deliberately does not match the dedicated
    // script. Never execute the real /tmp approval script during validation.
    tmux(['new-session','-d','-s','approvals','/bin/sleep','120']);created=true;
    check((await request(rustUrl,path)).data.state,'unknown','Unrelated approval-named session is not treated as trusted');
    const result=await request(rustUrl,path+'/stop',{method:'POST'});
    check(result.status,500,'Stop rejects unknown dedicated script');
    check(result.data.error,'승인 스크립트의 전용 세션을 확인하지 못해 중지하지 않았습니다.','Stop error matches original');
    check(tmux(['has-session','-t','=approvals']),'','Rejected stop preserves unrelated process');
    const pid=Number(tmux(['display-message','-p','-t','=approvals','#{pid}']).trim());
    process.kill(pid,'SIGSTOP');
    try {
      const start=Date.now();const response=await request(rustUrl,path);
      check(response.data.state,'unknown','Unresponsive watcher remains unknown');
      check(Date.now()-start<3500,true,'Watcher timeout stays inside UI request limit');
    } finally {process.kill(pid,'SIGCONT');}
  } finally {if(created)tmux(['kill-server']);}
}
