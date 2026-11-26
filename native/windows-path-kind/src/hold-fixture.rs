#![cfg(windows)]
#![allow(dead_code)]

mod facts;
mod hold;
mod pin;
mod security;
mod windows;

use hold::{Options, StartupInfo, TerminateProcess};
use pin::{PinnedPath, leaf_still_pinned};
use std::fmt::Write as _;
use std::mem::size_of;
use std::os::windows::ffi::OsStrExt;
use std::process::ExitCode;
use std::ptr::{null, null_mut};
use windows::*;

#[repr(C)]
#[derive(Default)]
struct ProcessInfo {
    process: Raw,
    thread: Raw,
    pid: u32,
    tid: u32,
}

#[repr(C)]
struct JobMembers {
    assigned: u32,
    count: u32,
    ids: [usize; 1025],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn QueryInformationJobObject(
        job: Raw,
        class: i32,
        buffer: Raw,
        size: u32,
        written: *mut u32,
    ) -> i32;
    fn GetEnvironmentVariableW(name: *const u16, value: *mut u16, size: u32) -> u32;
    fn Sleep(milliseconds: u32);
    fn CreateProcessW(
        executable: *const u16,
        command: *mut u16,
        process_security: Raw,
        thread_security: Raw,
        inherit: i32,
        flags: u32,
        environment: Raw,
        cwd: *const u16,
        startup: *mut StartupInfo,
        process: *mut ProcessInfo,
    ) -> i32;
}

unsafe extern "C" {
    fn wcstoull(value: *const u16, end: *mut *mut u16, base: i32) -> u64;
}

fn reply_limit() -> usize {
    let mut value = [0; 32];
    let length = unsafe {
        GetEnvironmentVariableW(
            c_wide(&ascii("AVE_TEST_HOLD_REPLY_LIMIT")).as_ptr(),
            value.as_mut_ptr(),
            value.len() as u32,
        )
    } as usize;
    if (1..value.len()).contains(&length) {
        unsafe { wcstoull(value.as_ptr(), null_mut(), 10) as usize }
    } else {
        facts::MAX_REPLY
    }
}

fn recheck(pinned: &PinnedPath, leaf: &[u16]) -> bool {
    match std::env::var("AVE_TEST_HOLD_RECHECK").as_deref() {
        Ok("lost") => return false,
        Ok("stall") => unsafe { Sleep(u32::MAX) },
        _ => {}
    }
    leaf_still_pinned(pinned, leaf)
}

fn report_members(job: Raw, byte: u8) {
    const PROCESS_ID_LIST: i32 = 3;
    if byte != b'L' {
        return;
    }
    let mut members = JobMembers {
        assigned: 0,
        count: 0,
        ids: [0; 1025],
    };
    let mut output = String::from("[");
    if unsafe {
        QueryInformationJobObject(
            job,
            PROCESS_ID_LIST,
            (&mut members as *mut JobMembers).cast(),
            size_of::<JobMembers>() as u32,
            null_mut(),
        )
    } != 0
    {
        for (index, id) in members.ids[..members.count as usize].iter().enumerate() {
            if index != 0 {
                output.push(',');
            }
            write!(output, "{id}").unwrap();
        }
    }
    output.push_str("]\n");
    let _ = write_all(unsafe { GetStdHandle(STDERR) }, output.as_bytes());
}

fn try_breakaway(args: &[Vec<u16>]) -> u8 {
    const CREATE_SUSPENDED: u32 = 4;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let [path] = args else { return 2 };
    let mut startup = StartupInfo::default();
    startup.size = size_of::<StartupInfo>() as u32;
    let mut process = ProcessInfo::default();
    let mut command = [ascii("\""), path.clone(), ascii("\"\0")].concat();
    if unsafe {
        CreateProcessW(
            c_wide(path).as_ptr(),
            command.as_mut_ptr(),
            null_mut(),
            null_mut(),
            0,
            CREATE_SUSPENDED | CREATE_BREAKAWAY_FROM_JOB | CREATE_NO_WINDOW,
            null_mut(),
            null(),
            &mut startup,
            &mut process,
        )
    } == 0
    {
        let _ = emit(&format!("breakaway refused {}", last_error()));
        return 0;
    }
    unsafe {
        TerminateProcess(process.process, 1);
        CloseHandle(process.thread);
        CloseHandle(process.process);
    }
    let _ = emit("breakaway allowed");
    1
}

fn main() -> ExitCode {
    let args: Vec<Vec<u16>> = std::env::args_os()
        .skip(1)
        .map(|value| value.encode_wide().collect())
        .collect();
    let code = match args.split_first() {
        Some((verb, rest)) if eq(verb, "--hold") => hold::run(
            rest,
            Options {
                reply_limit: reply_limit(),
                recheck,
                on_input: report_members,
            },
        ),
        Some((verb, rest)) if eq(verb, "--breakaway") => try_breakaway(rest),
        _ => 2,
    };
    code.into()
}
