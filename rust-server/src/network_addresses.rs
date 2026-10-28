//! Local connection addresses. Windows interop is restricted to a fixed,
//! read-only Tailscale status command; token and URL construction lives elsewhere.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    process_owned,
};
use std::{net::Ipv4Addr, time::Duration};
use tokio::process::Command;

const WINDOWS_TAILSCALE: &str = "/mnt/c/Program Files/Tailscale/tailscale.exe";
const STATUS_TIMEOUT: Duration = Duration::from_secs(3);
const STATUS_LIMIT: usize = 1024 * 1024;
type Groups = Vec<(String, V)>;

fn check_cancel(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Network address discovery cancelled".into())
    } else {
        Ok(())
    }
}
fn ipv4(value: &V) -> Option<Ipv4Addr> {
    if !value.is_string() {
        return None;
    }
    value.text().parse().ok()
}
fn tailscale(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    octets[0] == 100 && (64..=127).contains(&octets[1])
}
fn array_index(value: &str) -> Option<u32> {
    value
        .parse::<u32>()
        .ok()
        .filter(|index| *index < u32::MAX && index.to_string() == value)
}
fn local_addresses(groups: &Groups) -> Vec<V> {
    let mut ordered: Vec<_> = groups.iter().collect();
    // Object.values enumerates integer interface names before other names.
    ordered.sort_by_key(|(name, _)| array_index(name).map_or((1, 0), |index| (0, index)));
    let mut result = Vec::new();
    for (_, nets) in ordered {
        let V::Array(nets) = nets else {
            // Strings iterate characters which have no IPv4 family. Other
            // malformed interface values abort the source's outer try block.
            if nets.is_string() {
                continue;
            }
            break;
        };
        for net in nets {
            if *net == V::Null {
                return result;
            }
            if net["family"] != V::from("IPv4") || net["internal"].truthy() {
                continue;
            }
            let Some(ip) = ipv4(&net["address"]) else {
                continue;
            };
            result.push(object([
                ("ip", net["address"].clone()),
                (
                    "type",
                    if tailscale(ip) { "tailscale" } else { "lan" }.into(),
                ),
            ]));
        }
    }
    result
}
fn magic_dns(value: &V) -> Option<String> {
    if !value.is_string() {
        return None;
    }
    let value = value.text();
    let host = value.strip_suffix('.').unwrap_or(&value).to_lowercase();
    let labels: Vec<_> = host.split('.').collect();
    if labels.len() < 3 || labels[labels.len() - 2..] != ["ts", "net"] {
        return None;
    }
    if labels[..labels.len() - 2].iter().any(|label| {
        label.is_empty()
            || label.len() > 63
            || !label
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !label
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return None;
    }
    Some(host)
}
fn add_windows_status(result: &mut Vec<V>, status: &V) {
    if status["BackendState"] != V::from("Running") {
        return;
    }
    let Some(host) = magic_dns(&status["Self"]["DNSName"]) else {
        return;
    };
    let mut known: std::collections::HashSet<Ipv4Addr> =
        result.iter().filter_map(|item| ipv4(&item["ip"])).collect();
    let mut prepend = Vec::new();
    for value in status["Self"]["TailscaleIPs"].array() {
        let Some(ip) = ipv4(value).filter(|ip| tailscale(*ip)) else {
            continue;
        };
        if !known.insert(ip) {
            continue;
        }
        prepend.push(object([
            ("ip", ip.to_string().into()),
            ("host", host.clone().into()),
            ("type", "tailscale".into()),
        ]));
    }
    // Source unshift reverses newly found Windows addresses; keep that order
    // without quadratic duplicate checks and repeated front insertions.
    prepend.reverse();
    prepend.append(result);
    *result = prepend;
}
fn sorted(mut result: Vec<V>) -> V {
    result.sort_by_key(|item| item["type"] != V::from("tailscale"));
    V::Array(result)
}
fn parse_status(text: &str) -> Option<V> {
    let raw = serde_json::value::RawValue::from_string(text.to_owned()).ok()?;
    V::parse(&raw).ok()
}
fn status_command() -> Command {
    let mut command = Command::new(WINDOWS_TAILSCALE);
    command.args(["status", "--json"]);
    command
}
async fn with_status_command(
    groups: Groups,
    wsl: bool,
    command: Command,
    timeout: Duration,
    cancel: &Cancel,
) -> Result<V, String> {
    check_cancel(cancel)?;
    let mut result = local_addresses(&groups);
    if wsl {
        let output = process_owned::run(command, timeout, STATUS_LIMIT, cancel).await;
        check_cancel(cancel)?;
        if let Ok(output) = output {
            if output.status.success() {
                if let Some(status) = parse_status(&String::from_utf8_lossy(&output.stdout)) {
                    add_windows_status(&mut result, &status);
                }
            }
        }
        // Missing installation, invalid status, timeouts, and command errors
        // leave the already discovered Linux interfaces available.
    }
    check_cancel(cancel)?;
    Ok(sorted(result))
}

#[cfg(target_os = "linux")]
fn interface_groups() -> Groups {
    use std::ffi::CStr;
    struct OwnedInterfaces(*mut libc::ifaddrs);
    impl Drop for OwnedInterfaces {
        fn drop(&mut self) {
            unsafe { libc::freeifaddrs(self.0) };
        }
    }
    let mut first = std::ptr::null_mut();
    if unsafe { libc::getifaddrs(&mut first) } != 0 {
        return vec![];
    }
    let _owned = OwnedInterfaces(first);
    let mut groups: Groups = vec![];
    let mut current = first;
    while !current.is_null() {
        // getifaddrs owns this acyclic list until the guard calls freeifaddrs.
        let entry = unsafe { &*current };
        current = entry.ifa_next;
        if entry.ifa_addr.is_null()
            || entry.ifa_name.is_null()
            || entry.ifa_flags & libc::IFF_UP as u32 == 0
            || entry.ifa_flags & libc::IFF_RUNNING as u32 == 0
        {
            continue;
        }
        let family = unsafe { (*entry.ifa_addr).sa_family as i32 };
        let (family_name, address) = match family {
            libc::AF_INET => {
                let address = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in) };
                (
                    "IPv4",
                    Ipv4Addr::from(address.sin_addr.s_addr.to_ne_bytes()).to_string(),
                )
            }
            libc::AF_INET6 => {
                let address = unsafe { &*(entry.ifa_addr as *const libc::sockaddr_in6) };
                (
                    "IPv6",
                    std::net::Ipv6Addr::from(address.sin6_addr.s6_addr).to_string(),
                )
            }
            _ => continue,
        };
        let name = unsafe { CStr::from_ptr(entry.ifa_name) }
            .to_string_lossy()
            .into_owned();
        let net = object([
            ("family", family_name.into()),
            ("address", address.into()),
            (
                "internal",
                (entry.ifa_flags & libc::IFF_LOOPBACK as u32 != 0).into(),
            ),
        ]);
        match groups.iter_mut().find(|(existing, _)| *existing == name) {
            Some((_, entries)) => entries.array_mut().push(net),
            None => groups.push((name, V::Array(vec![net]))),
        }
    }
    groups
}
#[cfg(target_os = "linux")]
fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some_and(|value| !value.is_empty()) {
        return true;
    }
    let mut system: libc::utsname = unsafe { std::mem::zeroed() };
    if unsafe { libc::uname(&mut system) } != 0 {
        return false;
    }
    let release = unsafe { std::ffi::CStr::from_ptr(system.release.as_ptr()) }.to_string_lossy();
    release.to_ascii_lowercase().contains("microsoft")
}

pub async fn addresses(cancel: &Cancel) -> Result<V, String> {
    check_cancel(cancel)?;
    #[cfg(target_os = "linux")]
    {
        // libc's finite kernel snapshot runs outside Tokio's executor threads.
        // Cancellation does not interrupt libc, but prevents any subsequent
        // Windows process from starting and immediately releases the caller.
        let snapshot = tokio::task::spawn_blocking(|| (interface_groups(), is_wsl()));
        let (groups, wsl) = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err("Network address discovery cancelled".into()),
            result = snapshot => result.map_err(|_| "Network interface snapshot failed")?,
        };
        with_status_command(groups, wsl, status_command(), STATUS_TIMEOUT, cancel).await
    }
    #[cfg(not(target_os = "linux"))]
    {
        Err("Native network interface collection is only implemented on Linux".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn parse(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn groups(value: &V) -> Groups {
        value
            .array()
            .iter()
            .map(|pair| (pair.array()[0].text(), pair.array()[1].clone()))
            .collect()
    }
    fn local_fixture() -> Groups {
        groups(&parse(
            r#"[["eth0",[{"family":"IPv4","internal":false,"address":"172.26.1.2"}]]]"#,
        ))
    }
    #[test]
    fn original_address_validation_order_duplicates_and_host_rules_match() {
        let fixtures = parse(include_str!(
            "../../tests/fixtures/rust-network-address.json"
        ));
        assert!(fixtures.array().len() >= 100);
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let source_groups = if input["interfaceThrows"].truthy() {
                vec![]
            } else {
                groups(&input["groups"])
            };
            let mut result = local_addresses(&source_groups);
            if input["wsl"].truthy() && !input["execThrows"].truthy() {
                if let Some(status) = parse_status(&input["output"].text()) {
                    add_windows_status(&mut result, &status);
                }
            }
            assert_eq!(
                sorted(result),
                fixture["expected"]["value"],
                "{}",
                input["name"].text()
            );
        }
    }
    #[test]
    fn production_interop_command_is_fixed_and_read_only() {
        let command = status_command();
        assert_eq!(
            command.as_std().get_program(),
            std::ffi::OsStr::new(WINDOWS_TAILSCALE)
        );
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            [
                std::ffi::OsStr::new("status"),
                std::ffi::OsStr::new("--json")
            ]
        );
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn fake(directory: &std::path::Path, body: &str) -> Command {
        let script = directory.join("fake-tailscale.py");
        std::fs::write(&script, body).unwrap();
        let mut command = Command::new("/usr/bin/python3");
        command
            .arg(script)
            .args(["status", "--json"])
            .current_dir(directory);
        command
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test]
    async fn fake_windows_status_runs_asynchronously_and_retains_lan_on_failures() {
        let directory = tempfile::tempdir().unwrap();
        let script = "import sys,json,pathlib\npathlib.Path('arguments.json').write_text(json.dumps(sys.argv[1:]))\nprint(json.dumps({'BackendState':'Running','Self':{'DNSName':'Desktop.tail123.ts.net.','TailscaleIPs':['100.89.45.85']}}))\n";
        let result = with_status_command(
            local_fixture(),
            true,
            fake(directory.path(), script),
            STATUS_TIMEOUT,
            &Cancel::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            result,
            parse(
                r#"[{"ip":"100.89.45.85","host":"desktop.tail123.ts.net","type":"tailscale"},{"ip":"172.26.1.2","type":"lan"}]"#
            )
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("arguments.json")).unwrap(),
            r#"["status", "--json"]"#
        );
        for script in [
            "print('not JSON')\n",
            "import sys\nprint('{\"BackendState\":\"Running\"}')\nsys.exit(2)\n",
            "print('x' * (1024 * 1024 + 1))\n",
        ] {
            let result = with_status_command(
                local_fixture(),
                true,
                fake(directory.path(), script),
                STATUS_TIMEOUT,
                &Cancel::default(),
            )
            .await
            .unwrap();
            assert_eq!(result, sorted(local_addresses(&local_fixture())));
        }
        let result = with_status_command(
            local_fixture(),
            true,
            Command::new(directory.path().join("missing")),
            STATUS_TIMEOUT,
            &Cancel::default(),
        )
        .await
        .unwrap();
        assert_eq!(result, sorted(local_addresses(&local_fixture())));
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test]
    async fn non_wsl_and_precancel_never_start_the_injected_process() {
        let directory = tempfile::tempdir().unwrap();
        let script = "import pathlib\npathlib.Path('started').write_text('unsafe')\n";
        let cancel = Cancel::default();
        let result = with_status_command(
            local_fixture(),
            false,
            fake(directory.path(), script),
            STATUS_TIMEOUT,
            &cancel,
        )
        .await
        .unwrap();
        assert_eq!(result, sorted(local_addresses(&local_fixture())));
        assert!(!directory.path().join("started").exists());
        cancel.cancel();
        assert_eq!(
            with_status_command(
                local_fixture(),
                true,
                fake(directory.path(), script),
                STATUS_TIMEOUT,
                &cancel
            )
            .await,
            Err("Network address discovery cancelled".into())
        );
        assert!(!directory.path().join("started").exists());
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    fn observe_fake_spawn(command: &mut Command, directory: &std::path::Path) {
        use std::os::fd::AsRawFd;
        let record = std::fs::File::create(directory.join("owned-spawn")).unwrap();
        // Command sets process_group(0) and the pipe FDs before pre_exec.
        // Record kernel identity before Python runs, using only fixed buffers
        // and async-signal-safe syscalls in the child. This observes, not owns,
        // the child: the real runner still performs all cleanup and reaping.
        unsafe {
            command.pre_exec(move || {
                let mut buffer = [0u8; 4096];
                let fd = libc::open(
                    c"/proc/self/stat".as_ptr(),
                    libc::O_RDONLY | libc::O_CLOEXEC,
                );
                if fd < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                let count = libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len());
                libc::close(fd);
                if count <= 0
                    || libc::write(record.as_raw_fd(), buffer.as_ptr().cast(), count as usize)
                        != count
                {
                    return Err(std::io::Error::from_raw_os_error(libc::EIO));
                }
                for path in [c"/proc/self/fd/1", c"/proc/self/fd/2"] {
                    let count =
                        libc::readlink(path.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len() - 1);
                    if count <= 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    buffer[count as usize] = b'\n';
                    if libc::write(
                        record.as_raw_fd(),
                        buffer.as_ptr().cast(),
                        count as usize + 1,
                    ) != count + 1
                    {
                        return Err(std::io::Error::from_raw_os_error(libc::EIO));
                    }
                }
                Ok(())
            });
        }
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[tokio::test]
    async fn timeout_or_cancel_owns_the_fake_process_and_preserves_event_loop_progress() {
        for stop in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            // Controlled delayed publication: the child cannot publish its PID
            // until the test releases this barrier, even if Python starts fast.
            let script = "import os,pathlib,time\nwhile not pathlib.Path('publish-pid').exists(): time.sleep(0.001)\npathlib.Path('pid').write_text(str(os.getpid()))\ntime.sleep(0.4)\npathlib.Path('late').write_text('must not run')\n";
            let cancel = Cancel::default();
            let mut command = fake(directory.path(), script);
            observe_fake_spawn(&mut command, directory.path());
            let timeout = if stop {
                STATUS_TIMEOUT
            } else {
                Duration::from_millis(80)
            };
            let progressed = std::cell::Cell::new(false);
            let run = async {
                let result =
                    with_status_command(local_fixture(), true, command, timeout, &cancel).await;
                assert!(
                    progressed.get(),
                    "event loop must advance while the owned command is pending"
                );
                result
            };
            let advance = async {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(1);
                let record = loop {
                    let record =
                        std::fs::read_to_string(directory.path().join("owned-spawn")).unwrap();
                    if record.lines().count() == 3 {
                        break record;
                    }
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "spawn observation must be complete"
                    );
                    tokio::time::sleep(Duration::from_millis(1)).await;
                };
                tokio::task::yield_now().await;
                progressed.set(true);
                if stop {
                    cancel.cancel();
                }
                record
            };
            let (result, record) =
                tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(run, advance) })
                    .await
                    .unwrap();
            if stop {
                assert_eq!(result, Err("Network address discovery cancelled".into()));
            } else {
                assert_eq!(result.unwrap(), sorted(local_addresses(&local_fixture())));
            }
            let lines: Vec<_> = record.lines().collect();
            let pid: u32 = lines[0].split_whitespace().next().unwrap().parse().unwrap();
            let fields: Vec<_> = lines[0]
                .rsplit_once(") ")
                .unwrap()
                .1
                .split_whitespace()
                .collect();
            let start = fields[19];
            assert_eq!(
                fields[2].parse::<u32>().unwrap(),
                pid,
                "fake must lead its owned group"
            );
            assert_ne!(pid, unsafe { libc::getpgrp() } as u32);
            assert_ne!(
                lines[1], lines[2],
                "stdout and stderr must be distinct pipes"
            );
            assert!(lines[1..].iter().all(|pipe| pipe.starts_with("pipe:[")));
            let current = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            if let Ok(current) = current {
                assert_ne!(
                    current
                        .rsplit_once(") ")
                        .unwrap()
                        .1
                        .split_whitespace()
                        .nth(19)
                        .unwrap(),
                    start,
                    "the exact owned PID/start identity must be reaped, not merely unpublished"
                );
            }
            for entry in std::fs::read_dir("/proc").unwrap().flatten() {
                if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
                    continue;
                }
                if let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) {
                    let fields: Vec<_> = stat
                        .rsplit_once(") ")
                        .unwrap()
                        .1
                        .split_whitespace()
                        .collect();
                    assert!(
                        fields[2] != pid.to_string() || matches!(fields[0], "Z" | "X"),
                        "owned process group must not retain an executing member: {stat}"
                    );
                }
            }
            for entry in std::fs::read_dir("/proc/self/fd").unwrap().flatten() {
                if let Ok(target) = std::fs::read_link(entry.path()) {
                    assert!(
                        !lines[1..]
                            .iter()
                            .any(|pipe| target == std::path::Path::new(pipe)),
                        "owned stdout/stderr read handles must be released: {target:?}"
                    );
                }
            }
            std::fs::write(
                directory.path().join("publish-pid"),
                "released after cleanup",
            )
            .unwrap();
            assert!(
                !directory.path().join("pid").exists(),
                "delayed publication is not cleanup evidence"
            );
            assert!(!directory.path().join("late").exists());
            eprintln!("owned fake cleanup stop={stop} pid={pid} start={start} group={pid} pipes={:?} event_loop_progress={}", &lines[1..], progressed.get());
        }
    }
}
