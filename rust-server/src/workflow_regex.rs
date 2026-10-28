//! ECMAScript matching runs in a short-lived native child so backtracking cannot
//! keep the server busy after the workflow deadline.
use crate::board_value::{object, V};
use std::{
    io::{Read, Write},
    process::Stdio,
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 8 * 1024 * 1024;
fn evaluate(input: &V) -> Result<bool, String> {
    let pattern = &input["pattern"];
    if !pattern.is_string()
        || pattern.units().len() > 200
        || regex::Regex::new(r"[+*{]\)[+*{?]")
            .unwrap()
            .is_match(&pattern.text())
    {
        return Err("Unsafe regex pattern detected".into());
    }
    let regex = regress::Regex::from_unicode(pattern.units().iter().map(|unit| *unit as u32), "i")
        .map_err(|_| "Invalid workflow regex pattern")?;
    let value = if input["value"].is_string() {
        input["value"].clone()
    } else {
        input["value"].text().into()
    };
    Ok(regex.find_from_ucs2(value.units(), 0).next().is_some())
}
pub fn child() -> Result<(), Box<dyn std::error::Error>> {
    let mut bytes = vec![];
    std::io::stdin()
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LIMIT {
        return Err("Workflow regex input exceeds limit".into());
    }
    let raw = serde_json::value::RawValue::from_string(String::from_utf8(bytes)?)?;
    let input = V::parse(&raw).map_err(std::io::Error::other)?;
    let result = match evaluate(&input) {
        Ok(matched) => object([("matched", matched.into())]),
        Err(error) => object([("error", error.into())]),
    };
    std::io::stdout().write_all(result.raw().get().as_bytes())?;
    Ok(())
}
pub async fn is_match(pattern: &V, value: &V) -> Result<bool, String> {
    let input = object([("pattern", pattern.clone()), ("value", value.clone())]).raw();
    if input.get().len() > LIMIT {
        return Err("Workflow regex input exceeds limit".into());
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(test)]
    let executable = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("cockpit-server");
    let mut child = tokio::process::Command::new(executable)
        .arg("--workflow-regex")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap().take(4096);
    let mut output = vec![];
    let execution = async {
        let (status, (), _) = tokio::try_join!(
            child.wait(),
            async move {
                stdin.write_all(input.get().as_bytes()).await?;
                stdin.shutdown().await?;
                drop(stdin);
                Ok::<_, std::io::Error>(())
            },
            stdout.read_to_end(&mut output)
        )?;
        Ok::<_, std::io::Error>(status)
    };
    let result = tokio::time::timeout(Duration::from_secs(1), execution).await;
    if !matches!(result, Ok(Ok(status)) if status.success()) {
        let _ = child.kill().await;
        let _ = child.wait().await;
        return Err(if result.is_err() {
            "Workflow regex timed out"
        } else {
            "Workflow regex failed"
        }
        .into());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output).map_err(|_| "Invalid workflow regex response")?;
    value["matched"].as_bool().ok_or_else(|| {
        value["error"]
            .as_str()
            .unwrap_or("Workflow regex failed")
            .into()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ecmascript_features_and_non_unicode_surrogates() {
        assert!(evaluate(&object([
            ("pattern", "^42$".into()),
            ("value", 42.0.into())
        ]))
        .unwrap());
        for (pattern, value, expected) in [
            (r"(?<=a)b", "ab", true),
            (r"^(a)\1$", "AA", true),
            (r"^..$", "😀", true),
            (r"^.$", "😀", false),
            (r"\w", "é", false),
        ] {
            assert_eq!(
                evaluate(&object([
                    ("pattern", pattern.into()),
                    ("value", value.into())
                ]))
                .unwrap(),
                expected
            );
        }
    }
    #[tokio::test]
    async fn pathological_expression_is_terminated_without_blocking_server() {
        assert!(
            !is_match(&V::String(vec![94, 0xd800, 36]), &V::String(vec![0xdc00]))
                .await
                .unwrap()
        );
        assert!(is_match(&r"(?<=a)b".into(), &"ab".into()).await.unwrap());
        let result = is_match(
            &r"^(a|aa)+$".into(),
            &format!("{}!", "a".repeat(10000)).into(),
        )
        .await;
        assert_eq!(result.unwrap_err(), "Workflow regex timed out");
    }
}
