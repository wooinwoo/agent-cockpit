use crate::{
    board_value::{object, V},
    project_command, projects,
};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const RUN_FIELDS: &str = "databaseId,name,displayTitle,headBranch,headSha,status,conclusion,event,createdAt,updatedAt,url,workflowName";
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/cicd/runs/:projectId"),
    ("GET", "/api/cicd/runs/:projectId/:runId"),
    ("GET", "/api/cicd/runs/:projectId/:runId/jobs"),
    ("GET", "/api/cicd/runs/:projectId/:runId/logs"),
    ("POST", "/api/cicd/runs/:projectId/:runId/rerun"),
    ("POST", "/api/cicd/runs/:projectId/:runId/cancel"),
    ("GET", "/api/cicd/workflows/:projectId"),
];

#[derive(Default)]
pub struct Store {
    cache: Mutex<HashMap<(String, String), (Instant, V)>>,
}

pub fn route(method: &Method, path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/cicd/") else {
        return false;
    };
    let segments: Vec<_> = rest.split('/').collect();
    if segments.iter().any(|part| part.is_empty()) {
        return false;
    }
    match segments.as_slice() {
        ["runs" | "workflows", _] | ["runs", _, _] => *method == Method::GET,
        ["runs", _, _, "jobs" | "logs"] => *method == Method::GET,
        ["runs", _, _, "rerun" | "cancel"] => *method == Method::POST,
        _ => false,
    }
}

async fn gh(
    project: &V,
    args: Vec<String>,
    cancel: Option<&crate::ai_transport::Cancel>,
) -> Result<String, String> {
    let output = if let Some(cancel) = cancel {
        project_command::run_owned(
            project,
            "gh",
            &args,
            Duration::from_secs(30),
            5 * 1024 * 1024,
            cancel,
        )
        .await
    } else {
        project_command::run(
            project,
            "gh",
            &args,
            Duration::from_secs(30),
            5 * 1024 * 1024,
        )
        .await
    };
    output
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        .map_err(|error| {
            error
                .split_once('\n')
                .map(|(_, stderr)| stderr.trim())
                .filter(|stderr| !stderr.is_empty())
                .unwrap_or(&error)
                .to_owned()
        })
}

fn parse(value: &str) -> Result<V, String> {
    let raw = serde_json::value::RawValue::from_string(value.into())
        .map_err(|error| error.to_string())?;
    V::parse(&raw).map_err(|error| error.to_string())
}

impl Store {
    pub async fn handle(
        &self,
        path: &str,
        query: &HashMap<String, String>,
        input: V,
        projects: &projects::Store,
    ) -> Response {
        self.request(path, query, input, projects, None)
            .await
            .unwrap_or_else(|message| crate::error(500, &message))
    }
    pub async fn handle_agent(
        &self,
        path: &str,
        query: &HashMap<String, String>,
        input: V,
        projects: &projects::Store,
        cancel: &crate::ai_transport::Cancel,
    ) -> Response {
        self.request(path, query, input, projects, Some(cancel))
            .await
            .unwrap_or_else(|message| crate::error(500, &message))
    }

    async fn request(
        &self,
        path: &str,
        query: &HashMap<String, String>,
        input: V,
        projects: &projects::Store,
        cancel: Option<&crate::ai_transport::Cancel>,
    ) -> Result<Response, String> {
        let parts: Vec<_> = path.trim_start_matches("/api/cicd/").split('/').collect();
        let Some(id) = crate::decoded_id(parts[1]) else {
            return Ok(crate::error(400, "Invalid project ID"));
        };
        let project = projects
            .list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|value| V::parse(&serde_json::value::to_raw_value(&value).unwrap()).unwrap())
            .find(|p| p["id"] == V::from(id.as_str()));
        let Some(project) = project else {
            return Ok(crate::error(404, "Not found"));
        };
        if parts.len() >= 3 && !parts[2].bytes().all(|b| b.is_ascii_digit()) {
            return Ok(crate::error(400, "Invalid run ID"));
        }
        let project_path = project["path"].text();
        if parts.len() == 2 {
            let workflows = parts[0] == "workflows";
            let filter = |key| query.get(key).map(String::as_str).unwrap_or("");
            // Match the existing cache's omission of the limit query. Bound its
            // lifetime and entry count so arbitrary filter strings cannot grow it forever.
            let cache_key = if workflows {
                "workflows".into()
            } else {
                format!(
                    "runs:{}:{}:{}",
                    filter("workflow"),
                    filter("status"),
                    filter("branch")
                )
            };
            let key = (project_path.clone(), cache_key);
            {
                let mut cache = self.cache.lock().unwrap();
                cache.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
                if let Some((_, value)) = cache.get(&key) {
                    return Ok(Json(value.raw()).into_response());
                }
            }
            let mut args: Vec<String> = if workflows {
                ["workflow", "list", "--json", "id,name,state"]
                    .map(String::from)
                    .to_vec()
            } else {
                let limit = crate::git::parse_int(filter("limit"))
                    .filter(|n| *n != 0)
                    .unwrap_or(30);
                vec![
                    "run".into(),
                    "list".into(),
                    "--json".into(),
                    RUN_FIELDS.into(),
                    "-L".into(),
                    limit.to_string(),
                ]
            };
            if !workflows {
                for (key, flag) in [("workflow", "-w"), ("status", "-s"), ("branch", "-b")] {
                    if !filter(key).is_empty() {
                        args.extend([flag.into(), filter(key).into()]);
                    }
                }
            }
            let raw = gh(&project, args, cancel).await?;
            let data = if raw.is_empty() {
                V::Array(vec![])
            } else {
                parse(&raw)?
            };
            let mut cache = self.cache.lock().unwrap();
            if cache.len() >= 256 {
                if let Some(old) = cache
                    .iter()
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(key, _)| key.clone())
                {
                    cache.remove(&old);
                }
            }
            cache.insert(key, (Instant::now(), data.clone()));
            return Ok(Json(data.raw()).into_response());
        }
        let run = parts[2];
        let operation = parts.get(3).copied().unwrap_or("");
        let mut args = vec!["run".into(), "view".into(), run.into()];
        if operation == "logs" {
            args.push("--log".into());
            return Ok((
                [(axum::http::header::CONTENT_TYPE, "text/plain")],
                gh(&project, args, cancel)
                    .await
                    .unwrap_or_else(|_| "(No logs available)".into()),
            )
                .into_response());
        }
        if matches!(operation, "rerun" | "cancel") {
            args[1] = operation.into();
            if operation == "rerun" && input["failed"].truthy() {
                args.push("--failed".into());
            }
            gh(&project, args, cancel).await?;
            self.cache
                .lock()
                .unwrap()
                .retain(|(path, key), _| path != &project_path || !key.starts_with("runs:"));
            return Ok(Json(object([("success", V::Bool(true))]).raw()).into_response());
        }
        args.extend([
            "--json".into(),
            if operation == "jobs" {
                "jobs".into()
            } else {
                format!("{RUN_FIELDS},jobs")
            },
        ]);
        let data = parse(&gh(&project, args, cancel).await?)?;
        let value = if operation == "jobs" {
            if data["jobs"].truthy() {
                data["jobs"].clone()
            } else {
                V::Array(vec![])
            }
        } else {
            data
        };
        Ok(Json(value.raw()).into_response())
    }
}
