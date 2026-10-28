use crate::board_value::V;
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs::{self, File},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const WEEK: i64 = 7 * 86_400_000;
const CLAUDE_USAGE: &str = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_TOKEN: &str = "https://platform.claude.com/v1/oauth/token";
const CODEX_USAGE: &str = "https://chatgpt.com/backend-api/wham/usage";
const CODEX_TOKEN: &str = "https://auth.openai.com/oauth/token";
#[derive(Default)]
struct Entry {
    usage: Value,
    refreshed: i64,
    running: bool,
    generation: u64,
    credential_stamp: Option<(u64, u128)>,
    rejected_stamp: Option<(u64, u128)>,
    forced: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageFailure {
    Login,
    Scope,
    Configuration,
    Permission,
    RateLimit,
    Network,
    Response,
    Storage,
}
impl UsageFailure {
    fn code(self) -> &'static str {
        match self {
            Self::Login => "login_required",
            Self::Scope => "scope_required",
            Self::Configuration => "configuration_error",
            Self::Permission => "permission_denied",
            Self::RateLimit => "rate_limited",
            Self::Network => "network_error",
            Self::Response => "provider_error",
            Self::Storage => "credential_unavailable",
        }
    }
}
async fn response_failure(response: reqwest::Response) -> UsageFailure {
    let status = response.status().as_u16();
    let body = response.json::<Value>().await.unwrap_or(Value::Null);
    let code = body["error"]
        .as_str()
        .or_else(|| body["error"]["type"].as_str())
        .unwrap_or("");
    match code {
        "invalid_grant" => UsageFailure::Login,
        "invalid_scope" => UsageFailure::Scope,
        "invalid_client" => UsageFailure::Configuration,
        _ => match status {
            401 => UsageFailure::Login,
            403 => UsageFailure::Permission,
            429 => UsageFailure::RateLimit,
            _ => UsageFailure::Response,
        },
    }
}
fn credential_stamp(provider: &str, home: &Path) -> Option<(u64, u128)> {
    let file = home.join(if provider == "claude" {
        ".credentials.json"
    } else {
        "auth.json"
    });
    file_stamp(&file)
}
fn file_stamp(file: &Path) -> Option<(u64, u128)> {
    let meta = fs::symlink_metadata(file).ok().filter(|m| m.is_file())?;
    Some((
        meta.len(),
        meta.modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{to_bytes, Body},
        extract::State,
        http::Request,
        response::IntoResponse,
        routing::any,
        Json, Router,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn transcript_windows_and_weekly_reset_match_existing_contract() {
        let root = tempfile::tempdir().unwrap();
        let time = date("2026-09-10T06:00:00.000Z").unwrap();
        let project = root.path().join("projects/demo");
        fs::create_dir_all(&project).unwrap();
        let file = project.join("s1.jsonl");
        fs::write(&file,[
            json!({"timestamp":"2026-09-10T05:00:00Z","message":{"usage":{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":999}}}),
            json!({"timestamp":"2026-09-10T02:00:00Z","message":{"usage":{"input_tokens":200,"output_tokens":100}}}),
            json!({"timestamp":"2026-09-08T00:00:00Z","message":{"usage":{"input_tokens":1000}}}),
            json!({"timestamp":"2026-08-20T00:00:00Z","message":{"usage":{"input_tokens":99999}}}),
        ].map(|v|v.to_string()).join("\n")).unwrap();
        let contents = fs::read_to_string(&file)
            .unwrap()
            .replace("\"message\":", "\"unrelated\":\"\\ud800\",\"message\":");
        fs::write(&file, contents).unwrap();
        let mut value = claude_local(root.path(), time);
        assert_eq!(value["cost"]["unpricedRequests"], 3);
        assert!(value["cost"]["weekUsd"].is_null());
        value.as_object_mut().unwrap().remove("cost");
        assert_eq!(
            value,
            json!({"provider":"claude","weeklyTokens":1450.0,"sessionTokens":450.0,
            "lastActiveAt":"2026-09-10T05:00:00.000Z","weeklyResetAt":"2026-09-15T00:00:00.000Z",
            "daily":[{"date":"2026-09-08","tokens":1000.0},{"date":"2026-09-10","tokens":450.0}]})
        );
        assert_eq!(
            next_week("2026-08-29T08:59:00+00:00", time),
            "2026-09-12T08:59:00.000Z"
        );
        assert_eq!(next_week("", time), "");
        fs::write(&file,json!({"timestamp":"2026-09-10T05:00:00Z","message":{"id":"cost-fixture","model":"claude-opus-5-5","usage":{"input_tokens":1000,"output_tokens":100,"cache_read_input_tokens":900}}}).to_string()).unwrap();
        assert!(
            (claude_local(root.path(), time)["cost"]["weekUsd"]
                .as_f64()
                .unwrap()
                - 0.00618)
                .abs()
                < 0.000001
        );
        let sessions = root.path().join("sessions/sub");
        fs::create_dir_all(&sessions).unwrap();
        let file = sessions.join("rollout.jsonl");
        fs::write(&file,format!("{}\ninvalid\n{}\n",json!({"payload":{"rate_limits":{"primary":{"used_percent":10,"window_minutes":10080}}}}),
            json!({"payload":{"rate_limits":{"primary":{"used_percent":40,"window_minutes":300,"resets_at":time/1000-60},"secondary":{"used_percent":25,"window_minutes":10080,"resets_at":time/1000+3600}}}}))).unwrap();
        let contents = fs::read_to_string(&file)
            .unwrap()
            .replace("\"payload\":", "\"unrelated\":\"\\udfff\",\"payload\":");
        fs::write(&file, contents).unwrap();
        let value = codex_local(root.path(), time);
        assert_eq!(
            value["limits"],
            json!({"weekly":{"remaining":75.0,"resetAt":"2026-09-10T07:00:00.000Z"},"session":{"remaining":100,"resetAt":""}})
        );
        assert_eq!(codex_local(&root.path().join("missing"), time), Value::Null);
        File::open(&file)
            .unwrap()
            .set_modified(UNIX_EPOCH + Duration::from_millis((time - WEEK - 1) as u64))
            .unwrap();
        assert_eq!(codex_local(root.path(), time), Value::Null);
    }
    struct Server {
        requests: Mutex<Vec<Value>>,
        claude: PathBuf,
        codex: PathBuf,
        fail: AtomicBool,
        replace_login: AtomicBool,
    }
    #[tokio::test]
    async fn native_quota_refresh_has_one_owner_and_never_refreshes_cli_tokens() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let state = Arc::new(Server {
            requests: Mutex::new(vec![]),
            claude: root.path().join(".credentials.json"),
            codex: root.path().join("auth.json"),
            fail: AtomicBool::new(false),
            replace_login: AtomicBool::new(false),
        });
        fs::write(&state.claude, "unrelated CLI credential").unwrap();
        fs::write(&state.codex, "unrelated CLI credential").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(any(mock)).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut store = Store::new();
        Arc::get_mut(&mut store).unwrap().urls =
            ["claude-usage", "claude-token", "codex-usage", "codex-token"]
                .map(|path| format!("{base}/{path}"));
        fs::create_dir(root.path().join("jcode-engine")).unwrap();
        let binary = root.path().join("jcode-engine/jcode");
        fs::write(
            &binary,
            r#"#!/usr/bin/python3
import os,json,pathlib,time,sys
assert os.environ['JCODE_ACCOUNT_ONLY']=='1'
assert os.environ['JCODE_EXPECTED_EMAIL']=='one@example.com'
assert 'OPENAI_API_KEY' not in os.environ
home=pathlib.Path(os.environ['JCODE_HOME'])
provider=sys.argv[sys.argv.index('--provider')+1]
claude=provider=='claude'
file=home/('auth.json' if claude else 'openai-auth.json')
value=json.loads(file.read_text())
account=value['anthropic_accounts' if claude else 'openai_accounts'][0]
account['access' if claude else 'access_token']='native-new'
account['expires' if claude else 'expires_at']=int(time.time()*1000)+3600000
file.write_text(json.dumps(value))
with (home/'refresh-calls').open('a') as f:f.write('refresh\n')
print('{"ok":true,"refreshed":true}')
"#,
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        for (provider, id) in [
            ("claude", "0123456789abcdef"),
            ("codex", "1123456789abcdef"),
        ] {
            let parent = root.path().join(id);
            fs::create_dir(&parent).unwrap();
            fs::set_permissions(&parent, fs::Permissions::from_mode(0o700)).unwrap();
            let profile = crate::native_account::Profile::new(
                root.path(),
                &parent,
                id,
                provider,
                "one@example.com",
            )
            .unwrap();
            profile.prepare(None).unwrap();
            let mut native: Value =
                serde_json::from_slice(&fs::read(profile.credential_file()).unwrap()).unwrap();
            let account = &mut native[if provider == "claude" {
                "anthropic_accounts"
            } else {
                "openai_accounts"
            }][0];
            account[if provider == "claude" {
                "access"
            } else {
                "access_token"
            }] = "old".into();
            account[if provider == "claude" {
                "refresh"
            } else {
                "refresh_token"
            }] = "native-refresh".into();
            account[if provider == "claude" {
                "expires"
            } else {
                "expires_at"
            }] = 1.into();
            if provider == "codex" {
                account["account_id"] = "workspace-one".into();
            }
            fs::write(profile.credential_file(), native.to_string()).unwrap();
            for _ in 0..20 {
                store.snapshot_native(profile.clone());
            }
            let result = store.verify_native(profile.clone()).await;
            assert_eq!(result["query"]["state"], "ready", "{result}");
            assert_eq!(
                fs::read_to_string(profile.home.join("refresh-calls")).unwrap(),
                "refresh\n"
            );
            let requests = state.requests.lock().unwrap();
            assert!(requests.iter().all(|request| request["path"]
                .as_str()
                .unwrap()
                .ends_with("usage")
                && request["authorization"] == "Bearer native-new"));
            if provider == "codex" {
                assert!(requests
                    .iter()
                    .filter(|request| request["path"] == "/codex-usage")
                    .all(|request| request["account"] == "workspace-one"));
            }
            drop(requests);
            {
                let mut entries = store.entries.lock().unwrap();
                let entry = entries.get_mut(&profile.home).unwrap();
                entry.usage = json!({"query":{"state":"error","code":"login_required"}});
                entry.rejected_stamp = entry.credential_stamp;
            }
            assert!(store.native_login_rejected(&profile));
            store.invalidate(&profile.home);
            assert!(
                store.native_login_rejected(&profile),
                "A pending retry must keep the same rejected login blocked"
            );
            fs::write(
                profile.credential_file(),
                fs::read(profile.credential_file()).unwrap(),
            )
            .unwrap();
            assert!(
                !store.native_login_rejected(&profile),
                "A changed login must not keep an old rejection"
            );
            fs::remove_file(profile.credential_file()).unwrap();
            let result = store.verify_native(profile.clone()).await;
            assert_eq!(result["query"]["code"], "credential_unavailable");
            assert!(!profile.credential_file().exists());
        }
        assert_eq!(
            fs::read_to_string(&state.claude).unwrap(),
            "unrelated CLI credential"
        );
        assert_eq!(
            fs::read_to_string(&state.codex).unwrap(),
            "unrelated CLI credential"
        );
        server.abort();
    }
    async fn mock(
        State(state): State<Arc<Server>>,
        request: Request<Body>,
    ) -> axum::response::Response {
        let path = request.uri().path().to_owned();
        let authorization = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let account = request
            .headers()
            .get("chatgpt-account-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        let bytes = to_bytes(request.into_body(), 1024 * 1024).await.unwrap();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        state
            .requests
            .lock()
            .unwrap()
            .push(json!({"path":path,"authorization":authorization,"account":account,"body":body}));
        if state.fail.load(Ordering::Relaxed) {
            return (
                axum::http::StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"error":"fixture failure"})),
            )
                .into_response();
        }
        if path.ends_with("token") {
            if body["refresh_token"] == "rejected-fixture" {
                if state.replace_login.load(Ordering::Relaxed) {
                    fs::write(&state.claude,json!({"claudeAiOauth":{"accessToken":"latest-fixture","refreshToken":"latest-refresh","expiresAt":now()+3_600_000}}).to_string()).unwrap();
                }
                return (axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":"invalid_grant","error_description":"never expose fixture-private-token"}))).into_response();
            }
            if body["refresh_token"] == "scope-fixture" && body.get("scope").is_some() {
                return (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(json!({"error":"invalid_scope"})),
                )
                    .into_response();
            }
            let claude = path.starts_with("/claude");
            let file = if claude { &state.claude } else { &state.codex };
            let mut latest = read_document(file).unwrap();
            latest["cliAdded"] = "preserve".into();
            if state.replace_login.load(Ordering::Relaxed) {
                latest[if claude { "claudeAiOauth" } else { "tokens" }][if claude {
                    "refreshToken"
                } else {
                    "refresh_token"
                }] = "different-login".into();
            }
            fs::write(file, latest.raw().get()).unwrap();
            return Json(json!({"access_token":"new","refresh_token":"r2","expires_in":3600,"refresh_token_expires_in":86400})).into_response();
        }
        if authorization == "Bearer old" {
            return (axum::http::StatusCode::UNAUTHORIZED, Json(json!({}))).into_response();
        }
        if path.starts_with("/claude") {
            Json(json!({"seven_day":{"utilization":25,"resets_at":"2030-01-01T00:00:00Z"},"five_hour":{"utilization":45}})).into_response()
        } else {
            Json(json!({"rate_limit":{"primary_window":{"used_percent":30,"limit_window_seconds":18000,"reset_at":1},"secondary_window":{"used_percent":90,"limit_window_seconds":604800,"reset_at":2_000_000_000}}})).into_response()
        }
    }
    #[tokio::test]
    async fn oauth_single_flight_rotation_401_and_preservation() {
        let root = tempfile::tempdir().unwrap();
        let claude = root.path().join("claude");
        let codex = root.path().join("codex");
        fs::create_dir(&claude).unwrap();
        fs::create_dir(&codex).unwrap();
        let state = Arc::new(Server {
            requests: Mutex::new(vec![]),
            claude: claude.join(".credentials.json"),
            codex: codex.join("auth.json"),
            fail: AtomicBool::new(false),
            replace_login: AtomicBool::new(false),
        });
        fs::write(&state.claude,json!({"claudeAiOauth":{"accessToken":"old","refreshToken":"r1","expiresAt":1,"scopes":["user:inference"],"subscriptionType":"max"}}).to_string()).unwrap();
        fs::write(&state.codex,json!({"auth_mode":"chatgpt","tokens":{"access_token":"old","refresh_token":"r1","id_token":"i1","account_id":"acc"}}).to_string()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(any(mock)).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut store = Store::new();
        Arc::get_mut(&mut store).unwrap().urls =
            ["claude-usage", "claude-token", "codex-usage", "codex-token"]
                .map(|path| format!("{base}/{path}"));
        for _ in 0..20 {
            assert_eq!(store.snapshot("claude", &claude), Value::Null);
        }
        for _ in 0..300 {
            if !store.entries.lock().unwrap()[&claude].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            store.snapshot("claude", &claude)["limits"]["weekly"]["remaining"],
            75.0
        );
        let calls = state.requests.lock().unwrap().clone();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[0]["body"],
            json!({"grant_type":"refresh_token","refresh_token":"r1","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e","scope":"user:inference"})
        );
        assert_eq!(calls[1]["authorization"], "Bearer new");
        let saved = read_json(&state.claude).unwrap();
        assert_eq!(saved["cliAdded"], "preserve");
        assert_eq!(saved["claudeAiOauth"]["subscriptionType"], "max");
        assert_eq!(saved["claudeAiOauth"]["refreshToken"], "r2");
        assert!(
            saved["claudeAiOauth"]["expiresAt"]
                .as_i64()
                .unwrap_or_else(|| saved["claudeAiOauth"]["expiresAt"].as_f64().unwrap() as i64)
                > now()
        );
        let limits = store.official("codex", &codex, now()).await.unwrap();
        assert_eq!(limits["weekly"]["remaining"], 10.0);
        assert_eq!(limits["session"]["remaining"], 100);
        let calls = state.requests.lock().unwrap().clone();
        assert_eq!(calls[2]["authorization"], "Bearer old");
        assert_eq!(calls[2]["account"], "acc");
        assert_eq!(calls[3]["body"]["refresh_token"], "r1");
        assert_eq!(calls[4]["authorization"], "Bearer new");
        let saved = read_json(&state.codex).unwrap();
        assert_eq!(saved["tokens"]["id_token"], "i1");
        assert_eq!(saved["tokens"]["account_id"], "acc");
        assert!(date(saved["last_refresh"].as_str().unwrap()).is_some());
        state.replace_login.store(true, Ordering::Relaxed);
        assert_eq!(
            store.refresh("claude", &claude).await.unwrap()["refreshToken"],
            "different-login"
        );
        let preserved = fs::read(&state.claude).unwrap();
        state.fail.store(true, Ordering::Relaxed);
        assert_eq!(
            store.refresh("claude", &claude).await,
            Err(UsageFailure::Response)
        );
        assert_eq!(fs::read(&state.claude).unwrap(), preserved);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&state.codex).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        state.fail.store(false, Ordering::Relaxed);
        state.replace_login.store(false, Ordering::Relaxed);
        let surrogate = document("\"\\ud800\"".into()).unwrap();
        for (provider, home, file, key) in [
            ("claude", &claude, &state.claude, "claudeAiOauth"),
            ("codex", &codex, &state.codex, "tokens"),
        ] {
            let mut raw = read_document(file).unwrap();
            raw["future"] = surrogate.clone();
            raw[key]["future"] = surrogate.clone();
            fs::write(file, raw.raw().get()).unwrap();
            assert!(store.refresh(provider, home).await.is_ok());
            let saved = read_document(file).unwrap();
            assert_eq!(saved["future"], surrogate);
            assert_eq!(saved[key]["future"], surrogate);
            assert!(store.official(provider, home, now()).await.is_ok());
        }
        store.invalidate(&claude);
        assert_eq!(store.entries.lock().unwrap()[&claude].refreshed, 0);
        server.abort();
    }

    #[tokio::test]
    async fn scope_fallback_rejected_login_and_credential_change_recovery() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("claude");
        fs::create_dir(&home).unwrap();
        let file = home.join(".credentials.json");
        let credential = |refresh: &str| {
            json!({"claudeAiOauth":{"accessToken":"old","refreshToken":refresh,"expiresAt":1,"scopes":["user:inference","user:retired-scope"]}}).to_string()
        };
        fs::write(&file, credential("scope-fixture")).unwrap();
        let state = Arc::new(Server {
            requests: Mutex::new(vec![]),
            claude: file.clone(),
            codex: home.join("unused"),
            fail: AtomicBool::new(false),
            replace_login: AtomicBool::new(false),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let router = Router::new().fallback(any(mock)).with_state(state.clone());
        let server = tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        });
        let mut store = Store::new();
        Arc::get_mut(&mut store).unwrap().urls =
            ["claude-usage", "claude-token", "codex-usage", "codex-token"]
                .map(|path| format!("{base}/{path}"));
        let value = store.scan("claude", &home, now()).await;
        assert_eq!(value["query"]["state"], "ready");
        let calls = state.requests.lock().unwrap().clone();
        assert_eq!(calls.len(), 3);
        assert!(calls[0]["body"].get("scope").is_some());
        assert!(calls[1]["body"].get("scope").is_none());
        fs::write(&file, credential("rejected-fixture")).unwrap();
        let original = fs::read(&file).unwrap();
        store.snapshot("claude", &home);
        for _ in 0..300 {
            if !store.entries.lock().unwrap()[&home].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let value = store.snapshot("claude", &home);
        assert_eq!(value["query"]["code"], "login_required");
        assert!(!value.to_string().contains("fixture-private-token"));
        assert_eq!(fs::read(&file).unwrap(), original);
        let calls = state.requests.lock().unwrap().len();
        store
            .entries
            .lock()
            .unwrap()
            .get_mut(&home)
            .unwrap()
            .refreshed = now() - 600_000;
        for _ in 0..10 {
            store.snapshot("claude", &home);
        }
        assert_eq!(
            state.requests.lock().unwrap().len(),
            calls,
            "Rejected credentials never enter an automatic refresh loop"
        );
        fs::write(&file, credential("r1")).unwrap();
        store.snapshot("claude", &home);
        for _ in 0..300 {
            if !store.entries.lock().unwrap()[&home].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(
            store.snapshot("claude", &home)["query"]["state"],
            "ready",
            "A new login bypasses the old rejected state immediately"
        );
        fs::write(&file, credential("rejected-fixture")).unwrap();
        state.replace_login.store(true, Ordering::Relaxed);
        store.invalidate(&home);
        store.snapshot("claude", &home);
        for _ in 0..300 {
            if !store.entries.lock().unwrap()[&home].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(
            store.entries.lock().unwrap()[&home].forced,
            "A rejected old request cannot cache a newer login as rejected"
        );
        store.snapshot("claude", &home);
        for _ in 0..300 {
            if !store.entries.lock().unwrap()[&home].running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(store.snapshot("claude", &home)["query"]["state"], "ready");
        assert_eq!(
            state.requests.lock().unwrap().last().unwrap()["authorization"],
            "Bearer latest-fixture"
        );
        server.abort();
    }
}
pub struct Store {
    entries: Mutex<HashMap<PathBuf, Entry>>,
    client: reqwest::Client,
    urls: [String; 4],
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn date(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .or_else(|_| DateTime::parse_from_rfc2822(text))
        .ok()
        .map(|t| t.timestamp_millis())
}
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .map(|t| t.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}
pub fn next_week(text: &str, now: i64) -> String {
    let Some(t) = date(text) else {
        return String::new();
    };
    iso(if t > now {
        t
    } else {
        t + ((now - t) / WEEK + 1) * WEEK
    })
}
fn document(text: String) -> Option<V> {
    V::parse(&serde_json::value::RawValue::from_string(text).ok()?).ok()
}
fn number(value: &V) -> Option<f64> {
    if let V::Number(n) = value {
        Some(*n)
    } else {
        None
    }
}
fn selected_fields(value: &V, keys: &[&str]) -> Value {
    // Only selected protocol fields cross into UTF-8 serde values. Unknown JSON
    // fields stay in V, including lone UTF-16 surrogate units.
    let mut result = serde_json::Map::new();
    for key in keys {
        if value.has(key) {
            let raw = value[*key].raw();
            result.insert(
                (*key).into(),
                serde_json::from_str(raw.get()).unwrap_or_else(|_| value[*key].text().into()),
            );
        }
    }
    Value::Object(result)
}
fn auth_fields(value: &V) -> Value {
    selected_fields(
        value,
        &[
            "accessToken",
            "refreshToken",
            "expiresAt",
            "scopes",
            "access_token",
            "refresh_token",
            "account_id",
        ],
    )
}
fn read_document(file: &Path) -> Option<V> {
    if file.canonicalize().ok()? != file {
        return None;
    }
    let meta = fs::symlink_metadata(file).ok()?;
    if !meta.is_file() || meta.len() > 1024 * 1024 {
        return None;
    }
    document(fs::read_to_string(file).ok()?)
}
#[cfg(test)]
fn read_json(file: &Path) -> Option<Value> {
    serde_json::from_str(read_document(file)?.raw().get()).ok()
}
fn save_document(file: &Path, value: &V) -> Option<()> {
    if file.canonicalize().ok()? != file {
        return None;
    }
    if !fs::symlink_metadata(file).ok()?.is_file() {
        return None;
    }
    let parent = file.parent()?;
    // NamedTempFile creates a private 0600 file and never exposes a partial credential.
    let mut temp = tempfile::NamedTempFile::new_in(parent).ok()?;
    temp.write_all(value.raw().get().as_bytes()).ok()?;
    temp.as_file().sync_all().ok()?;
    temp.persist(file).ok()?;
    #[cfg(unix)]
    File::open(parent).ok()?.sync_all().ok()?;
    Some(())
}
fn files(root: &Path, now: i64) -> Vec<(PathBuf, i64)> {
    let mut pending = vec![root.to_path_buf()];
    let mut result = vec![];
    while let Some(dir) = pending.pop() {
        if !fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() && entry.path().extension().is_some_and(|s| s == "jsonl") {
                let ms = entry
                    .metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|t| t.as_millis() as i64);
                if let Some(ms) = ms.filter(|ms| *ms >= now - WEEK) {
                    result.push((entry.path(), ms));
                }
            }
        }
    }
    result
}
fn claude_local(home: &Path, now: i64) -> Value {
    let mut daily: BTreeMap<String, (f64, i64)> = BTreeMap::new();
    let mut costs = crate::usage_costs::Report::new(now);
    let mut cost_messages = HashMap::new();
    let mut session = 0.0;
    let mut last = 0;
    for (path, _) in files(&home.join("projects"), now) {
        let Ok(file) = File::open(&path) else {
            continue;
        };
        for (line_index, line) in BufReader::new(file)
            .lines()
            .map_while(Result::ok)
            .enumerate()
        {
            if !line.contains("\"usage\"") {
                continue;
            }
            let Some(value) = document(line) else {
                continue;
            };
            let Some(ts) = date(&value["timestamp"].text()).filter(|ts| *ts >= now - WEEK) else {
                continue;
            };
            let usage = &value["message"]["usage"];
            if let Some(tokens) = crate::usage_costs::Tokens::from_value(&selected_fields(
                usage,
                &[
                    "input_tokens",
                    "output_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ],
            )) {
                let id = if value["message"]["id"].is_string() {
                    value["message"]["id"].text()
                } else {
                    String::new()
                };
                let key = if id.is_empty() {
                    format!("{}:{line_index}", path.display())
                } else {
                    id
                };
                cost_messages.insert(
                    key,
                    (
                        value["message"]["model"].text(),
                        value["timestamp"].text(),
                        tokens,
                    ),
                );
            }
            let tokens = number(&usage["input_tokens"]).unwrap_or(0.0)
                + number(&usage["output_tokens"]).unwrap_or(0.0);
            if tokens == 0.0 {
                continue;
            }
            let key = iso(ts).chars().take(10).collect::<String>();
            let bucket = daily.entry(key).or_insert((0.0, ts));
            bucket.0 += tokens;
            bucket.1 = bucket.1.min(ts);
            if ts > now - 5 * 3_600_000 {
                session += tokens;
            }
            last = last.max(ts);
        }
    }
    for (model, timestamp, tokens) in cost_messages.into_values() {
        costs.add("claude", &model, &timestamp, &tokens);
    }
    let oldest = daily.values().map(|(_, ts)| *ts).min().unwrap_or(0);
    json!({"provider":"claude", "weeklyTokens":daily.values().map(|(n,_)| n).sum::<f64>(),
        "sessionTokens":session, "lastActiveAt":if last == 0 { String::new() } else { iso(last) },
        "weeklyResetAt":if oldest == 0 { String::new() } else { iso(oldest + WEEK) },
        "daily":daily.into_iter().map(|(date,(tokens,_))|json!({"date":date,"tokens":tokens})).collect::<Vec<_>>(),
        "cost":costs.value()})
}
fn limits(windows: &[&Value], duration: &str, reset: &str, threshold: f64, now: i64) -> Value {
    let pick = |weekly: bool| -> Value {
        let Some(w) = windows.iter().find(|w| {
            w["used_percent"].is_number()
                && w[duration]
                    .as_f64()
                    .is_some_and(|n| (n >= threshold) == weekly)
        }) else {
            return Value::Null;
        };
        let reset_ms = w[reset].as_f64().map(|n| (n * 1000.0) as i64);
        if reset_ms.is_some_and(|t| t <= now) {
            return json!({"remaining":100,"resetAt":""});
        }
        json!({"remaining":(100.0-w["used_percent"].as_f64().unwrap()).max(0.0),
            "resetAt":reset_ms.map(iso).unwrap_or_default()})
    };
    json!({"weekly":pick(true),"session":pick(false)})
}
fn codex_local(home: &Path, now: i64) -> Value {
    let mut entries = files(&home.join("sessions"), now);
    entries.sort_by_key(|(_, ms)| std::cmp::Reverse(*ms));
    for (path, ms) in entries {
        let Ok(file) = File::open(path) else { continue };
        let mut latest = None;
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if !line.contains("\"rate_limits\"") {
                continue;
            }
            let Some(value) = document(line) else {
                continue;
            };
            let rl = &value["payload"]["rate_limits"];
            let windows = ["primary", "secondary"].map(|key| {
                selected_fields(&rl[key], &["used_percent", "window_minutes", "resets_at"])
            });
            let windows = [&windows[0], &windows[1]];
            if windows.iter().any(|w| w["used_percent"].is_number()) {
                latest = Some(limits(&windows, "window_minutes", "resets_at", 1440.0, now));
            }
        }
        if let Some(limits) = latest {
            return json!({"provider":"codex","lastActiveAt":iso(ms),"limits":limits});
        }
    }
    Value::Null
}
impl Store {
    #[cfg(test)]
    pub(crate) fn seed(&self, provider: &str, home: &Path, usage: Value) {
        self.entries.lock().unwrap().insert(
            home.into(),
            Entry {
                usage,
                refreshed: now(),
                credential_stamp: credential_stamp(provider, home),
                ..Default::default()
            },
        );
    }
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .build()
                .expect("HTTPS client"),
            urls: [CLAUDE_USAGE, CLAUDE_TOKEN, CODEX_USAGE, CODEX_TOKEN].map(str::to_owned),
        })
    }
    pub fn invalidate(&self, home: &Path) {
        if let Some(entry) = self.entries.lock().unwrap().get_mut(home) {
            entry.refreshed = 0;
            entry.generation = entry.generation.wrapping_add(1);
            entry.forced = true;
            if entry.usage.is_object() {
                entry.usage["query"] = json!({"state":"loading"});
            }
        }
    }
    pub fn snapshot(self: &Arc<Self>, provider: &str, home: &Path) -> Value {
        self.snapshot_source(provider, home, None)
    }
    pub fn snapshot_native(self: &Arc<Self>, native: crate::native_account::Profile) -> Value {
        let provider = if native.provider == "openai" {
            "codex"
        } else {
            "claude"
        };
        self.snapshot_source(provider, &native.home, Some(native.clone()))
    }
    pub fn native_login_rejected(&self, native: &crate::native_account::Profile) -> bool {
        self.entries
            .lock()
            .unwrap()
            .get(&native.home)
            .is_some_and(|entry| {
                entry.rejected_stamp.is_some()
                    && entry.rejected_stamp == file_stamp(&native.credential_file())
            })
    }
    pub async fn verify_native(self: &Arc<Self>, native: crate::native_account::Profile) -> Value {
        self.invalidate(&native.home);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(35);
        loop {
            let value = self.snapshot_native(native.clone());
            if ["ready", "error"]
                .iter()
                .any(|state| value["query"]["state"] == *state)
            {
                return value;
            }
            if tokio::time::Instant::now() >= deadline {
                return json!({"query":{"state":"error","code":"network_error"}});
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    fn snapshot_source(
        self: &Arc<Self>,
        provider: &str,
        home: &Path,
        native: Option<crate::native_account::Profile>,
    ) -> Value {
        let mut entries = self.entries.lock().unwrap();
        let entry = entries.entry(home.into()).or_default();
        let mut value = entry.usage.clone();
        let stamp = native.as_ref().map_or_else(
            || credential_stamp(provider, home),
            |profile| file_stamp(&profile.credential_file()),
        );
        if native.is_some() && entry.rejected_stamp.is_some() && entry.rejected_stamp == stamp {
            value["authenticationRejected"] = true.into();
        }
        let unchanged = entry.credential_stamp == stamp;
        let rejected = value["query"]["code"] == "login_required";
        if entry.running
            || (!entry.forced && unchanged && (rejected || now() - entry.refreshed < 300_000))
        {
            return value;
        }
        entry.running = true;
        entry.forced = false;
        let generation = entry.generation;
        drop(entries);
        let store = self.clone();
        let home = home.to_path_buf();
        let provider = provider.to_owned();
        tokio::spawn(async move {
            let usage = if let Some(profile) = &native {
                let mut value = json!({"provider":provider,"authEngine":"jcode"});
                attach_query(
                    &mut value,
                    store
                        .official_source(&provider, &home, now(), Some(profile))
                        .await,
                    now(),
                );
                value
            } else {
                store.scan(&provider, &home, now()).await
            };
            let current_stamp = native.as_ref().map_or_else(
                || credential_stamp(&provider, &home),
                |profile| file_stamp(&profile.credential_file()),
            );
            let mut entries = store.entries.lock().unwrap();
            let entry = entries.entry(home).or_default();
            // A rejected old refresh must not poison credentials from a newer CLI login.
            if usage["query"]["code"] == "login_required" && stamp != current_stamp {
                entry.running = false;
                entry.forced = true;
                return;
            }
            if usage["query"]["code"] == "login_required" {
                entry.rejected_stamp = current_stamp;
            } else if usage["query"]["state"] == "ready" || entry.credential_stamp != current_stamp
            {
                entry.rejected_stamp = None;
            }
            entry.usage = usage;
            entry.credential_stamp = current_stamp;
            entry.running = false;
            if entry.generation == generation {
                entry.refreshed = now();
            }
        });
        value
    }
    async fn refresh(&self, provider: &str, home: &Path) -> Result<Value, UsageFailure> {
        let claude = provider == "claude";
        let file = home.join(if claude {
            ".credentials.json"
        } else {
            "auth.json"
        });
        let raw = read_document(&file).ok_or(UsageFailure::Storage)?;
        let key = if claude { "claudeAiOauth" } else { "tokens" };
        let refresh_key = if claude {
            "refreshToken"
        } else {
            "refresh_token"
        };
        let auth = auth_fields(&raw[key]);
        let token = auth[refresh_key]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(UsageFailure::Login)?;
        let mut body = json!({"grant_type":"refresh_token","refresh_token":token,
            "client_id":if claude {"9d1c250a-e61b-44d9-88ed-5944d1962f5e"} else {"app_EMoamEEZ73f0CkXaXp7hrann"}});
        if claude {
            if let Some(scopes) = auth["scopes"].as_array().filter(|a| !a.is_empty()) {
                body["scope"] = scopes
                    .iter()
                    .map(|s| s.as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(" ")
                    .into();
            }
        }
        let mut response = None;
        for attempt in 0..2 {
            let result = self
                .client
                .post(&self.urls[if claude { 1 } else { 3 }])
                .json(&body)
                .send()
                .await
                .map_err(|_| UsageFailure::Network)?;
            if result.status().is_success() {
                response = Some(result);
                break;
            }
            let failure = response_failure(result).await;
            // Imported scopes can outlive a provider's supported refresh scope list.
            if failure == UsageFailure::Scope && attempt == 0 && body.get("scope").is_some() {
                body.as_object_mut().unwrap().remove("scope");
                continue;
            }
            return Err(failure);
        }
        let body: Value = response
            .ok_or(UsageFailure::Response)?
            .json()
            .await
            .map_err(|_| UsageFailure::Response)?;
        let access = body["access_token"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(UsageFailure::Response)?;
        if claude && !body["expires_in"].is_number() {
            return Err(UsageFailure::Response);
        }
        // A CLI login can change this file while the request is in flight. Do not
        // recreate a deleted file or overwrite a different login's rotated tokens.
        let mut latest = read_document(&file).ok_or(UsageFailure::Storage)?;
        if latest[key][refresh_key] != raw[key][refresh_key] {
            return Ok(auth_fields(&latest[key]));
        }
        if !matches!(latest[key], V::Object(_)) {
            return Err(UsageFailure::Storage);
        }
        if claude {
            latest[key]["accessToken"] = access.into();
            latest[key]["refreshToken"] = body["refresh_token"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(token)
                .into();
            latest[key]["expiresAt"] = (now() as f64
                + body["expires_in"].as_f64().ok_or(UsageFailure::Response)? * 1000.0)
                .into();
            if let Some(n) = body["refresh_token_expires_in"].as_f64() {
                latest[key]["refreshTokenExpiresAt"] = (now() as f64 + n * 1000.0).into();
            }
        } else {
            latest[key]["access_token"] = access.into();
            for key_name in ["id_token", "refresh_token"] {
                if body[key_name].as_str().is_some_and(|s| !s.is_empty()) {
                    latest[key][key_name] = body[key_name].as_str().unwrap().into();
                }
            }
            latest["last_refresh"] = iso(now()).into();
        }
        save_document(&file, &latest).ok_or(UsageFailure::Storage)?;
        Ok(auth_fields(&latest[key]))
    }
    async fn official(
        &self,
        provider: &str,
        home: &Path,
        time: i64,
    ) -> Result<Value, UsageFailure> {
        self.official_source(provider, home, time, None).await
    }
    async fn refresh_source(
        &self,
        provider: &str,
        home: &Path,
        native: Option<&crate::native_account::Profile>,
        force: bool,
    ) -> Result<Value, UsageFailure> {
        let Some(profile) = native else {
            return self.refresh(provider, home).await;
        };
        let result = profile.refresh(force).await;
        if result["ok"] != true {
            return Err(match result["code"].as_str().unwrap_or("") {
                "login_required" => UsageFailure::Login,
                "scope_required" => UsageFailure::Scope,
                "network_error" => UsageFailure::Network,
                _ => UsageFailure::Storage,
            });
        }
        profile
            .credentials()
            .map_err(|_| UsageFailure::Storage)?
            .ok_or(UsageFailure::Login)
    }
    async fn official_source(
        &self,
        provider: &str,
        home: &Path,
        time: i64,
        native: Option<&crate::native_account::Profile>,
    ) -> Result<Value, UsageFailure> {
        let claude = provider == "claude";
        let mut auth = if let Some(profile) = native {
            profile
                .credentials()
                .map_err(|_| UsageFailure::Storage)?
                .ok_or(UsageFailure::Login)?
        } else {
            let raw = read_document(&home.join(if claude {
                ".credentials.json"
            } else {
                "auth.json"
            }))
            .ok_or(UsageFailure::Storage)?;
            auth_fields(&raw[if claude { "claudeAiOauth" } else { "tokens" }])
        };
        auth[if claude {
            "accessToken"
        } else {
            "access_token"
        }]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(UsageFailure::Login)?;
        if (claude || native.is_some())
            && auth[if claude { "expiresAt" } else { "expires_at" }]
                .as_f64()
                .is_some_and(|n| n - 300_000.0 < time as f64)
        {
            auth = self.refresh_source(provider, home, native, false).await?;
        }
        for attempt in 0..2 {
            let access = auth[if claude {
                "accessToken"
            } else {
                "access_token"
            }]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(UsageFailure::Login)?;
            let mut request = self
                .client
                .get(&self.urls[if claude { 0 } else { 2 }])
                .bearer_auth(access)
                .timeout(Duration::from_secs(10));
            if claude {
                request = request.header("anthropic-beta", "oauth-2025-04-20");
            } else if let Some(account) = auth["account_id"].as_str().filter(|s| !s.is_empty()) {
                request = request.header("ChatGPT-Account-Id", account);
            }
            let response = request.send().await.map_err(|_| UsageFailure::Network)?;
            if response.status() == 401 && attempt == 0 {
                auth = self.refresh_source(provider, home, native, true).await?;
                continue;
            }
            if !response.status().is_success() {
                return Err(response_failure(response).await);
            }
            let body: Value = response.json().await.map_err(|_| UsageFailure::Response)?;
            if claude {
                let pick = |key: &str| {
                    body[key]["utilization"].as_f64().map(|n| json!({"remaining":(100.0-n).max(0.0),"resetAt":body[key]["resets_at"].as_str().unwrap_or("")}))
                };
                let value = json!({"weekly":pick("seven_day"),"session":pick("five_hour")});
                return if value["weekly"].is_null() && value["session"].is_null() {
                    Err(UsageFailure::Response)
                } else {
                    Ok(value)
                };
            }
            let windows = [
                &body["rate_limit"]["primary_window"],
                &body["rate_limit"]["secondary_window"],
            ];
            return windows
                .iter()
                .any(|w| w["used_percent"].is_number())
                .then(|| limits(&windows, "limit_window_seconds", "reset_at", 86_400.0, time))
                .ok_or(UsageFailure::Response);
        }
        Err(UsageFailure::Login)
    }
    async fn scan(&self, provider: &str, home: &Path, time: i64) -> Value {
        if home.canonicalize().ok().as_deref() != Some(home) {
            return Value::Null;
        }
        if provider == "claude" {
            let path = home.to_owned();
            let (local, official) = tokio::join!(
                tokio::task::spawn_blocking(move || claude_local(&path, time)),
                self.official(provider, home, time)
            );
            let mut value = local.unwrap_or(Value::Null);
            if !value.is_object() {
                value = json!({"provider":"claude"});
            }
            attach_query(&mut value, official, time);
            value
        } else {
            let official = self.official(provider, home, time).await;
            let path = home.to_owned();
            let mut value = if official.is_ok() {
                json!({"provider":"codex","lastActiveAt":""})
            } else {
                tokio::task::spawn_blocking(move || codex_local(&path, time))
                    .await
                    .unwrap_or(Value::Null)
            };
            if !value.is_object() {
                value = json!({"provider":"codex"});
            }
            attach_query(&mut value, official, time);
            value
        }
    }
}

fn attach_query(value: &mut Value, official: Result<Value, UsageFailure>, time: i64) {
    match official {
        Ok(limits) => {
            value["limits"] = limits;
            value["query"] = json!({"state":"ready","checkedAt":iso(time)});
        }
        Err(failure) => {
            value["query"] = json!({"state":"error","code":failure.code(),"checkedAt":iso(time),"localFallback":value["limits"].is_object() || value["lastActiveAt"].as_str().is_some_and(|s| !s.is_empty())});
        }
    }
}
