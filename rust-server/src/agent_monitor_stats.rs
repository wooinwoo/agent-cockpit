//! Linux system statistics for the native COCKPIT system tool.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    process_owned,
};
use std::{
    io::Read,
    sync::OnceLock,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::process::Command;

const COMMAND_LIMIT: usize = 1024 * 1024;
const PROC_LIMIT: usize = 4 * 1024 * 1024;
const CANCELLED: &str = "System statistics collection cancelled";

fn cancelled(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err(CANCELLED.into())
    } else {
        Ok(())
    }
}

fn read_proc(path: &str) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|error| format!("Cannot read {path}: {error}"))?;
    let mut bytes = Vec::new();
    file.take((PROC_LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read {path}: {error}"))?;
    if bytes.len() > PROC_LIMIT {
        return Err(format!("System statistics input too large: {path}"));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, Clone, Copy)]
struct CpuSnapshot {
    idle: f64,
    total: f64,
    cores: usize,
}

fn cpu_snapshot(text: &str) -> Result<CpuSnapshot, String> {
    let mut snapshot = CpuSnapshot {
        idle: 0.0,
        total: 0.0,
        cores: 0,
    };
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else {
            continue;
        };
        let Some(index) = name.strip_prefix("cpu") else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|byte| byte.is_ascii_digit()) {
            continue;
        }
        let times = fields
            .take(6)
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Malformed CPU counters in /proc/stat")?;
        if times.len() < 6 {
            return Err("Missing CPU counters in /proc/stat".into());
        }
        // Node os.cpus().times exposes user, nice, sys, idle and irq. It does not
        // include /proc/stat's iowait, softirq, steal or guest counters.
        snapshot.idle += times[3] as f64;
        for index in [0, 1, 2, 3, 5] {
            snapshot.total += times[index] as f64;
        }
        snapshot.cores += 1;
    }
    if snapshot.cores == 0 {
        return Err("No CPU counters found in /proc/stat".into());
    }
    Ok(snapshot)
}

fn round(value: f64) -> f64 {
    let rounded = (value + 0.5).floor();
    if rounded == 0.0 && value < 0.0 {
        -0.0
    } else {
        rounded
    }
}

fn cpu_usage(first: CpuSnapshot, second: CpuSnapshot) -> f64 {
    let total = second.total - first.total;
    if total == 0.0 {
        0.0
    } else {
        round((1.0 - (second.idle - first.idle) / total) * 100.0)
    }
}

async fn sample_cpu(cancel: &Cancel) -> Result<(f64, usize), String> {
    cancelled(cancel)?;
    let first = cpu_snapshot(&read_proc("/proc/stat")?)?;
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(CANCELLED.into()),
        _ = tokio::time::sleep(Duration::from_millis(300)) => {}
    }
    cancelled(cancel)?;
    let second = cpu_snapshot(&read_proc("/proc/stat")?)?;
    Ok((cpu_usage(first, second), second.cores))
}

fn memory_info(text: &str) -> Result<V, String> {
    let bytes = |name: &str| -> Option<f64> {
        text.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            if key != name {
                return None;
            }
            let kib = value.split_whitespace().next()?.parse::<u64>().ok()?;
            Some(kib as f64 * 1024.0)
        })
    };
    let total = bytes("MemTotal")
        .filter(|value| *value > 0.0)
        .ok_or("Missing MemTotal in /proc/meminfo")?;
    // The current Node/libuv runtime reports MemAvailable as freemem(). Keep its
    // meaning, with the kernel's MemFree value for systems lacking that field.
    let free = bytes("MemAvailable")
        .filter(|value| *value > 0.0)
        .or_else(|| bytes("MemFree"))
        .ok_or("Missing free memory in /proc/meminfo")?;
    let used = total - free;
    Ok(object([
        ("total", total.into()),
        ("free", free.into()),
        ("used", used.into()),
        ("percent", round(used / total * 100.0).into()),
    ]))
}

fn parse_int(text: &str) -> f64 {
    let text = text.trim_start();
    let (negative, text) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let (radix, text) =
        if let Some(rest) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
            (16, rest)
        } else {
            (10, text)
        };
    let digits: String = text
        .chars()
        .take_while(|character| character.is_digit(radix))
        .collect();
    if digits.is_empty() {
        return f64::NAN;
    }
    let value = if radix == 10 {
        digits.parse::<f64>().unwrap_or(f64::INFINITY)
    } else {
        digits.chars().fold(0.0, |value, digit| {
            value * 16.0 + digit.to_digit(16).unwrap() as f64
        })
    };
    if negative {
        -value
    } else {
        value
    }
}

fn parse_float(text: &str) -> f64 {
    static PREFIX: OnceLock<regex::Regex> = OnceLock::new();
    let regex = PREFIX.get_or_init(|| {
        regex::Regex::new(
            r"^[+-]?(?:Infinity|(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)(?:[eE][+-]?[0-9]+)?)",
        )
        .unwrap()
    });
    let text = text.trim_start();
    regex
        .find(text)
        .map(|matched| matched.as_str().parse::<f64>().unwrap_or(f64::NAN))
        .unwrap_or(f64::NAN)
}

fn or_zero(value: f64) -> f64 {
    // JavaScript `value || 0` preserves infinities but replaces NaN and -0.
    if value.is_nan() || value == 0.0 {
        0.0
    } else {
        value
    }
}

fn disk_info(text: &str) -> V {
    let mut disks = Vec::new();
    for line in text.trim().split('\n').skip(1) {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }
        let filesystem = parts[0];
        let mountpoint = parts[5];
        if filesystem == "tmpfs" || filesystem == "devtmpfs" || filesystem.starts_with("map ") {
            continue;
        }
        if !filesystem.starts_with('/') && !filesystem.contains(':') {
            continue;
        }
        let total = parse_int(parts[1]) * 1024.0;
        if total.is_nan() || total == 0.0 {
            continue;
        }
        let used = parse_int(parts[2]) * 1024.0;
        let free = parse_int(parts[3]) * 1024.0;
        disks.push(object([
            ("drive", mountpoint.into()),
            ("total", total.into()),
            ("free", free.into()),
            ("used", used.into()),
            ("percent", round(used / total * 100.0).into()),
        ]));
    }
    V::Array(disks)
}

fn top_processes(text: &str, limit: usize) -> V {
    let mut processes = Vec::new();
    for line in text.trim().split('\n').skip(1) {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 4 {
            continue;
        }
        let cpu = or_zero(parse_float(parts[parts.len() - 2]));
        let rss_kib = or_zero(parse_int(parts[parts.len() - 1]));
        processes.push(object([
            ("Id", parse_int(parts[0]).into()),
            ("ProcessName", parts[1..parts.len() - 2].join(" ").into()),
            ("Cpu", (round(cpu * 10.0) / 10.0).into()),
            ("MemMB", (round(rss_kib / 1024.0 * 10.0) / 10.0).into()),
        ]));
    }
    // Stable ties preserve the command's ordering, matching Array.prototype.sort.
    processes.sort_by(|a, b| {
        b["MemMB"]
            .number()
            .partial_cmp(&a["MemMB"].number())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    processes.truncate(limit);
    V::Array(processes)
}

fn cpu_model(text: &str) -> &str {
    text.lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == "model name")
                .then(|| value.trim())
                .filter(|value| !value.is_empty())
        })
        .unwrap_or("Unknown")
}

/// This implementation is validated on Linux x86_64, where the shared command
/// runner owns and cancels every df/ps child. It never calls Node or a shell.
pub async fn collect(cancel: &Cancel) -> Result<V, String> {
    cancelled(cancel)?;
    #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
    {
        return Err("Native system statistics are only validated on Linux x86_64".into());
    }
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        let mut df = Command::new("/usr/bin/df");
        df.arg("-k").env("LC_ALL", "C");
        let mut ps = Command::new("/usr/bin/ps");
        ps.args(["-eo", "pid,comm,%cpu,rss"]).env("LC_ALL", "C");
        let (cpu, disk, processes) = tokio::join!(
            sample_cpu(cancel),
            process_owned::run(df, Duration::from_secs(5), COMMAND_LIMIT, cancel),
            process_owned::run(ps, Duration::from_secs(5), COMMAND_LIMIT, cancel),
        );
        cancelled(cancel)?;
        let (cpu, cores) = cpu?;
        // The original service treats df/ps failures as an empty list. Explicit
        // caller cancellation remains an error and is never reported as success.
        let disk = disk
            .ok()
            .filter(|output| output.status.success())
            .map(|output| disk_info(&String::from_utf8_lossy(&output.stdout)))
            .unwrap_or_else(|| V::Array(Vec::new()));
        let processes = processes
            .ok()
            .filter(|output| output.status.success())
            .map(|output| top_processes(&String::from_utf8_lossy(&output.stdout), 15))
            .unwrap_or_else(|| V::Array(Vec::new()));
        let memory = memory_info(&read_proc("/proc/meminfo")?)?;
        let hostname = read_proc("/proc/sys/kernel/hostname")?;
        let cpuinfo = read_proc("/proc/cpuinfo")?;
        let uptime = read_proc("/proc/uptime")?;
        let uptime = uptime
            .split_whitespace()
            .next()
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite() && *value >= 0.0)
            .ok_or("Invalid /proc/uptime")?;
        cancelled(cancel)?;
        let system = object([
            (
                "hostname",
                hostname.strip_suffix('\n').unwrap_or(&hostname).into(),
            ),
            ("platform", "linux".into()),
            ("arch", "x64".into()),
            ("cpuModel", cpu_model(&cpuinfo).into()),
            ("cpuCores", (cores as f64).into()),
            ("totalMemory", memory["total"].clone()),
            ("uptime", uptime.into()),
            ("nodeVersion", V::Null),
            ("runtime", "rust".into()),
        ]);
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| error.to_string())?
            .as_millis() as f64;
        Ok(object([
            ("cpu", cpu.into()),
            ("memory", memory),
            ("disk", disk),
            ("processes", processes),
            ("system", system),
            ("timestamp", now.into()),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_counts_match_nodes_five_time_fields() {
        let first = cpu_snapshot("cpu 999 999 999 999 999 999\ncpu0 10 1 20 100 9000 2 8000 7000 6000 5000\ncpu1 20 2 30 200 9000 3 8000\nintr 2\n").unwrap();
        assert_eq!(first.cores, 2);
        assert_eq!(first.idle, 300.0);
        assert_eq!(first.total, 388.0);
        let second = CpuSnapshot {
            idle: 370.0,
            total: 488.0,
            cores: 2,
        };
        assert_eq!(cpu_usage(first, second), 30.0);
        assert_eq!(cpu_usage(first, first), 0.0);
        assert!(cpu_snapshot("cpu 1 2 3 4 5 6\n").is_err());
        assert!(cpu_snapshot("cpu0 1 2 invalid 4 5 6\n").is_err());
    }

    #[test]
    fn memory_matches_current_node_available_memory_semantics() {
        let memory = memory_info(
            "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 700 kB\nCached: 500 kB\n",
        )
        .unwrap();
        assert_eq!(memory["total"], V::Number(1_024_000.0));
        assert_eq!(memory["free"], V::Number(716_800.0));
        assert_eq!(memory["used"], V::Number(307_200.0));
        assert_eq!(memory["percent"], V::Number(30.0));
        assert_eq!(
            memory_info("MemTotal: 1000 kB\nMemFree: 100 kB\n").unwrap()["percent"],
            V::Number(90.0)
        );
        assert!(memory_info("MemTotal: 0 kB\nMemFree: 0 kB\n").is_err());
    }

    #[test]
    fn df_parser_preserves_real_mount_filter_and_original_mountpoint_fields() {
        let disks = disk_info("Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/sda 1000 250 700 25% /\ntmpfs 99 1 98 1% /run\ndevtmpfs 99 1 98 1% /dev\noverlay 99 1 98 1% /overlay\nhost:/share 2000 500 1400 25% /mnt/share\n/dev/space 100 50 40 50% /mnt/with space\n/dev/empty 0 0 0 0% /empty\nmalformed line\n");
        assert_eq!(disks.array().len(), 3);
        assert_eq!(
            disks.array()[0],
            object([
                ("drive", "/".into()),
                ("total", 1_024_000.0.into()),
                ("used", 256_000.0.into()),
                ("free", 716_800.0.into()),
                ("percent", 25.0.into())
            ])
        );
        assert_eq!(disks.array()[1]["drive"], V::from("/mnt/share"));
        assert_eq!(disks.array()[2]["drive"], V::from("/mnt/with"));
    }

    #[test]
    fn process_parser_keeps_names_rounding_and_stable_memory_ties() {
        let processes = top_processes("PID COMMAND %CPU RSS\n1 first process 1.25 1000\n2 second -1.25 1024\n3 biggest 20 2048\n4 bad invalid invalid\n5 prefix 2.1suffix 512KiB\nshort\n", 5);
        assert_eq!(
            processes
                .array()
                .iter()
                .map(|row| row["Id"].number())
                .collect::<Vec<_>>(),
            [3.0, 1.0, 2.0, 5.0, 4.0]
        );
        assert_eq!(
            processes.array()[1]["ProcessName"],
            V::from("first process")
        );
        assert_eq!(processes.array()[1]["Cpu"], V::Number(1.3));
        assert_eq!(processes.array()[2]["Cpu"], V::Number(-1.2));
        assert_eq!(processes.array()[3]["MemMB"], V::Number(0.5));
        assert_eq!(processes.array()[4]["Cpu"], V::Number(0.0));
        assert_eq!(
            top_processes("PID COMMAND %CPU RSS\n1 p 1 1\n2 q 2 2", 1)
                .array()
                .len(),
            1
        );
    }

    #[test]
    fn numeric_prefixes_and_cpu_model_follow_source_fields() {
        assert_eq!(parse_int("-0x10tail"), -16.0);
        assert_eq!(parse_int("12MiB"), 12.0);
        assert!(parse_int("unknown").is_nan());
        assert_eq!(parse_float("1e+bad"), 1.0);
        assert_eq!(parse_float("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(
            cpu_model("processor : 0\nmodel name : Example CPU 9000\nmodel name : Other CPU\n"),
            "Example CPU 9000"
        );
        assert_eq!(cpu_model("processor: 0\n"), "Unknown");
    }

    #[tokio::test]
    async fn cancellation_before_collect_does_not_reach_sampling_or_spawn() {
        let cancel = Cancel::default();
        cancel.cancel();
        let result = tokio::time::timeout(Duration::from_millis(100), collect(&cancel))
            .await
            .unwrap();
        assert_eq!(result.unwrap_err(), CANCELLED);
    }
}
