//! Native model transport. Callers own routing, permissions, history and SSE names.
#[cfg(unix)]
use crate::process_owned::OwnedChild;
use serde_json::{json, Value};
use std::{io, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

const OUTPUT_LIMIT: usize = 16 * 1024 * 1024;
const LINE_LIMIT: usize = 1024 * 1024;

#[derive(Clone)]
pub struct Cancel(watch::Sender<bool>, Vec<watch::Sender<bool>>);
impl Default for Cancel {
    fn default() -> Self {
        Self(watch::channel(false).0, vec![])
    }
}
impl Cancel {
    /// Child operations observe parent cancellation even during synchronous work.
    /// Cancelling one timed-out child does not cancel its parent or siblings.
    pub fn child(&self) -> Self {
        let mut ancestors = self.1.clone();
        ancestors.push(self.0.clone());
        Self(watch::channel(false).0, ancestors)
    }
    pub fn cancel(&self) {
        self.0.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.0.borrow() || self.1.iter().any(|parent| *parent.borrow())
    }
    pub async fn cancelled(&self) {
        use futures_util::{stream::FuturesUnordered, StreamExt};
        let mut changes: FuturesUnordered<_> = std::iter::once(&self.0)
            .chain(self.1.iter())
            .map(|sender| {
                let mut receiver = sender.subscribe();
                async move {
                    loop {
                        if *receiver.borrow_and_update() {
                            return;
                        }
                        if receiver.changed().await.is_err() {
                            return;
                        }
                    }
                }
            })
            .collect();
        changes.next().await;
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Delta {
    Text(String),
    Thinking(String),
}

pub struct ClaudeOptions {
    pub model: String,
    pub system_prompt: Option<String>,
    pub continue_session: bool,
    pub stream: bool,
    pub timeout: Duration,
}
impl Default for ClaudeOptions {
    fn default() -> Self {
        Self {
            model: "haiku".into(),
            system_prompt: None,
            continue_session: false,
            stream: false,
            timeout: Duration::from_secs(60),
        }
    }
}
pub struct GeminiOptions {
    pub model: String,
    pub system_prompt: Option<String>,
    pub stream: bool,
    pub timeout: Duration,
    pub max_tokens: u32,
    pub temperature: Option<f64>,
    pub google_search: bool,
}
impl Default for GeminiOptions {
    fn default() -> Self {
        Self {
            model: "gemini-2.5-flash".into(),
            system_prompt: None,
            stream: true,
            timeout: Duration::from_secs(120),
            max_tokens: 8192,
            temperature: Some(0.7),
            google_search: false,
        }
    }
}

fn limited() -> io::Error {
    io::Error::other("AI response exceeded output limit")
}
fn append(bytes: &mut Vec<u8>, chunk: &[u8], limit: usize) -> io::Result<()> {
    if chunk.len() > limit.saturating_sub(bytes.len()) {
        return Err(limited());
    }
    bytes.extend_from_slice(chunk);
    Ok(())
}
async fn read_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
    let mut result = vec![];
    let mut chunk = [0; 8192];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            return Ok(result);
        }
        append(&mut result, &chunk[..n], limit)?;
    }
}
fn claude_line(line: &[u8], full: &mut String, emit: &mut impl FnMut(Delta)) {
    let Ok(value) = serde_json::from_slice::<Value>(line) else {
        return;
    };
    let text = match value["type"].as_str() {
        Some("content_block_delta") if value["delta"]["type"] == "text_delta" => {
            value["delta"]["text"].as_str()
        }
        Some("message") if full.is_empty() => {
            value["message"]["content"].as_array().and_then(|blocks| {
                blocks.iter().find_map(|block| {
                    (block["type"] == "text")
                        .then(|| block["text"].as_str())
                        .flatten()
                })
            })
        }
        Some("result") if full.is_empty() => value["result"].as_str(),
        _ => None,
    };
    if let Some(text) = text {
        full.push_str(text);
        emit(Delta::Text(text.into()));
    }
}
async fn claude_stdout(
    mut reader: impl AsyncRead + Unpin,
    stream: bool,
    output_limit: usize,
    emit: &mut impl FnMut(Delta),
) -> io::Result<String> {
    if !stream {
        return Ok(
            String::from_utf8_lossy(&read_bounded(reader, output_limit).await?)
                .trim()
                .into(),
        );
    }
    let mut full = String::new();
    let mut pending = vec![];
    let mut total = 0usize;
    let mut chunk = [0; 8192];
    loop {
        let n = reader.read(&mut chunk).await?;
        if n == 0 {
            claude_line(&pending, &mut full, emit);
            return Ok(full);
        }
        total += n;
        if total > output_limit {
            return Err(limited());
        }
        for part in chunk[..n].split_inclusive(|byte| *byte == b'\n') {
            append(&mut pending, part, LINE_LIMIT)?;
            if pending.last() == Some(&b'\n') {
                claude_line(&pending, &mut full, emit);
                pending.clear();
            }
        }
    }
}

pub async fn claude(
    prompt: &str,
    options: &ClaudeOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    #[cfg(not(unix))]
    return Err("Native Claude launcher has not been validated on this platform".into());
    #[cfg(unix)]
    claude_command(Command::new("claude"), prompt, options, cancel, emit).await
}

#[cfg(unix)]
pub(crate) async fn claude_command(
    mut command: Command,
    prompt: &str,
    options: &ClaudeOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    if cancel.is_cancelled() {
        return Err("AI request cancelled".into());
    }
    command.arg("-p");
    if options.stream {
        command.arg("--verbose");
    }
    command.args(["--model", &options.model]);
    if options.stream {
        command.args(["--output-format", "stream-json"]);
    }
    if options.continue_session {
        command.arg("--continue");
    }
    if let Some(system) = options.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        command.args(["--system-prompt", system]);
    }
    command.env_remove("CLAUDECODE");
    claude_process(command, prompt, options, cancel, emit, OUTPUT_LIMIT).await
}

pub async fn claude_summary(
    prompt: &str,
    timeout: Duration,
    cancel: &Cancel,
) -> Result<String, String> {
    #[cfg(unix)]
    {
        summary_command(Command::new("claude"), prompt, timeout, cancel).await
    }
    #[cfg(not(unix))]
    {
        let _ = (prompt, timeout, cancel);
        Err("Native Windows Claude launcher has not been validated".into())
    }
}

#[cfg(unix)]
async fn summary_command(
    mut command: Command,
    prompt: &str,
    timeout: Duration,
    cancel: &Cancel,
) -> Result<String, String> {
    command.args([
        "-p",
        "--model",
        "haiku",
        "--safe-mode",
        "--tools",
        "",
        "--no-session-persistence",
        "--output-format",
        "text",
        prompt,
    ]);
    claude_process(
        command,
        "",
        &ClaudeOptions {
            timeout,
            ..Default::default()
        },
        cancel,
        |_| {},
        4096,
    )
    .await
}

#[cfg(unix)]
async fn claude_process(
    mut command: Command,
    prompt: &str,
    options: &ClaudeOptions,
    cancel: &Cancel,
    mut emit: impl FnMut(Delta) + Send,
    output_limit: usize,
) -> Result<String, String> {
    if cancel.is_cancelled() {
        return Err("AI request cancelled".into());
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(false);
    let child = command
        .spawn()
        .map_err(|error| format!("Failed to run claude CLI: {error}"))?;
    let mut child = OwnedChild::new(child);
    let mut stdin = child.child_mut().stdin.take().unwrap();
    let stdout = child.child_mut().stdout.take().unwrap();
    let stderr = child.child_mut().stderr.take().unwrap();
    let result = {
        let execution = async {
            tokio::try_join!(
                child.wait_and_clean(),
                claude_stdout(stdout, options.stream, output_limit, &mut emit),
                read_bounded(stderr, LINE_LIMIT.min(output_limit)),
                async move {
                    stdin.write_all(prompt.as_bytes()).await?;
                    stdin.shutdown().await?;
                    drop(stdin);
                    Ok::<_, io::Error>(())
                }
            )
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("AI request cancelled".into()),
            value = tokio::time::timeout(options.timeout, execution) => match value {
                Err(_) => Err("Claude CLI timed out".into()),
                Ok(Err(error)) => Err(format!("Claude CLI I/O failed: {error}")),
                Ok(Ok((status, output, _, ()))) if status.success() => Ok(output),
                Ok(Ok((status, _, stderr, ()))) => {
                    let message = String::from_utf8_lossy(&stderr).trim().to_owned();
                    Err(if message.is_empty() { format!("claude exited with code {}", status.code().map(|code| code.to_string()).unwrap_or_else(|| "signal".into())) } else { message })
                }
            }
        }
    };
    // Dropped I/O futures release their pipe borrows before group cleanup/reaping.
    if result.is_err() {
        child.terminate().await;
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn child_cancellation_observes_parent_without_cancelling_siblings() {
        let parent = Cancel::default();
        let first = parent.child();
        let second = parent.child();
        let nested = second.child();
        first.cancel();
        assert!(first.is_cancelled());
        assert!(!parent.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!nested.is_cancelled());
        parent.cancel();
        assert!(second.is_cancelled());
        assert!(nested.is_cancelled());
        tokio::time::timeout(Duration::from_millis(100), nested.cancelled())
            .await
            .unwrap();
        assert!(parent.child().is_cancelled());
    }

    #[test]
    fn gemini_prompt_preserves_a_utf16_slice_inside_an_emoji() {
        use crate::board_value::V;
        let prompt = V::String(vec![65, 0xd83d]);
        let body = gemini_utf16_body(&prompt, &GeminiOptions::default());
        let parsed = V::parse(&body).unwrap();
        assert_eq!(
            parsed["contents"].array()[0]["parts"].array()[0]["text"],
            prompt
        );
        assert!(body.get().contains("\\ud83d"));
        let normal = gemini_utf16_body(&V::from("valid 😀"), &GeminiOptions::default());
        assert_eq!(
            serde_json::from_str::<Value>(normal.get()).unwrap(),
            gemini_body("valid 😀", &GeminiOptions::default())
        );
    }
    use tokio::net::{TcpListener, TcpStream};

    #[test]
    fn workflow_json_rejects_missing_content_and_preserves_non_text_blocks() {
        assert!(gemini_json(
            &json!({"candidates":[{"finishReason":"SAFETY"}]}),
            &mut |_| {}
        )
        .is_err());
        assert!(gemini_json(&json!({"candidates":[]}), &mut |_| {}).is_err());
        let input = json!({"candidates":[{"content":{"parts":[{"functionCall":{"name":"fixture", "args":{"value":1}}}, {"thought":true,"text":"private thought", "thoughtSignature":"fixture signature"}]}}]});
        let output = gemini_json(&input, &mut |_| {}).unwrap();
        assert_eq!(
            output,
            r#"[{"type":"functionCall","functionCall":{"name":"fixture","args":{"value":1}}},{"type":"thinking","thinking":"private thought","signature":"fixture signature"}]"#
        );
        assert_eq!(
            serde_json::from_str::<Value>(&output).unwrap(),
            json!([{"type":"functionCall", "functionCall":{"name":"fixture", "args":{"value":1}}}, {"type":"thinking", "thinking":"private thought", "signature":"fixture signature"}])
        );
    }

    async fn receive_request(stream: &mut TcpStream) -> (String, Value) {
        let mut received = vec![];
        let mut buffer = [0; 4096];
        loop {
            let n = stream.read(&mut buffer).await.unwrap();
            assert!(n > 0, "request ended early");
            received.extend_from_slice(&buffer[..n]);
            if let Some(at) = received.windows(4).position(|v| v == b"\r\n\r\n") {
                let header = String::from_utf8(received[..at].to_vec()).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .and_then(|n| n.trim().parse::<usize>().ok())
                    })
                    .unwrap();
                if received.len() >= at + 4 + length {
                    return (
                        header,
                        serde_json::from_slice(&received[at + 4..at + 4 + length]).unwrap(),
                    );
                }
            }
        }
    }
    async fn mock(
        body: Vec<u8>,
        status: u16,
        fragments: bool,
    ) -> (reqwest::Url, tokio::task::JoinHandle<(String, Value)>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base =
            gemini_base(Some(&format!("http://{}", listener.local_addr().unwrap()))).unwrap();
        let task = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = receive_request(&mut stream).await;
            stream.write_all(format!("HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len()).as_bytes()).await.unwrap();
            for chunk in body.chunks(if fragments { 1 } else { body.len().max(1) }) {
                stream.write_all(chunk).await.unwrap();
                if fragments {
                    tokio::task::yield_now().await;
                }
            }
            request
        });
        (base, task)
    }
    fn frame(parts: Value) -> String {
        format!(
            "data: {}\r\n\r\n",
            json!({"candidates":[{"content":{"parts":parts}}]})
        )
    }

    #[test]
    fn stream_parser_handles_utf8_crlf_multiline_and_eof() {
        let source = format!(": comment\r\n{}{}data: {{\r\ndata: \"candidates\":[{{\"content\":{{\"parts\":[{{\"text\":\"!\"}}]}}}}]}}\r\n\r\ndata: [DONE]", frame(json!([{"thought":true,"text":"생각"}])), frame(json!([{"text":"안녕😀"}])));
        let mut events = vec![];
        let mut emit = |event| events.push(event);
        let mut parser = Sse::new();
        for byte in source.as_bytes() {
            parser.push(&[*byte], &mut emit).unwrap();
        }
        assert_eq!(parser.finish(&mut emit).unwrap(), "안녕😀!");
        assert_eq!(
            events,
            [
                Delta::Thinking("생각".into()),
                Delta::Text("안녕😀".into()),
                Delta::Text("!".into())
            ]
        );
        let mut parser = Sse::new();
        assert!(parser
            .push(&vec![b'x'; LINE_LIMIT + 1], &mut |_| {})
            .is_err());
    }

    #[tokio::test]
    async fn gemini_stream_and_workflow_json_preserve_request_and_response_contracts() {
        let body = format!(
            "{}{}",
            frame(json!([{"thought":true,"text":"thinking"}])),
            frame(json!([{"text":" OK😀 "}]))
        );
        let (base, task) = mock(body.into_bytes(), 200, true).await;
        let mut events = vec![];
        let options = GeminiOptions {
            system_prompt: Some("시스템".into()),
            ..Default::default()
        };
        assert_eq!(
            gemini_request(
                base,
                "private +&key",
                "질문",
                &options,
                &Cancel::default(),
                |event| events.push(event)
            )
            .await
            .unwrap(),
            "OK😀"
        );
        assert_eq!(
            events,
            [
                Delta::Thinking("thinking".into()),
                Delta::Text(" OK😀 ".into())
            ]
        );
        let (header, request) = task.await.unwrap();
        let path = header
            .lines()
            .next()
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap();
        let url = reqwest::Url::parse(&format!("http://127.0.0.1{path}")).unwrap();
        assert_eq!(
            url.path(),
            "/v1beta/models/gemini-2.5-flash:streamGenerateContent"
        );
        assert_eq!(
            url.query_pairs().find(|(name, _)| name == "key").unwrap().1,
            "private +&key"
        );
        assert_eq!(
            request["generationConfig"],
            json!({"temperature":0.7,"maxOutputTokens":8192,"thinkingConfig":{"thinkingBudget":0}})
        );
        assert_eq!(
            request["systemInstruction"],
            json!({"parts":[{"text":"시스템"}]})
        );
        assert_eq!(
            request["contents"],
            json!([{"role":"user","parts":[{"text":"질문"}]}])
        );

        let (base, task) = mock(
            json!({"candidates":[{"content":{"parts":[{"text":"first"},{"text":"second"}]}}]})
                .to_string()
                .into_bytes(),
            200,
            false,
        )
        .await;
        let options = GeminiOptions {
            model: "gemini-2.5-pro".into(),
            stream: false,
            max_tokens: 4096,
            temperature: None,
            google_search: true,
            ..Default::default()
        };
        assert_eq!(
            gemini_request(
                base,
                "private",
                "workflow",
                &options,
                &Cancel::default(),
                |_| {}
            )
            .await
            .unwrap(),
            "first\nsecond"
        );
        let (header, request) = task.await.unwrap();
        assert!(header.contains(":generateContent?key="));
        assert_eq!(request["generationConfig"], json!({"maxOutputTokens":4096}));
        assert_eq!(request["tools"], json!([{"googleSearch":{}}]));
    }

    #[tokio::test]
    async fn gemini_errors_redact_keys_and_private_endpoint_rejects_redirect_destinations() {
        for base in [
            "http://localhost:1234",
            "https://127.0.0.1",
            "http://10.0.0.1",
            "http://127.0.0.1/private",
            "http://secret@127.0.0.1",
            "http://127.0.0.1/?key=secret",
        ] {
            assert!(gemini_base(Some(base)).is_err());
        }
        assert!(gemini_base(Some("http://[::1]:1234")).is_ok());
        let (base, task) = mock(b"private+%2B%26key private +&key".to_vec(), 403, false).await;
        let error = gemini_request(
            base,
            "private +&key",
            "x",
            &GeminiOptions::default(),
            &Cancel::default(),
            |_| {},
        )
        .await
        .unwrap_err();
        assert!(!error.contains("private"));
        assert!(error.starts_with("Gemini API 403:"));
        task.await.unwrap();
        let (base, task) = mock(b"broken-json".to_vec(), 200, false).await;
        assert_eq!(
            gemini_request(
                base,
                "private",
                "x",
                &GeminiOptions {
                    stream: false,
                    ..Default::default()
                },
                &Cancel::default(),
                |_| {}
            )
            .await
            .unwrap_err(),
            "Invalid Gemini API response"
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn gemini_cancel_timeout_and_drop_close_an_unfinished_body() {
        for scenario in ["cancel", "timeout", "drop"] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base =
                gemini_base(Some(&format!("http://{}", listener.local_addr().unwrap()))).unwrap();
            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                receive_request(&mut stream).await;
                stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n")
                    .await
                    .unwrap();
                let _ = ready_tx.send(());
                let mut byte = [0];
                let closed = tokio::time::timeout(Duration::from_secs(3), stream.read(&mut byte))
                    .await
                    .unwrap();
                assert!(
                    matches!(closed, Ok(0) | Err(_)),
                    "HTTP request remained open"
                );
            });
            let cancel = Cancel::default();
            let request_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                gemini_request(
                    base,
                    "private",
                    "x",
                    &GeminiOptions {
                        timeout: Duration::from_millis(400),
                        ..Default::default()
                    },
                    &request_cancel,
                    |_| {},
                )
                .await
            });
            ready_rx.await.unwrap();
            match scenario {
                "cancel" => {
                    cancel.cancel();
                    assert_eq!(task.await.unwrap().unwrap_err(), "AI request cancelled");
                }
                "timeout" => assert_eq!(
                    task.await.unwrap().unwrap_err(),
                    "Gemini API request timed out"
                ),
                _ => {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                }
            }
            server.await.unwrap();
        }
    }

    #[cfg(unix)]
    fn fixture_command(directory: &std::path::Path, source: &str) -> Command {
        use std::os::unix::fs::PermissionsExt;
        let executable = directory.join("private-claude");
        std::fs::write(&executable, format!("#!/bin/sh\n{source}\n")).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut command = Command::new(executable);
        command.current_dir(directory);
        command
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn summary_cli_retains_safe_flags_and_bounded_output() {
        let directory = tempfile::tempdir().unwrap();
        let command = fixture_command(
            directory.path(),
            "printf '%s\\n' \"$@\" > args\n/bin/cat > prompt\nprintf 'summary'",
        );
        assert_eq!(
            summary_command(
                command,
                "literal $(payload)",
                Duration::from_secs(2),
                &Cancel::default()
            )
            .await
            .unwrap(),
            "summary"
        );
        assert_eq!(std::fs::read_to_string(directory.path().join("args")).unwrap(), "-p\n--model\nhaiku\n--safe-mode\n--tools\n\n--no-session-persistence\n--output-format\ntext\nliteral $(payload)\n");
        assert_eq!(std::fs::read(directory.path().join("prompt")).unwrap(), b"");
        let command = fixture_command(directory.path(), "/usr/bin/head -c 5000 /dev/zero");
        assert!(summary_command(
            command,
            "private fixture",
            Duration::from_secs(2),
            &Cancel::default()
        )
        .await
        .unwrap_err()
        .contains("output limit"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn claude_plain_stream_fallback_arguments_and_env_are_private() {
        let directory = tempfile::tempdir().unwrap();
        let mut command = fixture_command(directory.path(), "printf '%s\\n' \"$@\" > args\nprintf '%s|%s' \"${CLAUDECODE-unset}\" \"$AI_TRANSPORT_FIXTURE\" > env\n/bin/cat > prompt\nprintf '  응답😀 \\n'");
        command
            .env("CLAUDECODE", "must-remove")
            .env("AI_TRANSPORT_FIXTURE", "preserved");
        let options = ClaudeOptions {
            model: "sonnet".into(),
            system_prompt: Some("시스템 ; $(literal)".into()),
            ..Default::default()
        };
        assert_eq!(
            claude_command(
                command,
                "질문😀\nsecond",
                &options,
                &Cancel::default(),
                |_| {}
            )
            .await
            .unwrap(),
            "응답😀"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("prompt")).unwrap(),
            "질문😀\nsecond"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("env")).unwrap(),
            "unset|preserved"
        );
        assert_eq!(
            std::fs::read_to_string(directory.path().join("args")).unwrap(),
            "-p\n--model\nsonnet\n--system-prompt\n시스템 ; $(literal)\n"
        );

        let source = "/bin/cat > /dev/null\nprintf '%s\\n' \"$@\" > args\nprintf '%s\\n' '{\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"안녕😀\"}}'\nprintf '%s' '{\"type\":\"result\",\"result\":\"duplicate\"}'";
        let mut events = vec![];
        let options = ClaudeOptions {
            stream: true,
            continue_session: true,
            ..Default::default()
        };
        assert_eq!(
            claude_command(
                fixture_command(directory.path(), source),
                "x",
                &options,
                &Cancel::default(),
                |event| events.push(event)
            )
            .await
            .unwrap(),
            "안녕😀"
        );
        assert_eq!(events, [Delta::Text("안녕😀".into())]);
        assert_eq!(
            std::fs::read_to_string(directory.path().join("args")).unwrap(),
            "-p\n--verbose\n--model\nhaiku\n--output-format\nstream-json\n--continue\n"
        );
        for record in [
            r#"{"type":"message","message":{"content":[{"type":"text","text":"fallback"}]}}"#,
            r#"{"type":"result","result":"fallback"}"#,
        ] {
            let source = format!("/bin/cat > /dev/null\nprintf '%s' '{record}'");
            assert_eq!(
                claude_command(
                    fixture_command(directory.path(), &source),
                    "x",
                    &options,
                    &Cancel::default(),
                    |_| {}
                )
                .await
                .unwrap(),
                "fallback"
            );
        }
        let source = "/bin/cat > /dev/null\nprintf 'fixture failure' >&2\nexit 7";
        assert_eq!(
            claude_command(
                fixture_command(directory.path(), source),
                "x",
                &options,
                &Cancel::default(),
                |_| {}
            )
            .await
            .unwrap_err(),
            "fixture failure"
        );
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn claude_cancel_timeout_drop_and_pre_cancel_never_leave_owned_child() {
        for scenario in ["cancel", "timeout", "drop"] {
            let directory = tempfile::tempdir().unwrap();
            let command = fixture_command(
                directory.path(),
                "printf '%s' \"$$\" > pid\nexec /bin/sleep 30",
            );
            let cancel = Cancel::default();
            let request_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                // Stdin cannot drain: cancellation must also cover prompt writes.
                claude_command(
                    command,
                    &"x".repeat(1024 * 1024),
                    &ClaudeOptions {
                        timeout: Duration::from_millis(500),
                        ..Default::default()
                    },
                    &request_cancel,
                    |_| {},
                )
                .await
            });
            let pid = tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    if let Ok(pid) = std::fs::read_to_string(directory.path().join("pid")) {
                        if !pid.is_empty() {
                            break pid;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let proc_path = format!("/proc/{pid}/stat");
            let initial = std::fs::read_to_string(&proc_path).unwrap();
            let start = initial
                .rsplit_once(") ")
                .unwrap()
                .1
                .split_whitespace()
                .nth(19)
                .unwrap()
                .to_owned();
            match scenario {
                "cancel" => {
                    cancel.cancel();
                    assert_eq!(task.await.unwrap().unwrap_err(), "AI request cancelled");
                }
                "timeout" => assert_eq!(task.await.unwrap().unwrap_err(), "Claude CLI timed out"),
                _ => {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                }
            }
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let same = std::fs::read_to_string(&proc_path)
                        .ok()
                        .is_some_and(|stat| {
                            stat.rsplit_once(") ").unwrap().1.split_whitespace().nth(19)
                                == Some(start.as_str())
                        });
                    if !same {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("owned child must be killed and reaped, not just left zombie");
        }
        let directory = tempfile::tempdir().unwrap();
        let command = fixture_command(directory.path(), "printf forbidden > spawned");
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(
            claude_command(command, "x", &ClaudeOptions::default(), &cancel, |_| {})
                .await
                .unwrap_err(),
            "AI request cancelled"
        );
        assert!(!directory.path().join("spawned").exists());
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn claude_owned_group_cleans_children_and_grandchildren_even_after_normal_exit() {
        for scenario in ["normal", "cancel", "timeout", "drop"] {
            let directory = tempfile::tempdir().unwrap();
            std::fs::write(directory.path().join("descendant.sh"), "#!/bin/sh\n/bin/cat /proc/$$/stat > child-stat\n/bin/sleep 30 &\n/bin/cat /proc/$!/stat > grandchild-stat\nwait\n").unwrap();
            let command = fixture_command(directory.path(), "/bin/cat > /dev/null\n/bin/cat /proc/$$/stat > leader-stat\n/bin/sh descendant.sh &\nwhile [ ! -f release ]; do /bin/sleep 0.01; done\nprintf 'finished'\nexit 0");
            let cancel = Cancel::default();
            let request_cancel = cancel.clone();
            let task = tokio::spawn(async move {
                claude_command(
                    command,
                    "x",
                    &ClaudeOptions {
                        timeout: Duration::from_secs(2),
                        ..Default::default()
                    },
                    &request_cancel,
                    |_| {},
                )
                .await
            });
            let identities = tokio::time::timeout(Duration::from_secs(1), async {
                loop {
                    let rows: Option<Vec<_>> = ["leader-stat", "child-stat", "grandchild-stat"]
                        .iter()
                        .map(|name| {
                            let stat = std::fs::read_to_string(directory.path().join(name)).ok()?;
                            let pid = stat.split_whitespace().next()?.parse::<u32>().ok()?;
                            let start = stat
                                .rsplit_once(") ")?
                                .1
                                .split_whitespace()
                                .nth(19)?
                                .to_owned();
                            Some((pid, start))
                        })
                        .collect();
                    if let Some(rows) = rows {
                        break rows;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .unwrap();
            let caller_group = unsafe { libc::getpgrp() };
            for (pid, _) in &identities {
                assert_eq!(
                    unsafe { libc::getpgid(*pid as i32) },
                    identities[0].0 as i32
                );
                assert_ne!(unsafe { libc::getpgid(*pid as i32) }, caller_group);
            }
            match scenario {
                "normal" => {
                    std::fs::write(directory.path().join("release"), "exit").unwrap();
                    assert_eq!(
                        tokio::time::timeout(Duration::from_secs(1), task)
                            .await
                            .expect(
                                "lingering inherited pipes must not consume the request deadline"
                            )
                            .unwrap()
                            .unwrap(),
                        "finished"
                    );
                }
                "cancel" => {
                    cancel.cancel();
                    assert_eq!(task.await.unwrap().unwrap_err(), "AI request cancelled");
                }
                "timeout" => assert_eq!(task.await.unwrap().unwrap_err(), "Claude CLI timed out"),
                _ => {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                }
            }
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let mut alive = false;
                    for (index, (pid, start)) in identities.iter().enumerate() {
                        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
                            continue;
                        };
                        let fields: Vec<_> = stat
                            .rsplit_once(") ")
                            .unwrap()
                            .1
                            .split_whitespace()
                            .collect();
                        if fields[19] == start && (index == 0 || !matches!(fields[0], "Z" | "X")) {
                            alive = true;
                        }
                    }
                    if !alive {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .expect("leader must be reaped and owned descendants must no longer execute");
        }
    }
}

fn gemini_base(override_base: Option<&str>) -> Result<reqwest::Url, String> {
    let Some(base) = override_base else {
        return Ok(reqwest::Url::parse("https://generativelanguage.googleapis.com").unwrap());
    };
    let url = reqwest::Url::parse(base).map_err(|_| "Invalid private Gemini endpoint")?;
    if url.scheme() != "http"
        || !url
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|ip| ip.is_loopback())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Invalid private Gemini endpoint".into());
    }
    Ok(url)
}
fn gemini_body(prompt: &str, options: &GeminiOptions) -> Value {
    let mut body = json!({"contents":[{"role":"user","parts":[{"text":prompt}]}], "generationConfig":{"maxOutputTokens":options.max_tokens}});
    if let Some(temperature) = options.temperature {
        body["generationConfig"]["temperature"] = json!(temperature);
    }
    // The agent's streaming Flash contract disables thinking. Workflow JSON
    // calls retain provider defaults, including models predating thinkingConfig.
    if options.stream && !options.model.contains("pro") {
        body["generationConfig"]["thinkingConfig"] = json!({"thinkingBudget":0});
    }
    if let Some(system) = options.system_prompt.as_deref().filter(|s| !s.is_empty()) {
        body["systemInstruction"] = json!({"parts":[{"text":system}]});
    }
    if options.google_search {
        body["tools"] = json!([{"googleSearch":{}}]);
    }
    body
}
fn gemini_parts(value: &Value, full: &mut String, emit: &mut impl FnMut(Delta), separate: bool) {
    let Some(parts) = value["candidates"][0]["content"]["parts"].as_array() else {
        return;
    };
    for part in parts {
        let Some(text) = part["text"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if part["thought"].as_bool() == Some(true) {
            emit(Delta::Thinking(text.into()));
        } else {
            if separate && !full.is_empty() {
                full.push('\n');
            }
            full.push_str(text);
            emit(Delta::Text(text.into()));
        }
    }
}
fn gemini_json(value: &Value, emit: &mut impl FnMut(Delta)) -> Result<String, String> {
    let candidate = value["candidates"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("Gemini API returned no candidate")?;
    if !candidate["content"].is_object() {
        return Err("Gemini API returned no candidate content".into());
    }
    let mut full = String::new();
    gemini_parts(value, &mut full, emit, true);
    // LangChain preserves non-text content instead of silently completing with
    // an empty answer (for example function calls, inline data, or thinking).
    let content: Vec<Value> = candidate["content"]["parts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|part| {
            if part["thought"] == true && part["text"].as_str().is_some_and(|s| !s.is_empty()) {
                let mut block = json!({"type":"thinking"});
                block["thinking"] = part["text"].clone();
                if part.get("thoughtSignature").is_some() {
                    block["signature"] = part["thoughtSignature"].clone();
                }
                return block;
            }
            for kind in [
                "text",
                "inlineData",
                "functionCall",
                "functionResponse",
                "fileData",
                "executableCode",
                "codeExecutionResult",
            ] {
                if let Some(value) = part.get(kind) {
                    let mut block = json!({"type":kind});
                    block[kind] = value.clone();
                    return block;
                }
            }
            part.clone()
        })
        .collect();
    let text = content
        .iter()
        .filter(|block| block["type"] == "text")
        .map(|block| block["text"].as_str().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    Ok(if text.is_empty() {
        Value::Array(content).to_string()
    } else {
        text
    })
}
struct Sse {
    pending: Vec<u8>,
    data: Vec<u8>,
    full: String,
}
impl Sse {
    fn new() -> Self {
        Self {
            pending: vec![],
            data: vec![],
            full: String::new(),
        }
    }
    fn event(&mut self, emit: &mut impl FnMut(Delta)) {
        if let Ok(value) = serde_json::from_slice::<Value>(&self.data) {
            gemini_parts(&value, &mut self.full, emit, false);
        }
        self.data.clear();
    }
    fn line(&mut self, emit: &mut impl FnMut(Delta)) -> io::Result<()> {
        let line = self.pending.strip_suffix(b"\r").unwrap_or(&self.pending);
        if line.is_empty() {
            self.event(emit);
        } else if let Some(data) = line.strip_prefix(b"data:") {
            // Node accepts complete data lines without requiring blank event separators.
            // Try each complete JSON record first; accumulate incomplete multi-line events.
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if let Ok(value) = serde_json::from_slice::<Value>(data) {
                self.event(emit);
                gemini_parts(&value, &mut self.full, emit, false);
            } else if data != b"[DONE]" {
                append(&mut self.data, data, LINE_LIMIT)?;
                append(&mut self.data, b"\n", LINE_LIMIT)?;
            }
        }
        self.pending.clear();
        Ok(())
    }
    fn push(&mut self, bytes: &[u8], emit: &mut impl FnMut(Delta)) -> io::Result<()> {
        for part in bytes.split_inclusive(|byte| *byte == b'\n') {
            append(&mut self.pending, part, LINE_LIMIT)?;
            if self.pending.last() == Some(&b'\n') {
                self.pending.pop();
                self.line(emit)?;
            }
        }
        Ok(())
    }
    fn finish(mut self, emit: &mut impl FnMut(Delta)) -> io::Result<String> {
        if !self.pending.is_empty() {
            self.line(emit)?;
        }
        self.event(emit);
        Ok(self.full.trim().into())
    }
}

pub async fn gemini(
    key: &str,
    prompt: &str,
    options: &GeminiOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    gemini_request(
        configured_gemini_base()?,
        key,
        prompt,
        options,
        cancel,
        emit,
    )
    .await
}

fn configured_gemini_base() -> Result<reqwest::Url, String> {
    let override_base = std::env::var("COCKPIT_PREVIEW_GEMINI_BASE")
        .map(Some)
        .or_else(|error| match error {
            std::env::VarError::NotPresent => Ok(None),
            _ => Err("Invalid private Gemini endpoint".to_string()),
        })?;
    gemini_base(override_base.as_deref())
}

pub async fn gemini_utf16(
    key: &str,
    prompt: &crate::board_value::V,
    options: &GeminiOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    gemini_request_body(
        configured_gemini_base()?,
        key,
        gemini_utf16_body(prompt, options),
        options,
        cancel,
        emit,
    )
    .await
}

fn gemini_utf16_body(
    prompt: &crate::board_value::V,
    options: &GeminiOptions,
) -> Box<serde_json::value::RawValue> {
    use crate::board_value::{object, V};
    let mut body: crate::json_values::Object =
        serde_json::from_str(&gemini_body("", options).to_string()).unwrap();
    body.insert(
        "contents".into(),
        V::Array(vec![object([
            ("role", "user".into()),
            ("parts", V::Array(vec![object([("text", prompt.clone())])])),
        ])])
        .raw(),
    );
    serde_json::value::to_raw_value(&body).unwrap()
}
pub async fn gemini_prompts_utf16(
    key: &str,
    prompt: &crate::board_value::V,
    system: &crate::board_value::V,
    options: &GeminiOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    use crate::board_value::{object, V};
    let mut body: crate::json_values::Object =
        serde_json::from_str(gemini_utf16_body(prompt, options).get()).unwrap();
    if system.truthy() {
        body.insert(
            "systemInstruction".into(),
            object([("parts", V::Array(vec![object([("text", system.clone())])]))]).raw(),
        );
    } else {
        body.remove("systemInstruction");
    }
    gemini_request_body(
        configured_gemini_base()?,
        key,
        serde_json::value::to_raw_value(&body).unwrap(),
        options,
        cancel,
        emit,
    )
    .await
}
async fn gemini_request(
    base: reqwest::Url,
    key: &str,
    prompt: &str,
    options: &GeminiOptions,
    cancel: &Cancel,
    emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    gemini_request_body(
        base,
        key,
        serde_json::value::to_raw_value(&gemini_body(prompt, options)).unwrap(),
        options,
        cancel,
        emit,
    )
    .await
}
async fn gemini_request_body(
    base: reqwest::Url,
    key: &str,
    body: Box<serde_json::value::RawValue>,
    options: &GeminiOptions,
    cancel: &Cancel,
    mut emit: impl FnMut(Delta) + Send,
) -> Result<String, String> {
    if cancel.is_cancelled() {
        return Err("AI request cancelled".into());
    }
    if key.is_empty() {
        return Err("Gemini API key not configured".into());
    }
    if options.model.is_empty()
        || !options
            .model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err("Invalid Gemini model".into());
    }
    let action = if options.stream {
        "streamGenerateContent"
    } else {
        "generateContent"
    };
    let mut url = base
        .join(&format!("/v1beta/models/{}:{action}", options.model))
        .map_err(|_| "Invalid Gemini model")?;
    if options.stream {
        url.query_pairs_mut().append_pair("alt", "sse");
    }
    url.query_pairs_mut().append_pair("key", key);
    let encoded_key: String = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("key", key)
        .finish()
        .strip_prefix("key=")
        .unwrap()
        .into();
    let operation = async {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
            .map_err(|_| "Gemini API request failed")?;
        let mut response = client
            .post(url)
            .json(&body)
            .send()
            .await
            .map_err(|_| "Gemini API request failed")?;
        let status = response.status();
        let mut bytes = vec![];
        let mut sse = Sse::new();
        let mut total = 0usize;
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Gemini API response failed")?
        {
            total = total
                .checked_add(chunk.len())
                .ok_or("AI response exceeded output limit")?;
            if total > OUTPUT_LIMIT {
                return Err("AI response exceeded output limit".to_owned());
            }
            if status.is_success() && options.stream {
                sse.push(&chunk, &mut emit)
                    .map_err(|error| error.to_string())?;
            } else {
                append(&mut bytes, &chunk, OUTPUT_LIMIT).map_err(|error| error.to_string())?;
            }
        }
        if !status.is_success() {
            let text = String::from_utf8_lossy(&bytes)
                .replace(key, "[redacted]")
                .replace(&encoded_key, "[redacted]");
            let prefix: String = text.chars().take(300).collect();
            return Err(format!("Gemini API {}: {prefix}", status.as_u16()));
        }
        if options.stream {
            return sse.finish(&mut emit).map_err(|error| error.to_string());
        }
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "Invalid Gemini API response")?;
        gemini_json(&value, &mut emit)
    };
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("AI request cancelled".into()),
        result = tokio::time::timeout(options.timeout, operation) => result.unwrap_or_else(|_| Err("Gemini API request timed out".into())),
    }
}
