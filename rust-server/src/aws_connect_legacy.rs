//! Exact, identity-pinned termination of tunnel commands started outside Cockpit.
//! The commands are listed per machine in `<data-dir>/aws-connect-legacy.json`:
//! `[{"id","profile","rdsInstance","localPort","region","script"}]`, where `script` is
//! relative to the home directory. Without that file nothing is ever matched.
use super::Target;
use std::{path::Path, sync::OnceLock};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub struct Legacy {
    id: String,
    profile: String,
    rds_instance: String,
    local_port: u16,
    region: String,
    script: String,
}
static CONFIG: OnceLock<Vec<Legacy>> = OnceLock::new();
pub fn configure(directory: &Path) {
    let rows = std::fs::read(directory.join("aws-connect-legacy.json"))
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_default();
    let _ = CONFIG.set(rows);
}
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn configured() -> &'static [Legacy] {
    CONFIG.get().map(Vec::as_slice).unwrap_or(&[])
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::{
        collections::HashSet,
        fs,
        io::Read,
        os::{
            fd::{FromRawFd, OwnedFd},
            unix::fs::MetadataExt,
        },
        path::PathBuf,
    };

    pub struct Process {
        pid: u32,
        parent: u32,
        start: u64,
        args: Vec<String>,
        cwd: PathBuf,
        exe: PathBuf,
    }
    fn identity(pid: u32) -> Option<(u32, u64)> {
        let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let fields: Vec<_> = text.rsplit_once(") ")?.1.split_whitespace().collect();
        Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
    }
    pub fn inventory() -> Vec<Process> {
        let Ok(entries) = fs::read_dir("/proc") else {
            return vec![];
        };
        entries
            .flatten()
            .filter_map(|entry| {
                let pid = entry.file_name().to_str()?.parse::<u32>().ok()?;
                if entry.metadata().ok()?.uid() != unsafe { libc::geteuid() } {
                    return None;
                }
                let (parent, start) = identity(pid)?;
                let mut bytes = Vec::new();
                fs::File::open(entry.path().join("cmdline"))
                    .ok()?
                    .take(16385)
                    .read_to_end(&mut bytes)
                    .ok()?;
                if bytes.len() > 16384 {
                    return None;
                }
                let args = bytes
                    .split(|byte| *byte == 0)
                    .filter(|s| !s.is_empty())
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .collect();
                let cwd = fs::read_link(entry.path().join("cwd")).unwrap_or_default();
                Some(Process {
                    pid,
                    parent,
                    start,
                    args,
                    cwd,
                    exe: fs::read_link(entry.path().join("exe")).ok()?,
                })
            })
            .collect()
    }
    fn flag(args: &[String], name: &str, value: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == name && pair[1] == value)
    }
    fn script(rows: &[super::Legacy], target: &Target) -> Option<PathBuf> {
        rows.iter()
            .find(|row| {
                row.id == target.id
                    && row.profile == target.profile
                    && row.rds_instance == target.rds_instance
                    && row.local_port == target.local_port
                    && row.region == target.region
            })
            .map(|row| super::super::home().join(&row.script))
    }
    fn root(process: &Process, target: &Target) -> bool {
        root_in(super::configured(), process, target)
    }
    fn root_in(rows: &[super::Legacy], process: &Process, target: &Target) -> bool {
        let Some(script) = script(rows, target) else {
            return false;
        };
        let script = script.canonicalize().unwrap_or(script);
        let shell = matches!(
            process.exe.file_name().and_then(|s| s.to_str()),
            Some("bash" | "sh" | "dash")
        );
        let script_arg = if shell && process.args.len() == 2 {
            process.args.get(1)
        } else if shell && process.args.len() == 3 && process.args[1] == "--" {
            process.args.get(2)
        } else {
            None
        };
        let old_script = script_arg.is_some_and(|arg| {
            let path = PathBuf::from(arg);
            let path = if path.is_absolute() {
                path
            } else {
                process.cwd.join(path)
            };
            path.canonicalize().unwrap_or(path) == script
        });
        if old_script {
            return true;
        }
        let Some(basti) =
            super::super::executable("basti").and_then(|path| path.canonicalize().ok())
        else {
            return false;
        };
        matches!(
            process.exe.file_name().and_then(|s| s.to_str()),
            Some("node" | "nodejs")
        ) && process
            .args
            .get(1)
            .is_some_and(|arg| PathBuf::from(arg).canonicalize().ok().as_ref() == Some(&basti))
            && process.args.iter().any(|arg| arg == "connect")
            && flag(&process.args, "--rds-instance", &target.rds_instance)
            && flag(
                &process.args,
                "--local-port",
                &target.local_port.to_string(),
            )
            && flag(&process.args, "--aws-profile", &target.profile)
            && flag(&process.args, "--aws-region", &target.region)
    }
    fn selected<'a>(target: &Target, processes: &'a [Process]) -> Vec<&'a Process> {
        let mut ids: HashSet<_> = processes
            .iter()
            .filter(|p| root(p, target))
            .map(|p| p.pid)
            .collect();
        loop {
            let before = ids.len();
            for process in processes {
                if ids.contains(&process.parent) {
                    ids.insert(process.pid);
                }
            }
            if ids.len() == before {
                break;
            }
        }
        processes
            .iter()
            .filter(|p| ids.contains(&p.pid) && p.pid > 1 && p.pid != std::process::id())
            .collect()
    }
    pub fn count(target: &Target, processes: &[Process]) -> usize {
        selected(target, processes).len()
    }
    fn signal(process: &Process, signal: i32) -> bool {
        // A pidfd refers to this process even if its numeric PID is subsequently reused.
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, process.pid, 0) };
        if fd < 0 {
            return false;
        }
        let owned = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        if identity(process.pid).map(|(_, start)| start) != Some(process.start) {
            return false;
        }
        let result = unsafe {
            libc::syscall(
                libc::SYS_pidfd_send_signal,
                fd,
                signal,
                std::ptr::null::<libc::siginfo_t>(),
                0,
            )
        };
        drop(owned);
        result == 0
    }
    pub async fn stop(target: &Target) -> usize {
        let first = inventory();
        let roots: Vec<_> = first.iter().filter(|p| root(p, target)).collect();
        if roots.is_empty() {
            return 0;
        }
        let mut count = 0;
        for process in &roots {
            count += usize::from(signal(process, libc::SIGTERM));
        }
        let second = inventory();
        let mut pinned = selected(target, &first);
        pinned.extend(selected(target, &second));
        let mut seen = HashSet::new();
        pinned.retain(|p| seen.insert((p.pid, p.start)));
        for process in &pinned {
            if !roots.iter().any(|root| root.pid == process.pid) {
                count += usize::from(signal(process, libc::SIGTERM));
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        for process in pinned {
            signal(process, libc::SIGKILL);
        }
        count
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn script_matching_requires_exact_path_and_configured_target() {
            let target = super::super::super::presets().remove(0);
            let rows = vec![super::super::Legacy {
                id: target.id.clone(),
                profile: target.profile.clone(),
                rds_instance: target.rds_instance.clone(),
                local_port: target.local_port,
                region: target.region.clone(),
                script: "projects/example/.prod-tunnel-keepalive.sh".into(),
            }];
            let path = super::super::super::home().join("projects/example");
            let process = Process {
                pid: 999999,
                parent: 1,
                start: 1,
                args: vec!["bash".into(), "./.prod-tunnel-keepalive.sh".into()],
                cwd: path,
                exe: PathBuf::from("/usr/bin/bash"),
            };
            assert!(root_in(&rows, &process, &target));
            assert!(!root_in(&[], &process, &target));
            let mut changed = target.clone();
            changed.local_port = 12345;
            assert!(!root_in(&rows, &process, &changed));
            let unrelated = Process {
                args: vec![
                    "bash".into(),
                    "-c".into(),
                    "echo .prod-tunnel-keepalive.sh".into(),
                ],
                ..process
            };
            assert!(!root_in(&rows, &unrelated, &target));
            let viewer = Process {
                pid: 999999,
                parent: 1,
                start: 1,
                args: vec![
                    "vim".into(),
                    super::super::super::home()
                        .join("projects/example/.prod-tunnel-keepalive.sh")
                        .to_string_lossy()
                        .into_owned(),
                ],
                cwd: PathBuf::from("/"),
                exe: PathBuf::from("/usr/bin/vim"),
            };
            assert!(!root_in(&rows, &viewer, &target));
            let syntax_check = Process {
                args: vec!["bash".into(), "-n".into(), viewer.args[1].clone()],
                exe: PathBuf::from("/usr/bin/bash"),
                ..viewer
            };
            assert!(!root_in(&rows, &syntax_check, &target));
        }
    }
}
#[cfg(target_os = "linux")]
pub use linux::{count, inventory, stop};
#[cfg(not(target_os = "linux"))]
pub fn inventory() -> Vec<()> {
    vec![]
}
#[cfg(not(target_os = "linux"))]
pub fn count(_target: &Target, _processes: &[()]) -> usize {
    0
}
#[cfg(not(target_os = "linux"))]
pub async fn stop(_target: &Target) -> usize {
    0
}
