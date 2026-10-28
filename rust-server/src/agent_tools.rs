//! Native core tools. Agent orchestration supplies project roots and owns each
//! cancellation token. This module does not expose an unauthenticated endpoint.
use crate::{
    ai_transport::Cancel,
    board_value::{object, V},
    process_owned,
};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock},
    time::Duration,
};
use tokio::process::Command;

const READ_LIMIT: usize = 10000;
const EDIT_LIMIT: usize = 100000;
const FILE_LIMIT: u64 = 16 * 1024 * 1024;
const COMMAND_LIMIT: usize = 1024 * 1024;
const FILTER_ERROR: &str = "Error: 이 명령어는 안전 필터에 차단됐어영. 읽기 전용 명령만 가능해여 (ls, dir, cat, type, git log, git status, git diff 등).";
const LINK_ERROR: &str = "Error: 심링크가 프로젝트 밖을 가리키고 있어영.";

fn policy() -> &'static serde_json::Value {
    static VALUE: OnceLock<serde_json::Value> = OnceLock::new();
    VALUE.get_or_init(|| serde_json::from_str(include_str!("agent_tool_policy.json")).unwrap())
}
fn matches(pattern: &str, flags: &str, text: &str) -> bool {
    regress::Regex::with_flags(pattern, flags).is_ok_and(|re| re.find(text).is_some())
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Risk {
    pub label: String,
    pub hard: bool,
}
pub fn classify_risk(kind: &str, arg: &str) -> Option<Risk> {
    if kind == "COCKPIT" {
        let sub = arg.split(':').next().unwrap_or("");
        return policy()["cockpitRisks"]
            .as_array()?
            .iter()
            .find(|row| row[0] == sub)
            .map(|row| Risk {
                label: row[1]["label"].as_str().unwrap().into(),
                hard: row[1]["hard"].as_bool().unwrap(),
            });
    }
    if kind != "BASH" {
        return None;
    }
    policy()["bashRisks"]
        .as_array()?
        .iter()
        .find(|row| matches(row[0].as_str().unwrap(), row[1].as_str().unwrap(), arg))
        .map(|row| Risk {
            label: row[2].as_str().unwrap().into(),
            hard: row[3].as_bool().unwrap(),
        })
}
pub fn is_safe_command(cmd: &str, sprint: bool) -> bool {
    let lower = cmd.to_lowercase();
    let lower = lower.trim();
    // The old || exception bypassed all chaining checks. Keep each invocation
    // single-command, including sprint commands, rather than executing its tail.
    if lower
        .chars()
        .any(|c| matches!(c, '\n' | '\r' | '\0' | '&' | '|' | ';'))
    {
        return false;
    }
    let list = if sprint { "sprintBlocked" } else { "blocked" };
    if !sprint {
        let word = lower
            .split_whitespace()
            .next()
            .unwrap_or("")
            .strip_suffix(".exe")
            .unwrap_or_else(|| lower.split_whitespace().next().unwrap_or(""));
        if !policy()["allowed"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == word)
        {
            return false;
        }
        if matches(
            r"\s+/(?:etc|home|root|usr|var|tmp|opt|mnt|proc|sys|dev|boot)\b",
            "",
            lower,
        ) || matches(r"\s+[a-z]:\\", "i", lower)
            || matches(r"[`]|\$\(|\$\{|%[a-z]", "i", lower)
        {
            return false;
        }
    }
    if policy()[list]
        .as_array()
        .unwrap()
        .iter()
        .any(|row| matches(row[0].as_str().unwrap(), row[1].as_str().unwrap(), lower))
    {
        return false;
    }
    let Some(words) = command_words(cmd) else {
        return sprint && cmd.trim().is_empty();
    };
    sprint || readonly_invocation(&words)
}

// Parse quoting only. Shell substitutions, redirects, pipelines, environment
// expansion and command lookup through a shell are never evaluated.
fn command_words(command: &str) -> Option<Vec<String>> {
    let mut words = vec![];
    let mut word = String::new();
    let mut started = false;
    let mut quote = None;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if quote == Some('\'') {
            if c == '\'' {
                quote = None;
            } else {
                word.push(c);
            }
        } else if c == '\\' {
            word.push(chars.next()?);
            started = true;
        } else if quote == Some('"') {
            if c == '"' {
                quote = None;
            } else {
                word.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            started = true;
        } else if c.is_whitespace() {
            if started {
                words.push(std::mem::take(&mut word));
                started = false;
            }
        } else {
            word.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return None;
    }
    if started {
        words.push(word);
    }
    (!words.is_empty()).then_some(words)
}
fn readonly_invocation(words: &[String]) -> bool {
    let program = words[0].to_ascii_lowercase();
    if program.ends_with(".exe") {
        return false;
    }
    let program = program.as_str();
    let args = &words[1..];
    // Global Git options can switch the project, install an executable alias,
    // or enable hooks. Only these built-in read operations are available.
    if program == "git" {
        return args.first().is_some_and(|sub| {
            [
                "status",
                "log",
                "diff",
                "show",
                "ls-files",
                "ls-tree",
                "rev-parse",
                "rev-list",
                "shortlog",
                "describe",
                "blame",
                "grep",
            ]
            .contains(&sub.as_str())
        }) && read_options(&args[1..], "short branch porcelain untracked-files ignored ignore-submodules column no-column ahead-behind no-ahead-behind show-stash oneline graph decorate no-decorate all branches tags remotes max-count skip since until after before author committer grep grep-reflog all-match invert-grep format pretty date reverse first-parent no-merges merges stat numstat shortstat name-only name-status raw patch no-patch patch-with-stat cached staged check relative no-relative color no-color abbrev no-abbrev full-index binary ignore-space-at-eol ignore-all-space ignore-space-change ignore-blank-lines word-diff word-diff-regex diff-algorithm unified no-renames find-renames find-copies patience histogram minimal exit-code quiet no-index exclude-standard others deleted modified stage directory error-unmatch full-tree long object-only is-inside-work-tree show-toplevel git-dir show-prefix verify symbolic-full-name abbrev-ref count left-right cherry-pick cherry-mark line-number files-with-matches files-without-match fixed-strings ignore-case extended-regexp basic-regexp perl-regexp word-regexp invert-match text max-depth break heading null", "ab cdefhil mno pqrstuvwxzABCDEFGILMNPRSUWX", "");
    }
    match program {
        "find" => args.iter().all(|arg| {
            !arg.starts_with('-')
                || [
                    "-name",
                    "-iname",
                    "-path",
                    "-ipath",
                    "-type",
                    "-maxdepth",
                    "-mindepth",
                    "-size",
                    "-mtime",
                    "-mmin",
                    "-atime",
                    "-amin",
                    "-ctime",
                    "-cmin",
                    "-newer",
                    "-newermt",
                    "-print",
                    "-print0",
                    "-empty",
                    "-readable",
                    "-writable",
                    "-executable",
                    "-prune",
                    "-o",
                    "-a",
                    "-not",
                ]
                .contains(&arg.as_str())
        }),
        "sed" => {
            args.len() >= 2
                && args.len() <= 3
                && args[0] == "-n"
                && matches(r"^(?:[0-9]+(?:,[0-9]+)?)?p$", "", &args[1])
                && args.get(2).is_none_or(|arg| !arg.starts_with('-'))
        }
        "sort" => read_options(args, "ignore-leading-blanks dictionary-order ignore-case general-numeric-sort human-numeric-sort ignore-nonprinting month-sort numeric-sort reverse random-sort random-source version-sort check unique stable field-separator key zero-terminated debug help version parallel batch-size buffer-size files0-from", "bdfghiMnrRVcCuszm", "ktS"),
        "uniq" => {
            args.iter().filter(|arg| !arg.starts_with('-')).count() <= 1
                && args.iter().all(|arg| {
                    !arg.starts_with('-')
                        || [
                            "-c",
                            "-d",
                            "-u",
                            "-i",
                            "--count",
                            "--repeated",
                            "--unique",
                            "--ignore-case",
                        ]
                        .contains(&arg.as_str())
                })
        }
        "rg" => read_options(args, "files files-with-matches files-without-match line-number no-line-number ignore-case case-sensitive smart-case fixed-strings regexp glob iglob type type-not type-list count count-matches only-matching heading no-heading hidden no-ignore no-ignore-vcs no-ignore-parent no-ignore-global follow max-count max-depth max-filesize context before-context after-context json stats color colors sort sortr path-separator multiline multiline-dotall encoding text binary crlf no-config help version threads trim passthru no-messages replace pcre2", "niIlLsvwxqoaFShHuUzP", "efgtTmABCrEj"),
        "file" => read_options(args, "brief mime mime-type mime-encoding dereference no-dereference keep-going no-pad raw print0 separator uncompress uncompress-nofork special-files preserve-date exclude exclude-quiet files-from magic-file help version", "bcdEhikLlNnprsvzZ0", "efmF"),
        "tree" => read_options(args, "dirsfirst filesfirst sort charset filelimit noreport inode device prune du info fromfile metafirst matchdirs ignore-case help version", "adfilnpqrstugDFNQhACJX", "LPIHT"),
        "hostname" => args.iter().all(|arg| {
            [
                "-a",
                "--alias",
                "-d",
                "--domain",
                "-f",
                "--fqdn",
                "--long",
                "-s",
                "--short",
                "-i",
                "--ip-address",
                "-I",
                "--all-ip-addresses",
                "-A",
                "--all-fqdns",
            ]
            .contains(&arg.as_str())
        }),
        "date" => args.iter().all(|arg| {
            arg.starts_with('+')
                || [
                    "-u",
                    "--utc",
                    "--universal",
                    "-R",
                    "--rfc-email",
                    "-I",
                    "--iso-8601",
                ]
                .contains(&arg.as_str())
                || arg.starts_with("--iso-8601=")
                || arg.starts_with("--rfc-3339=")
        }),
        "ls" | "dir" | "cat" | "head" | "tail" | "wc" | "stat" | "du" | "df" | "grep" | "cut"
        | "tr" | "diff" | "comm" | "pwd" | "which" | "whoami" | "uname" | "strings" | "od"
        | "sha256sum" | "md5sum" | "jq" => true,
        // Interpreters, interactive pagers and commands with ambiguous output
        // operands are not read-only capabilities. READ/SEARCH remain available.
        _ => false,
    }
}
// Option names must match exactly. GNU option abbreviations are intentionally
// rejected, including prefixes of output-file and executable-hook options.
fn read_options(args: &[String], long: &str, short: &str, values: &str) -> bool {
    for arg in args {
        if arg == "--" {
            break;
        }
        if let Some(option) = arg.strip_prefix("--") {
            let name = option.split('=').next().unwrap_or("");
            if !long.split_ascii_whitespace().any(|allowed| allowed == name) {
                return false;
            }
        } else if let Some(options) = arg.strip_prefix('-') {
            for c in options.chars() {
                if values.contains(c) {
                    break;
                }
                if !short.contains(c) && !c.is_ascii_digit() {
                    return false;
                }
            }
        }
    }
    true
}
fn execution_risk(kind: &str, argument: &str) -> Option<Risk> {
    let mut risk = classify_risk(kind, argument);
    if kind != "BASH" {
        return risk;
    }
    let Some(words) = command_words(argument) else {
        return risk;
    };
    let mut candidates = vec![words.join(" ")];
    if Path::new(&words[0])
        .file_name()
        .is_some_and(|name| name == "git")
    {
        let mut index = 1;
        while let Some(option) = words.get(index).filter(|arg| arg.starts_with('-')) {
            let takes_value = [
                "-c",
                "-C",
                "--exec-path",
                "--git-dir",
                "--work-tree",
                "--namespace",
                "--super-prefix",
                "--config-env",
            ]
            .contains(&option.as_str());
            index += if takes_value { 2 } else { 1 };
        }
        if let Some(command) = words.get(index) {
            candidates.push(format!("git {}", words[index..].join(" ")));
            if command == "push"
                && words[index + 1..].iter().any(|arg| {
                    arg.starts_with("--force")
                        || (arg.starts_with('-') && !arg.starts_with("--") && arg.contains('f'))
                })
            {
                candidates.push("git push --force".into());
            }
        }
    }
    for candidate in candidates {
        if let Some(next) = classify_risk(kind, &candidate) {
            if risk.is_none() || next.hard {
                risk = Some(next);
            }
        }
    }
    risk
}

#[derive(Default, Clone, Copy)]
pub struct Context {
    pub sprint_mode: bool,
}
pub struct Store {
    directory: PathBuf,
    roots: Vec<PathBuf>,
    worktrees: Vec<PathBuf>,
    writes: Arc<tokio::sync::Mutex<()>>,
    pub events: Option<Arc<crate::events::Store>>,
    pub telegram: Option<Arc<crate::telegram::Store>>,
}
impl Store {
    pub fn new(directory: PathBuf, roots: Vec<PathBuf>) -> Self {
        Self {
            directory,
            roots,
            worktrees: vec![],
            writes: Arc::new(tokio::sync::Mutex::new(())),
            events: None,
            telegram: None,
        }
    }
    pub fn register_worktree(&mut self, root: PathBuf) {
        if !self.worktrees.contains(&root) {
            self.worktrees.push(root);
        }
    }
    pub fn scoped(&self, roots: Vec<PathBuf>, worktrees: Vec<PathBuf>) -> Self {
        Self {
            directory: self.directory.clone(),
            roots,
            worktrees,
            writes: self.writes.clone(),
            events: self.events.clone(),
            telegram: self.telegram.clone(),
        }
    }
    pub fn unregister_worktree(&mut self, root: &Path) {
        self.worktrees.retain(|r| r != root);
    }
    fn primary(&self, sprint: bool) -> Result<&Path, String> {
        if sprint {
            if let Some(root) = self.worktrees.first() {
                return Ok(root);
            }
        }
        self.roots
            .first()
            .map(PathBuf::as_path)
            .ok_or_else(|| "Error: No projects registered".into())
    }
    fn resolve(&self, input: &str) -> Result<(PathBuf, PathBuf), String> {
        let roots: Vec<_> = self.worktrees.iter().rev().chain(&self.roots).collect();
        if roots.is_empty() {
            return Err("Error: No projects registered".into());
        }
        if input.contains('\0') {
            return Err("Error: Invalid file path".into());
        }
        let input_path = Path::new(input);
        for root in roots {
            let root = lexical(root);
            let path = lexical(&root.join(input_path));
            if let Ok(relative) = path.strip_prefix(&root) {
                return Ok((root, relative.to_path_buf()));
            }
        }
        Err(if input_path.is_absolute() {
            format!("Error: Path outside registered projects: {input}")
        } else {
            format!("Error: Cannot resolve path: {input}")
        })
    }
    /// Return None only for tools belonging to the service/delegation layer.
    pub async fn execute_core(
        &self,
        kind: &str,
        arg: &V,
        context: Context,
        cancel: &Cancel,
    ) -> Option<Result<V, String>> {
        if ![
            "BASH", "READ", "SEARCH", "EDIT", "WRITE", "GLOB", "GIT_DIFF", "GIT_LOG", "OPEN",
        ]
        .contains(&kind)
        {
            return None;
        }
        Some(self.execute(kind, arg, context, cancel).await)
    }
    async fn execute(
        &self,
        kind: &str,
        arg: &V,
        context: Context,
        cancel: &Cancel,
    ) -> Result<V, String> {
        if cancel.is_cancelled() {
            return Err("Command cancelled".into());
        }
        if !arg.is_string() {
            return Err("Tool argument must be a string".into());
        }
        let argument = arg.text();
        if let Some(risk) = execution_risk(kind, &argument) {
            let approved = if let Some(telegram) = &self.telegram {
                tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("Command cancelled".into()),
                    result = telegram.request_approval(risk.label.clone(), format!("{kind}:{argument}"), risk.hard) => result?,
                }
            } else {
                false
            };
            if !approved {
                return Ok(format!(
                    "Error: 사용자가 거부했거나 60초 안에 응답이 없었습니다. ({})",
                    risk.label
                )
                .into());
            }
        }
        match kind {
            "READ" => Ok(self.read(&argument).unwrap_or_else(V::from)),
            "EDIT" | "WRITE" => {
                // Cancellation is checked again inside the serialized mutation.
                // No await occurs between that check, backup and write.
                let _lock = tokio::select! {
                    biased;
                    _ = cancel.cancelled() => return Err("Command cancelled".into()),
                    lock = self.writes.lock() => lock,
                };
                if cancel.is_cancelled() {
                    return Err("Command cancelled".into());
                }
                Ok(
                    match if kind == "EDIT" {
                        self.edit(arg)
                    } else {
                        self.write(arg, context)
                    } {
                        Ok(value) => value,
                        Err(error) => error.into(),
                    },
                )
            }
            "GLOB" => Ok(self.glob(&argument, cancel).unwrap_or_else(|e| e).into()),
            "BASH" => {
                if !is_safe_command(&argument, context.sprint_mode) {
                    return Ok(if context.sprint_mode {
                        "Error: 이 명령어는 스프린트에서도 허용되지 않아영."
                    } else {
                        FILTER_ERROR
                    }
                    .into());
                }
                let root = match self.primary(context.sprint_mode) {
                    Ok(root) => root,
                    Err(e) => return Ok(e.into()),
                };
                if argument.trim().is_empty() {
                    return Ok("(no output)".into());
                }
                let words = command_words(&argument).ok_or("Invalid command quoting")?;
                let output = command(
                    root,
                    &words[0],
                    &words[1..],
                    if context.sprint_mode { 120 } else { 60 },
                    cancel,
                )
                .await?;
                require_success(&output)?;
                let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
                text.push_str(&String::from_utf8_lossy(&output.stderr));
                Ok(if text.trim().is_empty() {
                    "(no output)".into()
                } else {
                    V::from(text).trim()
                })
            }
            "SEARCH" => self.search(arg, cancel).await,
            "GIT_DIFF" => Ok(self
                .git_diff(&argument, cancel)
                .await
                .unwrap_or_else(|e| format!("Error: {e}"))
                .into()),
            "GIT_LOG" => Ok(self
                .git_log(&argument, cancel)
                .await
                .unwrap_or_else(|e| format!("Error: {e}"))
                .into()),
            "OPEN" => self.open(&argument, cancel).await,
            _ => unreachable!(),
        }
    }
    fn read(&self, input: &str) -> Result<V, String> {
        let (root, relative) = self.resolve(input)?;
        let mut file = scoped_open(&root, &relative, libc::O_RDONLY, 0)
            .map_err(|e| path_error(e, input, false))?;
        let bytes = read_regular(&mut file).map_err(|e| format!("Error: {e}"))?;
        let content = V::from(String::from_utf8_lossy(&bytes).into_owned());
        if content.units().len() > READ_LIMIT {
            let mut result = content.units()[..READ_LIMIT].to_vec();
            result.extend(
                format!(
                    "\n...(truncated — 전체 {}자 중 {READ_LIMIT}자만 표시)",
                    content.units().len()
                )
                .encode_utf16(),
            );
            return Ok(V::String(result));
        }
        Ok(content)
    }
    fn backup(&self, input: &str, bytes: &[u8]) -> Result<String, String> {
        let backup_dir = self.directory.join("agent-backups");
        // Refuse redirected storage; an approval log or backup must stay private.
        fs::create_dir_all(&self.directory).map_err(|e| format!("Error: 백업 생성 실패: {e}"))?;
        match fs::create_dir(&backup_dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(format!("Error: 백업 생성 실패: {e}")),
        }
        let meta =
            fs::symlink_metadata(&backup_dir).map_err(|e| format!("Error: 백업 생성 실패: {e}"))?;
        if !meta.is_dir() {
            return Err("Error: 백업 생성 실패: Invalid backup directory".into());
        }
        let safe_name: String = input
            .chars()
            .map(|c| if "/\\:*?\"<>|".contains(c) { '_' } else { c })
            .collect();
        let name = format!(
            "{}_{}-{:08x}.bak",
            safe_name,
            crate::account_usage::now(),
            rand::random::<u32>()
        );
        let mut file = scoped_open(
            &self.directory,
            &PathBuf::from("agent-backups").join(&name),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .map_err(|e| format!("Error: 백업 생성 실패: {e}"))?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|e| format!("Error: 백업 생성 실패: {e}"))?;
        Ok(name)
    }
    fn edit(&self, argument: &V) -> Result<V, String> {
        let units = argument.units();
        let file_path =
            String::from_utf16_lossy(units.split(|u| *u == 10).next().unwrap_or_default())
                .trim()
                .to_owned();
        if file_path.is_empty() {
            return Err("Error: 파일 경로가 필요해영.".into());
        }
        let (root, relative) = self.resolve(&file_path)?;
        let mut file = scoped_open(&root, &relative, libc::O_RDWR, 0)
            .map_err(|e| path_error(e, &file_path, true))?;
        require_single_link(&file)?;
        let bytes = read_regular(&mut file).map_err(|e| format!("Error: 파일 읽기 실패: {e}"))?;
        let content = V::from(String::from_utf8_lossy(&bytes).into_owned());
        let len = content.units().len();
        if len > EDIT_LIMIT {
            return Err(format!(
                "Error: 파일이 너무 커영 ({len}자). 최대 {EDIT_LIMIT}자까지 수정 가능해영."
            ));
        }
        if content.units().iter().take(1000).any(|u| *u == 0) {
            return Err("Error: 바이너리 파일은 수정할 수 없어영.".into());
        }
        let block = |name| -> Option<Vec<u16>> {
            let re = regress::Regex::new(&format!(r"{name}\s*\n<<<\n([\s\S]*?)\n>>>")).ok()?;
            let found = re.find_from_utf16(units, 0).next()?;
            Some(units[found.captures[0].clone()?].to_vec())
        };
        let (Some(old), Some(new)) = (block("OLD_CONTENT"), block("NEW_CONTENT")) else {
            return Err("Error: EDIT 형식이 잘못됐어영. OLD_CONTENT\\n<<<\\n...\\n>>>\\nNEW_CONTENT\\n<<<\\n...\\n>>> 블록이 필요해영.".into());
        };
        let mut content = normalize_lines(content.units());
        let mut old_normal = normalize_lines(&old);
        if !contains(&content, &old_normal) {
            let trimmed = trim_lines(&content);
            let old_trimmed = trim_lines(&old_normal);
            if !contains(&trimmed, &old_trimmed) {
                return Err("Error: OLD_CONTENT 블록이 파일에서 찾을 수 없어영. READ로 정확한 내용을 다시 확인해주세영.".into());
            }
            content = trimmed;
            old_normal = old_trimmed;
        }
        // An empty match is ambiguous for editing a nonempty file.
        if old_normal.is_empty() {
            return Err("Error: OLD_CONTENT 블록은 비어 있을 수 없어영.".into());
        }
        let occurrences = count_matches(&content, &old_normal);
        if occurrences > 1 {
            return Err(format!("Error: OLD_CONTENT가 파일에 {occurrences}번 나타나영. 더 구체적인 컨텍스트를 포함해주세영."));
        }
        let start = content
            .windows(old_normal.len())
            .position(|w| w == old_normal)
            .unwrap();
        content.splice(start..start + old_normal.len(), normalize_lines(&new));
        let backup = self.backup(&file_path, &bytes)?;
        if let Some(events) = &self.events {
            events.publish_raw(
                "agent:edit-backup",
                object([
                    ("file", file_path.clone().into()),
                    ("backupPath", backup.into()),
                ])
                .raw()
                .get(),
            );
        }
        replace_contents(
            &mut file,
            &bytes,
            String::from_utf16_lossy(&content).as_bytes(),
        )
        .map_err(|e| format!("Error: 파일 쓰기 실패: {e}"))?;
        let old_lines = old.iter().filter(|u| **u == 10).count() + 1;
        let new_lines = new.iter().filter(|u| **u == 10).count() + 1;
        Ok(format!("✅ {file_path} 수정 완료 ({old_lines}줄 → {new_lines}줄). 백업 생성됨. READ로 결과를 확인해주세영.").into())
    }
    fn write(&self, argument: &V, context: Context) -> Result<V, String> {
        let units = argument.units();
        let separator = units.iter().position(|u| *u == 10).unwrap_or(units.len());
        let file_path = V::String(units[..separator].to_vec()).trim().text();
        if file_path.is_empty() {
            return Err("Error: 파일 경로가 필요해영.".into());
        }
        let (root, relative) = self.resolve(&file_path)?;
        let content = units.get(separator + 1..).unwrap_or_default();
        if content.len() > EDIT_LIMIT {
            return Err(format!(
                "Error: 내용이 너무 커영 ({}자). 최대 {EDIT_LIMIT}자까지 가능해영.",
                content.len()
            ));
        }
        let existing = match scoped_open(&root, &relative, libc::O_RDWR, 0) {
            Ok(file) => Some(file),
            Err(e) if e.kind() == io::ErrorKind::NotFound => None,
            Err(e) => return Err(path_error(e, &file_path, true)),
        };
        if existing.is_some() && !context.sprint_mode {
            return Err(
                "Error: 파일이 이미 있어영. 기존 파일을 수정하려면 EDIT를 사용하세영.".into(),
            );
        }
        let overwrite = existing.is_some();
        if let Some(mut file) = existing {
            require_single_link(&file)?;
            let bytes =
                read_regular(&mut file).map_err(|e| format!("Error: 파일 읽기 실패: {e}"))?;
            self.backup(&file_path, &bytes)?;
            replace_contents(
                &mut file,
                &bytes,
                String::from_utf16_lossy(content).as_bytes(),
            )
            .map_err(|e| format!("Error: 파일 생성 실패: {e}"))?;
        } else {
            scoped_mkdirs(&root, relative.parent().unwrap_or(Path::new("")))
                .map_err(|e| format!("Error: 파일 생성 실패: {e}"))?;
            let mut file = scoped_open(
                &root,
                &relative,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                0o644,
            )
            .map_err(|e| path_error(e, &file_path, true))?;
            file.write_all(String::from_utf16_lossy(content).as_bytes())
                .and_then(|_| file.sync_all())
                .map_err(|e| format!("Error: 파일 생성 실패: {e}"))?;
        }
        let lines = content.iter().filter(|u| **u == 10).count() + 1;
        Ok(format!(
            "✅ {file_path} {} 완료 ({lines}줄, {}자).",
            if overwrite { "덮어쓰기" } else { "생성" },
            content.len()
        )
        .into())
    }
    fn glob(&self, pattern: &str, cancel: &Cancel) -> Result<String, String> {
        let root = self.primary(false)?;
        let safe = pattern.replace("../", "").trim().to_owned();
        if safe.is_empty() {
            return Err("Error: 패턴이 비어있어영.".into());
        }
        if safe.starts_with('/') || matches("^[a-zA-Z]:", "", &safe) {
            return Err("Error: 절대 경로 패턴은 사용할 수 없어영. 상대경로를 사용하세영.".into());
        }
        let pattern = safe
            .replace('.', "\\.")
            .replace("**", "{{DOUBLESTAR}}")
            .replace('*', "[^/]*")
            .replace("{{DOUBLESTAR}}", ".*")
            .replace('?', "[^/]");
        let re = regex::Regex::new(&format!("^{pattern}$")).ok();
        let mut queue = VecDeque::from([PathBuf::new()]);
        let mut results = vec![];
        let mut visited = 0usize;
        while let Some(relative) = queue.pop_front() {
            if cancel.is_cancelled() {
                return Err("Command cancelled".into());
            }
            if results.len() >= 50 {
                break;
            }
            visited += 1;
            if visited > 100000 {
                return Err("Error: File traversal limit exceeded".into());
            }
            let directory =
                match scoped_open(root, &relative, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
                    Ok(f) => f,
                    Err(_) => continue,
                };
            let Ok(entries) = directory_entries(&directory) else {
                continue;
            };
            for (name, is_dir) in entries {
                if results.len() >= 50 {
                    break;
                }
                let path = relative.join(&name);
                if is_dir {
                    if ![
                        "node_modules",
                        ".git",
                        "dist",
                        ".next",
                        "__pycache__",
                        ".venv",
                        "venv",
                        "build",
                        ".cache",
                        "coverage",
                    ]
                    .contains(&name.as_str())
                    {
                        queue.push_back(path);
                    }
                } else {
                    let display = path.to_string_lossy().into_owned();
                    let found = re.as_ref().map_or_else(
                        || display.contains(&safe.replace('*', "")),
                        |re| re.is_match(&display),
                    );
                    if found {
                        results.push(display.replace('\\', "/"));
                    }
                }
            }
        }
        Ok(if results.is_empty() {
            "No matches found".into()
        } else {
            results.join("\n")
        })
    }
    async fn search(&self, pattern: &V, cancel: &Cancel) -> Result<V, String> {
        let root = match self.primary(false) {
            Ok(root) => root,
            Err(_) => return Ok("No projects registered".into()),
        };
        let safe = V::String(
            pattern
                .units()
                .iter()
                .copied()
                .filter(|u| !matches!(*u, 0..=31 | 127))
                .collect(),
        )
        .trim();
        if safe.units().is_empty() {
            return Ok("Error: 검색어가 비어있어영.".into());
        }
        let mut args: Vec<String> = [
            "-rn",
            "-i",
            "-F",
            "--include=*.js",
            "--include=*.ts",
            "--include=*.py",
            "--include=*.json",
            "--include=*.md",
            "--include=*.css",
            "--include=*.html",
            "--",
        ]
        .into_iter()
        .map(Into::into)
        .collect();
        args.extend([safe.cut(200).text(), root.to_string_lossy().into_owned()]);
        let output = match command(root, "grep", &args, 60, cancel).await {
            Ok(o) => o,
            Err(e) => return Ok(format!("Search error: {e}").into()),
        };
        if output.status.code() == Some(1) {
            return Ok("No matches found".into());
        }
        if !output.status.success() && output.stdout.is_empty() {
            return Ok(format!(
                "Search error: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )
            .into());
        }
        let root = root.to_string_lossy();
        let lines: Vec<_> = String::from_utf8_lossy(&output.stdout)
            .split('\n')
            .filter(|s| !s.is_empty())
            .take(30)
            .map(|line| {
                let line = line
                    .replacen(&format!("{root}/"), "", 1)
                    .replacen(root.as_ref(), "", 1);
                line.strip_prefix("./").unwrap_or(&line).to_owned()
            })
            .collect();
        Ok(if lines.is_empty() {
            "No matches found".into()
        } else {
            lines.join("\n").into()
        })
    }
    async fn git(&self, args: &[&str], cancel: &Cancel) -> Result<String, String> {
        let root = self
            .primary(false)
            .map_err(|e| e.trim_start_matches("Error: ").to_owned())?;
        let output = command(
            root,
            "git",
            &args.iter().map(|s| (*s).into()).collect::<Vec<_>>(),
            15,
            cancel,
        )
        .await?;
        require_success(&output)?;
        Ok(String::from_utf8_lossy(&output.stdout).trim().into())
    }
    async fn git_diff(&self, mode: &str, cancel: &Cancel) -> Result<String, String> {
        match mode.trim().to_lowercase().as_str() {
            "staged" => {
                let text = self
                    .git(&["diff", "--cached", "--stat", "-p", "-U3"], cancel)
                    .await?;
                Ok(if text.is_empty() {
                    "No staged changes".into()
                } else {
                    text
                })
            }
            "unstaged" => {
                let text = self.git(&["diff", "--stat", "-p", "-U3"], cancel).await?;
                Ok(if text.is_empty() {
                    "No unstaged changes".into()
                } else {
                    text
                })
            }
            _ => {
                let staged = self.git(&["diff", "--cached", "--stat"], cancel).await?;
                let unstaged = self.git(&["diff", "--stat"], cancel).await?;
                let mut result = String::new();
                if !staged.is_empty() {
                    result.push_str(&format!("== Staged ==\n{staged}\n\n"));
                }
                if !unstaged.is_empty() {
                    result.push_str(&format!("== Unstaged ==\n{unstaged}"));
                }
                Ok(if result.is_empty() {
                    "No changes (clean working tree)".into()
                } else {
                    result
                })
            }
        }
    }
    async fn git_log(&self, arg: &str, cancel: &Cancel) -> Result<String, String> {
        let parsed = git_log_count(arg);
        let result = self
            .git(
                &[
                    "log",
                    "--oneline",
                    "--graph",
                    "--decorate",
                    &format!("-{parsed}"),
                ],
                cancel,
            )
            .await?;
        Ok(if result.is_empty() {
            "No commits found".into()
        } else {
            result
        })
    }
    async fn open(&self, argument: &str, cancel: &Cancel) -> Result<V, String> {
        let url = argument.trim();
        if url.is_empty() {
            return Ok("Error: URL이 필요해영.".into());
        }
        let final_url = if matches(r"^https?://", "i", url) {
            url.into()
        } else if url.contains('.') && !url.contains(' ') {
            format!("https://{url}")
        } else {
            return Ok("Error: https:// 로 시작하는 URL이 필요해영.".into());
        };
        let parsed = match url::Url::parse(&final_url) {
            Ok(u) => u,
            Err(_) => return Ok("Error: URL 형식이 올바르지 않아영.".into()),
        };
        if !["http", "https"].contains(&parsed.scheme()) {
            return Ok("Error: http/https 프로토콜만 열 수 있어영.".into());
        }
        let host = parsed.host_str().unwrap_or("");
        if matches(
            r"^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|localhost|\[::1\])",
            "",
            host,
        ) {
            return Ok("Error: 로컬/내부 네트워크 주소는 열 수 없어영.".into());
        }
        if matches(r"youtube\.com|youtu\.be", "i", host) {
            let re = regex::Regex::new(r"[?&]v=([a-zA-Z0-9_-]{11})").unwrap();
            let video = re
                .captures(&final_url)
                .map(|m| m[1].to_owned())
                .or_else(|| {
                    let path = parsed.path().trim_start_matches('/');
                    (host == "youtu.be" && matches("^[a-zA-Z0-9_-]{11}$", "", path))
                        .then(|| path.to_owned())
                });
            if let Some(video) = video {
                return Ok(format!(
                    "@@EMBED:youtube:https://www.youtube.com/embed/{video}?autoplay=1@@"
                )
                .into());
            }
        }
        let safe = final_url.replace(['"', '\'', '`'], "");
        let programs: &[&str] = if cfg!(target_os = "macos") {
            &["open"]
        } else if std::env::var_os("WSL_DISTRO_NAME").is_some() {
            &["wslview", "xdg-open"]
        } else {
            &["xdg-open"]
        };
        match launch_url(&safe, programs, cancel).await {
            Ok(()) => Ok(format!("✅ 브라우저에서 열었어영: {final_url}").into()),
            Err(e) => Ok(format!("Error: 열기 실패: {e}").into()),
        }
    }
}

fn lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
fn path_error(error: io::Error, input: &str, prefix: bool) -> String {
    if matches!(error.raw_os_error(), Some(libc::EXDEV | libc::ELOOP)) {
        LINK_ERROR.into()
    } else if error.kind() == io::ErrorKind::NotFound {
        format!(
            "{}File not found: {input}",
            if prefix { "Error: " } else { "" }
        )
    } else {
        format!("Error: {error}")
    }
}
#[cfg(target_os = "linux")]
fn scoped_open(root: &Path, relative: &Path, flags: i32, mode: u32) -> io::Result<File> {
    use std::os::{
        fd::{AsRawFd, FromRawFd},
        unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    };
    let root = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_CLOEXEC)
        .open(root)?;
    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC | libc::O_NONBLOCK) as u64,
        mode: mode as u64,
        resolve: 0x08 | 0x02, /* BENEATH | NO_MAGICLINKS */
    };
    let open = |relative: &Path| {
        let relative = if relative.as_os_str().is_empty() {
            Path::new(".")
        } else {
            relative
        };
        let path = std::ffi::CString::new(relative.as_os_str().as_bytes())
            .map_err(|_| io::Error::other("Invalid file path"))?;
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root.as_raw_fd(),
                path.as_ptr(),
                &how,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if fd < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(unsafe { File::from_raw_fd(fd as i32) })
        }
    };
    match open(relative) {
        Err(original) if matches!(original.raw_os_error(), Some(libc::EXDEV | libc::ELOOP)) => {
            // BENEATH rejects absolute links, even when their destination is
            // inside this root. Resolve that destination, then reopen beneath
            // the same directory descriptor so a swapped link cannot escape.
            let anchor = PathBuf::from(format!("/proc/self/fd/{}", root.as_raw_fd()));
            let base = anchor.canonicalize()?;
            let mut target = anchor.join(relative);
            let mut missing = Vec::new();
            let canonical = loop {
                match target.canonicalize() {
                    Ok(mut resolved) => {
                        for name in missing.iter().rev() {
                            resolved.push(name);
                        }
                        break resolved;
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        let Some(name) = target.file_name() else {
                            return Err(original);
                        };
                        missing.push(name.to_os_string());
                        if !target.pop() {
                            return Err(original);
                        }
                    }
                    Err(_) => return Err(original),
                }
            };
            let Ok(relative) = canonical.strip_prefix(base) else {
                return Err(original);
            };
            open(relative)
        }
        result => result,
    }
}
#[cfg(not(target_os = "linux"))]
fn scoped_open(_: &Path, _: &Path, _: i32, _: u32) -> io::Result<File> {
    Err(io::Error::other(
        "Native agent file tools have not been validated on this platform",
    ))
}
fn scoped_mkdirs(root: &Path, relative: &Path) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::ffi::OsStrExt;
        let mut prefix = PathBuf::new();
        for component in relative.components() {
            let Component::Normal(name) = component else {
                return Err(io::Error::other("Invalid relative directory"));
            };
            let parent = scoped_open(root, &prefix, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
            let name_c = std::ffi::CString::new(name.as_bytes())
                .map_err(|_| io::Error::other("Invalid directory"))?;
            if unsafe { libc::mkdirat(parent.as_raw_fd(), name_c.as_ptr(), 0o755) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            prefix.push(name);
            scoped_open(root, &prefix, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (root, relative);
        Err(io::Error::other(
            "Native agent directory creation has not been validated",
        ))
    }
}
fn directory_entries(directory: &File) -> io::Result<Vec<(String, bool)>> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        let mut entries = fs::read_dir(format!("/proc/self/fd/{}", directory.as_raw_fd()))?
            .map(|entry| {
                let entry = entry?;
                Ok((
                    entry.file_name().to_string_lossy().into_owned(),
                    entry.file_type()?.is_dir(),
                ))
            })
            .collect::<io::Result<Vec<_>>>()?;
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        Ok(entries)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = directory;
        Err(io::Error::other(
            "Native directory traversal has not been validated",
        ))
    }
}
fn read_regular(file: &mut File) -> io::Result<Vec<u8>> {
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(io::Error::other("Only regular files are allowed"));
    }
    if metadata.len() > FILE_LIMIT {
        return Err(io::Error::other("File exceeded read limit"));
    }
    let mut bytes = vec![];
    file.take(FILE_LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > FILE_LIMIT {
        return Err(io::Error::other("File exceeded read limit"));
    }
    Ok(bytes)
}
fn require_single_link(file: &File) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if file.metadata().map_err(|e| format!("Error: {e}"))?.nlink() != 1 {
            return Err("Error: Hard-linked files cannot be modified".into());
        }
    }
    Ok(())
}
fn replace_contents(file: &mut File, expected: &[u8], replacement: &[u8]) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    if read_regular(file)? != expected {
        return Err(io::Error::other(
            "File changed while preparing edit; read it again",
        ));
    }
    file.seek(SeekFrom::Start(0))?;
    file.write_all(replacement)?;
    file.set_len(replacement.len() as u64)?;
    file.sync_all()
}
fn normalize_lines(units: &[u16]) -> Vec<u16> {
    units
        .iter()
        .enumerate()
        .filter(|(i, c)| !(**c == 13 && units.get(i + 1) == Some(&10)))
        .map(|(_, c)| *c)
        .collect()
}
fn trim_lines(units: &[u16]) -> Vec<u16> {
    let mut result = vec![];
    for (i, line) in units.split(|u| *u == 10).enumerate() {
        if i > 0 {
            result.push(10);
        }
        // trimEnd keeps leading whitespace, unlike trim().
        let trailing = line.len()
            - line
                .iter()
                .rposition(|u| !V::String(vec![*u]).trim().units().is_empty())
                .map_or(0, |i| i + 1);
        result.extend_from_slice(&line[..line.len() - trailing]);
    }
    result
}
fn contains(haystack: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || haystack.windows(needle.len()).any(|w| w == needle)
}
fn count_matches(haystack: &[u16], needle: &[u16]) -> usize {
    let mut count = 0;
    let mut rest = haystack;
    while let Some(index) = rest.windows(needle.len()).position(|w| w == needle) {
        count += 1;
        rest = &rest[index + needle.len()..];
    }
    count
}
fn git_log_count(arg: &str) -> u32 {
    let trimmed = V::from(arg).trim().text();
    let (negative, rest) = if let Some(rest) = trimmed.strip_prefix('-') {
        (true, rest)
    } else {
        (false, trimmed.strip_prefix('+').unwrap_or(&trimmed))
    };
    let (radix, rest) = if rest.starts_with("0x") || rest.starts_with("0X") {
        (16, &rest[2..])
    } else {
        (10, rest)
    };
    let mut number = 0u32;
    let mut digits = 0;
    for c in rest.chars() {
        let Some(value) = c.to_digit(radix) else {
            break;
        };
        digits += 1;
        number = (number * radix + value).min(51);
    }
    if digits == 0 || number == 0 {
        10
    } else if negative {
        1
    } else {
        number.min(50)
    }
}
async fn command(
    root: &Path,
    program: &str,
    args: &[String],
    seconds: u64,
    cancel: &Cancel,
) -> Result<std::process::Output, String> {
    let mut command = Command::new(program);
    if program == "git" {
        command
            .args([
                "--no-pager",
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.hooksPath=/dev/null",
                "-C",
            ])
            .arg(root);
        if args
            .first()
            .is_some_and(|sub| ["diff", "log", "show"].contains(&sub.as_str()))
        {
            command
                .arg(&args[0])
                .args(["--no-ext-diff", "--no-textconv"])
                .args(&args[1..]);
        } else {
            command.args(args);
        }
    } else {
        command.args(args);
    }
    command
        .current_dir(root)
        .env_remove("CLAUDECODE")
        .env_remove("RIPGREP_CONFIG_PATH")
        .env_remove("GIT_EXTERNAL_DIFF");
    process_owned::run(command, Duration::from_secs(seconds), COMMAND_LIMIT, cancel).await
}
fn require_success(output: &std::process::Output) -> Result<(), String> {
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Command failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}
async fn launch_url(url: &str, programs: &[&str], cancel: &Cancel) -> Result<(), String> {
    let mut error = "No desktop opener available".to_owned();
    for program in programs {
        if cancel.is_cancelled() {
            return Err("Command cancelled".into());
        }
        let mut command = Command::new(program);
        command.arg(url);
        match process_owned::run(command, Duration::from_secs(5), COMMAND_LIMIT, cancel).await {
            Ok(output) if output.status.success() => return Ok(()),
            Ok(output) => {
                error = format!(
                    "Desktop opener exited {}: {}",
                    output.status,
                    String::from_utf8_lossy(&output.stderr).trim()
                )
            }
            Err(e) => error = e,
        }
    }
    Err(error)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stopped_write_waiter_exits_before_lock_releases_without_mutation() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("existing"), "before").unwrap();
        let store = Arc::new(Store::new(directory.path().into(), vec![root.clone()]));
        for (kind, arg) in [
            ("WRITE", "new\nafter"),
            (
                "EDIT",
                "existing\nOLD_CONTENT\n<<<\nbefore\n>>>\nNEW_CONTENT\n<<<\nafter\n>>>",
            ),
        ] {
            let parent = Cancel::default();
            let child = parent.child();
            let lock = store.writes.lock().await;
            let s = store.clone();
            let task = tokio::spawn(async move {
                s.execute_core(kind, &V::from(arg), Context { sprint_mode: false }, &child)
                    .await
                    .unwrap()
            });
            tokio::task::yield_now().await;
            parent.cancel();
            assert!(tokio::time::timeout(Duration::from_millis(100), task)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(!root.join("new").exists());
            assert_eq!(
                std::fs::read_to_string(root.join("existing")).unwrap(),
                "before"
            );
            drop(lock);
        }
    }
    use std::os::unix::fs::{symlink, PermissionsExt};
    fn fixture() -> (tempfile::TempDir, Store) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("project");
        fs::create_dir(&root).unwrap();
        let store = Store::new(directory.path().join("data"), vec![root]);
        (directory, store)
    }
    fn edit_arg(path: &str, old: &str, new: &str) -> V {
        format!("{path}\nOLD_CONTENT\n<<<\n{old}\n>>>\nNEW_CONTENT\n<<<\n{new}\n>>>").into()
    }
    async fn call(store: &Store, kind: &str, arg: &str) -> V {
        store
            .execute_core(kind, &arg.into(), Context::default(), &Cancel::default())
            .await
            .unwrap()
            .unwrap()
    }
    fn reference() -> V {
        V::parse(
            &serde_json::value::RawValue::from_string(
                include_str!("../../tests/fixtures/rust-agent-tools.json").into(),
            )
            .unwrap(),
        )
        .unwrap()
    }
    #[tokio::test]
    async fn original_core_tool_fixtures() {
        let (_directory, store) = fixture();
        let root = &store.roots[0];
        fs::write(root.join("small.md"), "첫 줄\nsecond line\n😀").unwrap();
        fs::write(root.join("long.txt"), "😀".repeat(5001)).unwrap();
        fs::write(root.join("edit.txt"), "alpha\r\nbeta\r\n").unwrap();
        fs::create_dir(root.join("src")).unwrap();
        fs::write(root.join("src/main.js"), "const value = \"needle\";\n").unwrap();
        for case in reference()["cases"].array() {
            let mut result = call(&store, &case["tool"].text(), &case["arg"].text()).await;
            if case["tool"] == V::from("BASH") && case["arg"] == V::from("pwd") {
                assert_eq!(result.text(), root.to_string_lossy());
                result = "<ROOT>".into();
            }
            assert_eq!(
                result,
                case["value"],
                "{} {}",
                case["tool"].text(),
                case["arg"].text()
            );
        }
        let backups: Vec<_> = fs::read_dir(store.directory.join("agent-backups"))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read(backups[0].path()).unwrap(), b"alpha\r\nbeta\r\n");
        assert_eq!(
            backups[0].metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    #[tokio::test]
    async fn original_git_tool_fixtures() {
        let (_directory, store) = fixture();
        let root = &store.roots[0];
        fs::write(root.join("small.md"), "첫 줄\nsecond line\n😀").unwrap();
        for args in [
            vec!["init", "-q", "-b", "main", "--template="],
            vec!["add", "--", "small.md"],
            vec![
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "-qm",
                "fixture",
            ],
        ] {
            let output = std::process::Command::new("/usr/bin/git")
                .arg("-C")
                .arg(root)
                .args(["-c", "core.hooksPath=/dev/null"])
                .args(args)
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("GIT_CONFIG_SYSTEM", "/dev/null")
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_AUTHOR_DATE", "2020-01-01T00:00:00Z")
                .env("GIT_COMMITTER_DATE", "2020-01-01T00:00:00Z")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        fs::write(root.join("small.md"), "first changed\n").unwrap();
        let output = std::process::Command::new("/usr/bin/git")
            .arg("-C")
            .arg(root)
            .args(["add", "--", "small.md"])
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .output()
            .unwrap();
        assert!(output.status.success());
        fs::write(root.join("small.md"), "second changed\n").unwrap();
        let hashes = regex::Regex::new(r"\b[0-9a-f]{7,40}\b").unwrap();
        for case in reference()["gitCases"].array() {
            let result = call(&store, &case["tool"].text(), &case["arg"].text())
                .await
                .text();
            assert_eq!(
                hashes.replace_all(&result, "<HASH>"),
                case["value"].text(),
                "{} {}",
                case["tool"].text(),
                case["arg"].text()
            );
        }
    }
    #[test]
    fn git_log_count_preserves_parse_int_clamping_and_overflow() {
        for (input, expected) in [
            ("", 10),
            ("0", 10),
            ("-0", 10),
            (" 12x", 12),
            ("0x20", 32),
            ("-0xff", 1),
            ("1e3", 1),
            ("0b10", 10),
            ("+5.9", 5),
            ("NaN", 10),
            ("\u{feff}7", 7),
            ("999999999999999999999999999999999", 50),
            ("-999999999999999999999999999999999", 1),
            ("0xffffffffffffffffffffffffffffffff", 50),
        ] {
            assert_eq!(git_log_count(input), expected, "{input}");
        }
    }
    #[tokio::test]
    async fn readonly_commands_cannot_write_or_invoke_embedded_commands() {
        let (directory, store) = fixture();
        let root = &store.roots[0];
        fs::write(root.join("input.txt"), "unchanged\n").unwrap();
        let outside = directory.path().join("outside");
        fs::write(&outside, "unchanged\n").unwrap();
        for cmd in [
            "sort -o ../outside input.txt",
            "sort -ro../outside input.txt",
            "find ../outside -delete",
            "find . -fprint ../outside",
            "sed -n w../outside input.txt",
            "sed -n 'e' input.txt",
            "awk 'BEGIN {system(\"/bin/to\" \"uch ../outside\")}'",
            "git -C ../outside config review.flag changed",
            "git -c alias.inspect=!script inspect",
            "git diff --output=../outside",
            "xxd -r input.hex ../outside",
            "uniq input.txt ../outside",
            "ls || true; touch ../outside",
            "ls\ntouch ../outside",
            "rg --pre=script x",
            "tree -o ../outside",
            "hostname new-name",
            "file -C -m input.txt",
        ] {
            assert_eq!(
                call(&store, "BASH", cmd).await,
                V::from(FILTER_ERROR),
                "{cmd}"
            );
            assert_eq!(fs::read_to_string(&outside).unwrap(), "unchanged\n");
        }
        for cmd in ["cat 'input.txt'", "sed -n '1p' input.txt", "sort input.txt"] {
            assert_eq!(
                call(&store, "BASH", cmd).await,
                V::from("unchanged"),
                "{cmd}"
            );
        }
        assert_eq!(
            command_words("cat 'a b' \"c d\" escaped\\ name").unwrap(),
            ["cat", "a b", "c d", "escaped name"]
        );
        assert!(command_words("cat 'unclosed").is_none());
        for cmd in [
            "sort --out=../outside input.txt",
            "sort --output=../outside input.txt",
            "sort --compress-prog=script input.txt",
            "git grep --open-files=script pattern",
            "git grep -Oscript pattern",
            "git log --out=../outside",
            "rg --hostname-b=script pattern",
            "file --comp input.txt",
            "tree --exec=script",
            "git.exe diff",
        ] {
            assert_eq!(
                call(&store, "BASH", cmd).await,
                V::from(FILTER_ERROR),
                "{cmd}"
            );
            assert_eq!(fs::read_to_string(&outside).unwrap(), "unchanged\n");
        }
        for cmd in [
            "sort --reverse input.txt",
            "sort -k1,1 input.txt",
            "rg --line-number --fixed-strings x .",
            "git log --oneline --max-count=10",
            "git status --porcelain=v1",
        ] {
            assert!(is_safe_command(cmd, false), "{cmd}");
        }
    }
    #[tokio::test]
    async fn sprint_approval_classifies_executed_argv_including_git_global_options() {
        let (_directory, store) = fixture();
        for (command, hard) in [
            ("git 'push' --force", true),
            ("git pu\\sh", false),
            ("'git' push", false),
            (
                "/usr/bin/git -C other -c color.ui=false push origin main --force",
                true,
            ),
            ("git --git-dir=/some/repo push origin main -uf", true),
            ("git --work-tree /some/path push", false),
            ("git push origin main --force-with-lease", true),
            ("git -c key=value reset --hard", false),
        ] {
            let risk = execution_risk("BASH", command).unwrap();
            assert_eq!(risk.hard, hard, "{command}");
            let result = store
                .execute_core(
                    "BASH",
                    &command.into(),
                    Context { sprint_mode: true },
                    &Cancel::default(),
                )
                .await
                .unwrap()
                .unwrap();
            assert!(
                result.text().starts_with("Error: 사용자가 거부했거나"),
                "{command}: {}",
                result.text()
            );
        }
        assert!(execution_risk("BASH", "git -C other status").is_none());
    }
    #[test]
    fn original_risk_and_filters_except_rejected_command_chaining() {
        for case in reference()["policies"].array() {
            let command = case["arg"].text();
            let strengthened = command
                .chars()
                .any(|c| matches!(c, '\n' | '\r' | '\0' | '&' | '|' | ';'));
            assert_eq!(
                is_safe_command(&command, false),
                !strengthened && case["safe"].truthy(),
                "{command}"
            );
            assert_eq!(
                is_safe_command(&command, true),
                !strengthened && case["sprintSafe"].truthy(),
                "sprint {command}"
            );
            let actual = classify_risk("BASH", &command)
                .map(|r| object([("label", r.label.into()), ("hard", r.hard.into())]))
                .unwrap_or(V::Null);
            assert_eq!(actual, case["risk"], "{command}");
        }
        assert!(classify_risk("bash", "git push").is_none());
        assert!(classify_risk("COCKPIT", "terminal-input:id:command").is_some());
        assert!(classify_risk("COCKPIT", "terminal-status").is_none());
    }
    #[tokio::test]
    async fn paths_do_not_escape_through_symlinks_case_or_sprint_names() {
        let (directory, store) = fixture();
        let root = &store.roots[0];
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret"), "unchanged").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        symlink(outside.join("secret"), root.join("link")).unwrap();
        for (tool, arg) in [
            ("READ", "link"),
            ("WRITE", "escape/new\ncontent"),
            ("WRITE", "link\noverwrite"),
        ] {
            assert_eq!(call(&store, tool, arg).await, V::from(LINK_ERROR));
        }
        assert!(store
            .edit(&edit_arg("link", "unchanged", "changed"))
            .is_err());
        assert!(!outside.join("new").exists());
        assert_eq!(
            fs::read_to_string(outside.join("secret")).unwrap(),
            "unchanged"
        );
        let case_variant = directory
            .path()
            .join("PROJECT/secret")
            .to_string_lossy()
            .into_owned();
        assert!(store.resolve(&case_variant).is_err());
        assert!(store
            .resolve(
                &directory
                    .path()
                    .join("project-sprint-fake/secret")
                    .to_string_lossy()
            )
            .is_err());
        fs::write(root.join("normal"), "before").unwrap();
        symlink("normal", root.join("inside")).unwrap();
        assert_eq!(call(&store, "READ", "inside").await, V::from("before"));
        store.edit(&edit_arg("inside", "before", "after")).unwrap();
        assert_eq!(fs::read_to_string(root.join("normal")).unwrap(), "after");
        assert!(fs::symlink_metadata(root.join("inside"))
            .unwrap()
            .is_symlink());
        symlink(root.join("normal"), root.join("absolute-inside")).unwrap();
        assert_eq!(
            call(&store, "READ", "absolute-inside").await,
            V::from("after")
        );
        store
            .edit(&edit_arg("absolute-inside", "after", "absolute"))
            .unwrap();
        assert_eq!(fs::read_to_string(root.join("normal")).unwrap(), "absolute");
        fs::create_dir(root.join("actual-dir")).unwrap();
        symlink(root.join("actual-dir"), root.join("absolute-dir")).unwrap();
        assert!(!call(&store, "WRITE", "absolute-dir/new\ninside")
            .await
            .text()
            .starts_with("Error:"));
        assert_eq!(
            fs::read_to_string(root.join("actual-dir/new")).unwrap(),
            "inside"
        );
    }
    #[test]
    fn backup_failure_and_hard_links_preserve_existing_bytes() {
        let (directory, store) = fixture();
        let file = store.roots[0].join("existing");
        fs::write(&file, "original").unwrap();
        fs::create_dir_all(&store.directory).unwrap();
        let outside = directory.path().join("outside-backups");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, store.directory.join("agent-backups")).unwrap();
        assert!(store
            .edit(&edit_arg("existing", "original", "new"))
            .unwrap_err()
            .contains("백업 생성 실패"));
        assert!(store
            .write(&V::from("existing\nnew"), Context { sprint_mode: true })
            .unwrap_err()
            .contains("백업 생성 실패"));
        assert_eq!(fs::read_to_string(&file).unwrap(), "original");
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        fs::hard_link(&file, directory.path().join("hardlink")).unwrap();
        assert!(store
            .edit(&edit_arg("existing", "original", "new"))
            .unwrap_err()
            .contains("Hard-linked"));
        assert_eq!(fs::read_to_string(file).unwrap(), "original");
    }
    #[test]
    fn edits_replace_literal_dollars_and_apply_whitespace_fallback() {
        let (_directory, store) = fixture();
        let file = store.roots[0].join("existing");
        fs::write(&file, "  old \t\nkeep\n").unwrap();
        store
            .edit(&edit_arg("existing", "  old  ", "$& $$ $` $'"))
            .unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "$& $$ $` $'\nkeep\n");
        fs::write(&file, "aa aa").unwrap();
        assert!(store
            .edit(&edit_arg("existing", "aa", "x"))
            .unwrap_err()
            .contains("2번"));
        assert!(store.edit(&edit_arg("existing", "", "x")).is_err());
        assert_eq!(fs::read_to_string(file).unwrap(), "aa aa");
    }
    #[test]
    fn size_binary_and_invalid_utf16_boundaries() {
        let (_directory, store) = fixture();
        let file = store.roots[0].join("existing");
        fs::write(&file, "😀".repeat(50000)).unwrap();
        assert!(store
            .edit(&edit_arg("existing", "😀", "x"))
            .unwrap_err()
            .contains("50000번"));
        fs::write(&file, "😀".repeat(50001)).unwrap();
        assert!(store
            .edit(&edit_arg("existing", "😀", "x"))
            .unwrap_err()
            .contains("100002자"));
        assert!(store
            .write(
                &format!("large\n{}", "x".repeat(100001)).into(),
                Context::default()
            )
            .is_err());
        assert!(!store.roots[0].join("large").exists());
        fs::write(&file, b"a\0b").unwrap();
        assert!(store
            .edit(&edit_arg("existing", "a", "b"))
            .unwrap_err()
            .contains("바이너리"));
        let arg = V::String("lone\n".encode_utf16().chain([0xd800]).collect());
        store.write(&arg, Context::default()).unwrap();
        assert_eq!(
            fs::read_to_string(store.roots[0].join("lone")).unwrap(),
            "�"
        );
    }
    #[tokio::test]
    async fn worktree_registration_order_and_cancellation_before_side_effects() {
        let (directory, mut store) = fixture();
        let a = directory.path().join("work-a");
        let b = directory.path().join("work-b");
        for (path, value) in [(&a, "a"), (&b, "b")] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("file"), value).unwrap();
        }
        store.register_worktree(a.clone());
        store.register_worktree(b.clone());
        assert_eq!(call(&store, "READ", "file").await, V::from("b"));
        assert_eq!(store.primary(true).unwrap(), a);
        store.unregister_worktree(&b);
        assert_eq!(call(&store, "READ", "file").await, V::from("a"));
        let cancel = Cancel::default();
        cancel.cancel();
        assert!(store
            .execute_core("WRITE", &V::from("new\nno"), Context::default(), &cancel)
            .await
            .unwrap()
            .is_err());
        assert!(!a.join("new").exists());
        assert!(store
            .execute_core("COCKPIT", &V::from("stats"), Context::default(), &cancel)
            .await
            .is_none());
    }
    #[tokio::test]
    async fn glob_does_not_follow_directory_links_or_scan_excluded_trees() {
        let (directory, store) = fixture();
        let root = &store.roots[0];
        fs::create_dir(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules/secret.js"), "skip").unwrap();
        let outside = directory.path().join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("secret.js"), "skip").unwrap();
        symlink(&outside, root.join("link")).unwrap();
        for i in 0..60 {
            fs::write(root.join(format!("{i:02}.js")), "").unwrap();
        }
        let value = call(&store, "GLOB", "*.js").await.text();
        assert_eq!(value.lines().count(), 50);
        assert!(!value.contains("secret"));
        assert_eq!(
            call(&store, "GLOB", "**/*.js").await,
            V::from("No matches found")
        );
    }
    #[tokio::test]
    async fn open_validation_and_youtube_embedding_never_launch_desktop() {
        let (_directory, store) = fixture();
        for (input, expected) in [
            ("", "Error: URL이 필요해영."),
            ("not a url", "Error: https:// 로 시작하는 URL이 필요해영."),
            (
                "http://localhost/path",
                "Error: 로컬/내부 네트워크 주소는 열 수 없어영.",
            ),
            (
                "https://[::1]/",
                "Error: 로컬/내부 네트워크 주소는 열 수 없어영.",
            ),
        ] {
            assert_eq!(call(&store, "OPEN", input).await, V::from(expected));
        }
        for url in [
            "https://www.youtube.com/watch?v=abcdefghijk",
            "https://youtu.be/abcdefghijk",
        ] {
            assert_eq!(
                call(&store, "OPEN", url).await,
                V::from("@@EMBED:youtube:https://www.youtube.com/embed/abcdefghijk?autoplay=1@@")
            );
        }
    }
    #[tokio::test]
    async fn opener_falls_back_on_missing_binary_or_nonzero_exit_and_obeys_cancel() {
        let directory = tempfile::tempdir().unwrap();
        let bad = directory.path().join("bad-opener");
        let good = directory.path().join("good-opener");
        let marker = directory.path().join("opened");
        fs::write(&bad, "#!/bin/sh\nexit 7\n").unwrap();
        fs::write(
            &good,
            format!("#!/bin/sh\nprintf '%s' \"$1\" > '{}'\n", marker.display()),
        )
        .unwrap();
        for path in [&bad, &good] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for first in [directory.path().join("missing-opener"), bad.clone()] {
            launch_url(
                "https://example.test/fixture?a=1&b=2",
                &[first.to_str().unwrap(), good.to_str().unwrap()],
                &Cancel::default(),
            )
            .await
            .unwrap();
            assert_eq!(
                fs::read_to_string(&marker).unwrap(),
                "https://example.test/fixture?a=1&b=2"
            );
            fs::remove_file(&marker).unwrap();
        }
        assert!(launch_url(
            "https://example.test",
            &[bad.to_str().unwrap()],
            &Cancel::default()
        )
        .await
        .is_err());
        let cancel = Cancel::default();
        cancel.cancel();
        assert!(
            launch_url("https://example.test", &[good.to_str().unwrap()], &cancel)
                .await
                .is_err()
        );
        assert!(!marker.exists());
    }
}
