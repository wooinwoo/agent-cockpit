//! One native credential owner per registered account. Existing CLI credentials are never copied.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone)]
pub struct Profile {
    pub home: PathBuf,
    pub binary: PathBuf,
    pub provider: String,
    pub label: String,
    pub email: String,
    id: String,
    settings_home: Option<PathBuf>,
}

fn invalid() -> io::Error {
    io::Error::other("jcode 계정 정보를 확인하지 못했습니다. 기존 로그인은 변경하지 않았습니다.")
}
fn private(path: &Path, directory: bool) -> io::Result<()> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::symlink_metadata(path)?;
    if meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || (directory && !meta.is_dir())
        || (!directory && (!meta.is_file() || meta.nlink() != 1 || meta.len() > 1_048_576))
    {
        return Err(invalid());
    }
    Ok(())
}
fn read(directory: &File, name: &str) -> io::Result<Value> {
    use std::{
        os::fd::AsRawFd,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let path = PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd())).join(name);
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != unsafe { libc::geteuid() }
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > 1_048_576
    {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return Err(invalid());
    }
    serde_json::from_slice(&bytes).map_err(|_| invalid())
}
fn write(path: &Path, value: &Value) -> io::Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)?;
    file.write_all(&serde_json::to_vec(value).map_err(|_| invalid())?)?;
    file.sync_all()
}
fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

impl Profile {
    pub fn new(
        directory: &Path,
        account_home: &Path,
        id: &str,
        provider: &str,
        email: &str,
    ) -> io::Result<Self> {
        let email = email.trim();
        if !account_home.is_absolute()
            || id.len() != 16
            || !id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || !["claude", "codex"].contains(&provider)
            || email.is_empty()
            || email.len() > 254
            || email.chars().any(char::is_control)
        {
            return Err(invalid());
        }
        let provider = if provider == "codex" {
            "openai"
        } else {
            "claude"
        };
        Ok(Self {
            home: account_home.join(".jcode"),
            binary: directory.join("jcode-engine/jcode"),
            provider: provider.into(),
            label: format!("{provider}-otter"),
            email: email.into(),
            id: id.into(),
            settings_home: None,
        })
    }
    pub fn with_settings(mut self, home: &Path) -> Self {
        self.settings_home = Some(home.into());
        self
    }
    pub fn exists(&self) -> bool {
        !matches!(fs::symlink_metadata(&self.home), Err(e) if e.kind() == io::ErrorKind::NotFound)
    }
    pub fn credential_file(&self) -> PathBuf {
        self.home.join(if self.provider == "claude" {
            "auth.json"
        } else {
            "openai-auth.json"
        })
    }
    pub fn login_command(&self) -> String {
        format!("jcode --no-update --no-selfdev login --provider={} --account={} --expected-email={} --no-validate",self.provider,self.label,quote(&self.email))
    }
    pub fn worker_command(&self) -> String {
        format!(
            "jcode --no-update --no-selfdev --provider={}",
            self.provider
        )
    }
    pub fn credentials(&self) -> io::Result<Option<Value>> {
        if !self.exists() {
            return Ok(None);
        }
        private(&self.home, true)?;
        let directory = crate::accounts::account_directory(&self.home)?;
        let marker = read(&directory, "cockpit-account.json")?;
        if marker["version"] != 1
            || marker["id"] != self.id
            || marker["provider"] != self.provider
            || !marker["email"]
                .as_str()
                .is_some_and(|email| email.eq_ignore_ascii_case(&self.email))
        {
            return Err(invalid());
        }
        let value = read(
            &directory,
            self.credential_file()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap(),
        )?;
        let list = value[if self.provider == "claude" {
            "anthropic_accounts"
        } else {
            "openai_accounts"
        }]
        .as_array()
        .filter(|list| list.len() == 1)
        .ok_or_else(invalid)?;
        let account = &list[0];
        if account["label"] != self.label
            || !account["email"]
                .as_str()
                .is_some_and(|email| email.eq_ignore_ascii_case(&self.email))
        {
            return Err(invalid());
        }
        let (access, refresh) = if self.provider == "claude" {
            ("access", "refresh")
        } else {
            ("access_token", "refresh_token")
        };
        if account[access] == "" && account[refresh] == "" {
            return Ok(None);
        }
        if !account[access]
            .as_str()
            .is_some_and(|token| !token.is_empty())
        {
            return Err(invalid());
        }
        if self.provider == "claude" {
            Ok(Some(
                json!({"accessToken":account[access],"refreshToken":account[refresh],"expiresAt":account["expires"]}),
            ))
        } else {
            if !account["account_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty())
            {
                return Err(invalid());
            }
            if marker["workspaceId"]
                .as_str()
                .is_some_and(|id| account["account_id"] != id)
            {
                return Err(invalid());
            }
            Ok(Some(
                json!({"access_token":account[access],"refresh_token":account[refresh],"expires_at":account["expires_at"],"account_id":account["account_id"]}),
            ))
        }
    }
    pub fn prepare(&self, workspace: Option<&str>) -> io::Result<()> {
        if self.exists() {
            self.credentials()?;
            return Ok(());
        }
        use std::{
            ffi::CString,
            os::{fd::AsRawFd, unix::fs::PermissionsExt},
        };
        let parent = self.home.parent().ok_or_else(invalid)?;
        private(parent, true)?;
        let pinned = crate::accounts::account_directory(parent)?;
        let stage = tempfile::Builder::new()
            .prefix(".jcode-init-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(format!("/proc/self/fd/{}", pinned.as_raw_fd()))?;
        let auth = if self.provider == "claude" {
            json!({"anthropic_accounts":[{"label":self.label,"email":self.email,"access":"","refresh":"","expires":0,"scopes":[]}],"active_anthropic_account":self.label})
        } else {
            let mut account = json!({"label":self.label,"email":self.email,"access_token":"","refresh_token":"","expires_at":0});
            if let Some(workspace) = workspace.filter(|id| !id.is_empty()) {
                account["account_id"] = workspace.into();
            }
            json!({"openai_accounts":[account],"active_openai_account":self.label})
        };
        write(
            &stage
                .path()
                .join(self.credential_file().file_name().unwrap()),
            &auth,
        )?;
        write(
            &stage.path().join("cockpit-account.json"),
            &json!({"version":1,"id":self.id,"provider":self.provider,"email":self.email,"workspaceId":workspace}),
        )?;
        if let Some(home) = &self.settings_home {
            let native = home.join(".jcode");
            if native.is_dir() {
                crate::jcode_session::copy_user_settings(
                    home,
                    &parent.join(stage.path().file_name().ok_or_else(invalid)?),
                )?;
            }
            // Share only tool settings and instructions; never link a credential directory.
            for (source, destination) in [
                (native.join("skills"), PathBuf::from("skills")),
                (
                    native.join("prompt-overlay.md"),
                    PathBuf::from("prompt-overlay.md"),
                ),
                (
                    native.join("preferred-tools.md"),
                    PathBuf::from("preferred-tools.md"),
                ),
                (home.join("AGENTS.md"), PathBuf::from("external/AGENTS.md")),
                (
                    home.join(".agents/skills"),
                    PathBuf::from("external/.agents/skills"),
                ),
                (
                    home.join(".claude/skills"),
                    PathBuf::from("external/.claude/skills"),
                ),
                (
                    home.join(".claude/plugins"),
                    PathBuf::from("external/.claude/plugins"),
                ),
                (
                    home.join(".codex/skills"),
                    PathBuf::from("external/.codex/skills"),
                ),
                (
                    home.join(".codex/config.toml"),
                    PathBuf::from("external/.codex/config.toml"),
                ),
            ] {
                if !source.exists() {
                    continue;
                }
                let destination = stage.path().join(destination);
                fs::create_dir_all(destination.parent().ok_or_else(invalid)?)?;
                std::os::unix::fs::symlink(source, destination)?;
            }
        }
        File::open(stage.path())?.sync_all()?;
        let old = CString::new(
            stage
                .path()
                .file_name()
                .unwrap()
                .to_str()
                .ok_or_else(invalid)?,
        )
        .map_err(|_| invalid())?;
        let target = CString::new(".jcode").unwrap();
        if unsafe {
            libc::renameat2(
                pinned.as_raw_fd(),
                old.as_ptr(),
                pinned.as_raw_fd(),
                target.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } != 0
        {
            if io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                return Err(invalid());
            }
            self.credentials()?;
        }
        pinned.sync_all()?;
        Ok(())
    }
    fn environment(&self) -> io::Result<Vec<(&'static str, String)>> {
        use std::os::unix::fs::DirBuilderExt;
        let root =
            std::env::temp_dir().join(format!("cockpit-jcode-{}", unsafe { libc::geteuid() }));
        let key = format!(
            "{:x}",
            Sha256::digest(self.home.as_os_str().as_encoded_bytes())
        );
        let runtime = root.join(&key[..24]);
        for path in [&root, &runtime] {
            match fs::DirBuilder::new().mode(0o700).create(path) {
                Ok(()) => (),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
                Err(_) => return Err(invalid()),
            }
            private(path, true)?;
            crate::accounts::account_directory(path)?;
        }
        let path = |value: &Path| value.to_str().map(str::to_owned).ok_or_else(invalid);
        if runtime.as_os_str().len() + "/jcode-debug.sock".len() >= 108 {
            return Err(invalid());
        }
        let mut values = vec![
            ("JCODE_HOME", path(&self.home)?),
            ("JCODE_RUNTIME_DIR", path(&runtime)?),
            ("JCODE_SOCKET", path(&runtime.join("jcode.sock"))?),
            (
                "JCODE_DEBUG_SOCKET",
                path(&runtime.join("jcode-debug.sock"))?,
            ),
            ("JCODE_ACCOUNT_ONLY", "1".into()),
            ("JCODE_EXPECTED_EMAIL", self.email.clone()),
        ];
        if self.provider == "openai" {
            if let Some(auth) = self.credentials()? {
                values.push((
                    "JCODE_EXPECTED_WORKSPACE",
                    auth["account_id"].as_str().ok_or_else(invalid)?.to_owned(),
                ));
            }
        }
        Ok(values)
    }
    fn removed_environment() -> Vec<String> {
        let mut keys: Vec<String> = [
            "CLAUDE_CONFIG_DIR",
            "CODEX_HOME",
            "CLAUDECODE",
            "CLAUDE_CODE_OAUTH_TOKEN",
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "OPENAI_API_KEY",
            "JCODE_ALLOW_CODEX_LEGACY_AUTH",
            "JCODE_NAMED_PROVIDER_PROFILE",
        ]
        .map(String::from)
        .into();
        keys.extend(["JCODE_EXPECTED_EMAIL", "JCODE_EXPECTED_WORKSPACE"].map(String::from));
        keys.extend(
            std::env::vars_os()
                .filter_map(|(key, _)| key.into_string().ok())
                .filter(|key| {
                    [
                        "JCODE_ANTHROPIC_",
                        "JCODE_OPENAI_COMPAT_",
                        "JCODE_PROVIDER_PROFILE_",
                    ]
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
                }),
        );
        keys
    }
    pub fn configure(&self, command: &mut tokio::process::Command) -> io::Result<()> {
        for key in Self::removed_environment() {
            command.env_remove(key);
        }
        for (key, value) in self.environment()? {
            command.env(key, value);
        }
        Ok(())
    }
    pub fn command(&self, logical: &str) -> io::Result<String> {
        let tail = logical
            .strip_prefix("jcode")
            .filter(|tail| tail.is_empty() || tail.starts_with(' '))
            .ok_or_else(invalid)?;
        let mut command = String::from("/usr/bin/env");
        for key in Self::removed_environment() {
            command.push_str(&format!(" -u {}", quote(&key)));
        }
        for (key, value) in self.environment()? {
            command.push_str(&format!(" {key}={}", quote(&value)));
        }
        command.push_str(&format!(
            " {}{tail}",
            quote(self.binary.to_str().ok_or_else(invalid)?)
        ));
        Ok(command)
    }
    pub async fn check_engine(&self) -> io::Result<()> {
        let probe = tempfile::Builder::new()
            .prefix("cockpit-jcode-capability-")
            .tempdir()?;
        let mut command = tokio::process::Command::new(&self.binary);
        command.args(["--no-update", "--no-selfdev", "cockpit-account"]);
        for key in Self::removed_environment() {
            command.env_remove(key);
        }
        for key in ["JCODE_SOCKET", "JCODE_DEBUG_SOCKET", "JCODE_RUNTIME_DIR"] {
            command.env_remove(key);
        }
        command
            .env("JCODE_HOME", probe.path())
            .env("JCODE_NO_TELEMETRY", "1")
            .env("JCODE_ACCOUNT_ONLY", "1")
            .env("JCODE_EXPECTED_EMAIL", &self.email);
        let result = crate::commands::capture_with_limit(command, Duration::from_secs(5), 16_384)
            .await
            .map_err(|_| invalid())?;
        let value: Value = serde_json::from_slice(&result.stdout).map_err(|_| invalid())?;
        if !result.status.success()
            || value["version"] != 1
            || value["nativeAccountOnly"] != true
            || value["guardedLogin"] != true
            || value["guardedInitialization"] != true
            || value["refreshOwner"] != "jcode"
            || value["accountCostRecords"] != true
        {
            return Err(invalid());
        }
        Ok(())
    }
    pub async fn refresh(&self, force: bool) -> Value {
        let mut command = tokio::process::Command::new(&self.binary);
        command.args([
            "--no-update",
            "--no-selfdev",
            "cockpit-account",
            "--refresh",
            "--provider",
            &self.provider,
            "--account",
            &self.label,
            "--expected-email",
            &self.email,
        ]);
        if force {
            command.arg("--force");
        }
        if self.configure(&mut command).is_err() {
            return json!({"ok":false,"code":"credential_unavailable"});
        }
        match crate::commands::capture_with_limit(command, Duration::from_secs(40), 16_384).await {
            Ok(output) if output.status.success() => serde_json::from_slice(&output.stdout)
                .unwrap_or(json!({"ok":false,"code":"credential_unavailable"})),
            _ => json!({"ok":false,"code":"network_error"}),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn profile(provider: &str) -> (tempfile::TempDir, Profile) {
        let temporary = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let profile = Profile::new(
            temporary.path(),
            temporary.path(),
            "0123456789abcdef",
            provider,
            "one@example.com",
        )
        .unwrap();
        (temporary, profile)
    }
    #[test]
    fn initialization_never_copies_or_overwrites_credentials() {
        let (temporary, profile) = profile("claude");
        fs::write(
            temporary.path().join(".credentials.json"),
            "old-cli-credential",
        )
        .unwrap();
        profile.prepare(None).unwrap();
        assert!(profile.credentials().unwrap().is_none());
        let mut native: Value =
            serde_json::from_slice(&fs::read(profile.credential_file()).unwrap()).unwrap();
        native["anthropic_accounts"][0]["access"] = "new-native-credential".into();
        native["anthropic_accounts"][0]["refresh"] = "new-native-refresh".into();
        fs::write(profile.credential_file(), native.to_string()).unwrap();
        let before = fs::read(profile.credential_file()).unwrap();
        profile.prepare(None).unwrap();
        assert_eq!(fs::read(profile.credential_file()).unwrap(), before);
        assert_eq!(
            fs::read_to_string(temporary.path().join(".credentials.json")).unwrap(),
            "old-cli-credential"
        );
        let changed = Profile::new(
            temporary.path(),
            temporary.path(),
            "0123456789abcdef",
            "claude",
            "other@example.com",
        )
        .unwrap();
        assert!(changed.credentials().is_err());
    }
    #[test]
    fn workspace_and_file_privacy_are_verified_before_use() {
        let (_temporary, profile) = profile("codex");
        profile.prepare(Some("workspace-one")).unwrap();
        let mut native: Value =
            serde_json::from_slice(&fs::read(profile.credential_file()).unwrap()).unwrap();
        native["openai_accounts"][0]["access_token"] = "native-access".into();
        native["openai_accounts"][0]["refresh_token"] = "native-refresh".into();
        native["openai_accounts"][0]["account_id"] = "workspace-two".into();
        fs::write(profile.credential_file(), native.to_string()).unwrap();
        assert!(profile.credentials().is_err());
        native["openai_accounts"][0]["account_id"] = "workspace-one".into();
        fs::write(profile.credential_file(), native.to_string()).unwrap();
        assert_eq!(
            profile.credentials().unwrap().unwrap()["account_id"],
            "workspace-one"
        );
        fs::set_permissions(profile.credential_file(), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(profile.credentials().is_err());
    }
    #[test]
    fn linked_profile_home_cannot_read_or_modify_another_profile() {
        let (temporary, profile) = profile("claude");
        let other = tempfile::tempdir().unwrap();
        symlink(other.path(), &profile.home).unwrap();
        assert!(profile.prepare(None).is_err());
        assert!(profile.credentials().is_err());
        assert_eq!(fs::read_dir(other.path()).unwrap().count(), 0);
        assert!(Profile::new(
            temporary.path(),
            temporary.path(),
            "../bad",
            "claude",
            "one@example.com"
        )
        .is_err());
    }
    #[test]
    fn tool_settings_survive_without_linking_oauth_credentials() {
        let (_temporary, profile) = profile("claude");
        let settings = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        fs::create_dir(settings.path().join(".jcode")).unwrap();
        fs::create_dir_all(settings.path().join(".agents/skills")).unwrap();
        fs::create_dir(settings.path().join(".claude")).unwrap();
        fs::write(
            settings.path().join(".jcode/config.toml"),
            "[display]\ntheme = 'dark'\n",
        )
        .unwrap();
        fs::write(settings.path().join(".claude.json"),r#"{"mcpServers":{"fixture":{"command":"/bin/true"}},"oauthAccount":{"emailAddress":"other@example.com"}}"#).unwrap();
        fs::write(
            settings.path().join(".claude/.credentials.json"),
            "unrelated-oauth",
        )
        .unwrap();
        for path in [".jcode", ".claude"] {
            fs::set_permissions(
                settings.path().join(path),
                fs::Permissions::from_mode(0o700),
            )
            .unwrap();
        }
        for path in [".jcode/config.toml", ".claude.json"] {
            fs::set_permissions(
                settings.path().join(path),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
        let profile = profile.with_settings(settings.path());
        profile.prepare(None).unwrap();
        assert_eq!(
            fs::read_to_string(profile.home.join("config.toml")).unwrap(),
            "[display]\ntheme = 'dark'\n"
        );
        let mcp: Value =
            serde_json::from_slice(&fs::read(profile.home.join("external/.claude.json")).unwrap())
                .unwrap();
        assert!(mcp["mcpServers"]["fixture"].is_object());
        assert!(mcp.get("oauthAccount").is_none());
        assert!(profile.home.join("external/.agents/skills").is_symlink());
        assert!(!profile
            .home
            .join("external/.claude/.credentials.json")
            .exists());
        assert!(profile.credentials().unwrap().is_none());
    }
    #[test]
    fn command_pins_the_binary_and_scrubs_external_credentials() {
        let (_temporary, profile) = profile("claude");
        profile.prepare(None).unwrap();
        let command = profile.command(&profile.worker_command()).unwrap();
        assert!(command.starts_with("/usr/bin/env -u 'CLAUDE_CONFIG_DIR'"));
        assert!(command.contains(" -u 'OPENAI_API_KEY'"));
        assert!(command.contains("JCODE_ACCOUNT_ONLY='1'"));
        assert!(command.contains("JCODE_EXPECTED_EMAIL='one@example.com'"));
        assert!(command.contains(profile.binary.to_str().unwrap()));
        assert!(profile.command("claude").is_err());
        let runtime = profile
            .environment()
            .unwrap()
            .into_iter()
            .find(|(key, _)| *key == "JCODE_RUNTIME_DIR")
            .unwrap()
            .1;
        assert!(runtime.len() + "/jcode-debug.sock".len() < 108);
        fs::remove_dir(runtime).unwrap();
    }
}
