//! Compatible recovery snapshots without following filesystem links or replacing
//! damaged JSON with an apparently successful empty checkpoint.
use crate::board_value::{object, V};
use serde::{ser::SerializeMap, ser::SerializeSeq, Serialize, Serializer};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};

const MAX_BYTES: usize = 32 * 1024 * 1024;
const GUIDE: &str = "콕핏 복구 히스토리\n\nlatest.json: 마지막 저장 시점의 목표, 체크리스트, 질문·답변, 작업 보고, 세션 배치, 프로젝트 등록 정보입니다. 서버 실행 중 약 30초마다 갱신합니다.\n작업요약.txt: 최근 결과, 다음 작업, 막힌 이유를 읽기 위한 요약입니다.\n날짜_시간.json: UTC 기준 각 시간의 첫 저장본입니다. 최근 50개를 보관합니다.\n\n일반 재부팅 뒤에는 콕핏을 실행하면 원래 데이터 폴더의 설정과 작업 배치를 복원합니다. 저장된 일시정지·대화 보호·운영 기한도 유지합니다. 전원이 꺼질 때 실행 중이던 명령은 완료 여부를 별도로 확인해야 합니다.\n\n데이터가 손상되면 설치 폴더의 scripts/cockpit-history.mjs에 복구본 JSON 절대경로와 새 출력 폴더 절대경로를 전달하세요. 기존 데이터를 덮어쓰지 않고 복구 파일과 안내를 생성합니다.\n\n계정 인증 파일, API 키 설정, 터미널 출력, 채팅 원문과 프로젝트 실제 파일은 수집하지 않습니다. 기존 홈 폴더와 프로젝트를 유지하세요.\n";

struct Pretty<'a>(&'a V);
impl Serialize for Pretty<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            V::Object(values) => {
                let mut map = serializer.serialize_map(Some(values.len()))?;
                for (key, value) in values {
                    map.serialize_entry(key, &Pretty(value))?;
                }
                map.end()
            }
            V::Array(values) => {
                let mut array = serializer.serialize_seq(Some(values.len()))?;
                for value in values {
                    array.serialize_element(&Pretty(value))?;
                }
                array.end()
            }
            value => value.raw().serialize(serializer),
        }
    }
}

fn records(value: &V) -> bool {
    matches!(value, V::Array(rows) if rows.iter().all(|row| matches!(row, V::Object(_))))
}
fn valid_parts(board: &V, state: &V, projects: &V) -> bool {
    matches!(board, V::Object(_))
        && records(&board["supervisors"])
        && records(&board["tasks"])
        && matches!(state, V::Object(_))
        && records(&state["terminals"])
        && records(projects)
        && board["supervisors"].array().iter().all(|review| {
            ["watched", "workerProgress"]
                .iter()
                .all(|key| !review[*key].truthy() || records(&review[*key]))
        })
}
fn parse_snapshot(bytes: &[u8]) -> Result<V, String> {
    let raw = serde_json::from_slice::<Box<serde_json::value::RawValue>>(bytes)
        .map_err(|_| "Damaged recovery history; original data preserved")?;
    let snapshot =
        V::parse(&raw).map_err(|_| "Damaged recovery history; original data preserved")?;
    if snapshot["schemaVersion"] != V::Number(1.0)
        || !matches!(&snapshot["savedAt"], V::Number(value) if value.is_finite())
        || !valid_parts(
            &snapshot["board"],
            &snapshot["sessionState"],
            &snapshot["projects"]["projects"],
        )
    {
        return Err("Damaged recovery history; original data preserved".into());
    }
    Ok(snapshot)
}

#[cfg(unix)]
fn dates(now: i64) -> Result<(String, String), String> {
    if !(-8_640_000_000_000_000..=8_640_000_000_000_000).contains(&now) {
        return Err("Invalid recovery timestamp".into());
    }
    let seconds = now.div_euclid(1000) as libc::time_t;
    let mut utc: libc::tm = unsafe { std::mem::zeroed() };
    let mut local: libc::tm = unsafe { std::mem::zeroed() };
    if unsafe { libc::gmtime_r(&seconds, &mut utc) }.is_null()
        || unsafe { libc::localtime_r(&seconds, &mut local) }.is_null()
    {
        return Err("Invalid recovery timestamp".into());
    }
    let year = utc.tm_year + 1900;
    let year = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else {
        format!("{year:+07}")
    };
    // Match Date.toISOString().slice(0, 13), including extended-year dates.
    let iso = format!(
        "{year}-{:02}-{:02}T{:02}",
        utc.tm_mon + 1,
        utc.tm_mday,
        utc.tm_hour
    );
    let hourly = format!(
        "{}.json",
        iso.chars().take(13).collect::<String>().replace('T', "_")
    );
    let local = format!(
        "{}. {}. {}. {} {}:{:02}:{:02}",
        local.tm_year + 1900,
        local.tm_mon + 1,
        local.tm_mday,
        if local.tm_hour < 12 {
            "오전"
        } else {
            "오후"
        },
        if local.tm_hour % 12 == 0 {
            12
        } else {
            local.tm_hour % 12
        },
        local.tm_min,
        local.tm_sec
    );
    Ok((hourly, local))
}
#[cfg(not(unix))]
fn dates(_now: i64) -> Result<(String, String), String> {
    Err("Native recovery history is only validated on Linux".into())
}

fn property(value: &V, key: &str) -> Result<String, String> {
    Ok(crate::agent_prompt::property_string(value, key)?.text())
}
fn fallback(values: &[&V], default: &str) -> Result<String, String> {
    values.iter().find(|value| value.truthy()).map_or_else(
        || Ok(default.to_owned()),
        |value| Ok(crate::agent_prompt::string(value)?.text()),
    )
}
fn alternate(value: &V, first: &str, second: &str) -> Result<String, String> {
    if value[first].truthy() {
        property(value, first)
    } else {
        property(value, second)
    }
}
fn summary(board: &V, state: &V, date: &str) -> Result<String, String> {
    let mut lines = vec![
        format!("콕핏 작업 기록 · {date}"),
        String::new(),
        "이 파일은 저장된 업무 상태입니다. 재부팅 전 명령이 성공했다는 뜻은 아닙니다.".into(),
        "다시 시작할 때 실행 중이던 외부 작업의 결과부터 확인하고 중복 실행하지 마세요.".into(),
        String::new(),
    ];
    for review in board["supervisors"].array() {
        lines.extend([
            format!(
                "{} · {} · {}",
                property(review, "id")?,
                alternate(review, "alias", "name")?,
                property(review, "status")?
            ),
            format!("전체 목표: {}", fallback(&[&review["objective"]], "없음")?),
            format!(
                "자동 진행: {}",
                fallback(&[&review["workerDispatch"]], "linked")?
            ),
        ]);
        for target in review["watched"].array() {
            let worker = review["workerProgress"]
                .array()
                .iter()
                .find(|worker| {
                    worker["termId"] == target["termId"] && worker["goal"] == target["goal"]
                })
                .unwrap_or(&V::Null);
            let run = &worker["run"];
            lines.extend([
                String::new(),
                format!(
                    "{} · {}",
                    alternate(target, "alias", "termId")?,
                    property(target, "termId")?
                ),
                format!("목표: {}", alternate(target, "objective", "goal")?),
                format!("완료 조건: {}", property(target, "goal")?),
                format!(
                    "우선순위: {} · 일시정지: {}",
                    fallback(&[&target["priority"]], "2")?,
                    target["paused"].truthy()
                ),
                format!("저장 상태: {}", fallback(&[&run["status"]], "ready")?),
                format!("최근 결과: {}", fallback(&[&run["summary"]], "없음")?),
                format!(
                    "다음 작업: {}",
                    fallback(&[&run["nextAction"], &worker["nextAction"]], "없음")?
                ),
                format!(
                    "막힘: {}",
                    fallback(&[&run["blocker"], &worker["blocker"]], "없음")?
                ),
                format!(
                    "작업자 보고 근거: {}",
                    fallback(&[&run["evidence"]], "없음")?
                ),
                format!("검증 근거: {}", fallback(&[&worker["evidence"]], "없음")?),
            ]);
        }
        lines.push(String::new());
    }
    lines.push("체크리스트·질문".into());
    for task in board["tasks"].array() {
        lines.push(format!(
            "[{}] {} · {} · {}{}",
            if task["done"].truthy() { "x" } else { " " },
            property(task, "id")?,
            fallback(&[&task["termId"], &task["supervisorId"]], "")?,
            property(task, "text")?,
            if task["answer"].truthy() {
                format!("\n답변: {}", property(task, "answer")?)
            } else {
                String::new()
            }
        ));
    }
    lines.extend([String::new(), "세션 배치".into()]);
    for terminal in state["terminals"].array() {
        lines.push(format!(
            "{} · {} · {} · 대화 보호 {}",
            alternate(terminal, "alias", "termId")?,
            property(terminal, "termId")?,
            fallback(&[&terminal["cwd"]], "")?,
            terminal["conversationHeld"].truthy()
        ));
    }
    // Node writes UTF-8 text: lone UTF-16 surrogates become U+FFFD in this human
    // summary. The JSON serializer above retains their original escaped units.
    Ok(format!("{}\n", lines.join("\n")))
}

fn hour_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() == 18
        && &bytes[13..] == b".json"
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'_'
        && [0, 1, 2, 3, 5, 6, 8, 9, 11, 12]
            .iter()
            .all(|index| bytes[*index].is_ascii_digit())
}

struct Storage {
    directory: File,
    path: PathBuf,
}
impl Storage {
    #[cfg(target_os = "linux")]
    fn open(root: &Path) -> Result<Self, String> {
        use std::{
            ffi::CString,
            os::{
                fd::{AsRawFd, FromRawFd},
                unix::{ffi::OsStrExt, fs::OpenOptionsExt},
            },
        };
        if !root.is_absolute() {
            return Err("Recovery data directory must be absolute".into());
        }
        let mut directory = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open("/")
            .map_err(|e| e.to_string())?;
        let leaf_index = root.components().count();
        for (index, component) in root
            .components()
            .chain(Path::new("recovery-history").components())
            .enumerate()
        {
            let name = match component {
                Component::RootDir | Component::CurDir => continue,
                Component::Normal(name) => {
                    CString::new(name.as_bytes()).map_err(|_| "Invalid recovery path")?
                }
                _ => return Err("Invalid recovery path".into()),
            };
            // The supplied data directory must exist. Only create our own leaf.
            if index == leaf_index {
                let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if result != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(io::Error::last_os_error().to_string());
                }
                if result == 0 {
                    directory.sync_all().map_err(|e| e.to_string())?;
                }
            }
            let fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(io::Error::last_os_error().to_string());
            }
            directory = unsafe { File::from_raw_fd(fd) };
        }
        let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()));
        Ok(Self { directory, path })
    }
    #[cfg(not(target_os = "linux"))]
    fn open(_root: &Path) -> Result<Self, String> {
        Err("Native recovery history is only validated on Linux".into())
    }
    fn bytes(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let mut options = OpenOptions::new();
        options.read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        let file = match options.open(self.path.join(name)) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !file.metadata().map_err(|e| e.to_string())?.is_file() {
            return Err("Recovery history must be a regular file".into());
        }
        let mut bytes = Vec::new();
        file.take((MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > MAX_BYTES {
            return Err("Recovery snapshot exceeds size limit".into());
        }
        Ok(Some(bytes))
    }
    fn temporary(&self, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
        let mut file = tempfile::NamedTempFile::new_in(&self.path).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.as_file()
                .set_permissions(fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        file.write_all(bytes).map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        Ok(file)
    }
    fn persist(
        &self,
        name: &str,
        file: tempfile::NamedTempFile,
        before: &Option<Vec<u8>>,
        immutable: bool,
    ) -> Result<(), String> {
        if &self.bytes(name)? != before {
            return Err("Recovery history changed during save".into());
        }
        if immutable {
            file.persist_noclobber(self.path.join(name))
                .map_err(|e| e.error.to_string())?;
        } else {
            file.persist(self.path.join(name))
                .map_err(|e| e.error.to_string())?;
        }
        self.directory.sync_all().map_err(|e| e.to_string())
    }
    fn hours(&self) -> Result<Vec<String>, String> {
        let mut names = Vec::new();
        for entry in fs::read_dir(&self.path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let Some(name) = entry.file_name().to_str().map(String::from) else {
                continue;
            };
            if hour_name(&name) {
                names.push(name);
            }
        }
        names.sort();
        Ok(names)
    }
}

pub struct Store {
    directory: PathBuf,
    writer: Mutex<()>,
}
impl Store {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            directory: data_directory,
            writer: Mutex::new(()),
        }
    }
    pub fn save(&self, board: &V, session_state: &V, projects: &V, now: i64) -> Result<(), String> {
        if !valid_parts(board, session_state, projects) {
            return Err("Invalid recovery input; original data preserved".into());
        }
        let (hour, local_date) = dates(now)?;
        let registrations = projects
            .array()
            .iter()
            .map(|project| {
                let mut registration = V::object();
                for key in ["id", "name", "path", "color", "stack"] {
                    if project.has(key) {
                        registration[key] = project[key].clone();
                    }
                }
                registration
            })
            .collect();
        let snapshot = object([
            ("schemaVersion", V::Number(1.0)),
            ("savedAt", V::Number(now as f64)),
            ("board", board.clone()),
            ("sessionState", session_state.clone()),
            ("projects", object([("projects", V::Array(registrations))])),
        ]);
        let mut json = serde_json::to_vec_pretty(&Pretty(&snapshot)).map_err(|e| e.to_string())?;
        json.push(b'\n');
        let summary = summary(board, session_state, &local_date)?;
        if json.len() > MAX_BYTES || summary.len() > MAX_BYTES {
            return Err("Recovery snapshot exceeds size limit".into());
        }
        let _guard = self
            .writer
            .lock()
            .map_err(|_| "Recovery writer unavailable")?;
        let storage = Storage::open(&self.directory)?;
        let mut hours = storage.hours()?;
        if hour_name(&hour) && !hours.contains(&hour) {
            hours.push(hour.clone());
            hours.sort();
        }
        let expired = &hours[..hours.len().saturating_sub(50)];
        // Validate this save's current checkpoints and deletion targets before
        // changing anything. Retained history needs only a directory listing;
        // an older damaged snapshot remains untouched until retention reaches it.
        for name in expired
            .iter()
            .map(String::as_str)
            .chain(["latest.json", hour.as_str()])
        {
            if let Some(bytes) = storage.bytes(name)? {
                parse_snapshot(&bytes)?;
            }
        }
        let destinations = [
            ("latest.json", json.as_slice(), false),
            ("작업요약.txt", summary.as_bytes(), false),
            ("안내.txt", GUIDE.as_bytes(), true),
            (hour.as_str(), json.as_slice(), true),
        ];
        let mut writes = Vec::new();
        for (name, bytes, immutable) in destinations {
            let before = storage.bytes(name)?;
            if immutable && before.is_some() {
                continue;
            }
            writes.push((name, storage.temporary(bytes)?, before, immutable));
        }
        for (name, file, before, immutable) in writes {
            storage.persist(name, file, &before, immutable)?;
        }
        for name in expired {
            if let Some(bytes) = storage.bytes(name)? {
                parse_snapshot(&bytes)?;
            }
            fs::remove_file(storage.path.join(name)).map_err(|e| e.to_string())?;
        }
        storage.directory.sync_all().map_err(|e| e.to_string())
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::{
        os::unix::{fs::symlink, fs::PermissionsExt},
        sync::Arc,
    };

    fn value(text: &str) -> V {
        V::parse(&serde_json::value::RawValue::from_string(text.into()).unwrap()).unwrap()
    }
    fn inputs() -> (V, V, V) {
        (
            value(
                r#"{"supervisors":[{"id":"S-0001","alias":"ai8","status":"running","objective":"운영 준비","watched":[{"termId":"term-1","alias":"ai1","goal":"검증 완료","priority":0,"paused":true}],"workerProgress":[{"termId":"term-1","goal":"검증 완료","nextAction":"확인","blocker":"기존 막힘","evidence":"검증 근거","run":{"status":"working","summary":"진행 중","blocker":"현재 막힘","evidence":"작업 근거"}}]}],"tasks":[{"id":"T-0001","termId":"term-1","text":"체크 😀\ud800","done":true,"answer":"답변"}],"future":{"keep":"\udc00"}}"#,
            ),
            value(
                r#"{"terminals":[{"termId":"term-1","alias":"ai1","cwd":"/private/project","conversationHeld":true}],"timestamp":1,"future":"preserve"}"#,
            ),
            value(
                r#"[{"id":"p","name":"프로젝트","path":"/private/project","color":"blue","stack":"node","token":"must-not-copy","output":"must-not-copy","unknown":"must-not-copy"}]"#,
            ),
        )
    }
    fn saved(directory: &Path, name: &str) -> Vec<u8> {
        fs::read(directory.join("recovery-history").join(name)).unwrap()
    }
    #[test]
    fn preserves_snapshot_fields_utf16_project_projection_and_korean_summary() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (board, state, projects) = inputs();
        store
            .save(&board, &state, &projects, 1_700_000_000_000)
            .unwrap();
        let raw = saved(directory.path(), "latest.json");
        let snapshot = parse_snapshot(&raw).unwrap();
        assert_eq!(snapshot["board"], board);
        assert_eq!(snapshot["sessionState"], state);
        assert_eq!(
            snapshot["projects"]["projects"].array()[0],
            value(
                r#"{"id":"p","name":"프로젝트","path":"/private/project","color":"blue","stack":"node"}"#
            )
        );
        assert!(!String::from_utf8(raw).unwrap().contains("must-not-copy"));
        let text = String::from_utf8(saved(directory.path(), "작업요약.txt")).unwrap();
        let expected = "\n\n이 파일은 저장된 업무 상태입니다. 재부팅 전 명령이 성공했다는 뜻은 아닙니다.\n다시 시작할 때 실행 중이던 외부 작업의 결과부터 확인하고 중복 실행하지 마세요.\n\nS-0001 · ai8 · running\n전체 목표: 운영 준비\n자동 진행: linked\n\nai1 · term-1\n목표: 검증 완료\n완료 조건: 검증 완료\n우선순위: 2 · 일시정지: true\n저장 상태: working\n최근 결과: 진행 중\n다음 작업: 확인\n막힘: 현재 막힘\n작업자 보고 근거: 작업 근거\n검증 근거: 검증 근거\n\n체크리스트·질문\n[x] T-0001 · term-1 · 체크 😀�\n답변: 답변\n\n세션 배치\nai1 · term-1 · /private/project · 대화 보호 true\n";
        assert!(text.starts_with("콕핏 작업 기록 · "));
        assert_eq!(&text[text.find('\n').unwrap()..], expected);
        assert_eq!(saved(directory.path(), "안내.txt"), GUIDE.as_bytes());
        assert_eq!(
            fs::metadata(directory.path().join("recovery-history/latest.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    #[test]
    fn first_hour_and_existing_guide_are_immutable_and_only_fifty_hours_remain() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (mut board, state, projects) = inputs();
        let start = 1_700_000_000_000;
        store.save(&board, &state, &projects, start).unwrap();
        let first = dates(start).unwrap().0;
        let original = saved(directory.path(), &first);
        fs::write(
            directory.path().join("recovery-history/안내.txt"),
            "operator note",
        )
        .unwrap();
        board["future"] = "new".into();
        store.save(&board, &state, &projects, start + 1000).unwrap();
        assert_eq!(saved(directory.path(), &first), original);
        assert_eq!(saved(directory.path(), "안내.txt"), b"operator note");
        fs::write(
            directory.path().join("recovery-history/unrelated.json"),
            "keep",
        )
        .unwrap();
        for hour in 1..=51 {
            store
                .save(&board, &state, &projects, start + hour * 3_600_000)
                .unwrap();
        }
        let names = Storage::open(directory.path()).unwrap().hours().unwrap();
        assert_eq!(names.len(), 50);
        assert_eq!(names[0], dates(start + 2 * 3_600_000).unwrap().0);
        assert_eq!(names[49], dates(start + 51 * 3_600_000).unwrap().0);
        assert_eq!(saved(directory.path(), "unrelated.json"), b"keep");
    }
    #[test]
    fn malformed_input_and_damaged_existing_json_preserve_all_previous_files() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (board, state, projects) = inputs();
        let now = 1_700_000_000_000;
        store.save(&board, &state, &projects, now).unwrap();
        let latest = saved(directory.path(), "latest.json");
        assert!(store
            .save(&board, &V::object(), &projects, now + 1000)
            .is_err());
        assert_eq!(saved(directory.path(), "latest.json"), latest);
        for name in ["latest.json".to_owned(), dates(now).unwrap().0] {
            let path = directory.path().join("recovery-history").join(&name);
            let original = fs::read(&path).unwrap();
            fs::write(&path, "{broken").unwrap();
            assert!(store.save(&board, &state, &projects, now + 1000).is_err());
            assert_eq!(fs::read(&path).unwrap(), b"{broken");
            fs::write(path, original).unwrap();
            assert_eq!(saved(directory.path(), "latest.json"), latest);
        }
    }
    #[test]
    fn damaged_retained_hour_does_not_block_latest_but_expiration_fails_before_writes() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (board, state, projects) = inputs();
        let now = 1_700_000_000_000;
        store.save(&board, &state, &projects, now).unwrap();
        let first = dates(now).unwrap().0;
        fs::write(
            directory.path().join("recovery-history").join(&first),
            "{retained-broken",
        )
        .unwrap();
        store
            .save(&board, &state, &projects, now + 3_600_000)
            .unwrap();
        let latest = saved(directory.path(), "latest.json");
        assert_eq!(
            parse_snapshot(&latest).unwrap()["savedAt"],
            V::Number((now + 3_600_000) as f64)
        );
        assert_eq!(saved(directory.path(), &first), b"{retained-broken");
        // Fill only the fixture's retained file names. The next save would prune
        // the damaged first hour, so it must fail before replacing latest.json.
        for hour in 2..50 {
            fs::write(
                directory
                    .path()
                    .join("recovery-history")
                    .join(dates(now + hour * 3_600_000).unwrap().0),
                &latest,
            )
            .unwrap();
        }
        let next = now + 50 * 3_600_000;
        assert!(store.save(&board, &state, &projects, next).is_err());
        assert_eq!(saved(directory.path(), "latest.json"), latest);
        assert_eq!(saved(directory.path(), &first), b"{retained-broken");
        assert!(!directory
            .path()
            .join("recovery-history")
            .join(dates(next).unwrap().0)
            .exists());
        assert_eq!(
            Storage::open(directory.path())
                .unwrap()
                .hours()
                .unwrap()
                .len(),
            50
        );
    }
    #[test]
    fn unsafe_leaf_and_parent_paths_fail_before_checkpoint_replacement() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let (board, state, projects) = inputs();
        let now = 1_700_000_000_000;
        store.save(&board, &state, &projects, now).unwrap();
        let before = saved(directory.path(), "latest.json");
        let target = outside.path().join("sentinel");
        fs::write(&target, "preserve").unwrap();
        let hourly = dates(now).unwrap().0;
        for name in ["latest.json", "작업요약.txt", "안내.txt", hourly.as_str()] {
            let path = directory.path().join("recovery-history").join(name);
            let original = fs::read(&path).unwrap();
            fs::remove_file(&path).unwrap();
            symlink(&target, &path).unwrap();
            assert!(store.save(&board, &state, &projects, now + 1000).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"preserve");
            fs::remove_file(&path).unwrap();
            fs::write(path, original).unwrap();
            assert_eq!(saved(directory.path(), "latest.json"), before);
        }
        let summary = directory.path().join("recovery-history/작업요약.txt");
        fs::remove_file(&summary).unwrap();
        fs::create_dir(&summary).unwrap();
        assert!(store.save(&board, &state, &projects, now + 1000).is_err());
        assert_eq!(saved(directory.path(), "latest.json"), before);
        let linked = directory.path().join("linked");
        symlink(outside.path(), &linked).unwrap();
        assert!(Store::new(linked)
            .save(&board, &state, &projects, now)
            .is_err());
        assert!(!outside.path().join("recovery-history").exists());
    }
    #[test]
    fn opened_directory_cannot_be_redirected_by_a_parent_symlink_swap() {
        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let storage = Storage::open(directory.path()).unwrap();
        let leaf = directory.path().join("recovery-history");
        let moved = directory.path().join("original-history");
        fs::rename(&leaf, &moved).unwrap();
        symlink(outside.path(), &leaf).unwrap();
        storage
            .persist(
                "latest.json",
                storage.temporary(b"anchored").unwrap(),
                &None,
                false,
            )
            .unwrap();
        assert_eq!(fs::read(moved.join("latest.json")).unwrap(), b"anchored");
        assert!(!outside.path().join("latest.json").exists());
        assert!(Storage::open(directory.path()).is_err());
    }
    #[test]
    fn concurrent_saves_share_one_writer_and_keep_valid_snapshots() {
        let directory = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::new(directory.path().into()));
        let mut jobs = Vec::new();
        for hour in 0..8 {
            let store = store.clone();
            jobs.push(std::thread::spawn(move || {
                let (board, state, projects) = inputs();
                store
                    .save(
                        &board,
                        &state,
                        &projects,
                        1_700_000_000_000 + hour * 3_600_000,
                    )
                    .unwrap();
            }));
        }
        for job in jobs {
            job.join().unwrap();
        }
        let storage = Storage::open(directory.path()).unwrap();
        let hours = storage.hours().unwrap();
        assert_eq!(hours.len(), 8);
        for name in hours.iter().map(String::as_str).chain(["latest.json"]) {
            parse_snapshot(&storage.bytes(name).unwrap().unwrap()).unwrap();
        }
        assert_eq!(
            fs::read_dir(directory.path().join("recovery-history"))
                .unwrap()
                .count(),
            11
        );
    }
}
