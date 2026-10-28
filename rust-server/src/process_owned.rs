//! Commands whose process group, streams and cancellation share one owner.
use crate::ai_transport::Cancel;
pub use std::process::Output;
use std::time::Duration;
use tokio::process::Command;
#[cfg(unix)]
use {
    std::{io, process::Stdio},
    tokio::io::{AsyncRead, AsyncReadExt},
};

// Keep the group leader unreaped until group cleanup. Its reserved PID prevents
// a late cancellation or Drop from signalling an unrelated, reused process group.
#[cfg(unix)]
pub(crate) struct OwnedChild {
    child: Option<tokio::process::Child>,
    armed: bool,
}
#[cfg(unix)]
impl OwnedChild {
    // The caller must spawn the child with process_group(0), kill_on_drop(false),
    // and must not reap it independently of this owner.
    pub(crate) fn new(child: tokio::process::Child) -> Self {
        Self {
            child: Some(child),
            armed: true,
        }
    }
    pub(crate) fn child_mut(&mut self) -> &mut tokio::process::Child {
        self.child.as_mut().expect("owned child")
    }

    fn observed_exit(&self) -> io::Result<bool> {
        let pid = self
            .child
            .as_ref()
            .expect("owned child")
            .id()
            .ok_or_else(|| io::Error::other("Claude PID ownership lost"))?;
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        loop {
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result == 0 {
                return Ok(unsafe { info.si_pid() } != 0);
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    fn kill_group(&mut self) -> io::Result<()> {
        if !self.armed {
            return Ok(());
        }
        self.armed = false;
        // ECHILD means an external reaper invalidated ownership. Never signal it.
        self.observed_exit()?;
        let pid = self.child_mut().id().unwrap();
        if unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    pub(crate) async fn wait_and_clean(&mut self) -> io::Result<std::process::ExitStatus> {
        loop {
            if self.observed_exit()? {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.kill_group()?;
        self.child_mut().wait().await
    }
    pub(crate) async fn terminate(&mut self) {
        if self.kill_group().is_ok() {
            let _ = self.child_mut().wait().await;
        }
    }
}
#[cfg(unix)]
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.kill_group();
        let Some(mut child) = self.child.take().filter(|child| child.id().is_some()) else {
            return;
        };
        // A dropped future may be the runtime's last process operation. Move
        // ownership to a reaper rather than relying on Tokio's orphan queue
        // receiving another SIGCHLD or spawn. Only this Child calls try_wait.
        let _ = std::thread::Builder::new()
            .name("cockpit-command-reaper".into())
            .spawn(move || loop {
                match child.try_wait() {
                    Ok(Some(_)) | Err(_) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                }
            });
    }
}

// These checks keep descendants in the owned process group. They do not
// restrict filesystem or network access and are not a general-purpose sandbox.
// Filters survive fork/exec and cannot be removed after NO_NEW_PRIVS is set:
// https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn install_group_filter() -> io::Result<()> {
    const fn instruction(code: u16, jt: u8, jf: u8, k: u32) -> libc::sock_filter {
        libc::sock_filter { code, jt, jf, k }
    }
    const LOAD: u16 = (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16;
    const EQ: u16 = (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16;
    const GE: u16 = (libc::BPF_JMP | libc::BPF_JGE | libc::BPF_K) as u16;
    const SET: u16 = (libc::BPF_JMP | libc::BPF_JSET | libc::BPF_K) as u16;
    const RET: u16 = (libc::BPF_RET | libc::BPF_K) as u16;
    const DENY: u32 = libc::SECCOMP_RET_ERRNO | libc::EPERM as u32;
    const UNAVAILABLE: u32 = libc::SECCOMP_RET_ERRNO | libc::ENOSYS as u32;
    const NAMESPACES: u32 = (libc::CLONE_NEWCGROUP
        | libc::CLONE_NEWIPC
        | libc::CLONE_NEWNET
        | libc::CLONE_NEWNS
        | libc::CLONE_NEWPID
        | libc::CLONE_NEWUSER
        | libc::CLONE_NEWUTS) as u32
        | 0x00000080; // CLONE_NEWTIME; clone3 is denied separately.
    let mut filter = [
        instruction(LOAD, 0, 0, 4),        // seccomp_data.arch
        instruction(EQ, 1, 0, 0xc000003e), // AUDIT_ARCH_X86_64
        instruction(RET, 0, 0, libc::SECCOMP_RET_KILL_PROCESS),
        instruction(LOAD, 0, 0, 0), // seccomp_data.nr
        // Deny x32's syscall bit and its historical 512..547 aliases. Future
        // syscalls above this reviewed ABI range also fail closed.
        instruction(GE, 0, 1, 512),
        instruction(RET, 0, 0, UNAVAILABLE),
        instruction(EQ, 0, 1, libc::SYS_setsid as u32),
        instruction(RET, 0, 0, DENY),
        instruction(EQ, 0, 1, libc::SYS_setpgid as u32),
        instruction(RET, 0, 0, DENY),
        instruction(EQ, 0, 1, libc::SYS_unshare as u32),
        instruction(RET, 0, 0, DENY),
        instruction(EQ, 0, 1, libc::SYS_setns as u32),
        instruction(RET, 0, 0, DENY),
        // Avoid old-kernel ptrace/seccomp syscall-rewrite bypasses.
        instruction(EQ, 0, 1, libc::SYS_ptrace as u32),
        instruction(RET, 0, 0, DENY),
        // clone3 arguments are behind a pointer; return ENOSYS so libc can use
        // clone for ordinary threads/forks without uninspectable namespaces.
        instruction(EQ, 0, 1, libc::SYS_clone3 as u32),
        instruction(RET, 0, 0, UNAVAILABLE),
        instruction(EQ, 0, 3, libc::SYS_clone as u32),
        instruction(LOAD, 0, 0, 16), // low word of args[0], x86_64 little endian
        instruction(SET, 0, 1, NAMESPACES),
        instruction(RET, 0, 0, DENY),
        instruction(RET, 0, 0, libc::SECCOMP_RET_ALLOW),
    ];
    let program = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_mut_ptr(),
    };
    // Called only from pre_exec: stack data and async-signal-safe syscalls.
    if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER,
            &program,
            0,
            0,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(unix)]
async fn read_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            return Ok(result);
        }
        if count > limit.saturating_sub(result.len()) {
            return Err(io::Error::other("Command output exceeded limit"));
        }
        result.extend_from_slice(&chunk[..count]);
    }
}

/// Capture each stream up to `limit` bytes. Nonzero exit status remains data.
/// Cancellation, timeout, read failure and dropping the future clean the group.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn spawn_owned(mut command: Command) -> io::Result<OwnedChild> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    unsafe {
        command.pre_exec(install_group_filter);
    }
    Ok(OwnedChild::new(command.spawn()?))
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub async fn run(
    command: Command,
    timeout: Duration,
    limit: usize,
    cancel: &Cancel,
) -> Result<Output, String> {
    if cancel.is_cancelled() {
        return Err("Command cancelled".into());
    }
    // Command establishes the new group before pre_exec. The filter then
    // prevents this process or its descendants leaving that group.
    let mut child =
        spawn_owned(command).map_err(|error| format!("Failed to run command: {error}"))?;
    let stdout = child.child_mut().stdout.take().unwrap();
    let stderr = child.child_mut().stderr.take().unwrap();
    let result = {
        let execution = async {
            let (status, stdout, stderr) = tokio::try_join!(
                child.wait_and_clean(),
                read_bounded(stdout, limit),
                read_bounded(stderr, limit),
            )?;
            Ok::<_, io::Error>(Output {
                status,
                stdout,
                stderr,
            })
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Command cancelled".into()),
            value = tokio::time::timeout(timeout, execution) => match value {
                Err(_) => Err("Command timed out".into()),
                Ok(Err(error)) => Err(format!("Command I/O failed: {error}")),
                Ok(Ok(output)) => Ok(output),
            }
        }
    };
    // Dropped stream futures release their pipe handles before cleanup/reaping.
    if result.is_err() {
        child.terminate().await;
    }
    result
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
pub async fn run(
    _command: Command,
    _timeout: Duration,
    _limit: usize,
    _cancel: &Cancel,
) -> Result<Output, String> {
    Err("Native owned command isolation is only validated on Linux x86_64".into())
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::*;
    use std::{fs, path::Path};

    fn command(directory: &Path, script: &str) -> Command {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", script]).current_dir(directory);
        command
    }

    #[tokio::test]
    async fn nonzero_and_exact_stream_limits_remain_outputs() {
        let directory = tempfile::tempdir().unwrap();
        let output = run(
            command(directory.path(), "printf 'out'; printf 'err' >&2; exit 7"),
            Duration::from_secs(3),
            3,
            &Cancel::default(),
        )
        .await
        .unwrap();
        assert_eq!(output.status.code(), Some(7));
        assert_eq!(output.stdout, b"out");
        assert_eq!(output.stderr, b"err");
    }

    #[tokio::test]
    async fn precancel_never_spawns() {
        let directory = tempfile::tempdir().unwrap();
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(
            run(
                command(directory.path(), "printf forbidden > spawned"),
                Duration::from_secs(3),
                100,
                &cancel,
            )
            .await
            .unwrap_err(),
            "Command cancelled"
        );
        assert!(!directory.path().join("spawned").exists());
    }

    // Run only in a subprocess created by the owned runner. The ordinary test
    // invocation never installs a filter on the host test harness.
    #[test]
    fn seccomp_probe() {
        let Ok(mode) = std::env::var("COCKPIT_OWNED_SECCOMP_PROBE") else {
            return;
        };
        if mode == "compat" {
            // Harmless i386 getpid would succeed without the architecture gate.
            unsafe {
                core::arch::asm!("int 0x80", inout("eax") 20u32 => _, options(nostack));
            }
            panic!("compat syscall bypassed the architecture check");
        }
        assert_eq!(
            unsafe { libc::prctl(libc::PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) },
            1
        );
        assert_eq!(std::thread::spawn(|| 42).join().unwrap(), 42);
        let forked = unsafe { libc::fork() };
        assert!(forked >= 0, "ordinary fork must remain usable");
        if forked == 0 {
            unsafe {
                libc::_exit(17);
            }
        }
        let mut status = 0;
        assert_eq!(unsafe { libc::waitpid(forked, &mut status, 0) }, forked);
        assert_eq!(libc::WEXITSTATUS(status), 17);
        for (syscall, first) in [
            (libc::SYS_setsid, 0),
            (libc::SYS_setpgid, 0),
            (libc::SYS_unshare, 0),
            (libc::SYS_setns, -1),
            (libc::SYS_ptrace, 0),
        ] {
            assert_eq!(
                unsafe { libc::syscall(syscall, first as libc::c_long, 0, 0, 0, 0, 0) },
                -1
            );
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
        }
        for namespace in [
            libc::CLONE_NEWCGROUP,
            libc::CLONE_NEWIPC,
            libc::CLONE_NEWNET,
            libc::CLONE_NEWNS,
            libc::CLONE_NEWPID,
            libc::CLONE_NEWUSER,
            libc::CLONE_NEWUTS,
            0x80,
        ] {
            let result = unsafe {
                libc::syscall(
                    libc::SYS_clone,
                    (namespace | libc::SIGCHLD) as libc::c_ulong,
                    0,
                    0,
                    0,
                    0,
                )
            };
            if result == 0 {
                unsafe {
                    libc::_exit(18);
                }
            }
            assert_eq!(result, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::EPERM));
        }
        for syscall in [
            libc::SYS_clone3,
            libc::SYS_getpid | 0x40000000,
            512,
            521,
            547,
        ] {
            assert_eq!(unsafe { libc::syscall(syscall, 0, 0, 0, 0, 0, 0) }, -1);
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::ENOSYS)
            );
        }
    }

    #[tokio::test]
    async fn filter_blocks_group_namespaces_and_compat_but_preserves_threads_and_fork() {
        use std::os::unix::process::ExitStatusExt;
        for mode in ["syscalls", "compat"] {
            let mut probe = Command::new(std::env::current_exe().unwrap());
            probe
                .args([
                    "--exact",
                    "process_owned::tests::seccomp_probe",
                    "--nocapture",
                ])
                .env("COCKPIT_OWNED_SECCOMP_PROBE", mode);
            let output = run(probe, Duration::from_secs(5), 8192, &Cancel::default())
                .await
                .unwrap();
            if mode == "compat" {
                assert_eq!(output.status.signal(), Some(libc::SIGSYS));
            } else {
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
    }

    #[tokio::test]
    async fn setsid_cannot_escape_to_write_after_command_exit() {
        for wait in ["", " -w"] {
            let directory = tempfile::tempdir().unwrap();
            fs::write(
                directory.path().join("task.sh"),
                "/bin/sleep 0.05\nprintf forbidden > escaped-write\n",
            )
            .unwrap();
            let output = run(
                command(
                    directory.path(),
                    &format!("/usr/bin/setsid -f{wait} /bin/sh task.sh"),
                ),
                Duration::from_secs(3),
                8192,
                &Cancel::default(),
            )
            .await
            .unwrap();
            if !wait.is_empty() {
                assert!(!output.status.success());
                assert!(String::from_utf8_lossy(&output.stderr).contains("Operation not permitted"));
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
            assert!(!directory.path().join("escaped-write").exists());
        }
    }

    fn identity(path: &Path) -> Option<(u32, String)> {
        let stat = fs::read_to_string(path).ok()?;
        Some((
            stat.split_whitespace().next()?.parse().ok()?,
            stat.rsplit_once(") ")?
                .1
                .split_whitespace()
                .nth(19)?
                .to_owned(),
        ))
    }

    async fn identities(directory: &Path) -> Vec<(u32, String)> {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let rows: Option<Vec<_>> = ["leader-stat", "child-stat", "grandchild-stat"]
                    .iter()
                    .map(|name| identity(&directory.join(name)))
                    .collect();
                if let Some(rows) = rows {
                    return rows;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("fixture process group must start")
    }

    async fn assert_clean(rows: &[(u32, String)], scenario: &str) {
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let alive = rows.iter().enumerate().any(|(index, (pid, start))| {
                    let Ok(stat) = fs::read_to_string(format!("/proc/{pid}/stat")) else {
                        return false;
                    };
                    let fields: Vec<_> = stat
                        .rsplit_once(") ")
                        .unwrap()
                        .1
                        .split_whitespace()
                        .collect();
                    fields[19] == start && (index == 0 || !matches!(fields[0], "Z" | "X"))
                });
                if !alive {
                    return;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            let states: Vec<_> = rows
                .iter()
                .map(|(pid, _)| fs::read_to_string(format!("/proc/{pid}/stat")))
                .collect();
            panic!("{scenario}: leader must be reaped; owned descendants must stop executing: {states:?}");
        });
    }

    #[tokio::test]
    async fn normal_cancel_timeout_drop_and_both_overflows_clean_descendants() {
        for scenario in ["normal", "cancel", "timeout", "drop", "stdout", "stderr"] {
            let directory = tempfile::tempdir().unwrap();
            fs::write(directory.path().join("grandchild.sh"), "#!/bin/sh\n/bin/cat /proc/$$/stat > grandchild-stat\nwhile [ ! -f attempt-write ]; do /bin/sleep 0.01; done\nprintf forbidden > forbidden-write\n").unwrap();
            fs::write(
                directory.path().join("child.sh"),
                "#!/bin/sh\n/bin/cat /proc/$$/stat > child-stat\n/bin/sh grandchild.sh &\nwait\n",
            )
            .unwrap();
            let finish = match scenario {
                "stdout" => "/usr/bin/head -c 4097 /dev/zero; /bin/sleep 30",
                "stderr" => "/usr/bin/head -c 4097 /dev/zero >&2; /bin/sleep 30",
                _ => "printf finished; exit 0",
            };
            let script = format!("/bin/cat /proc/$$/stat > leader-stat\n/bin/sh child.sh &\nwhile [ ! -f release ]; do /bin/sleep 0.01; done\n{finish}");
            let fixture = command(directory.path(), &script);
            let cancel = Cancel::default();
            let request_cancel = cancel.clone();
            let timeout = if scenario == "timeout" {
                Duration::from_secs(3)
            } else {
                Duration::from_secs(10)
            };
            let task =
                tokio::spawn(async move { run(fixture, timeout, 4096, &request_cancel).await });
            let rows = identities(directory.path()).await;
            for (pid, _) in &rows {
                assert_eq!(unsafe { libc::getpgid(*pid as i32) }, rows[0].0 as i32);
                assert_ne!(unsafe { libc::getpgid(*pid as i32) }, unsafe {
                    libc::getpgrp()
                });
            }
            match scenario {
                "normal" | "stdout" | "stderr" => {
                    fs::write(directory.path().join("release"), "exit").unwrap();
                    let result = tokio::time::timeout(Duration::from_secs(2), task)
                        .await
                        .expect("inherited pipes must not delay cleanup")
                        .unwrap();
                    if scenario == "normal" {
                        let output = result.unwrap();
                        assert!(output.status.success());
                        assert_eq!(output.stdout, b"finished");
                    } else {
                        assert_eq!(
                            result.unwrap_err(),
                            "Command I/O failed: Command output exceeded limit"
                        );
                    }
                }
                "cancel" => {
                    cancel.cancel();
                    assert_eq!(task.await.unwrap().unwrap_err(), "Command cancelled");
                }
                "timeout" => assert_eq!(task.await.unwrap().unwrap_err(), "Command timed out"),
                _ => {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                }
            }
            assert_clean(&rows, scenario).await;
            fs::write(directory.path().join("attempt-write"), "attempt").unwrap();
            tokio::time::sleep(Duration::from_millis(50)).await;
            assert!(!directory.path().join("forbidden-write").exists());
        }
    }
}
