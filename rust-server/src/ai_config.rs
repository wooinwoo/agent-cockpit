use crate::board_value::{object, V};
use axum::{
    http::Method,
    response::{IntoResponse, Response},
    Json,
};
use ring::{
    aead,
    rand::{SecureRandom, SystemRandom},
};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/ai/config"),
    ("POST", "/api/ai/config"),
    ("POST", "/api/ai/test"),
];
pub fn route(method: &Method, path: &str) -> bool {
    ROUTES
        .iter()
        .any(|(verb, target)| method.as_str() == *verb && path == *target)
}
pub struct Store {
    directory: PathBuf,
    writes: Mutex<()>,
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        "Invalid AI configuration storage",
    )
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> io::Result<Vec<u8>> {
    if text.len() % 2 != 0 || !text.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(invalid());
    }
    text.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).map_err(|_| invalid()))
        .collect()
}
fn cipher(key: &[u8]) -> io::Result<aead::LessSafeKey> {
    aead::UnboundKey::new(&aead::AES_256_GCM, key)
        .map(aead::LessSafeKey::new)
        .map_err(|_| invalid())
}
fn encrypt(key: &[u8], text: &str) -> io::Result<String> {
    let mut iv = [0; 12];
    SystemRandom::new().fill(&mut iv).map_err(|_| invalid())?;
    let mut data = text.as_bytes().to_vec();
    let tag = cipher(key)?
        .seal_in_place_separate_tag(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::empty(),
            &mut data,
        )
        .map_err(|_| invalid())?;
    Ok(format!(
        "enc:{}:{}:{}",
        hex(&iv),
        hex(tag.as_ref()),
        hex(&data)
    ))
}
fn decrypt(key: &[u8], text: &str) -> io::Result<String> {
    let parts: Vec<_> = text.split(':').collect();
    if parts.len() != 4 || parts[0] != "enc" {
        return Err(invalid());
    }
    let iv: [u8; 12] = unhex(parts[1])?.try_into().map_err(|_| invalid())?;
    let tag = unhex(parts[2])?;
    if tag.len() != 16 {
        return Err(invalid());
    }
    let mut data = unhex(parts[3])?;
    data.extend(tag);
    let plain = cipher(key)?
        .open_in_place(
            aead::Nonce::assume_unique_for_key(iv),
            aead::Aad::empty(),
            &mut data,
        )
        .map_err(|_| invalid())?;
    String::from_utf8(plain.to_vec()).map_err(|_| invalid())
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            directory,
            writes: Mutex::new(()),
        }
    }
    fn checked(&self, path: &Path) -> io::Result<()> {
        if !crate::account_hub::safe_path(&self.directory, path) {
            return Err(invalid());
        }
        match fs::symlink_metadata(path) {
            Ok(meta) if !meta.is_file() => Err(invalid()),
            Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        }
    }
    fn bytes(&self, path: &Path) -> io::Result<Option<Vec<u8>>> {
        self.checked(path)?;
        match fs::read(path) {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    fn encryption_key(&self) -> io::Result<Option<Vec<u8>>> {
        self.bytes(&self.directory.join(".encryption-key"))?
            .map(|bytes| {
                let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
                let key = unhex(text.trim())?;
                if key.len() != 32 {
                    return Err(invalid());
                }
                Ok(key)
            })
            .transpose()
    }
    fn config(&self) -> io::Result<Option<V>> {
        self.bytes(&self.directory.join("ai-config.json"))?
            .map(|bytes| {
                let raw = serde_json::value::RawValue::from_string(
                    String::from_utf8(bytes).map_err(|_| invalid())?,
                )
                .map_err(|_| invalid())?;
                let value = V::parse(&raw).map_err(|_| invalid())?;
                if !matches!(value, V::Object(_))
                    || (value.has("geminiApiKey") && !value["geminiApiKey"].is_string())
                {
                    return Err(invalid());
                }
                Ok(value)
            })
            .transpose()
    }
    fn decoded(&self, config: &V) -> io::Result<V> {
        let value = &config["geminiApiKey"];
        if !value.is_string() {
            return Ok("".into());
        }
        let text = value.text();
        if !text.starts_with("enc:") {
            return Ok(value.clone());
        }
        let key = self.encryption_key()?.ok_or_else(invalid)?;
        decrypt(&key, &text).map(V::from)
    }
    // Reads are deliberately uncached: agent loops observe replacement keys immediately.
    pub fn key(&self) -> io::Result<Option<String>> {
        let _guard = self.writes.lock().unwrap();
        self.config()?
            .map(|config| self.decoded(&config).map(|key| key.text()))
            .transpose()
            .map(|key| key.filter(|key| !key.is_empty()))
    }
    pub fn jira(&self) -> io::Result<V> {
        let _guard = self.writes.lock().unwrap();
        let Some(bytes) = self.bytes(&self.directory.join("jira-config.json"))? else {
            return Ok(V::Null);
        };
        let raw = serde_json::value::RawValue::from_string(
            String::from_utf8(bytes).map_err(|_| invalid())?,
        )
        .map_err(|_| invalid())?;
        let mut config = V::parse(&raw).map_err(|_| invalid())?;
        if !matches!(config, V::Object(_)) {
            return Err(invalid());
        }
        // Old installations use token, while config persistence encrypts apiToken.
        // Keep the service's existing token precedence and support both encodings.
        let value = if config["token"].truthy() {
            config["token"].clone()
        } else {
            config["apiToken"].clone()
        };
        if value.is_string() {
            let text = value.text();
            config["token"] = if text.starts_with("enc:") {
                decrypt(&self.encryption_key()?.ok_or_else(invalid)?, &text).map(V::from)?
            } else {
                value
            };
        }
        Ok(config)
    }
    fn atomic(&self, path: &Path, bytes: &[u8], new: bool) -> io::Result<()> {
        self.checked(path)?;
        let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or_else(invalid)?)?;
        file.write_all(bytes)?;
        file.as_file().sync_all()?;
        if new {
            file.persist_noclobber(path).map_err(|e| e.error)?;
        } else {
            file.persist(path).map_err(|e| e.error)?;
        }
        Ok(())
    }
    fn save(&self, supplied: &str) -> io::Result<()> {
        let _guard = self.writes.lock().unwrap();
        let old = self.config()?;
        // Do not overwrite malformed or undecryptable credentials, or rotate a broken key.
        if let Some(config) = &old {
            self.decoded(config)?;
        }
        let current_key = self.encryption_key()?;
        let backup_dir = self.directory.join("backups");
        if !crate::account_hub::safe_path(&self.directory, &backup_dir) {
            return Err(invalid());
        }
        fs::create_dir_all(&self.directory)?;
        if old.is_some() {
            fs::create_dir_all(&backup_dir)?;
        }
        let key = match current_key {
            Some(key) => key,
            None => {
                // An encrypted input without its existing key cannot be repaired by rotation.
                if supplied.starts_with("enc:") {
                    return Err(invalid());
                }
                let mut key = vec![0; 32];
                SystemRandom::new().fill(&mut key).map_err(|_| invalid())?;
                self.atomic(
                    &self.directory.join(".encryption-key"),
                    hex(&key).as_bytes(),
                    true,
                )?;
                key
            }
        };
        let encrypted = if supplied.starts_with("enc:") {
            decrypt(&key, supplied)?;
            supplied.to_owned()
        } else {
            encrypt(&key, supplied)?
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                self.directory.join(".encryption-key"),
                fs::Permissions::from_mode(0o600),
            )?;
        }
        if let Some(mut old) = old {
            // Legacy plaintext is encrypted in backups as well as the replacement file.
            if old["geminiApiKey"].truthy() && !old["geminiApiKey"].text().starts_with("enc:") {
                old["geminiApiKey"] = encrypt(&key, &old["geminiApiKey"].text())?.into();
            }
            let mut stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| invalid())?
                .as_millis();
            for entry in fs::read_dir(&backup_dir)? {
                let name = entry?.file_name().to_string_lossy().into_owned();
                if let Some(n) = name
                    .strip_prefix("ai-config.json.")
                    .and_then(|n| n.strip_suffix(".bak"))
                    .and_then(|n| n.parse::<u128>().ok())
                {
                    stamp = stamp.max(n.checked_add(1).ok_or_else(invalid)?);
                }
            }
            self.atomic(
                &backup_dir.join(format!("ai-config.json.{stamp}.bak")),
                old.raw().get().as_bytes(),
                true,
            )?;
        }
        self.atomic(
            &self.directory.join("ai-config.json"),
            object([("geminiApiKey", encrypted.into())])
                .raw()
                .get()
                .as_bytes(),
            false,
        )?;
        // The replacement is committed. Retention is best-effort maintenance;
        // failures here must not report an already saved key as unsaved.
        if let Ok(entries) = fs::read_dir(&backup_dir) {
            let mut backups: Vec<_> = entries
                .filter_map(Result::ok)
                .filter(|entry| {
                    let name = entry.file_name().to_string_lossy().into_owned();
                    name.starts_with("ai-config.json.")
                        && name.ends_with(".bak")
                        && entry.file_type().is_ok_and(|kind| kind.is_file())
                })
                .map(|entry| entry.path())
                .collect();
            backups.sort();
            for path in backups.iter().take(backups.len().saturating_sub(10)) {
                if self.checked(path).is_ok() {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
    pub async fn handle(&self, method: &Method, path: &str, input: &V) -> Response {
        if *method == Method::GET && path == "/api/ai/config" {
            let result = (|| -> io::Result<V> {
                let _guard = self.writes.lock().unwrap();
                let Some(config) = self.config()? else {
                    return Ok(object([("configured", false.into())]));
                };
                let key = self.decoded(&config)?;
                let masked = if key.truthy() {
                    V::String(
                        "****"
                            .encode_utf16()
                            .chain(
                                key.units()[key.units().len().saturating_sub(4)..]
                                    .iter()
                                    .copied(),
                            )
                            .collect(),
                    )
                } else {
                    "".into()
                };
                Ok(object([
                    ("configured", key.truthy().into()),
                    ("geminiApiKey", masked),
                ]))
            })();
            return match result {
                Ok(value) => Json(value.raw()).into_response(),
                Err(_) => crate::error(500, "AI configuration storage operation failed"),
            };
        }
        if *method != Method::POST || !matches!(path, "/api/ai/config" | "/api/ai/test") {
            return crate::error(404, "Not found");
        }
        if !input["geminiApiKey"].is_string() || !input["geminiApiKey"].truthy() {
            return crate::error(400, "geminiApiKey required");
        }
        let key = input["geminiApiKey"].text();
        if path == "/api/ai/config" {
            return match self.save(&key) {
                Ok(()) => Json(object([("success", true.into())]).raw()).into_response(),
                Err(_) => crate::error(500, "AI configuration storage operation failed"),
            };
        }
        let mut url = match endpoint() {
            Ok(url) => url,
            Err(_) => return crate::error(400, "Invalid private Gemini endpoint"),
        };
        url.query_pairs_mut().append_pair("key", &key);
        let encoded_key = url
            .query()
            .unwrap_or_default()
            .strip_prefix("key=")
            .unwrap_or_default()
            .to_owned();
        let client = match reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()
        {
            Ok(client) => client,
            Err(_) => return crate::error(400, "API request failed"),
        };
        let response = client.post(url).json(&serde_json::json!({"contents":[{"parts":[{"text":"Say \"OK\" in one word."}]}], "generationConfig":{"maxOutputTokens":10}})).send().await;
        match response {
            Ok(response) if response.status().is_success() => {
                Json(object([("success", true.into())]).raw()).into_response()
            }
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response
                    .text()
                    .await
                    .unwrap_or_default()
                    .replace(&key, "[redacted]")
                    .replace(&encoded_key, "[redacted]");
                let mut error: Vec<_> = format!("API {status}: ").encode_utf16().collect();
                error.extend(V::from(body).cut(200).units());
                (
                    axum::http::StatusCode::BAD_REQUEST,
                    Json(object([("error", V::String(error))]).raw()),
                )
                    .into_response()
            }
            Err(error) => crate::error(
                400,
                if error.is_timeout() {
                    "API request timed out"
                } else {
                    "API request failed"
                },
            ),
        }
    }
}
fn endpoint() -> io::Result<reqwest::Url> {
    let base = match std::env::var("COCKPIT_PREVIEW_GEMINI_BASE") {
        Ok(base) => {
            let url = reqwest::Url::parse(&base).map_err(|_| invalid())?;
            if url.scheme() != "http"
                || !url
                    .host_str()
                    .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok())
                    .is_some_and(|ip| ip.is_loopback())
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
            {
                return Err(invalid());
            }
            url
        }
        Err(std::env::VarError::NotPresent) => {
            reqwest::Url::parse("https://generativelanguage.googleapis.com").unwrap()
        }
        Err(_) => return Err(invalid()),
    };
    base.join("/v1beta/models/gemini-2.5-flash:generateContent")
        .map_err(|_| invalid())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn encryption_hot_reload_and_corruption_preserve_storage() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        assert_eq!(store.key().unwrap(), None);
        store.save("fixture-key").unwrap();
        assert_eq!(store.key().unwrap().as_deref(), Some("fixture-key"));
        let key_path = directory.path().join(".encryption-key");
        let original = fs::read(&key_path).unwrap();
        for _ in 0..12 {
            store.save("replacement").unwrap();
        }
        assert_eq!(fs::read(&key_path).unwrap(), original);
        assert_eq!(
            fs::read_dir(directory.path().join("backups"))
                .unwrap()
                .count(),
            10
        );
        fs::write(
            directory.path().join("ai-config.json"),
            r#"{"geminiApiKey":"external"}"#,
        )
        .unwrap();
        assert_eq!(store.key().unwrap().as_deref(), Some("external"));
        fs::write(&key_path, "broken").unwrap();
        assert!(store.save("cannot-save").is_err());
        assert_eq!(fs::read_to_string(&key_path).unwrap(), "broken");
        assert_eq!(store.key().unwrap().as_deref(), Some("external"));
    }
    #[test]
    fn authenticated_ciphertext_rejects_wrong_key_and_truncation() {
        let encrypted = encrypt(&[1; 32], "private 😀").unwrap();
        assert_eq!(decrypt(&[1; 32], &encrypted).unwrap(), "private 😀");
        assert!(decrypt(&[2; 32], &encrypted).is_err());
        assert!(decrypt(&[1; 32], "enc:00:00:00").is_err());
    }

    fn jira_fixture(token_field: &str, token: V) -> V {
        object([
            ("url", "https://jira-fixture.invalid".into()),
            ("email", "fixture@example.invalid".into()),
            (token_field, token),
            (
                "future",
                object([("keep", V::String(vec![0xd800, 0x41, 0xdc00]))]),
            ),
        ])
    }

    #[test]
    fn jira_reads_encrypted_api_token_and_plaintext_without_mutating_storage() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        assert_eq!(store.jira().unwrap(), V::Null);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 0);
        let config_path = directory.path().join("jira-config.json");
        let key_path = directory.path().join(".encryption-key");

        let plain = jira_fixture("apiToken", "fixture-plain-token".into());
        fs::write(&config_path, plain.raw().get()).unwrap();
        let before = fs::read(&config_path).unwrap();
        let decoded = store.jira().unwrap();
        assert_eq!(decoded["token"], V::from("fixture-plain-token"));
        assert_eq!(decoded["future"], plain["future"]);
        assert_eq!(fs::read(&config_path).unwrap(), before);
        assert!(!key_path.exists());

        let key = [0x35; 32];
        let encrypted = encrypt(&key, "fixture-encrypted-token 😀").unwrap();
        let config = jira_fixture("apiToken", encrypted.clone().into());
        fs::write(&key_path, format!("{}\n", hex(&key))).unwrap();
        fs::write(&config_path, config.raw().get()).unwrap();
        let config_before = fs::read(&config_path).unwrap();
        let key_before = fs::read(&key_path).unwrap();
        let decoded = store.jira().unwrap();
        assert_eq!(decoded["token"], V::from("fixture-encrypted-token 😀"));
        assert_eq!(decoded["apiToken"], V::from(encrypted));
        assert_eq!(decoded["url"], config["url"]);
        assert_eq!(decoded["email"], config["email"]);
        assert_eq!(decoded["future"], config["future"]);
        assert_eq!(fs::read(&config_path).unwrap(), config_before);
        assert_eq!(fs::read(&key_path).unwrap(), key_before);
        assert_eq!(fs::read_dir(directory.path()).unwrap().count(), 2);
    }

    #[test]
    fn jira_legacy_token_precedes_api_token_for_plaintext_and_encrypted_values() {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(directory.path().into());
        let config_path = directory.path().join("jira-config.json");
        let key_path = directory.path().join(".encryption-key");
        let key = [0x36; 32];
        let mut config = jira_fixture(
            "apiToken",
            encrypt(&key, "fixture-new-token").unwrap().into(),
        );
        config["token"] = "fixture-legacy-token".into();
        fs::write(&config_path, config.raw().get()).unwrap();
        // A plain legacy token wins even if an unused apiToken cannot decrypt.
        fs::write(&key_path, "fixture-broken-key").unwrap();
        assert_eq!(
            store.jira().unwrap()["token"],
            V::from("fixture-legacy-token")
        );
        assert_eq!(fs::read_to_string(&key_path).unwrap(), "fixture-broken-key");

        fs::write(&key_path, hex(&key)).unwrap();
        config["token"] = encrypt(&key, "fixture-encrypted-legacy").unwrap().into();
        fs::write(&config_path, config.raw().get()).unwrap();
        let before = fs::read(&config_path).unwrap();
        assert_eq!(
            store.jira().unwrap()["token"],
            V::from("fixture-encrypted-legacy")
        );
        assert_eq!(fs::read(&config_path).unwrap(), before);

        config["token"] = "".into();
        fs::write(&config_path, config.raw().get()).unwrap();
        assert_eq!(store.jira().unwrap()["token"], V::from("fixture-new-token"));
    }

    #[test]
    fn jira_missing_broken_and_wrong_keys_fail_without_repairing_saved_data() {
        let key = [0x37; 32];
        let encrypted = encrypt(&key, "fixture-authenticated-token").unwrap();
        for key_bytes in [
            None,
            Some(b"bad hexadecimal".to_vec()),
            Some(b"00".to_vec()),
            Some(hex(&[0x38; 32]).into_bytes()),
        ] {
            for token_field in ["apiToken", "token"] {
                let directory = tempfile::tempdir().unwrap();
                let config_path = directory.path().join("jira-config.json");
                let key_path = directory.path().join(".encryption-key");
                let config = jira_fixture(token_field, encrypted.clone().into());
                fs::write(&config_path, config.raw().get()).unwrap();
                if let Some(bytes) = &key_bytes {
                    fs::write(&key_path, bytes).unwrap();
                }
                let config_before = fs::read(&config_path).unwrap();
                let store = Store::new(directory.path().into());
                assert!(store.jira().is_err());
                assert_eq!(fs::read(&config_path).unwrap(), config_before);
                match &key_bytes {
                    Some(bytes) => assert_eq!(fs::read(&key_path).unwrap(), *bytes),
                    None => assert!(!key_path.exists()),
                }
                assert_eq!(
                    fs::read_dir(directory.path()).unwrap().count(),
                    if key_bytes.is_some() { 2 } else { 1 }
                );
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn jira_config_and_encryption_key_symlinks_are_rejected_without_changes() {
        use std::os::unix::fs::symlink;
        let key = [0x39; 32];
        let config = jira_fixture(
            "apiToken",
            encrypt(&key, "fixture-symlink-token").unwrap().into(),
        );
        for link_config in [true, false] {
            for inside in [true, false] {
                let directory = tempfile::tempdir().unwrap();
                let external = tempfile::tempdir().unwrap();
                let target_directory = if inside {
                    directory.path()
                } else {
                    external.path()
                };
                let target = target_directory.join("fixture-link-target");
                let config_path = directory.path().join("jira-config.json");
                let key_path = directory.path().join(".encryption-key");
                let (link, bytes) = if link_config {
                    fs::write(&key_path, hex(&key)).unwrap();
                    (config_path.clone(), config.raw().get().as_bytes().to_vec())
                } else {
                    fs::write(&config_path, config.raw().get()).unwrap();
                    (key_path.clone(), hex(&key).into_bytes())
                };
                fs::write(&target, &bytes).unwrap();
                symlink(&target, &link).unwrap();
                let store = Store::new(directory.path().into());
                assert!(store.jira().is_err());
                assert_eq!(fs::read_link(&link).unwrap(), target);
                assert_eq!(fs::read(&target).unwrap(), bytes);
                assert!(fs::symlink_metadata(&link)
                    .unwrap()
                    .file_type()
                    .is_symlink());
                if link_config {
                    assert_eq!(fs::read_to_string(&key_path).unwrap(), hex(&key));
                } else {
                    assert_eq!(
                        fs::read_to_string(&config_path).unwrap(),
                        config.raw().get()
                    );
                }
            }
        }
    }
}
