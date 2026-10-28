use crate::board_value::{object, V};
use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::value::RawValue;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
};

pub struct Record {
    pub profile: V,
    pub id: String,
    pub provider: String,
    pub home: PathBuf,
    pub source: String,
    pub updated_at: String,
}

fn is_wsl() -> bool {
    cfg!(target_os = "linux")
        && std::env::var("WSL_DISTRO_NAME").is_ok_and(|value| !value.is_empty())
}

pub fn runtime() -> &'static str {
    if is_wsl() {
        "WSL"
    } else if cfg!(windows) {
        "Windows"
    } else {
        "Linux"
    }
}

fn windows_to_wsl_path(value: &str) -> String {
    let path = V::from(value).trim().text();
    let bytes = path.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'/' | b'\\')
    {
        format!(
            "/mnt/{}/{}",
            (bytes[0] as char).to_ascii_lowercase(),
            path[3..].replace('\\', "/")
        )
    } else {
        path
    }
}

pub fn candidates(directory: &Path) -> Vec<(PathBuf, String)> {
    candidate_paths(
        directory,
        is_wsl(),
        &std::env::var("AI_HUB_LAUNCHER_ROOT").unwrap_or_default(),
        &std::env::var("COCKPIT_WINDOWS_HOME").unwrap_or_default(),
        &std::env::var("USER").unwrap_or_default(),
    )
}

/// Legacy discovery uses the supplied real home without widening preview reads.
/// Call from a Tokio blocking task to enable the bounded Windows-home fallback.
pub fn candidates_legacy(home: &Path) -> Vec<(PathBuf, String)> {
    legacy_candidate_paths(
        home,
        is_wsl(),
        &std::env::var("AI_HUB_LAUNCHER_ROOT").unwrap_or_default(),
        &std::env::var("COCKPIT_WINDOWS_HOME").unwrap_or_default(),
        &std::env::var("USER").unwrap_or_default(),
        Path::exists,
        host_windows_home,
    )
}

fn host_windows_home() -> String {
    let Ok(runtime) = tokio::runtime::Handle::try_current() else {
        return String::new();
    };
    let mut command = tokio::process::Command::new("cmd.exe");
    command.args(["/d", "/c", "echo", "%USERPROFILE%"]);
    let result = runtime.block_on(crate::process_owned::run(
        command,
        std::time::Duration::from_secs(2),
        4096,
        &crate::ai_transport::Cancel::default(),
    ));
    match result {
        Ok(output) if output.status.success() => {
            V::from(String::from_utf8_lossy(&output.stdout).into_owned())
                .trim()
                .text()
        }
        _ => String::new(),
    }
}

fn legacy_candidate_paths(
    home: &Path,
    wsl: bool,
    configured: &str,
    windows_home: &str,
    user: &str,
    exists: impl FnOnce(&Path) -> bool,
    detect: impl FnOnce() -> String,
) -> Vec<(PathBuf, String)> {
    let mut candidates = candidate_home_paths(home, wsl, configured, windows_home, user);
    let guessed = PathBuf::from(format!(
        "/mnt/c/Users/{user}/.codex-account-launcher/profiles.json"
    ));
    if wsl && windows_home.is_empty() && (user.is_empty() || !exists(&guessed)) {
        let detected = detect();
        if !detected.is_empty() {
            let path = PathBuf::from(windows_to_wsl_path(&detected))
                .join(".codex-account-launcher/profiles.json");
            let key = path.to_string_lossy().replace('\\', "/").to_lowercase();
            if !candidates.iter().any(|(existing, _)| {
                existing.to_string_lossy().replace('\\', "/").to_lowercase() == key
            }) {
                candidates.push((path, "Windows".into()));
            }
        }
    }
    candidates
}

fn candidate_paths(
    directory: &Path,
    wsl: bool,
    configured: &str,
    windows_home: &str,
    user: &str,
) -> Vec<(PathBuf, String)> {
    candidate_home_paths(&directory.join("home"), wsl, configured, windows_home, user)
}

fn candidate_home_paths(
    home: &Path,
    wsl: bool,
    configured: &str,
    windows_home: &str,
    user: &str,
) -> Vec<(PathBuf, String)> {
    let mut result = Vec::new();
    let mut seen = HashSet::new();
    let mut add = |root: &str, source: &str| {
        if root.is_empty() {
            return;
        }
        let root = if wsl {
            windows_to_wsl_path(root)
        } else {
            root.to_owned()
        };
        let path = PathBuf::from(root).join("profiles.json");
        let key = path.to_string_lossy().replace('\\', "/").to_lowercase();
        if seen.insert(key) {
            result.push((path, source.to_owned()));
        }
    };
    add(configured, "Configured");
    add(
        &home.join(".codex-account-launcher").to_string_lossy(),
        if wsl { "WSL" } else { "Local" },
    );
    if wsl {
        if !windows_home.is_empty() {
            add(
                &PathBuf::from(windows_to_wsl_path(windows_home))
                    .join(".codex-account-launcher")
                    .to_string_lossy(),
                "Windows",
            );
        }
        if !user.is_empty() {
            add(
                &format!("/mnt/c/Users/{user}/.codex-account-launcher"),
                "Windows",
            );
        }
        // Preview stops at these candidates. Only the legacy caller may probe
        // cmd.exe when neither an explicit nor an existing guessed home works.
    }
    result
}

pub fn safe_path(directory: &Path, path: &Path) -> bool {
    if !directory.is_absolute()
        || !path.is_absolute()
        || !path.starts_with(directory)
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || directory
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return false;
    }
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component.as_os_str());
        match fs::symlink_metadata(&prefix) {
            Ok(metadata) if metadata.file_type().is_symlink() => return false,
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return false,
            _ => {}
        }
    }
    true
}

/// An explicitly configured legacy path may be outside DATA_DIR, but may not
/// be relative, traverse parents, or pass through any symlink.
pub fn safe_legacy_path(path: &Path) -> bool {
    path.ancestors()
        .last()
        .is_some_and(|root| safe_path(root, path))
}

pub fn load(directory: &Path) -> (Vec<Record>, V) {
    load_paths(directory, candidates(directory), is_wsl())
}

pub fn load_legacy(home: &Path) -> (Vec<Record>, V) {
    load_checked(home, candidates_legacy(home), is_wsl(), true)
}

fn load_paths(directory: &Path, candidates: Vec<(PathBuf, String)>, wsl: bool) -> (Vec<Record>, V) {
    load_checked(directory, candidates, wsl, false)
}

fn load_checked(
    directory: &Path,
    candidates: Vec<(PathBuf, String)>,
    wsl: bool,
    legacy: bool,
) -> (Vec<Record>, V) {
    let mut records = Vec::new();
    let mut sources = Vec::new();
    let mut seen = HashSet::new();
    for (path, source) in candidates {
        let allowed = |path: &Path| {
            if legacy {
                safe_legacy_path(path)
            } else {
                safe_path(directory, path)
            }
        };
        if !allowed(&path) || !path.exists() {
            continue;
        }
        let parsed = (|| -> Result<(V, String), Box<dyn std::error::Error>> {
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || metadata.len() > 10 * 1024 * 1024 {
                return Err("Profile source must be a regular file no larger than 10 MiB".into());
            }
            let raw =
                RawValue::from_string(String::from_utf8_lossy(&fs::read(&path)?).into_owned())?;
            let value = V::parse(&raw)?;
            if matches!(value, V::Null) {
                return Err("Cannot read properties of null".into());
            }
            let profiles = if value.is_array() {
                value
            } else {
                value["profiles"].clone()
            };
            if !profiles.is_array() {
                return Ok((V::Null, String::new()));
            }
            let modified = DateTime::<Utc>::from(metadata.modified()?);
            // Node Stats.mtime uses Math.round(mtimeMs), unlike new Date(mtimeMs).
            let ms = modified.timestamp() as f64 * 1000.0
                + modified.timestamp_subsec_nanos() as f64 / 1_000_000.0;
            let updated_at = DateTime::<Utc>::from_timestamp_millis((ms + 0.5).floor() as i64)
                .ok_or("Invalid profile modification time")?
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            Ok((profiles, updated_at))
        })();
        let (profiles, updated_at) = match parsed {
            Ok((V::Null, _)) => continue,
            Ok(result) => result,
            Err(_) => {
                sources.push(object([
                    ("source", V::from(source)),
                    ("error", V::from("프로필 파일을 읽지 못했습니다.")),
                ]));
                continue;
            }
        };
        sources.push(object([
            ("source", V::from(source.clone())),
            ("updatedAt", V::from(updated_at.clone())),
        ]));
        for profile in profiles.array() {
            let provider = if profile["provider"].truthy() {
                profile["provider"].text().to_lowercase()
            } else {
                String::new()
            };
            let key = match provider.as_str() {
                "claude" => "claudeConfigDir",
                "codex" => "codexHome",
                _ => continue,
            };
            let raw_path = if profile.has(key) {
                profile[key].text()
            } else {
                "undefined".into()
            };
            let trimmed = V::from(raw_path.as_str()).trim().text();
            if trimmed.is_empty() {
                continue;
            }
            let home = PathBuf::from(if wsl && !cfg!(windows) {
                windows_to_wsl_path(&trimmed)
            } else {
                trimmed
            });
            if !allowed(&home) {
                continue;
            }
            let id = format!(
                "{:x}",
                Sha256::digest(format!("{provider}\0{}", raw_path.to_lowercase()).as_bytes())
            )[..16]
                .to_owned();
            if !seen.insert(id.clone()) {
                continue;
            }
            records.push(Record {
                profile: profile.clone(),
                id,
                provider,
                home,
                source: source.clone(),
                updated_at: updated_at.clone(),
            });
        }
    }
    (records, V::Array(sources))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_windows_fallback_matches_source_conditions_without_host_access() {
        use std::cell::Cell;
        // Expected calls and paths come from fresh profileFileCandidates VM runs.
        for (wsl, explicit, user, present, checks, detections, expected_paths) in [
            (
                false,
                "",
                "user",
                false,
                0,
                0,
                vec![
                    "/synthetic/configured/profiles.json",
                    "/synthetic/home/.codex-account-launcher/profiles.json",
                ],
            ),
            (
                true,
                "D:\\People\\explicit",
                "user",
                false,
                0,
                0,
                vec![
                    "/synthetic/configured/profiles.json",
                    "/synthetic/home/.codex-account-launcher/profiles.json",
                    "/mnt/d/People/explicit/.codex-account-launcher/profiles.json",
                    "/mnt/c/Users/user/.codex-account-launcher/profiles.json",
                ],
            ),
            (
                true,
                "",
                "user",
                true,
                1,
                0,
                vec![
                    "/synthetic/configured/profiles.json",
                    "/synthetic/home/.codex-account-launcher/profiles.json",
                    "/mnt/c/Users/user/.codex-account-launcher/profiles.json",
                ],
            ),
            (
                true,
                "",
                "user",
                false,
                1,
                1,
                vec![
                    "/synthetic/configured/profiles.json",
                    "/synthetic/home/.codex-account-launcher/profiles.json",
                    "/mnt/c/Users/user/.codex-account-launcher/profiles.json",
                    "/mnt/c/Users/different/.codex-account-launcher/profiles.json",
                ],
            ),
            (
                true,
                "",
                "",
                false,
                0,
                1,
                vec![
                    "/synthetic/configured/profiles.json",
                    "/synthetic/home/.codex-account-launcher/profiles.json",
                    "/mnt/c/Users/different/.codex-account-launcher/profiles.json",
                ],
            ),
        ] {
            let checked = Cell::new(0);
            let detected = Cell::new(0);
            let candidates = legacy_candidate_paths(
                Path::new("/synthetic/home"),
                wsl,
                "/synthetic/configured",
                explicit,
                user,
                |path| {
                    checked.set(checked.get() + 1);
                    assert_eq!(
                        path,
                        Path::new("/mnt/c/Users/user/.codex-account-launcher/profiles.json")
                    );
                    present
                },
                || {
                    detected.set(detected.get() + 1);
                    " C:\\Users\\different \r\n".into()
                },
            );
            assert_eq!(checked.get(), checks);
            assert_eq!(detected.get(), detections);
            assert_eq!(
                candidates
                    .iter()
                    .map(|(path, _)| path.clone())
                    .collect::<Vec<_>>(),
                expected_paths
                    .into_iter()
                    .map(PathBuf::from)
                    .collect::<Vec<_>>()
            );
            assert_eq!(candidates[0].1, "Configured");
            assert_eq!(candidates[1].1, if wsl { "WSL" } else { "Local" });
            assert!(candidates
                .iter()
                .skip(2)
                .all(|(_, source)| source == "Windows"));
        }
    }

    #[test]
    fn legacy_windows_fallback_preserves_deduplication_and_failure_behavior() {
        let home = Path::new("/synthetic/home");
        let candidates = legacy_candidate_paths(
            home,
            true,
            "C:\\Users\\Mixed\\.codex-account-launcher",
            "",
            "user",
            |_| false,
            || "c:\\users\\mixed".into(),
        );
        assert_eq!(candidates.len(), 3);
        assert_eq!(candidates[0].1, "Configured");
        let candidates = legacy_candidate_paths(
            Path::new("/mnt/c/Users/Mixed"),
            true,
            "",
            "",
            "",
            |_| panic!("No guessed username means no existence check"),
            || "C:\\Users\\MIXED".into(),
        );
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].1, "WSL");
        let candidates = legacy_candidate_paths(
            home,
            true,
            "",
            "",
            "",
            |_| panic!("No guessed username"),
            String::new,
        );
        assert_eq!(candidates, candidate_home_paths(home, true, "", "", ""));
        // The preview builder retains no detector or command execution path.
        assert_eq!(
            candidate_paths(Path::new("/synthetic"), true, "", "", ""),
            candidates
        );
    }

    #[test]
    fn legacy_candidates_use_real_home_and_keep_configured_and_wsl_order() {
        let preview = candidate_paths(Path::new("/synthetic/data"), false, "", "", "");
        let legacy = candidate_home_paths(Path::new("/synthetic/home"), false, "", "", "");
        assert_eq!(
            preview[0].0,
            PathBuf::from("/synthetic/data/home/.codex-account-launcher/profiles.json")
        );
        assert_eq!(
            legacy[0].0,
            PathBuf::from("/synthetic/home/.codex-account-launcher/profiles.json")
        );
        let candidates = candidate_home_paths(
            Path::new("/synthetic/home"),
            true,
            "D:\\explicit-hub",
            "E:\\People\\demo",
            "demo-wsl",
        );
        assert_eq!(
            candidates,
            vec![
                (
                    PathBuf::from("/mnt/d/explicit-hub/profiles.json"),
                    "Configured".into()
                ),
                (
                    PathBuf::from("/synthetic/home/.codex-account-launcher/profiles.json"),
                    "WSL".into()
                ),
                (
                    PathBuf::from("/mnt/e/People/demo/.codex-account-launcher/profiles.json"),
                    "Windows".into()
                ),
                (
                    PathBuf::from("/mnt/c/Users/demo-wsl/.codex-account-launcher/profiles.json"),
                    "Windows".into()
                ),
            ]
        );
    }

    #[cfg(unix)]
    #[test]
    fn legacy_explicit_sources_and_homes_remain_symlink_and_traversal_checked() {
        use std::os::unix::fs::symlink;
        let fixture = tempfile::tempdir().unwrap();
        let data = fixture.path().join("data");
        let launcher = fixture.path().join("launcher");
        let account = fixture.path().join("explicit-account");
        for path in [&data, &launcher, &account] {
            fs::create_dir(path).unwrap();
        }
        let link = fixture.path().join("linked-account");
        symlink(&account, &link).unwrap();
        let profiles = launcher.join("profiles.json");
        fs::write(
            &profiles,
            V::Array(
                [
                    account.clone(),
                    link.clone(),
                    fixture.path().join("child/../explicit-account"),
                    PathBuf::from("relative-account"),
                ]
                .into_iter()
                .map(|home| {
                    object([
                        ("provider", "claude".into()),
                        (
                            "claudeConfigDir",
                            home.to_string_lossy().into_owned().into(),
                        ),
                    ])
                })
                .collect(),
            )
            .raw()
            .get(),
        )
        .unwrap();
        let candidates = vec![(profiles.clone(), "Configured".into())];
        assert!(load_paths(&data, candidates.clone(), false).0.is_empty());
        let (records, sources) = load_checked(&data, candidates, false, true);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].home, account);
        assert_eq!(sources.array().len(), 1);
        assert!(!safe_legacy_path(&link));
        assert!(!safe_legacy_path(Path::new("relative-account")));
        assert!(!safe_legacy_path(
            &fixture.path().join("child/../explicit-account")
        ));
        let linked_source = fixture.path().join("linked-profiles.json");
        symlink(profiles, &linked_source).unwrap();
        assert!(load_checked(
            &data,
            vec![(linked_source, "Configured".into())],
            false,
            true
        )
        .0
        .is_empty());
    }

    #[test]
    fn candidate_order_conversion_and_case_insensitive_deduplication() {
        assert_eq!(
            windows_to_wsl_path(" \u{feff}D:\\People\\demo\\계정 "),
            "/mnt/d/People/demo/계정"
        );
        assert_eq!(windows_to_wsl_path("/preview/home"), "/preview/home");
        let directory = Path::new("/preview");
        let paths = candidate_paths(
            directory,
            true,
            "/preview/home/.codex-account-launcher",
            "D:\\People\\demo",
            "linux-user",
        );
        assert_eq!(
            paths,
            vec![
                (
                    PathBuf::from("/preview/home/.codex-account-launcher/profiles.json"),
                    "Configured".into()
                ),
                (
                    PathBuf::from("/mnt/d/People/demo/.codex-account-launcher/profiles.json"),
                    "Windows".into()
                ),
                (
                    PathBuf::from("/mnt/c/Users/linux-user/.codex-account-launcher/profiles.json"),
                    "Windows".into()
                ),
            ]
        );
        let paths = candidate_paths(
            directory,
            false,
            "/PREVIEW/HOME/.CODEX-ACCOUNT-LAUNCHER",
            "",
            "",
        );
        assert_eq!(paths.len(), 1);
        assert_eq!(paths[0].1, "Configured");
    }

    #[test]
    fn profiles_preserve_raw_ids_first_record_and_safe_sources() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let home = root.join("claude");
        let profile = object([
            ("provider", V::from("CLAUDE")),
            ("name", V::from("first")),
            ("claudeConfigDir", V::from(format!(" {} ", home.display()))),
        ]);
        let mut second = profile.clone();
        second["name"] = V::from("second");
        let first_file = root.join("first.json");
        let second_file = root.join("second.json");
        fs::write(&first_file, V::Array(vec![profile.clone()]).raw().get()).unwrap();
        fs::File::open(&first_file)
            .unwrap()
            .set_modified(
                std::time::UNIX_EPOCH + std::time::Duration::new(1_700_000_000, 533_999_000),
            )
            .unwrap();
        fs::write(
            &second_file,
            object([("profiles", V::Array(vec![second]))]).raw().get(),
        )
        .unwrap();
        let bad_file = root.join("bad.json");
        fs::write(&bad_file, "{").unwrap();
        let null_file = root.join("null.json");
        fs::write(&null_file, "null").unwrap();
        let outside = root.parent().unwrap().join("outside/profiles.json");
        let (records, sources) = load_paths(
            root,
            vec![
                (first_file, "Configured".into()),
                (second_file, "Local".into()),
                (bad_file, "Bad".into()),
                (null_file, "Null".into()),
                (outside.clone(), "Outside".into()),
            ],
            false,
        );
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].profile["name"], V::from("first"));
        assert_eq!(records[0].home, home);
        assert_eq!(
            records[0].id,
            format!(
                "{:x}",
                Sha256::digest(
                    format!("claude\0 {} ", home.display())
                        .to_lowercase()
                        .as_bytes()
                )
            )[..16]
        );
        assert_eq!(sources.array().len(), 4);
        assert!(records[0].updated_at.ends_with('Z'));
        assert_eq!(records[0].updated_at, "2023-11-14T22:13:20.534Z");
        assert_eq!(
            sources.array()[2]["error"],
            V::from("프로필 파일을 읽지 못했습니다.")
        );
        assert_eq!(sources.array()[3]["error"], sources.array()[2]["error"]);
        assert!(!safe_path(root, &outside));
        assert!(!safe_path(root, &root.join("child/../first.json")));
        assert!(!safe_path(root, Path::new("relative/profiles.json")));
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_profiles_homes_and_ancestor_directories() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("profiles.json"), "[]").unwrap();
        std::os::unix::fs::symlink(&target, root.join("link")).unwrap();
        assert!(!safe_path(root, &root.join("link")));
        assert!(!safe_path(root, &root.join("link/profiles.json")));
        std::os::unix::fs::symlink(target.join("profiles.json"), root.join("profiles.json"))
            .unwrap();
        let (records, sources) = load_paths(
            root,
            vec![(root.join("profiles.json"), "Local".into())],
            false,
        );
        assert!(records.is_empty());
        assert!(sources.array().is_empty());
        assert!(!safe_path(
            &root.join("link"),
            &root.join("link/profiles.json")
        ));
    }
}
