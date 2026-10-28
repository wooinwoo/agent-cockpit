//! Open operating storage and preserve files from older installation layouts.

#[cfg(target_os = "linux")]
pub use linux::open;

#[cfg(not(target_os = "linux"))]
pub fn open(
    _root: &std::path::Path,
    _data: &std::path::Path,
) -> std::io::Result<(std::fs::File, String)> {
    Err(std::io::Error::other(
        "Operating storage is only supported on Linux and WSL",
    ))
}

#[cfg(target_os = "linux")]
mod linux {
    use fs2::FileExt;
    use std::{
        ffi::CString,
        fs::{File, OpenOptions},
        io,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::{ffi::OsStrExt, fs::OpenOptionsExt},
        },
        path::{Component, Path, PathBuf},
    };

    const MIGRATED_FILES: &[&str] = &[
        ".encryption-key",
        ".cockpit-token",
        "projects.json",
        "jira-config.json",
        "ai-config.json",
        "session-state.json",
        "agent-history.json",
    ];
    const DIRECTORY_FLAGS: i32 =
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

    fn directory(path: &Path, create: bool) -> io::Result<File> {
        if !path.is_absolute()
            || path
                .components()
                .any(|part| !matches!(part, Component::RootDir | Component::Normal(_)))
        {
            return Err(io::Error::other(
                "Operating storage requires absolute paths without traversal",
            ));
        }
        let mut current = OpenOptions::new()
            .read(true)
            .custom_flags(DIRECTORY_FLAGS)
            .open("/")?;
        for part in path.components() {
            let Component::Normal(name) = part else {
                continue;
            };
            let name = CString::new(name.as_bytes())
                .map_err(|_| io::Error::other("Invalid operating storage directory"))?;
            let mut fd =
                unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS) };
            if fd < 0 {
                let error = io::Error::last_os_error();
                if !create || error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
                if unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::AlreadyExists {
                        return Err(error);
                    }
                }
                fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), DIRECTORY_FLAGS) };
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            current = unsafe { File::from_raw_fd(fd) };
        }
        Ok(current)
    }

    fn pinned(directory: &File) -> PathBuf {
        PathBuf::from(format!("/proc/self/fd/{}", directory.as_raw_fd()))
    }

    fn regular(path: &Path) -> io::Result<Option<File>> {
        let file = match OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        if !file.metadata()?.is_file() {
            return Err(io::Error::other(
                "Operating storage file must be a regular file",
            ));
        }
        Ok(Some(file))
    }

    fn copy_missing(root: &Path, data: &Path, name: &str) -> io::Result<()> {
        let destination = data.join(name);
        if regular(&destination)?.is_some() {
            return Ok(());
        }
        let Some(mut source) = regular(&root.join(name))? else {
            return Ok(());
        };
        let mut temporary = tempfile::NamedTempFile::new_in(data)?;
        io::copy(&mut source, &mut temporary)?;
        temporary.as_file().sync_all()?;
        temporary
            .persist_noclobber(destination)
            .map_err(|error| error.error)?;
        Ok(())
    }

    pub fn open(root: &Path, data: &Path) -> io::Result<(File, String)> {
        let root = directory(root, false)?;
        let data = directory(data, true)?;
        let root_path = pinned(&root);
        let data_path = pinned(&data);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(data_path.join(".cockpit-native.lock"))?;
        if !lock.metadata()?.is_file() {
            return Err(io::Error::other("Invalid native server lock"));
        }
        lock.try_lock_exclusive()
            .map_err(|_| io::Error::other("Data directory is already in use by a native server"))?;
        for name in MIGRATED_FILES {
            copy_missing(&root_path, &data_path, name)?;
        }
        let token = crate::saved_token(&data_path)?;
        data.sync_all()?;
        Ok((lock, token))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{
            fs,
            os::unix::fs::{symlink, PermissionsExt},
        };

        const TOKEN: &str = "0123456789abcdef0123456789abcdef";

        // A parallel test that forks briefly shares this lock's open file
        // description until its child execs, so closing our descriptor alone
        // may leave the lock held. LOCK_UN releases it for every duplicate.
        fn release(lock: File) {
            lock.unlock().unwrap();
        }

        fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf) {
            let fixture = tempfile::tempdir().unwrap();
            let root = fixture.path().join("source");
            let data = fixture.path().join("home/.local/share/cockpit");
            fs::create_dir(&root).unwrap();
            (fixture, root, data)
        }

        fn mode(path: &Path) -> u32 {
            fs::metadata(path).unwrap().permissions().mode() & 0o777
        }

        #[test]
        fn fresh_storage_creates_private_directories_and_token() {
            let (fixture, root, data) = fixture();
            let (_lock, token) = open(&root, &data).unwrap();
            assert_eq!(token.len(), 32);
            for relative in [
                "home",
                "home/.local",
                "home/.local/share",
                "home/.local/share/cockpit",
            ] {
                assert_eq!(mode(&fixture.path().join(relative)), 0o700);
            }
            assert_eq!(mode(&data.join(".cockpit-token")), 0o600);
            assert_eq!(mode(&data.join(".cockpit-native.lock")), 0o600);
            assert_eq!(
                fs::read_to_string(data.join(".cockpit-token")).unwrap(),
                token
            );
            assert!(!data.join(".cockpit-rust-preview").exists());
            assert!(!data.join(".encryption-key").exists());
            assert_eq!(fs::read_dir(root).unwrap().count(), 0);
        }

        #[test]
        fn migration_preserves_bytes_originals_destination_precedence_and_retry() {
            let (_fixture, root, data) = fixture();
            fs::create_dir_all(&data).unwrap();
            for name in MIGRATED_FILES {
                let bytes = if *name == ".cockpit-token" {
                    TOKEN.as_bytes().to_vec()
                } else {
                    [name.as_bytes(), b"\0\xff\n\\ud800"].concat()
                };
                fs::write(root.join(name), bytes).unwrap();
            }
            let existing = b"existing destination stays byte-for-byte";
            fs::write(data.join("projects.json"), existing).unwrap();
            let (lock, token) = open(&root, &data).unwrap();
            assert_eq!(token, TOKEN);
            for name in MIGRATED_FILES {
                let original = if *name == ".cockpit-token" {
                    TOKEN.as_bytes().to_vec()
                } else {
                    [name.as_bytes(), b"\0\xff\n\\ud800"].concat()
                };
                assert_eq!(fs::read(root.join(name)).unwrap(), original);
                let expected = if *name == "projects.json" {
                    existing.to_vec()
                } else {
                    original
                };
                assert_eq!(fs::read(data.join(name)).unwrap(), expected);
                if *name != "projects.json" {
                    assert_eq!(mode(&data.join(name)), 0o600);
                }
            }
            release(lock);
            fs::write(
                root.join("ai-config.json"),
                b"new source must not replace destination",
            )
            .unwrap();
            let (lock, again) = open(&root, &data).unwrap();
            assert_eq!(again, TOKEN);
            assert_eq!(
                fs::read(data.join("ai-config.json")).unwrap(),
                b"ai-config.json\0\xff\n\\ud800"
            );
            assert_eq!(fs::read(data.join("projects.json")).unwrap(), existing);
            assert_eq!(
                fs::read_dir(&data).unwrap().count(),
                MIGRATED_FILES.len() + 1
            );
            drop(lock);
        }

        #[test]
        fn lock_prevents_migration_until_previous_owner_releases_it() {
            let (_fixture, root, data) = fixture();
            let (lock, token) = open(&root, &data).unwrap();
            fs::write(root.join("projects.json"), b"original project bytes").unwrap();
            assert!(open(&root, &data).is_err());
            assert!(!data.join("projects.json").exists());
            release(lock);
            let (_lock, again) = open(&root, &data).unwrap();
            assert_eq!(again, token);
            assert_eq!(
                fs::read(data.join("projects.json")).unwrap(),
                b"original project bytes"
            );
        }

        #[test]
        fn source_and_destination_symlinks_and_nonregular_files_are_rejected() {
            for target in ["source", "destination"] {
                for kind in ["symlink", "directory", "fifo"] {
                    let (fixture, root, data) = fixture();
                    fs::create_dir_all(&data).unwrap();
                    let outside = fixture.path().join("untouched");
                    fs::write(&outside, b"unchanged").unwrap();
                    let bad = if target == "source" {
                        root.join("projects.json")
                    } else {
                        data.join("projects.json")
                    };
                    match kind {
                        "symlink" => symlink(&outside, &bad).unwrap(),
                        "directory" => fs::create_dir(&bad).unwrap(),
                        _ => {
                            let path = CString::new(bad.as_os_str().as_bytes()).unwrap();
                            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
                        }
                    }
                    assert!(open(&root, &data).is_err(), "{target} {kind}");
                    assert_eq!(fs::read(outside).unwrap(), b"unchanged");
                    assert!(!data.join(".cockpit-token").exists());
                    if target == "source" {
                        assert!(!data.join("projects.json").exists());
                    }
                }
            }
        }

        #[test]
        fn source_and_data_parent_symlinks_and_traversal_are_rejected() {
            let (fixture, root, data) = fixture();
            let alias = fixture.path().join("source-alias");
            symlink(&root, &alias).unwrap();
            assert!(open(&alias, &data).is_err());
            assert!(!data.exists());
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            symlink(&outside, fixture.path().join("home")).unwrap();
            assert!(open(&root, &data).is_err());
            assert_eq!(fs::read_dir(&outside).unwrap().count(), 0);
            assert!(open(&root, &fixture.path().join("new/../target")).is_err());
            assert!(!fixture.path().join("new").exists());
            assert!(open(Path::new("relative"), &data).is_err());
            assert!(open(
                &fixture.path().join("absent-root"),
                &fixture.path().join("absent-data")
            )
            .is_err());
            assert!(!fixture.path().join("absent-root").exists());
            assert!(!fixture.path().join("absent-data").exists());
        }

        #[test]
        fn invalid_lock_and_token_are_preserved() {
            for name in [".cockpit-native.lock", ".cockpit-token"] {
                let (fixture, root, data) = fixture();
                fs::create_dir_all(&data).unwrap();
                let outside = fixture.path().join("untouched");
                fs::write(&outside, TOKEN).unwrap();
                symlink(&outside, data.join(name)).unwrap();
                assert!(open(&root, &data).is_err());
                assert_eq!(fs::read_to_string(outside).unwrap(), TOKEN);
            }
            let (_fixture, root, data) = fixture();
            fs::create_dir_all(&data).unwrap();
            fs::write(data.join(".cockpit-token"), b"broken").unwrap();
            assert!(open(&root, &data).is_err());
            assert_eq!(fs::read(data.join(".cockpit-token")).unwrap(), b"broken");
        }

        #[test]
        fn pinned_directories_survive_path_replacement_without_redirecting_copy() {
            let (fixture, root, data) = fixture();
            fs::write(root.join("projects.json"), b"pinned source").unwrap();
            let source_handle = directory(&root, false).unwrap();
            let data_handle = directory(&data, true).unwrap();
            let moved_root = fixture.path().join("old-source");
            let moved_data = fixture.path().join("old-data");
            let outside = fixture.path().join("outside");
            fs::create_dir(&outside).unwrap();
            fs::write(outside.join("projects.json"), b"unrelated").unwrap();
            fs::rename(&root, &moved_root).unwrap();
            fs::rename(&data, &moved_data).unwrap();
            symlink(&outside, &root).unwrap();
            symlink(&outside, &data).unwrap();
            copy_missing(
                &pinned(&source_handle),
                &pinned(&data_handle),
                "projects.json",
            )
            .unwrap();
            assert_eq!(
                fs::read(moved_data.join("projects.json")).unwrap(),
                b"pinned source"
            );
            assert_eq!(
                fs::read(outside.join("projects.json")).unwrap(),
                b"unrelated"
            );
            assert_eq!(
                fs::read(moved_root.join("projects.json")).unwrap(),
                b"pinned source"
            );
        }
    }
}
