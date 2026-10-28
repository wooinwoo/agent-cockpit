//! One-time installation into a new, Cockpit-owned JCODE_HOME. Existing stores
//! may belong to running jcode processes and are never rewritten or refreshed.
use serde_json::Value;
use std::{io, path::Path};

pub fn prepare(accounts: &crate::accounts::Store, home: &Path) -> io::Result<Value> {
    #[cfg(target_os = "linux")]
    {
        linux::prepare(accounts, home).map_err(|error| {
            if error
                .get_ref()
                .is_some_and(|cause| cause.is::<AccountFailure>())
            {
                error
            } else {
                invalid()
            }
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (accounts, home);
        Err(invalid())
    }
}

pub fn metadata(home: &Path) -> io::Result<Value> {
    #[cfg(target_os = "linux")]
    {
        linux::metadata(home).map_err(|_| invalid())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = home;
        Err(invalid())
    }
}

fn invalid() -> io::Error {
    // Parser errors can contain tokens. Never return their text or source paths.
    io::Error::other("jcode 계정 저장소를 확인하지 못했습니다. 기존 계정은 변경하지 않았습니다.")
}
#[derive(Debug)]
struct AccountFailure(String);
impl std::fmt::Display for AccountFailure {
    fn fmt(&self, output: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(output, "등록 계정 {}의 OAuth 정보를 확인하지 못했습니다. 원본과 기존 저장소는 변경하지 않았습니다.", self.0)
    }
}
impl std::error::Error for AccountFailure {}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::accounts::account_directory;
    use serde_json::json;
    use std::{
        collections::HashSet,
        ffi::CString,
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{
                ffi::OsStrExt,
                fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
            },
        },
        path::PathBuf,
    };

    const MANIFEST: &str = "cockpit-accounts.json";
    const MAX_FILE: u64 = 2 * 1024 * 1024;
    const ANIMALS: &[&str] = &[
        "otter", "fox", "panda", "wolf", "owl", "lynx", "badger", "raven", "tiger", "koala",
        "falcon", "gecko", "bison", "heron", "moose", "orca", "rabbit", "yak", "zebra", "beaver",
        "cougar", "dolphin", "ibis", "jaguar", "lemur", "marten", "newt", "quail", "seal",
        "wombat", "alpaca", "penguin",
    ];
    fn label(provider: &str, index: usize) -> String {
        match ANIMALS.get(index) {
            Some(animal) => format!("{provider}-{animal}"),
            None => format!("{provider}-animal-{}", index + 1),
        }
    }
    fn pinned(directory: &File) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
    }
    fn private(meta: &fs::Metadata, directory: bool) -> io::Result<()> {
        if meta.uid() != unsafe { libc::geteuid() }
            || meta.mode() & 0o077 != 0
            || (directory && !meta.is_dir())
            || (!directory && (!meta.is_file() || meta.nlink() != 1 || meta.len() > MAX_FILE))
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn file(directory: &File, name: &str) -> io::Result<File> {
        let name = CString::new(name).map_err(|_| invalid())?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(invalid());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        private(&file.metadata()?, false)?;
        Ok(file)
    }
    fn display_text(value: &Value, limit: usize) -> io::Result<String> {
        let text = value.as_str().ok_or_else(invalid)?;
        if text.chars().count() > limit || text.chars().any(char::is_control) {
            return Err(invalid());
        }
        Ok(text.into())
    }
    fn email_identity(value: &Value) -> io::Result<String> {
        let email = display_text(value, 254)?.trim().to_lowercase();
        if email.is_empty() {
            return Err(invalid());
        }
        Ok(email)
    }
    fn public_manifest(value: &Value) -> io::Result<Value> {
        if value["version"] != 1 {
            return Err(invalid());
        }
        let accounts = value["accounts"].as_array().ok_or_else(invalid)?;
        if accounts.is_empty() || accounts.len() > 100 {
            return Err(invalid());
        }
        let mut ids = HashSet::new();
        let mut counts = [0, 0];
        let mut result = Vec::new();
        for account in accounts {
            let id = account["id"].as_str().ok_or_else(invalid)?;
            if id.len() != 16
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
                || !ids.insert(id)
            {
                return Err(invalid());
            }
            let provider = account["provider"].as_str().ok_or_else(invalid)?;
            let slot = match provider {
                "claude" => 0,
                "openai" => 1,
                _ => return Err(invalid()),
            };
            let expected = label(provider, counts[slot]);
            counts[slot] += 1;
            if account["label"] != expected {
                return Err(invalid());
            }
            email_identity(&account["email"])?;
            result.push(json!({"id":id,"provider":provider,"label":expected,
                "name":display_text(&account["name"],120)?,"email":display_text(&account["email"],254)?}));
        }
        Ok(json!({"ready":true,"accountCount":result.len(),"accounts":result}))
    }
    fn metadata_from(directory: &File) -> io::Result<Value> {
        private(&directory.metadata()?, true)?;
        let read = |name: &str, limit: u64| -> io::Result<Value> {
            let mut bytes = Vec::new();
            file(directory, name)?
                .take(limit + 1)
                .read_to_end(&mut bytes)?;
            if bytes.len() as u64 > limit {
                return Err(invalid());
            }
            serde_json::from_slice(&bytes).map_err(|_| invalid())
        };
        let result = public_manifest(&read(MANIFEST, 128 * 1024)?)?;
        // jcode can relabel accounts after deletion. Validate the whole mapping
        // against current identities while leaving token refresh and writes to jcode.
        for (provider, name, key) in [
            ("claude", "auth.json", "anthropic_accounts"),
            ("openai", "openai-auth.json", "openai_accounts"),
        ] {
            let expected: Vec<_> = result["accounts"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|account| account["provider"] == provider)
                .collect();
            let auth = read(name, MAX_FILE)?;
            if !auth.is_object() {
                return Err(invalid());
            }
            let actual = match auth.get(key) {
                Some(Value::Array(accounts)) => accounts.as_slice(),
                None if expected.is_empty() => &[],
                _ => return Err(invalid()),
            };
            if actual.len() != expected.len() {
                return Err(invalid());
            }
            for (actual, expected) in actual.iter().zip(expected) {
                if actual["label"] != expected["label"]
                    || email_identity(&actual["email"])? != email_identity(&expected["email"])?
                {
                    return Err(invalid());
                }
            }
        }
        Ok(result)
    }
    pub(super) fn metadata(home: &Path) -> io::Result<Value> {
        metadata_from(&account_directory(home)?)
    }
    fn token<'a>(value: &'a Value, key: &str) -> io::Result<&'a str> {
        value[key]
            .as_str()
            .filter(|text| !text.trim().is_empty() && !text.chars().any(char::is_control))
            .ok_or_else(invalid)
    }
    fn expiry(value: &Value) -> io::Result<Option<i64>> {
        if value.is_null() {
            return Ok(None);
        }
        if let Some(n) = value.as_i64() {
            return Ok(Some(n));
        }
        if let Some(n) = value
            .as_f64()
            .filter(|n| n.is_finite() && *n >= i64::MIN as f64 && *n < i64::MAX as f64)
        {
            return Ok(Some(n as i64));
        }
        if let Some(text) = value.as_str() {
            let text = text.trim();
            if text.is_empty() {
                return Ok(None);
            }
            if let Ok(n) = text.parse::<i64>() {
                return Ok(Some(n));
            }
            if let Ok(date) = chrono::DateTime::parse_from_rfc3339(text) {
                return Ok(Some(date.timestamp_millis()));
            }
        }
        Err(invalid())
    }
    fn jwt_expiry(token: &str) -> Option<i64> {
        let payload = token.split('.').nth(1)?;
        if payload.len() > 64 * 1024 {
            return None;
        }
        let mut bytes = Vec::new();
        let (mut buffer, mut bits) = (0u32, 0);
        for ch in payload.bytes() {
            let value = match ch {
                b'A'..=b'Z' => ch - b'A',
                b'a'..=b'z' => ch - b'a' + 26,
                b'0'..=b'9' => ch - b'0' + 52,
                b'-' => 62,
                b'_' => 63,
                _ => return None,
            };
            buffer = (buffer << 6) | value as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                bytes.push((buffer >> bits) as u8);
            }
        }
        if bits >= 6 || (bits > 0 && buffer & ((1 << bits) - 1) != 0) {
            return None;
        }
        serde_json::from_slice::<Value>(&bytes).ok()?["exp"]
            .as_i64()?
            .checked_mul(1000)
    }
    fn convert(provider: &str, label: &str, raw: &Value) -> io::Result<Value> {
        if provider == "claude" {
            let oauth = &raw["claudeAiOauth"];
            let mut account = json!({"label":label,"access":token(oauth,"accessToken")?,
                "refresh":token(oauth,"refreshToken")?,"expires":expiry(&oauth["expiresAt"])?.unwrap_or(0)});
            let scopes: Vec<String> = match &oauth["scopes"] {
                Value::Null => Vec::new(),
                Value::String(text) => text.split_whitespace().map(String::from).collect(),
                Value::Array(items) => items
                    .iter()
                    .map(|v| v.as_str().map(String::from).ok_or_else(invalid))
                    .collect::<io::Result<_>>()?,
                _ => return Err(invalid()),
            };
            account["scopes"] = json!(scopes);
            if !oauth["subscriptionType"].is_null() {
                account["subscription_type"] = oauth["subscriptionType"]
                    .as_str()
                    .ok_or_else(invalid)?
                    .into();
            }
            Ok(account)
        } else {
            let oauth = &raw["tokens"];
            let access = token(oauth, "access_token")?;
            let mut account = json!({"label":label,"access_token":access,"refresh_token":token(oauth,"refresh_token")?});
            for key in ["account_id", "id_token"] {
                if !oauth[key].is_null() {
                    account[key] = oauth[key].as_str().ok_or_else(invalid)?.into();
                }
            }
            if let Some(time) = expiry(&oauth["expires_at"])?.or_else(|| jwt_expiry(access)) {
                account["expires_at"] = time.into();
            }
            Ok(account)
        }
    }
    fn write(path: &Path, value: &Value) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
        if bytes.len() as u64 > MAX_FILE {
            return Err(invalid());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
            .open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()
    }
    pub(super) fn prepare(accounts: &crate::accounts::Store, home: &Path) -> io::Result<Value> {
        if !home.is_absolute()
            || home.components().any(|c| {
                !matches!(
                    c,
                    std::path::Component::RootDir | std::path::Component::Normal(_)
                )
            })
        {
            return Err(invalid());
        }
        let parent = account_directory(home.parent().ok_or_else(invalid)?)?;
        let parent_meta = parent.metadata()?;
        if parent_meta.uid() != unsafe { libc::geteuid() } || parent_meta.mode() & 0o022 != 0 {
            return Err(invalid());
        }
        let name = CString::new(home.file_name().ok_or_else(invalid)?.as_bytes())
            .map_err(|_| invalid())?;
        let existing = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if existing >= 0 {
            return metadata_from(&unsafe { File::from_raw_fd(existing) });
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::NotFound {
            return Err(invalid());
        }

        let registered = accounts.registered_accounts().map_err(|_| invalid())?;
        if registered.is_empty() || registered.len() > 100 {
            return Err(invalid());
        }
        let stage = tempfile::Builder::new()
            .prefix(".cockpit-jcode-")
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir_in(pinned(&parent))?;
        let mut pools = [Vec::new(), Vec::new()];
        let mut mapping = Vec::new();
        for account in registered {
            let id = account["id"].as_str().ok_or_else(invalid)?;
            let checked = (|| -> io::Result<(usize, Value, Value)> {
                let (launch, raw) = accounts.oauth_source(id)?;
                if account["provider"] != launch.provider {
                    return Err(invalid());
                }
                let (slot, provider) = match launch.provider.as_str() {
                    "claude" => (0, "claude"),
                    "codex" => (1, "openai"),
                    _ => return Err(invalid()),
                };
                let label = label(provider, pools[slot].len());
                let name = display_text(&account["name"], 120)?;
                let email = display_text(&account["email"], 254)?;
                email_identity(&account["email"])?;
                let mut credential = convert(provider, &label, &raw)?;
                credential["email"] = email.clone().into();
                Ok((
                    slot,
                    credential,
                    json!({"id":id,"provider":provider,"label":label,"name":name,"email":email}),
                ))
            })()
            .map_err(|_| io::Error::other(AccountFailure(id.into())))?;
            pools[checked.0].push(checked.1);
            mapping.push(checked.2);
        }
        let manifest = json!({"version":1,"accounts":mapping});
        let result = public_manifest(&manifest)?;
        let active = |pool: &Vec<Value>| {
            pool.first()
                .map(|a| a["label"].clone())
                .unwrap_or(Value::Null)
        };
        write(
            &stage.path().join("auth.json"),
            &json!({"anthropic_accounts":pools[0],"active_anthropic_account":active(&pools[0])}),
        )?;
        write(
            &stage.path().join("openai-auth.json"),
            &json!({"openai_accounts":pools[1],"active_openai_account":active(&pools[1])}),
        )?;
        write(&stage.path().join(MANIFEST), &manifest)?;
        File::open(stage.path())?.sync_all()?;
        let staged_name =
            CString::new(stage.path().file_name().unwrap().as_bytes()).map_err(|_| invalid())?;
        let renamed = unsafe {
            libc::renameat2(
                parent.as_raw_fd(),
                staged_name.as_ptr(),
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if renamed != 0 {
            if io::Error::last_os_error().kind() == io::ErrorKind::AlreadyExists {
                return metadata(home);
            }
            return Err(invalid());
        }
        parent.sync_all()?;
        Ok(result)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        os::unix::{
            ffi::OsStrExt,
            fs::{symlink, PermissionsExt},
        },
        path::PathBuf,
        sync::{Arc, Barrier},
    };

    struct Fixture {
        directory: tempfile::TempDir,
        store: crate::accounts::Store,
        home: PathBuf,
        sources: Vec<PathBuf>,
    }
    fn fixture(count: usize) -> Fixture {
        let directory = tempfile::Builder::new()
            .permissions(fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let mut records = Vec::new();
        let mut sources = Vec::new();
        for index in 0..count {
            let claude = index % 3 != 2;
            let home = directory
                .path()
                .join(format!("ai-accounts/account-{index}"));
            fs::create_dir_all(&home).unwrap();
            let source = home.join(if claude {
                ".credentials.json"
            } else {
                "auth.json"
            });
            let auth = if claude {
                json!({"claudeAiOauth":{"accessToken":format!("synthetic-access-{index}"),"refreshToken":format!("synthetic-refresh-{index}"),
                    "expiresAt":1.0,"scopes":["user:inference","user:profile"],"subscriptionType":"max"},"unknown":"source-only"})
            } else {
                json!({"tokens":{"access_token":"x.eyJleHAiOjE3MDAwMDAwMDB9.x","refresh_token":format!("synthetic-refresh-{index}"),
                    "account_id":format!("synthetic-account-{index}"),"id_token":"synthetic-id-token"},"last_refresh":"2000-01-01T00:00:00Z"})
            };
            fs::write(&source, serde_json::to_vec(&auth).unwrap()).unwrap();
            records.push(json!({"id":format!("{index:016x}"),"provider":if claude {"claude"}else{"codex"},
                "name":format!("계정 {index}"),"email":format!("fixture-{index}@example.invalid"),"homePath":home}));
            sources.push(source);
        }
        fs::write(
            directory.path().join("ai-accounts.json"),
            json!({"accounts":records}).to_string(),
        )
        .unwrap();
        let store = crate::accounts::Store::new(directory.path(), directory.path());
        let home = directory.path().join("managed-jcode");
        Fixture {
            directory,
            store,
            home,
            sources,
        }
    }
    fn bytes(path: &Path) -> Vec<u8> {
        fs::read(path).unwrap()
    }
    fn json_file(path: &Path) -> Value {
        serde_json::from_slice(&bytes(path)).unwrap()
    }
    fn rewrite_home(fixture: &Fixture, home: &Path) {
        let path = fixture.directory.path().join("ai-accounts.json");
        let mut value = json_file(&path);
        value["accounts"][0]["homePath"] = home.to_string_lossy().into_owned().into();
        fs::write(path, value.to_string()).unwrap();
    }

    #[test]
    fn nine_accounts_preserve_sources_expired_refresh_and_native_schema() {
        let fixture = fixture(9);
        let original: Vec<_> = fixture.sources.iter().map(|path| bytes(path)).collect();
        let result = prepare(&fixture.store, &fixture.home).unwrap();
        assert_eq!(result["accountCount"], 9);
        assert_eq!(result["accounts"][0]["label"], "claude-otter");
        assert_eq!(result["accounts"][1]["label"], "claude-fox");
        assert_eq!(result["accounts"][2]["label"], "openai-otter");
        assert_eq!(result, metadata(&fixture.home).unwrap());
        let claude = json_file(&fixture.home.join("auth.json"));
        assert_eq!(claude["anthropic_accounts"].as_array().unwrap().len(), 6);
        assert_eq!(claude["anthropic_accounts"][0]["expires"], 1);
        assert_eq!(
            claude["anthropic_accounts"][0]["refresh"],
            "synthetic-refresh-0"
        );
        assert_eq!(claude["anthropic_accounts"][0]["subscription_type"], "max");
        assert_eq!(
            claude["anthropic_accounts"][0]["scopes"],
            json!(["user:inference", "user:profile"])
        );
        let openai = json_file(&fixture.home.join("openai-auth.json"));
        assert_eq!(
            openai["openai_accounts"][0]["expires_at"],
            1_700_000_000_000i64
        );
        assert_eq!(
            openai["openai_accounts"][0]["id_token"],
            "synthetic-id-token"
        );
        assert_eq!(
            openai["openai_accounts"][0]["account_id"],
            "synthetic-account-2"
        );
        let public = serde_json::to_string(&result).unwrap();
        assert!(!public.contains("synthetic-access"));
        assert!(!public.contains("synthetic-refresh"));
        assert!(!public.contains(fixture.directory.path().to_str().unwrap()));
        assert_eq!(
            fs::metadata(&fixture.home).unwrap().permissions().mode() & 0o777,
            0o700
        );
        for name in ["auth.json", "openai-auth.json", "cockpit-accounts.json"] {
            assert_eq!(
                fs::metadata(fixture.home.join(name))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
        assert_eq!(
            fixture
                .sources
                .iter()
                .map(|path| bytes(path))
                .collect::<Vec<_>>(),
            original
        );
    }

    #[test]
    fn existing_pool_never_reads_source_or_rewrites_rotated_tokens() {
        let fixture = fixture(3);
        let expected = prepare(&fixture.store, &fixture.home).unwrap();
        fs::remove_file(&fixture.sources[0]).unwrap();
        fs::write(fixture.directory.path().join("ai-accounts.json"), "{broken").unwrap();
        let mut originals = Vec::new();
        for (name, key, access, refresh) in [
            ("auth.json", "anthropic_accounts", "access", "refresh"),
            (
                "openai-auth.json",
                "openai_accounts",
                "access_token",
                "refresh_token",
            ),
        ] {
            let path = fixture.home.join(name);
            let mut auth = json_file(&path);
            auth[key][0][access] = json!("rotated-by-running-jcode");
            auth[key][0][refresh] = json!("rotated-refresh-by-running-jcode");
            auth[key][0]["email"] = json!(format!(
                " {} ",
                auth[key][0]["email"].as_str().unwrap().to_uppercase()
            ));
            fs::write(&path, auth.to_string()).unwrap();
            originals.push((path.clone(), bytes(&path)));
        }
        assert_eq!(prepare(&fixture.store, &fixture.home).unwrap(), expected);
        assert_eq!(metadata(&fixture.home).unwrap(), expected);
        for (path, original) in originals {
            assert_eq!(bytes(&path), original);
        }
    }

    #[test]
    fn removed_reordered_or_relabelled_accounts_cannot_reuse_registered_ids() {
        for change in ["delete", "reorder-and-relabel", "rename"] {
            let fixture = fixture(2);
            prepare(&fixture.store, &fixture.home).unwrap();
            let path = fixture.home.join("auth.json");
            let mut auth = json_file(&path);
            let accounts = auth["anthropic_accounts"].as_array_mut().unwrap();
            match change {
                "delete" => {
                    accounts.remove(0);
                    accounts[0]["label"] = json!("claude-otter");
                }
                "reorder-and-relabel" => {
                    accounts.swap(0, 1);
                    accounts[0]["label"] = json!("claude-otter");
                    accounts[1]["label"] = json!("claude-fox");
                }
                "rename" => {
                    accounts[0]["label"] = json!("claude-panda");
                }
                _ => unreachable!(),
            }
            fs::write(&path, auth.to_string()).unwrap();
            let original = bytes(&path);
            assert!(metadata(&fixture.home).is_err(), "{change}");
            assert!(prepare(&fixture.store, &fixture.home).is_err(), "{change}");
            assert_eq!(bytes(&path), original);
        }
    }

    #[test]
    fn same_label_with_a_replacement_email_is_rejected_for_both_providers() {
        for (name, key) in [
            ("auth.json", "anthropic_accounts"),
            ("openai-auth.json", "openai_accounts"),
        ] {
            let fixture = fixture(3);
            prepare(&fixture.store, &fixture.home).unwrap();
            let path = fixture.home.join(name);
            let mut auth = json_file(&path);
            auth[key][0]["email"] = json!("replacement@example.invalid");
            fs::write(&path, auth.to_string()).unwrap();
            let original = bytes(&path);
            let error = metadata(&fixture.home).unwrap_err().to_string();
            assert!(!error.contains("replacement"));
            assert!(!error.contains("synthetic"));
            assert_eq!(bytes(&path), original);
        }
    }

    #[test]
    fn missing_identity_or_unparsable_current_auth_fails_without_public_secrets() {
        let fixture = fixture(1);
        let path = fixture.directory.path().join("ai-accounts.json");
        let mut accounts = json_file(&path);
        accounts["accounts"][0]["email"] = json!("  ");
        fs::write(&path, accounts.to_string()).unwrap();
        assert!(prepare(&fixture.store, &fixture.home).is_err());
        assert!(!fixture.home.exists());
        accounts["accounts"][0]["email"] = json!("fixture-0@example.invalid");
        fs::write(path, accounts.to_string()).unwrap();
        prepare(&fixture.store, &fixture.home).unwrap();
        let path = fixture.home.join("auth.json");
        fs::write(&path, b"{synthetic-secret-current-token").unwrap();
        let error = metadata(&fixture.home).unwrap_err().to_string();
        assert!(!error.contains("synthetic-secret"));
        assert_eq!(bytes(&path), b"{synthetic-secret-current-token");
    }

    #[test]
    fn simultaneous_first_creation_publishes_one_complete_pool() {
        let fixture = Arc::new(fixture(9));
        let barrier = Arc::new(Barrier::new(6));
        let threads: Vec<_> = (0..6)
            .map(|_| {
                let fixture = fixture.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    prepare(&fixture.store, &fixture.home)
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().unwrap()["accountCount"], 9);
        }
        assert_eq!(metadata(&fixture.home).unwrap()["accountCount"], 9);
        assert!(!fs::read_dir(fixture.directory.path())
            .unwrap()
            .any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".cockpit-jcode-")));
    }

    #[test]
    fn malformed_or_missing_oauth_does_not_publish_or_expose_secrets() {
        for malformed in [
            "{synthetic-secret-marker",
            "{}",
            r#"{"claudeAiOauth":{"accessToken":123,"refreshToken":"synthetic-secret-marker"}}"#,
            r#"{"claudeAiOauth":{"accessToken":"synthetic-secret-marker","refreshToken":" "}}"#,
        ] {
            let fixture = fixture(2);
            fs::write(&fixture.sources[1], malformed).unwrap();
            let error = prepare(&fixture.store, &fixture.home)
                .unwrap_err()
                .to_string();
            assert!(error.contains("0000000000000001"));
            assert!(!error.contains("synthetic-secret-marker"));
            assert!(!error.contains(fixture.directory.path().to_str().unwrap()));
            assert!(!fixture.home.exists());
            assert_eq!(bytes(&fixture.sources[1]), malformed.as_bytes());
            assert!(!fs::read_dir(fixture.directory.path())
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".cockpit-jcode-")));
        }
    }

    #[test]
    fn source_links_traversal_fifo_and_oversize_are_rejected() {
        for kind in ["link", "ancestor", "traversal", "fifo", "oversize"] {
            let fixture = fixture(1);
            let source = &fixture.sources[0];
            match kind {
                "link" => {
                    let target = fixture.directory.path().join("source");
                    fs::rename(source, &target).unwrap();
                    symlink(target, source).unwrap();
                }
                "ancestor" => {
                    let linked = fixture.directory.path().join("ai-accounts/link");
                    symlink(source.parent().unwrap(), &linked).unwrap();
                    rewrite_home(&fixture, &linked);
                }
                "traversal" => {
                    rewrite_home(&fixture, &source.parent().unwrap().join("../account-0"));
                }
                "fifo" => {
                    fs::remove_file(source).unwrap();
                    let path = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                }
                "oversize" => {
                    fs::write(source, vec![b' '; 1024 * 1024 + 1]).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(prepare(&fixture.store, &fixture.home).is_err(), "{kind}");
            assert!(!fixture.home.exists());
        }
    }

    #[test]
    fn existing_unmanaged_target_and_symlinked_paths_are_preserved() {
        let fixture = fixture(1);
        fs::create_dir(&fixture.home).unwrap();
        let sentinel = fixture.home.join("auth.json");
        fs::write(&sentinel, b"do not replace").unwrap();
        assert!(prepare(&fixture.store, &fixture.home).is_err());
        assert_eq!(bytes(&sentinel), b"do not replace");
        let link = fixture.directory.path().join("linked-home");
        symlink(&fixture.home, &link).unwrap();
        assert!(prepare(&fixture.store, &link).is_err());
        assert!(metadata(&link).is_err());
        let ancestor = fixture.directory.path().join("linked-parent");
        symlink(fixture.directory.path(), &ancestor).unwrap();
        assert!(prepare(&fixture.store, &ancestor.join("new-home")).is_err());
        assert!(!fixture.directory.path().join("new-home").exists());
    }

    #[test]
    fn metadata_rejects_public_or_linked_files_and_strips_unknown_fields() {
        let fixture = fixture(1);
        prepare(&fixture.store, &fixture.home).unwrap();
        let manifest = fixture.home.join("cockpit-accounts.json");
        let mut value = json_file(&manifest);
        value["access"] = "secret-extra".into();
        value["accounts"][0]["refresh"] = "secret-extra".into();
        fs::write(&manifest, value.to_string()).unwrap();
        assert!(!metadata(&fixture.home)
            .unwrap()
            .to_string()
            .contains("secret-extra"));
        let auth = fixture.home.join("auth.json");
        fs::set_permissions(&auth, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(metadata(&fixture.home).is_err());
        fs::set_permissions(&auth, fs::Permissions::from_mode(0o600)).unwrap();
        let target = fixture.directory.path().join("saved-auth");
        fs::rename(&auth, &target).unwrap();
        symlink(target, &auth).unwrap();
        assert!(metadata(&fixture.home).is_err());
    }
}
