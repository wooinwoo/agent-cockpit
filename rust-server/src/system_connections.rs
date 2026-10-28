//! Network connection details and explicit external session/voice requests.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    App,
};
use axum::{
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU16, Ordering},
        RwLock,
    },
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/lan-info"),
    ("GET", "/api/qr-code"),
    ("POST", "/api/sessions/:id/start"),
    ("POST", "/api/sessions/:id/resume"),
    ("POST", "/api/agent/tts"),
];
pub struct Store {
    port: AtomicU16,
    cancel: Cancel,
    hosts: RwLock<HashSet<String>>,
}
impl Default for Store {
    fn default() -> Self {
        Self {
            port: AtomicU16::new(0),
            cancel: Cancel::default(),
            hosts: RwLock::new(HashSet::new()),
        }
    }
}
fn session(path: &str) -> Option<(&str, bool)> {
    let rest = path.strip_prefix("/api/sessions/")?;
    let (id, resume) = if let Some(id) = rest.strip_suffix("/start") {
        (id, false)
    } else {
        (rest.strip_suffix("/resume")?, true)
    };
    (!id.is_empty() && !id.contains('/')).then_some((id, resume))
}
pub fn route(method: &Method, path: &str) -> bool {
    (*method == Method::GET && matches!(path, "/api/lan-info" | "/api/qr-code"))
        || (*method == Method::POST && (path == "/api/agent/tts" || session(path).is_some()))
}
impl Store {
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Release);
    }
    pub fn stop(&self) {
        self.cancel.cancel();
    }
    pub fn host_allowed(&self, host: &str) -> bool {
        self.hosts.read().unwrap().contains(host)
    }
    pub async fn refresh_hosts(&self) -> Result<V, String> {
        // Isolated server fixtures provide addresses without querying a user's
        // Windows/Tailscale installation. Normal discovery owns its subprocess.
        let ips = if let Ok(value) = std::env::var("COCKPIT_PREVIEW_NETWORK_JSON") {
            serde_json::value::RawValue::from_string(value)
                .map_err(|_| "Invalid network fixture".to_owned())
                .and_then(|raw| V::parse(&raw).map_err(|_| "Invalid network fixture".to_owned()))?
        } else {
            crate::network_addresses::addresses(&self.cancel).await?
        };
        if !ips.is_array() {
            return Err("Invalid network address list".into());
        }
        let hosts = ips
            .array()
            .iter()
            .filter_map(|row| {
                row["ip"]
                    .text()
                    .parse::<std::net::IpAddr>()
                    .ok()
                    .map(|ip| ip.to_string())
            })
            .collect();
        *self.hosts.write().unwrap() = hosts;
        Ok(ips)
    }
    pub async fn handle(
        &self,
        app: &App,
        path: &str,
        input: &V,
        query: &HashMap<String, String>,
        local: bool,
    ) -> Response {
        if self.cancel.is_cancelled() || app.closing.load(Ordering::Acquire) {
            return crate::error(503, "Server is shutting down");
        }
        if matches!(path, "/api/lan-info" | "/api/qr-code") && !local {
            return if path == "/api/qr-code" {
                StatusCode::FORBIDDEN.into_response()
            } else {
                crate::error(403, "Forbidden")
            };
        }
        if path == "/api/qr-code" {
            let Some(data) = query.get("data").filter(|data| !data.is_empty()) else {
                return (StatusCode::BAD_REQUEST, "Missing data param").into_response();
            };
            return match crate::qr::svg(&data.clone().into()) {
                Ok(svg) => (
                    [
                        ("content-type", "image/svg+xml"),
                        ("cache-control", "no-store"),
                    ],
                    svg,
                )
                    .into_response(),
                Err(error) => crate::error(400, &error),
            };
        }
        if path == "/api/lan-info" {
            let ips = self.refresh_hosts().await;
            return match ips {
                Ok(ips) => Json(
                    object([
                        ("token", app.token.clone().into()),
                        ("ips", ips),
                        ("port", (self.port.load(Ordering::Acquire) as f64).into()),
                    ])
                    .raw(),
                )
                .into_response(),
                Err(error) => crate::error(500, &error),
            };
        }
        if path == "/api/agent/tts" {
            if !input["text"].truthy() {
                return crate::error(400, "text required");
            }
            if !input["text"].is_string() {
                return crate::error(400, "text must be a string");
            }
            let result = if let Ok(endpoint) = std::env::var("COCKPIT_PREVIEW_TTS_URL") {
                crate::tts::synthesize_preview(&input["text"], &endpoint, &self.cancel).await
            } else {
                crate::tts::synthesize(&input["text"], &self.cancel).await
            };
            return match result {
                Ok(audio) => (
                    [
                        ("content-type", "audio/mpeg"),
                        ("cache-control", "no-store"),
                    ],
                    audio,
                )
                    .into_response(),
                Err(error) => crate::error(500, &error),
            };
        }
        if let Some((id, resume)) = session(path) {
            let Some(id) = crate::decoded_id(id) else {
                return crate::error(400, "Invalid project ID");
            };
            let Some(project) = crate::git::project(&app.projects, &id) else {
                return crate::error(404, "Not found");
            };
            return match crate::session_launch::launch(&project, input, resume, &self.cancel).await
            {
                Ok(value) => Json(value.raw()).into_response(),
                Err(error) => crate::error(500, &error),
            };
        }
        crate::error(404, "Not found")
    }
}
