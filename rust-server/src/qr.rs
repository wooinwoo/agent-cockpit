//! Standard byte-mode QR rendering with the original SVG scale and quiet zone.
use crate::board_value::V;
use qrcodegen::{QrCode, QrCodeEcc, QrSegment, Version};
use std::fmt::Write;

const TOO_LONG: &str = "QR data exceeds 271 UTF-8 bytes";

fn byte(value: &V) -> Result<u8, String> {
    // Buffer.from(array) applies JavaScript ToNumber and then ToUint8.
    if matches!(value, V::Object(_) if value.has("toString")) {
        return Err("Cannot convert object to primitive value".into());
    }
    let number = value.number();
    Ok(if number.is_finite() {
        number.trunc().rem_euclid(256.0) as u8
    } else {
        0
    })
}

fn bytes(text: &V) -> Result<Vec<u8>, String> {
    match text {
        // Node replaces each unpaired UTF-16 surrogate with U+FFFD.
        V::String(units) => Ok(String::from_utf16_lossy(units).into_bytes()),
        V::Array(values) => values.iter().map(byte).collect(),
        V::Object(_) if text.has("length") => {
            let length = match text["length"] {
                V::Number(n) if n > 0.0 => n.trunc(),
                _ => 0.0,
            };
            if length > 271.0 {
                return Err(TOO_LONG.into());
            }
            (0..length as usize)
                .map(|i| byte(&text[&i.to_string()]))
                .collect()
        }
        V::Object(_) if text["type"] == V::from("Buffer") && text["data"].is_array() => {
            text["data"].array().iter().map(byte).collect()
        }
        _ => {
            let received = match text {
                V::Null => "null".into(),
                V::Bool(v) => format!("type boolean ({v})"),
                V::Number(n) => format!("type number ({n})"),
                _ => "an instance of Object".into(),
            };
            Err(format!("The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object. Received {received}"))
        }
    }
}

/// Render byte mode with ECC-L, versions 1–10, scale 6 and a four-module quiet zone.
/// Standard format/version bits and interleaved error correction replace the old
/// renderer's invalid matrices. Inputs above 271 encoded bytes are rejected.
pub fn svg(text: &V) -> Result<String, String> {
    let bytes = bytes(text)?;
    if bytes.len() > 271 {
        return Err(TOO_LONG.into());
    }
    let code = QrCode::encode_segments_advanced(
        &[QrSegment::make_bytes(&bytes)],
        QrCodeEcc::Low,
        Version::new(1),
        Version::new(10),
        None,
        false,
    )
    .map_err(|_| TOO_LONG.to_string())?;
    let total = (code.size() + 8) * 6;
    let mut output = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {total} {total}\" width=\"{total}\" height=\"{total}\"><rect width=\"{total}\" height=\"{total}\" fill=\"#fff\"/><g fill=\"#000\">");
    for y in 0..code.size() {
        for x in 0..code.size() {
            if code.get_module(x, y) {
                write!(
                    output,
                    "<rect x=\"{}\" y=\"{}\" width=\"6\" height=\"6\"/>",
                    (x + 4) * 6,
                    (y + 4) * 6
                )
                .unwrap();
            }
        }
    }
    output.push_str("</g></svg>");
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board_value::object;

    fn view_box(svg: &str) -> &str {
        svg.split("viewBox=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap()
    }

    // Read the rendered SVG's rectangles, not the encoder's module grid. This
    // catches rendering, quiet-zone, scale and matrix defects in one independent
    // scanner. Only synthetic fixture payloads are used.
    fn scan(svg: &str) -> Vec<u8> {
        let dimensions: Vec<usize> = view_box(svg)
            .split(' ')
            .map(|v| v.parse().unwrap())
            .collect();
        assert_eq!(&dimensions[..2], &[0, 0]);
        let width = dimensions[2];
        let height = dimensions[3];
        assert_eq!(width, height);
        assert!(svg.contains(&format!(
            "<rect width=\"{width}\" height=\"{height}\" fill=\"#fff\"/>"
        )));
        assert!(svg.contains("<g fill=\"#000\">"));
        let attribute = |rect: &str, name: &str| -> usize {
            rect.split(&format!("{name}=\""))
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .parse()
                .unwrap()
        };
        let mut pixels = vec![255; width * height];
        for rect in svg
            .split("<rect ")
            .skip(1)
            .filter(|rect| rect.starts_with("x="))
        {
            let x = attribute(rect, "x");
            let y = attribute(rect, "y");
            let w = attribute(rect, "width");
            let h = attribute(rect, "height");
            assert_eq!((w, h), (6, 6));
            assert!(x >= 24 && y >= 24 && x + w <= width - 24 && y + h <= height - 24);
            assert_eq!((x % 6, y % 6), (0, 0));
            for row in y..y + h {
                pixels[row * width + x..row * width + x + w].fill(0);
            }
        }
        let mut scanner = quircs::Quirc::default();
        let codes: Vec<_> = scanner.identify(width, height, &pixels).collect();
        assert_eq!(codes.len(), 1, "one QR must be detected in rendered SVG");
        let code = codes.into_iter().next().unwrap().expect("QR extraction");
        code.decode().expect("independent QR decoding").payload
    }

    #[test]
    fn source_fixtures_decode_payloads_and_document_matrix_corrections() {
        let raw = serde_json::value::RawValue::from_string(
            include_str!("../../tests/fixtures/rust-qr.json").into(),
        )
        .unwrap();
        let fixtures = V::parse(&raw).unwrap();
        assert_eq!(fixtures.array().len(), 375);
        for (index, fixture) in fixtures.array().iter().enumerate() {
            let actual = svg(&fixture["input"]["text"]);
            if fixture["expected"].has("error") {
                assert_eq!(
                    object([("error", actual.unwrap_err().into())]),
                    fixture["expected"],
                    "QR fixture {index}"
                );
            } else {
                let rendered = actual.unwrap();
                assert_eq!(
                    V::from(view_box(&rendered)),
                    fixture["expected"]["viewBox"],
                    "QR dimensions {index}"
                );
                let payload = scan(&rendered);
                let hex: String = payload.iter().map(|value| format!("{value:02x}")).collect();
                assert_eq!(
                    V::from(hex),
                    fixture["expected"]["payloadHex"],
                    "QR decoded payload {index}"
                );
                assert!(fixture["correction"]["original"].has("svgSha256"));
            }
        }
    }

    #[test]
    fn default_margin_scale_and_text_escaping_are_preserved() {
        let output = svg(&"<script>".into()).unwrap();
        assert!(output.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 174 174\" width=\"174\" height=\"174\"><rect width=\"174\" height=\"174\" fill=\"#fff\"/><g fill=\"#000\">"));
        assert!(output.ends_with("</g></svg>"));
        assert!(!output.contains("<script>"));
        for part in output.split("<rect x=\"").skip(1) {
            let x: usize = part.split('"').next().unwrap().parse().unwrap();
            let y: usize = part
                .split(" y=\"")
                .nth(1)
                .unwrap()
                .split('"')
                .next()
                .unwrap()
                .parse()
                .unwrap();
            assert!((24..=144).contains(&x) && x % 6 == 0);
            assert!((24..=144).contains(&y) && y % 6 == 0);
        }
    }

    #[test]
    fn capacity_is_utf8_bytes_and_unpaired_surrogates_use_replacement() {
        assert!(svg(&"a".repeat(271).into()).is_ok());
        assert_eq!(svg(&"a".repeat(272).into()).unwrap_err(), TOO_LONG);
        assert!(svg(&"가".repeat(90).into()).is_ok());
        assert_eq!(svg(&"가".repeat(91).into()).unwrap_err(), TOO_LONG);
        assert_eq!(
            svg(&V::String(vec![0xd800])).unwrap(),
            svg(&"�".into()).unwrap()
        );
        assert_eq!(
            svg(&V::String(vec![0xd83d, 0xde00])).unwrap(),
            svg(&"😀".into()).unwrap()
        );
    }
}
