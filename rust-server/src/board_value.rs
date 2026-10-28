use crate::json_values;
use serde_json::{json, value::RawValue};
use std::{
    collections::BTreeMap,
    ops::{Index, IndexMut},
};

// Board strings follow the existing JavaScript UTF-16 contract, including lone
// surrogates left by historical slice limits. Rust String would lose that data.
#[derive(Clone, Debug, PartialEq)]
pub enum V {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<V>),
    Object(BTreeMap<String, V>),
}
static NULL: V = V::Null;
impl V {
    pub fn parse(raw: &RawValue) -> serde_json::Result<Self> {
        Self::parse_depth(raw, 0)
    }
    fn parse_depth(raw: &RawValue, depth: usize) -> serde_json::Result<Self> {
        // RawValue validates syntax without serde_json's normal recursion limit.
        // Bound the tree before cloning, normalization, or serialization recurse.
        if depth >= 128 {
            return Err(serde_json::Error::io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "Board JSON nesting exceeds 128 levels",
            )));
        }
        let text = raw.get();
        Ok(match text.as_bytes().first() {
            Some(b'{') => Self::Object(
                serde_json::from_str::<json_values::Object>(text)?
                    .into_iter()
                    .map(|(k, v)| Ok((k, Self::parse_depth(&v, depth + 1)?)))
                    .collect::<serde_json::Result<_>>()?,
            ),
            Some(b'[') => Self::Array(
                serde_json::from_str::<Vec<Box<RawValue>>>(text)?
                    .iter()
                    .map(|v| Self::parse_depth(v, depth + 1))
                    .collect::<serde_json::Result<_>>()?,
            ),
            Some(b'"') => Self::String(json_values::units(raw).expect("validated JSON string")),
            Some(b't') => Self::Bool(true),
            Some(b'f') => Self::Bool(false),
            Some(b'n') => Self::Null,
            _ => Self::Number(text.parse().unwrap_or(f64::NAN)),
        })
    }
    pub fn raw(&self) -> Box<RawValue> {
        match self {
            Self::String(units) => json_values::string(units),
            Self::Array(items) => {
                serde_json::value::to_raw_value(&items.iter().map(Self::raw).collect::<Vec<_>>())
                    .unwrap()
            }
            Self::Object(items) => serde_json::value::to_raw_value(
                &items
                    .iter()
                    .map(|(k, v)| (k, v.raw()))
                    .collect::<BTreeMap<_, _>>(),
            )
            .unwrap(),
            Self::Null => json_values::raw(json!(null)),
            Self::Bool(v) => json_values::raw(json!(v)),
            Self::Number(n) => json_values::raw(json!(n)),
        }
    }
    pub fn object() -> Self {
        Self::Object(BTreeMap::new())
    }
    pub fn object_clone(&self) -> Self {
        if matches!(self, Self::Object(_)) {
            self.clone()
        } else {
            Self::object()
        }
    }
    pub fn has(&self, key: &str) -> bool {
        matches!(self,Self::Object(o) if o.contains_key(key))
    }
    pub fn remove(&mut self, key: &str) {
        if let Self::Object(o) = self {
            o.remove(key);
        }
    }
    pub fn array(&self) -> &[V] {
        if let Self::Array(a) = self {
            a
        } else {
            &[]
        }
    }
    pub fn array_mut(&mut self) -> &mut Vec<V> {
        if !matches!(self, Self::Array(_)) {
            *self = Self::Array(Vec::new());
        }
        let Self::Array(a) = self else { unreachable!() };
        a
    }
    pub fn is_string(&self) -> bool {
        matches!(self, Self::String(_))
    }
    pub fn is_array(&self) -> bool {
        matches!(self, Self::Array(_))
    }
    pub fn is_integer(&self) -> bool {
        matches!(self,Self::Number(n) if n.is_finite() && n.fract()==0.0)
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Bool(v) => *v,
            Self::Number(n) => *n != 0.0 && !n.is_nan(),
            Self::String(s) => !s.is_empty(),
            _ => true,
        }
    }
    pub fn text(&self) -> String {
        match self {
            Self::String(s) => String::from_utf16_lossy(s),
            Self::Null => "null".into(),
            Self::Bool(b) => b.to_string(),
            Self::Number(n) => n.to_string(),
            Self::Array(a) => a
                .iter()
                .map(|v| {
                    if *v == Self::Null {
                        String::new()
                    } else {
                        v.text()
                    }
                })
                .collect::<Vec<_>>()
                .join(","),
            Self::Object(_) => "[object Object]".into(),
        }
    }
    pub fn units(&self) -> &[u16] {
        if let Self::String(s) = self {
            s
        } else {
            &[]
        }
    }
    pub fn cut(&self, limit: usize) -> Self {
        Self::String(self.units().iter().take(limit).copied().collect())
    }
    pub fn trim(&self) -> Self {
        let space = |c: &u16| matches!(*c,0x0009..=0x000d|0x0020|0x00a0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff);
        let s = self.units();
        let start = s.iter().position(|c| !space(c)).unwrap_or(s.len());
        let end = s.iter().rposition(|c| !space(c)).map_or(start, |i| i + 1);
        Self::String(s[start..end].to_vec())
    }
    pub fn number(&self) -> f64 {
        match self {
            Self::Null => 0.0,
            Self::Bool(b) => {
                if *b {
                    1.0
                } else {
                    0.0
                }
            }
            Self::Number(n) => *n,
            Self::Object(_) => f64::NAN,
            _ => {
                let text = if self.is_string() {
                    self.trim().text()
                } else {
                    self.text()
                };
                if text.is_empty() {
                    return 0.0;
                }
                for (prefix, radix) in [
                    ("0x", 16),
                    ("0X", 16),
                    ("0b", 2),
                    ("0B", 2),
                    ("0o", 8),
                    ("0O", 8),
                ] {
                    if let Some(t) = text.strip_prefix(prefix) {
                        return u64::from_str_radix(t, radix)
                            .map(|v| v as f64)
                            .unwrap_or(f64::NAN);
                    }
                }
                text.parse().unwrap_or(f64::NAN)
            }
        }
    }
    pub fn number_or(&self, default: f64) -> f64 {
        let n = self.number();
        if n.is_nan() || n == 0.0 {
            default
        } else {
            n
        }
    }
}
impl Index<&str> for V {
    type Output = V;
    fn index(&self, key: &str) -> &V {
        if let Self::Object(o) = self {
            o.get(key).unwrap_or(&NULL)
        } else {
            &NULL
        }
    }
}
impl IndexMut<&str> for V {
    fn index_mut(&mut self, key: &str) -> &mut V {
        if !matches!(self, Self::Object(_)) {
            *self = Self::object();
        }
        let Self::Object(o) = self else {
            unreachable!()
        };
        o.entry(key.into()).or_insert(V::Null)
    }
}
impl From<&str> for V {
    fn from(s: &str) -> Self {
        Self::String(s.encode_utf16().collect())
    }
}
impl From<String> for V {
    fn from(s: String) -> Self {
        Self::from(s.as_str())
    }
}
impl From<f64> for V {
    fn from(n: f64) -> Self {
        Self::Number(n)
    }
}
impl From<bool> for V {
    fn from(b: bool) -> Self {
        Self::Bool(b)
    }
}
pub fn object<const N: usize>(fields: [(&str, V); N]) -> V {
    V::Object(fields.into_iter().map(|(k, v)| (k.into(), v)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn utf16_and_unknown_nested_values_roundtrip() {
        let raw = RawValue::from_string(
            r#"{"text":"한😀\ud800","nested":[true,null,0,{"x":"\udc00"}]}"#.into(),
        )
        .unwrap();
        let value = V::parse(&raw).unwrap();
        assert_eq!(V::parse(&value.raw()).unwrap(), value);
        assert_eq!(value["text"].cut(2).raw().get(), r#""한\ud83d""#);
        assert_eq!(V::from("\u{feff}  제목 \u{a0}").trim(), V::from("제목"));
    }

    #[test]
    fn deeply_nested_json_is_rejected_before_recursive_board_processing() {
        let raw =
            RawValue::from_string(format!("{}0{}", "[".repeat(130), "]".repeat(130))).unwrap();
        assert!(V::parse(&raw).is_err());
    }
}
