//! Read-only Jira agent tool. Credentials stay on the configured origin.
use crate::{
    agent_prompt::{property_string, string},
    agent_runtime::concat,
    ai_transport::Cancel,
    board_value::{object, V},
};
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(15);
const MONITOR_SPRINT_BUDGET: Duration = Duration::from_secs(5);
const BODY_LIMIT: usize = 4 * 1024 * 1024;
const FIELDS: &[&str] = &[
    "summary",
    "status",
    "priority",
    "assignee",
    "reporter",
    "duedate",
    "created",
    "updated",
    "issuetype",
    "sprint",
    "labels",
    "story_points",
    "customfield_10016",
    "parent",
];
const ISSUE_QUERY: &str = "fields=summary,status,priority,assignee,reporter,duedate,created,updated,issuetype,sprint,labels,description,comment,story_points,customfield_10016&expand=transitions,renderedFields";
macro_rules! cat {
    ($($part:expr),* $(,)?) => { concat(&[$($part.into()),*]) };
}
fn check_cancel(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Jira request cancelled".into())
    } else {
        Ok(())
    }
}
fn error_text(error: impl Into<V>, cancel: &Cancel) -> Result<V, String> {
    check_cancel(cancel)?;
    let error: V = error.into();
    Ok(cat!("Error: ", error))
}

struct Client {
    base: url::Url,
    email: String,
    token: String,
    http: reqwest::Client,
}
impl Client {
    fn new(config: &V) -> Result<Self, String> {
        for key in ["url", "email", "token"] {
            if !config[key].is_string() || config[key].units().is_empty() {
                return Err("Invalid Jira configuration".into());
            }
        }
        let base = url::Url::parse(&config["url"].text()).map_err(|_| "Invalid Jira URL")?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err("Invalid Jira URL".into());
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "Jira HTTP client setup failed")?;
        Ok(Self {
            base,
            email: config["email"].text(),
            token: config["token"].text(),
            http,
        })
    }

    async fn request(&self, path: &str, body: Option<V>, cancel: &Cancel) -> Result<V, V> {
        check_cancel(cancel)?;
        let url = self
            .base
            .join(path)
            .map_err(|_| "Invalid Jira request path")?;
        if url.origin() != self.base.origin() {
            return Err("Jira request must use the configured origin".into());
        }
        let operation = async {
            let request = match body {
                Some(body) => self.http.post(url).body(body.raw().get().to_string()),
                None => self.http.get(url),
            };
            let mut response = request
                .basic_auth(&self.email, Some(&self.token))
                .header("accept", "application/json")
                .header("content-type", "application/json")
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        "Jira request timeout"
                    } else {
                        "Jira request failed"
                    }
                })?;
            let status = response.status().as_u16();
            if (300..400).contains(&status) {
                return Err(format!("Jira redirect refused ({status})").into());
            }
            if response
                .content_length()
                .is_some_and(|length| length > BODY_LIMIT as u64)
            {
                return Err("Jira response exceeds limit".into());
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|error| {
                if error.is_timeout() {
                    "Jira request timeout"
                } else {
                    "Jira response read failed"
                }
            })? {
                if bytes.len() + chunk.len() > BODY_LIMIT {
                    return Err("Jira response exceeds limit".into());
                }
                bytes.extend_from_slice(&chunk);
            }
            let raw = String::from_utf8_lossy(&bytes);
            let parsed = serde_json::value::RawValue::from_string(raw.to_string())
                .ok()
                .and_then(|raw| V::parse(&raw).ok());
            if status >= 400 {
                if status == 401 {
                    return Err("Jira API 토큰이 만료되었거나 유효하지 않습니다".into());
                }
                if status == 403 {
                    return Err("Jira 접근 권한이 없습니다".into());
                }
                let mut error = V::from(format!("Jira API {status}"));
                if let Some(value) = parsed {
                    let first = match &value["errorMessages"] {
                        V::Array(items) => items.first().cloned().unwrap_or(V::Null),
                        V::String(units) => units
                            .first()
                            .map(|unit| V::String(vec![*unit]))
                            .unwrap_or(V::Null),
                        _ => V::Null,
                    };
                    let message = if first.truthy() {
                        first
                    } else {
                        value["message"].clone()
                    };
                    if message.truthy() {
                        error = string(&message).map_err(V::from)?;
                    }
                }
                return Err(error);
            }
            if bytes.is_empty() || status == 204 {
                return Ok(V::Null);
            }
            Ok(parsed.unwrap_or_else(|| raw.into_owned().into()))
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("Jira request cancelled".into()),
            result = tokio::time::timeout(TIMEOUT, operation) => result.unwrap_or_else(|_| Err("Jira request timeout".into())),
        };
        check_cancel(cancel)?;
        result
    }

    async fn search(&self, jql: V, max_results: usize, cancel: &Cancel) -> Result<Vec<V>, V> {
        issues(
            self.request(
                "/rest/api/3/search/jql",
                Some(search_body(jql, max_results)),
                cancel,
            )
            .await?,
        )
        .map_err(V::from)
    }
    async fn my_issues(&self, cancel: &Cancel) -> Result<Vec<V>, V> {
        self.my_issues_limit(30, cancel).await
    }
    async fn my_issues_limit(&self, limit: usize, cancel: &Cancel) -> Result<Vec<V>, V> {
        // The legacy cache omits account identity. Avoid sharing another Jira
        // account's issues and retain fresh authorization checks on every call.
        let mut all = Vec::new();
        let mut next = V::Null;
        loop {
            check_cancel(cancel)?;
            let mut body = search_body(
                "assignee = currentUser() ORDER BY updated DESC".into(),
                limit.saturating_sub(all.len()).min(100),
            );
            if next.truthy() {
                body["nextPageToken"] = next;
            }
            let data = self
                .request("/rest/api/3/search/jql", Some(body), cancel)
                .await?;
            let batch = issues(data.clone()).map_err(V::from)?;
            let empty = batch.is_empty();
            all.extend(batch);
            if empty || data["isLast"].truthy() || all.len() >= limit {
                break;
            }
            next = data["nextPageToken"].clone();
            if !next.truthy() {
                break;
            }
        }
        Ok(all)
    }
}

// Sprint collection keeps the source's board-order conflict resolution even
// when requests finish in a different order. Only the first fifty boards are
// considered, and at most four authenticated requests are active at once.
async fn monitor_sprints(client: &Client, cancel: &Cancel) -> Result<Vec<V>, String> {
    use futures_util::{stream, StreamExt};
    let data = client
        .request("/rest/agile/1.0/board?maxResults=50", None, cancel)
        .await
        .map_err(|error| error.text())?;
    check_cancel(cancel)?;
    if data == V::Null {
        return Err("Invalid Jira board response".into());
    }
    let boards = if data["values"].truthy() {
        let V::Array(boards) = &data["values"] else {
            return Err("Invalid Jira board response".into());
        };
        boards
            .iter()
            .take(50)
            .filter(|board| board["type"] == V::from("scrum"))
            .cloned()
            .collect::<Vec<_>>()
    } else {
        vec![]
    };
    let requests = stream::iter(
        boards
            .into_iter()
            .enumerate()
            .map(|(index, board)| async move {
                check_cancel(cancel)?;
                let board_id = board["id"].clone();
                let id = board_id.text();
                // Jira board IDs are decimal identifiers, never URL path fragments.
                if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Ok((index, vec![]));
                }
                let path =
                    format!("/rest/agile/1.0/board/{id}/sprint?state=active,future&maxResults=10");
                let response = client.request(&path, None, cancel).await;
                check_cancel(cancel)?;
                let sprints = response
                    .ok()
                    .and_then(|value| normalize_sprints(&value, &board_id).ok())
                    .unwrap_or_default();
                Ok::<_, String>((index, sprints))
            }),
    )
    .buffer_unordered(4);
    tokio::pin!(requests);
    let mut by_board = Vec::new();
    while let Some(result) = requests.next().await {
        check_cancel(cancel)?;
        by_board.push(result?);
    }
    by_board.sort_by_key(|(index, _)| *index);
    let mut deduplicated: Vec<V> = Vec::new();
    for (_, sprints) in by_board {
        for sprint in sprints {
            let previous = deduplicated.iter_mut().find(|existing| {
                existing.has("id") == sprint.has("id") && existing["id"] == sprint["id"]
            });
            match previous {
                Some(previous) if sprint["state"] == V::from("active") => *previous = sprint,
                None => deduplicated.push(sprint),
                _ => {}
            }
        }
    }
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .find(|value| !value.is_empty())
        .unwrap_or_default();
    let locale = locale
        .split(['.', '@'])
        .next()
        .unwrap_or("")
        .replace('_', "-");
    let locale = if matches!(locale.as_str(), "C" | "POSIX" | "") {
        "en-US"
    } else {
        &locale
    };
    let locale = locale
        .parse::<icu_locale::Locale>()
        .unwrap_or_else(|_| "en-US".parse().expect("valid built-in locale"));
    let collator = icu_collator::Collator::try_new(locale.into(), Default::default())
        .or_else(|_| icu_collator::Collator::try_new(Default::default(), Default::default()))
        .expect("compiled default collation data");
    if deduplicated
        .iter()
        .any(|sprint| sprint["name"].truthy() && !sprint["name"].is_string())
    {
        return Err("Invalid Jira sprint name".into());
    }
    deduplicated.sort_by(|a, b| {
        match (
            a["state"] == V::from("active"),
            b["state"] == V::from("active"),
        ) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => collator.compare_utf16(a["name"].units(), b["name"].units()),
        }
    });
    check_cancel(cancel)?;
    Ok(deduplicated)
}

fn normalize_sprints(data: &V, board_id: &V) -> Result<Vec<V>, String> {
    if *data == V::Null {
        return Err("Invalid Jira sprint response".into());
    }
    if !data["values"].truthy() {
        return Ok(vec![]);
    }
    let V::Array(values) = &data["values"] else {
        return Err("Invalid Jira sprint response".into());
    };
    values
        .iter()
        .map(|sprint| {
            if *sprint == V::Null {
                return Err("Invalid Jira sprint response".into());
            }
            let mut normalized = child(sprint, &["id", "name", "state"]);
            for key in ["startDate", "endDate"] {
                normalized[key] = if sprint[key].truthy() {
                    sprint[key].clone()
                } else {
                    V::Null
                };
            }
            normalized["goal"] = if sprint["goal"].truthy() {
                sprint["goal"].clone()
            } else {
                "".into()
            };
            normalized["boardId"] = board_id.clone();
            Ok(normalized)
        })
        .collect()
}

/// Independent monitor data fetch. Issues are required; sprint lookup remains
/// optional as in scanJira, while cancellation always rejects the entire cycle.
pub async fn monitor_snapshot(config: &V, cancel: &Cancel) -> Result<V, String> {
    monitor_snapshot_with_sprint_budget(config, cancel, MONITOR_SPRINT_BUDGET).await
}

async fn monitor_snapshot_with_sprint_budget(
    config: &V,
    cancel: &Cancel,
    sprint_budget: Duration,
) -> Result<V, String> {
    check_cancel(cancel)?;
    let client = Client::new(config)?;
    let issues = client
        .my_issues_limit(15, cancel)
        .await
        .map_err(|error| error.text())?;
    check_cancel(cancel)?;
    // Optional board/sprint work cannot discard an already successful issue
    // scan. Timeout drops its owned HTTP futures and cancels only this child.
    let sprint_cancel = cancel.child();
    let sprints =
        tokio::time::timeout(sprint_budget, monitor_sprints(&client, &sprint_cancel)).await;
    sprint_cancel.cancel();
    check_cancel(cancel)?;
    Ok(object([
        ("issues", V::Array(issues)),
        (
            "sprints",
            V::Array(sprints.ok().and_then(Result::ok).unwrap_or_default()),
        ),
    ]))
}

fn search_body(jql: V, count: usize) -> V {
    object([
        ("jql", jql),
        ("maxResults", (count as f64).into()),
        (
            "fields",
            V::Array(FIELDS.iter().map(|field| (*field).into()).collect()),
        ),
    ])
}
fn child(raw: &V, names: &[&str]) -> V {
    let mut output = V::object();
    for name in names {
        if raw.has(name) {
            output[name] = raw[name].clone();
        }
    }
    output
}
fn simplify(raw: &V) -> Result<V, String> {
    if *raw == V::Null {
        return Err("Cannot read properties of null (reading 'fields')".into());
    }
    let fields = &raw["fields"];
    let mut issue = child(raw, &["key", "id"]);
    issue["summary"] = if fields["summary"].truthy() {
        fields["summary"].clone()
    } else {
        "".into()
    };
    for key in [
        "status", "priority", "assignee", "reporter", "type", "parent", "sprint",
    ] {
        issue[key] = V::Null;
    }
    for (target, source, names) in [
        ("status", "status", &["name"][..]),
        ("priority", "priority", &["name", "iconUrl"][..]),
        ("assignee", "assignee", &["displayName"][..]),
        ("reporter", "reporter", &["displayName"][..]),
        ("type", "issuetype", &["name", "iconUrl"][..]),
        ("parent", "parent", &["key"][..]),
        ("sprint", "sprint", &["name", "state", "id"][..]),
    ] {
        if fields[source].truthy() {
            issue[target] = child(&fields[source], names);
        }
    }
    if issue["status"].truthy() {
        issue["status"]["category"] = if fields["status"]["statusCategory"]["key"].truthy() {
            fields["status"]["statusCategory"]["key"].clone()
        } else {
            "undefined".into()
        };
    }
    if issue["assignee"].truthy() && fields["assignee"]["avatarUrls"].has("24x24") {
        issue["assignee"]["avatarUrl"] = fields["assignee"]["avatarUrls"]["24x24"].clone();
    }
    if issue["type"].truthy() {
        issue["type"]["subtask"] = if fields["issuetype"]["subtask"].truthy() {
            fields["issuetype"]["subtask"].clone()
        } else {
            false.into()
        };
    }
    if issue["parent"].truthy() {
        issue["parent"]["summary"] = if fields["parent"]["fields"]["summary"].truthy() {
            fields["parent"]["fields"]["summary"].clone()
        } else {
            "".into()
        };
    }
    for (target, source) in [
        ("dueDate", "duedate"),
        ("created", "created"),
        ("updated", "updated"),
        ("description", "description"),
    ] {
        issue[target] = if fields[source].truthy() {
            fields[source].clone()
        } else {
            V::Null
        };
    }
    issue["storyPoints"] = if fields["story_points"] != V::Null {
        fields["story_points"].clone()
    } else {
        fields["customfield_10016"].clone()
    };
    issue["labels"] = if fields["labels"].truthy() {
        fields["labels"].clone()
    } else {
        V::Array(vec![])
    };
    issue["renderedDescription"] = if raw["renderedFields"]["description"].truthy() {
        raw["renderedFields"]["description"].clone()
    } else {
        V::Null
    };
    issue["transitions"] = if raw["transitions"].truthy() {
        raw["transitions"].clone()
    } else {
        V::Array(vec![])
    };
    let mut comments = Vec::new();
    let raw_comments = &fields["comment"]["comments"];
    if *raw_comments != V::Null {
        let V::Array(items) = raw_comments else {
            return Err("f.comment?.comments?.map is not a function".into());
        };
        for item in items {
            if *item == V::Null {
                return Err("Cannot read properties of null (reading 'id')".into());
            }
            let mut comment = child(item, &["id", "created"]);
            comment["author"] = if item["author"]["displayName"].truthy() {
                item["author"]["displayName"].clone()
            } else {
                "Unknown".into()
            };
            if item["renderedBody"].truthy() {
                comment["body"] = item["renderedBody"].clone();
            } else if item.has("body") {
                comment["body"] = item["body"].clone();
            }
            comments.push(comment);
        }
    }
    issue["comments"] = V::Array(comments);
    Ok(issue)
}
fn issues(data: V) -> Result<Vec<V>, String> {
    if data == V::Null {
        return Err("Cannot read properties of null (reading 'issues')".into());
    }
    if !data["issues"].truthy() {
        return Ok(vec![]);
    }
    let V::Array(items) = &data["issues"] else {
        return Err("(data.issues || []).map is not a function".into());
    };
    items.iter().map(simplify).collect()
}
fn value_or(value: &V, alternate: &str) -> Result<V, String> {
    if value.truthy() {
        string(value)
    } else {
        Ok(alternate.into())
    }
}
fn date(value: &V) -> Option<i64> {
    if let V::Number(number) = value {
        return number.is_finite().then_some(*number as i64);
    }
    if let V::Bool(boolean) = value {
        return Some(i64::from(*boolean));
    }
    let text = value.text();
    if let Some(date) = crate::account_usage::date(&text) {
        return Some(date);
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f%z", "%Y-%m-%d %H:%M:%S%.f%z"] {
        if let Ok(date) = chrono::DateTime::parse_from_str(&text, format) {
            return Some(date.timestamp_millis());
        }
    }
    if let Ok(date) = NaiveDate::parse_from_str(&text, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp_millis());
    }
    for format in ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M:%S%.f"] {
        if let Ok(date) = NaiveDateTime::parse_from_str(&text, format) {
            #[cfg(unix)]
            {
                let mut local: libc::tm = unsafe { std::mem::zeroed() };
                local.tm_year = date.year() - 1900;
                local.tm_mon = date.month0() as i32;
                local.tm_mday = date.day() as i32;
                local.tm_hour = date.hour() as i32;
                local.tm_min = date.minute() as i32;
                local.tm_sec = date.second() as i32;
                local.tm_isdst = -1;
                return Some(
                    unsafe { libc::mktime(&mut local) } as i64 * 1000
                        + i64::from(date.and_utc().timestamp_subsec_millis()),
                );
            }
            #[cfg(not(unix))]
            {
                return Some(date.and_utc().timestamp_millis());
            }
        }
    }
    None
}
fn local_date(value: &V) -> V {
    let Some(ms) = date(value) else {
        return "Invalid Date".into();
    };
    #[cfg(unix)]
    {
        let seconds = ms.div_euclid(1000) as libc::time_t;
        let mut local: libc::tm = unsafe { std::mem::zeroed() };
        if unsafe { libc::localtime_r(&seconds, &mut local) }.is_null() {
            return "Invalid Date".into();
        }
        format!(
            "{}. {}. {}.",
            local.tm_year + 1900,
            local.tm_mon + 1,
            local.tm_mday
        )
        .into()
    }
    #[cfg(not(unix))]
    {
        chrono::DateTime::from_timestamp_millis(ms)
            .map(|date| format!("{}. {}. {}.", date.year(), date.month(), date.day()).into())
            .unwrap_or_else(|| "Invalid Date".into())
    }
}
fn due_date(issue: &V) -> Result<Option<V>, String> {
    if !issue["dueDate"].truthy() {
        return Ok(None);
    }
    if !issue["dueDate"].is_string() {
        return Err("i.dueDate.slice is not a function".into());
    }
    Ok(Some(issue["dueDate"].cut(10)))
}
fn assignee(issue: &V, empty: &str) -> Result<V, String> {
    if issue["assignee"].truthy() {
        Ok(cat!(
            "@",
            property_string(&issue["assignee"], "displayName")?
        ))
    } else {
        Ok(empty.into())
    }
}
fn format_list(issues: &[V], now: i64) -> Result<V, String> {
    let mut output = V::from("| 이슈 | 타입 | 상태 | 우선순위 | 담당 | 요약 | 마감일 | SP |\n| --- | --- | --- | --- | --- | --- | --- | --- |");
    let mut statuses: Vec<(V, usize)> = vec![];
    let mut overdue = 0;
    for issue in issues {
        let due = due_date(issue)?.unwrap_or_else(|| "-".into());
        let points = if issue["storyPoints"] != V::Null {
            string(&issue["storyPoints"])?
        } else {
            "-".into()
        };
        output = cat!(
            output,
            "\n| ",
            property_string(issue, "key")?,
            " | ",
            value_or(&issue["type"]["name"], "-")?,
            " | [",
            value_or(&issue["status"]["name"], "?")?,
            "] | ",
            value_or(&issue["priority"]["name"], "-")?,
            " | ",
            assignee(issue, "-")?,
            " | ",
            property_string(issue, "summary")?,
            " | ",
            due,
            " | ",
            points,
            " |"
        );
        let status = value_or(&issue["status"]["name"], "기타")?;
        if let Some((_, count)) = statuses.iter_mut().find(|(name, _)| *name == status) {
            *count += 1;
        } else {
            statuses.push((status, 1));
        }
        if issue["dueDate"].truthy() && date(&issue["dueDate"]).is_some_and(|due| due < now) {
            overdue += 1;
        }
    }
    // Object.entries puts canonical integer status keys first in JavaScript.
    statuses.sort_by_key(|(name, _)| {
        let text = name.text();
        let index = text
            .parse::<u32>()
            .ok()
            .filter(|value| *value < u32::MAX && value.to_string() == text);
        index.map_or((1, 0), |index| (0, index))
    });
    output = cat!(output, format!("\n\n총 **{}건** — ", issues.len()));
    for (index, (status, count)) in statuses.into_iter().enumerate() {
        output = cat!(
            output,
            if index > 0 { ", " } else { "" },
            "[",
            status,
            format!("] {count}건")
        );
    }
    if overdue > 0 {
        output = cat!(output, format!(" | 마감 초과 **{overdue}건** ⚠️"));
    }
    Ok(output)
}
fn format_issue(issue: &V, now: i64) -> Result<V, String> {
    let due = due_date(issue)?;
    let mut output = cat!(
        "## ",
        property_string(issue, "key")?,
        ": ",
        property_string(issue, "summary")?,
        "\n\n| 항목 | 내용 |\n| --- | --- |\n| 상태 | [",
        value_or(&issue["status"]["name"], "?")?,
        "] |\n| 타입 | ",
        value_or(&issue["type"]["name"], "?")?,
        " |\n| 우선순위 | ",
        value_or(&issue["priority"]["name"], "?")?,
        " |\n| 담당 | ",
        assignee(issue, "미할당")?,
        " |\n| 보고자 | ",
        value_or(&issue["reporter"]["displayName"], "?")?,
        " |"
    );
    if let Some(due) = due {
        let overdue = date(&due).is_some_and(|due| due < now);
        output = cat!(
            output,
            "\n| 마감일 | ",
            due,
            if overdue { " ⚠️ **초과**" } else { "" },
            " |"
        );
    }
    if issue["sprint"].truthy() {
        output = cat!(
            output,
            "\n| 스프린트 | ",
            property_string(&issue["sprint"], "name")?,
            " (",
            property_string(&issue["sprint"], "state")?,
            ") |"
        );
    }
    if issue["storyPoints"] != V::Null {
        output = cat!(output, "\n| SP | ", string(&issue["storyPoints"])?, " |");
    }
    let labels = &issue["labels"];
    let has_labels = match labels {
        V::String(units) => !units.is_empty(),
        V::Array(items) => !items.is_empty(),
        V::Object(_) => labels["length"].truthy(),
        _ => false,
    };
    if has_labels {
        let V::Array(labels) = labels else {
            return Err("i.labels.join is not a function".into());
        };
        let mut joined = V::from("");
        for (index, label) in labels.iter().enumerate() {
            joined = cat!(
                joined,
                if index > 0 { ", " } else { "" },
                if *label == V::Null {
                    V::from("")
                } else {
                    string(label)?
                }
            );
        }
        output = cat!(output, "\n| 라벨 | ", joined, " |");
    }
    if issue["parent"].truthy() {
        output = cat!(
            output,
            "\n| 상위이슈 | ",
            property_string(&issue["parent"], "key")?,
            " ",
            property_string(&issue["parent"], "summary")?,
            " |"
        );
    }
    if issue["updated"].truthy() {
        output = cat!(
            output,
            "\n| 최종수정 | ",
            local_date(&issue["updated"]),
            " |"
        );
    }
    if issue["description"].truthy() {
        output = cat!(
            output,
            "\n\n### 설명\n",
            if issue["description"].is_string() {
                issue["description"].cut(600)
            } else {
                V::from("(ADF 형식 — Jira 웹에서 확인)")
            }
        );
    }
    Ok(output)
}
fn lowercase(value: &V) -> Result<V, String> {
    if !value.is_string() {
        return Err("(i.summary || \"\").toLowerCase is not a function".into());
    }
    let mut output = Vec::new();
    let mut part = String::new();
    for decoded in char::decode_utf16(value.units().iter().copied()) {
        match decoded {
            Ok(ch) => part.push(ch),
            Err(error) => {
                output.extend(part.to_lowercase().encode_utf16());
                part.clear();
                output.push(error.unpaired_surrogate());
            }
        }
    }
    output.extend(part.to_lowercase().encode_utf16());
    Ok(V::String(output))
}
fn contains_case_insensitive(value: &V, query: &V) -> Result<bool, String> {
    let value = if value.truthy() {
        value.clone()
    } else {
        V::from("")
    };
    let value = lowercase(&value)?;
    Ok(query.units().is_empty()
        || value
            .units()
            .windows(query.units().len())
            .any(|part| part == query.units()))
}
fn keyword_jql(query: &V) -> V {
    let mut escaped = Vec::new();
    for unit in query.units() {
        if matches!(unit, 34 | 92) {
            escaped.push(92);
        }
        escaped.push(*unit);
    }
    let escaped = V::String(escaped);
    cat!(
        "summary ~ \"",
        escaped.clone(),
        "\" OR description ~ \"",
        escaped,
        "\" ORDER BY updated DESC"
    )
}

async fn execute_at(argument: &V, config: &V, cancel: &Cancel, now: i64) -> Result<V, String> {
    check_cancel(cancel)?;
    if !config["url"].truthy() || !config["email"].truthy() || !config["token"].truthy() {
        return Ok(
            "Error: Jira 설정이 안 되어있어영. 설정 탭에서 Jira를 먼저 연결해주세영.".into(),
        );
    }
    if *argument == V::Null {
        return Err("Cannot read properties of null (reading 'trim')".into());
    }
    if !argument.is_string() {
        return Err("arg.trim is not a function".into());
    }
    let trimmed = argument.trim();
    let lower = trimmed.text().to_ascii_lowercase();
    let client = match Client::new(config) {
        Ok(client) => client,
        Err(error) => return error_text(error, cancel),
    };
    if lower.starts_with("jql:") {
        let jql = V::String(trimmed.units()[4..].to_vec()).trim();
        if !jql.truthy() {
            return Ok("Error: JQL 쿼리가 필요해영.".into());
        }
        return match client.search(jql.clone(), 20, cancel).await {
            Ok(issues) if issues.is_empty() => Ok(cat!("JQL 검색 결과가 없어영: ", jql)),
            Ok(issues) => match format_list(&issues, now) {
                Ok(text) => Ok(text),
                Err(error) => error_text(error, cancel),
            },
            Err(error) if error.text().contains("searchIssues") => {
                check_cancel(cancel)?;
                Ok(
                    "Error: JQL 검색 기능을 사용할 수 없어영. search:키워드 를 사용해주세영."
                        .into(),
                )
            }
            Err(error) => error_text(error, cancel),
        };
    }
    if lower.starts_with("search:") {
        let query = V::String(trimmed.units()[7..].to_vec()).trim();
        if !query.truthy() {
            return Ok("Error: 검색어가 필요해영.".into());
        }
        let result = async {
            let issues = match client.search(keyword_jql(&query), 15, cancel).await {
                Ok(issues) => issues,
                Err(_) => {
                    check_cancel(cancel)?;
                    let all = client.my_issues(cancel).await?;
                    let lowered = lowercase(&query)?;
                    let mut filtered = Vec::new();
                    for issue in all {
                        if contains_case_insensitive(&issue["summary"], &lowered)?
                            || contains_case_insensitive(&issue["key"], &lowered)?
                        {
                            filtered.push(issue);
                        }
                    }
                    filtered
                }
            };
            if issues.is_empty() {
                Ok(cat!("\"", query, "\"로 검색된 이슈가 없어영."))
            } else {
                format_list(&issues, now).map_err(V::from)
            }
        }
        .await;
        return match result {
            Ok(value) => {
                check_cancel(cancel)?;
                Ok(value)
            }
            Err(error) => error_text(error, cancel),
        };
    }
    if lower.split_once('-').is_some_and(|(prefix, number)| {
        !prefix.is_empty()
            && prefix.bytes().all(|b| b.is_ascii_lowercase())
            && !number.is_empty()
            && number.bytes().all(|b| b.is_ascii_digit())
    }) {
        let key = lower.to_ascii_uppercase();
        let result = client
            .request(
                &format!("/rest/api/3/issue/{key}?{ISSUE_QUERY}"),
                None,
                cancel,
            )
            .await
            .and_then(|raw| simplify(&raw).map_err(V::from))
            .and_then(|issue| format_issue(&issue, now).map_err(V::from));
        return match result {
            Ok(value) => {
                check_cancel(cancel)?;
                Ok(value)
            }
            Err(error) => error_text(error, cancel),
        };
    }
    Ok("Error: 올바른 이슈 키 (예: PROJ-123) 또는 search:검색어 형식을 사용해주세영.".into())
}

pub async fn execute(argument: &V, config: &V, cancel: &Cancel) -> Result<V, String> {
    execute_at(argument, config, cancel, crate::account_usage::now()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, Response},
        routing::any,
        Router,
    };
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc, Mutex,
        },
    };

    fn parse(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    struct Script {
        replies: Mutex<VecDeque<V>>,
        requests: Mutex<Vec<V>>,
        notified: tokio::sync::Notify,
        closing: Cancel,
        active: AtomicUsize,
        peak: AtomicUsize,
        concurrency: tokio::sync::Notify,
    }
    struct Active(Arc<Script>);
    impl Drop for Active {
        fn drop(&mut self) {
            self.0.active.fetch_sub(1, Ordering::SeqCst);
        }
    }
    struct Server {
        base: String,
        script: Arc<Script>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.script.closing.cancel();
            self.task.abort();
        }
    }
    impl Server {
        async fn new(replies: Vec<V>) -> Self {
            let script = Arc::new(Script {
                replies: Mutex::new(replies.into()),
                requests: Mutex::new(vec![]),
                notified: tokio::sync::Notify::new(),
                closing: Cancel::default(),
                active: AtomicUsize::new(0),
                peak: AtomicUsize::new(0),
                concurrency: tokio::sync::Notify::new(),
            });
            let state = script.clone();
            let app = Router::new().fallback(any(move |request: Request<Body>| {
                let state = state.clone();
                async move {
                    let active = state.active.fetch_add(1, Ordering::SeqCst) + 1;
                    state.peak.fetch_max(active, Ordering::SeqCst);
                    state.concurrency.notify_waiters();
                    let _active = Active(state.clone());
                    assert_eq!(
                        request.headers().get("authorization").unwrap(),
                        "Basic Zml4dHVyZTp0b2tlbg=="
                    );
                    assert_eq!(request.headers().get("accept").unwrap(), "application/json");
                    assert_eq!(
                        request.headers().get("content-type").unwrap(),
                        "application/json"
                    );
                    let mut recorded = object([
                        ("method", request.method().as_str().into()),
                        (
                            "path",
                            request.uri().path_and_query().unwrap().as_str().into(),
                        ),
                    ]);
                    let body = axum::body::to_bytes(request.into_body(), BODY_LIMIT)
                        .await
                        .unwrap();
                    if !body.is_empty() {
                        recorded["body"] = parse(std::str::from_utf8(&body).unwrap());
                    }
                    let path = recorded["path"].clone();
                    state.requests.lock().unwrap().push(recorded);
                    state.notified.notify_one();
                    let reply = {
                        let mut replies = state.replies.lock().unwrap();
                        let index = replies
                            .iter()
                            .position(|reply| !reply.has("path") || reply["path"] == path)
                            .expect("unexpected Jira request");
                        replies.remove(index).unwrap()
                    };
                    if reply["waitForPeak"].truthy() {
                        loop {
                            let notified = state.concurrency.notified();
                            tokio::pin!(notified);
                            notified.as_mut().enable();
                            if state.peak.load(Ordering::SeqCst) >= reply["waitForPeak"].number() as usize { break; }
                            tokio::select! { _ = notified => {}, _ = state.closing.cancelled() => break }
                        }
                    }
                    if reply["pending"].truthy() {
                        state.closing.cancelled().await;
                    }
                    if reply["delayMs"].truthy() {
                        tokio::time::sleep(Duration::from_millis(reply["delayMs"].number() as u64))
                            .await;
                    }
                    let mut response =
                        Response::builder().status(reply["status"].number_or(200.0) as u16);
                    if reply["location"].truthy() {
                        response = response.header("location", reply["location"].text());
                    }
                    if reply["chunked"].truthy() {
                        let chunks = vec![
                            Ok::<_, std::io::Error>(vec![b'x'; BODY_LIMIT / 2]),
                            Ok(vec![b'x'; BODY_LIMIT / 2 + 1]),
                        ];
                        return response
                            .body(Body::from_stream(futures_util::stream::iter(chunks)))
                            .unwrap();
                    }
                    let body = if reply["large"].truthy() {
                        "x".repeat(BODY_LIMIT + 1)
                    } else {
                        reply["body"].raw().get().to_owned()
                    };
                    response.body(Body::from(body)).unwrap()
                }
            }));
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/jira/context", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            Self { base, script, task }
        }
        fn config(&self) -> V {
            object([
                ("url", self.base.clone().into()),
                ("email", "fixture".into()),
                ("token", "token".into()),
            ])
        }
    }

    #[tokio::test]
    async fn original_jira_results_normalization_requests_and_pagination_match() {
        let fixtures = parse(include_str!(
            "../../tests/fixtures/rust-agent-service-jira.json"
        ));
        assert!(fixtures.array().len() >= 50);
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let server = Server::new(input["responses"].array().to_vec()).await;
            let config = if input.has("config") {
                input["config"].clone()
            } else {
                server.config()
            };
            let mut actual = match execute_at(
                &input["argument"],
                &config,
                &Cancel::default(),
                input["now"].number() as i64,
            )
            .await
            {
                Ok(value) => object([("value", value)]),
                Err(error) => object([("error", error.into())]),
            };
            actual["requests"] = V::Array(server.script.requests.lock().unwrap().clone());
            assert_eq!(actual, fixture["expected"], "{}", input["name"].text());
        }
    }

    #[tokio::test]
    async fn keyword_quotes_and_backslashes_are_escaped_but_raw_jql_is_preserved() {
        let server = Server::new(vec![
            object([(
                "body",
                object([("issues", V::Array(vec![]))])
            )]);
            2
        ])
        .await;
        let query = V::String(vec![34, 32, 79, 82, 32, 120, 32, 92, 34, 0xd800]);
        let argument = cat!("search:", query.clone());
        execute(&argument, &server.config(), &Cancel::default())
            .await
            .unwrap();
        let request = server.script.requests.lock().unwrap()[0].clone();
        let expected = cat!(
            "summary ~ \"\\\" OR x \\\\\\\"",
            V::String(vec![0xd800]),
            "\" OR description ~ \"\\\" OR x \\\\\\\"",
            V::String(vec![0xd800]),
            "\" ORDER BY updated DESC"
        );
        assert_eq!(request["body"]["jql"], expected);
        let raw = cat!("summary ~ \"", query, "\" ORDER BY updated DESC");
        execute(
            &cat!("jql:", raw.clone()),
            &server.config(),
            &Cancel::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            server.script.requests.lock().unwrap()[1]["body"]["jql"],
            raw
        );
    }

    #[tokio::test]
    async fn cancellation_during_search_never_starts_fallback() {
        let server = Server::new(vec![object([("pending", true.into())])]).await;
        let config = server.config();
        let cancel = Cancel::default();
        let argument = V::from("search:work");
        let run = execute(&argument, &config, &cancel);
        let stop = async {
            server.script.notified.notified().await;
            cancel.cancel();
        };
        let (result, ()) =
            tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(run, stop) })
                .await
                .unwrap();
        assert_eq!(result, Err("Jira request cancelled".into()));
        assert_eq!(server.script.requests.lock().unwrap().len(), 1);
        let before = server.script.requests.lock().unwrap().len();
        assert!(execute(&argument, &config, &cancel).await.is_err());
        assert_eq!(server.script.requests.lock().unwrap().len(), before);
    }

    #[tokio::test]
    async fn authentication_never_follows_redirects_and_responses_are_bounded() {
        let secondary = Server::new(vec![]).await;
        let primary = Server::new(vec![object([
            ("status", 302.0.into()),
            ("location", secondary.base.clone().into()),
            ("body", V::Null),
        ])])
        .await;
        let result = execute(&"ABC-1".into(), &primary.config(), &Cancel::default())
            .await
            .unwrap();
        assert_eq!(result, V::from("Error: Jira redirect refused (302)"));
        assert!(secondary.script.requests.lock().unwrap().is_empty());
        for field in ["large", "chunked"] {
            let server = Server::new(vec![object([(field, true.into())])]).await;
            let result = execute(&"ABC-1".into(), &server.config(), &Cancel::default())
                .await
                .unwrap();
            assert_eq!(result, V::from("Error: Jira response exceeds limit"));
        }
    }

    #[tokio::test]
    async fn request_timeout_is_bounded_and_does_not_reveal_credentials() {
        let server = Server::new(vec![object([("pending", true.into())])]).await;
        let mut client = Client::new(&server.config()).unwrap();
        client.http = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(40))
            .build()
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_secs(2),
            client.request("/rest/api/3/issue/ABC-1", None, &Cancel::default()),
        )
        .await
        .unwrap();
        assert_eq!(result, Err(V::from("Jira request timeout")));
        for url in [
            "file:///tmp/jira",
            "ftp://fixture.invalid",
            "https://secret:password@fixture.invalid",
            "https://fixture.invalid/?token=secret",
            "https://fixture.invalid/#secret",
            "not a URL",
        ] {
            let config = object([
                ("url", url.into()),
                ("email", "private@example.invalid".into()),
                ("token", "private-token".into()),
            ]);
            assert!(Client::new(&config).is_err());
        }
        let client = Client::new(&server.config()).unwrap();
        let denied = client
            .request(
                "//other.invalid/rest/api/3/issue/ABC-1",
                None,
                &Cancel::default(),
            )
            .await;
        assert_eq!(
            denied,
            Err(V::from("Jira request must use the configured origin"))
        );
    }

    const MONITOR_ISSUES: &str = "/rest/api/3/search/jql";
    const MONITOR_BOARDS: &str = "/rest/agile/1.0/board?maxResults=50";
    fn sprint_path(id: usize) -> String {
        format!("/rest/agile/1.0/board/{id}/sprint?state=active,future&maxResults=10")
    }
    fn reply(path: &str, body: V) -> V {
        object([("path", path.into()), ("body", body)])
    }
    fn boards(count: usize) -> V {
        object([(
            "values",
            V::Array(
                (1..=count)
                    .map(|id| object([("id", (id as f64).into()), ("type", "scrum".into())]))
                    .collect(),
            ),
        )])
    }
    fn sorted_requests(values: &[V]) -> V {
        let mut sorted = values.to_vec();
        sorted.sort_by_key(|value| value.raw().get().to_owned());
        V::Array(sorted)
    }

    #[tokio::test]
    async fn monitor_snapshot_matches_original_issue_pages_sprint_fields_and_partial_failures() {
        let fixtures = parse(include_str!("../../tests/fixtures/rust-monitor-jira.json"));
        assert!(fixtures.array().len() >= 20);
        for fixture in fixtures.array() {
            let server = Server::new(fixture["input"]["replies"].array().to_vec()).await;
            let mut actual = match monitor_snapshot(&server.config(), &Cancel::default()).await {
                Ok(value) => object([("value", value)]),
                Err(error) => object([("error", error.into())]),
            };
            actual["requests"] = sorted_requests(&server.script.requests.lock().unwrap());
            let mut expected = fixture["expected"].clone();
            expected["requests"] = sorted_requests(expected["requests"].array());
            assert_eq!(actual, expected, "{}", fixture["input"]["name"].text());
        }
    }

    #[tokio::test]
    async fn monitor_caps_boards_and_inflight_requests_preserving_source_conflict_order() {
        let mut replies = vec![
            reply(MONITOR_ISSUES, object([("issues", V::Array(vec![]))])),
            reply(MONITOR_BOARDS, boards(52)),
        ];
        for id in 1..=50 {
            let mut response = reply(
                &sprint_path(id),
                object([(
                    "values",
                    V::Array(vec![object([
                        ("id", 99.0.into()),
                        ("name", format!("board-{id}").into()),
                        ("state", "active".into()),
                    ])]),
                )]),
            );
            if id <= 4 {
                response["waitForPeak"] = 4.0.into();
            }
            response["delayMs"] = if id % 4 == 1 { 12.0.into() } else { 3.0.into() };
            replies.push(response);
        }
        let server = Server::new(replies).await;
        let snapshot = tokio::time::timeout(
            Duration::from_secs(2),
            monitor_snapshot(&server.config(), &Cancel::default()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(snapshot["sprints"].array().len(), 1);
        assert_eq!(snapshot["sprints"].array()[0]["name"], V::from("board-50"));
        assert_eq!(snapshot["sprints"].array()[0]["boardId"], V::from(50.0));
        let requests = server.script.requests.lock().unwrap();
        assert_eq!(requests.len(), 52);
        assert!(!requests
            .iter()
            .any(|request| request["path"] == V::from(sprint_path(51))
                || request["path"] == V::from(sprint_path(52))));
        assert_eq!(server.script.peak.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn monitor_cancellation_in_every_fetch_stage_prevents_partial_success_or_more_work() {
        for stage in ["issues", "boards", "sprints"] {
            let mut issue = reply(MONITOR_ISSUES, object([("issues", V::Array(vec![]))]));
            let mut board = reply(MONITOR_BOARDS, boards(8));
            if stage == "issues" {
                issue["pending"] = true.into();
            }
            if stage == "boards" {
                board["pending"] = true.into();
            }
            let mut replies = vec![issue, board];
            for id in 1..=8 {
                let mut sprint = reply(&sprint_path(id), object([("values", V::Array(vec![]))]));
                sprint["pending"] = true.into();
                replies.push(sprint);
            }
            let server = Server::new(replies).await;
            let config = server.config();
            let cancel = Cancel::default();
            let expected = match stage {
                "issues" => 1,
                "boards" => 2,
                _ => 6,
            };
            let run = monitor_snapshot(&config, &cancel);
            let stop = async {
                loop {
                    let notified = server.script.notified.notified();
                    if server.script.requests.lock().unwrap().len() >= expected {
                        break;
                    }
                    notified.await;
                }
                cancel.cancel();
            };
            let (result, ()) =
                tokio::time::timeout(Duration::from_secs(2), async { tokio::join!(run, stop) })
                    .await
                    .unwrap();
            assert_eq!(result, Err("Jira request cancelled".into()));
            assert_eq!(server.script.requests.lock().unwrap().len(), expected);
            assert_eq!(
                monitor_snapshot(&config, &cancel).await,
                Err("Jira request cancelled".into())
            );
            assert_eq!(server.script.requests.lock().unwrap().len(), expected);
        }
    }

    #[tokio::test]
    async fn optional_sprint_budget_preserves_issues_and_stops_queued_board_requests() {
        let raw_issue = object([
            ("key", "FIX-1".into()),
            ("id", "1".into()),
            (
                "fields",
                object([
                    ("summary", "keep successful issues".into()),
                    ("status", object([("name", "In Progress".into())])),
                ]),
            ),
        ]);
        let expected_issue = simplify(&raw_issue).unwrap();
        for delayed_boards in [true, false] {
            let mut board = reply(MONITOR_BOARDS, boards(50));
            if delayed_boards {
                board["pending"] = true.into();
            }
            let mut replies = vec![
                reply(
                    MONITOR_ISSUES,
                    object([("issues", V::Array(vec![raw_issue.clone()]))]),
                ),
                board,
            ];
            for id in 1..=50 {
                let mut sprint = reply(&sprint_path(id), object([("values", V::Array(vec![]))]));
                sprint["pending"] = true.into();
                replies.push(sprint);
            }
            let server = Server::new(replies).await;
            let cancel = Cancel::default();
            let snapshot = tokio::time::timeout(
                Duration::from_secs(1),
                monitor_snapshot_with_sprint_budget(
                    &server.config(),
                    &cancel,
                    Duration::from_millis(100),
                ),
            )
            .await
            .expect("optional sprint scan exceeded its budget")
            .unwrap();
            assert_eq!(snapshot["issues"], V::Array(vec![expected_issue.clone()]));
            assert_eq!(snapshot["sprints"], V::Array(vec![]));
            assert!(
                !cancel.is_cancelled(),
                "optional timeout cancelled the monitor parent"
            );
            let expected_requests = if delayed_boards { 2 } else { 6 };
            assert_eq!(
                server.script.requests.lock().unwrap().len(),
                expected_requests
            );
            // Give a detached dispatcher an opportunity to reveal itself. The
            // timed-out future must not start any of the other queued boards.
            tokio::time::sleep(Duration::from_millis(20)).await;
            assert_eq!(
                server.script.requests.lock().unwrap().len(),
                expected_requests
            );
        }
    }
}
