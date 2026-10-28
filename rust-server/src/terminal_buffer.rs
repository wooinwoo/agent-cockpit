use std::collections::VecDeque;

#[derive(Default)]
pub struct Decoder {
    bytes: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.bytes.extend_from_slice(bytes);
        let mut decoded = String::new();
        loop {
            match std::str::from_utf8(&self.bytes) {
                Ok(text) => {
                    decoded.push_str(text);
                    self.bytes.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    decoded.push_str(std::str::from_utf8(&self.bytes[..valid]).unwrap());
                    if let Some(invalid) = error.error_len() {
                        decoded.push('\u{fffd}');
                        self.bytes.drain(..valid + invalid);
                    } else {
                        self.bytes.drain(..valid);
                        break;
                    }
                }
            }
        }
        decoded
    }
}

#[derive(Default)]
pub struct Replay {
    chunks: VecDeque<(String, usize)>,
    length: usize,
    trimmed: bool,
    escape: String,
    clipboard: bool,
    clipboard_escape: bool,
}
impl Replay {
    pub fn push(&mut self, text: &str) {
        let mut clean = String::new();
        for c in text.chars() {
            if self.clipboard {
                if c == '\u{7}' || (self.clipboard_escape && c == '\\') {
                    self.clipboard = false;
                    self.clipboard_escape = false;
                } else {
                    self.clipboard_escape = c == '\u{1b}';
                }
                continue;
            }
            if !self.escape.is_empty() || c == '\u{1b}' {
                self.escape.push(c);
                while !self.escape.is_empty() && !"\u{1b}]52;".starts_with(&self.escape) {
                    let c = self.escape.remove(0);
                    clean.push(c);
                }
                if self.escape == "\u{1b}]52;" {
                    self.escape.clear();
                    self.clipboard = true;
                }
            } else {
                clean.push(c);
            }
        }
        if clean.is_empty() {
            return;
        }
        let length = clean.encode_utf16().count();
        self.chunks.push_back((clean, length));
        self.length += length;
        while self.length > 50_000 && self.chunks.len() > 1 {
            self.length -= self.chunks.pop_front().unwrap().1;
            self.trimmed = true;
        }
    }
    pub fn read(&self) -> String {
        let mut result: String = self.chunks.iter().map(|(text, _)| text.as_str()).collect();
        if self.trimmed {
            if let Some(index) = result.find('\n').filter(|index| *index < 4096) {
                result.drain(..=index);
            }
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn split_utf8_and_clipboard_sequences_preserve_display_without_replay() {
        let text = "한😀글\u{1b}[31m색\u{1b}[0m";
        let mut decoder = Decoder::default();
        let mut output = String::new();
        for byte in text.as_bytes() {
            output.push_str(&decoder.push(&[*byte]));
        }
        assert_eq!(output, text);
        for terminator in ["\u{7}", "\u{1b}\\"] {
            let mut replay = Replay::default();
            let text = format!("before\u{1b}]52;c;private{terminator}after\u{1b}[31m색");
            for c in text.chars() {
                replay.push(&c.to_string());
            }
            assert_eq!(replay.read(), "beforeafter\u{1b}[31m색");
        }
    }
}
