use crate::pin::{Facts, pin, verify};
use crate::security::{self, Descriptor};
use crate::windows::*;
use std::fmt::Write;
use std::io::Read;

const MAX_FRAME: usize = 1024 * 1024;
const MAX_PATHS: usize = 2048;
const MAX_REPLY: usize = 8 * 1024 * 1024;
const MAX_CONTENT: i64 = 1024 * 1024;

fn parse_frame(input: &mut impl Read) -> Option<Vec<Vec<u16>>> {
    fn length(input: &mut impl Read) -> Option<usize> {
        let mut bytes = [0; 4];
        input.read_exact(&mut bytes).ok()?;
        Some(u32::from_le_bytes(bytes) as usize)
    }
    let size = length(input)?;
    if !(4..=MAX_FRAME).contains(&size) {
        return None;
    }
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).ok()?;
    if input.read(&mut [0]).ok()? != 0 {
        return None;
    }
    let mut body = bytes.as_slice();
    let count = length(&mut body)?;
    if !(1..=MAX_PATHS).contains(&count) {
        return None;
    }
    let mut paths = Vec::with_capacity(count);
    for _ in 0..count {
        let size = length(&mut body)?;
        if size == 0 {
            return None;
        }
        let (bytes, tail) = body.split_at_checked(size)?;
        let path: Vec<_> = std::str::from_utf8(bytes).ok()?.encode_utf16().collect();
        if path.len() >= 32768 || path.contains(&0) {
            return None;
        }
        paths.push(path);
        body = tail;
    }
    body.is_empty().then_some(paths)
}

fn json(text: &[u16]) -> String {
    let Ok(text) = String::from_utf16(text) else {
        return "null".into();
    };
    let mut output = String::from("\"");
    for ch in text.chars() {
        match ch {
            '"' | '\\' => {
                output.push('\\');
                output.push(ch);
            }
            '\0'..='\u{1f}' => {
                write!(output, "\\u{:04x}", ch as u32).unwrap();
            }
            _ => output.push(ch),
        }
    }
    output.push('"');
    output
}

fn optional_json(text: &[u16]) -> String {
    if text.is_empty() {
        "null".into()
    } else {
        json(text)
    }
}

fn identity(id: FileId) -> String {
    format!(
        r#""volumeSerial":"0x{:016x}","fileId":"0x{}""#,
        id.volume,
        hex(id.bytes.into_iter().rev())
    )
}

fn facts_json(facts: &Facts) -> String {
    if facts.exists != Some(true) {
        let exists = if facts.exists == Some(false) {
            "false"
        } else {
            "null"
        };
        return format!(
            r#"{{"exists":{exists},"canonical":null,"volumeSerial":null,"fileId":null,"volumeSerialNumber":null,"fileIndex":null,"fileSystemName":null,"changeTime":null,"attributes":0,"reparseTag":0,"reparseTarget":null,"directory":false}}"#
        );
    }
    format!(
        r#"{{"exists":true,"canonical":{},{},"volumeSerialNumber":"0x{:016x}","fileIndex":"0x{:016x}","fileSystemName":{},"changeTime":"0x{:016x}","attributes":{},"reparseTag":{},"reparseTarget":{},"directory":{}}}"#,
        json(&facts.canonical),
        identity(facts.id),
        facts.legacy.volume,
        facts.legacy.index(),
        optional_json(&facts.filesystem),
        facts.change as u64,
        facts.tag.attributes,
        facts.tag.reparse,
        optional_json(&facts.target),
        facts.tag.attributes & DIRECTORY != 0
    )
}

fn descriptor_json(handle: Raw, facts: &Facts) -> Option<String> {
    let security = Descriptor::read(handle)?;
    let owner = json(&security::sid_text(security.owner).ok()?);
    let mut output = format!(r#"{{"identity":{{{}}},"owner":{owner}"#, identity(facts.id));
    if !security.group.is_null() {
        write!(
            output,
            r#","group":{}"#,
            json(&security::sid_text(security.group).ok()?)
        )
        .unwrap();
    }
    write!(
        output,
        r#","protected":{},"nullDacl":{},"aces":["#,
        security.control & security::SE_DACL_PROTECTED != 0,
        security.null_dacl()
    )
    .unwrap();
    for (index, ace) in security.aces().enumerate() {
        let ace = ace?;
        let mask = ace.mask()?;
        let offset = match ace.kind() {
            0 | 1 => Some(8),
            5 | 6 => Some(12 + ace.object_flags()?.count_ones() as usize * 16),
            _ => None,
        };
        let (sid, account) = if let Some(offset) = offset {
            let sid = ace.sid(offset)?;
            (
                json(&security::sid_text(sid).ok()?),
                security::account_text(sid),
            )
        } else {
            ("null".into(), None)
        };
        if index != 0 {
            output.push(',');
        }
        write!(
            output,
            r#"{{"type":{},"flags":{},"mask":{mask},"sid":{sid}"#,
            ace.kind(),
            ace.flags()
        )
        .unwrap();
        if let Some(account) = account {
            write!(output, r#","account":{}"#, json(&account)).unwrap();
        }
        output.push('}');
    }
    output.push_str("]}");
    Some(output)
}

fn token_json() -> Option<String> {
    let token = security::context()?;
    let mut output = format!(
        r#","currentUserSid":{},"elevated":{},"principals":{{"#,
        json(&token.user),
        token.elevated
    );
    for (index, (sid, name)) in token.principals.iter().enumerate() {
        if index != 0 {
            output.push(',');
        }
        write!(output, r#"{}:"{name}""#, json(sid)).unwrap();
    }
    output.push('}');
    Some(output)
}

fn content_json(file: Raw) -> Result<String, u8> {
    let size = size(file).map_err(|_| 4_u8)?;
    if size < 0 {
        return Err(4);
    }
    if size > MAX_CONTENT {
        return Err(5);
    }
    let mut bytes = vec![0; size as usize];
    if !bytes.is_empty() && read(file, &mut bytes) != Ok(size as usize) {
        return Err(4);
    }
    Ok(format!("\"{}\"", hex(bytes)))
}

fn framed_row_fits(output_size: usize, row_size: usize, first: bool) -> bool {
    let punctuation = usize::from(!first) + 1;
    output_size + row_size + punctuation + STDOUT_LINE_ENDING.len() <= MAX_REPLY
}

fn batch(args: &[Vec<u16>], dacl: bool) -> Result<String, u8> {
    let (mut parent, mut content, mut framed) = (false, false, false);
    let mut operands = args;
    while let Some((flag, rest)) = operands.split_first() {
        if !flag.starts_with(&[45, 45]) {
            break;
        }
        if dacl && eq(flag, "--parent") {
            parent = true;
        } else if dacl && eq(flag, "--content") {
            content = true;
        } else if dacl && !framed && eq(flag, "--stdin") {
            framed = true;
        } else {
            return Err(2);
        }
        operands = rest;
    }
    let parsed;
    let paths = if framed {
        if !parent || content || !operands.is_empty() {
            return Err(2);
        }
        parsed = parse_frame(&mut std::io::stdin().lock()).ok_or(2_u8)?;
        &parsed[..]
    } else {
        if operands.is_empty() {
            return Err(2);
        }
        operands
    };
    let context = if dacl {
        token_json().ok_or(4_u8)?
    } else {
        String::new()
    };
    let mut output = String::from("[");
    for (index, path) in paths.iter().enumerate() {
        let first = index == 0;
        let pinned = pin(path, content).ok_or_else(|| {
            diagnose("could not read path facts");
            4_u8
        })?;
        let facts = pinned.facts.last().ok_or(4_u8)?;
        let mut row = facts_json(facts);
        row.pop();
        row.push_str(",\"ancestors\":[");
        for (position, ancestor) in pinned.facts[..pinned.facts.len() - 1].iter().enumerate() {
            if position != 0 {
                row.push(',');
            }
            row.push_str(&facts_json(ancestor));
            if framed && !framed_row_fits(output.len(), row.len(), first) {
                return Err(4);
            }
        }
        row.push(']');
        if dacl {
            row.push_str(&context);
            let mut bytes = "null".into();
            if facts.exists == Some(true) {
                let file = pinned.handles.last().ok_or(4_u8)?.raw();
                let descriptor = descriptor_json(file, facts).ok_or(4_u8)?;
                if content && facts.tag.attributes & REPARSE == 0 {
                    if facts.tag.attributes & DIRECTORY != 0 {
                        return Err(4);
                    }
                    bytes = content_json(file)?;
                }
                row.push(',');
                row.push_str(&descriptor[1..descriptor.len() - 1]);
            } else {
                row.push_str(",\"identity\":null");
            }
            if parent {
                row.push_str(",\"parent\":");
                let last = pinned.facts.len() - 1;
                if last > 0 && pinned.facts[last - 1].exists == Some(true) {
                    row.push_str(
                        &descriptor_json(pinned.handles[last - 1].raw(), &pinned.facts[last - 1])
                            .ok_or(4_u8)?,
                    );
                } else {
                    row.push_str("null");
                }
            }
            if content {
                write!(row, ",\"contentHex\":{bytes}").unwrap();
            }
        }
        if !verify(&pinned) {
            return Err(4);
        }
        if framed {
            write!(row, ",\"requestPath\":{}", json(path)).unwrap();
        }
        row.push('}');
        if framed && !framed_row_fits(output.len(), row.len(), first) {
            return Err(4);
        }
        if !first {
            output.push(',');
        }
        output.push_str(&row);
    }
    output.push(']');
    Ok(output)
}

pub fn run(args: &[Vec<u16>], dacl: bool) -> u8 {
    match batch(args, dacl) {
        Ok(output) => {
            if emit(&output).is_ok() {
                0
            } else {
                3
            }
        }
        Err(code) => code,
    }
}

fn ordinary(handle: Raw) -> Option<bool> {
    let tag = tag(handle).ok()?;
    (tag.attributes & REPARSE == 0).then_some(tag.attributes & DIRECTORY != 0)
}

fn leading_denies(handle: Raw, sid: Raw) -> Option<(u32, u32)> {
    let security = Descriptor::read(handle)?;
    let (mut mask, mut inheritable) = (0, 0);
    for ace in security.aces() {
        let ace = ace?;
        if ace.kind() != 1 || ace.flags() & 0x10 != 0 {
            break;
        }
        let trustee = ace.sid(8)?;
        if unsafe { security::EqualSid(sid, trustee) } == 0 || ace.flags() & 8 != 0 {
            continue;
        }
        mask |= ace.mask()?;
        if ace.flags() & 7 == 3 {
            inheritable |= ace.mask()?;
        }
    }
    Some((mask, inheritable))
}

fn deny_row(input: &[u16], sid: Raw) -> Option<String> {
    let pinned = pin(input, false)?;
    let mut directory = false;
    for handle in &pinned.handles {
        directory = ordinary(handle.raw())?;
    }
    let (deny, inherit, parent) = if pinned.facts.last()?.exists == Some(false) {
        directory = false;
        (0, 0, 0)
    } else {
        let [.., parent, target] = &pinned.handles[..] else {
            return None;
        };
        let (mask, inherit) = leading_denies(target.raw(), sid)?;
        let (parent, _) = leading_denies(parent.raw(), sid)?;
        for handle in &pinned.handles {
            ordinary(handle.raw())?;
        }
        (mask, inherit, parent)
    };
    Some(format!(
        r#"{{"denyMask":{deny},"inheritableMask":{inherit},"parentMask":{parent},"directory":{directory}}}"#
    ))
}

pub fn deny(args: &[Vec<u16>]) -> u8 {
    let Some(sid) = args
        .first()
        .filter(|_| args.len() >= 2)
        .and_then(|sid| security::parse_sid(sid))
    else {
        diagnose("invalid deny DACL request");
        return 2;
    };
    let mut out = String::from("[");
    for (index, path) in args[1..].iter().enumerate() {
        let Some(row) = deny_row(path, sid.0) else {
            diagnose("could not verify deny DACL handles");
            return 4;
        };
        if index != 0 {
            out.push(',');
        }
        out.push_str(&row);
    }
    out.push(']');
    if emit(&out).is_ok() { 0 } else { 3 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(path: &[u8]) -> Vec<u8> {
        let length = path.len() as u32;
        [
            (8 + length).to_le_bytes().as_slice(),
            &1_u32.to_le_bytes(),
            &length.to_le_bytes(),
            path,
        ]
        .concat()
    }

    #[test]
    fn frame_requires_valid_utf8_and_eof() {
        let valid = frame("D:\\é😀".as_bytes());
        assert_eq!(
            parse_frame(&mut valid.as_slice()),
            Some(vec![ascii("D:\\é😀")])
        );
        for bytes in [
            frame(&[0xc0, 0x80]),
            frame(b"a\0b"),
            valid[..valid.len() - 1].to_vec(),
            [valid, vec![0]].concat(),
        ] {
            assert!(parse_frame(&mut bytes.as_slice()).is_none());
        }
        assert!(parse_frame(&mut (MAX_FRAME as u32 + 1).to_le_bytes().as_slice()).is_none());
    }

    #[test]
    fn framed_reply_accepts_the_exact_wire_budget() {
        assert!(framed_row_fits(1, MAX_REPLY - 4, true));
        assert!(framed_row_fits(128, MAX_REPLY - 132, false));
    }

    #[test]
    fn framed_reply_rejects_the_first_byte_over_the_wire_budget() {
        assert!(!framed_row_fits(1, MAX_REPLY - 3, true));
        assert!(!framed_row_fits(128, MAX_REPLY - 131, false));
    }

    #[test]
    fn identity_and_wide_values_are_lossless() {
        let id = FileId {
            volume: u64::MAX,
            bytes: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
        };
        assert_eq!(
            identity(id),
            r#""volumeSerial":"0xffffffffffffffff","fileId":"0x02000000000000000000000000000001""#
        );
        assert_eq!(json(&[0xd800]), "null");
        assert_eq!(json(&ascii("é\\\n")), "\"é\\\\\\u000a\"");
    }
}
