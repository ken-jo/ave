#![cfg(windows)]

mod directory;
mod facts;
#[cfg(feature = "fixture")]
mod faults;
mod hold;
mod pin;
mod policy;
mod security;
mod windows;

use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::process::ExitCode;
use std::ptr::null_mut;
use windows::*;

#[link(name = "shell32")]
unsafe extern "system" {
    fn SHGetKnownFolderPath(id: *const Guid, flags: u32, token: Raw, path: *mut *mut u16) -> i32;
}

#[link(name = "ole32")]
unsafe extern "system" {
    fn CoInitializeEx(reserved: Raw, flags: u32) -> i32;
    fn CoUninitialize();
    fn CoTaskMemFree(memory: *mut c_void);
}

struct Apartment;

impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct KnownFolder(*mut u16);

impl Drop for KnownFolder {
    fn drop(&mut self) {
        unsafe {
            CoTaskMemFree(self.0.cast());
        }
    }
}

fn print_documents() -> u8 {
    const DOCUMENTS: Guid = Guid(
        0xfdd39ad0,
        0x238f,
        0x46af,
        [0xad, 0xb4, 0x6c, 0x85, 0x48, 0x03, 0x69, 0xc7],
    );
    if unsafe { CoInitializeEx(null_mut(), 2) } < 0 {
        return 4;
    }
    let _apartment = Apartment;
    let mut folder = KnownFolder(null_mut());
    if unsafe { SHGetKnownFolderPath(&DOCUMENTS, 0x4000, null_mut(), &mut folder.0) } < 0
        || folder.0.is_null()
    {
        return 4;
    }
    let text = unsafe { wide_z(folder.0) };
    if text.is_empty() {
        return 4;
    }
    if emit(&String::from_utf16_lossy(&text)).is_ok() {
        0
    } else {
        3
    }
}

fn print_system() -> u8 {
    let mut buffer = vec![0; 260];
    loop {
        let length =
            unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
        if length == 0 {
            diagnose(&format!("GetSystemDirectoryW failed: {}", last_error()));
            return 4;
        }
        if length < buffer.len() {
            if emit(&String::from_utf16_lossy(&buffer[..length])).is_ok() {
                return 0;
            }
            diagnose("could not write the system directory");
            return 3;
        }
        if length >= 32768 {
            diagnose("system directory exceeds the path limit");
            return 4;
        }
        buffer.resize(length + 1, 0);
    }
}

fn print_mapping(name: &[u16]) -> u8 {
    let name = c_wide(name);
    let mut buffer = vec![0; 1024];
    loop {
        if unsafe { QueryDosDeviceW(name.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32) } != 0
        {
            break;
        }
        let error = last_error();
        if error == 122 && buffer.len() < 1 << 20 {
            buffer.resize(buffer.len() * 4, 0);
        } else {
            diagnose(&format!("QueryDosDeviceW failed: {error}"));
            return 1;
        }
    }
    let mapping = before_nul(&buffer);
    if mapping.is_empty() {
        diagnose("QueryDosDeviceW returned an empty mapping");
        return 1;
    }
    if emit(&String::from_utf16_lossy(mapping)).is_err() {
        diagnose("could not write the mapping");
        return 3;
    }
    0
}

fn dispatch(args: &[Vec<u16>]) -> u8 {
    let (verb, rest) = args
        .split_first()
        .map_or((&[][..], &[][..]), |(verb, rest)| (verb.as_slice(), rest));
    match String::from_utf16(verb).as_deref() {
        Ok("--mxc-policy") => policy::run(rest, false),
        Ok("--mxc-policy-held-v1") => policy::run(rest, true),
        Ok("--system-directory") => {
            if rest.is_empty() {
                print_system()
            } else {
                2
            }
        }
        Ok("--documents-directory") if rest.is_empty() => print_documents(),
        Ok("--pin") => facts::run(rest, false),
        Ok("--dacl") => facts::run(rest, true),
        Ok("--hold") => hold::run(rest, hold::Options::default()),
        Ok("--deny-acls") => facts::deny(rest),
        Ok(mode) if mode.starts_with("--dir-") => directory::run(mode, rest),
        _ if verb.starts_with(&[45, 45, 100, 105, 114, 45]) => directory::run("", rest),
        _ if rest.is_empty() && matches!(verb, [65..=90 | 97..=122, 58]) => print_mapping(verb),
        _ => {
            diagnose("usage: ave-path-kind.exe X:");
            2
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os()
        .skip(1)
        .map(|value| value.encode_wide().collect())
        .collect();
    ExitCode::from(dispatch(&args))
}
