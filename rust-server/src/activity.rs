use regex::Regex;
use std::{
    collections::{HashSet, VecDeque},
    fs::File,
    io::{self, Read},
    path::Path,
    sync::LazyLock,
};

macro_rules! matches {
    ($pattern:literal, $text:expr) => {{
        static PATTERN: LazyLock<Regex> = LazyLock::new(|| Regex::new($pattern).unwrap());
        PATTERN.is_match($text)
    }};
}

fn kind_of(comm: &str, cmdline: &str) -> Option<&'static str> {
    let args: Vec<_> = cmdline.split('\0').filter(|s| !s.is_empty()).collect();
    let basename = |s: &str| {
        Path::new(s)
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_lowercase()
    };
    let executable = basename(args.first().copied().unwrap_or(""));
    let script = if matches!(
        r"^(node|nodejs|bun|python(?:[0-9]+(?:\.[0-9]+)*)?)$",
        &executable
    ) {
        basename(args.get(1).copied().unwrap_or(""))
    } else {
        String::new()
    };
    let names = [comm.trim().to_lowercase(), executable, script];
    for agent in ["claude", "codex", "opencode"] {
        if names.iter().any(|name| name == agent) {
            return Some(agent);
        }
    }
    names
        .iter()
        .any(|name| {
            matches!(
                r"^(?:jcode|jcode-(?:linux|darwin)-(?:x86_64|aarch64|arm64)(?:\.bin)?)$",
                name
            )
        })
        .then_some("jcode")
}

fn invalid_process() -> io::Error {
    io::Error::other("Terminal process could not be observed")
}

pub fn detect(pid: Option<u32>) -> io::Result<Option<&'static str>> {
    detect_process(pid).map(|process| process.map(|(_, kind)| kind))
}

pub fn detect_process(pid: Option<u32>) -> io::Result<Option<(u32, &'static str)>> {
    let pid = pid.filter(|p| *p > 0).ok_or_else(invalid_process)?;
    detect_process_with(pid, |path| {
        let mut bytes = Vec::new();
        File::open(path)?.take(65_537).read_to_end(&mut bytes)?;
        if bytes.len() > 65_536 {
            return Err(invalid_process());
        }
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
}

#[cfg(test)]
fn detect_with(
    pid: u32,
    read: impl Fn(&str) -> io::Result<String>,
) -> io::Result<Option<&'static str>> {
    detect_process_with(pid, read).map(|process| process.map(|(_, kind)| kind))
}

fn detect_process_with(
    pid: u32,
    read: impl Fn(&str) -> io::Result<String>,
) -> io::Result<Option<(u32, &'static str)>> {
    let state_of = |pid| -> io::Result<Vec<String>> {
        let text = read(&format!("/proc/{pid}/stat"))?;
        let tail = text.rsplit_once(") ").ok_or_else(invalid_process)?.1;
        Ok(tail.split_whitespace().map(str::to_owned).collect())
    };
    let root = state_of(pid)?;
    let foreground = root
        .get(5)
        .and_then(|s| s.parse::<u32>().ok())
        .filter(|n| *n > 0)
        .ok_or_else(invalid_process)?;
    let mut queue = VecDeque::from([pid]);
    let mut seen = HashSet::new();
    while let Some(next) = queue.pop_front() {
        if !seen.insert(next) {
            continue;
        }
        if seen.len() > 128 {
            return Err(invalid_process());
        }
        let state = if next == pid {
            root.clone()
        } else {
            state_of(next)?
        };
        let comm = read(&format!("/proc/{next}/comm"))?;
        let cmdline = read(&format!("/proc/{next}/cmdline"))?;
        if state.get(2).and_then(|s| s.parse::<u32>().ok()) == Some(foreground)
            && state
                .first()
                .is_some_and(|s| !["T", "t", "Z", "X"].contains(&s.as_str()))
        {
            if let Some(kind) = kind_of(&comm, &cmdline) {
                return Ok(Some((next, kind)));
            }
        }
        for child in read(&format!("/proc/{next}/task/{next}/children"))?.split_whitespace() {
            queue.push_back(child.parse::<u32>().map_err(|_| invalid_process())?);
        }
    }
    Ok(None)
}

pub fn screen_state(
    lines: &[String],
    current: bool,
    agent: &str,
    resume_paused: bool,
    inspect_composer: bool,
) -> &'static str {
    if !current {
        return "unknown";
    }
    let text = lines.join("\n");
    if matches!(
        r"(?i)Resuming session|Starting (?:session|MCP)|Connecting to .*server|Reconnecting[.…]",
        &text
    ) {
        return "unknown";
    }
    if matches!(
        r"(?i)Hooks need review|Review hooks|Trust all and continue",
        &text
    ) || matches!(
        r"(?i)(?:Would you like to run|Do you want to proceed|Do you trust|Allow this|Update available)[\s\S]*(?-u:\b)1\.\s*(?:Yes|Allow|Trust|Update)",
        &text
    ) || matches!(
        r"(?im)^\s*(?:You've hit your usage limit|Usage limit reached|Rate limit reached|Not signed in|Please sign in|Sign in to (?:Codex|Claude))(?-u:\b)",
        &text
    ) {
        return "approval";
    }
    if agent == "jcode" {
        return jcode_state(lines, inspect_composer);
    }
    if !inspect_composer
        && matches!(
            r"(?i)esc to interrupt|esc to cancel|ctrl.c to interrupt|Messages to be submitted|tab to queue",
            &text
        )
    {
        return "busy";
    }
    if matches!(
        r"(?im)^\s*(?:GPT-\S+[^\n]*\s)?Goal (?:budget|usage)(?-u:\b)",
        &text
    ) {
        return "limited";
    }
    if matches!(r"(?im)^\s*(?:GPT-\S+[^\n]*\s)?Goal blocked(?-u:\b)", &text) {
        return "goal-blocked";
    }
    if !resume_paused && matches!(r"(?im)^\s*(?:GPT-\S+[^\n]*\s)?Goal paused(?-u:\b)", &text) {
        return "paused";
    }
    if !inspect_composer
        && matches!(
            r"(?im)^\s*(?:[•■]\s*)?(?:Conversation interrupted|Turn interrupted|Interrupted · What should)",
            &text
        )
    {
        return "interrupted";
    }
    let prompt = lines.iter().rposition(|line| matches!(r"^\s*[›❯>]", line));
    let last = prompt.map(|i| lines[i].trim()).unwrap_or("");
    let footer = &lines[prompt.map_or(0, |i| i + 1)..];
    if agent == "claude" {
        if !inspect_composer
            && lines
                .iter()
                .any(|line| matches!(r"^\s*[✢✳✶✻✽*]\s+.+…", line))
        {
            return "busy";
        }
        let known = footer.iter().all(|line| line.trim().is_empty()
            || matches!(r"^\s*─+\s*$|^\s*⏵⏵ (?:auto mode on|accept edits on)(?-u:\b)|^\s*\? for shortcuts\s*$", line));
        return if matches!(r"^[❯>]\s*$", last) && known {
            "idle"
        } else {
            "unknown"
        };
    }
    if footer.iter().any(|line| !line.trim().is_empty()
        && !matches!(r"(?i)^\s*(?:GPT-\S+|[←]?\s*for agents(?-u:\b)|\? for shortcuts(?-u:\b)|[0-9]+% context left(?-u:\b))", line)) { return "unknown"; }
    if agent == "codex" && matches!(r"^›\s*(?:Ask Codex to do anything)?$", last) {
        "idle"
    } else {
        "unknown"
    }
}

// Display observations can ignore historical prompts; input authorization stays conservative.
pub fn display_state(lines: &[String], current: bool, agent: &str) -> &'static str {
    let strict = screen_state(lines, current, agent, false, false);
    if !current || !["codex", "claude"].contains(&agent) { return strict; }
    let Some(composer) = lines.iter().rposition(|line| matches!(r"^\s*[›❯>]\s*(?:Ask Codex to do anything)?\s*$",line)) else { return strict; };
    if screen_state(&lines[composer..], true, agent, false, false) != "idle" { return strict; }
    let nearby = &lines[composer.saturating_sub(8)..composer];
    if nearby.iter().any(|line| matches!(r"^\s*[•◦]\s*Working\s*\([^\n]*esc to interrupt|^\s*[✢✳✶✻✽*]\s+.+…",line)) { return "busy"; }
    // Codex queues follow-ups only while a turn runs, and a long queue pushes the Working line above this window.
    if agent == "codex" && nearby.iter().any(|line| matches!(r"(?i)edit last queued message", line)) { return "busy"; }
    if ["busy", "approval", "unknown"].contains(&strict) { "idle" } else { strict }
}

pub fn resume_composer(lines: &[String], agent: &str) -> bool {
    if agent != "codex" || screen_state(lines, true, agent, false, false) != "paused" {
        return false;
    }
    let Some(index) = lines.iter().rposition(|line| matches!(r"^\s*[›❯>]", line)) else {
        return false;
    };
    if !matches!(r"^\s*›\s*/goal resume\s*$", &lines[index]) {
        return false;
    }
    let mut empty = lines.to_vec();
    empty[index] = "›".into();
    screen_state(&empty, true, agent, true, false) == "idle"
}

fn jcode_state(lines: &[String], inspect_composer: bool) -> &'static str {
    let mut content: Vec<_> = lines
        .iter()
        .map(|line| line.trim())
        .filter(|line| !line.is_empty())
        .collect();
    if matches!(
        r"^(?:~(?:/\S*)?|/\S+)\s+(?:(?:[A-Za-z0-9_./…-]+|[~?↑↓±][0-9]+|[▱▰]+)\s+)*[0-9]+%\s+(?:OAuth\s+)?(?:(?:Claude\s+)?(?:Opus|Sonnet|Haiku)\s+[0-9.]+|(?:OpenAI\s+)?GPT-[A-Za-z0-9.]+(?:\s+[A-Za-z0-9.]+)?)\s+(?:low|medium|high|xhigh|max)$",
        content.last().copied().unwrap_or("")
    ) {
        content.pop();
    }
    let last = content.last().copied().unwrap_or("");
    let busy = matches!(r"^[0-9]+…", last);
    if busy && !inspect_composer {
        return "busy";
    }
    if lines.iter().any(|line| {
        matches!(
            r"(?i)invalid_request_error|last request failed|Press Ctrl\+Y|permission required|Enter select\s*·\s*Esc cancel",
            line
        )
    }) {
        return "unknown";
    }
    if matches!(
        r"^[0-9]+[>…]\s*(?:(?:[0-9.]+[kKmM]?/[0-9.]+[kKmM]?\s+[▱▰]+\s+[0-9]+%)|[\u{f0318}\u{f059f}])?\s*$",
        last
    ) {
        "idle"
    } else if busy {
        "busy"
    } else {
        "unknown"
    }
}

pub fn clean_screen(raw: &str, max: usize) -> (Vec<String>, bool) {
    static ANSI: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[()][0-9A-B]|[\r\x00-\x08\x0b\x0c\x0e-\x1f]").unwrap()
    });
    let clean = ANSI.replace_all(raw, "");
    let mut lines = Vec::new();
    for line in clean.split('\n').map(str::trim_end) {
        if !matches!(r"^[\s■⬝▀▄█░▒▓⠀-⠿◦•·│┃┌┐└┘├┤┬┴┼─═]*$", line)
            && lines.last().map(String::as_str) != Some(line)
        {
            lines.push(line.to_owned());
        }
    }
    let excess = lines.len().saturating_sub(max.clamp(1, 500));
    lines.drain(..excess);
    (lines, excess > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_uses_live_composer_without_relaxing_input_authorization() {
        for lines in [
            vec!["Would you like to run this command?", "1. Yes", "2. No", "›", "? for shortcuts"],
            vec!["old output: esc to interrupt", "›", "? for shortcuts"],
            vec!["Starting MCP server", "›", "? for shortcuts"],
        ] {
            let lines: Vec<String> = lines.into_iter().map(String::from).collect();
            assert_ne!(screen_state(&lines, true, "codex", false, false), "idle");
            assert_eq!(display_state(&lines, true, "codex"), "idle");
            assert_eq!(display_state(&lines, false, "codex"), "unknown");
        }
        for (lines, expected) in [
            (vec!["• Working (3s • esc to interrupt)", "›", "? for shortcuts"], "busy"),
            (
                vec![
                    "• Working (19m 17s • esc to interrupt)",
                    "  ↳ 첫 번째 대기 지시",
                    "    이어지는 줄",
                    "    …",
                    "  ↳ 두 번째 대기 지시",
                    "    이어지는 줄",
                    "    이어지는 줄",
                    "    …",
                    "    shift+← edit last queued message",
                    "› Ask Codex to do anything",
                    "  GPT-6.1-Sol xhigh fast · ~/project",
                ],
                "busy",
            ),
            (vec!["  Worked for 4m 21s • 17:13", "› Ask Codex to do anything", "? for shortcuts"], "idle"),
            (vec!["Would you like to run this command?", "› 1. Yes", "2. No"], "approval"),
            (vec!["› draft text", "? for shortcuts"], "unknown"),
        ] {
            assert_eq!(display_state(&lines.into_iter().map(String::from).collect::<Vec<_>>(), true, "codex"), expected);
        }
    }
    #[test]
    fn screen_states_match_shared_node_contract() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../tests/fixtures/rust-activity.json")).unwrap();
        for (index, case) in cases.as_array().unwrap().iter().enumerate() {
            let lines: Vec<String> = case["lines"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().into())
                .collect();
            assert_eq!(
                screen_state(
                    &lines,
                    case["current"] != false,
                    case["agent"].as_str().unwrap(),
                    case["resumePaused"] == true,
                    case["inspectComposer"] == true
                ),
                case["expected"].as_str().unwrap(),
                "fixture {index}: {lines:?}"
            );
        }
    }
    #[test]
    fn process_identity_requires_foreground_and_executable_not_argument() {
        for program in ["vim", "cat", "less", "tail", "rg"] {
            assert_eq!(kind_of(program, &format!("{program}\0codex\0")), None);
        }
        assert_eq!(kind_of("MainThread", "node\0/opt/codex\0"), Some("codex"));
        assert_eq!(
            kind_of("jcode-linux-x86", "/opt/jcode-linux-x86_64.bin\0"),
            Some("jcode")
        );
        let read = |path: &str| -> io::Result<String> {
            Ok(match path {
                "/proc/10/stat" => "10 (shell with spaces) S 1 10 10 1 12",
                "/proc/10/comm" => "bash",
                "/proc/10/cmdline" => "bash\0",
                "/proc/10/task/10/children" => "11 12",
                "/proc/11/stat" => "11 (codex) S 10 11 10 1 12",
                "/proc/11/comm" => "codex",
                "/proc/11/cmdline" => "codex\0",
                "/proc/11/task/11/children" => "",
                "/proc/12/stat" => "12 (vim) S 10 12 10 1 12",
                "/proc/12/comm" => "vim",
                "/proc/12/cmdline" => "vim\0codex\0",
                "/proc/12/task/12/children" => "",
                _ => return Err(invalid_process()),
            }
            .into())
        };
        assert_eq!(detect_with(10, read).unwrap(), None);
        let active = |path: &str| {
            read(path).map(|s| {
                if path == "/proc/10/stat" {
                    s.replace("1 12", "1 11")
                } else {
                    s
                }
            })
        };
        assert_eq!(detect_with(10, active).unwrap(), Some("codex"));
        for state in ["T", "t", "Z", "X"] {
            assert_eq!(
                detect_with(10, |path| active(path).map(
                    |s| if path == "/proc/11/stat" {
                        s.replace(") S", &format!(") {state}"))
                    } else {
                        s
                    }
                ))
                .unwrap(),
                None
            );
        }
        assert!(detect_with(10, |_| Err(invalid_process())).is_err());
    }
}
