//! External session launch plans. Successful spawn transfers ownership to the
//! desktop terminal; it does not claim that Claude has logged in or become ready.
use crate::{
    agent_prompt::string,
    ai_transport::Cancel,
    board_value::{object, V},
};
use std::{io, process::Stdio};
use tokio::process::Command;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Mac,
    Linux,
}
impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::Mac
        } else {
            Self::Linux
        }
    }
}
#[derive(Clone, Debug)]
pub struct Launcher {
    pub program: String,
    pub args: Vec<V>,
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub project_id: V,
    pub claude_args: Vec<V>,
    pub launchers: Vec<Launcher>,
    has_project_id: bool,
}
impl Plan {
    pub fn response(&self) -> V {
        let mut result = object([("launched", true.into())]);
        if self.has_project_id {
            result["projectId"] = self.project_id.clone();
        }
        result
    }
}

fn sanitize(value: &V) -> V {
    V::String(
        value
            .units()
            .iter()
            .copied()
            .filter(|c| {
                !matches!(
                    *c,
                    38 | 124 | 60 | 62 | 94 | 59 | 96 | 36 | 40 | 41 | 123 | 125 | 13 | 10 | 34
                )
            })
            .take(500)
            .collect(),
    )
}
fn append(output: &mut Vec<u16>, value: &str) {
    output.extend(value.encode_utf16());
}
fn wt_argument(value: V) -> V {
    let V::String(units) = value else {
        return value;
    };
    let mut escaped = Vec::with_capacity(units.len());
    for unit in units {
        if unit == 59 {
            escaped.push(92);
        }
        escaped.push(unit);
    }
    V::String(escaped)
}
fn shell_quote(value: &V) -> Result<V, String> {
    let mut result = vec![39];
    for c in string(value)?.units() {
        if *c == 39 {
            append(&mut result, "'\\''");
        } else {
            result.push(*c);
        }
    }
    result.push(39);
    Ok(V::String(result))
}
fn shell_command(path: &V, args: &[V], keep_open: bool) -> Result<V, String> {
    let mut command: Vec<_> = "cd -- ".encode_utf16().collect();
    command.extend_from_slice(shell_quote(path)?.units());
    append(&mut command, " && claude");
    for arg in args {
        command.push(32);
        command.extend_from_slice(shell_quote(arg)?.units());
    }
    if keep_open {
        append(&mut command, "; exec bash");
    }
    Ok(V::String(command))
}
fn applescript(command: &V) -> V {
    let mut script: Vec<_> = "tell application \"Terminal\"\n  activate\n  do script \""
        .encode_utf16()
        .collect();
    for c in command.units() {
        match *c {
            92 => append(&mut script, "\\\\"),
            34 => append(&mut script, "\\\""),
            10 => append(&mut script, "\\n"),
            13 => append(&mut script, "\\r"),
            9 => append(&mut script, "\\t"),
            c => script.push(c),
        }
    }
    append(&mut script, "\"\nend tell");
    V::String(script)
}
fn wsl_path(path: &V) -> Option<(V, V)> {
    let units: Vec<_> = path
        .units()
        .iter()
        .map(|c| if *c == 92 { 47 } else { *c })
        .collect();
    // Match the original /^\/\/wsl[\$.](?:localhost)?\/([^/]+)(\/.*)/i.
    // The dot suffix alone and dollar+localhost forms are historical aliases.
    let prefix = |at: usize, text: &str| {
        let target: Vec<_> = text.encode_utf16().collect();
        units.get(at..at + target.len()).is_some_and(|slice| {
            slice
                .iter()
                .zip(target)
                .all(|(a, b)| *a == b || (65..=90).contains(a) && *a + 32 == b)
        })
    };
    if !prefix(0, "//wsl") || !matches!(units.get(5), Some(36 | 46)) {
        return None;
    }
    let mut start = 6;
    if prefix(start, "localhost") {
        start += 9;
    }
    if units.get(start) != Some(&47) {
        return None;
    }
    start += 1;
    let slash = units[start..].iter().position(|c| *c == 47)? + start;
    if slash == start {
        return None;
    }
    // JavaScript dot excludes line terminators; the match is not end-anchored.
    let end = units[slash..]
        .iter()
        .position(|c| matches!(*c, 10 | 13 | 0x2028 | 0x2029))
        .map_or(units.len(), |i| slash + i);
    Some((
        V::String(units[start..slash].to_vec()),
        V::String(units[slash..end].to_vec()),
    ))
}

pub fn plan(project: &V, input: &V, resume: bool, platform: Platform) -> Result<Plan, String> {
    let mut args = vec![];
    if resume {
        let id = &input["sessionId"];
        let text = string(id)?;
        let valid = !text.units().is_empty()
            && text
                .units()
                .iter()
                .all(|c| matches!(*c, 45 | 48..=57 | 65..=70 | 97..=102));
        if id.truthy() && valid {
            args.extend(["--resume".into(), id.clone()]);
        } else {
            args.push("--continue".into());
        }
    } else {
        if *input == V::Null {
            return Err("Cannot read properties of null (reading 'resume')".into());
        }
        if input["resume"].truthy() {
            args.push("--continue".into());
        }
        if input["model"].is_string()
            && matches!(input["model"].text().as_str(), "haiku" | "sonnet" | "opus")
        {
            args.extend(["--model".into(), input["model"].clone()]);
        }
        if input["prompt"].truthy() {
            args.extend(["-p".into(), sanitize(&input["prompt"])]);
        }
    }
    let path = &project["path"];
    if !path.is_string() && (platform != Platform::Windows || path.truthy()) {
        return Err("Session project path must be a string".into());
    }
    let launchers = match platform {
        Platform::Windows => {
            let mut wt_args: Vec<V> = ["-w", "0", "nt"].into_iter().map(Into::into).collect();
            if let Some((distro, linux_path)) = wsl_path(path) {
                wt_args.extend([
                    "--title".into(),
                    sanitize(&project["name"]),
                    "wsl".into(),
                    "-d".into(),
                    distro,
                    "--cd".into(),
                    linux_path,
                    "--".into(),
                    "claude".into(),
                ]);
            } else {
                let win_path = V::String(
                    path.units()
                        .iter()
                        .map(|c| if *c == 47 { 92 } else { *c })
                        .collect(),
                );
                wt_args.extend([
                    "-d".into(),
                    win_path,
                    "--title".into(),
                    sanitize(&project["name"]),
                    "claude".into(),
                ]);
            }
            wt_args.extend(args.iter().cloned());
            vec![Launcher {
                program: "wt".into(),
                // WT parses semicolons even inside a single OS argument, then
                // removes one backslash from each escaped delimiter (\;).
                args: wt_args.into_iter().map(wt_argument).collect(),
            }]
        }
        Platform::Mac => {
            if args.iter().any(|arg| !arg.is_string()) {
                return Err("a.replace is not a function".into());
            }
            vec![Launcher {
                program: "osascript".into(),
                args: vec![
                    "-e".into(),
                    applescript(&shell_command(path, &args, false)?),
                ],
            }]
        }
        Platform::Linux => {
            let command = shell_command(path, &args, true)?;
            [("gnome-terminal", "--"), ("konsole", "-e"), ("xterm", "-e")]
                .into_iter()
                .map(|(program, separator)| Launcher {
                    program: program.into(),
                    args: vec![
                        separator.into(),
                        "bash".into(),
                        "-c".into(),
                        command.clone(),
                    ],
                })
                .collect()
        }
    };
    Ok(Plan {
        project_id: project["id"].clone(),
        has_project_id: project.has("id"),
        claude_args: args,
        launchers,
    })
}

pub async fn launch(project: &V, input: &V, resume: bool, cancel: &Cancel) -> Result<V, String> {
    launch_plan(&plan(project, input, resume, Platform::current())?, cancel).await
}

/// Preview tests supply absolute fake executable paths here. There is no shell
/// around a launcher. Only its explicitly quoted terminal command uses a shell.
pub async fn launch_plan(plan: &Plan, cancel: &Cancel) -> Result<V, String> {
    let mut missing = vec![];
    for launcher in &plan.launchers {
        if cancel.is_cancelled() {
            return Err("Session launch cancelled".into());
        }
        let mut command = Command::new(&launcher.program);
        for arg in &launcher.args {
            command.arg(string(arg)?.text());
        }
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        #[cfg(windows)]
        command.creation_flags(0x00000008 | 0x00000200 | 0x08000000);
        if cancel.is_cancelled() {
            return Err("Session launch cancelled".into());
        }
        match command.spawn() {
            Ok(child) => {
                // Tokio reaps the child when it exits. Its default non-killing
                // drop transfers lifetime past this request and cancellation.
                drop(child);
                return Ok(plan.response());
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                missing.push(launcher.program.clone())
            }
            Err(error) => return Err(format!("Session launcher {}: {error}", launcher.program)),
        }
    }
    Err(format!(
        "No terminal launcher found: {}",
        missing.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn value(text: &str) -> V {
        V::parse(&serde_json::from_str::<Box<serde_json::value::RawValue>>(text).unwrap()).unwrap()
    }
    fn plan_value(plan: &Plan) -> V {
        object([
            ("value", plan.response()),
            ("claudeArgs", V::Array(plan.claude_args.clone())),
            (
                "launchers",
                V::Array(
                    plan.launchers
                        .iter()
                        .map(|launcher| {
                            object([
                                ("program", launcher.program.clone().into()),
                                ("args", V::Array(launcher.args.clone())),
                            ])
                        })
                        .collect(),
                ),
            ),
        ])
    }
    #[test]
    fn original_session_options_and_corrected_launcher_boundaries() {
        let fixtures = value(include_str!(
            "../../tests/fixtures/rust-session-launch.json"
        ));
        for fixture in fixtures.array() {
            let input = &fixture["input"];
            let platform = match input["platform"].text().as_str() {
                "windows" => Platform::Windows,
                "mac" => Platform::Mac,
                "linux" => Platform::Linux,
                other => panic!("unknown fixture platform {other}"),
            };
            let actual = match plan(
                &input["project"],
                &input["options"],
                input["resume"].truthy(),
                platform,
            ) {
                Ok(plan) => plan_value(&plan),
                Err(error) => object([("error", error.into())]),
            };
            assert_eq!(actual, fixture["expected"], "{}", fixture["name"].text());
        }
    }

    #[test]
    fn windows_terminal_delimiter_round_trip_preserves_literal_arguments() {
        // These are WT's AppCommandlineArgs::_commandDelimiterRegex and
        // Commandline::AddArg rules, independent of OS argv quoting.
        let delimiter = regex::Regex::new(r"(^;|[^\\];)").unwrap();
        for original in [
            ";",
            "a;b",
            "a\\;b",
            "a\\\\;b",
            ";; split-pane cmd",
            "C:\\a;b",
            "😀;한글",
        ] {
            let escaped = wt_argument(original.into()).text();
            assert!(!delimiter.is_match(&escaped));
            assert_eq!(escaped.replace("\\;", ";"), original);
        }
    }

    #[cfg(unix)]
    fn executable(path: &std::path::Path, script: &str) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(path, script).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(unix)]
    async fn read_eventually(path: &std::path::Path) -> Vec<u8> {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                if let Ok(bytes) = std::fs::read(path) {
                    if !bytes.is_empty() {
                        return bytes;
                    }
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap()
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn quoted_shell_preserves_path_and_each_argument() {
        let directory = tempfile::tempdir().unwrap();
        let project_path = directory.path().join("a ' ; $(touch INJECTED) \" path");
        std::fs::create_dir(&project_path).unwrap();
        let captured = directory.path().join("argv");
        executable(
            &directory.path().join("claude"),
            &format!(
                "#!/bin/sh\nprintf '%s\\0' \"$PWD\" \"$@\" > {}\n",
                shell_quote(&captured.to_string_lossy().as_ref().into())
                    .unwrap()
                    .text()
            ),
        );
        executable(&directory.path().join("bash"), "#!/bin/sh\nexit 0\n");
        let project = object([
            ("id", "fixture".into()),
            ("path", project_path.to_string_lossy().as_ref().into()),
        ]);
        let options = object([
            ("resume", true.into()),
            ("model", "opus".into()),
            ("prompt", "one 'two'\tthree \\ four --model sonnet".into()),
        ]);
        let plan = plan(&project, &options, false, Platform::Linux).unwrap();
        let status = Command::new("/bin/bash")
            .arg("-c")
            .arg(plan.launchers[0].args[3].text())
            .env("PATH", directory.path())
            .status()
            .await
            .unwrap();
        assert!(status.success());
        let bytes = std::fs::read(captured).unwrap();
        let actual: Vec<_> = bytes
            .split(|b| *b == 0)
            .take_while(|b| !b.is_empty())
            .map(|s| String::from_utf8_lossy(s).into_owned())
            .collect();
        let mut expected = vec![project_path.to_string_lossy().into_owned()];
        expected.extend(plan.claude_args.iter().map(V::text));
        assert_eq!(actual, expected);
        assert!(!project_path.join("INJECTED").exists());
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn fake_launcher_fallback_missing_error_and_cancel_before_spawn() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("spawned");
        let fake = directory.path().join("terminal");
        executable(
            &fake,
            &format!(
                "#!/bin/sh\nprintf '%s\\0' \"$@\" > {}\n",
                shell_quote(&marker.to_string_lossy().as_ref().into())
                    .unwrap()
                    .text()
            ),
        );
        let project = object([("id", "fixture".into()), ("path", "/fixture".into())]);
        let mut plan = plan(&project, &V::object(), false, Platform::Linux).unwrap();
        plan.launchers.truncate(2);
        plan.launchers[0].program = directory
            .path()
            .join("missing")
            .to_string_lossy()
            .into_owned();
        plan.launchers[1].program = fake.to_string_lossy().into_owned();
        let cancel = Cancel::default();
        cancel.cancel();
        assert_eq!(
            launch_plan(&plan, &cancel).await.unwrap_err(),
            "Session launch cancelled"
        );
        assert!(!marker.exists());
        assert_eq!(
            launch_plan(&plan, &Cancel::default()).await.unwrap(),
            plan.response()
        );
        let captured = read_eventually(&marker).await;
        let expected: Vec<u8> = plan.launchers[1]
            .args
            .iter()
            .flat_map(|v| v.text().into_bytes().into_iter().chain([0]))
            .collect();
        assert_eq!(captured, expected);
        plan.launchers.truncate(1);
        assert!(launch_plan(&plan, &Cancel::default())
            .await
            .unwrap_err()
            .starts_with("No terminal launcher found:"));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn successful_spawn_survives_request_cancellation() {
        let directory = tempfile::tempdir().unwrap();
        let gate = directory.path().join("release");
        let done = directory.path().join("done");
        let fake = directory.path().join("terminal");
        executable(&fake, &format!("#!/bin/sh\ni=0\nwhile [ ! -e '{}' ] && [ \"$i\" -lt 200 ]; do /bin/sleep .01; i=$((i+1)); done\nprintf done > '{}'\n", gate.display(), done.display()));
        let project = object([("id", "fixture".into()), ("path", "/fixture".into())]);
        let mut plan = plan(&project, &V::object(), false, Platform::Linux).unwrap();
        plan.launchers.truncate(1);
        plan.launchers[0].program = fake.to_string_lossy().into_owned();
        let cancel = Cancel::default();
        launch_plan(&plan, &cancel).await.unwrap();
        cancel.cancel();
        std::fs::write(&gate, "release").unwrap();
        assert_eq!(read_eventually(&done).await, b"done");
    }
}
