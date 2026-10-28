use crate::board_value::{object, V};
use axum::{
    http::{header, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{stream, StreamExt};
use serde_json::value::RawValue;
use std::{cmp::Ordering, collections::HashMap, time::Duration};

const LIST_FIELDS: &str = "number,title,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup";
const DETAIL_FIELDS: &str = "number,title,body,state,headRefName,baseRefName,author,updatedAt,createdAt,reviewDecision,isDraft,additions,deletions,changedFiles,labels,url,mergeable,statusCheckRollup,reviews,comments,files,commits";
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/prs"),
    ("GET", "/api/projects/:id/prs"),
    ("GET", "/api/projects/:id/prs/:number"),
    ("GET", "/api/projects/:id/prs/:number/diff"),
    ("POST", "/api/projects/:id/prs/:number/approve"),
    ("POST", "/api/projects/:id/prs/:number/request-changes"),
    ("POST", "/api/projects/:id/prs/:number/comment"),
    ("POST", "/api/projects/:id/prs/:number/merge"),
];

pub fn route(method: &Method, path: &str) -> Option<(String, String)> {
    if *method == Method::GET && path == "/api/prs" {
        return Some((String::new(), "all".into()));
    }
    let (id, operation) = path.strip_prefix("/api/projects/")?.split_once('/')?;
    if id.is_empty() {
        return None;
    }
    let parts: Vec<_> = operation.split('/').collect();
    let matches = match parts.as_slice() {
        ["prs"] => *method == Method::GET,
        ["prs", number] if !number.is_empty() => *method == Method::GET,
        ["prs", number, "diff"] if !number.is_empty() => *method == Method::GET,
        ["prs", number, "approve" | "request-changes" | "comment" | "merge"]
            if !number.is_empty() =>
        {
            *method == Method::POST
        }
        _ => false,
    };
    matches.then(|| (id.into(), operation.into()))
}

fn fallback(value: &V, default: V) -> V {
    if value.truthy() {
        value.clone()
    } else {
        default
    }
}

fn copy_fields(source: &V, fields: &[(&str, &str)]) -> V {
    let mut result = V::object();
    for (from, to) in fields {
        if source.has(from) {
            result[to] = source[from].clone();
        }
    }
    result
}

fn array_or_empty(value: &V) -> Result<&[V], String> {
    if !value.truthy() {
        Ok(&[])
    } else if let V::Array(items) = value {
        Ok(items)
    } else {
        Err("GitHub response field is not an array".into())
    }
}

fn non_null(value: &V) -> Result<(), String> {
    if *value == V::Null {
        Err("Cannot read properties of null".into())
    } else {
        Ok(())
    }
}

fn map_pr(pr: &V) -> Result<V, String> {
    non_null(pr)?;
    let mut result = copy_fields(
        pr,
        &[
            ("number", "number"),
            ("title", "title"),
            ("state", "state"),
            ("headRefName", "branch"),
            ("baseRefName", "baseBranch"),
            ("updatedAt", "updatedAt"),
            ("createdAt", "createdAt"),
            ("isDraft", "isDraft"),
            ("url", "url"),
            ("mergeable", "mergeable"),
        ],
    );
    result["author"] = fallback(&pr["author"]["login"], "unknown".into());
    result["reviewDecision"] = fallback(&pr["reviewDecision"], "PENDING".into());
    for key in ["additions", "deletions", "changedFiles"] {
        result[key] = fallback(&pr[key], V::Number(0.0));
    }
    result["labels"] = V::Array(
        array_or_empty(&pr["labels"])?
            .iter()
            .map(|label| {
                non_null(label)?;
                Ok(fallback(&label["name"], label.clone()))
            })
            .collect::<Result<_, String>>()?,
    );
    result["checks"] = V::Array(
        array_or_empty(&pr["statusCheckRollup"])?
            .iter()
            .map(|check| {
                non_null(check)?;
                let mut mapped = copy_fields(check, &[("conclusion", "conclusion")]);
                for (key, alternative) in [("name", "context"), ("status", "state")] {
                    if check[key].truthy() {
                        mapped[key] = check[key].clone();
                    } else if check.has(alternative) {
                        mapped[key] = check[alternative].clone();
                    }
                }
                Ok(mapped)
            })
            .collect::<Result<_, String>>()?,
    );
    Ok(result)
}

fn map_detail(pr: &V) -> Result<V, String> {
    let mut result = map_pr(pr)?;
    result["body"] = fallback(&pr["body"], "".into());
    for key in ["reviews", "comments", "files"] {
        result[key] = V::Array(
            array_or_empty(&pr[key])?
                .iter()
                .map(|entry| {
                    non_null(entry)?;
                    let fields: &[(&str, &str)] = match key {
                        "reviews" => &[("state", "state"), ("submittedAt", "submittedAt")],
                        "comments" => &[("createdAt", "createdAt")],
                        _ => &[("path", "path")],
                    };
                    let mut mapped = copy_fields(entry, fields);
                    if key == "files" {
                        for field in ["additions", "deletions"] {
                            mapped[field] = fallback(&entry[field], V::Number(0.0));
                        }
                    } else {
                        mapped["author"] = fallback(&entry["author"]["login"], "unknown".into());
                        mapped["body"] = fallback(&entry["body"], "".into());
                    }
                    Ok(mapped)
                })
                .collect::<Result<_, String>>()?,
        );
    }
    let commits = fallback(&pr["commits"], V::Array(vec![]));
    match &commits {
        V::Array(items) => result["commits"] = V::Number(items.len() as f64),
        V::String(units) => result["commits"] = V::Number(units.len() as f64),
        _ if commits.has("length") => result["commits"] = commits["length"].clone(),
        _ => {}
    }
    Ok(result)
}

async fn gh(project: &V, args: &[String], seconds: u64) -> Result<String, String> {
    let output = crate::project_command::run(
        project,
        "gh",
        args,
        Duration::from_secs(seconds),
        1024 * 1024,
    )
    .await?;
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn parse_output(output: &str, empty: &str) -> Result<V, String> {
    let raw = RawValue::from_string(if output.is_empty() { empty } else { output }.into())
        .map_err(|error| error.to_string())?;
    V::parse(&raw).map_err(|error| error.to_string())
}

pub async fn list(project: &V, state: &str) -> V {
    let mut args: Vec<String> = ["pr", "list", "--json", LIST_FIELDS, "--limit", "20"]
        .into_iter()
        .map(String::from)
        .collect();
    if matches!(state, "all" | "merged" | "closed") {
        args.extend(["--state".into(), state.into()]);
    }
    let fetched = async {
        let parsed = parse_output(&gh(project, &args, 15).await?, "[]")?;
        if !parsed.is_array() {
            return Err("GitHub PR response is not an array".into());
        }
        parsed
            .array()
            .iter()
            .map(map_pr)
            .collect::<Result<Vec<_>, String>>()
    }
    .await;
    // The Node list endpoint returns an empty list when gh or JSON mapping fails.
    let prs = fetched.unwrap_or_default();
    let mut result = copy_fields(project, &[("id", "projectId")]);
    result["prs"] = V::Array(prs);
    result
}

fn json_response(status: StatusCode, value: V) -> Response {
    (status, Json(value.raw())).into_response()
}

fn error_response(status: StatusCode, message: impl Into<String>) -> Response {
    json_response(status, object([("error", V::from(message.into()))]))
}

fn updated_at(pr: &V) -> Option<i64> {
    if !pr.has("updatedAt") {
        return None;
    }
    match &pr["updatedAt"] {
        V::Null => Some(0),
        V::Number(value) if value.is_finite() => Some(*value as i64),
        V::Bool(value) => Some(i64::from(*value)),
        value => chrono::DateTime::parse_from_rfc3339(&value.text())
            .or_else(|_| chrono::DateTime::parse_from_rfc2822(&value.text()))
            .ok()
            .map(|date| date.timestamp_millis()),
    }
}

async fn all(projects: Vec<V>, state: String) -> V {
    let mut results = stream::iter(projects.into_iter().enumerate().map(|(index, project)| {
        let state = state.clone();
        async move {
            let result = list(&project, &state).await;
            let items = result["prs"]
                .array()
                .iter()
                .map(|pr| {
                    let mut pr = pr.clone();
                    for (from, to) in [("id", "projectId"), ("name", "projectName")] {
                        if project.has(from) {
                            pr[to] = project[from].clone();
                        }
                    }
                    pr
                })
                .collect::<Vec<_>>();
            (index, items)
        }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    results.sort_by_key(|(index, _)| *index);
    let mut prs: Vec<_> = results.into_iter().flat_map(|(_, items)| items).collect();
    prs.sort_by(|a, b| match (updated_at(a), updated_at(b)) {
        (Some(a), Some(b)) => b.cmp(&a),
        _ => Ordering::Equal,
    });
    object([("prs", V::Array(prs))])
}

fn action_args(number: &str, operation: &str, input: &V) -> Result<Vec<String>, String> {
    let body = &input["body"];
    let mut args = vec!["pr".into()];
    match operation {
        "approve" => {
            args.extend(["review".into(), number.into(), "--approve".into()]);
            if body.truthy() {
                args.extend(["--body".into(), body.text()]);
            }
        }
        "request-changes" => args.extend([
            "review".into(),
            number.into(),
            "--request-changes".into(),
            "--body".into(),
            fallback(body, "Changes requested".into()).text(),
        ]),
        "comment" => args.extend([
            "comment".into(),
            number.into(),
            "--body".into(),
            body.text(),
        ]),
        "merge" => {
            let flag = if input["method"] == V::from("rebase") {
                "--rebase"
            } else if input["method"] == V::from("merge") {
                "--merge"
            } else {
                "--squash"
            };
            args.extend([
                "merge".into(),
                number.into(),
                flag.into(),
                "--delete-branch".into(),
            ]);
        }
        _ => return Err("Not found".into()),
    }
    Ok(args)
}

pub async fn handle(
    projects: &crate::projects::Store,
    raw_id: &str,
    operation: &str,
    query: &HashMap<String, String>,
    input: V,
) -> Response {
    let loaded = projects
        .list()
        .map_err(|error| error.to_string())
        .and_then(|items| {
            items
                .iter()
                .map(|item| {
                    let raw =
                        serde_json::value::to_raw_value(item).map_err(|error| error.to_string())?;
                    V::parse(&raw).map_err(|error| error.to_string())
                })
                .collect::<Result<Vec<_>, String>>()
        });
    let projects = match loaded {
        Ok(projects) => projects,
        Err(error) => return error_response(StatusCode::INTERNAL_SERVER_ERROR, error),
    };
    if operation == "all" {
        let state = query
            .get("state")
            .filter(|s| !s.is_empty())
            .cloned()
            .unwrap_or_else(|| "all".into());
        return json_response(StatusCode::OK, all(projects, state).await);
    }
    let Some(id) = crate::decoded_id(raw_id) else {
        return error_response(StatusCode::BAD_REQUEST, "Invalid project id");
    };
    let Some(project) = projects
        .iter()
        .find(|project| project["id"] == V::from(id.as_str()))
    else {
        return error_response(StatusCode::NOT_FOUND, "Not found");
    };
    if operation == "prs" {
        return json_response(StatusCode::OK, list(project, "open").await);
    }
    let parts: Vec<_> = operation.split('/').collect();
    let Some(number) = parts.get(1).copied() else {
        return error_response(StatusCode::BAD_REQUEST, "Invalid PR number");
    };
    if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
        return error_response(StatusCode::BAD_REQUEST, "Invalid PR number");
    }
    let action = parts.get(2).copied().unwrap_or("");
    if action == "comment" {
        if input["body"] != V::Null && !input["body"].is_string() {
            return error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "body.body?.trim is not a function",
            );
        }
        if !input["body"].trim().truthy() {
            return error_response(StatusCode::BAD_REQUEST, "Comment body required");
        }
    }
    let result = async {
        if action.is_empty() {
            let args = ["pr", "view", &number, "--json", DETAIL_FIELDS].map(String::from);
            let parsed = parse_output(&gh(project, &args, 20).await?, "{}")?;
            return Ok(json_response(StatusCode::OK, map_detail(&parsed)?));
        }
        if action == "diff" {
            let args = ["pr", "diff", &number].map(String::from);
            let diff = gh(project, &args, 30).await?;
            return Ok(([(header::CONTENT_TYPE, "text/plain")], diff).into_response());
        }
        let args = action_args(&number, action, &input)?;
        gh(project, &args, 15).await?;
        Ok::<Response, String>(json_response(
            StatusCode::OK,
            object([("ok", V::Bool(true))]),
        ))
    }
    .await;
    result.unwrap_or_else(|error| error_response(StatusCode::INTERNAL_SERVER_ERROR, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn value(json: &str) -> V {
        V::parse(&RawValue::from_string(json.into()).unwrap()).unwrap()
    }

    #[test]
    fn mapping_preserves_missing_null_defaults_and_utf16() {
        let mapped = map_pr(&value(r#"{"title":"\ud800","number":null,"headRefName":"main","author":{},"labels":["plain",{"name":"named"},{"name":"","color":"red"}],"statusCheckRollup":[{"name":"","context":"ci","state":"SUCCESS"},{}]}"#)).unwrap();
        assert_eq!(mapped["title"].units(), &[0xd800]);
        assert!(mapped.has("number"));
        assert!(!mapped.has("url"));
        assert_eq!(mapped["branch"], V::from("main"));
        assert_eq!(mapped["author"], V::from("unknown"));
        assert_eq!(mapped["reviewDecision"], V::from("PENDING"));
        assert_eq!(mapped["labels"].array()[2]["color"], V::from("red"));
        assert_eq!(mapped["checks"].array()[0]["name"], V::from("ci"));
        assert_eq!(mapped["checks"].array()[1], V::object());
        let detail = map_detail(&value(
            r#"{"commits":[{},{}],"reviews":[{}],"files":[{"path":"a"}]}"#,
        ))
        .unwrap();
        assert_eq!(detail["commits"], V::Number(2.0));
        assert_eq!(detail["body"], V::from(""));
        assert!(!detail["reviews"].array()[0].has("submittedAt"));
        assert_eq!(detail["files"].array()[0]["additions"], V::Number(0.0));
        assert!(map_pr(&value(r#"{"labels":{}}"#)).is_err());
    }

    #[test]
    fn routing_matches_methods_and_keeps_raw_segments_for_validation() {
        assert_eq!(
            route(&Method::GET, "/api/prs"),
            Some(("".into(), "all".into()))
        );
        assert_eq!(
            route(&Method::GET, "/api/projects/a%20b/prs/%31/diff"),
            Some(("a%20b".into(), "prs/%31/diff".into()))
        );
        assert!(route(&Method::GET, "/api/projects/a/prs/bad").is_some());
        assert!(route(&Method::POST, "/api/projects/a/prs/12/merge").is_some());
        for path in [
            "/api/projects/a/git",
            "/api/projects/a/prs/",
            "/api/projects/a/prs/12/merge",
            "/api/projects/a/prs/12/diff/extra",
        ] {
            assert!(route(&Method::GET, path).is_none());
        }
        assert!(route(&Method::POST, "/api/prs").is_none());
    }

    #[test]
    fn action_arguments_preserve_body_and_merge_defaults() {
        assert_eq!(
            action_args("0012", "approve", &V::Null).unwrap(),
            ["pr", "review", "0012", "--approve"]
        );
        assert_eq!(
            action_args("12", "request-changes", &V::Null)
                .unwrap()
                .last()
                .unwrap(),
            "Changes requested"
        );
        let args = action_args(
            "12",
            "comment",
            &object([("body", V::from("  hello\n--flag  "))]),
        )
        .unwrap();
        assert_eq!(args.last().unwrap(), "  hello\n--flag  ");
        assert_eq!(
            action_args("12", "merge", &object([("method", V::from("invalid"))])).unwrap(),
            ["pr", "merge", "12", "--squash", "--delete-branch"]
        );
    }
}
