//! Agent adapters for the existing CI service and the public weather endpoints.
use crate::{
    agent_prompt::{property_string, string},
    ai_transport::Cancel,
    board_value::V,
    cicd, projects,
};
use std::{collections::HashMap, future::Future, time::Duration};

const WEATHER_LIMIT: usize = 1_048_576;
const WEATHER_TIMEOUT: Duration = Duration::from_secs(5);
const CI_BODY_LIMIT: usize = 10 * 1024 * 1024;

fn concat(parts: impl IntoIterator<Item = V>) -> V {
    V::String(
        parts
            .into_iter()
            .flat_map(|part| part.units().to_vec())
            .collect(),
    )
}
fn lines(parts: Vec<V>) -> V {
    let mut result = vec![];
    for (index, part) in parts.into_iter().enumerate() {
        if index != 0 {
            result.push(10);
        }
        result.extend_from_slice(part.units());
    }
    V::String(result)
}
fn error(message: impl AsRef<str>) -> V {
    format!("Error: {}", message.as_ref()).into()
}
fn cancelled(cancel: &Cancel) -> Result<(), String> {
    if cancel.is_cancelled() {
        Err("Agent request cancelled".into())
    } else {
        Ok(())
    }
}
async fn owned<T>(
    future: impl Future<Output = Result<T, String>>,
    cancel: &Cancel,
) -> Result<T, String> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Agent request cancelled".into()),
        result = future => result,
    }
}
fn fallback_property(value: &V, first: &str, second: &str) -> Result<V, String> {
    if *value == V::Null {
        return Err(format!(
            "Cannot read properties of null (reading '{first}')"
        ));
    }
    if value[first].truthy() {
        string(&value[first])
    } else {
        property_string(value, second)
    }
}

#[derive(Clone, Debug, PartialEq)]
enum CiAction {
    Status,
    Detail(String),
    Rerun(String),
    Cancel(String),
}
fn ci_action(argument: &V) -> Result<CiAction, V> {
    let arg = argument.trim().text().to_lowercase();
    if arg == "status" {
        return Ok(CiAction::Status);
    }
    for prefix in ["detail:", "rerun:", "cancel:"] {
        if let Some(id) = arg.strip_prefix(prefix) {
            let id = V::from(id).trim().text();
            if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err("Error: 올바른 런 ID가 필요해영 (숫자).".into());
            }
            return Ok(match prefix {
                "detail:" => CiAction::Detail(id),
                "rerun:" => CiAction::Rerun(id),
                _ => CiAction::Cancel(id),
            });
        }
    }
    Err("Error: 올바른 형식을 사용해주세영: status, detail:런ID, rerun:런ID, cancel:런ID".into())
}

fn ci_result(action: &CiAction, value: &V) -> Result<V, String> {
    match action {
        CiAction::Rerun(id) => Ok(format!("✅ Run #{id} 재실행을 시작했어영!").into()),
        CiAction::Cancel(id) => Ok(format!("✅ Run #{id} 취소했어영!").into()),
        CiAction::Status => {
            if *value == V::Null {
                return Err("Cannot read properties of null (reading 'length')".into());
            }
            if (value.is_array() && value.array().is_empty())
                || (value.is_string() && value.units().is_empty())
                || (!value.is_array() && !value.is_string() && !value["length"].truthy())
            {
                return Ok("CI/CD 실행 이력이 없어영.".into());
            }
            if !value.is_array() {
                return Err("runs.map is not a function".into());
            }
            let mut output = vec![];
            for run in value.array() {
                let status = fallback_property(run, "conclusion", "status")?;
                let raw_status = if run["conclusion"].truthy() {
                    &run["conclusion"]
                } else {
                    &run["status"]
                };
                let icon = if *raw_status == V::from("success") {
                    "✅"
                } else if *raw_status == V::from("failure") {
                    "❌"
                } else if *raw_status == V::from("in_progress") {
                    "⏳"
                } else {
                    "⬜"
                };
                output.push(concat([
                    icon.into(),
                    " #".into(),
                    property_string(run, "databaseId")?,
                    " ".into(),
                    fallback_property(run, "workflowName", "name")?,
                    " [".into(),
                    property_string(run, "headBranch")?,
                    "] ".into(),
                    status,
                    " (".into(),
                    property_string(run, "createdAt")?,
                    ")".into(),
                ]));
            }
            Ok(lines(output))
        }
        CiAction::Detail(_) => {
            if *value == V::Null {
                return Err("Cannot read properties of null (reading 'jobs')".into());
            }
            let mut jobs = vec![];
            if value["jobs"].truthy() {
                if !value["jobs"].is_array() {
                    return Err("(detail.jobs || []).map is not a function".into());
                }
                for job in value["jobs"].array() {
                    let status = fallback_property(job, "conclusion", "status")?;
                    let raw_status = if job["conclusion"].truthy() {
                        &job["conclusion"]
                    } else {
                        &job["status"]
                    };
                    let icon = if *raw_status == V::from("success") {
                        "✅"
                    } else if *raw_status == V::from("failure") {
                        "❌"
                    } else {
                        "⏳"
                    };
                    jobs.push(concat([
                        "  ".into(),
                        icon.into(),
                        " ".into(),
                        property_string(job, "name")?,
                        ": ".into(),
                        status,
                    ]));
                }
            }
            let sha = if value["headSha"].truthy() {
                if !value["headSha"].is_string() {
                    return Err("(detail.headSha || \"\").slice is not a function".into());
                }
                value["headSha"].cut(7)
            } else {
                "".into()
            };
            let mut output = vec![
                concat([
                    "Run #".into(),
                    property_string(value, "databaseId")?,
                    ": ".into(),
                    fallback_property(value, "displayTitle", "name")?,
                ]),
                concat([
                    "워크플로우: ".into(),
                    property_string(value, "workflowName")?,
                ]),
                concat([
                    "브랜치: ".into(),
                    property_string(value, "headBranch")?,
                    " (".into(),
                    sha,
                    ")".into(),
                ]),
                concat([
                    "상태: ".into(),
                    fallback_property(value, "conclusion", "status")?,
                ]),
                concat(["생성: ".into(), property_string(value, "createdAt")?]),
            ];
            if !jobs.is_empty() {
                output.push(concat(["\n작업 목록:\n".into(), lines(jobs)]));
            }
            Ok(lines(output))
        }
    }
}

async fn ci_with<F, Fut>(
    argument: &V,
    has_root: bool,
    call: F,
    cancel: &Cancel,
) -> Result<V, String>
where
    F: FnOnce(CiAction) -> Fut,
    Fut: Future<Output = Result<V, String>>,
{
    cancelled(cancel)?;
    if !has_root {
        return Ok("Error: No projects registered".into());
    }
    if *argument == V::Null {
        return Err("Cannot read properties of null (reading 'trim')".into());
    }
    if !argument.is_string() {
        return Err("arg.trim is not a function".into());
    }
    let action = match ci_action(argument) {
        Ok(action) => action,
        Err(error) => return Ok(error),
    };
    cancelled(cancel)?;
    let response = owned(call(action.clone()), cancel).await;
    cancelled(cancel)?;
    Ok(response
        .and_then(|value| ci_result(&action, &value))
        .unwrap_or_else(error))
}

fn encode_component(value: &V) -> Result<String, String> {
    let value = String::from_utf16(value.units()).map_err(|_| "URI malformed")?;
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    Ok(encoded)
}

/// Reuses CI's project resolution, cache, gh invocation and mutation behavior.
pub async fn cicd(
    argument: &V,
    store: &cicd::Store,
    projects: &projects::Store,
    cancel: &Cancel,
) -> Result<V, String> {
    cancelled(cancel)?;
    let primary = projects
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .next();
    let primary = primary
        .map(|project| V::parse(&serde_json::value::to_raw_value(&project).unwrap()).unwrap());
    let has_root = primary
        .as_ref()
        .is_some_and(|project| project["path"].truthy());
    ci_with(
        argument,
        has_root,
        |action| async move {
            let id = encode_component(&primary.as_ref().unwrap()["id"])?;
            let mut query = HashMap::new();
            let path = match action {
                CiAction::Status => {
                    query.insert("limit".into(), "10".into());
                    format!("/api/cicd/runs/{id}")
                }
                CiAction::Detail(run) => format!("/api/cicd/runs/{id}/{run}"),
                CiAction::Rerun(run) => format!("/api/cicd/runs/{id}/{run}/rerun"),
                CiAction::Cancel(run) => format!("/api/cicd/runs/{id}/{run}/cancel"),
            };
            cancelled(cancel)?;
            let response = store
                .handle_agent(&path, &query, V::object(), projects, cancel)
                .await;
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), CI_BODY_LIMIT)
                .await
                .map_err(|error| error.to_string())?;
            let raw = serde_json::from_slice::<Box<serde_json::value::RawValue>>(&body)
                .map_err(|error| error.to_string())?;
            let value = V::parse(&raw).map_err(|error| error.to_string())?;
            if !status.is_success() {
                return Err(property_string(&value, "error")?.text());
            }
            Ok(value)
        },
        cancel,
    )
    .await
}

fn weather_code(value: &V, key: &str) -> Result<V, String> {
    let code = property_string(value, key)?;
    let description = match code.text().as_str() {
        "0" => Some("맑음"),
        "1" => Some("대체로 맑음"),
        "2" => Some("구름 조금"),
        "3" => Some("흐림"),
        "45" => Some("안개"),
        "48" => Some("짙은 안개"),
        "51" | "53" => Some("이슬비"),
        "55" => Some("강한 이슬비"),
        "61" => Some("약한 비"),
        "63" => Some("비"),
        "65" => Some("강한 비"),
        "71" => Some("약한 눈"),
        "73" => Some("눈"),
        "75" => Some("강한 눈"),
        "77" => Some("눈알갱이"),
        "80" => Some("소나기"),
        "81" => Some("강한 소나기"),
        "82" => Some("폭우"),
        "85" => Some("약한 눈소나기"),
        "86" => Some("강한 눈소나기"),
        "95" => Some("뇌우"),
        "96" => Some("우박 뇌우"),
        "99" => Some("강한 우박 뇌우"),
        _ => None,
    };
    Ok(description
        .map(V::from)
        .unwrap_or_else(|| concat(["코드".into(), code])))
}
fn wind_direction(current: &V) -> V {
    let deg = if current.has("wind_direction_10m") {
        current["wind_direction_10m"].number()
    } else {
        f64::NAN
    };
    let index = (deg / 22.5 + 0.5).floor() % 16.0;
    if !index.is_finite() || index < 0.0 {
        return "undefined".into();
    }
    [
        "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW",
        "NW", "NNW",
    ][index as usize]
        .into()
}
fn indexed(value: &V, key: &str, index: usize) -> Result<V, String> {
    if !value.has(key) {
        return Err(format!(
            "Cannot read properties of undefined (reading '{index}')"
        ));
    }
    let value = &value[key];
    if *value == V::Null {
        return Err(format!(
            "Cannot read properties of null (reading '{index}')"
        ));
    }
    Ok(match value {
        V::Array(values) => values
            .get(index)
            .cloned()
            .unwrap_or_else(|| "undefined".into()),
        V::String(units) => units
            .get(index)
            .map(|unit| V::String(vec![*unit]))
            .unwrap_or_else(|| "undefined".into()),
        _ if value.has(&index.to_string()) => value[&index.to_string()].clone(),
        _ => "undefined".into(),
    })
}
fn weather_result(location: &V, place: &V, weather: &V) -> Result<V, String> {
    if *weather == V::Null {
        return Err("Cannot read properties of null (reading 'current')".into());
    }
    let current = if weather["current"].truthy() {
        weather["current"].clone()
    } else {
        V::object()
    };
    let name = if place["name"].truthy() {
        string(&place["name"])?
    } else {
        location.clone()
    };
    let country = if place["country"].truthy() {
        concat([", ".into(), string(&place["country"])?])
    } else {
        "".into()
    };
    let mut output = vec![
        concat(["[Weather: ".into(), name, country, "]".into()]),
        concat([
            weather_code(&current, "weather_code")?,
            " | ".into(),
            property_string(&current, "temperature_2m")?,
            "°C (체감 ".into(),
            property_string(&current, "apparent_temperature")?,
            "°C)".into(),
        ]),
        concat([
            "습도: ".into(),
            property_string(&current, "relative_humidity_2m")?,
            "% | 풍속: ".into(),
            property_string(&current, "wind_speed_10m")?,
            "km/h ".into(),
            wind_direction(&current),
            " | 강수량: ".into(),
            property_string(&current, "precipitation")?,
            "mm".into(),
        ]),
    ];
    let daily = &weather["daily"];
    let count = match &daily["time"] {
        V::Array(items) => items.len(),
        V::String(units) => units.len(),
        _ => 0,
    };
    if count > 10_000 {
        return Err("Weather forecast exceeded limit".into());
    }
    if count > 0 {
        output.extend(["".into(), "[3-Day Forecast]".into()]);
        for index in 0..count {
            let code = indexed(daily, "weather_code", index)?;
            let code_object = crate::board_value::object([("code", code)]);
            output.push(concat([
                string(&indexed(daily, "time", index)?)?,
                ": ".into(),
                string(&indexed(daily, "temperature_2m_min", index)?)?,
                "~".into(),
                string(&indexed(daily, "temperature_2m_max", index)?)?,
                "°C | ".into(),
                weather_code(&code_object, "code")?,
            ]));
        }
    }
    Ok(lines(output))
}

async fn weather_with<F, Fut>(argument: &V, mut fetch: F, cancel: &Cancel) -> Result<V, String>
where
    F: FnMut(String) -> Fut,
    Fut: Future<Output = Result<V, String>>,
{
    cancelled(cancel)?;
    if *argument == V::Null {
        return Ok("Error: location required. e.g. WEATHER 서울".into());
    }
    if !argument.is_string() {
        return Err("location?.trim is not a function".into());
    }
    let location = argument.trim();
    if !location.truthy() {
        return Ok("Error: location required. e.g. WEATHER 서울".into());
    }
    let result = async {
        let name = encode_component(&location)?;
        let geo = owned(fetch(format!("https://geocoding-api.open-meteo.com/v1/search?name={name}&count=1&language=ko")), cancel).await?;
        cancelled(cancel)?;
        if geo == V::Null { return Err("Cannot read properties of null (reading 'results')".into()); }
        let place = geo["results"].array().first().cloned().unwrap_or(V::Null);
        if !place.truthy() { return Ok(concat(["Error: \"".into(), location.clone(), "\" 위치를 찾을 수 없습니다.".into()])); }
        let url = concat([
            "https://api.open-meteo.com/v1/forecast?latitude=".into(), property_string(&place, "latitude")?,
            "&longitude=".into(), property_string(&place, "longitude")?,
            "&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,apparent_temperature,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=Asia/Seoul&forecast_days=3".into(),
        ]).text();
        cancelled(cancel)?;
        let data = owned(fetch(url), cancel).await?;
        cancelled(cancel)?;
        weather_result(&location, &place, &data)
    }.await;
    cancelled(cancel)?;
    Ok(result.unwrap_or_else(|message| format!("Error: weather fetch failed — {message}").into()))
}

fn allowed_weather_url(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port_or_known_default() == Some(443)
        && matches!(
            (url.host_str(), url.path()),
            (Some("geocoding-api.open-meteo.com"), "/v1/search")
                | (Some("api.open-meteo.com"), "/v1/forecast")
        )
}
fn decode_weather_body(body: &[u8]) -> Result<V, String> {
    if body.len() > WEATHER_LIMIT {
        return Err("Weather response exceeded limit".into());
    }
    let raw = serde_json::from_slice::<Box<serde_json::value::RawValue>>(body)
        .map_err(|error| error.to_string())?;
    V::parse(&raw).map_err(|error| error.to_string())
}
async fn fetch_weather(client: &reqwest::Client, url: String) -> Result<V, String> {
    let url = url::Url::parse(&url).map_err(|error| error.to_string())?;
    if !allowed_weather_url(&url) {
        return Err("Invalid weather endpoint".into());
    }
    tokio::time::timeout(WEATHER_TIMEOUT, async {
        let mut response = client
            .get(url)
            .send()
            .await
            .map_err(|error| error.to_string())?;
        if response
            .content_length()
            .is_some_and(|length| length > WEATHER_LIMIT as u64)
        {
            return Err("Weather response exceeded limit".into());
        }
        let mut body = vec![];
        while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
            if body.len() + chunk.len() > WEATHER_LIMIT {
                return Err("Weather response exceeded limit".into());
            }
            body.extend_from_slice(&chunk);
        }
        decode_weather_body(&body)
    })
    .await
    .map_err(|_| "The operation was aborted due to timeout".to_string())?
}

pub async fn weather(argument: &V, cancel: &Cancel) -> Result<V, String> {
    cancelled(cancel)?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(WEATHER_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    weather_with(argument, |url| fetch_weather(&client, url), cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;
    use std::{
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Mutex,
        },
    };

    fn fixtures() -> V {
        V::parse(
            &serde_json::value::RawValue::from_string(
                include_str!("../../tests/fixtures/rust-agent-service-external.json").into(),
            )
            .unwrap(),
        )
        .unwrap()
    }
    fn outcome(value: Result<V, String>) -> V {
        match value {
            Ok(value) => object([("value", value)]),
            Err(message) => object([("error", message.into())]),
        }
    }
    #[tokio::test]
    async fn ci_text_and_service_contract_match_original() {
        for case in fixtures()["cicd"].array() {
            let input = &case["input"];
            let calls = Mutex::new(vec![]);
            let result = ci_with(
                &input["arg"],
                input["root"].truthy(),
                |action| {
                    let (method, args) = match action {
                        CiAction::Status => (
                            "getWorkflowRuns",
                            V::Array(vec![
                                input["root"].clone(),
                                object([("limit", 10.0.into())]),
                            ]),
                        ),
                        CiAction::Detail(id) => (
                            "getRunDetail",
                            V::Array(vec![input["root"].clone(), id.into()]),
                        ),
                        CiAction::Rerun(id) => (
                            "rerunWorkflow",
                            V::Array(vec![input["root"].clone(), id.into()]),
                        ),
                        CiAction::Cancel(id) => (
                            "cancelRun",
                            V::Array(vec![input["root"].clone(), id.into()]),
                        ),
                    };
                    calls
                        .lock()
                        .unwrap()
                        .push(object([("method", method.into()), ("args", args)]));
                    std::future::ready(if input.has("error") {
                        Err(input["error"].text())
                    } else {
                        Ok(input["response"].clone())
                    })
                },
                &Cancel::default(),
            )
            .await;
            assert_eq!(outcome(result), case["expected"], "{}", input.raw());
            assert_eq!(
                V::Array(calls.into_inner().unwrap()),
                case["calls"],
                "{}",
                input.raw()
            );
        }
    }
    #[tokio::test]
    async fn weather_text_and_requests_match_original() {
        for case in fixtures()["weather"].array() {
            let input = &case["input"];
            let calls = Mutex::new(vec![]);
            let mut responses: VecDeque<_> = input["responses"].array().to_vec().into();
            let result = weather_with(
                &input["arg"],
                |url| {
                    calls.lock().unwrap().push(V::from(url));
                    let response = responses.pop_front().expect("fixture request count");
                    std::future::ready(if response.has("error") {
                        Err(response["error"].text())
                    } else {
                        Ok(response["value"].clone())
                    })
                },
                &Cancel::default(),
            )
            .await;
            assert_eq!(outcome(result), case["expected"], "{}", input.raw());
            assert_eq!(
                V::Array(calls.into_inner().unwrap()),
                case["calls"],
                "{}",
                input.raw()
            );
        }
    }
    #[test]
    fn weather_endpoint_policy_rejects_host_scheme_port_and_redirect_targets() {
        for url in [
            "https://geocoding-api.open-meteo.com/v1/search?name=x",
            "https://api.open-meteo.com/v1/forecast?latitude=0&longitude=0",
        ] {
            assert!(allowed_weather_url(&url::Url::parse(url).unwrap()));
        }
        for url in [
            "http://api.open-meteo.com/v1/forecast",
            "https://api.open-meteo.com:444/v1/forecast",
            "https://api.open-meteo.com.attacker.example/v1/forecast",
            "https://x@api.open-meteo.com/v1/forecast",
            "https://api.open-meteo.com/other",
            "https://127.0.0.1/v1/forecast",
        ] {
            assert!(!allowed_weather_url(&url::Url::parse(url).unwrap()));
        }
    }
    #[tokio::test]
    async fn cancellation_prevents_mutation_and_drops_pending_requests() {
        let cancel = Cancel::default();
        cancel.cancel();
        let ci = ci_with(
            &"rerun:123".into(),
            true,
            |_| async { panic!("cancelled CI must not start") },
            &cancel,
        )
        .await;
        let weather = weather_with(
            &"서울".into(),
            |_| async { panic!("cancelled weather must not fetch") },
            &cancel,
        )
        .await;
        assert!(ci.is_err() && weather.is_err());
        struct Guard(Arc<AtomicBool>);
        impl Drop for Guard {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let cancel = Cancel::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let observed = dropped.clone();
        let arg = V::from("서울");
        let request = weather_with(
            &arg,
            move |_| {
                let guard = Guard(observed.clone());
                async move {
                    let _guard = guard;
                    std::future::pending().await
                }
            },
            &cancel,
        );
        let stop = async {
            tokio::time::sleep(Duration::from_millis(5)).await;
            cancel.cancel();
        };
        let (result, _) = tokio::join!(request, stop);
        assert_eq!(result, Err("Agent request cancelled".into()));
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn weather_body_boundary_and_utf16_are_preserved() {
        let mut body = vec![b' '; WEATHER_LIMIT];
        body[..2].copy_from_slice(b"{}");
        assert_eq!(decode_weather_body(&body).unwrap(), V::object());
        body.push(b' ');
        assert_eq!(
            decode_weather_body(&body),
            Err("Weather response exceeded limit".into())
        );
        assert!(decode_weather_body(b"not json").is_err());
        assert_eq!(
            decode_weather_body(br#"{"name":"\ud800"}"#).unwrap()["name"],
            V::String(vec![0xd800])
        );
    }
}
