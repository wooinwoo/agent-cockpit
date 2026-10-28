//! Linux manager for one owned server child and verified restart handovers.
use std::{error::Error, ffi::OsString};

pub async fn run(args: Vec<OsString>) -> Result<(), Box<dyn Error>> {
    #[cfg(target_os = "linux")]
    {
        linux::run(args).await.map_err(Into::into)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = args;
        Err("Managed restart is only supported on Linux and WSL".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::board_value::V;
    use serde_json::Value;
    use std::{
        collections::VecDeque,
        ffi::{CString, OsString},
        fs::{self, File, OpenOptions},
        io::{self, Read, Write},
        net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            },
        },
        path::{Component, Path, PathBuf},
        process::{ExitStatus, Stdio},
        sync::{Arc, Mutex, OnceLock},
        time::{Duration, Instant},
    };
    use tokio::{
        io::{AsyncRead, AsyncReadExt},
        process::{Child, Command},
        signal::unix::{signal, Signal, SignalKind},
        sync::{mpsc, oneshot},
        task::JoinHandle,
    };

    const MAX_LINE: usize = 16 * 1024;
    const MAX_PENDING: usize = 64 * 1024;
    const MAX_LOG: u64 = 4 * 1024 * 1024;
    const START_TIMEOUT: Duration = Duration::from_secs(20);
    const STOP_TIMEOUT: Duration = Duration::from_secs(10);

    fn error(message: impl Into<String>) -> io::Error {
        io::Error::other(message.into())
    }

    struct Config {
        root: PathBuf,
        data: PathBuf,
        preview: bool,
    }
    impl Config {
        fn parse(args: &[OsString]) -> io::Result<Self> {
            let (mut root, mut sandbox, mut data, mut state) = (None, None, None, None);
            let mut pairs = args.chunks_exact(2);
            for pair in &mut pairs {
                match pair[0].to_str() {
                    Some("--root") => root = Some(PathBuf::from(&pair[1])),
                    Some("--sandbox-dir") => sandbox = Some(PathBuf::from(&pair[1])),
                    Some("--data-dir") => data = Some(PathBuf::from(&pair[1])),
                    Some("--state-dir") => state = Some(PathBuf::from(&pair[1])),
                    Some("--home-dir" | "--bind") => {}
                    _ => return Err(error("Invalid managed server arguments")),
                }
            }
            if !pairs.remainder().is_empty() || sandbox.is_some() == data.is_some() {
                return Err(error("Managed server requires one data directory mode"));
            }
            let root = root.ok_or_else(|| error("Managed server requires --root"))?;
            let preview = sandbox.is_some();
            if preview && state.is_some() {
                return Err(error("--state-dir requires --data-dir"));
            }
            let data = sandbox.clone().or(data).unwrap();
            let log_root = sandbox.or(state).unwrap_or(root);
            if [&log_root, &data].iter().any(|path| {
                !path.is_absolute()
                    || path
                        .components()
                        .any(|part| matches!(part, Component::ParentDir))
            }) {
                return Err(error(
                    "Managed server log root must be an absolute path without traversal",
                ));
            }
            Ok(Self {
                root: log_root,
                data,
                preview,
            })
        }
    }

    fn bound_args(args: &[OsString], address: SocketAddr) -> Vec<OsString> {
        let mut fixed = Vec::with_capacity(args.len() + 2);
        for pair in args.chunks_exact(2) {
            if pair[0] != "--bind" {
                fixed.extend_from_slice(pair);
            }
        }
        fixed.extend(["--bind".into(), address.to_string().into()]);
        fixed
    }

    // Traverse through directory descriptors so a renamed ancestor cannot redirect
    // the log to a different directory after its symlink check.
    fn directory(path: &Path) -> io::Result<File> {
        if !path.is_absolute() {
            return Err(error("Log directory must be absolute"));
        }
        let mut current = File::open("/")?;
        for component in path.components() {
            let Component::Normal(name) = component else {
                if matches!(component, Component::RootDir) {
                    continue;
                }
                return Err(error("Invalid log directory component"));
            };
            let name = CString::new(name.as_bytes()).map_err(|_| error("Invalid log directory"))?;
            let fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            current = unsafe { File::from_raw_fd(fd) };
        }
        Ok(current)
    }

    fn owned_file(file: &File) -> io::Result<()> {
        let meta = file.metadata()?;
        if !meta.is_file() || meta.nlink() != 1 || meta.uid() != unsafe { libc::getuid() } {
            return Err(error(
                "Log must be a regular file owned by the current user without hard links",
            ));
        }
        Ok(())
    }

    struct Log {
        _directory: File,
        path: PathBuf,
        file: File,
        bytes: u64,
    }
    impl Log {
        fn open(config: &Config) -> io::Result<Self> {
            let root = directory(&config.root)?;
            let root_path = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd()));
            if config.preview {
                let marker = OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(root_path.join(".cockpit-rust-preview"))?;
                owned_file(&marker)?;
            }
            let name = CString::new("logs").unwrap();
            if unsafe { libc::mkdirat(root.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                let err = io::Error::last_os_error();
                if err.kind() != io::ErrorKind::AlreadyExists {
                    return Err(err);
                }
            }
            let fd = unsafe {
                libc::openat(
                    root.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            let directory = unsafe { File::from_raw_fd(fd) };
            let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
            let file = Self::file(&path)?;
            let bytes = file.metadata()?.len();
            Ok(Self {
                _directory: directory,
                path,
                file,
                bytes,
            })
        }
        fn file(path: &Path) -> io::Result<File> {
            let file = OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path.join("server.log"))?;
            owned_file(&file)?;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
            Ok(file)
        }
        fn append(&mut self, text: &str) -> io::Result<()> {
            if self.bytes.saturating_add(text.len() as u64) > MAX_LOG {
                let backup = self.path.join("server.log.1");
                match OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&backup)
                {
                    Ok(file) => owned_file(&file)?,
                    Err(err) if err.kind() == io::ErrorKind::NotFound => {}
                    Err(err) => return Err(err),
                }
                // An older launcher may have left an unbounded log. Keep the
                // single rotated file within the same cap as the active file.
                if self.file.metadata()?.len() > MAX_LOG {
                    self.file.set_len(MAX_LOG)?;
                }
                self.file.sync_all()?;
                fs::rename(self.path.join("server.log"), backup)?;
                self.file = Self::file(&self.path)?;
                self.bytes = 0;
                self._directory.sync_all()?;
            }
            self.file.write_all(text.as_bytes())?;
            self.bytes += text.len() as u64;
            Ok(())
        }
    }

    fn masked(text: &str) -> String {
        // The shared masker handles known credential formats. Quoted JSON keys
        // need a separate boundary because the original text patterns omit it.
        static JSON_SECRET: OnceLock<regex::Regex> = OnceLock::new();
        let json_secret = JSON_SECRET.get_or_init(|| regex::Regex::new(
            r#"(?i)("[^"\\]*(?:password|passwd|token|secret|api[_-]?key|authorization)[^"\\]*"\s*:\s*)"(?:\\.|[^"\\])*""#
        ).unwrap());
        let text = json_secret.replace_all(text, "$1\"***\"");
        crate::telegram_text::mask(&V::from(text.into_owned())).text()
    }

    struct Output {
        config: Config,
        log: Option<Log>,
        pending: VecDeque<String>,
        bytes: usize,
    }
    impl Output {
        fn record(&mut self, source: &str, text: &str) -> io::Result<()> {
            let text = format!("[{source}] {}\n", masked(text));
            // A detached launch may have no stderr reader; the file remains the
            // authoritative log once startup has been verified.
            let _ = write!(io::stderr(), "{text}");
            if let Some(log) = &mut self.log {
                return log.append(&text);
            }
            self.bytes += text.len();
            self.pending.push_back(text);
            while self.bytes > MAX_PENDING {
                self.bytes -= self.pending.pop_front().unwrap().len();
            }
            Ok(())
        }
        fn activate(&mut self) -> io::Result<()> {
            if self.log.is_some() {
                return Ok(());
            }
            let mut log = Log::open(&self.config)?;
            for line in &self.pending {
                log.append(line)?;
            }
            self.pending.clear();
            self.bytes = 0;
            self.log = Some(log);
            Ok(())
        }
    }
    type SharedOutput = Arc<Mutex<Output>>;
    fn record(output: &SharedOutput, source: &str, text: &str) -> io::Result<()> {
        output
            .lock()
            .map_err(|_| error("Server log lock unavailable"))?
            .record(source, text)
    }

    struct Ready {
        value: Value,
        address: SocketAddr,
    }
    fn ready(value: Value) -> io::Result<Ready> {
        let address = value
            .get("listening")
            .and_then(Value::as_str)
            .and_then(|value| value.parse::<SocketAddr>().ok())
            .filter(|address| address.port() != 0)
            .ok_or_else(|| error("Invalid server readiness announcement"))?;
        Ok(Ready { value, address })
    }

    async fn drain(
        mut stream: impl AsyncRead + Unpin,
        source: &'static str,
        output: SharedOutput,
        mut announcement: Option<oneshot::Sender<io::Result<Ready>>>,
        faults: mpsc::Sender<()>,
    ) {
        let mut buffer = [0; 2048];
        let mut line = Vec::new();
        let mut oversized = false;
        loop {
            let count = match stream.read(&mut buffer).await {
                Ok(count) => count,
                Err(_) => {
                    let _ = faults.try_send(());
                    return;
                }
            };
            for byte in buffer[..count]
                .iter()
                .copied()
                .chain((count == 0 && (!line.is_empty() || oversized)).then_some(b'\n'))
            {
                if byte != b'\n' {
                    if !oversized {
                        if line.len() == MAX_LINE {
                            line.clear();
                            oversized = true;
                        } else {
                            line.push(byte);
                        }
                    }
                    continue;
                }
                let text = if oversized {
                    "Oversized output line omitted".into()
                } else {
                    String::from_utf8_lossy(&line).into_owned()
                };
                line.clear();
                oversized = false;
                if announcement.is_some() {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        let _ = announcement.take().unwrap().send(ready(value));
                        continue;
                    }
                }
                if record(&output, source, &text).is_err() {
                    let _ = faults.try_send(());
                    return;
                }
            }
            if count == 0 {
                return;
            }
        }
    }

    fn health_cookie(data: &Path) -> io::Result<reqwest::header::HeaderValue> {
        let read = || -> io::Result<String> {
            let directory = directory(data)?;
            let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                .open(path.join(".cockpit-token"))?;
            let metadata = file.metadata()?;
            if !metadata.is_file() || metadata.len() > MAX_LINE as u64 {
                return Err(error("Invalid health credential file"));
            }
            let mut bytes = Vec::new();
            file.take(MAX_LINE as u64 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > MAX_LINE {
                return Err(error("Health credential exceeds size limit"));
            }
            String::from_utf8(bytes).map_err(|_| error("Invalid health credential encoding"))
        };
        let token = read().map_err(|_| error("Unable to read managed health credential"))?;
        let token = token.trim();
        if token.len() < 16 || reqwest::header::HeaderValue::from_str(token).is_err() {
            return Err(error("Invalid managed health credential"));
        }
        let mut cookie = reqwest::header::HeaderValue::from_str(&format!("cockpit-token={token}"))
            .map_err(|_| error("Invalid managed health credential"))?;
        cookie.set_sensitive(true);
        Ok(cookie)
    }

    async fn healthy(client: &reqwest::Client, address: SocketAddr, data: &Path) -> io::Result<()> {
        let cookie = health_cookie(data)?;
        let ip = match address.ip() {
            IpAddr::V4(ip) if ip.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
            IpAddr::V6(ip) if ip.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
            ip => ip,
        };
        let url = format!("http://{}/api/health", SocketAddr::new(ip, address.port()));
        loop {
            if let Ok(mut response) = client
                .get(&url)
                .header(reqwest::header::COOKIE, cookie.clone())
                .send()
                .await
            {
                if response.status().is_success() {
                    let mut bytes = Vec::new();
                    let complete = loop {
                        match response.chunk().await {
                            Ok(Some(chunk)) if bytes.len() + chunk.len() <= MAX_LINE => {
                                bytes.extend_from_slice(&chunk)
                            }
                            Ok(None) => break true,
                            _ => break false,
                        }
                    };
                    if complete
                        && serde_json::from_slice::<Value>(&bytes)
                            .is_ok_and(|value| value["status"] == "ok")
                    {
                        return Ok(());
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    struct Signals {
        terminate: Signal,
        interrupt: Signal,
    }
    impl Signals {
        fn new() -> io::Result<Self> {
            Ok(Self {
                terminate: signal(SignalKind::terminate())?,
                interrupt: signal(SignalKind::interrupt())?,
            })
        }
        async fn stopped(&mut self) {
            tokio::select! { _ = self.terminate.recv() => {}, _ = self.interrupt.recv() => {} }
        }
    }

    struct Server {
        child: Option<Child>,
        readers: Vec<JoinHandle<()>>,
        announcement: Option<oneshot::Receiver<io::Result<Ready>>>,
        faults: mpsc::Receiver<()>,
    }
    impl Server {
        fn spawn(executable: &Path, args: &[OsString], output: &SharedOutput) -> io::Result<Self> {
            let mut command = Command::new(executable);
            command
                .arg("--managed-child")
                .args(args)
                .env("COCKPIT_MANAGER_PID", std::process::id().to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .process_group(0)
                .kill_on_drop(true);
            let mut child = command.spawn()?;
            let (announcement, receiver) = oneshot::channel();
            let (faults, failures) = mpsc::channel(2);
            let readers = vec![
                tokio::spawn(drain(
                    child.stdout.take().unwrap(),
                    "server stdout",
                    output.clone(),
                    Some(announcement),
                    faults.clone(),
                )),
                tokio::spawn(drain(
                    child.stderr.take().unwrap(),
                    "server stderr",
                    output.clone(),
                    None,
                    faults,
                )),
            ];
            Ok(Self {
                child: Some(child),
                readers,
                announcement: Some(receiver),
                faults: failures,
            })
        }
        async fn finish_readers(&mut self) {
            for mut reader in self.readers.drain(..) {
                if tokio::time::timeout(Duration::from_secs(1), &mut reader)
                    .await
                    .is_err()
                {
                    reader.abort();
                    let _ = reader.await;
                }
            }
        }
        async fn stop(&mut self) -> io::Result<()> {
            let child = self.child.as_mut().unwrap();
            if let Some(pid) = child.id() {
                // Only the owned, unreaped direct child is signalled. Its tmux
                // sessions and other process groups must outlive server restart.
                if unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) } != 0 {
                    let err = io::Error::last_os_error();
                    if err.raw_os_error() != Some(libc::ESRCH) {
                        return Err(err);
                    }
                }
                match tokio::time::timeout(STOP_TIMEOUT, child.wait()).await {
                    Ok(result) => {
                        result?;
                    }
                    Err(_) => {
                        child.start_kill()?;
                        tokio::time::timeout(Duration::from_secs(5), child.wait())
                            .await
                            .map_err(|_| error("Owned server did not exit after termination"))??;
                    }
                }
            }
            self.finish_readers().await;
            Ok(())
        }
    }
    impl Drop for Server {
        fn drop(&mut self) {
            for reader in self.readers.drain(..) {
                reader.abort();
            }
            if let Some(mut child) = self.child.take() {
                if child.id().is_some() {
                    let _ = child.start_kill();
                    if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                        runtime.spawn(async move {
                            let _ =
                                tokio::time::timeout(Duration::from_secs(5), child.wait()).await;
                        });
                    }
                }
            }
        }
    }

    enum Startup {
        Ready(Ready),
        Failed,
        Stopped,
    }
    async fn startup(
        server: &mut Server,
        client: &reqwest::Client,
        signals: &mut Signals,
        data: &Path,
    ) -> Startup {
        let announcement = server.announcement.take().unwrap();
        let ready = async {
            let value = announcement
                .await
                .map_err(|_| error("Server exited before readiness"))??;
            healthy(client, value.address, data).await?;
            Ok::<_, io::Error>(value)
        };
        tokio::select! {
            _ = signals.stopped() => Startup::Stopped,
            _ = server.child.as_mut().unwrap().wait() => Startup::Failed,
            Some(_) = server.faults.recv() => Startup::Failed,
            value = tokio::time::timeout(START_TIMEOUT, ready) => match value {
                Ok(Ok(value)) => Startup::Ready(value), _ => Startup::Failed,
            },
        }
    }

    fn fallback(previous: &Option<File>, used: &mut bool) -> Option<PathBuf> {
        if *used {
            return None;
        }
        let file = previous.as_ref()?;
        *used = true;
        Some(PathBuf::from(format!(
            "/proc/{}/fd/{}",
            std::process::id(),
            file.as_raw_fd()
        )))
    }

    fn retain_candidate(previous: &mut Option<File>, pin: File) -> io::Result<Option<File>> {
        let Some(baseline) = previous else {
            *previous = Some(pin);
            return Ok(None);
        };
        let baseline = baseline.metadata()?;
        let candidate = pin.metadata()?;
        if (baseline.dev(), baseline.ino()) == (candidate.dev(), candidate.ino()) {
            Ok(None)
        } else {
            Ok(Some(pin))
        }
    }

    // Promote a replacement only after the observed healthy lifetime passes
    // probation. A fallback using the baseline inode never replaces that pin.
    fn finish_candidate(
        previous: &mut Option<File>,
        candidate: Option<File>,
        stable: bool,
    ) -> bool {
        if stable {
            if let Some(pin) = candidate {
                *previous = Some(pin);
            }
            false
        } else {
            candidate.is_some()
        }
    }

    pub(super) async fn run(mut args: Vec<OsString>) -> io::Result<()> {
        let config = Config::parse(&args)?;
        let data = config.data.clone();
        let mut signals = Signals::new()?;
        let executable = std::env::current_exe()?;
        let mut next = executable.clone();
        let output = Arc::new(Mutex::new(Output {
            config,
            log: None,
            pending: VecDeque::new(),
            bytes: 0,
        }));
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(1))
            .build()
            .map_err(|_| error("Unable to create local health client"))?;
        let mut previous = None;
        let mut fallback_used = false;
        let mut failures = 0;
        loop {
            let mut server = match Server::spawn(&next, &args, &output) {
                Ok(server) => server,
                Err(_) => {
                    record(&output, "manager", "Server spawn failed")?;
                    if let Some(path) = fallback(&previous, &mut fallback_used) {
                        record(
                            &output,
                            "manager",
                            "Trying the previous verified executable once",
                        )?;
                        next = path;
                        continue;
                    }
                    return Err(error("Managed server spawn failed; no further fallback"));
                }
            };
            let announced = startup(&mut server, &client, &mut signals, &data).await;
            if matches!(announced, Startup::Stopped) {
                server.stop().await?;
                return Ok(());
            }
            let verified = if let Startup::Ready(mut ready) = announced {
                let pid = server
                    .child
                    .as_ref()
                    .unwrap()
                    .id()
                    .ok_or_else(|| error("Server exited during readiness"))?;
                let pin = File::open(format!("/proc/{pid}/exe"));
                let activate = output
                    .lock()
                    .map_err(|_| error("Server log lock unavailable"))?
                    .activate();
                match (pin, activate) {
                    (Ok(pin), Ok(())) => {
                        ready.value["managed"] = true.into();
                        ready.value["serverPid"] = pid.into();
                        Some((ready, pin))
                    }
                    _ => None,
                }
            } else {
                None
            };
            let Some((ready, pin)) = verified else {
                server.stop().await?;
                record(&output, "manager", "Server startup verification failed")?;
                if let Some(path) = fallback(&previous, &mut fallback_used) {
                    record(
                        &output,
                        "manager",
                        "Trying the previous verified executable once",
                    )?;
                    next = path;
                    continue;
                }
                return Err(error("Managed server startup failed; no further fallback"));
            };
            args = bound_args(&args, ready.address);
            let candidate = match retain_candidate(&mut previous, pin) {
                Ok(candidate) => candidate,
                Err(error) => {
                    server.stop().await?;
                    return Err(error);
                }
            };
            let publish = || -> io::Result<()> {
                record(
                    &output,
                    "manager",
                    &format!("Verified server ready: {}", ready.value),
                )?;
                writeln!(io::stdout(), "{}", ready.value)?;
                io::stdout().flush()
            };
            if let Err(error) = publish() {
                server.stop().await?;
                return Err(error);
            }
            let ready_at = Instant::now();
            let status: io::Result<ExitStatus> = tokio::select! {
                _ = signals.stopped() => { server.stop().await?; return Ok(()); },
                status = server.child.as_mut().unwrap().wait() => status,
                Some(_) = server.faults.recv() => { server.stop().await?; Err(error("Server output collection failed")) },
            };
            let stable = ready_at.elapsed() >= Duration::from_secs(60);
            let early_candidate = finish_candidate(&mut previous, candidate, stable);
            if stable {
                failures = 0;
            }
            server.finish_readers().await;
            match status?.code() {
                Some(0) => return Ok(()),
                Some(75) => record(
                    &output,
                    "manager",
                    "Restart requested; starting the replacement server",
                )?,
                _ => {
                    failures += 1;
                    record(&output, "manager", "Server exited unexpectedly")?;
                    if failures > 3 {
                        return Err(error("Managed server restart limit reached"));
                    }
                    tokio::select! {
                        _ = signals.stopped() => return Ok(()),
                        _ = tokio::time::sleep(Duration::from_secs(1 << (failures - 1))) => {},
                    }
                    if early_candidate {
                        if let Some(path) = fallback(&previous, &mut fallback_used) {
                            record(
                                &output,
                                "manager",
                                "Replacement exited during probation; trying the previous verified executable once",
                            )?;
                            next = path;
                            continue;
                        }
                    }
                }
            }
            next = executable.clone();
            fallback_used = false;
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn modes_and_port_persistence_keep_original_server_arguments() {
            let args: Vec<OsString> = [
                "--root",
                "/source",
                "--sandbox-dir",
                "/preview",
                "--bind",
                "127.0.0.1:0",
            ]
            .map(Into::into)
            .into();
            let config = Config::parse(&args).unwrap();
            assert!(config.preview);
            assert_eq!(config.root, Path::new("/preview"));
            let address = "127.0.0.1:43210".parse().unwrap();
            let fixed = bound_args(&args, address);
            assert_eq!(fixed.last().unwrap(), "127.0.0.1:43210");
            assert_eq!(&fixed[..4], &args[..4]);
            let legacy = ["--root", "/source", "--data-dir", "/data"].map(Into::into);
            let config = Config::parse(&legacy).unwrap();
            assert!(!config.preview);
            assert_eq!(config.root, Path::new("/source"));
            let packaged: Vec<OsString> = legacy
                .into_iter()
                .chain(["--state-dir".into(), "/writable-state".into()])
                .collect();
            let config = Config::parse(&packaged).unwrap();
            assert_eq!(config.root, Path::new("/writable-state"));
            assert_eq!(config.data, Path::new("/data"));
            assert_eq!(&bound_args(&packaged, address)[..6], &packaged);
            let mut preview_state = args.to_vec();
            preview_state.extend(["--state-dir".into(), "/writable-state".into()]);
            assert!(Config::parse(&preview_state).is_err());
            assert!(Config::parse(&["--managed-child".into(), "ignored".into()]).is_err());
            assert!(ready(serde_json::json!({"listening":"127.0.0.1:0"})).is_err());
            assert!(ready(serde_json::json!({"listening":"127.0.0.1:43210"})).is_ok());
        }

        #[test]
        fn private_logs_mask_rotate_and_reject_symlinks_without_creating_preview_marker() {
            let temp = tempfile::tempdir().unwrap();
            let config = Config {
                root: temp.path().to_path_buf(),
                data: temp.path().to_path_buf(),
                preview: true,
            };
            assert!(Log::open(&config).is_err());
            assert!(!temp.path().join("logs").exists());
            fs::write(temp.path().join(".cockpit-rust-preview"), b"fixture").unwrap();
            let mut log = Log::open(&config).unwrap();
            let text = masked("TOKEN=private-value {\"apiKey\":\"quoted-value\"}");
            assert!(!text.contains("private-value"));
            assert!(!text.contains("quoted-value"));
            log.append(&text).unwrap();
            log.file.set_len(MAX_LOG).unwrap();
            log.bytes = MAX_LOG;
            log.append("next\n").unwrap();
            assert_eq!(
                fs::read(temp.path().join("logs/server.log")).unwrap(),
                b"next\n"
            );
            let meta = fs::metadata(temp.path().join("logs/server.log")).unwrap();
            assert_eq!(meta.permissions().mode() & 0o777, 0o600);
            assert!(
                fs::metadata(temp.path().join("logs/server.log.1"))
                    .unwrap()
                    .len()
                    <= MAX_LOG
            );
            let other = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(temp.path().join("logs"), other.path().join("logs"))
                .unwrap();
            assert!(Log::open(&Config {
                root: other.path().to_path_buf(),
                data: other.path().to_path_buf(),
                preview: false
            })
            .is_err());
        }

        #[test]
        fn health_cookie_is_sensitive_bounded_and_rejects_symlink_files() {
            let temp = tempfile::tempdir().unwrap();
            let path = temp.path().join(".cockpit-token");
            fs::write(&path, b"synthetic-private-token-1234567890\n").unwrap();
            let cookie = health_cookie(temp.path()).unwrap();
            assert!(cookie.is_sensitive());
            assert_eq!(
                cookie.to_str().unwrap(),
                "cockpit-token=synthetic-private-token-1234567890"
            );
            let other = tempfile::tempdir().unwrap();
            std::os::unix::fs::symlink(&path, other.path().join(".cockpit-token")).unwrap();
            assert!(health_cookie(other.path()).is_err());
            fs::write(&path, vec![b'x'; MAX_LINE + 1]).unwrap();
            assert!(health_cookie(temp.path()).is_err());
            fs::write(&path, b"synthetic-token\r\nforged-header: value").unwrap();
            assert!(health_cookie(temp.path()).is_err());
        }

        #[test]
        fn pinned_fallback_is_available_once_per_primary_attempt() {
            let mut used = false;
            assert!(fallback(&None, &mut used).is_none());
            assert!(!used);
            let pin = Some(tempfile::tempfile().unwrap());
            let first = fallback(&pin, &mut used).unwrap();
            assert!(used);
            assert!(fallback(&pin, &mut used).is_none());
            used = false;
            assert_eq!(fallback(&pin, &mut used), Some(first));
        }

        #[test]
        fn early_replacement_failure_preserves_baseline_and_same_inode_is_not_a_candidate() {
            let v1 = tempfile::tempfile().unwrap();
            let v2 = tempfile::tempfile().unwrap();
            let mut previous = None;
            assert!(retain_candidate(&mut previous, v1.try_clone().unwrap())
                .unwrap()
                .is_none());
            let baseline_fd = previous.as_ref().unwrap().as_raw_fd();
            let candidate = retain_candidate(&mut previous, v2).unwrap();
            assert!(candidate.is_some());
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), baseline_fd);
            assert!(finish_candidate(&mut previous, candidate, false));
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), baseline_fd);

            let mut used = false;
            assert!(fallback(&previous, &mut used).is_some());
            assert!(fallback(&previous, &mut used).is_none());
            let fallback_pin = retain_candidate(&mut previous, v1.try_clone().unwrap()).unwrap();
            assert!(fallback_pin.is_none());
            assert!(!finish_candidate(&mut previous, fallback_pin, false));
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), baseline_fd);
            let same_inode = retain_candidate(&mut previous, v1).unwrap();
            assert!(!finish_candidate(&mut previous, same_inode, true));
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), baseline_fd);
        }

        #[test]
        fn replacement_is_promoted_only_after_probation_and_remains_the_next_fallback() {
            let v1 = tempfile::tempfile().unwrap();
            let v2 = tempfile::tempfile().unwrap();
            let v2_fd = v2.as_raw_fd();
            let mut previous = Some(v1);
            let candidate = retain_candidate(&mut previous, v2).unwrap();
            assert!(!finish_candidate(&mut previous, candidate, true));
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), v2_fd);

            let v3 = tempfile::tempfile().unwrap();
            let candidate = retain_candidate(&mut previous, v3).unwrap();
            assert!(finish_candidate(&mut previous, candidate, false));
            assert_eq!(previous.as_ref().unwrap().as_raw_fd(), v2_fd);
            let mut used = false;
            assert_eq!(
                fallback(&previous, &mut used).unwrap(),
                PathBuf::from(format!("/proc/{}/fd/{v2_fd}", std::process::id()))
            );
        }
    }
}
