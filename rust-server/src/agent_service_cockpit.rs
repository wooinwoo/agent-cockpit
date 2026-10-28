//! COCKPIT tool text and dispatch. The application adapter owns all side effects.
use crate::{
    agent_context::fixed_decimal,
    agent_prompt::{property_string, string},
    agent_runtime::{concat, Pending},
    ai_transport::Cancel,
    board_value::{object, V},
};

pub trait Services: Send + Sync {
    fn call<'a>(
        &'a self,
        operation: &'a str,
        parameter: &'a V,
        input: &'a V,
        cancel: &'a Cancel,
    ) -> Pending<'a, V>;
}
fn fallback(v: &V, default: &str) -> V {
    if v.truthy() {
        v.clone()
    } else {
        default.into()
    }
}
fn format(source: &str, args: &[V]) -> Result<V, String> {
    let parts: Vec<_> = source.split("{}").collect();
    if parts.len() != args.len() + 1 {
        return Err("Invalid tool text template".into());
    }
    let mut text = Vec::new();
    for (index, part) in parts.iter().enumerate() {
        text.extend(part.encode_utf16());
        if let Some(value) = args.get(index) {
            text.extend_from_slice(string(value)?.units());
        }
    }
    Ok(V::String(text))
}
macro_rules! t { ($source:expr $(,$value:expr)* $(,)?) => { format($source, &[$($value),*])? }; }
fn join(values: Vec<V>, separator: &str) -> V {
    let mut result = vec![];
    for (index, value) in values.into_iter().enumerate() {
        if index > 0 {
            result.extend(separator.encode_utf16());
        }
        result.extend_from_slice(value.units());
    }
    V::String(result)
}
fn amount(value: &V, digits: usize) -> Result<V, String> {
    if !value.truthy() {
        return fixed_decimal(&V::Number(0.0), digits);
    }
    if !matches!(value, V::Number(_)) {
        return Err("(value || 0).toFixed is not a function".into());
    }
    fixed_decimal(value, digits)
}
fn number(v: &V) -> Result<V, String> {
    if *v == V::Null {
        return Ok("0".into());
    }
    if let V::Array(values) = v {
        return Ok(join(
            values
                .iter()
                .map(|v| {
                    if *v == V::Null {
                        Ok("".into())
                    } else {
                        number(v)
                    }
                })
                .collect::<Result<Vec<_>, String>>()?,
            ",",
        ));
    }
    let V::Number(n) = v else {
        return string(v);
    };
    if n.is_nan() {
        return Ok("NaN".into());
    }
    if n.is_infinite() {
        return Ok(if n.is_sign_negative() { "-∞" } else { "∞" }.into());
    }
    // Intl.NumberFormat rounds the shortest decimal representation, unlike
    // Number.toFixed, which rounds the exact binary floating-point value.
    let shortest = n.abs().to_string();
    let (integer, decimal) = shortest.split_once('.').unwrap_or((&shortest, ""));
    let mut rounded = integer.bytes().collect::<Vec<_>>();
    rounded.extend(decimal.bytes().chain(std::iter::repeat(b'0')).take(3));
    if decimal
        .as_bytes()
        .get(3)
        .is_some_and(|digit| *digit >= b'5')
    {
        let mut carry = true;
        for digit in rounded.iter_mut().rev() {
            if *digit < b'9' {
                *digit += 1;
                carry = false;
                break;
            }
            *digit = b'0';
        }
        if carry {
            rounded.insert(0, b'1');
        }
    }
    let split = rounded.len() - 3;
    let integer = String::from_utf8(rounded[..split].to_vec()).unwrap();
    let fraction = String::from_utf8(rounded[split..].to_vec()).unwrap();
    let decimal = fraction.trim_end_matches('0');
    let digits = integer.as_str();
    let mut result = String::new();
    if n.is_sign_negative() {
        result.push('-');
    }
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            result.push(',');
        }
        result.push(c);
    }
    if !decimal.is_empty() {
        result.push('.');
        result.push_str(decimal);
    }
    Ok(result.into())
}
fn bytes(owner: &V, key: &str) -> Result<V, String> {
    let n = if owner.has(key) {
        owner[key].number()
    } else {
        f64::NAN
    };
    let (value, digits, suffix) = if n >= 1e9 {
        (n / 1e9, 1, "GB")
    } else if n >= 1e6 {
        (n / 1e6, 1, "MB")
    } else {
        (n / 1e3, 0, "KB")
    };
    Ok(concat(&[
        fixed_decimal(&V::Number(value), digits)?,
        suffix.into(),
    ]))
}
fn ago(value: &V, now: i64) -> V {
    if !value.truthy() {
        return "".into();
    }
    let at = if matches!(value, V::Number(_)) {
        Some(value.number() as i64)
    } else {
        chrono::DateTime::parse_from_rfc3339(&value.text())
            .ok()
            .map(|d| d.timestamp_millis())
            .or_else(|| {
                chrono::NaiveDate::parse_from_str(&value.text(), "%Y-%m-%d")
                    .ok()
                    .and_then(|d| d.and_hms_opt(0, 0, 0))
                    .map(|d| d.and_utc().timestamp_millis())
            })
    };
    let Some(at) = at else {
        return "NaNd ago".into();
    };
    let diff = now.saturating_sub(at);
    if diff < 60000 {
        "just now".into()
    } else if diff < 3600000 {
        format!("{}m ago", diff / 60000).into()
    } else if diff < 86400000 {
        format!("{}h ago", diff / 3600000).into()
    } else {
        format!("{}d ago", diff / 86400000).into()
    }
}
fn tail(raw: &V, maximum: usize, marker: bool) -> Result<V, String> {
    if !raw.is_string() {
        return Err("buf.replace is not a function".into());
    }
    // Regex operates on UTF-16 code units so truncation never repairs surrogates.
    let a = regress::Regex::new(r"\x1B\[[0-9;]*[A-Za-z]").unwrap();
    let b = regress::Regex::new(r"\x1B\][^\x07]*\x07").unwrap();
    let mut units = raw.units().to_vec();
    for re in [a, b] {
        let ranges: Vec<_> = re.find_from_utf16(&units, 0).map(|m| m.range()).collect();
        for r in ranges.into_iter().rev() {
            units.drain(r);
        }
    }
    if units.len() > maximum {
        let cut = V::String(units[units.len() - maximum..].to_vec());
        Ok(if marker {
            concat(&["...(truncated)\n".into(), cut])
        } else {
            cut
        })
    } else {
        Ok(V::String(units))
    }
}
pub async fn execute(
    arg: &V,
    services: &dyn Services,
    cancel: &Cancel,
    now: i64,
) -> Result<V, String> {
    if cancel.is_cancelled() {
        return Err("Agent request cancelled".into());
    }
    if arg.truthy() && !arg.is_string() {
        return Err("(arg || \"\").trim is not a function".into());
    }
    let trimmed = arg.trim();
    let units = trimmed.units();
    let split = units.iter().position(|c| *c == 10);
    let line = V::String(units[..split.unwrap_or(units.len())].to_vec()).trim();
    let extra = V::String(split.map(|i| units[i + 1..].to_vec()).unwrap_or_default());
    let colon = line.units().iter().position(|c| *c == 58);
    let command = V::String(line.units()[..colon.unwrap_or(line.units().len())].to_vec())
        .text()
        .to_lowercase();
    let param = V::String(
        colon
            .map(|i| line.units()[i + 1..].to_vec())
            .unwrap_or_default(),
    )
    .trim();
    let result = run(&command, &param, &extra, services, cancel, now).await;
    if cancel.is_cancelled() {
        return Err("Agent request cancelled".into());
    }
    Ok(match result {
        Ok(v) => v,
        Err(e) => t!("Error: cockpit {} failed — {}", command.into(), e.into()),
    })
}
async fn run(
    cmd: &str,
    p: &V,
    extra: &V,
    s: &dyn Services,
    c: &Cancel,
    now: i64,
) -> Result<V, String> {
    let empty = V::Null;
    macro_rules! call {
        ($op:expr) => {
            s.call($op, p, &empty, c).await?
        };
        ($op:expr,$input:expr) => {
            s.call($op, p, &$input, c).await?
        };
    }
    macro_rules! field {
        ($v:expr,$key:expr) => {
            property_string($v, $key)?
        };
    }
    match cmd {
        "usage"=>{
            let d=call!("usage"); if !d.truthy(){return Ok("No usage data available.".into());}
            let a=&d["today"]; let w=&d["week"]; let mut models=vec![];
            if let V::Object(rows)=&a["models"] {for (m,v) in rows {models.push(t!("  {}: ${} ({} out)",m.clone().into(),amount(&v["apiCost"],3)?,number(&v["outputTokens"])?));}}
            Ok(t!("[Today {}]\nOutput: {} | Input: {} | Cache R: {} | Cache W: {}\nCost: ${} | Messages: {} | Sessions: {} | Tools: {}\nModels:\n{}\n\n[Week]\nCost: ${} | Output: {} | Messages: {}\nReset: {}",fallback(&a["date"],""),number(&a["outputTokens"])?,number(&a["inputTokens"])?,number(&a["cacheReadTokens"])?,number(&a["cacheCreationTokens"])?,amount(&a["apiEquivCost"],3)?,fallback(&a["messages"],"0"),fallback(&a["sessions"],"0"),fallback(&a["toolCalls"],"0"),if models.is_empty(){"  (none)".into()}else{join(models,"\n")},amount(&w["apiEquivCost"],3)?,number(&w["outputTokens"])?,fallback(&w["messages"],"0"),fallback(&w["resetAt"],"?")))
        },
        "projects"=>{let rows=call!("projects"); if rows.array().is_empty(){return Ok("No projects registered.".into());} let mut lines=vec![t!("[Projects] {}",(rows.array().len() as f64).into())];for(i,r)in rows.array().iter().enumerate(){lines.push(t!("{}. {} ({}) — stack: {} — {}",((i+1)as f64).into(),field!(r,"name"),field!(r,"id"),fallback(&r["stack"],"?"),field!(r,"path")));}Ok(join(lines,"\n"))},
        "project"=>{
            if !p.truthy(){return Ok("Error: project ID required. Usage: project:ID".into());}
            let d=call!("project");let r=&d["project"];if !r.truthy(){return Ok(t!("Error: project \"{}\" not found.",p.clone()));}
            let mut lines=vec![t!("[Project: {}]",field!(r,"name")),t!("Path: {}",field!(r,"path")),t!("Stack: {}",fallback(&r["stack"],"?"))];
            let a=&d["session"];if a.truthy(){lines.push(t!("Session: {} | Model: {} | Last: {}",fallback(&a["state"],"unknown"),fallback(&a["model"],"?"),ago(&a["lastActivity"],now)));}
            let g=&d["git"];if g.truthy(){lines.push(t!("Branch: {} | Uncommitted: {}",fallback(&g["branch"],"?"),fallback(&g["uncommittedCount"],"0")));if let Some(last)=g["recentCommits"].array().first(){lines.push(t!("Last commit: {} ({})",field!(last,"message"),if last.has("hash"){last["hash"].cut(7)}else{"undefined".into()}));}}
            if !d["prs"]["prs"].array().is_empty(){let mut prs=vec![];for pr in d["prs"]["prs"].array(){prs.push(t!("#{} {} [{}]",field!(pr,"number"),field!(pr,"title"),field!(pr,"reviewDecision")));}lines.push(t!("PRs: {}",join(prs,", ")));}
            if let Some(r)=d["cicd"]["runs"].array().first(){lines.push(t!("CI/CD: {} — {} ({})",fallback(&r["name"],"workflow"),if r["conclusion"].truthy(){r["conclusion"].clone()}else{field!(r,"status")},ago(if r["updated_at"].truthy(){&r["updated_at"]}else{&r["created_at"]},now)));}Ok(join(lines,"\n"))
        },
        "prs"=>{let rows=call!("prs");if rows.array().is_empty(){return Ok(if p.truthy(){t!("No PRs for project \"{}\".",p.clone())}else{"No PRs across all projects.".into()});}let mut lines=vec![t!("[PRs] {}",(rows.array().len()as f64).into())];for r in rows.array(){lines.push(t!("#{} {} [{}] — {} (@{}) {}",field!(r,"number"),field!(r,"title"),fallback(&r["reviewDecision"],"PENDING"),field!(r,"project"),field!(r,"author"),if r["isDraft"].truthy(){"(draft)".into()}else{"".into()}));}Ok(join(lines,"\n"))},
        "sessions"=>{let rows=call!("sessions");let mut lines=vec![t!("[Sessions] {} projects",(rows.array().len()as f64).into())];for r in rows.array(){lines.push(t!("  {}: {} | Model: {} | Last: {}",field!(r,"name"),fallback(&r["session"]["state"],"no_data"),fallback(&r["session"]["model"],"?"),ago(&r["session"]["lastActivity"],now)));}Ok(join(lines,"\n"))},
        "notes"=>{let rows=call!("notes");if rows.array().is_empty(){return Ok("No notes.".into());}let mut lines=vec![t!("[Notes] {}",(rows.array().len()as f64).into())];for(i,n)in rows.array().iter().enumerate(){lines.push(t!("{}. [{}] \"{}\"{}{} — {}\n   {}",((i+1)as f64).into(),field!(n,"id"),field!(n,"title"),if n["tags"].array().is_empty(){"".into()}else{t!(" — tags: {}",join(n["tags"].array().to_vec(),","))},if n["project"].truthy(){t!(" — project: {}",n["project"].clone())}else{"".into()},ago(&n["updatedAt"],now),fallback(&n["preview"],"")));}Ok(join(lines,"\n"))},
        "note"=>{if !p.truthy(){return Ok("Error: note ID required. Usage: note:ID".into());}let n=call!("note");if !n.truthy(){return Ok(t!("Error: note \"{}\" not found.",p.clone()));}Ok(t!("[Note: {}]\nID: {} | Created: {} | Updated: {}\nTags: {} | Project: {}\n\n{}",field!(&n,"title"),field!(&n,"id"),ago(&n["createdAt"],now),ago(&n["updatedAt"],now),fallback(&join(n["tags"].array().to_vec(),", "),"(none)"),fallback(&n["project"],"(none)"),fallback(&n["content"],"(empty)")))},
        "note-create"|"note-update"=>{
            let create=cmd=="note-create";if !p.truthy(){return Ok(if create{"Error: 제목이 필요합니다. Usage: COCKPIT:note-create:제목"}else{"Error: 노트 ID가 필요합니다. Usage: COCKPIT:note-update:ID"}.into());}
            let input=if create{object([("title",p.clone()),("content",extra.clone()),("project","".into())])}else{object([("content",extra.clone())])};
            match s.call(cmd,p,&input,c).await {Ok(n)=>{if !n.truthy(){return Ok(if create{"Error: Note 생성 실패: Cannot read properties of null (reading 'id')".into()}else{t!("Error: note \"{}\" not found.",p.clone())});}Ok(t!("Note {} 완료: [{}] \"{}\" ({}자)",if create{"생성".into()}else{"수정".into()},field!(&n,"id"),field!(&n,"title"),(extra.units().len()as f64).into()))},Err(e)=>Ok(t!("Error: Note {} 실패: {}",if create{"생성".into()}else{"수정".into()},e.into()))}
        },
        "system"=>{let r=call!("system");if !r.truthy(){return Ok("System stats unavailable.".into());}let mut lines=vec!["[System]".into(),t!("CPU: {}% | Memory: {}% ({} / {})",field!(&r,"cpu"),field!(&r["memory"],"percent"),bytes(&r["memory"],"used")?,bytes(&r["memory"],"total")?)];if !r["disk"].array().is_empty(){let mut disks=vec![];for d in r["disk"].array(){disks.push(t!("{} {}% ({}/{})",field!(d,"drive"),field!(d,"percent"),bytes(d,"used")?,bytes(d,"total")?));}lines.push(t!("Disks: {}",join(disks," | ")));}if r["system"].truthy(){let z=&r["system"];lines.push(t!("Host: {} | {} {} | Cores: {} | Node: {}",field!(z,"hostname"),field!(z,"platform"),field!(z,"arch"),field!(z,"cpuCores"),field!(z,"nodeVersion")));}if !r["processes"].array().is_empty(){lines.push("Top processes:".into());for z in r["processes"].array().iter().take(8){lines.push(t!("  {} (PID {}) — CPU: {}s, Mem: {}MB",field!(z,"ProcessName"),field!(z,"Id"),field!(z,"Cpu"),field!(z,"MemMB")));}}Ok(join(lines,"\n"))},
        "briefing"=>{let b=call!("briefing");if !b.truthy(){return Ok("Briefing generation failed.".into());}let mut lines=vec![t!("[Daily Briefing {}] {} projects, {} need attention",field!(&b,"date"),field!(&b,"totalProjects"),field!(&b,"attentionCount"))];if b["cost"].truthy(){lines.push(t!("Cost — Yesterday: ${} | Today: ${} | Week: ${}",amount(&b["cost"]["yesterday"],2)?,amount(&b["cost"]["today"],2)?,amount(&b["cost"]["weekly"],2)?));}for r in b["items"].array(){lines.push(t!("{}{}: {}",if r["needsAttention"].truthy(){"[!] ".into()}else{"".into()},field!(r,"projectId"),join(r["changes"].array().to_vec(),", ")));}if b["items"].array().is_empty(){lines.push("No notable changes.".into());}Ok(join(lines,"\n"))},
        "alerts"=>{let a=call!("alerts");if a.array().is_empty(){return Ok("No active alerts.".into());}let mut lines=vec![t!("[Alerts] {}",(a.array().len()as f64).into())];for r in a.array(){lines.push(t!("[{}] {}",r["level"].text().to_uppercase().into(),field!(r,"message")));}Ok(join(lines,"\n"))},
        "activity"=>{let a=call!("activity");if a.array().is_empty(){return Ok("No recent activity.".into());}let mut lines=vec![t!("[Recent Activity] {}",(a.array().len()as f64).into())];for r in a.array().iter().take(15){lines.push(t!("{} — {}: {}",ago(if r["timestamp"].truthy(){&r["timestamp"]}else{&r["ts"]},now),fallback(if r["project"].truthy(){&r["project"]}else{&r["projectId"]},"?"),fallback(if r["summary"].truthy(){&r["summary"]}else if r["message"].truthy(){&r["message"]}else{&r["type"]},"?")));}Ok(join(lines,"\n"))},
        "workflows"=>{let rows=call!("workflows");if rows.array().is_empty(){return Ok("No workflows defined.".into());}let mut lines=vec![t!("[Workflows] {}",(rows.array().len()as f64).into())];for(i,r)in rows.array().iter().enumerate(){lines.push(t!("{}. [{}] \"{}\" — steps: {}{}",((i+1)as f64).into(),field!(r,"id"),field!(r,"name"),(r["steps"].array().len()as f64).into(),if r["description"].truthy(){t!(" — {}",r["description"].clone())}else{"".into()}));}Ok(join(lines,"\n"))},
        "workflow"=>{if !p.truthy(){return Ok("Error: workflow ID required. Usage: workflow:ID".into());}let r=call!("workflow");if !r.truthy(){return Ok(t!("Error: workflow \"{}\" not found.",p.clone()));}let mut lines=vec![t!("[Workflow: {}]",field!(&r,"name")),t!("ID: {}",field!(&r,"id"))];if r["description"].truthy(){lines.push(r["description"].clone());}if !r["steps"].array().is_empty(){lines.push(t!("Steps ({}):",(r["steps"].array().len()as f64).into()));for z in r["steps"].array(){lines.push(t!("  {} — model: {} | type: {}",field!(z,"name"),fallback(&z["model"],"?"),fallback(&z["type"],"llm")));}}Ok(join(lines,"\n"))},
        "workflow-runs"=>{let rows=call!("workflow-runs");if rows.array().is_empty(){return Ok("No workflow runs.".into());}let mut lines=vec![t!("[Workflow Runs] {}",(rows.array().len()as f64).into())];for r in rows.array().iter().take(15){lines.push(t!("[{}] \"{}\" — {} — {}{}",field!(r,"id"),if r["workflowName"].truthy(){r["workflowName"].clone()}else{field!(r,"workflowId")},field!(r,"status"),ago(&r["startedAt"],now),if r["error"].truthy(){t!(" — ERR: {}",r["error"].clone())}else{"".into()}));}Ok(join(lines,"\n"))},
        "workflow-run"=>{if !p.truthy(){return Ok("Error: run ID required. Usage: workflow-run:ID".into());}let r=call!("workflow-run");if !r.truthy(){return Ok(t!("Error: workflow run \"{}\" not found.",p.clone()));}let mut lines=vec![t!("[Run: {}]",field!(&r,"id")),t!("Workflow: {}",if r["workflowName"].truthy(){r["workflowName"].clone()}else{field!(&r,"workflowId")}),t!("Status: {} | Started: {}{}",field!(&r,"status"),ago(&r["startedAt"],now),if r["finishedAt"].truthy(){t!(" | Finished: {}",ago(&r["finishedAt"],now))}else{"".into()})];if !r["steps"].array().is_empty(){lines.push("Steps:".into());for z in r["steps"].array(){lines.push(t!("  {}: {}{}{}",field!(z,"name"),field!(z,"status"),if z["duration"].truthy(){t!(" ({}ms)",z["duration"].clone())}else{"".into()},if z["error"].truthy(){t!(" ERR: {}",z["error"].clone())}else{"".into()}));}}Ok(join(lines,"\n"))},
        "workflow-start"=>{if !p.truthy(){return Ok("Error: workflow ID required. Usage: workflow-start:WORKFLOW_ID".into());}let input=crate::agent_response::json_text(extra).and_then(|text|serde_json::value::RawValue::from_string(text).ok()).and_then(|r|V::parse(&r).ok()).unwrap_or(V::object());match s.call(cmd,p,&input,c).await{Ok(r)=>Ok(t!("[OK] Workflow \"{}\" started. Run ID: {}. Status: {}",p.clone(),fallback(&r["id"],"(unknown)"),fallback(&r["status"],"running"))),Err(e)=>Ok(t!("Error: workflow start failed — {}",e.into()))}},
        "terminals"=>{let data=call!("terminals");let rows=&data["terminals"];if rows.array().is_empty(){return Ok("[Terminals] 0 active — no terminals running.".into());}let mut lines=vec![t!("[Terminals] {} active",(rows.array().len()as f64).into())];for(i,r)in rows.array().iter().enumerate(){let name=data["projects"].array().iter().find(|p|p["id"]==r["projectId"]).map(|p|p["name"].clone()).unwrap_or(r["projectId"].clone());lines.push(t!("{}. [{}] project: {} | cmd: {}",((i+1)as f64).into(),field!(r,"termId"),name,fallback(&r["command"],"(shell)")));}Ok(join(lines,"\n"))},
        "terminal-read"=>{if !p.truthy(){return Ok("Error: terminal ID required. Usage: terminal-read:TERM_ID".into());}let raw=call!("terminal-read");if raw==V::Null{return Ok(t!("Error: terminal \"{}\" not found.",p.clone()));}Ok(t!("[Terminal: {}] last output:\n{}",p.clone(),tail(&raw,3000,true)?))},
        "terminal-input"=>{let Some(i)=p.units().iter().position(|u|*u==58)else{return Ok("Error: format is terminal-input:TERM_ID:command. Example: terminal-input:term-123:npm test".into());};let id=V::String(p.units()[..i].to_vec()).trim();let input=concat(&[V::String(p.units()[i+1..].to_vec()),"\r".into()]);let r=s.call(cmd,&id,&input,c).await?;if r==V::Null{return Ok(t!("Error: terminal \"{}\" not found.",id));}Ok(t!("[OK] Sent to {}. Recent output:\n{}",id,tail(&r,2000,true)?))},
        "terminal-create"=>{let i=p.units().iter().position(|u|*u==58);let id=V::String(p.units()[..i.unwrap_or(p.units().len())].to_vec()).trim();let input=V::String(i.map(|n|p.units()[n+1..].to_vec()).unwrap_or_default()).trim();if !id.truthy(){return Ok("Error: project ID required. Usage: terminal-create:PROJECT_ID[:command]".into());}let r=s.call(cmd,&id,&input,c).await?;if !r.truthy(){return Ok(t!("Error: failed to create terminal for project \"{}\". Check project ID.",id));}Ok(t!("[OK] Created terminal {} for project {}{}.\nInitial output:\n{}",field!(&r,"id"),id,if input.truthy(){t!(" with command: {}",input)}else{"".into()},tail(&r["output"],1000,false)?))},
        "git-commit"|"git-push"=>{if !p.truthy(){return Ok(t!("Error: project ID required. Usage: {}:PROJECT_ID",cmd.into()));}let project=call!("project")["project"].clone();if !project.truthy(){return Ok(t!("Error: project \"{}\" not found.",p.clone()));}match s.call(cmd,p,extra,c).await{Ok(output)=>Ok(t!("[OK] {} {}:\n{}",if cmd=="git-commit"{"Committed to".into()}else{"Pushed".into()},field!(&project,"name"),output.cut(500))),Err(e)=>Ok(t!("Error: git {} failed — {}",if cmd=="git-commit"{"commit".into()}else{"push".into()},e.into()))}},
        _=>Ok(t!("Error: unknown cockpit command \"{}\". Available: usage, projects, project:ID, prs, prs:ID, sessions, notes, note:ID, note-create:TITLE, note-update:ID, system, briefing, alerts, activity, workflows, workflow:ID, workflow-runs, workflow-run:ID, workflow-start:ID, terminals, terminal-read:ID, terminal-input:ID:cmd, terminal-create:PROJ_ID[:cmd], git-commit:PROJ_ID, git-push:PROJ_ID",cmd.into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct Snapshot {
        values: V,
        calls: Mutex<Vec<V>>,
    }
    impl Services for Snapshot {
        fn call<'a>(
            &'a self,
            operation: &'a str,
            parameter: &'a V,
            input: &'a V,
            _: &'a Cancel,
        ) -> Pending<'a, V> {
            Box::pin(async move {
                self.calls.lock().unwrap().push(object([
                    ("operation", operation.into()),
                    ("parameter", parameter.clone()),
                    ("input", input.clone()),
                ]));
                let value = self.values[operation].clone();
                if value.has("__error") {
                    Err(value["__error"].text())
                } else {
                    Ok(value)
                }
            })
        }
    }

    #[tokio::test]
    async fn original_cockpit_text_and_dispatch_contract() {
        let fixtures = V::parse(
            &serde_json::value::RawValue::from_string(
                include_str!("../../tests/fixtures/rust-agent-service-cockpit.json").into(),
            )
            .unwrap(),
        )
        .unwrap();
        let mut differences = vec![];
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let services = Snapshot {
                values: input["snapshot"].clone(),
                calls: Mutex::new(vec![]),
            };
            let result = execute(
                &input["argument"],
                &services,
                &Cancel::default(),
                input["now"].number() as i64,
            )
            .await;
            let actual = match result {
                Ok(value) => object([("value", value)]),
                Err(message) => object([("error", message.into())]),
            };
            let calls = V::Array(services.calls.into_inner().unwrap());
            if actual != fixture["expected"] || calls != fixture["calls"] {
                differences.push(format!("case {index}: {}\nexpected: {}\nactual: {}\nexpected calls: {}\nactual calls: {}", input["argument"].raw(), fixture["expected"].raw(), actual.raw(), fixture["calls"].raw(), calls.raw()));
            }
        }
        assert!(
            differences.is_empty(),
            "{} source differences:\n{}",
            differences.len(),
            differences
                .iter()
                .take(12)
                .cloned()
                .collect::<Vec<_>>()
                .join("\n\n")
        );
    }

    #[tokio::test]
    async fn already_cancelled_request_cannot_start_a_mutation() {
        let services = Snapshot {
            values: V::object(),
            calls: Mutex::new(vec![]),
        };
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(
            execute(&"git-push:p1".into(), &services, &cancel, 0).await,
            Err("Agent request cancelled".into())
        );
        assert!(services.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn workflow_input_keeps_literal_surrogates_without_repairing_bad_escapes() {
        for (escaped, expected) in [
            (false, object([("x", V::String(vec![0xd800]))])),
            (true, V::object()),
        ] {
            let services = Snapshot {
                values: V::object(),
                calls: Mutex::new(vec![]),
            };
            let mut units: Vec<_> = "workflow-start:w1\n{\"x\":\"".encode_utf16().collect();
            if escaped {
                units.push(92);
            }
            units.push(0xd800);
            units.extend("\"}".encode_utf16());
            execute(&V::String(units), &services, &Cancel::default(), 0)
                .await
                .unwrap();
            assert_eq!(services.calls.lock().unwrap()[0]["input"], expected);
        }
    }
}
