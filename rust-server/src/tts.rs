//! Request-owned Edge speech synthesis. No socket or audio buffer is shared.
use crate::{agent_prompt::string, ai_transport::Cancel, board_value::V};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{client::IntoClientRequest, protocol::WebSocketConfig, Message},
};

const ENDPOINT: &str =
    "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1";
// Public Edge protocol constant, not a user credential.
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0";
const ORIGIN: &str = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const AUDIO_LIMIT: usize = 4 * 1024 * 1024;
const HEADER_LIMIT: usize = 8192;
const TIMEOUT: Duration = Duration::from_secs(10);

pub fn prepare_text(text: &V) -> Result<V, String> {
    if !text.truthy() {
        return Err("text required".into());
    }
    if !text.is_string() {
        return Err("text must be a string".into());
    }
    Ok(text.cut(800))
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn sec_ms_gec(now_ms: i64) -> String {
    let ticks = now_ms.div_euclid(1000) as i128 + 11_644_473_600i128;
    let windows_ticks = (ticks - ticks % 300) * 10_000_000;
    let decimal = string(&V::Number(windows_ticks as f64))
        .expect("number is stringable")
        .text();
    hex(&Sha256::digest(format!("{decimal}{TRUSTED_CLIENT_TOKEN}"))).to_uppercase()
}
fn connection_id() -> String {
    let mut bytes = rand::random::<[u8; 16]>();
    // The installed client fixes only the variant, not the UUID version nibble.
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let id = hex(&bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &id[..8],
        &id[8..12],
        &id[12..16],
        &id[16..20],
        &id[20..]
    )
}
fn synth_url(now_ms: i64, connection_id: &str) -> String {
    format!("{ENDPOINT}?TrustedClientToken={TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId={connection_id}", sec_ms_gec(now_ms))
}
fn configuration() -> String {
    let body = serde_json::json!({"context":{"synthesis":{"audio":{
        "metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},
        "outputFormat":"audio-24khz-48kbitrate-mono-mp3"
    }}}});
    format!("Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{body}")
}
fn ssml_request(text: &V, request_id: &str) -> String {
    // Input is plain text. Escaping fixes the old route's SSML injection while
    // preserving the original UTF-16 slice and UTF-8 replacement on the wire.
    let escaped = text
        .text()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;");
    format!("X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version=\"1.0\" xmlns=\"http://www.w3.org/2001/10/synthesis\" xmlns:mstts=\"https://www.w3.org/2001/mstts\" xml:lang=\"ko-KR\">\n                <voice name=\"ko-KR-SunHiNeural\">\n                    <prosody pitch=\"+0Hz\" rate=\"1\" volume=\"100\">\n                        {escaped}\n                    </prosody> \n                </voice>\n            </speak>")
}
fn preview_url(endpoint: &str) -> Result<String, String> {
    let url = url::Url::parse(endpoint).map_err(|_| "Invalid TTS preview endpoint")?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err("TTS preview endpoint must be ws://127.0.0.1:port".into());
    }
    Ok(url.into())
}

pub async fn synthesize(text: &V, cancel: &Cancel) -> Result<Vec<u8>, String> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "Invalid system clock")?
        .as_millis() as i64;
    synthesize_at(text, &synth_url(now_ms, &connection_id()), cancel, TIMEOUT).await
}
/// The HTTP adapter may use this only in its isolated preview mode.
pub async fn synthesize_preview(
    text: &V,
    endpoint: &str,
    cancel: &Cancel,
) -> Result<Vec<u8>, String> {
    synthesize_at(text, &preview_url(endpoint)?, cancel, TIMEOUT).await
}
async fn synthesize_at(
    text: &V,
    endpoint: &str,
    cancel: &Cancel,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let text = prepare_text(text)?;
    let request_id = hex(&rand::random::<[u8; 16]>());
    // This future owns connect, handshake, sends, reads and the close. Dropping
    // it on cancellation, timeout or an aborted caller closes the owned socket.
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("TTS cancelled".into()),
        result = tokio::time::timeout(timeout, exchange(endpoint, &text, &request_id)) =>
            result.map_err(|_| "TTS stream timeout".to_owned())?,
    }
}
fn protocol_error(detail: &str) -> String {
    format!("TTS protocol error: {detail}")
}
struct Headers<'a> {
    path: &'a str,
    content_type: Option<&'a str>,
}
fn headers<'a>(bytes: &'a [u8], request_id: &str) -> Result<Headers<'a>, String> {
    if bytes.len() > HEADER_LIMIT {
        return Err(protocol_error("headers exceed limit"));
    }
    let text = std::str::from_utf8(bytes).map_err(|_| protocol_error("invalid header encoding"))?;
    if !text.ends_with("\r\n") {
        return Err(protocol_error("unterminated headers"));
    }
    let mut id = None;
    let mut path = None;
    let mut content_type = None;
    for line in text.trim_end_matches("\r\n").split("\r\n") {
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| protocol_error("invalid header"))?;
        let target = if key.eq_ignore_ascii_case("X-RequestId") {
            &mut id
        } else if key.eq_ignore_ascii_case("Path") {
            &mut path
        } else if key.eq_ignore_ascii_case("Content-Type") {
            &mut content_type
        } else {
            continue;
        };
        if target.replace(value.trim()).is_some() {
            return Err(protocol_error("duplicate header"));
        }
    }
    let id = id.ok_or_else(|| protocol_error("missing request ID"))?;
    if !id.eq_ignore_ascii_case(request_id) {
        return Err(protocol_error("request ID mismatch"));
    }
    Ok(Headers {
        path: path.ok_or_else(|| protocol_error("missing path"))?,
        content_type,
    })
}
enum Packet<'a> {
    Ignore,
    Audio(&'a [u8]),
    End,
}
fn text_packet<'a>(text: &'a str, request_id: &str) -> Result<Packet<'a>, String> {
    let end = text.find("\r\n\r\n").map_or(text.len(), |i| i + 2);
    let head = headers(&text.as_bytes()[..end], request_id)?;
    match head.path {
        "turn.start" | "response" | "audio.metadata" => Ok(Packet::Ignore),
        "turn.end" => Ok(Packet::End),
        _ => Err(protocol_error("unexpected text path")),
    }
}
fn binary_packet<'a>(bytes: &'a [u8], request_id: &str) -> Result<Packet<'a>, String> {
    if bytes.len() < 2 {
        return Err(protocol_error("missing binary header length"));
    }
    let length = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
    let end = 2 + length;
    let head = headers(
        bytes
            .get(2..end)
            .ok_or_else(|| protocol_error("truncated binary headers"))?,
        request_id,
    )?;
    let data = &bytes[end..];
    let valid_type =
        head.content_type == Some("audio/mpeg") || head.content_type.is_none() && data.is_empty();
    if head.path != "audio" || !valid_type {
        return Err(protocol_error("unexpected binary audio type"));
    }
    Ok(Packet::Audio(data))
}
async fn exchange(endpoint: &str, text: &V, request_id: &str) -> Result<Vec<u8>, String> {
    let mut request = endpoint
        .into_client_request()
        .map_err(|_| "Invalid TTS endpoint")?;
    request
        .headers_mut()
        .insert("User-Agent", USER_AGENT.parse().unwrap());
    request
        .headers_mut()
        .insert("Origin", ORIGIN.parse().unwrap());
    let config = WebSocketConfig::default()
        .read_buffer_size(16 * 1024)
        .max_message_size(Some(AUDIO_LIMIT + HEADER_LIMIT + 2))
        .max_frame_size(Some(AUDIO_LIMIT + HEADER_LIMIT + 2))
        .max_write_buffer_size(64 * 1024)
        .write_buffer_size(0);
    // connect_async_with_config performs one handshake and does not follow HTTP redirects.
    let (mut socket, _) = connect_async_with_config(request, Some(config), false)
        .await
        .map_err(|e| format!("TTS connection failed: {e}"))?;
    socket
        .send(Message::Text(configuration().into()))
        .await
        .map_err(|e| format!("TTS send failed: {e}"))?;
    socket
        .send(Message::Text(ssml_request(text, request_id).into()))
        .await
        .map_err(|e| format!("TTS send failed: {e}"))?;
    let mut audio = Vec::new();
    while let Some(message) = socket.next().await {
        let message = message.map_err(|e| format!("TTS receive failed: {e}"))?;
        let packet = match &message {
            Message::Text(text) => text_packet(text, request_id)?,
            Message::Binary(bytes) => binary_packet(bytes, request_id)?,
            Message::Ping(_) => {
                socket
                    .flush()
                    .await
                    .map_err(|e| format!("TTS pong failed: {e}"))?;
                continue;
            }
            Message::Pong(_) => continue,
            Message::Close(_) => return Err("TTS connection closed before turn.end".into()),
            _ => return Err(protocol_error("unexpected websocket frame")),
        };
        match packet {
            Packet::Ignore => {}
            Packet::Audio(chunk) => {
                if chunk.len() > AUDIO_LIMIT.saturating_sub(audio.len()) {
                    return Err("TTS audio exceeds 4 MiB limit".into());
                }
                audio.extend_from_slice(chunk);
            }
            Packet::End => {
                if audio.is_empty() {
                    return Err("No audio data received".into());
                }
                let _ = socket.close(None).await;
                return Ok(audio);
            }
        }
    }
    Err("TTS connection closed before turn.end".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;
    use tokio::{io::AsyncReadExt, net::TcpListener, sync::oneshot};
    use tokio_tungstenite::{accept_async, accept_hdr_async};
    const ID: &str = "000102030405060708090a0b0c0d0e0f";
    fn value(text: &str) -> V {
        V::parse(&serde_json::from_str::<Box<serde_json::value::RawValue>>(text).unwrap()).unwrap()
    }
    fn packet_value(packet: Packet<'_>) -> V {
        match packet {
            Packet::Ignore => object([("kind", "ignore".into())]),
            Packet::End => object([("kind", "end".into())]),
            Packet::Audio(bytes) => object([("kind", "audio".into()), ("hex", hex(bytes).into())]),
        }
    }
    #[test]
    fn original_hash_messages_and_utf16_fixtures() {
        let fixtures = value(include_str!("../../tests/fixtures/rust-tts.json"));
        for fixture in fixtures["hashes"].array() {
            assert_eq!(
                sec_ms_gec(fixture["now"].number() as i64),
                fixture["expected"].text()
            );
        }
        for fixture in fixtures["requests"].array() {
            let actual = match prepare_text(&fixture["input"]) {
                Ok(prepared) => object([
                    ("prepared", prepared.clone()),
                    ("ssml", ssml_request(&prepared, ID).into()),
                ]),
                Err(error) => object([("error", error.into())]),
            };
            assert_eq!(actual, fixture["expected"], "{}", fixture["name"].text());
        }
        let config = configuration();
        let (headers, body) = config.split_once("\r\n\r\n").unwrap();
        assert_eq!(headers, fixtures["protocol"]["configHeaders"].text());
        assert_eq!(value(body), fixtures["protocol"]["configBody"]);
        assert_eq!(USER_AGENT, fixtures["protocol"]["userAgent"].text());
        assert_eq!(ORIGIN, fixtures["protocol"]["origin"].text());
        assert_eq!(
            synth_url(
                fixtures["protocol"]["now"].number() as i64,
                &fixtures["protocol"]["connectionId"].text()
            ),
            fixtures["protocol"]["url"].text()
        );
        for fixture in fixtures["frames"].array() {
            let result = if fixture["type"].text() == "text" {
                text_packet(&fixture["data"].text(), ID).map(packet_value)
            } else {
                let bytes: Vec<u8> = fixture["data"]
                    .array()
                    .iter()
                    .map(|v| v.number() as u8)
                    .collect();
                binary_packet(&bytes, ID).map(packet_value)
            };
            let actual = result.unwrap_or_else(|error| object([("error", error.into())]));
            assert_eq!(actual, fixture["expected"], "{}", fixture["name"].text());
        }
    }
    fn binary(id: &str, data: &[u8]) -> Message {
        let header = format!("X-RequestId:{id}\r\nContent-Type:audio/mpeg\r\nPath:audio\r\n");
        let mut bytes = (header.len() as u16).to_be_bytes().to_vec();
        bytes.extend(header.as_bytes());
        bytes.extend(data);
        Message::Binary(bytes.into())
    }
    fn control(id: &str, path: &str) -> Message {
        Message::Text(format!("X-RequestId:{id}\r\nPath:{path}\r\n\r\n{{}}").into())
    }
    async fn listener() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!(
            "ws://127.0.0.1:{}/fixture",
            listener.local_addr().unwrap().port()
        );
        (listener, endpoint)
    }
    async fn receive_request(
        socket: &mut tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) -> String {
        let config = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(config.starts_with(
            "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n"
        ));
        let ssml = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(ssml.contains("ko-KR-SunHiNeural"));
        assert!(ssml.contains("<prosody pitch=\"+0Hz\" rate=\"1\" volume=\"100\">"));
        ssml.split_once("\r\n")
            .unwrap()
            .0
            .strip_prefix("X-RequestId:")
            .unwrap()
            .into()
    }
    #[tokio::test]
    async fn concurrent_requests_keep_audio_and_socket_ownership_separate() {
        let (listener, endpoint) = listener().await;
        let server = tokio::spawn(async move {
            let mut workers = vec![];
            for _ in 0..2 {
                let (stream, _) = listener.accept().await.unwrap();
                workers.push(tokio::spawn(async move {
                    let mut socket = accept_hdr_async(
                        stream,
                        |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                         response| {
                            assert_eq!(request.headers()["User-Agent"], USER_AGENT);
                            assert_eq!(request.headers()["Origin"], ORIGIN);
                            Ok(response)
                        },
                    )
                    .await
                    .unwrap();
                    let id = receive_request(&mut socket).await;
                    socket.send(control(&id, "turn.start")).await.unwrap();
                    socket.send(Message::Ping(vec![1, 2].into())).await.unwrap();
                    socket.send(binary(&id, b"ID3fixture")).await.unwrap();
                    socket.send(binary(&id, id.as_bytes())).await.unwrap();
                    socket.send(control(&id, "turn.end")).await.unwrap();
                    // Keep the fixture peer alive while the client flushes its
                    // pong and close, so unread data cannot cause a TCP reset.
                    while let Some(Ok(message)) = socket.next().await {
                        if matches!(message, Message::Close(_)) {
                            break;
                        }
                    }
                    id
                }));
            }
            let first = workers.remove(0).await.unwrap();
            let second = workers.remove(0).await.unwrap();
            assert_ne!(first, second);
            [first, second]
        });
        let cancel = Cancel::default();
        let text = V::from("테스트 <voice> & 확인");
        let (first, second) = tokio::join!(
            synthesize_preview(&text, &endpoint, &cancel),
            synthesize_preview(&text, &endpoint, &cancel)
        );
        let mut outputs = [first.unwrap(), second.unwrap()];
        outputs.sort();
        let mut expected = server
            .await
            .unwrap()
            .map(|id| format!("ID3fixture{id}").into_bytes());
        expected.sort();
        assert_eq!(outputs, expected);
    }
    #[tokio::test]
    async fn rejects_partial_empty_foreign_and_oversized_audio() {
        for mode in ["partial", "empty", "foreign", "bad-header", "too-large"] {
            let (listener, endpoint) = listener().await;
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = accept_async(stream).await.unwrap();
                let id = receive_request(&mut socket).await;
                match mode {
                    "partial" => {
                        socket.send(binary(&id, b"ID3partial")).await.unwrap();
                        let _ = socket.close(None).await;
                    }
                    "empty" => {
                        socket.send(control(&id, "turn.end")).await.unwrap();
                    }
                    "foreign" => {
                        socket
                            .send(binary("ffffffffffffffffffffffffffffffff", b"ID3foreign"))
                            .await
                            .unwrap();
                    }
                    "bad-header" => {
                        socket
                            .send(Message::Binary(vec![0, 255, 1].into()))
                            .await
                            .unwrap();
                    }
                    "too-large" => {
                        socket
                            .send(binary(&id, &vec![0; AUDIO_LIMIT]))
                            .await
                            .unwrap();
                        let _ = socket.send(binary(&id, b"x")).await;
                    }
                    _ => unreachable!(),
                }
            });
            let error = synthesize_preview(&"test".into(), &endpoint, &Cancel::default())
                .await
                .unwrap_err();
            let expected = match mode {
                "partial" => "TTS connection closed before turn.end",
                "empty" => "No audio data received",
                "foreign" => "TTS protocol error: request ID mismatch",
                "bad-header" => "TTS protocol error: truncated binary headers",
                _ => "TTS audio exceeds 4 MiB limit",
            };
            assert_eq!(error, expected, "{mode}");
            server.await.unwrap();
        }
    }
    #[tokio::test]
    async fn cancellation_drop_and_deadline_close_connecting_and_active_sockets() {
        for handshake in [false, true] {
            for mode in ["cancel", "drop", "timeout"] {
                let (listener, endpoint) = listener().await;
                let (ready, started) = oneshot::channel();
                let server = tokio::spawn(async move {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    if handshake {
                        let mut socket = accept_async(stream).await.unwrap();
                        receive_request(&mut socket).await;
                        ready.send(()).unwrap();
                        let close = tokio::time::timeout(Duration::from_secs(2), socket.next())
                            .await
                            .unwrap();
                        assert!(matches!(
                            close,
                            None | Some(Err(_)) | Some(Ok(Message::Close(_)))
                        ));
                    } else {
                        ready.send(()).unwrap();
                        tokio::time::timeout(Duration::from_secs(2), async {
                            let mut buffer = [0; 4096];
                            loop {
                                if stream.read(&mut buffer).await.unwrap_or(0) == 0 {
                                    break;
                                }
                            }
                        })
                        .await
                        .unwrap();
                    }
                });
                let cancel = Cancel::default();
                let child = cancel.child();
                let task = tokio::spawn(async move {
                    synthesize_at(
                        &"fixture".into(),
                        &endpoint,
                        &child,
                        if mode == "timeout" {
                            Duration::from_millis(150)
                        } else {
                            TIMEOUT
                        },
                    )
                    .await
                });
                started.await.unwrap();
                if mode == "drop" {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                } else {
                    if mode == "cancel" {
                        cancel.cancel();
                    }
                    let error = task.await.unwrap().unwrap_err();
                    assert_eq!(
                        error,
                        if mode == "timeout" {
                            "TTS stream timeout"
                        } else {
                            "TTS cancelled"
                        }
                    );
                }
                server.await.unwrap();
            }
        }
        assert_eq!(TIMEOUT, Duration::from_secs(10));
    }
    #[test]
    fn preview_endpoint_never_accepts_external_or_authenticated_urls() {
        assert!(preview_url("ws://127.0.0.1:41234/fixture").is_ok());
        for endpoint in [
            "wss://127.0.0.1:41234",
            "ws://localhost:41234",
            "ws://[::1]:41234",
            "ws://example.com:41234",
            "ws://127.0.0.1",
            "ws://user@127.0.0.1:41234",
            "ws://127.0.0.1:41234/#fragment",
        ] {
            assert!(preview_url(endpoint).is_err(), "{endpoint}");
        }
    }
}
