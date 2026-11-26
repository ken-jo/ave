mod recovery;

#[cfg(feature = "fixture")]
pub(crate) use recovery::NameIdentity;

use crate::pin::{child_name, components, redirects};
use crate::windows::*;
use recovery::*;
use std::ffi::c_void;
use std::ptr::null_mut;

type Arg = Vec<u16>;
type Outcome<T> = Result<T, u8>;

const COPY_CHUNK: usize = 1024 * 1024;
const SYNC_INTERVAL: usize = 16 * COPY_CHUNK;

#[derive(Clone, Copy)]
struct FileFailure {
    error: u32,
    native: Option<(i32, &'static str)>,
}

impl From<u32> for FileFailure {
    fn from(error: u32) -> Self {
        Self {
            error,
            native: None,
        }
    }
}

impl FileFailure {
    fn native(status: i32, operation: &'static str) -> Self {
        Self {
            error: unsafe { RtlNtStatusToDosError(status) },
            native: Some((status, operation)),
        }
    }
}

fn error_name(error: u32) -> &'static str {
    match error {
        2 | 3 => "ENOENT",
        5 => "EPERM",
        32 | 33 => "EBUSY",
        80 | 183 => "EEXIST",
        17 => "EXDEV",
        39 | 112 => "ENOSPC",
        223 => "EFBIG",
        145 => "ENOTEMPTY",
        267 => "ENOTDIR",
        336 => "EISDIR",
        8 | 14 => "ENOMEM",
        _ => "EUNKNOWN",
    }
}

fn say(line: &str) {
    let _ = emit(line);
}

fn done(line: &str) -> u8 {
    say(line);
    0
}

fn failed_with(failure: FileFailure, suffix: &str) -> u8 {
    say(&format!("failed {}{suffix}", error_name(failure.error)));
    if let Some((status, operation)) = failure.native {
        diagnose(&format!(
            "Windows error {} (NTSTATUS 0x{:08X}, {operation})",
            failure.error, status as u32
        ));
    } else {
        diagnose(&format!("Windows error {}", failure.error));
    }
    4
}

fn failed(failure: impl Into<FileFailure>) -> u8 {
    failed_with(failure.into(), "")
}

fn refused(what: &str) -> u8 {
    say(&format!("refused {what}"));
    3
}

fn proceed(step: &str) -> bool {
    say(step);
    let mut answer = [0];
    read(input(), &mut answer) == Ok(1) && answer[0] == b'c'
}

fn stop_requested() -> bool {
    let mut available = 0;
    unsafe {
        PeekNamedPipe(
            input(),
            null_mut(),
            0,
            null_mut(),
            &mut available,
            null_mut(),
        ) == 0
            || available != 0
    }
}

fn number(text: &[u16]) -> Option<u64> {
    if text.is_empty() || (text.len() > 1 && text[0] == 48) {
        return None;
    }
    text.iter().try_fold(0_u64, |value, &digit| {
        if !(48..=57).contains(&digit) {
            return None;
        }
        value.checked_mul(10)?.checked_add(u64::from(digit - 48))
    })
}

fn plain_name(text: &[u16]) -> bool {
    !text.is_empty()
        && text.len() <= 255
        && !text.iter().any(|unit| matches!(unit, 47 | 58 | 92))
        && text != [46]
        && text != [46, 46]
}

fn same_name(left: &[u16], right: &[u16]) -> bool {
    fn lower(unit: u16) -> u16 {
        if (65..=90).contains(&unit) {
            unit + 32
        } else {
            unit
        }
    }
    left.iter()
        .copied()
        .map(lower)
        .eq(right.iter().copied().map(lower))
}

fn open(
    directory: Raw,
    name: &[u16],
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
) -> Result<Handle, FileFailure> {
    open_relative(
        directory,
        name,
        access,
        share,
        disposition,
        options,
        null_mut(),
    )
    .map_err(|status| FileFailure::native(status, "NtCreateFile"))
}

fn hold_error(error: FileFailure, what: &str) -> u8 {
    if matches!(error.error, 2 | 3 | 5 | 267 | 123 | 53 | 67) {
        refused(what)
    } else {
        failed(error)
    }
}

struct HeldDirectory(Vec<Handle>);

impl HeldDirectory {
    fn raw(&self) -> Raw {
        self.0.last().unwrap().raw()
    }
}

fn hold(args: &[Arg], what: &str) -> Outcome<HeldDirectory> {
    let volume = number(&args[1]).ok_or(2_u8)?;
    let index = number(&args[2]).ok_or(2_u8)?;
    let names = components(&args[0]).ok_or(2_u8)?;
    let mut held: Vec<Handle> = Vec::with_capacity(names.len());
    for (position, component) in names.iter().enumerate() {
        let access = TRAVERSE
            | READ_ATTRIBUTES
            | if position + 1 == names.len() {
                READ_DATA
            } else {
                0
            };
        let share = SHARE_READ | SHARE_WRITE;
        let opened = if let Some(parent) = held.last() {
            open(
                parent.raw(),
                child_name(&names[position - 1], component),
                access,
                share,
                OPEN,
                DIRECTORY_FILE | BACKUP | OPEN_REPARSE,
            )
        } else {
            open_root(component, access | SYNCHRONIZE, share).map_err(FileFailure::from)
        }
        .map_err(|error| hold_error(error, what))?;
        let tag = tag(opened.raw()).map_err(failed)?;
        if tag.attributes & DIRECTORY == 0 || redirects(tag) {
            return Err(refused(what));
        }
        held.push(opened);
    }
    let held = HeldDirectory(held);
    let facts = legacy(held.raw()).map_err(failed)?;
    if u64::from(facts.volume) != volume || facts.index() != index {
        return Err(refused(what));
    }
    Ok(held)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum Entry {
    Absent,
    Ordinary,
    Other,
}

fn classify(directory: Raw, name: &[u16]) -> Result<Entry, FileFailure> {
    match open(
        directory,
        name,
        READ_ATTRIBUTES,
        SHARE_ALL,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(entry) => Ok(
            if tag(entry.raw())?.attributes & (DIRECTORY | REPARSE) == 0 {
                Entry::Ordinary
            } else {
                Entry::Other
            },
        ),
        Err(error) if error.error == 2 => Ok(Entry::Absent),
        Err(error) => Err(error),
    }
}

struct Options<'a>(Vec<(&'a str, &'a [u16])>);

impl<'a> Options<'a> {
    fn parse(mut args: &'a [Arg], valued: &[&'a str], flags: &[&'a str]) -> Option<Self> {
        let mut options = Self(Vec::new());
        while let Some((name, rest)) = args.split_first() {
            let (name, value, rest) =
                if let Some(name) = valued.iter().find(|value| eq(name, value)) {
                    let (value, rest) = rest.split_first()?;
                    (*name, value.as_slice(), rest)
                } else {
                    (*flags.iter().find(|value| eq(name, value))?, &[][..], rest)
                };
            if options.get(name).is_some() {
                return None;
            }
            options.0.push((name, value));
            args = rest;
        }
        Some(options)
    }

    fn get(&self, name: &str) -> Option<&'a [u16]> {
        self.0
            .iter()
            .find_map(|(key, value)| (*key == name).then_some(*value))
    }
}

fn open_source(directory: Raw, name: &[u16], access: u32, options: u32) -> Outcome<Handle> {
    open(directory, name, access, SHARE_READ, OPEN, options).map_err(|error| {
        if error.error == 2 {
            refused("source")
        } else {
            failed(error)
        }
    })
}

fn rename_download(args: &[Arg]) -> Outcome<u8> {
    let (name, target) = (&args[3], &args[7]);
    if !plain_name(name) || !plain_name(target) {
        return Err(2);
    }
    let options = Options::parse(&args[8..], &["--expect"], &[]).ok_or(2_u8)?;
    let expected = options.get("--expect").and_then(parse_token).ok_or(2_u8)?;
    let from = hold(&args[..3], "from")?;
    let to = hold(&args[4..7], "to")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let source = open_source(from.raw(), name, DELETE | READ_ATTRIBUTES, OPEN_REPARSE)?;
    if !matches_stamp(source.raw(), &expected) {
        return Err(refused("source"));
    }
    match classify(to.raw(), target).map_err(failed)? {
        Entry::Other => return Err(refused("target")),
        Entry::Ordinary => return Ok(done("replace")),
        Entry::Absent => {}
    }
    match move_entry(from.raw(), name, &source, &expected, to.raw(), target) {
        Ok(stamp) => say(&format!("published {}", token_text(stamp.id, stamp.birth))),
        Err(error) if matches!(error.error, 80 | 183) => return Err(refused("target")),
        Err(error) if error.error == 17 => return Ok(done("cross-volume")),
        Err(error) => return Err(failed(error)),
    }
    Ok(done("committed"))
}

struct CopyTarget<'a> {
    directory: Raw,
    target: &'a [u16],
    aside: &'a [u16],
    old: Option<Handle>,
    stamp: ExpectedFile,
}

impl CopyTarget<'_> {
    fn report_left(&self, retiring: bool) {
        let verified = check_name(
            self.directory,
            self.aside,
            self.stamp.id,
            self.stamp.birth,
            false,
        ) == NameIdentity::Matches;
        let snapshot = self
            .old
            .as_ref()
            .filter(|_| verified)
            .map_or_else(|| "-".into(), |old| snapshot(old.raw(), self.stamp.id));
        say(&format!(
            "target-left left {} {} {} {snapshot}",
            String::from_utf16_lossy(self.aside),
            token_text(self.stamp.id, self.stamp.birth),
            if retiring {
                "remove-failed"
            } else {
                "mismatch"
            }
        ));
        #[cfg(feature = "fixture")]
        crate::faults::stop_replacement("leftover");
    }

    fn restore(&mut self) {
        if self.old.is_none() {
            return;
        }
        #[cfg(feature = "fixture")]
        if crate::faults::fail_replacement_rename(true) {
            self.report_left(false);
            return;
        }
        if self.move_old(self.aside, self.target).is_err() {
            self.report_left(false);
        } else {
            say("target-restored");
        }
    }

    fn move_old(&mut self, from: &[u16], to: &[u16]) -> Result<(), FileFailure> {
        self.stamp = move_entry(
            self.directory,
            from,
            self.old.as_ref().unwrap(),
            &self.stamp,
            self.directory,
            to,
        )?;
        Ok(())
    }
}

fn copy_bytes(source: Raw, target: Raw) -> Result<bool, FileFailure> {
    let mut buffer = vec![0; COPY_CHUNK];
    let (mut copied, mut unsynced) = (0_u64, 0);
    loop {
        if stop_requested() {
            return Ok(false);
        }
        let count = read(source, &mut buffer)?;
        if count == 0 {
            break;
        }
        write_all(target, &buffer[..count])?;
        copied += count as u64;
        unsynced += count;
        if unsynced >= SYNC_INTERVAL {
            flush(target)?;
            unsynced = 0;
        }
        say(&format!("progress {copied}"));
    }
    flush(target)?;
    Ok(true)
}

fn copy(args: &[Arg]) -> Outcome<u8> {
    let (name, target, part_name, aside) = (&args[3], &args[7], &args[8], &args[9]);
    if !plain_name(name)
        || !plain_name(target)
        || !plain_name(part_name)
        || !hidden_name(aside)
        || same_name(part_name, target)
        || same_name(aside, target)
        || same_name(aside, part_name)
    {
        return Err(2);
    }
    let from = hold(&args[..3], "from")?;
    let to = hold(&args[4..7], "to")?;
    let directory = to.raw();
    match volume_kind(directory) {
        VolumeKind::FileIds => {}
        VolumeKind::Unknown => return Err(refused("volume-unknown")),
        VolumeKind::NoFileIds => return Err(refused("volume")),
    }
    let source = open_source(
        from.raw(),
        name,
        READ_DATA | READ_ATTRIBUTES,
        OPEN_REPARSE | SEQUENTIAL,
    )?;
    let attributes = tag(source.raw()).map_err(failed)?.attributes;
    if attributes & (DIRECTORY | REPARSE) != 0 {
        return Err(refused("source"));
    }
    let mut previous = open(
        directory,
        target,
        READ_DATA | READ_ATTRIBUTES | DELETE,
        SHARE_READ,
        OPEN,
        OPEN_REPARSE,
    );
    if previous.as_ref().is_err_and(|error| error.error == 5) {
        previous = open(
            directory,
            target,
            READ_ATTRIBUTES | DELETE,
            SHARE_READ,
            OPEN,
            OPEN_REPARSE,
        );
    }
    let old = match previous {
        Ok(entry) => Some(entry),
        Err(error) if missing(error.error) => None,
        Err(error) => return Err(failed(error)),
    };
    let old_id = if let Some(entry) = &old {
        if !ordinary(entry.raw()) {
            return Err(refused("target"));
        }
        read_id(entry.raw()).map_err(|_| refused("target"))?
    } else {
        FileId::default()
    };
    let dest = stamp(directory).ok_or_else(|| refused("to"))?;
    say(&format!(
        "destination-id {}",
        token_text(dest.id, dest.birth)
    ));
    let mut old_stamp = ExpectedFile {
        id: old_id,
        ..ExpectedFile::default()
    };
    if let Some(entry) = &old {
        if old_id.volume != dest.id.volume {
            return Err(refused("target"));
        }
        old_stamp.birth = birth(entry.raw()).ok_or_else(|| refused("target"))?;
        say(&format!(
            "target-id {}",
            token_text(old_id, old_stamp.birth)
        ));
    }
    let replacing = old.is_some();
    let mut target_entry = CopyTarget {
        directory,
        target,
        aside,
        old,
        stamp: old_stamp,
    };
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let part = match open(
        directory,
        part_name,
        READ_DATA | WRITE_DATA | READ_ATTRIBUTES | DELETE,
        SHARE_READ,
        CREATE,
        NOT_DIRECTORY | OPEN_REPARSE | SEQUENTIAL,
    ) {
        Ok(part) => part,
        Err(error)
            if error.error == 5
                && classify(directory, part_name).is_ok_and(|entry| entry != Entry::Absent) =>
        {
            return Err(failed(80));
        }
        Err(error) => return Err(failed(error)),
    };
    let Some(written) = stamp(part.raw()).filter(|written| {
        written.id.volume == dest.id.volume && (!replacing || written.id != old_id)
    }) else {
        return Err(failed_with(50.into(), " left"));
    };
    say(&format!(
        "writing {}",
        token_text(written.id, written.birth)
    ));
    match copy_bytes(source.raw(), part.raw()) {
        Ok(true) => {}
        Ok(false) => {
            return Ok(stopped_copy(
                directory, part_name, part, &written, None, false,
            ));
        }
        Err(error) => {
            return Ok(stopped_copy(
                directory,
                part_name,
                part,
                &written,
                Some(error),
                false,
            ));
        }
    }
    let Some(final_stamp) =
        stamp(part.raw()).filter(|found| found.id == written.id && found.birth == written.birth)
    else {
        return Ok(stopped_copy(
            directory,
            part_name,
            part,
            &written,
            Some(50.into()),
            false,
        ));
    };
    if replacing {
        say(&format!(
            "copy-id {}",
            token_text(written.id, written.birth)
        ));
    }
    if !proceed("copied") {
        return Ok(stopped_copy(
            directory, part_name, part, &written, None, false,
        ));
    }
    match check_name(directory, part_name, written.id, final_stamp.birth, false) {
        NameIdentity::Absent => return Err(refused("target removed")),
        NameIdentity::Unverified => return Err(refused("target left")),
        NameIdentity::Matches => {}
    }
    if replacing {
        #[cfg(feature = "fixture")]
        crate::faults::stop_replacement("before-move");
        if target_entry.move_old(target, aside).is_err() {
            return Err(stopped_copy(
                directory,
                part_name,
                part,
                &final_stamp,
                None,
                true,
            ));
        }
        if check_name(directory, aside, old_id, target_entry.stamp.birth, false)
            != NameIdentity::Matches
        {
            target_entry.restore();
            return Err(stopped_copy(
                directory,
                part_name,
                part,
                &final_stamp,
                None,
                true,
            ));
        }
        #[cfg(feature = "fixture")]
        crate::faults::stop_replacement("after-move");
    }
    #[cfg(feature = "fixture")]
    let force_failure = replacing && crate::faults::fail_replacement_rename(false);
    #[cfg(not(feature = "fixture"))]
    let force_failure = false;
    let renamed = if force_failure {
        Err(29.into())
    } else {
        move_entry(directory, part_name, &part, &final_stamp, directory, target)
    };
    let published = match renamed {
        Ok(stamp) => stamp,
        Err(error) => {
            target_entry.restore();
            let entry = classify(directory, target).unwrap_or(Entry::Absent);
            let reject = (!replacing && entry != Entry::Absent)
                || matches!(error.error, 80 | 183 | 50 | 1 | 87);
            return Ok(stopped_copy(
                directory,
                part_name,
                part,
                &final_stamp,
                (!reject).then_some(error),
                reject,
            ));
        }
    };
    let checked = check_name(directory, target, written.id, published.birth, false);
    #[cfg(feature = "fixture")]
    let checked = crate::faults::commit_result(checked);
    if checked != NameIdentity::Matches {
        let rolled_back = move_entry(directory, target, &part, &published, directory, part_name);
        target_entry.restore();
        return Err(refused(if rolled_back.is_ok() {
            "target left"
        } else {
            "target changed"
        }));
    }
    say(&format!(
        "published {}",
        token_text(published.id, published.birth)
    ));
    if replacing {
        #[cfg(feature = "fixture")]
        crate::faults::stop_replacement("after-commit");
        if retire_checked(
            directory,
            aside,
            &mut target_entry.old,
            &target_entry.stamp,
            false,
            None,
        )
        .is_err()
        {
            // Preserve the available evidence if the retired name still exists.
            target_entry.report_left(true);
        } else {
            say("target-retired");
        }
    }
    Ok(done("committed"))
}

fn remove_entry(directory: Raw, name: &[u16], expected: &ExpectedFile) -> Outcome<Option<bool>> {
    let entry = match open(
        directory,
        name,
        DELETE | READ_ATTRIBUTES,
        SHARE_READ,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(entry) => entry,
        Err(error) if error.error == 2 => return Ok(None),
        Err(error) => return Err(failed(error)),
    };
    let tag = tag(entry.raw()).map_err(failed)?;
    if tag.attributes & DIRECTORY != 0 && tag.attributes & REPARSE == 0 {
        return Err(failed(336));
    }
    if expected.birth == 0
        || stamp(entry.raw())
            .is_none_or(|found| found.id != expected.id || found.birth != expected.birth)
    {
        return Ok(Some(false));
    }
    remove_checked(directory, name, entry, expected, true, None).map_err(failed)?;
    Ok(Some(true))
}

fn remove_download(args: &[Arg]) -> Outcome<u8> {
    let name = &args[3];
    if !plain_name(name) || record_name(name) {
        return Err(2);
    }
    let options = Options::parse(&args[4..], &["--expect"], &[]).ok_or(2_u8)?;
    let expected = options.get("--expect").and_then(parse_token).ok_or(2_u8)?;
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    match remove_entry(directory.raw(), name, &expected)? {
        Some(true) => Ok(done("removed")),
        Some(false) => Err(refused("source")),
        None => Ok(done("absent")),
    }
}

fn stamp_name(args: &[Arg]) -> Outcome<u8> {
    let name = &args[3];
    if !plain_name(name) || record_name(name) {
        return Err(2);
    }
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let entry = match open(
        directory.raw(),
        name,
        READ_ATTRIBUTES,
        SHARE_READ,
        OPEN,
        OPEN_REPARSE,
    ) {
        Ok(entry) => entry,
        Err(error) if missing(error.error) => return Ok(done("absent")),
        Err(error) => return Err(failed(error)),
    };
    if !ordinary(entry.raw()) {
        return Err(refused("source"));
    }
    let stamp = stamp(entry.raw()).ok_or_else(|| refused("source"))?;
    Ok(done(&format!(
        "stamp {}",
        token_text(stamp.id, stamp.birth)
    )))
}

struct DirectoryEntry {
    name: Vec<u16>,
    attributes: u32,
    creation: i64,
    id: [u8; 16],
}

fn list(
    directory: Raw,
    extended: bool,
    mut visit: impl FnMut(DirectoryEntry) -> Result<(), FileFailure>,
) -> Result<(), FileFailure> {
    let mut buffer = vec![0_u64; 8192];
    for first in [true].into_iter().chain(std::iter::repeat(false)) {
        let class = match (extended, first) {
            (true, true) => 20,
            (true, false) => 19,
            (false, true) => 15,
            (false, false) => 14,
        };
        let result = check(unsafe {
            GetFileInformationByHandleEx(
                directory,
                class,
                buffer.as_mut_ptr().cast::<c_void>(),
                65536,
            )
        });
        match result {
            Err(18) => return Ok(()),
            Err(error) => return Err(error.into()),
            Ok(()) => {}
        }
        let mut bytes = unsafe { std::slice::from_raw_parts(buffer.as_ptr().cast::<u8>(), 65536) };
        let header = if extended { 88 } else { 68 };
        loop {
            if bytes.len() < header {
                return Err(13.into());
            }
            let dword = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
            let next = dword(0) as usize;
            let name_end = header + dword(60) as usize;
            let end = if next == 0 { bytes.len() } else { next };
            if end > bytes.len() || name_end > end || name_end % 2 != 0 {
                return Err(13.into());
            }
            let name = bytes[header..name_end]
                .chunks_exact(2)
                .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
                .collect();
            visit(DirectoryEntry {
                name,
                attributes: dword(56),
                creation: i64::from_le_bytes(bytes[8..16].try_into().unwrap()),
                id: if extended {
                    bytes[72..88].try_into().unwrap()
                } else {
                    [0; 16]
                },
            })?;
            if next == 0 {
                break;
            }
            bytes = &bytes[next..];
        }
    }
    unreachable!()
}

fn sweep(args: &[Arg]) -> Outcome<u8> {
    Options::parse(&args[3..], &[], &["--keep-records"]).ok_or(2_u8)?;
    let directory = hold(args, "from")?;
    if !proceed("ready") {
        return Ok(done("cancelled"));
    }
    let directory = directory.raw();
    let held = read_id(directory).map_err(|_| refused("from"))?;
    let mut staged = Vec::new();
    list(directory, true, |entry| {
        let directory_only = entry.attributes & DIRECTORY != 0 && entry.attributes & REPARSE == 0;
        if entry.name != [46]
            && entry.name != [46, 46]
            && !directory_only
            && !record_name(&entry.name)
        {
            let stamp = ExpectedFile {
                id: FileId {
                    volume: held.volume,
                    bytes: entry.id,
                },
                birth: time_ns(entry.creation).unwrap_or(0),
                content: None,
            };
            staged.push((entry.name, stamp));
        }
        Ok(())
    })
    .map_err(failed)?;
    let mut count = 0_u32;
    for (name, stamp) in staged {
        if remove_entry(directory, &name, &stamp)? == Some(true) {
            count += 1;
        }
    }
    Ok(done(&format!("swept {count}")))
}

pub fn run(mode: &str, args: &[Arg]) -> u8 {
    let count = args.len();
    let result = match mode {
        "--dir-rename" if count >= 8 => rename_download(args),
        "--dir-copy" if count == 10 => copy(args),
        "--dir-remove" if count >= 4 => remove_download(args),
        "--dir-stamp" if count == 4 => stamp_name(args),
        "--dir-sweep" if count >= 3 => sweep(args),
        "--dir-list-records" if count == 3 => list_records(args),
        "--dir-read" if count == 5 => record(args, RecordMode::Read),
        "--dir-write-record" if count == 5 => record(args, RecordMode::Write),
        "--dir-sweep-record" if count == 5 => record(args, RecordMode::Sweep),
        "--dir-remove-record" if count >= 4 => record(args, RecordMode::Remove),
        "--dir-remove-id" if count >= 4 => recover(args, RecoveryMode::Remove),
        "--dir-restore" if count >= 5 => recover(args, RecoveryMode::RestorePart),
        "--dir-restore-target" if count >= 5 => recover(args, RecoveryMode::RestoreTarget),
        _ => {
            diagnose("usage: ave-path-kind.exe --dir-<mode> <arguments>");
            Err(2)
        }
    };
    result.unwrap_or_else(|status| status)
}
