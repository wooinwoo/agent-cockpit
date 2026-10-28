use serde_json::{
    value::{to_raw_value, RawValue},
    Value,
};
use std::collections::BTreeMap;

// Preserve JavaScript UTF-16 strings and fields from newer state versions.
pub type Object = BTreeMap<String, Box<RawValue>>;

pub(crate) fn raw(value: Value) -> Box<RawValue> {
    to_raw_value(&value).expect("JSON value")
}

// RawValue has already checked JSON syntax. Decode only its string token into
// UTF-16 code units; Rust's String cannot represent JavaScript's lone surrogates.
pub(crate) fn units(value: &RawValue) -> Option<Vec<u16>> {
    let text = value.get();
    let text = text.strip_prefix('"')?.strip_suffix('"')?;
    let mut result = Vec::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let escaped = chars.next()?;
            if escaped == 'u' {
                let mut unit = 0u16;
                for _ in 0..4 {
                    unit = (unit << 4) | chars.next()?.to_digit(16)? as u16;
                }
                result.push(unit);
                continue;
            }
            result.push(match escaped {
                '"' => 34,
                '\\' => 92,
                '/' => 47,
                'b' => 8,
                'f' => 12,
                'n' => 10,
                'r' => 13,
                't' => 9,
                _ => return None,
            });
        } else {
            result.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
        }
    }
    Some(result)
}

pub(crate) fn string(units: &[u16]) -> Box<RawValue> {
    let mut encoded = String::from("\"");
    let mut segment = String::new();
    fn flush(encoded: &mut String, segment: &mut String) {
        let escaped = serde_json::to_string(segment).expect("UTF-8 segment");
        encoded.push_str(&escaped[1..escaped.len() - 1]);
        segment.clear();
    }
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok(c) => segment.push(c),
            Err(error) => {
                flush(&mut encoded, &mut segment);
                encoded.push_str(&format!("\\u{:04x}", error.unpaired_surrogate()));
            }
        }
    }
    flush(&mut encoded, &mut segment);
    encoded.push('"');
    RawValue::from_string(encoded).expect("Encoded JSON string")
}

pub(crate) fn slice(value: &RawValue, limit: usize) -> Option<Box<RawValue>> {
    let mut units = units(value)?;
    units.truncate(limit);
    Some(string(&units))
}

pub(crate) fn blank(value: &RawValue) -> bool {
    units(value).unwrap_or_default().iter().all(|c| matches!(*c,
        0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff))
}

pub(crate) fn truthy(value: &RawValue) -> bool {
    match value.get() {
        "null" | "false" | "\"\"" => false,
        text => text.parse::<f64>() != Ok(0.0),
    }
}
