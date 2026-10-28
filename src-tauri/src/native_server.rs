use std::{
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    os::unix::fs::DirBuilderExt,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

fn running(port: u16) -> io::Result<bool> {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = match TcpStream::connect_timeout(&address, Duration::from_millis(500)) {
        Ok(stream) => stream,
        Err(error) if error.kind() == io::ErrorKind::ConnectionRefused => return Ok(false),
        Err(error) => return Err(error),
    };
    stream.set_read_timeout(Some(Duration::from_secs(1)))?;
    stream.set_write_timeout(Some(Duration::from_secs(1)))?;
    write!(
        stream,
        "GET /api/migration/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )?;
    let mut bytes = Vec::new();
    stream.take(64 * 1024).read_to_end(&mut bytes)?;
    let valid = bytes
        .windows(4)
        .position(|value| value == b"\r\n\r\n")
        .filter(|_| bytes.starts_with(b"HTTP/1.1 200 "))
        .and_then(|end| serde_json::from_slice::<serde_json::Value>(&bytes[end + 4..]).ok())
        .is_some_and(|value| value["runtime"] == "rust");
    if !valid {
        return Err(io::Error::other(format!(
            "Port {port} is occupied by a different or unready server; no process was stopped"
        )));
    }
    Ok(true)
}

pub fn stop(child: &mut Child) -> io::Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    // A live, unreaped Child retains its PID; never target an arbitrary listener.
    let status = Command::new("/bin/kill")
        .args(["-TERM", &child.id().to_string()])
        .status()?;
    if !status.success() {
        return Err(io::Error::other("Could not request native server shutdown"));
    }
    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        if child.try_wait()?.is_some() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(io::Error::other(format!(
        "Native manager {} did not finish shutdown; it was not force-killed",
        child.id()
    )))
}

fn wait_ready(child: &mut Child, port: u16, timeout: Duration) -> io::Result<()> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait()? {
            return Err(io::Error::other(format!(
                "Native manager exited during startup: {status}"
            )));
        }
        match running(port) {
            Ok(true) => return Ok(()),
            Ok(false) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::WouldBlock
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::BrokenPipe
                        | io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(error),
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(io::Error::other(
        "Native server startup timed out; inspect desktop-state/logs/server.log",
    ))
}

pub fn start(
    binary: &Path,
    root: &Path,
    data: &Path,
    home: &Path,
    port: u16,
) -> io::Result<Option<Child>> {
    if running(port)? {
        return Ok(None);
    }
    if [binary, root, data, home]
        .iter()
        .any(|path| !path.is_absolute())
    {
        return Err(io::Error::other("Desktop server paths must be absolute"));
    }
    let state = data.join("desktop-state");
    for path in state.ancestors() {
        match fs::symlink_metadata(path) {
            Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                return Err(io::Error::other(
                    "Desktop storage must not contain links or non-directory parents",
                ));
            }
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&state)?;
    let mut child = Command::new(binary)
        .arg("--managed")
        .arg("--root")
        .arg(root)
        .arg("--data-dir")
        .arg(data)
        .arg("--home-dir")
        .arg(home)
        .arg("--state-dir")
        .arg(state)
        .env("COCKPIT_PORT", port.to_string())
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .spawn()?;
    if let Err(error) = wait_ready(&mut child, port, Duration::from_secs(25)) {
        stop(&mut child)?;
        return Err(error);
    }
    Ok(Some(child))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn fixture(body: &'static str) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = std::thread::spawn(move || {
            let (mut client, _) = listener.accept().unwrap();
            client
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                let mut buffer = [0; 1024];
                let count = client.read(&mut buffer).unwrap();
                assert!(count > 0 && request.len() + count < 4096);
                request.extend_from_slice(&buffer[..count]);
            }
            assert!(request.starts_with(b"GET /api/migration/status "));
            write!(
                client,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
        });
        (port, task)
    }

    #[test]
    fn existing_native_server_is_reused_without_launching_or_creating_storage() {
        let (port, task) = fixture(r#"{"runtime":"rust"}"#);
        let absent = Path::new("/does-not-exist/cockpit-fixture");
        assert!(start(absent, absent, absent, absent, port)
            .unwrap()
            .is_none());
        task.join().unwrap();
    }

    #[test]
    fn different_or_invalid_listener_is_rejected_without_replacement() {
        for body in [r#"{"runtime":"node"}"#, "not JSON"] {
            let (port, task) = fixture(body);
            assert!(running(port).is_err());
            task.join().unwrap();
        }
    }

    #[test]
    fn owned_child_shutdown_reaps_the_process() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        stop(&mut child).unwrap();
        assert!(child.try_wait().unwrap().is_some());
        stop(&mut child).unwrap();
    }

    #[test]
    fn owned_startup_survives_a_bound_port_with_delayed_http_readiness() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let server = std::thread::spawn(move || {
            let (mut first, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            first.read(&mut request).unwrap();
            // The production server binds before doing its startup host lookup.
            std::thread::sleep(Duration::from_millis(1300));
            drop(first);
            listener.set_nonblocking(true).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            while Instant::now() < deadline {
                if let Ok((mut client, _)) = listener.accept() {
                    client
                        .set_read_timeout(Some(Duration::from_secs(1)))
                        .unwrap();
                    client.read(&mut request).unwrap();
                    client.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{\"runtime\":\"rust\"}").unwrap();
                    return;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        });
        let result = wait_ready(&mut child, port, Duration::from_secs(5));
        stop(&mut child).unwrap();
        server.join().unwrap();
        result.unwrap();
    }
}
