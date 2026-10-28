use std::{
    io::{self, Read, Write},
    net::{Ipv4Addr, SocketAddr, TcpStream},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

// This service owns the sessions. Closing the Windows window must not stop it.
const DISCOVER: &str = r#"set -eu
/usr/bin/systemctl --user start cockpit-prod.service
printf 'COCKPIT_HOST='
/usr/bin/hostname -I
printf 'COCKPIT_TOKEN='
/usr/bin/cat "$HOME/.local/share/cockpit/.cockpit-token"
printf '\n'
"#;

pub fn status_page(message: &str) -> tauri::Url {
    let message = message
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    let html = format!("<!doctype html><html lang=\"ko\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Cockpit</title><body style=\"background:#090d10;color:#d8e0e5;font:16px system-ui;display:grid;place-items:center;min-height:90vh;margin:0;padding:24px\"><main style=\"max-width:640px;line-height:1.7\"><h1>Cockpit</h1><p>{message}</p></main></body></html>");
    let encoded: String = html.bytes().map(|byte| format!("%{byte:02X}")).collect();
    tauri::Url::parse(&format!("data:text/html;charset=utf-8,{encoded}")).unwrap()
}

fn output(command: &mut Command, timeout: Duration) -> io::Result<Vec<u8>> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let stdout = child.stdout.take().unwrap();
    let (sender, receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout.take(4097).read_to_end(&mut bytes).map(|_| bytes);
        let _ = sender.send(result);
    });
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(status) = child.try_wait()? {
            if !status.success() {
                return Err(io::Error::other(
                    "WSL Cockpit service could not start. Check cockpit-prod.service in Ubuntu.",
                ));
            }
            let bytes = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| {
                    io::Error::new(io::ErrorKind::TimedOut, "WSL discovery timed out")
                })??;
            if bytes.len() > 4096 {
                return Err(io::Error::other("WSL discovery response is too large"));
            }
            return Ok(bytes);
        }
        if Instant::now() >= deadline {
            // Only reap our temporary wsl.exe client, never the shared service.
            child.kill()?;
            child.wait()?;
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "WSL startup timed out",
            ));
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn parse(bytes: &[u8]) -> io::Result<(Vec<Ipv4Addr>, String)> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| io::Error::other("Invalid WSL discovery response"))?;
    let hosts: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("COCKPIT_HOST="))
        .collect();
    let tokens: Vec<_> = text
        .lines()
        .filter_map(|line| line.strip_prefix("COCKPIT_TOKEN="))
        .collect();
    if hosts.len() != 1 || tokens.len() != 1 {
        return Err(io::Error::other(
            "Missing or ambiguous WSL Cockpit configuration",
        ));
    }
    let addresses: Vec<Ipv4Addr> = hosts[0]
        .split_whitespace()
        .filter_map(|host| host.parse::<Ipv4Addr>().ok())
        .filter(|host| host.is_private() || host.is_loopback())
        .take(8)
        .collect();
    let token = tokens[0].trim();
    if addresses.is_empty()
        || !(16..=256).contains(&token.len())
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return Err(io::Error::other("Invalid WSL Cockpit address or token"));
    }
    Ok((addresses, token.to_owned()))
}

fn verify(address: SocketAddr, token: &str, deadline: Instant) -> io::Result<()> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    write!(stream, "GET /api/migration/status HTTP/1.1\r\nHost: {address}\r\nCookie: cockpit-token={token}\r\nConnection: close\r\n\r\n")?;
    let mut bytes = Vec::new();
    while bytes.len() < 64 * 1024 {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "WSL response timed out",
            ));
        }
        stream.set_read_timeout(Some(remaining.min(Duration::from_secs(1))))?;
        let mut part = [0; 4096];
        let count = stream.read(&mut part)?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&part[..count]);
    }
    let valid = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .filter(|_| bytes.starts_with(b"HTTP/1.1 200 "))
        .and_then(|end| serde_json::from_slice::<serde_json::Value>(&bytes[end + 4..]).ok())
        .is_some_and(|value| value["runtime"] == "rust");
    if !valid {
        return Err(io::Error::other(
            "WSL endpoint did not identify an authenticated Rust Cockpit server",
        ));
    }
    Ok(())
}

// Try localhost first: WSL forwards it and it survives the WSL IP changing on restart.
// The WSL IPs stay as a fallback for when localhost forwarding is off or broken.
fn candidates(hosts: Vec<Ipv4Addr>) -> Vec<Ipv4Addr> {
    let mut all = vec![Ipv4Addr::LOCALHOST];
    all.extend(hosts.into_iter().filter(|host| !host.is_loopback()));
    all
}

/// Unauthenticated liveness check of the page the window is showing.
pub fn is_up(url: &tauri::Url) -> bool {
    let Some(address) = url.socket_addrs(|| None).ok().and_then(|all| all.into_iter().next()) else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(1)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    if write!(stream, "GET /api/health HTTP/1.1\r\nHost: {address}\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0; 12];
    stream.read_exact(&mut head).is_ok() && &head == b"HTTP/1.1 200"
}

pub fn connect() -> io::Result<tauri::Url> {
    let distro = std::env::var("COCKPIT_WSL_DISTRO").unwrap_or_else(|_| "Ubuntu".into());
    let mut command = Command::new("wsl.exe");
    command.args(["--distribution", &distro, "--", "/bin/sh", "-c", DISCOVER]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    // WSL 세션 생성은 호스트 메모리가 빡빡하면 간헐적으로 HCS 핸드셰이크
    // 타임아웃(30초)에 걸려 wsl.exe 가 실패한다. 2026-10-21 실측: 성공 시
    // 0.4~1.4초, 실패 시 정확히 30.3초, 실패율 10~20%. 기존에는 30초 한 번만
    // 시도했기 때문에 그 한 번이 걸리면 곧바로 "WSL startup timed out" 배너가
    // 떴다 — 클라이언트 쪽 여유가 0 이었다.
    //
    // 10초씩 3회로 쪼갠다. 성공 경로는 1.4초 미만이라 10초로도 충분하고,
    // 최악의 전체 지연은 30초로 종전과 같은데 성공 기회는 3배가 된다.
    let mut discovered = None;
    let mut last_error = None;
    for _ in 0..3 {
        match output(&mut command, Duration::from_secs(10)) {
            Ok(bytes) => {
                discovered = Some(bytes);
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }
    let bytes = match discovered {
        Some(bytes) => bytes,
        None => {
            return Err(last_error
                .unwrap_or_else(|| io::Error::other("WSL discovery produced no result")))
        }
    };
    let (hosts, token) = parse(&bytes)?;
    let hosts = candidates(hosts);
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        for host in &hosts {
            let address = SocketAddr::from((*host, 3847));
            let attempt_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
            if verify(address, &token, attempt_deadline).is_ok() {
                let mut url = tauri::Url::parse(&format!("http://{address}/")).unwrap();
                url.query_pairs_mut().append_pair("token", &token);
                return Ok(url);
            }
            if Instant::now() >= deadline {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "WSL Rust Cockpit did not become reachable within 15 seconds",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn discovery_accepts_multiple_local_addresses_without_leaking_credentials_in_errors() {
        let (hosts, token) = parse(b"notice\r\nCOCKPIT_HOST=172.20.1.2 10.0.0.2 fe80::1\r\nCOCKPIT_TOKEN=0123456789abcdef\r\n").unwrap();
        assert_eq!(hosts.len(), 2);
        assert_eq!(token, "0123456789abcdef");
        for invalid in [
            "COCKPIT_HOST=example.com",
            "COCKPIT_HOST=8.8.8.8",
            "COCKPIT_HOST=999.1.1.1",
            "COCKPIT_HOST=10.1.1.1\nCOCKPIT_HOST=10.2.2.2",
        ] {
            let error = parse(format!("{invalid}\nCOCKPIT_TOKEN=secret-token-1234\n").as_bytes())
                .unwrap_err();
            assert!(!error.to_string().contains("secret-token"));
        }
        assert!(
            parse(b"COCKPIT_HOST=10.1.1.1\nCOCKPIT_TOKEN=0123456789abcdef;injected\n").is_err()
        );
    }

    #[test]
    fn endpoint_requires_rust_and_uses_cookie_auth_without_token_in_the_request_url() {
        for (body, accepted) in [
            (r#"{"runtime":"rust"}"#, true),
            (r#"{"runtime":"node"}"#, false),
            ("<html>Login</html>", false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut bytes = Vec::new();
                while !bytes.windows(4).any(|value| value == b"\r\n\r\n") {
                    let mut part = [0; 1024];
                    let count = stream.read(&mut part).unwrap();
                    assert!(count > 0 && bytes.len() < 4096);
                    bytes.extend_from_slice(&part[..count]);
                }
                let request = String::from_utf8(bytes).unwrap();
                assert!(request.starts_with("GET /api/migration/status HTTP/1.1\r\n"));
                assert!(request.contains("Cookie: cockpit-token=0123456789abcdef\r\n"));
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            assert_eq!(
                verify(
                    address,
                    "0123456789abcdef",
                    Instant::now() + Duration::from_secs(2)
                )
                .is_ok(),
                accepted
            );
            server.join().unwrap();
        }
    }

    #[test]
    fn trickling_response_cannot_extend_the_absolute_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            for _ in 0..20 {
                if stream.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        });
        let start = Instant::now();
        let error = verify(
            address,
            "0123456789abcdef",
            start + Duration::from_millis(120),
        )
        .unwrap_err();
        assert!(matches!(
            error.kind(),
            io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
        ));
        assert!(start.elapsed() < Duration::from_millis(500));
        server.join().unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn discovery_timeout_reaps_only_its_owned_client() {
        let start = Instant::now();
        let error = output(
            Command::new("/bin/sleep").arg("30"),
            Duration::from_millis(50),
        )
        .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_eq!(
            output(
                Command::new("/bin/echo").arg("ready"),
                Duration::from_secs(2)
            )
            .unwrap(),
            b"ready\n"
        );
    }

    #[test]
    fn localhost_is_tried_before_wsl_addresses() {
        let wsl = Ipv4Addr::new(172, 26, 183, 217);
        assert_eq!(
            candidates(vec![wsl, Ipv4Addr::LOCALHOST]),
            vec![Ipv4Addr::LOCALHOST, wsl]
        );
    }

    #[test]
    fn liveness_needs_a_200_from_the_health_endpoint() {
        for (reply, up) in [("HTTP/1.1 200 OK\r\n\r\n", true), ("HTTP/1.1 503 Busy\r\n\r\n", false)] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = tauri::Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut part = [0; 1024];
                let count = stream.read(&mut part).unwrap();
                assert!(part[..count].starts_with(b"GET /api/health HTTP/1.1\r\n"));
                stream.write_all(reply.as_bytes()).unwrap();
            });
            assert_eq!(is_up(&url), up);
            server.join().unwrap();
        }
        let closed = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = tauri::Url::parse(&format!("http://{}/", closed.local_addr().unwrap())).unwrap();
        drop(closed);
        assert!(!is_up(&url));
    }

    #[test]
    fn loading_and_failure_pages_keep_messages_as_text() {
        let url = status_page("연결 실패 <script> & 재시도");
        assert_eq!(url.scheme(), "data");
        assert!(!url.as_str().contains("<script>"));
        assert!(url.as_str().contains("%26%6C%74%3B"));
    }

    #[test]
    #[ignore = "requires the installed WSL Cockpit service; starts it if stopped"]
    fn installed_wsl_service_is_discovered_and_authenticated() {
        let url = connect().unwrap();
        assert_eq!(url.scheme(), "http");
        assert_eq!(url.port(), Some(3847));
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "token" && value.len() >= 16));
    }
}
