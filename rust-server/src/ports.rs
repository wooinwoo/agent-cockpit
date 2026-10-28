use crate::{
    board_value::{object, V},
    commands, dev_servers,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{collections::HashMap, time::Duration};
use tokio::process::Command;

pub const ROUTES: &[(&str, &str)] = &[("GET", "/api/ports"), ("POST", "/api/ports/kill")];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, endpoint)| method.as_str() == *verb && path == *endpoint)
}

// These inputs use JavaScript parseInt(value, 10), never its hexadecimal mode.
fn decimal(text: &str) -> Option<i64> {
    let text = text.trim_start();
    let (negative, rest) = if let Some(rest) = text.strip_prefix('-') {
        (true, rest)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let value = digits.parse::<i64>().ok()?;
    Some(if negative { -value } else { value })
}
fn insert(entries: &mut Vec<V>, endpoint: &str, pid: Option<i64>) {
    let Some((address, port)) = endpoint.rsplit_once(':') else {
        return;
    };
    let Some(port) = decimal(port) else { return };
    let pid = pid.map(|n| V::Number(n as f64)).unwrap_or(V::Null);
    if entries
        .iter()
        .any(|entry| entry["port"] == V::Number(port as f64) && entry["pid"] == pid)
    {
        return;
    }
    entries.push(object([
        ("port", V::Number(port as f64)),
        ("pid", pid),
        ("protocol", "TCP".into()),
        ("address", address.into()),
        ("processName", "Unknown".into()),
        ("projectId", V::Null),
        ("projectName", V::Null),
        ("isDevServer", false.into()),
    ]));
}
fn lsof(text: &str) -> Vec<V> {
    let mut entries = vec![];
    let mut pid = Some(0);
    for line in text.lines() {
        if let Some(value) = line.strip_prefix('p') {
            pid = decimal(value);
        } else if let Some(value) = line.strip_prefix('n') {
            insert(&mut entries, value, pid);
        }
    }
    entries
}
fn ss(text: &str) -> Vec<V> {
    let mut entries = vec![];
    for line in text.lines().skip(1) {
        let parts: Vec<_> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let pid = parts
            .get(5)
            .and_then(|value| value.split_once("pid="))
            .and_then(|(_, value)| decimal(value))
            .unwrap_or(0);
        insert(&mut entries, parts[3], Some(pid));
    }
    entries
}
async fn output(program: &str, args: &[&str], seconds: u64) -> std::io::Result<String> {
    let mut command = Command::new(program);
    command.args(args);
    commands::output(command, Duration::from_secs(seconds)).await
}
fn annotate(entries: &mut [V], names: &HashMap<String, String>, dev: &V) {
    for entry in entries.iter_mut() {
        entry["processName"] = names
            .get(&entry["pid"].text())
            .map(|s| s.as_str())
            .unwrap_or("Unknown")
            .into();
        if let Some(server) = dev
            .array()
            .iter()
            .rev()
            .find(|server| server["port"].truthy() && server["port"] == entry["port"])
        {
            entry["projectId"] = server["projectId"].clone();
            entry["projectName"] = if server["projectName"].truthy() {
                server["projectName"].clone()
            } else {
                server["projectId"].clone()
            };
            entry["isDevServer"] = true.into();
        }
    }
    entries.sort_by(|a, b| a["port"].number().total_cmp(&b["port"].number()));
}
async fn listening(dev: &V) -> V {
    let mut entries = match output("lsof", &["-iTCP", "-sTCP:LISTEN", "-nP", "-F", "pcn"], 8).await
    {
        Ok(text) => lsof(&text),
        Err(_) => output("ss", &["-tlnp"], 8)
            .await
            .map(|text| ss(&text))
            .unwrap_or_default(),
    };
    let mut pids: Vec<_> = entries.iter().map(|entry| entry["pid"].text()).collect();
    pids.sort();
    pids.dedup();
    let mut names = HashMap::new();
    for chunk in pids.chunks(8) {
        let mut tasks = tokio::task::JoinSet::new();
        for pid in chunk {
            let pid = pid.clone();
            tasks.spawn(async move {
                let name = output("ps", &["-p", &pid, "-o", "comm="], 3).await.ok()?;
                let name = name.trim().to_owned();
                (!name.is_empty()).then_some((pid, name))
            });
        }
        while let Some(result) = tasks.join_next().await {
            if let Ok(Some((pid, name))) = result {
                names.insert(pid, name);
            }
        }
    }
    annotate(&mut entries, &names, dev);
    V::Array(entries)
}
fn kill(input: &V) -> Response {
    let Some(pid) = decimal(&input["pid"].text()).filter(|pid| *pid > 0 && *pid <= i32::MAX as i64)
    else {
        return crate::error(400, "Invalid PID");
    };
    if matches!(pid, 1 | 4) || pid == std::process::id() as i64 {
        return crate::error(400, "Cannot kill protected process");
    }
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
            let error = std::io::Error::last_os_error();
            let message = match error.raw_os_error() {
                Some(libc::ESRCH) => "kill ESRCH".into(),
                Some(libc::EPERM) => "kill EPERM".into(),
                _ => error.to_string(),
            };
            return crate::error(400, &format!("Failed to kill PID {pid}: {message}"));
        }
        Json(object([("killed", true.into())]).raw()).into_response()
    }
    #[cfg(not(unix))]
    crate::error(501, "Ports are not implemented on this platform")
}
pub async fn handle(method: &Method, path: &str, input: &V, dev: &dev_servers::Store) -> Response {
    if method == Method::POST && path == "/api/ports/kill" {
        return kill(input);
    }
    if method == Method::GET && path == "/api/ports" {
        #[cfg(unix)]
        return Json(listening(&dev.snapshot()).await.raw()).into_response();
        #[cfg(not(unix))]
        return crate::error(501, "Ports are not implemented on this platform");
    }
    crate::error(404, "Not found")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parsing_duplicates_ipv6_names_and_dev_fallback() {
        let mut entries =
            lsof("p321\ncnode\nn[::1]:5173\nn*:5173\np322\nn*:80\np323\nn*:5173\nninvalid\n");
        assert_eq!(entries.len(), 3);
        let dev = V::Array(vec![object([
            ("projectId", "demo".into()),
            ("port", 5173.0.into()),
        ])]);
        annotate(
            &mut entries,
            &HashMap::from([("321".into(), "node".into())]),
            &dev,
        );
        assert_eq!(entries[0]["port"], V::Number(80.0));
        assert_eq!(entries[1]["address"], V::from("[::1]"));
        assert_eq!(entries[1]["projectName"], V::from("demo"));
        assert_eq!(entries[1]["processName"], V::from("node"));
        assert_eq!(entries[2]["processName"], V::from("Unknown"));
        let rows = ss("State Recv-Q Send-Q Local Peer Process\nLISTEN 0 10 [::]:80 *:* users:((\"node\",pid=322,fd=1))\nLISTEN 0 10 0.0.0.0:90 *:*\n");
        assert_eq!(rows[0]["pid"], V::Number(322.0));
        assert_eq!(rows[1]["pid"], V::Number(0.0));
        assert_eq!(decimal("+12tail"), Some(12));
        assert_eq!(decimal("0x10"), Some(0));
        assert_eq!(decimal("bad"), None);
    }
    #[test]
    fn protected_and_wrapping_pids_are_rejected_without_signalling() {
        for pid in ["0", "-1", "1", "4", "2147483648", "4294967295", "bad"] {
            assert_eq!(kill(&object([("pid", pid.into())])).status(), 400);
        }
        assert_eq!(
            kill(&object([("pid", (std::process::id() as f64).into())])).status(),
            400
        );
    }
}
