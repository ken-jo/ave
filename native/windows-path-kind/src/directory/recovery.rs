use super::*;
use crate::security::private_descriptor;

const RECORD_LIMIT: usize = 8192;
const DIGEST_SPAN: i64 = 64 * 1024;

#[link(name = "bcrypt")]
unsafe extern "system" {
    fn BCryptOpenAlgorithmProvider(
        out: *mut Raw,
        algorithm: *const u16,
        implementation: *const u16,
        flags: u32,
    ) -> i32;
    fn BCryptCloseAlgorithmProvider(algorithm: Raw, flags: u32) -> i32;
    fn BCryptHash(
        algorithm: Raw,
        secret: Raw,
        secret_size: u32,
        data: *const u8,
        len: u32,
        hash: *mut u8,
        hash_len: u32,
    ) -> i32;
}

struct Algorithm(Raw);

impl Drop for Algorithm {
    fn drop(&mut self) {
        unsafe {
            BCryptCloseAlgorithmProvider(self.0, 0);
        }
    }
}

pub(super) fn missing(error: u32) -> bool {
    matches!(error, 2 | 3)
}

pub(super) fn read_id(file: Raw) -> Result<FileId, u32> {
    let result = file_id(file);
    #[cfg(feature = "fixture")]
    let result = crate::faults::file_id_result(result);
    let id = result?;
    if id.bytes == [0; 16] {
        return Err(50);
    }
    Ok(id)
}

pub(super) fn ordinary(file: Raw) -> bool {
    tag(file).is_ok_and(|tag| tag.attributes & (DIRECTORY | REPARSE) == 0)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum NameIdentity {
    Absent,
    Matches,
    Unverified,
}

fn probe_name(
    directory: Raw,
    name: &[u16],
    id: FileId,
    wanted_birth: Option<u64>,
    allow_reparse: bool,
) -> NameIdentity {
    let entry = match open(
        directory,
        name,
        READ_ATTRIBUTES,
        SHARE_ALL,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(entry) => entry,
        Err(error) if missing(error.error) => return NameIdentity::Absent,
        Err(_) => return NameIdentity::Unverified,
    };
    if (allow_reparse || ordinary(entry.raw()))
        && read_id(entry.raw()).is_ok_and(|found| found == id)
        && wanted_birth.is_none_or(|wanted| birth(entry.raw()) == Some(wanted))
    {
        NameIdentity::Matches
    } else {
        NameIdentity::Unverified
    }
}

pub(super) fn check_name(
    directory: Raw,
    name: &[u16],
    id: FileId,
    birth: u64,
    allow_reparse: bool,
) -> NameIdentity {
    if birth == 0 {
        return NameIdentity::Unverified;
    }
    probe_name(directory, name, id, Some(birth), allow_reparse)
}

fn hash_bytes(bytes: &[u8]) -> Option<[u8; 32]> {
    let mut raw = null_mut();
    let sha256 = [83, 72, 65, 50, 53, 54, 0];
    if unsafe { BCryptOpenAlgorithmProvider(&mut raw, sha256.as_ptr(), std::ptr::null(), 0) } < 0 {
        return None;
    }
    let algorithm = Algorithm(raw);
    let mut hash = [0; 32];
    let status = unsafe {
        BCryptHash(
            algorithm.0,
            null_mut(),
            0,
            bytes.as_ptr(),
            bytes.len() as u32,
            hash.as_mut_ptr(),
            hash.len() as u32,
        )
    };
    (status >= 0).then_some(hash)
}

fn hash_span(file: Raw, offset: i64, byte_count: usize) -> Option<[u8; 32]> {
    seek(file, offset).ok()?;
    let mut bytes = vec![0; byte_count];
    read_exact(file, &mut bytes).ok()?;
    hash_bytes(&bytes)
}

pub(super) fn time_ns(ticks: i64) -> Option<u64> {
    u64::try_from(ticks).ok()?.checked_mul(100)
}

pub(super) enum VolumeKind {
    FileIds,
    NoFileIds,
    Unknown,
}

pub(super) fn volume_kind(file: Raw) -> VolumeKind {
    let flags = volume_flags(file);
    #[cfg(feature = "fixture")]
    let flags = crate::faults::volume_result(flags);
    match flags {
        Ok(flags) if flags & 0x01000000 != 0 => VolumeKind::FileIds,
        Ok(_) => VolumeKind::NoFileIds,
        Err(_) => VolumeKind::Unknown,
    }
}

pub(super) fn birth(file: Raw) -> Option<u64> {
    if !matches!(volume_kind(file), VolumeKind::FileIds) {
        return None;
    }
    time_ns(basic(file).ok()?.creation).filter(|value| *value != 0)
}

fn fingerprint(file: Raw, before: &Basic) -> Option<String> {
    let len = size(file).ok()?;
    if len < 0 {
        return None;
    }
    let mtime = time_ns(before.write)?;
    let span = len.min(DIGEST_SPAN);
    let head = hash_span(file, 0, span as usize)?;
    let tail = hash_span(file, len - span, span as usize)?;
    let after = basic(file).ok()?;
    if before.change != after.change || before.write != after.write || size(file).ok()? != len {
        return None;
    }
    Some(format!("{len}:{mtime}:{}:{}", hex(head), hex(tail)))
}

#[derive(Default)]
pub(super) struct ExpectedFile {
    pub(super) id: FileId,
    pub(super) birth: u64,
    pub(super) content: Option<String>,
}

pub(super) fn token_text(id: FileId, birth: u64) -> String {
    format!(
        "{}:{}:creation:{birth}",
        id.volume,
        hex(id.bytes.into_iter().rev())
    )
}

pub(super) fn parse_token(token: &[u16]) -> Option<ExpectedFile> {
    let mut fields = token.splitn(4, |unit| *unit == 58);
    let volume = number(fields.next()?)?;
    let mut bytes: [u8; 16] = decode_hex(fields.next()?, 16)?.try_into().ok()?;
    bytes.reverse();
    let evidence = fields.next()?;
    let value = fields.next()?;
    if evidence.is_empty()
        || !evidence.iter().all(|unit| (97..=122).contains(unit))
        || value.is_empty()
        || value.iter().any(|unit| matches!(unit, 9 | 32))
    {
        return None;
    }
    let birth = if eq(evidence, "creation") {
        number(value).filter(|value| *value != 0)?
    } else {
        0
    };
    Some(ExpectedFile {
        id: FileId { volume, bytes },
        birth,
        content: None,
    })
}

fn parse_content(body: &[u16]) -> Option<String> {
    let mut parts = body.split(|unit| *unit == 58);
    number(parts.next()?)?;
    number(parts.next()?)?;
    decode_hex(parts.next()?, 32)?;
    decode_hex(parts.next()?, 32)?;
    if parts.next().is_some() {
        return None;
    }
    String::from_utf16(body).ok()
}

pub(super) fn matches_stamp(file: Raw, expected: &ExpectedFile) -> bool {
    if expected.birth == 0
        || !ordinary(file)
        || read_id(file) != Ok(expected.id)
        || birth(file) != Some(expected.birth)
    {
        return false;
    }
    let Ok(basic) = basic(file) else {
        return false;
    };
    expected
        .content
        .as_ref()
        .is_none_or(|content| fingerprint(file, &basic).as_ref() == Some(content))
}

pub(super) fn stamp(file: Raw) -> Option<ExpectedFile> {
    Some(ExpectedFile {
        id: read_id(file).ok()?,
        birth: birth(file)?,
        content: None,
    })
}

fn verify_entry(
    directory: Raw,
    name: &[u16],
    file: Raw,
    expected: &ExpectedFile,
    allow_reparse: bool,
) -> Result<(), FileFailure> {
    if expected.birth == 0 {
        return Err(50.into());
    }
    if stamp(file).is_none_or(|found| found.id != expected.id || found.birth != expected.birth)
        || (!allow_reparse && !matches_stamp(file, expected))
        || check_name(directory, name, expected.id, expected.birth, allow_reparse)
            != NameIdentity::Matches
    {
        return Err(5.into());
    }
    Ok(())
}

pub(super) fn move_entry(
    directory: Raw,
    name: &[u16],
    entry: &Handle,
    expected: &ExpectedFile,
    destination: Raw,
    target: &[u16],
) -> Result<ExpectedFile, FileFailure> {
    verify_entry(directory, name, entry.raw(), expected, false)?;
    let operation = duplicate(entry.raw())?;
    #[repr(C)]
    struct IoStatus(usize, usize);
    #[link(name = "ntdll")]
    unsafe extern "system" {
        fn NtSetInformationFile(
            file: Raw,
            status: *mut IoStatus,
            data: Raw,
            len: u32,
            class: i32,
        ) -> i32;
    }
    // FILE_RENAME_INFO has its UTF-16 name at byte 20 on both supported targets.
    #[repr(C)]
    struct Rename {
        replace: u32,
        root: Raw,
        len: u32,
        name: [u16; 256],
    }
    let mut info = Rename {
        replace: 0,
        root: destination,
        len: (target.len() * 2) as u32,
        name: [0; 256],
    };
    info.name[..target.len()].copy_from_slice(target);
    let mut status = IoStatus(0, 0);
    let result = unsafe {
        NtSetInformationFile(
            operation.raw(),
            &mut status,
            (&mut info as *mut Rename).cast(),
            24 + info.len,
            10,
        )
    };
    if result < 0 {
        return Err(FileFailure::native(result, "NtSetInformationFile"));
    }
    operation.close()?;
    // The moved name can acquire a different creation time through filename tunnelling.
    if probe_name(destination, target, expected.id, None, false) != NameIdentity::Matches {
        return Err(5.into());
    }
    stamp(entry.raw())
        .filter(|moved| moved.id == expected.id)
        .ok_or_else(|| 5.into())
}

pub(super) fn remove_checked(
    directory: Raw,
    name: &[u16],
    entry: Handle,
    expected: &ExpectedFile,
    allow_reparse: bool,
    digest: Option<(usize, &[u8; 32])>,
) -> Result<(), FileFailure> {
    retire_checked(
        directory,
        name,
        &mut Some(entry),
        expected,
        allow_reparse,
        digest,
    )
}

pub(super) fn retire_checked(
    directory: Raw,
    name: &[u16],
    entry: &mut Option<Handle>,
    expected: &ExpectedFile,
    allow_reparse: bool,
    digest: Option<(usize, &[u8; 32])>,
) -> Result<(), FileFailure> {
    let file = entry.as_ref().unwrap().raw();
    verify_entry(directory, name, file, expected, allow_reparse)?;
    if let Some((length, digest)) = digest
        && (size(file) != Ok(length as i64) || hash_span(file, 0, length).as_ref() != Some(digest))
    {
        return Err(5.into());
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(
            handle: Raw,
            class: i32,
            value: *const c_void,
            len: u32,
        ) -> i32;
    }
    check(unsafe { SetFileInformationByHandle(file, 4, (&1_i32 as *const i32).cast(), 4) })?;
    entry.take().unwrap().close()?;
    if classify(directory, name)? == Entry::Absent {
        Ok(())
    } else {
        Err(5.into())
    }
}

pub(super) fn snapshot(file: Raw, id: FileId) -> String {
    let snapshot = || {
        let birth = birth(file)?;
        let content = fingerprint(file, &basic(file).ok()?)?;
        Some(format!("{}/{content}", token_text(id, birth)))
    };
    snapshot().unwrap_or_else(|| "-".into())
}

pub(super) fn hidden_name(name: &[u16]) -> bool {
    name.len() == 42
        && name[0] == 46
        && eq(&name[33..], ".removing")
        && decode_hex(&name[1..33], 16).is_some()
}

struct Retirement {
    original: NameIdentity,
    removed: bool,
    leftover: &'static str,
}

fn retire(directory: Raw, name: &[u16], file: Handle, expected: &ExpectedFile) -> Retirement {
    let original = check_name(directory, name, expected.id, expected.birth, false);
    let mut result = Retirement {
        original,
        removed: false,
        leftover: "left",
    };
    if original != NameIdentity::Matches {
        return result;
    }
    #[cfg(feature = "fixture")]
    if crate::faults::fail_remove() {
        return result;
    }
    // Retirement proves identity and creation again. A recorded content fingerprint was checked on entry.
    let stamp = ExpectedFile {
        id: expected.id,
        birth: expected.birth,
        content: None,
    };
    result.removed = remove_checked(directory, name, file, &stamp, false, None).is_ok();
    if !result.removed {
        result.leftover = "left remove-failed";
    }
    result
}

pub(super) fn stopped_copy(
    directory: Raw,
    name: &[u16],
    file: Handle,
    stamp: &ExpectedFile,
    failure: Option<FileFailure>,
    refused_commit: bool,
) -> u8 {
    let retired = retire(directory, name, file, stamp);
    let gone = retired.removed || retired.original == NameIdentity::Absent;
    let suffix = if gone {
        String::new()
    } else {
        format!(" {}", retired.leftover)
    };
    if refused_commit {
        if gone {
            refused("target removed")
        } else {
            refused(&format!("target{suffix}"))
        }
    } else if let Some(failure) = failure {
        failed_with(failure, &suffix)
    } else {
        done(&format!("cancelled{suffix}"))
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum RecoveryMode {
    Remove,
    RestorePart,
    RestoreTarget,
}

fn recover_target(
    directory: Raw,
    hidden: &[u16],
    target: &[u16],
    old: &ExpectedFile,
    retire_only: bool,
    writer: Option<&ExpectedFile>,
    writer_renamed: bool,
) -> u8 {
    let access = READ_ATTRIBUTES | if old.content.is_some() { READ_DATA } else { 0 };
    let mut published = None;
    let mut vacant = false;
    let mut committed = retire_only;
    if !retire_only {
        match open(directory, target, access, SHARE_READ, OPEN, OPEN_REPARSE) {
            Ok(entry) => {
                let file = entry.raw();
                committed = writer.is_some_and(|writer| {
                    if writer_renamed {
                        ordinary(file)
                            && read_id(file) == Ok(writer.id)
                            && probe_name(directory, target, writer.id, None, false)
                                == NameIdentity::Matches
                    } else {
                        matches_stamp(file, writer)
                            && check_name(directory, target, writer.id, writer.birth, false)
                                == NameIdentity::Matches
                    }
                });
                published = Some(entry);
            }
            Err(error) if missing(error.error) => vacant = true,
            Err(_) => return done("left"),
        }
    }
    let source = match open(
        directory,
        hidden,
        access | DELETE,
        SHARE_READ,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(file) => file,
        Err(error) if missing(error.error) => {
            let restored = published.as_ref().is_some_and(|file| {
                matches_stamp(file.raw(), old)
                    && check_name(directory, target, old.id, old.birth, false)
                        == NameIdentity::Matches
            });
            return done(if committed || restored {
                "resolved"
            } else {
                "left"
            });
        }
        Err(_) => return done("left"),
    };
    if !matches_stamp(source.raw(), old)
        || check_name(directory, hidden, old.id, old.birth, false) != NameIdentity::Matches
    {
        return done("left");
    }
    let restored = if committed {
        remove_checked(directory, hidden, source, old, false, None).is_ok()
    } else {
        vacant && move_entry(directory, hidden, &source, old, directory, target).is_ok()
    };
    done(if restored { "resolved" } else { "left" })
}

fn restore_part(
    directory: Raw,
    name: &[u16],
    part_name: &[u16],
    source: Handle,
    expected: &ExpectedFile,
) -> Option<&'static str> {
    let target = open(
        directory,
        part_name,
        WRITE_DATA | READ_ATTRIBUTES,
        0,
        CREATE,
        NOT_DIRECTORY | SEQUENTIAL,
    )
    .ok()?;
    let target_stamp = stamp(target.raw())?;
    seek(source.raw(), 0).ok()?;
    let mut buffer = vec![0; COPY_CHUNK];
    loop {
        let count = read(source.raw(), &mut buffer).ok()?;
        if count == 0 {
            break;
        }
        let written = write_all(target.raw(), &buffer[..count]);
        #[cfg(feature = "fixture")]
        let written = crate::faults::restore_write_result(written);
        written.ok()?;
    }
    // Keep both names if the copied part cannot be verified before retirement.
    flush(target.raw()).ok()?;
    if check_name(
        directory,
        part_name,
        target_stamp.id,
        target_stamp.birth,
        false,
    ) != NameIdentity::Matches
    {
        return None;
    }
    let removed = retire(directory, name, source, expected);
    Some(if removed.removed {
        "restored"
    } else {
        removed.leftover
    })
}

pub(super) fn recover(args: &[Arg], mode: RecoveryMode) -> Outcome<u8> {
    let restoring = mode != RecoveryMode::Remove;
    let name = &args[3];
    let part_name = if restoring {
        args[4].as_slice()
    } else {
        &[][..]
    };
    if !plain_name(name)
        || (restoring && (!plain_name(part_name) || same_name(name, part_name)))
        || (mode == RecoveryMode::RestoreTarget && !hidden_name(name))
    {
        return Err(2);
    }
    let options = Options::parse(
        &args[if restoring { 5 } else { 4 }..],
        &["--expect", "--content", "--writer", "--renamed-writer"],
        &["--retire"],
    )
    .ok_or(2_u8)?;
    let content = options.get("--content");
    let full_writer = options.get("--writer");
    let renamed_writer = options.get("--renamed-writer");
    let writer_token = full_writer.or(renamed_writer);
    let retire_only = options.get("--retire").is_some();
    if (full_writer.is_some() && renamed_writer.is_some())
        || (mode == RecoveryMode::RestorePart && content.is_none())
        || (mode != RecoveryMode::RestoreTarget && (writer_token.is_some() || retire_only))
        || (writer_token.is_some() && retire_only)
    {
        return Err(2);
    }
    let mut expected = options.get("--expect").and_then(parse_token).ok_or(2_u8)?;
    if let Some(content) = content {
        expected.content = Some(parse_content(content).ok_or(2_u8)?);
    }
    let writer = if let Some(writer) = writer_token {
        Some(
            parse_token(writer)
                .filter(|writer| writer.id != expected.id && writer.id.volume == expected.id.volume)
                .ok_or(2_u8)?,
        )
    } else {
        None
    };
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let directory = directory.raw();
    if mode == RecoveryMode::RestoreTarget {
        return Ok(recover_target(
            directory,
            name,
            part_name,
            &expected,
            retire_only,
            writer.as_ref(),
            renamed_writer.is_some(),
        ));
    }
    let source = match open(
        directory,
        name,
        READ_DATA | READ_ATTRIBUTES | DELETE,
        SHARE_READ,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(source) => source,
        Err(error) => {
            return Ok(done(if missing(error.error) {
                "absent"
            } else {
                "left"
            }));
        }
    };
    if !matches_stamp(source.raw(), &expected) {
        return Ok(done("left"));
    }
    if restoring {
        return Ok(done(
            restore_part(directory, name, part_name, source, &expected).unwrap_or("left"),
        ));
    }
    let retired = retire(directory, name, source, &expected);
    Ok(done(if retired.removed {
        "removed"
    } else if retired.original == NameIdentity::Absent {
        "absent"
    } else {
        retired.leftover
    }))
}

pub(super) fn record_name(name: &[u16]) -> bool {
    name.len() == 45 && eq(&name[32..], ".cleanup.json") && decode_hex(&name[..32], 16).is_some()
}

pub(super) fn list_records(args: &[Arg]) -> Outcome<u8> {
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let mut outcome = String::from("records");
    list(directory.raw(), false, |entry| {
        if record_name(&entry.name) {
            if outcome.len() + 47 > 1024 * 1024 {
                return Err(223.into());
            }
            outcome.push(' ');
            outcome.extend(entry.name.into_iter().map(|unit| char::from(unit as u8)));
        }
        Ok(())
    })
    .map_err(failed)?;
    Ok(done(&outcome))
}

fn create_record(directory: Raw, name: &[u16], bytes: &[u8]) -> Result<ExpectedFile, FileFailure> {
    let security = private_descriptor("FA")?;
    let entry = open_relative(
        directory,
        name,
        READ_DATA | WRITE_DATA | READ_ATTRIBUTES,
        0,
        CREATE,
        NOT_DIRECTORY,
        security.0,
    )
    .map_err(|status| FileFailure::native(status, "NtCreateFile"))?;
    write_all(entry.raw(), bytes)?;
    flush(entry.raw())?;
    let stamp = stamp(entry.raw()).ok_or(29)?;
    let digest = hash_bytes(bytes).ok_or(29)?;
    if size(entry.raw()) != Ok(bytes.len() as i64)
        || hash_span(entry.raw(), 0, bytes.len()) != Some(digest)
    {
        return Err(29.into());
    }
    entry.close()?;
    if check_name(directory, name, stamp.id, stamp.birth, false) != NameIdentity::Matches {
        return Err(29.into());
    }
    Ok(stamp)
}

#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum RecordMode {
    Read,
    Write,
    Remove,
    Sweep,
}

pub(super) fn record(args: &[Arg], mode: RecordMode) -> Outcome<u8> {
    let name = &args[3];
    if !record_name(name) {
        return Err(2);
    }
    let mut write_bytes = None;
    let mut removal = None;
    let limit = match mode {
        RecordMode::Write => {
            let length = args[4].len() / 2;
            if length > RECORD_LIMIT {
                return Err(2);
            }
            write_bytes = Some(decode_hex(&args[4], length).ok_or(2_u8)?);
            length
        }
        RecordMode::Remove => {
            let options = Options::parse(&args[4..], &["--expect", "--length", "--digest"], &[])
                .ok_or(2_u8)?;
            let stamp = options
                .get("--expect")
                .and_then(parse_token)
                .filter(|stamp| stamp.birth != 0)
                .ok_or(2_u8)?;
            let length = options
                .get("--length")
                .and_then(number)
                .filter(|length| *length <= RECORD_LIMIT as u64)
                .ok_or(2_u8)?;
            let digest = options
                .get("--digest")
                .and_then(|text| decode_hex(text, 32))
                .ok_or(2_u8)?;
            removal = Some((stamp, <[u8; 32]>::try_from(digest).unwrap()));
            length as usize
        }
        _ => number(&args[4])
            .filter(|limit| (1..=RECORD_LIMIT as u64).contains(limit))
            .ok_or(2_u8)? as usize,
    };
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let directory = directory.raw();
    if let Some(bytes) = write_bytes {
        let stamp = create_record(directory, name, &bytes).map_err(failed)?;
        return Ok(done(&format!(
            "written {}",
            token_text(stamp.id, stamp.birth)
        )));
    }
    let access = READ_DATA | READ_ATTRIBUTES | if mode != RecordMode::Read { DELETE } else { 0 };
    let entry = match open(directory, name, access, SHARE_READ, OPEN, OPEN_REPARSE) {
        Ok(file) => file,
        Err(error) if missing(error.error) => return Ok(done("absent")),
        Err(error) => return Err(failed(error)),
    };
    if !ordinary(entry.raw()) {
        return Ok(done("absent"));
    }
    if let Some((stamp, digest)) = removal {
        return Ok(done(
            if remove_checked(
                directory,
                name,
                entry,
                &stamp,
                false,
                Some((limit, &digest)),
            )
            .is_ok()
            {
                "removed"
            } else {
                "kept"
            },
        ));
    }
    let sweep_stamp = if mode == RecordMode::Sweep {
        let Some(stamp) = stamp(entry.raw()) else {
            return Ok(done("absent"));
        };
        Some(stamp)
    } else {
        None
    };
    let mut bytes = vec![0; limit + 1];
    let mut used = 0;
    while used <= limit {
        let count = read(entry.raw(), &mut bytes[used..]).map_err(failed)?;
        if count == 0 {
            break;
        }
        used += count;
    }
    if used > limit {
        return Err(failed(223));
    }
    bytes.truncate(used);
    if let Some(stamp) = sweep_stamp {
        let Some(digest) = hash_bytes(&bytes) else {
            return Ok(done("absent"));
        };
        let frame = format!(
            "record {} {}",
            token_text(stamp.id, stamp.birth),
            hex(bytes)
        );
        if !proceed(&frame) {
            return Ok(done("kept"));
        }
        Ok(done(
            if remove_checked(directory, name, entry, &stamp, false, Some((used, &digest))).is_ok()
            {
                "removed"
            } else {
                "kept"
            },
        ))
    } else {
        Ok(done(&format!("record {}", hex(bytes))))
    }
}
