use super::*;
use std::{
    os::fd::AsRawFd,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    sync::LazyLock,
};

const MAX_AUTH_BYTES: u64 = 2 * 1024 * 1024;

fn valid_label(label: &str) -> bool {
    !label.is_empty()
        && label.len() <= 128
        && label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
}

pub(super) fn switch_command(provider: &str, label: &str) -> io::Result<String> {
    if !["claude", "openai"].contains(&provider) || !valid_label(label) {
        return Err(err("올바른 저장 계정을 선택하세요."));
    }
    Ok(format!("/account {provider} switch {label}\r"))
}

// Account switching is allowed at an empty composer after a failed request.
// Permission dialogs, drafts and active turns must still block the write.
pub(super) fn switch_input_allowed(lines: &[String]) -> bool {
    static ERROR_LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(
        r"(?i)invalid_request_error|last request failed|Press Ctrl\+Y|^\s*(You've hit your usage limit|Usage limit reached|Rate limit reached)\b"
    ).unwrap()
    });
    if lines
        .iter()
        .any(|line| line.to_lowercase().contains("permission required"))
    {
        return false;
    }
    static COMPOSER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*[0-9]+[>…]").unwrap());
    let Some(composer) = lines.iter().rposition(|line| COMPOSER.is_match(line)) else {
        return false;
    };
    let filtered: Vec<_> = lines
        .iter()
        .enumerate()
        .filter(|(index, line)| *index >= composer || !ERROR_LINE.is_match(line))
        .map(|(_, line)| line.clone())
        .collect();
    activity::screen_state(&filtered, true, "jcode", false, false) == "idle"
}

fn account_metadata(value: &Value, provider: &str) -> Vec<Value> {
    let (list, active, access, refresh) = if provider == "claude" {
        (
            "anthropic_accounts",
            "active_anthropic_account",
            "access",
            "refresh",
        )
    } else {
        (
            "openai_accounts",
            "active_openai_account",
            "access_token",
            "refresh_token",
        )
    };
    value[list]
        .as_array()
        .into_iter()
        .flatten()
        .take(100)
        .filter_map(|account| {
            let label = account["label"].as_str()?;
            if !valid_label(label) {
                return None;
            }
            let available = [access, refresh]
                .iter()
                .any(|key| account[*key].as_str().is_some_and(|s| !s.is_empty()));
            Some(json!({"provider":provider,"label":label,
            "email":account["email"].as_str().map(|s|s.chars().take(254).collect::<String>()),
            "isDefault":value[active] == label,"available":available}))
        })
        .collect()
}

fn read_pool(path: &Path, provider: &str) -> io::Result<Vec<Value>> {
    let directory = crate::accounts::account_directory(
        path.parent().ok_or_else(|| err("Invalid account path"))?,
    )?;
    let pinned = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(
        path.file_name()
            .ok_or_else(|| err("Invalid account path"))?,
    );
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(pinned)
    {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(err("저장 계정 파일에 접근할 수 없습니다.")),
    };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.len() > MAX_AUTH_BYTES
    {
        return Err(err(
            "저장 계정 파일의 소유권 또는 형식을 확인할 수 없습니다.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(MAX_AUTH_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_AUTH_BYTES {
        return Err(err("저장 계정 파일이 너무 큽니다."));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| err("저장 계정 파일 형식이 올바르지 않습니다."))?;
    Ok(account_metadata(&value, provider))
}

impl Store {
    pub(super) fn process_home(&self, entry: &Entry) -> io::Result<(u32, PathBuf)> {
        let (root, dead) = self.pane_identity(entry)?;
        if dead {
            return Err(err("실행 중인 jcode 세션에서 계정을 바꿀 수 있습니다."));
        }
        let (pid, kind) = activity::detect_process(Some(root))?
            .ok_or_else(|| err("실행 중인 AI를 확인할 수 없습니다."))?;
        if kind != "jcode" {
            return Err(err("현재 이 버튼은 jcode의 저장 계정을 지원합니다."));
        }
        let mut env = Vec::new();
        File::open(format!("/proc/{pid}/environ"))?
            .take(1024 * 1024 + 1)
            .read_to_end(&mut env)?;
        if env.len() > 1024 * 1024 {
            return Err(err("세션 계정 경로를 확인할 수 없습니다."));
        }
        let variable = |key: &[u8]| {
            env.split(|b| *b == 0)
                .find_map(|item| item.strip_prefix(key))
                .and_then(|value| std::str::from_utf8(value).ok())
                .filter(|s| !s.is_empty())
        };
        let home = variable(b"JCODE_HOME=")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                variable(b"HOME=")
                    .map(PathBuf::from)
                    .unwrap_or_else(|| self.home.clone())
                    .join(".jcode")
            });
        if !home.is_absolute() {
            return Err(err("jcode 계정 경로는 절대 경로여야 합니다."));
        }
        Ok((pid, home))
    }

    pub(super) fn native_accounts(&self, entry: &Entry) -> io::Result<Value> {
        use sha2::{Digest, Sha256};
        let (_, home) = self.process_home(entry)?;
        let mut accounts = read_pool(&home.join("auth.json"), "claude")?;
        accounts.extend(read_pool(&home.join("openai-auth.json"), "openai")?);
        for account in &mut accounts {
            let fingerprint = json!([
                home,
                account["provider"],
                account["label"],
                account["email"]
            ]);
            account["selectionKey"] = json!(format!(
                "{:x}",
                Sha256::digest(fingerprint.to_string().as_bytes())
            ));
        }
        Ok(json!({"accounts":accounts,"agent":"jcode"}))
    }

    pub(super) fn selectable_accounts(&self, entry: &Entry) -> io::Result<Value> {
        let (_, home) = self.process_home(entry)?;
        let managed_home = self.directory.join("jcode-accounts");
        let managed = home == managed_home;
        let mut native = self.native_accounts(entry)?;
        let pool = crate::jcode_accounts::metadata(&managed_home).ok();
        let registered = self.accounts.registered_accounts().map_err(err)?;
        let mut choices = Vec::new();
        for mut account in registered {
            if let Ok(profile) = self
                .accounts
                .native_profile(account["id"].as_str().unwrap_or(""))
            {
                if profile.exists() || profile.binary.is_file() {
                    let available = profile.credentials().is_ok_and(|auth| auth.is_some())
                        && profile.binary.is_file()
                        && !self.accounts.usage.native_login_rejected(&profile);
                    account["provider"] = json!(profile.provider);
                    account["label"] = json!(profile.label);
                    account["source"] = json!("cockpit");
                    account["available"] = json!(available);
                    account["requiresConnection"] = json!(home != profile.home);
                    account["isDefault"] = json!(home == profile.home);
                    account["authEngine"] = json!("jcode");
                    choices.push(account);
                    continue;
                }
            }
            let stored = pool
                .as_ref()
                .and_then(|pool| pool["accounts"].as_array())
                .and_then(|accounts| accounts.iter().find(|item| item["id"] == account["id"]));
            account["provider"] = json!(if account["provider"] == "codex" {
                "openai"
            } else {
                "claude"
            });
            account["source"] = json!("cockpit");
            account["available"] = json!(
                !managed
                    || stored.is_some_and(|stored| native["accounts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["label"] == stored["label"] && item["available"] == true))
            );
            account["requiresConnection"] = json!(!managed);
            if let Some(stored) = stored {
                account["label"] = stored["label"].clone();
                if managed {
                    account["isDefault"] = json!(native["accounts"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|item| item["provider"] == account["provider"]
                            && item["label"] == stored["label"]
                            && item["isDefault"] == true));
                }
            }
            choices.push(account);
        }
        for mut account in native["accounts"].as_array().unwrap().clone() {
            if managed && choices.iter().any(|item| item["label"] == account["label"]) {
                continue;
            }
            if choices.iter().any(|item| {
                item["authEngine"] == "jcode"
                    && item["isDefault"] == true
                    && item["label"] == account["label"]
                    && item["provider"] == account["provider"]
            }) {
                continue;
            }
            account["source"] = json!("jcode");
            choices.push(account);
        }
        native["accounts"] = json!(choices);
        native["managed"] = json!(managed);
        Ok(native)
    }

    pub(super) fn managed_launch(&self, saved: &Value, command: &str) -> io::Result<String> {
        let managed = saved["jcodeHomeManaged"] == true;
        if !managed && saved["jcodeSourceHome"].as_str().is_none() {
            return Ok(command.into());
        }
        if command.split_whitespace().next() != Some("jcode") || !recovery_command(command) {
            return Err(err("저장된 jcode 실행 명령을 확인하세요."));
        }
        if !managed {
            let home = saved["jcodeSourceHome"].as_str().unwrap();
            let socket = saved["jcodeSourceSocket"]
                .as_str()
                .filter(|value| Path::new(value).is_absolute())
                .ok_or_else(|| err("원래 jcode 연결 경로를 확인하세요."))?;
            crate::accounts::account_directory(Path::new(home))?;
            let runtime = match saved["jcodeSourceRuntime"].as_str() {
                Some(value) if Path::new(value).is_absolute() => {
                    format!(" JCODE_RUNTIME_DIR={}", shell_quote(value))
                }
                None => String::new(),
                _ => return Err(err("원래 jcode 실행 경로를 확인하세요.")),
            };
            let home_arg = if saved["jcodeSourceHomeImplicit"] == true {
                "-u JCODE_HOME".into()
            } else {
                format!("JCODE_HOME={}", shell_quote(home))
            };
            return Ok(format!("/usr/bin/env -u JCODE_DEBUG_SOCKET -u JCODE_RUNTIME_DIR {home_arg} JCODE_SOCKET={}{runtime} {command}", shell_quote(socket)));
        }
        let home = self.directory.join("jcode-accounts");
        crate::jcode_accounts::metadata(&home)?;
        let runtime = home.join("runtime");
        use std::os::unix::fs::DirBuilderExt;
        match fs::DirBuilder::new().mode(0o700).create(&runtime) {
            Ok(()) => (),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
            Err(error) => return Err(error),
        }
        let pinned = crate::accounts::account_directory(&runtime)?;
        let meta = pinned.metadata()?;
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
            || runtime.as_os_str().len() + "/jcode-debug.sock".len() >= 108
        {
            return Err(err("전용 jcode 연결 폴더의 권한 또는 길이를 확인하세요."));
        }
        Ok(format!("/usr/bin/env -u JCODE_SOCKET -u JCODE_DEBUG_SOCKET JCODE_HOME={} JCODE_RUNTIME_DIR={} {command}", shell_quote(home.to_str().ok_or_else(||err("Invalid account path"))?), shell_quote(runtime.to_str().ok_or_else(||err("Invalid runtime path"))?)))
    }

    pub(super) fn check_native_account(
        &self,
        entry: &Entry,
        provider: &str,
        label: &str,
    ) -> io::Result<()> {
        switch_command(provider, label)?;
        let saved = entry.meta.lock().unwrap().saved.clone();
        if saved["accountHandoffError"].is_string() {
            let (pid, home) = self.process_home(entry)?;
            let expected = if saved["accountEngine"] == "jcode" {
                self.accounts
                    .native_profile(value_text(&saved, "accountId"))
                    .map_err(err)?
                    .home
            } else if saved["jcodeHomeManaged"] == true {
                self.directory.join("jcode-accounts")
            } else {
                PathBuf::from(saved["jcodeSourceHome"].as_str().unwrap_or(""))
            };
            if home != expected
                || crate::jcode_session::identify(pid, &home)?.id
                    != saved["jcodeSessionId"].as_str().unwrap_or("")
            {
                return Err(err(
                    "저장한 대화와 현재 연결이 달라 계정 전환을 보류했습니다.",
                ));
            }
        }
        if !self.native_accounts(entry)?["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .any(|account| {
                account["provider"] == provider
                    && account["label"] == label
                    && account["available"] == true
            })
        {
            return Err(err(
                "사용할 수 있는 저장 계정이 아닙니다. 목록을 새로고침하세요.",
            ));
        }
        Ok(())
    }

    pub(super) fn check_account_selection(
        &self,
        entry: &Entry,
        provider: &str,
        label: &str,
        selection: Option<&str>,
    ) -> io::Result<()> {
        self.check_native_account(entry, provider, label)?;
        if let Some(key) = selection {
            if !self.native_accounts(entry)?["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| {
                    item["provider"] == provider
                        && item["label"] == label
                        && item["selectionKey"] == key
                })
            {
                return Err(err(
                    "계정 목록을 읽은 뒤 연결이 변경됐습니다. 목록을 다시 여세요.",
                ));
            }
        }
        Ok(())
    }
}

pub(super) fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_public_account_metadata_leaves_the_store() {
        let accounts = account_metadata(
            &json!({"anthropic_accounts":[{"label":"claude-otter","access":"secret-access","refresh":"secret-refresh","email":"test@example.invalid"},{"label":"bad\nlabel","access":"hidden"}],"active_anthropic_account":"claude-otter"}),
            "claude",
        );
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0]["isDefault"], true);
        assert_eq!(accounts[0]["available"], true);
        assert!(!serde_json::to_string(&accounts).unwrap().contains("secret"));
        for label in ["bad\rlabel", "x y", "../a", "$(id)", ""] {
            assert!(switch_command("claude", label).is_err());
        }
        assert!(switch_command("shell", "claude-otter").is_err());
    }
    #[test]
    fn switch_requires_an_empty_jcode_composer_even_after_rate_limit() {
        for lines in [
            vec!["1>"],
            vec![
                "23> \u{f0318}",
                " /work/project merge/rust ?136 ↑1 114k/1M ▰▱▱▱ 11% OAuth OpenAI GPT-6 Astra xhigh",
            ],
            vec![
                "23> \u{f0318}",
                " ~/…/project merge/dev-r… ±193 ↑1 ▱▱▱▱ 11% GPT-6 Astra xhigh",
            ],
            vec![
                "Usage limit reached",
                "Last request failed. Press Ctrl+Y to retry",
                "1>",
            ],
        ] {
            assert!(switch_input_allowed(
                &lines.into_iter().map(String::from).collect::<Vec<_>>()
            ));
        }
        for lines in [
            vec!["1> draft"],
            vec![
                "23> unfinished",
                " /work/project merge/rust ?136 ↑1 114k/1M ▰▱▱▱ 11% OAuth OpenAI GPT-6 Astra xhigh",
            ],
            vec!["1…"],
            vec!["Do you want to proceed?", "1. Yes", "1>"],
            vec!["permission required", "1>"],
            vec!["Starting session", "1>"],
            vec!["Last request failed", "1> /other-command"],
            vec!["1>", "2> invalid_request_error 처리해줘"],
            vec!["1>", "2> Press Ctrl+Y"],
            vec!["2>", "invalid_request_error 처리해줘"],
            vec!["1>", "2>", "Press Ctrl+Y"],
        ] {
            assert!(!switch_input_allowed(
                &lines.into_iter().map(String::from).collect::<Vec<_>>()
            ));
        }
    }
}
