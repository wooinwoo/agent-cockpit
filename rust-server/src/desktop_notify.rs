//! Desktop notification arguments and an owned, cancellable delivery command.
use crate::{ai_transport::Cancel, process_owned};
use std::{collections::BTreeMap, time::Duration};
use tokio::process::Command;

// The original static PowerShell script, encoded as UTF-16LE then Base64.
// User text is supplied only through NT/NB, never interpolated into the script.
// Source-reference fixtures verify this constant against lib/notify.js.
const WINDOWS_COMMAND: &str = "CgBbAFcAaQBuAGQAbwB3AHMALgBVAEkALgBOAG8AdABpAGYAaQBjAGEAdABpAG8AbgBzAC4AVABvAGEAcwB0AE4AbwB0AGkAZgBpAGMAYQB0AGkAbwBuAE0AYQBuAGEAZwBlAHIALAAgAFcAaQBuAGQAbwB3AHMALgBVAEkALgBOAG8AdABpAGYAaQBjAGEAdABpAG8AbgBzACwAIABDAG8AbgB0AGUAbgB0AFQAeQBwAGUAIAA9ACAAVwBpAG4AZABvAHcAcwBSAHUAbgB0AGkAbQBlAF0AIAB8ACAATwB1AHQALQBOAHUAbABsAAoAWwBXAGkAbgBkAG8AdwBzAC4ARABhAHQAYQAuAFgAbQBsAC4ARABvAG0ALgBYAG0AbABEAG8AYwB1AG0AZQBuAHQALAAgAFcAaQBuAGQAbwB3AHMALgBEAGEAdABhAC4AWABtAGwALgBEAG8AbQAsACAAQwBvAG4AdABlAG4AdABUAHkAcABlACAAPQAgAFcAaQBuAGQAbwB3AHMAUgB1AG4AdABpAG0AZQBdACAAfAAgAE8AdQB0AC0ATgB1AGwAbAAKACQAQQBQAFAAXwBJAEQAIAA9ACAAJwB7ADEAQQBDADEANABFADcANwAtADAAMgBFADcALQA0AEUANQBEAC0AQgA3ADQANAAtADIARQBCADEAQQBFADUAMQA5ADgAQgA3AH0AXABXAGkAbgBkAG8AdwBzAFAAbwB3AGUAcgBTAGgAZQBsAGwAXAB2ADEALgAwAFwAcABvAHcAZQByAHMAaABlAGwAbAAuAGUAeABlACcACgAkAHQAIAA9ACAAWwBTAHkAcwB0AGUAbQAuAFMAZQBjAHUAcgBpAHQAeQAuAFMAZQBjAHUAcgBpAHQAeQBFAGwAZQBtAGUAbgB0AF0AOgA6AEUAcwBjAGEAcABlACgAJABlAG4AdgA6AE4AVAApAAoAJABiACAAPQAgAFsAUwB5AHMAdABlAG0ALgBTAGUAYwB1AHIAaQB0AHkALgBTAGUAYwB1AHIAaQB0AHkARQBsAGUAbQBlAG4AdABdADoAOgBFAHMAYwBhAHAAZQAoACQAZQBuAHYAOgBOAEIAKQAKACQAeABtAGwAIAA9ACAATgBlAHcALQBPAGIAagBlAGMAdAAgAFcAaQBuAGQAbwB3AHMALgBEAGEAdABhAC4AWABtAGwALgBEAG8AbQAuAFgAbQBsAEQAbwBjAHUAbQBlAG4AdAAKACQAeABtAGwALgBMAG8AYQBkAFgAbQBsACgAIgA8AHQAbwBhAHMAdAA+ADwAdgBpAHMAdQBhAGwAPgA8AGIAaQBuAGQAaQBuAGcAIAB0AGUAbQBwAGwAYQB0AGUAPQAnAFQAbwBhAHMAdABHAGUAbgBlAHIAaQBjACcAPgA8AHQAZQB4AHQAPgAkAHQAPAAvAHQAZQB4AHQAPgA8AHQAZQB4AHQAPgAkAGIAPAAvAHQAZQB4AHQAPgA8AC8AYgBpAG4AZABpAG4AZwA+ADwALwB2AGkAcwB1AGEAbAA+ADwAYQB1AGQAaQBvACAAcwByAGMAPQAnAG0AcwAtAHcAaQBuAHMAbwB1AG4AZABlAHYAZQBuAHQAOgBOAG8AdABpAGYAaQBjAGEAdABpAG8AbgAuAEQAZQBmAGEAdQBsAHQAJwAvAD4APAAvAHQAbwBhAHMAdAA+ACIAKQAKAFsAVwBpAG4AZABvAHcAcwAuAFUASQAuAE4AbwB0AGkAZgBpAGMAYQB0AGkAbwBuAHMALgBUAG8AYQBzAHQATgBvAHQAaQBmAGkAYwBhAHQAaQBvAG4ATQBhAG4AYQBnAGUAcgBdADoAOgBDAHIAZQBhAHQAZQBUAG8AYQBzAHQATgBvAHQAaQBmAGkAZQByACgAJABBAFAAUABfAEkARAApAC4AUwBoAG8AdwAoAFsAVwBpAG4AZABvAHcAcwAuAFUASQAuAE4AbwB0AGkAZgBpAGMAYQB0AGkAbwBuAHMALgBUAG8AYQBzAHQATgBvAHQAaQBmAGkAYwBhAHQAaQBvAG4AXQA6ADoAbgBlAHcAKAAkAHgAbQBsACkAKQA=";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    Linux,
    Mac,
    Windows,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Plan {
    pub program: String,
    pub args: Vec<String>,
    /// Overrides applied to the inherited environment.
    pub env: BTreeMap<String, String>,
}

pub fn plan(title: &str, body: &str, platform: Platform) -> Plan {
    let mut env = BTreeMap::new();
    let (program, args) = match platform {
        Platform::Linux => ("notify-send", vec!["--".into(), title.into(), body.into()]),
        Platform::Mac => {
            let escape = |value: &str| value.replace('\\', "\\\\").replace('"', "\\\"");
            (
                "osascript",
                vec![
                    "-e".into(),
                    format!(
                        "display notification \"{}\" with title \"{}\"",
                        escape(body),
                        escape(title)
                    ),
                ],
            )
        }
        Platform::Windows => {
            env.insert("NT".into(), title.into());
            env.insert("NB".into(), body.into());
            (
                "powershell",
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-EncodedCommand".into(),
                    WINDOWS_COMMAND.into(),
                ],
            )
        }
    };
    Plan {
        program: program.into(),
        args,
        env,
    }
}

fn command(plan: &Plan) -> Command {
    let mut command = Command::new(&plan.program);
    command.args(&plan.args).envs(&plan.env);
    command
}

async fn run(command: Command, cancel: &Cancel) -> Result<(), String> {
    let output = process_owned::run(command, Duration::from_secs(5), 16 * 1024, cancel).await?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Desktop notification command failed ({})",
            output.status
        ))
    }
}

/// Wait for delivery command exit without exposing its output or notification text.
/// Execution support follows process_owned; platform plans can be built anywhere.
pub async fn show(title: &str, body: &str, cancel: &Cancel) -> Result<(), String> {
    let platform = match std::env::consts::OS {
        "windows" => Platform::Windows,
        "macos" => Platform::Mac,
        _ => Platform::Linux,
    };
    run(command(&plan(title, body, platform)), cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::{object, V};

    fn value(plan: Plan) -> V {
        object([
            ("program", plan.program.into()),
            (
                "args",
                V::Array(plan.args.into_iter().map(V::from).collect()),
            ),
            (
                "env",
                V::Object(plan.env.into_iter().map(|(k, v)| (k, v.into())).collect()),
            ),
        ])
    }

    #[test]
    fn source_fixtures_keep_platform_contract_and_injection_corrections() {
        let raw = serde_json::value::RawValue::from_string(
            include_str!("../../tests/fixtures/rust-notify.json").into(),
        )
        .unwrap();
        let fixtures = V::parse(&raw).unwrap();
        assert_eq!(fixtures.array().len(), 54);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let input = &fixture["input"];
            let platform = match input["platform"].text().as_str() {
                "linux" => Platform::Linux,
                "mac" => Platform::Mac,
                "windows" => Platform::Windows,
                _ => panic!("unknown fixture platform"),
            };
            assert_eq!(
                value(plan(
                    &input["title"].text(),
                    &input["body"].text(),
                    platform
                )),
                fixture["expected"],
                "notification fixture {index}"
            );
        }
    }

    #[test]
    fn mac_literals_round_trip_backslashes_quotes_and_script_lookalikes() {
        let title = "trailing\\";
        let body = "\\\" & do shell script \"touch forbidden\" & \"\n한글";
        let planned = plan(title, body, Platform::Mac);
        let mut remaining = planned.args[1]
            .strip_prefix("display notification ")
            .unwrap();
        let literal = |input: &mut &str| {
            assert!(input.starts_with('"'));
            let mut chars = input[1..].char_indices();
            let mut output = String::new();
            while let Some((index, character)) = chars.next() {
                match character {
                    '\\' => {
                        let (_, escaped) = chars.next().unwrap();
                        assert!(matches!(escaped, '\\' | '"'));
                        output.push(escaped);
                    }
                    '"' => {
                        *input = &input[index + 2..];
                        return output;
                    }
                    _ => output.push(character),
                }
            }
            panic!("unterminated AppleScript string literal");
        };
        assert_eq!(literal(&mut remaining), body);
        remaining = remaining.strip_prefix(" with title ").unwrap();
        assert_eq!(literal(&mut remaining), title);
        assert!(remaining.is_empty());
    }

    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    mod owned {
        use super::*;
        use std::{fs, os::unix::fs::PermissionsExt, path::Path};

        fn fake(directory: &Path, planned: &Plan, script: &str) -> Command {
            let executable = directory.join(&planned.program);
            fs::write(&executable, format!("#!/bin/sh\n{script}\n")).unwrap();
            fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
            let mut command = command(planned);
            command
                .env_clear()
                .env("PATH", directory)
                .envs(&planned.env)
                .current_dir(directory);
            command
        }

        #[tokio::test]
        async fn isolated_fake_executables_receive_exact_arguments_and_environment() {
            for platform in [Platform::Linux, Platform::Mac, Platform::Windows] {
                let directory = tempfile::tempdir().unwrap();
                let planned = plan(
                    "--urgency=critical",
                    "$(touch forbidden)\n한글\\\"",
                    platform,
                );
                let command = fake(
                    directory.path(),
                    &planned,
                    "printf '%s\\0' \"$@\" > argv\nprintf '%s\\0%s\\0' \"$NT\" \"$NB\" > env",
                );
                run(command, &Cancel::default()).await.unwrap();
                let expected: Vec<u8> = planned
                    .args
                    .iter()
                    .flat_map(|arg| arg.as_bytes().iter().copied().chain([0]))
                    .collect();
                assert_eq!(fs::read(directory.path().join("argv")).unwrap(), expected);
                let env: Vec<u8> = ["NT", "NB"]
                    .into_iter()
                    .flat_map(|key| {
                        planned
                            .env
                            .get(key)
                            .map(String::as_bytes)
                            .unwrap_or_default()
                            .iter()
                            .copied()
                            .chain([0])
                    })
                    .collect();
                assert_eq!(fs::read(directory.path().join("env")).unwrap(), env);
                assert!(!directory.path().join("forbidden").exists());
            }
        }

        #[tokio::test]
        async fn cancelled_before_spawn_never_calls_the_fake_notifier() {
            let directory = tempfile::tempdir().unwrap();
            let command = fake(
                directory.path(),
                &plan("title", "body", Platform::Linux),
                "printf forbidden > spawned",
            );
            let cancel = Cancel::default();
            cancel.cancel();
            assert_eq!(
                run(command, &cancel).await.unwrap_err(),
                "Command cancelled"
            );
            assert!(!directory.path().join("spawned").exists());
        }

        #[tokio::test]
        async fn cancellation_and_dropped_delivery_stop_private_descendants() {
            for drop_task in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let command = fake(directory.path(), &plan("title", "body", Platform::Linux), "/bin/sh -c 'printf ready > ready; while [ ! -e release ]; do /bin/sleep 0.02; done; printf forbidden > late' &\nwait");
                let cancel = Cancel::default();
                let child_cancel = cancel.clone();
                let task = tokio::spawn(async move { run(command, &child_cancel).await });
                tokio::time::timeout(Duration::from_secs(4), async {
                    while !directory.path().join("ready").exists() {
                        assert!(!task.is_finished(), "fake notifier exited before readiness");
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .expect("private notifier readiness");
                if drop_task {
                    task.abort();
                    assert!(task.await.unwrap_err().is_cancelled());
                } else {
                    cancel.cancel();
                    assert_eq!(task.await.unwrap().unwrap_err(), "Command cancelled");
                }
                fs::write(directory.path().join("release"), "release").unwrap();
                tokio::time::sleep(Duration::from_millis(250)).await;
                assert!(!directory.path().join("late").exists());
            }
        }

        #[tokio::test]
        async fn command_failure_and_output_overflow_do_not_expose_notification_text() {
            for (script, expected) in [
                (
                    "printf private-body >&2; exit 7",
                    "Desktop notification command failed",
                ),
                (
                    "i=0; while [ \"$i\" -lt 17000 ]; do printf x; i=$((i + 1)); done",
                    "Command output exceeded limit",
                ),
            ] {
                let directory = tempfile::tempdir().unwrap();
                let command = fake(
                    directory.path(),
                    &plan("title", "private-body", Platform::Linux),
                    script,
                );
                let error = run(command, &Cancel::default()).await.unwrap_err();
                assert!(error.contains(expected), "{error}");
                assert!(!error.contains("private-body"));
            }
        }
    }
}
