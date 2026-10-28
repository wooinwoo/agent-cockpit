use std::{io, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};

// Child processes must not keep a request or shutdown stuck indefinitely.
// Bound both streams; drop on timeout terminates and reaps the direct child.
pub async fn capture(command: Command, timeout: Duration) -> io::Result<std::process::Output> {
    capture_with_limit(command, timeout, 1_048_576).await
}

pub async fn capture_with_limit(
    command: Command,
    timeout: Duration,
    limit: usize,
) -> io::Result<std::process::Output> {
    capture_with_spawn(command, timeout, limit, Command::spawn).await
}

pub async fn capture_with_spawn(
    mut command: Command,
    timeout: Duration,
    limit: usize,
    spawn: impl FnOnce(&mut Command) -> io::Result<tokio::process::Child>,
) -> io::Result<std::process::Output> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = spawn(&mut command)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let run = async {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let mut stdout = stdout.take(limit as u64 + 1);
        let mut stderr = stderr.take(limit as u64 + 1);
        let (status, read_out, read_err) = tokio::join!(
            child.wait(),
            stdout.read_to_end(&mut out),
            stderr.read_to_end(&mut err)
        );
        read_out?;
        read_err?;
        if out.len() > limit || err.len() > limit {
            return Err(io::Error::other("Command output exceeded limit"));
        }
        Ok(std::process::Output {
            status: status?,
            stdout: out,
            stderr: err,
        })
    };
    tokio::time::timeout(timeout, run)
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "Command timed out"))?
}

pub async fn output(command: Command, timeout: Duration) -> io::Result<String> {
    let output = capture(command, timeout).await?;
    if !output.status.success() {
        return Err(io::Error::other("Command failed"));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unresponsive_and_oversized_commands_return_errors() {
        let mut sleeper = Command::new("/bin/sleep");
        sleeper.arg("10");
        assert_eq!(
            capture(sleeper, Duration::from_millis(100))
                .await
                .unwrap_err()
                .kind(),
            io::ErrorKind::TimedOut
        );
        let mut oversized = Command::new("/usr/bin/head");
        oversized.args(["-c", "1048577", "/dev/zero"]);
        assert_eq!(
            capture(oversized, Duration::from_secs(3))
                .await
                .unwrap_err()
                .to_string(),
            "Command output exceeded limit"
        );
    }
}
