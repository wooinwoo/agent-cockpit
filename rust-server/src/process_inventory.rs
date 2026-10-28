//! Conservative inventory and identity-pinned cleanup of abandoned Cockpit MCPs.
use serde_json::{json, Value};
use std::{collections::HashSet, io};

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        fs::{self, File},
        io::Read,
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::fs::MetadataExt,
        },
        path::{Component, Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    const MIN_AGE: u64 = 600;
    #[derive(Clone)]
    struct Process {
        pid: u32,
        parent: u32,
        uid: u32,
        name: String,
        state: char,
        start: u64,
        pages: u64,
        exe: PathBuf,
        args: Vec<String>,
    }

    fn invalid() -> io::Error {
        io::Error::new(io::ErrorKind::InvalidData, "Invalid process metadata")
    }
    fn bounded(path: &Path, limit: usize) -> io::Result<Vec<u8>> {
        let mut bytes = Vec::new();
        File::open(path)?
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(invalid());
        }
        Ok(bytes)
    }
    fn parse_stat(text: &str, uid: u32) -> io::Result<Process> {
        let (pid, rest) = text.split_once(" (").ok_or_else(invalid)?;
        let (name, fields) = rest.rsplit_once(") ").ok_or_else(invalid)?;
        let fields: Vec<_> = fields.split_whitespace().collect();
        if fields.len() < 22 {
            return Err(invalid());
        }
        Ok(Process {
            pid: pid.parse().map_err(|_| invalid())?,
            parent: fields[1].parse().map_err(|_| invalid())?,
            uid,
            name: name.chars().filter(|c| !c.is_control()).take(64).collect(),
            state: fields[0].chars().next().ok_or_else(invalid)?,
            start: fields[19].parse().map_err(|_| invalid())?,
            pages: fields[21].parse::<i64>().map_err(|_| invalid())?.max(0) as u64,
            exe: PathBuf::new(),
            args: Vec::new(),
        })
    }
    fn read_stat(pid: u32) -> io::Result<Process> {
        let dir = PathBuf::from(format!("/proc/{pid}"));
        let uid = fs::metadata(&dir)?.uid();
        let data = bounded(&dir.join("stat"), 4096)?;
        let process = parse_stat(std::str::from_utf8(&data).map_err(|_| invalid())?, uid)?;
        if process.pid != pid {
            return Err(invalid());
        }
        Ok(process)
    }
    fn read_process(pid: u32) -> io::Result<Process> {
        let mut process = read_stat(pid)?;
        let dir = PathBuf::from(format!("/proc/{pid}"));
        // PID 1 is the namespace reaper; its executable link may be root-only.
        if pid == 1 && process.uid == 0 && matches!(process.name.as_str(), "init" | "systemd") {
            process.exe = PathBuf::from(&process.name);
            return Ok(process);
        }
        if !matches!(process.state, 'Z' | 'X') {
            process.exe = fs::read_link(dir.join("exe"))?;
            process.args = bounded(&dir.join("cmdline"), 64 * 1024)?
                .split(|b| *b == 0)
                .filter(|v| !v.is_empty())
                .map(|v| String::from_utf8_lossy(v).into_owned())
                .collect();
        }
        Ok(process)
    }
    fn npx_mcp(path: &Path) -> bool {
        if !path.is_absolute() {
            return false;
        }
        let mut inside = false;
        let mut mcp = false;
        for component in path.components() {
            match component {
                Component::ParentDir | Component::CurDir => return false,
                Component::Normal(value) => {
                    let value = value.to_string_lossy();
                    if inside && value.to_ascii_lowercase().contains("mcp") {
                        mcp = true;
                    }
                    if value == "_npx" {
                        inside = true;
                    }
                }
                _ => {}
            }
        }
        inside && mcp
    }
    fn is_mcp(process: &Process) -> bool {
        if npx_mcp(&process.exe) {
            return true;
        }
        if !matches!(
            process.exe.file_name().and_then(|v| v.to_str()),
            Some("node" | "nodejs" | "bun")
        ) {
            return false;
        }
        let mut args = process.args.iter().skip(1);
        let script = args.find(|arg| {
            !matches!(
                arg.as_str(),
                "--no-warnings" | "--enable-source-maps" | "--experimental-strip-types"
            )
        });
        script.is_some_and(|arg| npx_mcp(Path::new(arg)))
    }
    fn reaper(process: &Process, uid: u32) -> bool {
        let executable = process.exe.file_name().and_then(|v| v.to_str());
        if process.pid == 1 {
            return process.uid == 0
                && process.parent == 0
                && matches!(executable, Some("init" | "systemd"));
        }
        process.uid == uid
            && executable == Some("systemd")
            && process.args.iter().skip(1).any(|arg| arg == "--user")
    }
    fn orphan_chain(
        process: &Process,
        uid: u32,
        mut read: impl FnMut(u32) -> io::Result<Process>,
    ) -> bool {
        let mut current = process.clone();
        let mut seen = HashSet::from([current.pid]);
        let mut reached_reaper = false;
        for _ in 0..128 {
            let Ok(parent) = read(current.parent) else {
                return false;
            };
            if !seen.insert(parent.pid)
                || parent.start > current.start
                || matches!(parent.state, 'Z' | 'X')
            {
                return false;
            }
            let is_reaper = reaper(&parent, uid);
            if !is_reaper && (reached_reaper || parent.uid != uid || !is_mcp(&parent)) {
                return false;
            }
            reached_reaper |= is_reaper;
            if parent.pid == 1 {
                return reached_reaper && is_reaper;
            }
            current = parent;
        }
        false
    }
    fn term_id(bytes: &[u8]) -> Option<String> {
        let mut values = bytes
            .split(|b| *b == 0)
            .filter_map(|entry| entry.strip_prefix(b"COCKPIT_TERM_ID="));
        let value = values.next()?;
        if values.next().is_some()
            || value.is_empty()
            || value.len() > 160
            || !value
                .iter()
                .all(|b| b.is_ascii_alphanumeric() || b"_-:.".contains(b))
        {
            return None;
        }
        String::from_utf8(value.to_vec()).ok()
    }
    fn reason(term: Option<&str>, ids: &HashSet<String>, age: u64) -> &'static str {
        if !term.is_some_and(|id| ids.contains(id)) {
            "unverified_session"
        } else if age < MIN_AGE {
            "too_young"
        } else {
            "abandoned_mcp"
        }
    }
    fn identity(process: &Process, pid: u32, start: u64, uid: u32) -> bool {
        process.pid == pid
            && process.start == start
            && process.uid == uid
            && !matches!(process.state, 'Z' | 'X')
    }
    fn clocks() -> io::Result<(f64, u64, u64)> {
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        let uptime = bounded(Path::new("/proc/uptime"), 256)?;
        let uptime: f64 = std::str::from_utf8(&uptime)
            .map_err(|_| invalid())?
            .split_whitespace()
            .next()
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        if ticks <= 0 || page <= 0 || !uptime.is_finite() || uptime < 0.0 {
            return Err(invalid());
        }
        Ok((uptime, ticks as u64, page as u64))
    }
    fn candidate(
        process: &Process,
        ids: &HashSet<String>,
        uptime: f64,
        ticks: u64,
        page: u64,
        uid: u32,
    ) -> Option<Value> {
        if process.uid != uid || !is_mcp(process) || !orphan_chain(process, uid, read_process) {
            return None;
        }
        let env = bounded(
            Path::new(&format!("/proc/{}/environ", process.pid)),
            1024 * 1024,
        )
        .ok();
        let term = env.as_deref().and_then(term_id);
        let elapsed = uptime - process.start as f64 / ticks as f64;
        if elapsed < 0.0 {
            return None;
        }
        let age = elapsed as u64;
        let reason = reason(term.as_deref(), ids, age);
        let after = read_process(process.pid).ok()?;
        if !identity(&after, process.pid, process.start, uid)
            || after.parent != process.parent
            || after.exe != process.exe
            || after.args != process.args
        {
            return None;
        }
        Some(
            json!({"pid":process.pid,"startTicks":process.start.to_string(),"termId":term,"name":process.name,
            "rssKiB":process.pages.saturating_mul(page)/1024,"ageSeconds":age,"eligible":reason=="abandoned_mcp","reason":reason}),
        )
    }
    pub(super) fn snapshot(ids: &HashSet<String>) -> io::Result<Value> {
        let (uptime, ticks, page) = clocks()?;
        let uid = unsafe { libc::geteuid() };
        let mut orphans = Vec::new();
        let mut zombies = Vec::new();
        for entry in fs::read_dir("/proc")? {
            let Ok(entry) = entry else {
                continue;
            };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            if fs::metadata(entry.path())
                .map(|m| m.uid() != uid)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(process) = read_process(pid) else {
                continue;
            };
            if process.uid != uid {
                continue;
            }
            if process.state == 'Z' {
                zombies.push(
                    json!({"pid":pid,"parentPid":process.parent,"name":process.name,"rssKiB":0}),
                );
            } else if let Some(row) = candidate(&process, ids, uptime, ticks, page, uid) {
                orphans.push(row);
            }
        }
        orphans.sort_by_key(|v| v["pid"].as_u64());
        zombies.sort_by_key(|v| v["pid"].as_u64());
        Ok(
            json!({"observedAt":SystemTime::now().duration_since(UNIX_EPOCH).map_err(|_| invalid())?.as_millis() as u64,
            "orphans":orphans,"zombies":zombies,"minimumAgeSeconds":MIN_AGE}),
        )
    }
    pub(super) fn tree_rss_kib(root_pid: u32) -> io::Result<u64> {
        let uid = unsafe { libc::geteuid() };
        let root = read_stat(root_pid)?;
        if root.uid != uid {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        let mut processes = Vec::new();
        for entry in fs::read_dir("/proc")? {
            let Ok(entry) = entry else {
                continue;
            };
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|s| s.parse::<u32>().ok())
            else {
                continue;
            };
            if fs::metadata(entry.path())
                .map(|m| m.uid() != uid)
                .unwrap_or(true)
            {
                continue;
            }
            let Ok(process) = read_stat(pid) else {
                continue;
            };
            if process.uid == uid {
                if processes.len() >= 2048 {
                    return Err(io::Error::other("Process inventory exceeds 2048 entries"));
                }
                processes.push(process);
            }
        }
        let current = read_stat(root_pid)?;
        if !identity(&current, root_pid, root.start, uid) {
            return Err(io::Error::other("Process identity changed"));
        }
        let pages = tree_pages(&root, &processes)?;
        let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if page <= 0 {
            return Err(invalid());
        }
        Ok(pages.saturating_mul(page as u64) / 1024)
    }
    fn tree_pages(root: &Process, processes: &[Process]) -> io::Result<u64> {
        if !processes
            .iter()
            .any(|p| identity(p, root.pid, root.start, root.uid))
        {
            return Err(io::Error::other("Process identity changed"));
        }
        let mut included = HashSet::from([root.pid]);
        loop {
            let previous = included.len();
            for process in processes {
                if process.uid == root.uid
                    && process.start >= root.start
                    && included.contains(&process.parent)
                {
                    included.insert(process.pid);
                }
            }
            if included.len() == previous {
                break;
            }
        }
        Ok(processes
            .iter()
            .filter(|p| {
                p.uid == root.uid && included.contains(&p.pid) && !matches!(p.state, 'Z' | 'X')
            })
            .fold(0_u64, |sum, p| sum.saturating_add(p.pages)))
    }
    fn requests(value: &Value) -> io::Result<Vec<(u32, u64)>> {
        let rows = value
            .as_array()
            .filter(|v| v.len() <= 100)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        let mut requests = Vec::new();
        for row in rows {
            let pid = row["pid"]
                .as_u64()
                .filter(|v| *v > 1 && *v <= i32::MAX as u64)
                .ok_or_else(invalid)? as u32;
            let start = row["startTicks"]
                .as_str()
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
                .and_then(|s| s.parse().ok())
                .ok_or_else(invalid)?;
            if seen.insert((pid, start)) {
                requests.push((pid, start));
            }
        }
        Ok(requests)
    }
    pub(super) fn cleanup(ids: &HashSet<String>, requested: &Value) -> io::Result<Value> {
        let requests = requests(requested)?;
        let uid = unsafe { libc::geteuid() };
        let mut signalled = Vec::new();
        let mut skipped = Vec::new();
        for &(pid, start) in &requests {
            let outcome = (|| -> Result<(), &'static str> {
                let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
                if fd < 0 {
                    return Err("pidfd_unavailable");
                }
                let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
                let process = read_process(pid).map_err(|_| "process_unreadable")?;
                if !identity(&process, pid, start, uid) {
                    return Err("identity_changed");
                }
                let (uptime, ticks, page) = clocks().map_err(|_| "clock_unavailable")?;
                let row =
                    candidate(&process, ids, uptime, ticks, page, uid).ok_or("not_abandoned")?;
                if row["eligible"] != true {
                    return Err(if row["reason"] == "too_young" {
                        "too_young"
                    } else {
                        "unverified_session"
                    });
                }
                // pidfd pins this process: PID reuse never redirects the signal.
                if unsafe {
                    libc::syscall(
                        libc::SYS_pidfd_send_signal,
                        fd.as_raw_fd(),
                        libc::SIGTERM,
                        std::ptr::null::<libc::siginfo_t>(),
                        0,
                    )
                } < 0
                {
                    return Err("signal_failed");
                }
                Ok(())
            })();
            let mut row = json!({"pid":pid,"startTicks":start.to_string()});
            if let Err(reason) = outcome {
                row["reason"] = json!(reason);
                skipped.push(row);
            } else {
                signalled.push(row);
            }
        }
        Ok(json!({"requested":requests.len(),"signalled":signalled,"skipped":skipped}))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        fn process(pid: u32, parent: u32, exe: &str) -> Process {
            Process {
                pid,
                parent,
                uid: 1000,
                name: "node".into(),
                state: 'S',
                start: 100,
                pages: 2,
                exe: exe.into(),
                args: vec![exe.into()],
            }
        }
        fn init() -> Process {
            Process {
                uid: 0,
                start: 0,
                ..process(1, 0, "/sbin/init")
            }
        }
        #[test]
        fn stat_preserves_spaced_parenthesized_names_and_field_offsets() {
            let mut fields = vec!["0"; 22];
            fields[0] = "S";
            fields[1] = "12";
            fields[19] = "123456";
            fields[21] = "42";
            let p = parse_stat(&format!("44 (odd ) process) {}", fields.join(" ")), 1000).unwrap();
            assert_eq!((p.pid, p.parent, p.start, p.pages), (44, 12, 123456, 42));
            assert_eq!(p.name, "odd ) process");
            assert!(parse_stat("44 (broken) S 1", 1000).is_err());
        }
        #[test]
        fn only_actual_npx_mcp_script_matches() {
            let script = "/home/user/.npm/_npx/abc/node_modules/playwright-mcp/cli.js";
            let mut p = process(3, 1, "/usr/bin/node");
            p.args = vec!["node".into(), script.into()];
            assert!(is_mcp(&p));
            p.args = vec!["node".into(), "/tmp/server.js".into(), script.into()];
            assert!(!is_mcp(&p));
            p.args = vec!["node".into(), "--eval".into(), script.into()];
            assert!(!is_mcp(&p));
            assert!(!npx_mcp(Path::new("/tmp/_npx/mcp/../../server.js")));
            assert!(!npx_mcp(Path::new("/tmp/mcp/_npx/package/server.js")));
        }
        #[test]
        fn ancestry_rejects_work_parents_missing_metadata_and_cycles() {
            let p = process(3, 1, "/tmp/_npx/pkg/mcp.js");
            assert!(orphan_chain(&p, 1000, |_| Ok(init())));
            let mut manager = process(2, 1, "/usr/lib/systemd/systemd");
            manager.args.push("--user".into());
            let p = Process { parent: 2, ..p };
            assert!(orphan_chain(&p, 1000, |pid| Ok(if pid == 2 {
                manager.clone()
            } else {
                init()
            })));
            for exe in [
                "/usr/bin/tmux",
                "/usr/bin/code",
                "/usr/bin/claude",
                "/usr/bin/bash",
            ] {
                assert!(!orphan_chain(&p, 1000, |_| Ok(process(2, 1, exe))));
            }
            assert!(!orphan_chain(&p, 1000, |_| Err(invalid())));
            assert!(!orphan_chain(&p, 1000, |_| Ok(process(
                2,
                2,
                "/tmp/_npx/pkg/mcp.js"
            ))));
        }
        #[test]
        fn provenance_age_and_pid_reuse_fail_closed() {
            let ids = HashSet::from(["term-1".into()]);
            assert_eq!(
                term_id(b"TOKEN=never-output\0COCKPIT_TERM_ID=term-1\0"),
                Some("term-1".into())
            );
            assert!(term_id(b"COCKPIT_TERM_ID=a\0COCKPIT_TERM_ID=b\0").is_none());
            assert_eq!(reason(None, &ids, 900), "unverified_session");
            assert_eq!(reason(Some("other"), &ids, 900), "unverified_session");
            assert_eq!(reason(Some("term-1"), &ids, 599), "too_young");
            assert_eq!(reason(Some("term-1"), &ids, 600), "abandoned_mcp");
            let p = process(3, 1, "/usr/bin/node");
            assert!(identity(&p, 3, 100, 1000));
            assert!(!identity(&p, 3, 99, 1000));
            assert!(!identity(&p, 3, 100, 2000));
            assert!(!identity(&Process { state: 'Z', ..p }, 3, 100, 1000));
        }
        #[test]
        fn cleanup_requests_are_bounded_and_deduplicated() {
            let row = json!({"pid":3,"startTicks":"100"});
            assert_eq!(requests(&json!([row, row])).unwrap(), vec![(3, 100)]);
            assert!(requests(&json!([{"pid":1,"startTicks":"100"}])).is_err());
            assert!(requests(&json!([{"pid":3,"startTicks":100}])).is_err());
            assert!(requests(&Value::Array(vec![row; 101])).is_err());
        }
        #[test]
        fn memory_tree_includes_only_owned_descendants_and_requires_same_root() {
            let root = process(3, 1, "/usr/bin/node");
            let rows = vec![
                process(5, 4, "/usr/bin/node"),
                process(4, 3, "/usr/bin/node"),
                Process {
                    uid: 2000,
                    ..process(6, 3, "/usr/bin/node")
                },
                Process {
                    state: 'Z',
                    ..process(7, 3, "/usr/bin/node")
                },
                process(8, 2, "/usr/bin/node"),
                root.clone(),
            ];
            assert_eq!(tree_pages(&root, &rows).unwrap(), 6);
            assert!(tree_pages(
                &Process {
                    start: 99,
                    ..root.clone()
                },
                &rows
            )
            .is_err());
            assert!(tree_pages(&root, &[]).is_err());
        }
    }
}

/// `known_ids` must contain only persisted sessions that are no longer active.
pub fn snapshot(known_ids: &HashSet<String>) -> io::Result<Value> {
    #[cfg(target_os = "linux")]
    {
        linux::snapshot(known_ids)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = known_ids;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Process inventory requires Linux",
        ))
    }
}

/// Signal only freshly verified MCPs belonging to inactive, persisted sessions.
pub fn cleanup(known_ids: &HashSet<String>, requested: &Value) -> io::Result<Value> {
    #[cfg(target_os = "linux")]
    {
        linux::cleanup(known_ids, requested)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (known_ids, requested);
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Process cleanup requires Linux",
        ))
    }
}

/// Same-user descendant RSS sum; shared pages can be counted more than once.
pub fn tree_rss_kib(root_pid: u32) -> io::Result<u64> {
    #[cfg(target_os = "linux")]
    {
        linux::tree_rss_kib(root_pid)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root_pid;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Process memory inventory requires Linux",
        ))
    }
}
