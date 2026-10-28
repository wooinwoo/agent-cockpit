use crate::{board_value::V, commands};
use std::{process::Output, sync::OnceLock, time::Duration};
use tokio::{process::Command, sync::Semaphore};

static LIMIT: Semaphore = Semaphore::const_new(8);

#[cfg(test)]
pub async fn hold_all_slots() -> tokio::sync::SemaphorePermit<'static> {
    LIMIT.acquire_many(8).await.unwrap()
}

pub async fn run(
    project: &V,
    program: &str,
    args: &[String],
    timeout: Duration,
    limit: usize,
) -> Result<Output, String> {
    run_with_spawn(project, program, args, timeout, limit, Command::spawn).await
}

pub async fn run_with_spawn(
    project: &V,
    program: &str,
    args: &[String],
    timeout: Duration,
    limit: usize,
    spawn: impl FnOnce(&mut Command) -> std::io::Result<tokio::process::Child>,
) -> Result<Output, String> {
    let _permit = LIMIT
        .acquire()
        .await
        .map_err(|_| "Project commands stopped")?;
    let (command, invocation) = prepare(project, program, args);
    let output = commands::capture_with_spawn(command, timeout, limit, spawn)
        .await
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                format!("spawn {program} ENOENT")
            } else if e.kind() == std::io::ErrorKind::TimedOut {
                format!("{program} operation timed out")
            } else {
                format!("{program} command failed: {e}")
            }
        })?;
    if !output.status.success() {
        return Err(format!(
            "Command failed: {invocation}\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

fn prepare(project: &V, program: &str, args: &[String]) -> (Command, String) {
    let path = project["path"].text();
    let normalized = path.replace('\\', "/");
    static WSL: OnceLock<regex::Regex> = OnceLock::new();
    let wsl = WSL
        .get_or_init(|| regex::Regex::new(r"(?i)^//wsl[\$.](?:localhost)?/([^/]+)(/.*)").unwrap())
        .captures(&normalized);
    let mut command;
    let mut invocation;
    if let Some(wsl) = wsl {
        command = Command::new("wsl");
        command.args(["-d", &wsl[1], "--cd", &wsl[2], program]);
        command.current_dir(std::env::var("SYSTEMROOT").unwrap_or_else(|_| "C:\\Windows".into()));
        invocation = format!("wsl -d {} --cd {} {program}", &wsl[1], &wsl[2]);
    } else {
        command = Command::new(program);
        let path = if cfg!(windows) {
            path.replace('/', "\\")
        } else {
            path
        };
        if program == "git" {
            command.args(["-C", &path]);
            invocation = format!("git -C {path}");
        } else {
            command.current_dir(&path);
            invocation = program.into();
        }
    }
    command.args(args);
    if !args.is_empty() {
        invocation.push(' ');
        invocation.push_str(&args.join(" "));
    }
    (command, invocation)
}

pub async fn run_owned(
    project: &V,
    program: &str,
    args: &[String],
    timeout: Duration,
    limit: usize,
    cancel: &crate::ai_transport::Cancel,
) -> Result<Output, String> {
    let _permit = tokio::select! {biased;_=cancel.cancelled()=>return Err("Command cancelled".into()),permit=LIMIT.acquire()=>permit.map_err(|_|"Project commands stopped")?};
    let (command, invocation) = prepare(project, program, args);
    let output = crate::process_owned::run(command, timeout, limit, cancel).await?;
    if !output.status.success() {
        return Err(format!(
            "Command failed: {invocation}\n{}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(output)
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::*;
    use crate::{ai_transport::Cancel, board_value::object};
    use std::{fs, os::unix::fs::PermissionsExt};

    #[tokio::test]
    async fn cancelling_owned_git_stops_hook_descendants_before_delayed_write() {
        let directory = tempfile::tempdir().unwrap();
        let repo = directory.path();
        // An empty environment prevents user Git variables, config includes,
        // hooks, signing helpers or a foreign index from reaching this fixture.
        let git_env = [
            "-i",
            "PATH=/usr/bin:/bin",
            "LC_ALL=C",
            "GIT_CONFIG_NOSYSTEM=1",
            "GIT_CONFIG_GLOBAL=/dev/null",
            "GIT_CONFIG_SYSTEM=/dev/null",
            "/usr/bin/git",
        ];
        let initialized = std::process::Command::new("/usr/bin/env")
            .args(git_env)
            .args(["init", "--quiet", "--template=", "--initial-branch=fixture"])
            .current_dir(repo)
            .output()
            .unwrap();
        assert!(
            initialized.status.success(),
            "{}",
            String::from_utf8_lossy(&initialized.stderr)
        );
        let hooks = repo.join("fixture-hooks");
        fs::create_dir(&hooks).unwrap();
        let hook = hooks.join("pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\n/bin/sh ./hook-descendant.sh &\n/bin/sleep 3\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(
            repo.join("hook-descendant.sh"),
            "#!/bin/sh\nprintf started > descendant-started\nattempt=0\nwhile [ ! -e release-descendant ] && [ \"$attempt\" -lt 50 ]; do\n  /bin/sleep 0.1\n  attempt=$((attempt + 1))\ndone\nif [ -e release-descendant ]; then printf forbidden > delayed-write; fi\n",
        )
        .unwrap();
        let project = object([("path", repo.to_string_lossy().as_ref().into())]);
        let mut args = git_env
            .iter()
            .map(|arg| (*arg).to_owned())
            .collect::<Vec<_>>();
        args.extend([
            "-c".into(),
            format!("core.hooksPath={}", hooks.display()),
            "-c".into(),
            "core.fsmonitor=false".into(),
            "-c".into(),
            "commit.gpgSign=false".into(),
            "-c".into(),
            "user.name=Fixture".into(),
            "-c".into(),
            "user.email=fixture@example.invalid".into(),
            "commit".into(),
            "--allow-empty".into(),
            "--quiet".into(),
            "-m".into(),
            "fixture".into(),
        ]);
        let cancel = Cancel::default();
        let started = repo.join("descendant-started");
        let cancel_after_descendant = async {
            let observed = tokio::time::timeout(Duration::from_secs(10), async {
                while !started.exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            cancel.cancel();
            observed.is_ok()
        };
        let (result, observed) = tokio::join!(
            run_owned(
                &project,
                "/usr/bin/env",
                &args,
                Duration::from_secs(5),
                8192,
                &cancel,
            ),
            cancel_after_descendant,
        );
        assert!(observed, "The private Git hook must start its descendant");
        assert_eq!(result.unwrap_err(), "Command cancelled");
        // Release the canary only after cancellation returns. A fixed sleep in
        // the hook could write before cancellation on an overloaded test host.
        fs::write(repo.join("release-descendant"), "release").unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert!(
            !repo.join("delayed-write").exists(),
            "A cancelled Git hook descendant wrote after cancellation"
        );
    }
}
