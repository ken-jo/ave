use crate::facts::{MAX_REPLY, held_reply};
use crate::pin::{PinnedPath, hold, leaf_still_pinned};
use crate::windows::*;
use std::mem::size_of;
use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::thread;

const HELLO: [u8; 4] = *b"AVH2";
const RECHECK: [u8; 4] = *b"AVHQ";
const PROCESS_ADMISSION_ACCESS: u32 = 0x40 | 0x100 | 1 | SYNCHRONIZE;
const EVENT_MODIFY_STATE: u32 = 2;
const CLOSE_SOURCE: u32 = 1;
const KILL_ON_JOB_CLOSE: u32 = 0x2000;
const EXTENDED_LIMIT_INFORMATION: i32 = 9;
const INFINITE: u32 = u32::MAX;

#[repr(C)]
#[derive(Default)]
pub(super) struct StartupInfo {
    pub size: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    window: [u32; 8],
    show: u16,
    extra_size: u16,
    extra: *const u8,
    input: Raw,
    output: Raw,
    error: Raw,
}

#[repr(C)]
#[derive(Default)]
struct BasicJobLimits {
    process_time: i64,
    job_time: i64,
    flags: u32,
    minimum_working_set: usize,
    maximum_working_set: usize,
    active_processes: u32,
    affinity: usize,
    priority: u32,
    scheduling: u32,
}

#[repr(C)]
#[derive(Default)]
struct JobLimits {
    basic: BasicJobLimits,
    io_counters: [u64; 6],
    memory_limits: [usize; 4],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStartupInfoW(startup: *mut StartupInfo);
    fn CreateJobObjectW(security: *const SecurityAttributes, name: *const u16) -> Raw;
    fn SetInformationJobObject(job: Raw, class: i32, buffer: *const JobLimits, size: u32) -> i32;
    fn AssignProcessToJobObject(job: Raw, process: Raw) -> i32;
    pub(super) fn TerminateProcess(process: Raw, code: u32) -> i32;
}

struct HeldDirectory {
    job: Handle,
    channel: Handle,
    pinned: PinnedPath,
    leaf: Vec<u16>,
}

pub(super) struct Options {
    pub reply_limit: usize,
    pub recheck: fn(&PinnedPath, &[u16]) -> bool,
    pub on_input: fn(Raw, u8),
}

impl Default for Options {
    fn default() -> Self {
        Self {
            reply_limit: MAX_REPLY,
            recheck: leaf_still_pinned,
            on_input: |_, _| {},
        }
    }
}

// The startup block stores a count, that many flags, and that many handle values.
fn handle_value(extra: &[u8], fd: usize) -> Option<usize> {
    let header = size_of::<i32>();
    let width = size_of::<usize>();
    let count = usize::try_from(i32::from_le_bytes(extra.get(..header)?.try_into().ok()?)).ok()?;
    if fd >= count || header + count.checked_mul(1 + width)? > extra.len() {
        return None;
    }
    let start = header + count + fd * width;
    let value = usize::from_le_bytes(extra[start..start + width].try_into().ok()?);
    (value != 0 && value != usize::MAX).then_some(value)
}

fn hold_channel() -> Option<Handle> {
    let mut startup = StartupInfo::default();
    unsafe { GetStartupInfoW(&mut startup) };
    if startup.extra.is_null() {
        return None;
    }
    let extra =
        unsafe { std::slice::from_raw_parts(startup.extra, usize::from(startup.extra_size)) };
    unsafe { Handle::from_raw(handle_value(extra, 3)? as Raw).ok() }
}

fn create_job() -> Result<Handle, u32> {
    let job = unsafe { Handle::from_raw(CreateJobObjectW(null(), null())) }?;
    let limits = JobLimits {
        basic: BasicJobLimits {
            flags: KILL_ON_JOB_CLOSE,
            ..BasicJobLimits::default()
        },
        ..JobLimits::default()
    };
    check(unsafe {
        SetInformationJobObject(
            job.raw(),
            EXTENDED_LIMIT_INFORMATION,
            &limits,
            size_of::<JobLimits>() as u32,
        )
    })?;
    Ok(job)
}

fn read_frame(channel: Raw) -> Result<([u8; 4], u32), u32> {
    let mut bytes = [0; 8];
    read_exact(channel, &mut bytes)?;
    let (kind, value) = bytes.split_at(4);
    Ok((
        kind.try_into().unwrap(),
        u32::from_le_bytes(value.try_into().unwrap()),
    ))
}

fn reply_bytes(kind: u8, value: u64) -> [u8; 9] {
    let mut bytes = [0; 9];
    bytes[0] = kind;
    bytes[1..].copy_from_slice(&value.to_le_bytes());
    bytes
}

fn reply(channel: Raw, kind: u8, value: u64) -> Result<(), u32> {
    write_all(channel, &reply_bytes(kind, value))
}

fn admit(held: &HeldDirectory) -> Option<()> {
    let channel = held.channel.raw();
    let proof = unsafe { Handle::from_raw(CreateEventW(null_mut(), 1, 0, null())) }.ok()?;
    let (HELLO, pid) = read_frame(channel).ok()? else {
        return None;
    };
    let launcher =
        unsafe { Handle::from_raw(OpenProcess(PROCESS_ADMISSION_ACCESS, 0, pid)) }.ok()?;
    let mut remote = null_mut();
    check(unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            proof.raw(),
            launcher.raw(),
            &mut remote,
            EVENT_MODIFY_STATE,
            0,
            0,
        )
    })
    .ok()?;

    // The launcher bounds admission; its exit also ends this wait.
    let waits = [proof.raw(), launcher.raw()];
    if reply(channel, b'C', remote as usize as u64).is_ok()
        && unsafe { WaitForMultipleObjects(2, waits.as_ptr(), 0, INFINITE) } == 0
        && unsafe { AssignProcessToJobObject(held.job.raw(), launcher.raw()) } != 0
    {
        return Some(());
    }
    unsafe {
        DuplicateHandle(
            launcher.raw(),
            remote,
            null_mut(),
            null_mut(),
            0,
            0,
            CLOSE_SOURCE,
        )
    };
    None
}

fn serve(held: &HeldDirectory, recheck: fn(&PinnedPath, &[u16]) -> bool) {
    let channel = held.channel.raw();
    if admit(held).is_none() {
        let _ = reply(channel, b'F', 0);
        return;
    }
    let _ = reply(channel, b'A', 0);
    while let Ok((RECHECK, _)) = read_frame(channel) {
        let verdict = if recheck(&held.pinned, &held.leaf) {
            b'P'
        } else {
            b'X'
        };
        if reply(channel, verdict, 0).is_err() {
            break;
        }
    }
}

pub(super) fn run(args: &[Vec<u16>], options: Options) -> u8 {
    let [path] = args else { return 2 };
    let Some((pinned, leaf)) = hold(path) else {
        diagnose("could not hold the directory");
        return 4;
    };
    let Some(output) = held_reply(&pinned.facts, options.reply_limit) else {
        diagnose("held directory reply exceeds the limit");
        return 3;
    };
    let Ok(job) = create_job() else {
        diagnose("could not create the hold job");
        return 3;
    };
    let Some(channel) = hold_channel() else {
        diagnose("the hold channel is missing");
        return 3;
    };
    if write_all(unsafe { GetStdHandle(STDOUT) }, output.as_bytes()).is_err() {
        return 3;
    }
    let held = Arc::new(HeldDirectory {
        job,
        channel,
        pinned,
        leaf,
    });
    let worker = Arc::clone(&held);
    if thread::Builder::new()
        .spawn(move || serve(&worker, options.recheck))
        .is_err()
    {
        return 3;
    }
    let mut byte = [0];
    while read(input(), &mut byte) == Ok(1) {
        (options.on_input)(held.job.raw(), byte[0]);
    }
    // Exit closes the job and all pins even if the channel thread is blocked.
    unsafe { TerminateProcess(GetCurrentProcess(), 0) };
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_structures_keep_the_native_layout() {
        assert_eq!(size_of::<StartupInfo>(), 104);
        assert_eq!(std::mem::offset_of!(StartupInfo, extra_size), 66);
        assert_eq!(std::mem::offset_of!(StartupInfo, extra), 72);
        assert_eq!(size_of::<JobLimits>(), 144);
    }

    #[test]
    fn handles_require_the_complete_startup_block_and_a_live_value() {
        let mut extra = 4_i32.to_le_bytes().to_vec();
        extra.extend([1; 4]);
        for value in [1_usize, 2, 3, 0x1234] {
            extra.extend(value.to_le_bytes());
        }
        assert_eq!(handle_value(&extra, 3), Some(0x1234));
        assert_eq!(handle_value(&extra[..extra.len() - 1], 3), None);
        assert_eq!(handle_value(&extra, 4), None);
        assert_eq!(handle_value(&(-1_i32).to_le_bytes(), 3), None);
        let last = extra.len() - size_of::<usize>();
        for value in [0, usize::MAX] {
            extra[last..].copy_from_slice(&value.to_le_bytes());
            assert_eq!(handle_value(&extra, 3), None);
        }
    }

    #[test]
    fn replies_use_one_kind_byte_and_a_little_endian_value() {
        assert_eq!(
            reply_bytes(b'C', 0x1234_5678_abcd_ef01),
            *b"C\x01\xef\xcd\xab\x78\x56\x34\x12"
        );
        for kind in [b'A', b'F', b'P', b'X'] {
            assert_eq!(reply_bytes(kind, 0)[1..], [0; 8]);
        }
    }
}
