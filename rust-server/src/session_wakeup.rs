use crate::{account_usage::now, terminals};
use axum::{
    body::{to_bytes, Body},
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{stream, StreamExt};
use ring::hmac;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct Rule {
    enabled: bool,
    after_seconds: u64,
    url: String,
    secret: String,
}
impl Default for Rule {
    fn default() -> Self {
        Self {
            enabled: false,
            after_seconds: 600,
            url: String::new(),
            secret: String::new(),
        }
    }
}
impl Rule {
    fn validate(&self) -> Result<(), String> {
        if !(1..=86_400).contains(&self.after_seconds) {
            return Err("대기 시간은 1초부터 24시간까지 설정하세요.".into());
        }
        if self.secret.len() > 512 || (!self.secret.is_empty() && self.secret.len() < 16) {
            return Err("서명 키는 16~512자로 입력하세요.".into());
        }
        if self.url.is_empty() && !self.enabled {
            return Ok(());
        }
        let url = url::Url::parse(&self.url).map_err(|_| "올바른 웹훅 주소를 입력하세요.")?;
        if self.url.len() > 2048
            || !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
        {
            return Err("인증 정보나 #조각이 없는 HTTP(S) 웹훅 주소를 입력하세요.".into());
        }
        Ok(())
    }
}
#[derive(Default)]
struct Observation {
    incarnation: String,
    since: i64,
    next_attempt: i64,
    last_attempt: i64,
    last_sent: i64,
    error: String,
}
impl Observation {
    fn due(&mut self, rule: &Rule, activity: &Value, time: i64) -> bool {
        if !rule.enabled {
            return false;
        }
        let incarnation = activity["incarnation"].as_str().unwrap_or("");
        if self.incarnation != incarnation {
            *self = Self {
                incarnation: incarnation.into(),
                ..Default::default()
            };
        }
        if activity["state"] == "busy" {
            self.since = 0;
            self.next_attempt = 0;
            return false;
        }
        if self.since == 0 {
            self.since = time;
        }
        if time < self.next_attempt
            || time.saturating_sub(self.since) < rule.after_seconds as i64 * 1000
        {
            return false;
        }
        self.last_attempt = time;
        self.next_attempt = time + 30_000;
        true
    }
}
#[derive(Default)]
struct State {
    rules: BTreeMap<String, Rule>,
    observations: BTreeMap<String, Observation>,
}
pub struct Store {
    path: PathBuf,
    state: Mutex<State>,
    client: reqwest::Client,
}
impl Store {
    pub fn new(directory: PathBuf) -> io::Result<Self> {
        let path = directory.join("session-wakeup.json");
        let rules: BTreeMap<String, Rule> = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => BTreeMap::new(),
            Ok(meta) if meta.is_file() && meta.len() <= 262_144 => {
                serde_json::from_slice(&fs::read(&path)?)?
            }
            _ => return Err(io::Error::other("Invalid session wakeup configuration")),
        };
        if rules.len() > 64 || rules.values().any(|rule| rule.validate().is_err()) {
            return Err(io::Error::other("Invalid session wakeup rules"));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(io::Error::other)?;
        Ok(Self {
            path,
            state: Mutex::new(State {
                rules,
                ..Default::default()
            }),
            client,
        })
    }
    fn public(&self, id: &str) -> Value {
        let state = self.state.lock().unwrap();
        let rule = state.rules.get(id).cloned().unwrap_or_default();
        let mut out = json!({"enabled":rule.enabled,"afterSeconds":rule.after_seconds,"url":rule.url,"secretConfigured":!rule.secret.is_empty()});
        if let Some(observation) = state.observations.get(id) {
            out["lastAttemptAt"] = json!(observation.last_attempt);
            out["lastSentAt"] = json!(observation.last_sent);
            out["lastError"] = json!(observation.error);
            out["waitingSince"] = json!(observation.since);
        }
        out
    }
    fn save(&self, id: &str, input: Value) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        let mut rule: Rule =
            serde_json::from_value(input.clone()).map_err(|_| "설정 값 형식을 확인하세요.")?;
        if !input.get("secret").is_some_and(Value::is_string) {
            rule.secret = state
                .rules
                .get(id)
                .map(|r| r.secret.clone())
                .unwrap_or_default();
        }
        rule.validate()?;
        let mut rules = state.rules.clone();
        rules.insert(id.into(), rule);
        if rules.len() > 64 {
            return Err("최대 64개 세션까지 감시할 수 있습니다.".into());
        }
        if fs::symlink_metadata(&self.path).is_ok_and(|m| !m.is_file()) {
            return Err("설정 저장 경로를 확인하세요.".into());
        }
        let mut file = tempfile::NamedTempFile::new_in(self.path.parent().unwrap())
            .map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&rules).map_err(|e| e.to_string())?)
            .and_then(|_| file.flush())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        fs::File::open(self.path.parent().unwrap())
            .and_then(|f| f.sync_all())
            .map_err(|e| e.to_string())?;
        state.rules = rules;
        state.observations.remove(id);
        Ok(())
    }
    pub async fn tick(&self, terminals: Arc<terminals::Store>) {
        let rules: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .rules
            .iter()
            .filter(|(_, rule)| rule.enabled)
            .map(|(id, rule)| (id.clone(), rule.clone()))
            .collect();
        stream::iter(rules)
            .for_each_concurrent(4, |(id, rule)| self.tick_rule(id, rule, terminals.clone()))
            .await;
    }
    async fn tick_rule(&self, id: String, rule: Rule, terminals: Arc<terminals::Store>) {
        let observed_id = id.clone();
        let store = terminals.clone();
        let Ok(Some(activity)) =
            tokio::task::spawn_blocking(move || store.wakeup_observation(&observed_id)).await
        else {
            self.state.lock().unwrap().observations.remove(&id);
            return;
        };
        let time = now();
        let payload = {
            let mut state = self.state.lock().unwrap();
            if state.rules.get(&id) != Some(&rule) {
                return;
            }
            let observation = state.observations.entry(id.clone()).or_default();
            if !observation.due(&rule, &activity, time) {
                return;
            }
            json!({"event_type":"cockpit.session_stalled","id":format!("{}:{}:{}:{}",id,observation.incarnation,observation.since,observation.last_sent),"observedAt":time,"waitingSince":observation.since,"session":activity})
        };
        let result = self.post(&rule, &payload, time).await;
        let mut state = self.state.lock().unwrap();
        if state.rules.get(&id) != Some(&rule) {
            return;
        }
        if let Some(observation) = state.observations.get_mut(&id) {
            match result {
                Ok(()) => {
                    observation.last_sent = now();
                    observation.next_attempt =
                        observation.last_sent + rule.after_seconds as i64 * 1000;
                    observation.error.clear();
                }
                Err(error) => {
                    observation.error = error;
                    observation.next_attempt = now() + 30_000;
                }
            }
        }
    }
    async fn post(&self, rule: &Rule, payload: &Value, time: i64) -> Result<(), String> {
        let body = payload.to_string();
        let timestamp = (time / 1000).to_string();
        let mut request = self
            .client
            .post(&rule.url)
            .header("Content-Type", "application/json")
            .header("X-Webhook-Id", payload["id"].as_str().unwrap())
            .header("X-Request-ID", payload["id"].as_str().unwrap());
        if !rule.secret.is_empty() {
            let key = hmac::Key::new(hmac::HMAC_SHA256, rule.secret.as_bytes());
            let signature = hmac::sign(&key, format!("{timestamp}.{body}").as_bytes())
                .as_ref()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>();
            request = request
                .header("X-Webhook-Timestamp", timestamp)
                .header("X-Webhook-Signature-V2", signature);
        }
        match request.body(body).send().await {
            Ok(response) if response.status().is_success() => Ok(()),
            Ok(response) => Err(format!(
                "HTTP {} · 30초 후 재시도",
                response.status().as_u16()
            )),
            Err(_) => Err(
                "웹훅 연결 실패 · 주소와 PM 실행 상태를 확인하세요. 30초 후 재시도합니다.".into(),
            ),
        }
    }
}
pub fn route<'a>(method: &Method, path: &'a str) -> Option<&'a str> {
    if *method != Method::GET && *method != Method::PUT {
        return None;
    }
    path.strip_prefix("/api/terminals/")?
        .strip_suffix("/wakeup")
        .filter(|id| !id.is_empty() && !id.contains('/'))
}
pub async fn handle(
    app: Arc<crate::App>,
    method: &Method,
    id: &str,
    body: Body,
    local: bool,
) -> Response {
    if !local {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"PM 깨우기 설정은 로컬에서만 관리할 수 있습니다."})),
        )
            .into_response();
    }
    let Some((terminal, _)) = app.terminals.reference(id, false) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"error":"세션을 찾지 못했습니다."})),
        )
            .into_response();
    };
    let id = terminal["termId"].as_str().unwrap_or(id);
    if *method == Method::PUT {
        let input = match to_bytes(body, 8192)
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        {
            Some(value) => value,
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({"error":"설정 값 형식을 확인하세요."})),
                )
                    .into_response()
            }
        };
        let store = app.clone();
        let key = id.to_owned();
        match tokio::task::spawn_blocking(move || store.session_wakeup.save(&key, input)).await {
            Ok(Ok(())) => {}
            _ => return (
                StatusCode::BAD_REQUEST,
                Json(
                    json!({"error":"설정을 저장하지 못했습니다. 시간·주소·서명 키를 확인하세요."}),
                ),
            )
                .into_response(),
        }
    }
    Json(app.session_wakeup.public(id)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn real_http_post_uses_stable_event_id_and_timestamp_bound_hmac() {
        use std::io::{BufRead, BufReader, Read};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                headers.push_str(&line);
                if line == "\r\n" {
                    break;
                }
            }
            let length = headers
                .lines()
                .find_map(|line| {
                    line.to_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                })
                .unwrap();
            let mut body = vec![0; length];
            reader.read_exact(&mut body).unwrap();
            drop(reader);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nOK")
                .unwrap();
            (headers.to_lowercase(), body)
        });
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into()).unwrap();
        let rule = Rule {
            enabled: true,
            url: format!("http://{address}/hook"),
            secret: "0123456789abcdef".into(),
            ..Default::default()
        };
        let payload = json!({"id":"event-1","event_type":"cockpit.session_stalled","session":{"state":"idle"}});
        store.post(&rule, &payload, 123_000).await.unwrap();
        let (headers, body) = server.join().unwrap();
        assert!(headers.starts_with("post /hook http/1.1"));
        assert!(headers.contains("x-webhook-id: event-1\r\n"));
        assert!(headers.contains("x-request-id: event-1\r\n"));
        assert!(headers.contains("x-webhook-timestamp: 123\r\n"));
        let signature = headers
            .lines()
            .find_map(|line| line.strip_prefix("x-webhook-signature-v2: "))
            .unwrap();
        let key = hmac::Key::new(hmac::HMAC_SHA256, rule.secret.as_bytes());
        let expected = hmac::sign(
            &key,
            format!("123.{}", String::from_utf8(body.clone()).unwrap()).as_bytes(),
        )
        .as_ref()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
        assert_eq!(signature, expected);
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), payload);
    }
    #[test]
    fn non_busy_changes_do_not_reset_timeout_and_busy_or_incarnation_do() {
        let rule = Rule {
            enabled: true,
            after_seconds: 10,
            url: "http://127.0.0.1/hook".into(),
            ..Default::default()
        };
        let mut observation = Observation::default();
        assert!(!observation.due(&rule, &json!({"state":"idle","incarnation":"a"}), 1_000));
        assert!(!observation.due(&rule, &json!({"state":"unknown","incarnation":"a"}), 10_999));
        assert!(observation.due(&rule, &json!({"state":"offline","incarnation":"a"}), 11_000));
        assert!(!observation.due(&rule, &json!({"state":"offline","incarnation":"a"}), 11_001));
        assert!(!observation.due(&rule, &json!({"state":"busy","incarnation":"a"}), 12_000));
        assert!(!observation.due(&rule, &json!({"state":"idle","incarnation":"a"}), 30_000));
        assert!(!observation.due(&rule, &json!({"state":"idle","incarnation":"b"}), 40_000));
    }
    #[test]
    fn settings_persist_without_exposing_secret_and_invalid_input_keeps_last_rule() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into()).unwrap();
        store.save("terminal",json!({"enabled":true,"afterSeconds":60,"url":"http://127.0.0.1/hook","secret":"0123456789abcdef"})).unwrap();
        assert!(!store
            .public("terminal")
            .to_string()
            .contains("0123456789abcdef"));
        assert!(store
            .save(
                "terminal",
                json!({"enabled":true,"afterSeconds":0,"url":"file:///etc/passwd"})
            )
            .is_err());
        assert_eq!(store.public("terminal")["afterSeconds"], 60);
        let reloaded = Store::new(directory.path().into()).unwrap();
        assert_eq!(reloaded.public("terminal")["secretConfigured"], true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(directory.path().join("session-wakeup.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
