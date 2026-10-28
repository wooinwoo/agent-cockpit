//! Pure snapshots for the original project and team prompt context.
//!
//! `projects` and `roots` are provider return values; omitted keys mean no provider.
//! `projectsError` / `rootsError` model failed providers. `branches` is aligned with
//! roots and contains the resulting branch name or null on lookup failure.
//! `notes` being absent means there is no listNotes service. Otherwise it contains
//! `files: [{name, note?}]` in directory order, or `error: true` on directory failure.
//! Missing `note` represents a read/JSON failure; explicit null is parsed JSON null.
//! `cost` is the poller's cost:daily value. `serviceProjects` is the independently
//! supplied getProjects result. Their absence means those services are unavailable.
//! `costError` / `serviceProjectsError` represent failed service calls.
use crate::board_value::V;

fn append(out: &mut Vec<u16>, text: &str) {
    out.extend(text.encode_utf16());
}

fn string(value: &V) -> Result<V, String> {
    Ok(match value {
        V::String(_) => value.clone(),
        V::Object(_) if value.has("toString") => {
            return Err("Cannot convert object to primitive value".into());
        }
        V::Number(n) if *n == 0.0 => "0".into(),
        V::Number(n) if *n == f64::INFINITY => "Infinity".into(),
        V::Number(n) if *n == f64::NEG_INFINITY => "-Infinity".into(),
        V::Number(n) if n.is_finite() && (n.abs() >= 1e21 || n.abs() < 1e-6) => {
            let scientific = format!("{n:e}");
            let (digits, exponent) = scientific.split_once('e').unwrap();
            let exponent: i32 = exponent.parse().unwrap();
            format!(
                "{digits}e{}{exponent}",
                if exponent >= 0 { "+" } else { "" }
            )
            .into()
        }
        V::Array(values) => {
            let mut out = Vec::new();
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    out.push(44);
                }
                if *value != V::Null {
                    out.extend_from_slice(string(value)?.units());
                }
            }
            V::String(out)
        }
        _ => value.text().into(),
    })
}

fn property(value: &V, key: &str) -> Result<Option<V>, String> {
    if *value == V::Null {
        return Err(format!("Cannot read properties of null (reading '{key}')"));
    }
    if key == "length" {
        match value {
            V::Array(items) => return Ok(Some(V::Number(items.len() as f64))),
            V::String(units) => return Ok(Some(V::Number(units.len() as f64))),
            _ => {}
        }
    }
    Ok(value.has(key).then(|| value[key].clone()))
}

fn display(value: Option<&V>) -> Result<V, String> {
    value.map_or_else(|| Ok("undefined".into()), string)
}

fn put(out: &mut Vec<u16>, value: Option<&V>) -> Result<(), String> {
    out.extend_from_slice(display(value)?.units());
    Ok(())
}

fn value_or(value: Option<V>, fallback: V) -> V {
    value.filter(V::truthy).unwrap_or(fallback)
}

fn snapshot_value(snapshot: &V, key: &str) -> Result<V, String> {
    let error_key = format!("{key}Error");
    if snapshot[error_key.as_str()].truthy() {
        return Err(format!("{key} fixture unavailable"));
    }
    Ok(if snapshot.has(key) {
        snapshot[key].clone()
    } else {
        V::Array(Vec::new())
    })
}

fn item(value: &V, index: usize) -> Result<Option<V>, String> {
    match value {
        V::Array(items) => Ok(items.get(index).cloned()),
        V::String(units) => Ok(units.get(index).map(|unit| V::String(vec![*unit]))),
        _ => property(value, &index.to_string()),
    }
}

pub fn project(snapshot: &V) -> Result<V, String> {
    let projects = snapshot_value(snapshot, "projects")?;
    let count = property(&projects, "length")?;
    if !count.as_ref().is_some_and(V::truthy) {
        return Ok("".into());
    }
    let roots = snapshot_value(snapshot, "roots")?;
    let V::Array(projects) = projects else {
        return Err("projects.map is not a function".into());
    };
    let mut out = Vec::new();
    append(&mut out, "\n## Project Context (");
    put(&mut out, count.as_ref())?;
    append(&mut out, "개 등록됨)\n사용자가 특정 프로젝트를 지정하지 않으면 \"어떤 프로젝트 말씀이세요?\" 라고 물어봐.\n");
    for (index, project) in projects.iter().enumerate() {
        let root = item(&roots, index)?;
        let mut line = Vec::new();
        append(&mut line, "- **");
        put(&mut line, property(project, "name")?.as_ref())?;
        append(&mut line, "** [");
        put(
            &mut line,
            Some(&value_or(property(project, "stack")?, "?".into())),
        )?;
        append(&mut line, "] ");
        put(&mut line, property(project, "path")?.as_ref())?;
        if root.as_ref().is_some_and(V::truthy) {
            let branch = item(&snapshot["branches"], index).ok().flatten();
            if let Some(branch) = branch.filter(V::truthy) {
                append(&mut line, " (branch: ");
                put(&mut line, Some(&branch))?;
                line.push(41);
            }
        }
        if index > 0 {
            out.push(10);
        }
        out.extend(line);
    }
    Ok(V::String(out))
}

// `for..of` on a sliced JS string groups valid surrogate pairs while preserving
// lone surrogates. Array snapshots follow the normal production path.
fn sliced_items(value: &V, limit: usize) -> Result<Vec<V>, String> {
    match value {
        V::Array(items) => Ok(items.iter().take(limit).cloned().collect()),
        V::String(units) => {
            let units = &units[..units.len().min(limit)];
            let mut out = Vec::new();
            let mut index = 0;
            while index < units.len() {
                let width = if (0xd800..=0xdbff).contains(&units[index])
                    && units
                        .get(index + 1)
                        .is_some_and(|unit| (0xdc00..=0xdfff).contains(unit))
                {
                    2
                } else {
                    1
                };
                out.push(V::String(units[index..index + width].to_vec()));
                index += width;
            }
            Ok(out)
        }
        _ => Err("value.slice is not a function".into()),
    }
}

fn plan(snapshot: &V) -> V {
    let mut out = Vec::new();
    append(&mut out, "\n\n## 기획팀 컨텍스트\n");
    if snapshot.has("notes") {
        let result = (|| -> Result<(), String> {
            let notes = &snapshot["notes"];
            if notes["error"].truthy() {
                return Err("notes directory unavailable".into());
            }
            let V::Array(records) = &notes["files"] else {
                return Err("notes files unavailable".into());
            };
            let mut files = Vec::new();
            // The source filters the whole directory before its 20-file slice.
            for record in records {
                let V::String(name) = &record["name"] else {
                    return Err("filename.endsWith is not a function".into());
                };
                if name.ends_with(&[46, 106, 115, 111, 110]) {
                    files.push(record);
                }
            }
            files.truncate(20);
            if files.is_empty() {
                append(&mut out, "기존 문서: 없음\n");
            } else {
                append(&mut out, &format!("기존 문서 ({}개):\n", files.len()));
                for record in files {
                    let line = (|| -> Result<Vec<u16>, String> {
                        if !record.has("note") {
                            return Err("note read failed".into());
                        }
                        let note = &record["note"];
                        let mut line = Vec::new();
                        append(&mut line, "- [");
                        put(&mut line, property(note, "id")?.as_ref())?;
                        append(&mut line, "] ");
                        put(
                            &mut line,
                            Some(&value_or(property(note, "title")?, "Untitled".into())),
                        )?;
                        append(&mut line, " (");
                        let content = value_or(property(note, "content")?, "".into());
                        put(&mut line, property(&content, "length")?.as_ref())?;
                        append(&mut line, "자)\n");
                        Ok(line)
                    })();
                    match line {
                        Ok(line) => out.extend(line),
                        Err(_) => {
                            append(&mut out, "- ");
                            put(&mut out, Some(&record["name"]))?;
                            out.push(10);
                        }
                    }
                }
            }
            Ok(())
        })();
        if result.is_err() {
            append(&mut out, "기존 문서: (조회 불가)\n");
        }
    }
    append(&mut out, "\n문서 작성 시 COCKPIT:note-create 명령으로 저장해. 수정은 COCKPIT:note-update.\n기존 문서와 제목/내용이 중복되지 않도록 확인.\n");
    V::String(out)
}

fn projects_team(snapshot: &V, marketing: bool) -> V {
    let mut out = Vec::new();
    append(
        &mut out,
        if marketing {
            "\n\n## 마케팅팀 컨텍스트\n"
        } else {
            "\n\n## 개발팀 컨텍스트\n"
        },
    );
    if snapshot.has("projects") || snapshot["projectsError"].truthy() {
        let _ = (|| -> Result<(), String> {
            let projects = snapshot_value(snapshot, "projects")?;
            if property(&projects, "length")?
                .as_ref()
                .is_some_and(V::truthy)
            {
                append(
                    &mut out,
                    if marketing {
                        "프로젝트 목록 (콘텐츠 대상):\n"
                    } else {
                        "등록된 프로젝트:\n"
                    },
                );
                for project in sliced_items(&projects, 10)? {
                    let mut line = Vec::new();
                    append(&mut line, "- ");
                    put(&mut line, property(&project, "name")?.as_ref())?;
                    append(&mut line, " (");
                    put(
                        &mut line,
                        Some(&value_or(property(&project, "stack")?, "?".into())),
                    )?;
                    line.push(41);
                    if !marketing {
                        append(&mut line, " — ");
                        put(&mut line, property(&project, "path")?.as_ref())?;
                    }
                    line.push(10);
                    out.extend(line);
                }
            }
            Ok(())
        })();
    }
    append(
        &mut out,
        if marketing {
            "\n릴리즈 노트, 공지사항, 마케팅 카피 등 작성 시 COCKPIT:note-create로 저장해.\nGIT_LOG로 최근 변경사항을 확인해서 릴리즈 노트에 반영할 수 있어.\n"
        } else {
            "\n코드리뷰 시 GIT_DIFF로 변경사항을 확인하고, 보안/성능/가독성 관점에서 리뷰해.\nBASH로 테스트 실행, READ로 관련 코드 확인 가능.\n"
        },
    );
    V::String(out)
}

fn fixed_three(value: &V) -> Result<V, String> {
    fixed_decimal(value, 3)
}

/// JavaScript toFixed rounding for the 0–3 fractional digits in agent text.
pub(crate) fn fixed_decimal(value: &V, digits: usize) -> Result<V, String> {
    assert!(
        digits <= 3,
        "agent decimal formatting supports at most three digits"
    );
    let V::Number(number) = value else {
        return Err("value.toFixed is not a function".into());
    };
    if !number.is_finite() || number.abs() >= 1e21 {
        return string(value);
    }
    let negative = *number < 0.0;
    let bits = number.abs().to_bits();
    let stored_exponent = (bits >> 52) & 0x7ff;
    let fraction = bits & ((1u64 << 52) - 1);
    let (mantissa, exponent) = if stored_exponent == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1u64 << 52), stored_exponent as i32 - 1023 - 52)
    };
    // Integer arithmetic preserves the original binary float and chooses the
    // larger decimal integer at exact ties, as Number.prototype.toFixed does.
    let scale = 10u128.pow(digits as u32);
    let scaled = mantissa as u128 * scale;
    let rounded = if exponent >= 0 {
        scaled << exponent
    } else if exponent <= -128 {
        0
    } else {
        let shift = (-exponent) as u32;
        let divisor = 1u128 << shift;
        scaled / divisor + u128::from(scaled % divisor >= divisor / 2)
    };
    let sign = if negative { "-" } else { "" };
    Ok(if digits == 0 {
        format!("{sign}{rounded}")
    } else {
        format!("{sign}{}.{:0digits$}", rounded / scale, rounded % scale)
    }
    .into())
}

fn admin(snapshot: &V) -> V {
    let mut out = Vec::new();
    append(&mut out, "\n\n## 경영지원 컨텍스트\n");
    if snapshot.has("cost") && !snapshot["costError"].truthy() {
        let _ = (|| -> Result<(), String> {
            let cost = &snapshot["cost"];
            if *cost == V::Null {
                return Ok(());
            }
            if let Some(today) = property(cost, "today")?.filter(V::truthy) {
                let mut line = Vec::new();
                append(&mut line, "[오늘 현황] 비용: $");
                let cost = value_or(property(&today, "apiEquivCost")?, V::Number(0.0));
                put(&mut line, Some(&fixed_three(&cost)?))?;
                append(&mut line, " | 메시지: ");
                put(
                    &mut line,
                    Some(&value_or(property(&today, "messages")?, V::Number(0.0))),
                )?;
                append(&mut line, " | 세션: ");
                put(
                    &mut line,
                    Some(&value_or(property(&today, "sessions")?, V::Number(0.0))),
                )?;
                line.push(10);
                out.extend(line);
            }
            Ok(())
        })();
    }
    if snapshot.has("serviceProjects") && !snapshot["serviceProjectsError"].truthy() {
        let _ = (|| -> Result<(), String> {
            let count = property(&snapshot["serviceProjects"], "length")?;
            let mut line = Vec::new();
            append(&mut line, "등록 프로젝트: ");
            put(&mut line, count.as_ref())?;
            append(&mut line, "개\n");
            out.extend(line);
            Ok(())
        })();
    }
    append(&mut out, "\nCOCKPIT:usage로 상세 비용, COCKPIT:system으로 시스템 상태, COCKPIT:projects로 프로젝트 목록 조회 가능.\n보고서 작성 시 COCKPIT:note-create로 저장해.\n");
    V::String(out)
}

fn design(snapshot: &V) -> V {
    let mut out = Vec::new();
    append(&mut out, "\n\n## 디자인팀 컨텍스트\n");
    if snapshot.has("roots") || snapshot["rootsError"].truthy() {
        let _ = (|| -> Result<(), String> {
            let roots = snapshot_value(snapshot, "roots")?;
            if property(&roots, "length")?.as_ref().is_some_and(V::truthy) {
                append(&mut out, "프로젝트 루트 (스타일 파일 탐색용):\n");
                for root in sliced_items(&roots, 5)? {
                    let mut line = Vec::new();
                    append(&mut line, "- ");
                    put(&mut line, Some(&root))?;
                    line.push(10);
                    out.extend(line);
                }
            }
            Ok(())
        })();
    }
    append(&mut out, "\nGLOB으로 *.css, *.scss 파일 검색, READ로 스타일 파일 분석 가능.\n스타일 감사 시 일관성(변수 사용, 색상 팔레트), 접근성(대비율, 폰트 크기), 반응형 체크.\n개선 제안은 COCKPIT:note-create로 문서화해.\n");
    V::String(out)
}

pub fn team(profile: &V, snapshot: &V) -> Result<V, String> {
    Ok(match &profile["team"] {
        value if *value == V::from("plan") => plan(snapshot),
        value if *value == V::from("dev") => projects_team(snapshot, false),
        value if *value == V::from("admin") => admin(snapshot),
        value if *value == V::from("marketing") => projects_team(snapshot, true),
        value if *value == V::from("design") => design(snapshot),
        _ => "".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;

    fn json(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }

    #[test]
    fn reference_contexts_match_original_javascript() {
        let fixtures = json(include_str!("../../tests/fixtures/rust-agent-context.json"));
        assert_eq!(fixtures.array().len(), 259);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let result = match input["action"].text().as_str() {
                "project" => project(&input["snapshot"]),
                "team" => team(&input["profile"], &input["snapshot"]),
                _ => panic!("unexpected context fixture action"),
            };
            let actual = match result {
                Ok(value) => object([("value", value)]),
                Err(error) => object([("error", error.into())]),
            };
            assert_eq!(actual, fixture["expected"], "context fixture {index}");
        }
    }

    #[test]
    fn project_branches_keep_root_alignment_and_utf16() {
        let snapshot = json(
            r#"{"projects":[{"name":"한\ud800","path":"/a"},{"name":"b","path":"/b","stack":"Rust"}],"roots":["","/b"],"branches":["ignored","main\udc00"]}"#,
        );
        let result = project(&snapshot).unwrap();
        assert!(result.units().contains(&0xd800));
        assert!(result.units().contains(&0xdc00));
        assert!(!result.text().contains("ignored"));
        assert!(result
            .text()
            .contains("[?] /a\n- **b** [Rust] /b (branch: main"));
    }

    #[test]
    fn notes_distinguish_missing_empty_unavailable_and_malformed() {
        let profile = object([("team", "plan".into())]);
        assert!(!team(&profile, &V::object())
            .unwrap()
            .text()
            .contains("기존 문서:"));
        assert!(team(&profile, &json(r#"{"notes":{"files":[]}}"#))
            .unwrap()
            .text()
            .contains("기존 문서: 없음"));
        assert!(team(&profile, &json(r#"{"notes":{"error":true}}"#))
            .unwrap()
            .text()
            .contains("기존 문서: (조회 불가)"));
        let snapshot = json(
            r#"{"notes":{"files":[{"name":"ignored.txt"},{"name":"ok.json","note":{"id":"N","content":"😀\ud800"}},{"name":"null.json","note":null},{"name":"broken.json"}]}}"#,
        );
        let result = team(&profile, &snapshot).unwrap().text();
        assert!(
            result.contains("기존 문서 (3개):\n- [N] Untitled (3자)\n- null.json\n- broken.json\n")
        );
        assert!(!result.contains("ignored.txt"));
    }

    #[test]
    fn optional_context_keeps_completed_lines_when_later_entry_fails() {
        let snapshot = json(
            r#"{"projects":[{"name":"first","path":"/first"},null,{"name":"last"}],"roots":["/first",{"toString":null},"/last"]}"#,
        );
        let dev = team(&object([("team", "dev".into())]), &snapshot)
            .unwrap()
            .text();
        assert!(dev.contains("- first (?) — /first\n"));
        assert!(!dev.contains("last"));
        assert!(dev.ends_with("BASH로 테스트 실행, READ로 관련 코드 확인 가능.\n"));
        let design = team(&object([("team", "design".into())]), &snapshot)
            .unwrap()
            .text();
        assert!(design.contains("- /first\n"));
        assert!(!design.contains("/last"));
        assert!(project(&snapshot).is_err());
    }

    #[test]
    fn costs_use_binary_float_rounding_and_do_not_coerce_strings() {
        for (value, expected) in [
            (0.0625, "0.063"),
            (-0.0625, "-0.063"),
            (1.0005, "1.000"),
            (-0.00001, "-0.000"),
            (f64::MIN_POSITIVE, "0.000"),
            (1e21, "1e+21"),
            (-1e21, "-1e+21"),
        ] {
            assert_eq!(fixed_three(&V::Number(value)).unwrap(), V::from(expected));
        }
        let profile = object([("team", "admin".into())]);
        let result = team(
            &profile,
            &json(r#"{"cost":{"today":{"apiEquivCost":"1.5"}},"serviceProjects":[]}"#),
        )
        .unwrap()
        .text();
        assert!(!result.contains("[오늘 현황]"));
        assert!(result.contains("등록 프로젝트: 0개"));
    }

    #[test]
    fn list_limits_apply_before_the_optional_loop() {
        let projects = V::Array(
            (0..12)
                .map(|index| object([("name", format!("p{index}").into())]))
                .collect(),
        );
        let roots = V::Array((0..7).map(|index| format!("root{index}").into()).collect());
        let snapshot = object([("projects", projects), ("roots", roots)]);
        let dev = team(&object([("team", "dev".into())]), &snapshot)
            .unwrap()
            .text();
        assert!(dev.contains("- p9"));
        assert!(!dev.contains("- p10"));
        let design = team(&object([("team", "design".into())]), &snapshot)
            .unwrap()
            .text();
        assert!(design.contains("root4"));
        assert!(!design.contains("root5"));
    }
}
