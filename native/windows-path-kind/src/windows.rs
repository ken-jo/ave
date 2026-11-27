use std::ffi::c_void;
use std::mem::size_of;
use std::ptr::{null, null_mut};

pub type Raw = *mut c_void;
pub const INVALID: Raw = -1_isize as Raw;
pub const STDIN: u32 = -10_i32 as u32;
pub const STDOUT: u32 = -11_i32 as u32;
pub const STDERR: u32 = -12_i32 as u32;
pub const READ_DATA: u32 = 1;
pub const WRITE_DATA: u32 = 2;
pub const TRAVERSE: u32 = 0x20;
pub const READ_ATTRIBUTES: u32 = 0x80;
pub const DELETE: u32 = 0x10000;
pub const READ_CONTROL: u32 = 0x20000;
pub const SYNCHRONIZE: u32 = 0x100000;
pub const DIRECTORY: u32 = 0x10;
pub const REPARSE: u32 = 0x400;
pub const SHARE_READ: u32 = 1;
pub const SHARE_WRITE: u32 = 2;
pub const SHARE_ALL: u32 = 7;
pub const OPEN: u32 = 1;
pub const CREATE: u32 = 2;
pub const DIRECTORY_FILE: u32 = 1;
pub const SEQUENTIAL: u32 = 4;
pub const NOT_DIRECTORY: u32 = 0x40;
pub const BACKUP: u32 = 0x4000;
pub const OPEN_REPARSE: u32 = 0x200000;
pub const WAIT_TIMEOUT: u32 = 258;

#[repr(C)]
#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub struct FileId {
    pub volume: u64,
    pub bytes: [u8; 16],
}

#[repr(C)]
#[derive(Clone, Copy, Default, Eq, PartialEq)]
pub struct Tag {
    pub attributes: u32,
    pub reparse: u32,
}

#[repr(C)]
#[derive(Default)]
pub struct Basic {
    pub creation: i64,
    pub access: i64,
    pub write: i64,
    pub change: i64,
    pub attributes: u32,
}

#[repr(C)]
#[derive(Default)]
pub struct Legacy {
    pub attributes: u32,
    pub creation: [u32; 2],
    pub access: [u32; 2],
    pub write: [u32; 2],
    pub volume: u32,
    pub size_high: u32,
    pub size_low: u32,
    pub links: u32,
    pub index_high: u32,
    pub index_low: u32,
}

impl Legacy {
    pub fn index(&self) -> u64 {
        (u64::from(self.index_high) << 32) | u64::from(self.index_low)
    }
}

#[repr(C)]
pub struct Guid(pub u32, pub u16, pub u16, pub [u8; 8]);

#[repr(C)]
pub struct SecurityAttributes {
    pub length: u32,
    pub descriptor: Raw,
    pub inherit: i32,
}

#[repr(C)]
struct Unicode {
    len: u16,
    capacity: u16,
    text: *const u16,
}

#[repr(C)]
struct Attributes {
    len: u32,
    root: Raw,
    name: *const Unicode,
    flags: u32,
    security: Raw,
    quality: Raw,
}

#[repr(C)]
struct IoStatus(usize, usize);

#[link(name = "kernel32")]
unsafe extern "system" {
    pub fn GetLastError() -> u32;
    pub fn GetStdHandle(index: u32) -> Raw;
    pub fn QueryDosDeviceW(name: *const u16, text: *mut u16, len: u32) -> u32;
    pub fn GetSystemDirectoryW(text: *mut u16, len: u32) -> u32;
    pub fn GetFullPathNameW(path: *const u16, len: u32, out: *mut u16, part: *mut *mut u16) -> u32;
    pub fn GetFinalPathNameByHandleW(handle: Raw, out: *mut u16, len: u32, flags: u32) -> u32;
    pub fn GetVolumeInformationByHandleW(
        handle: Raw,
        volume: *mut u16,
        len: u32,
        serial: *mut u32,
        component: *mut u32,
        flags: *mut u32,
        fs: *mut u16,
        fs_len: u32,
    ) -> i32;
    pub fn GetFileInformationByHandleEx(handle: Raw, class: i32, value: Raw, len: u32) -> i32;
    pub fn GetFileInformationByHandle(handle: Raw, value: *mut Legacy) -> i32;
    pub fn CreateFileW(
        path: *const u16,
        access: u32,
        share: u32,
        security: Raw,
        disposition: u32,
        flags: u32,
        template: Raw,
    ) -> Raw;
    pub fn DeviceIoControl(
        handle: Raw,
        code: u32,
        input: Raw,
        input_size: u32,
        output: Raw,
        output_size: u32,
        used: *mut u32,
        overlapped: Raw,
    ) -> i32;
    pub fn CloseHandle(handle: Raw) -> i32;
    pub fn LocalFree(allocation: Raw) -> Raw;
    pub fn ReadFile(handle: Raw, data: Raw, len: u32, read: *mut u32, overlapped: Raw) -> i32;
    pub fn WriteFile(
        handle: Raw,
        data: *const c_void,
        len: u32,
        written: *mut u32,
        overlapped: Raw,
    ) -> i32;
    pub fn PeekNamedPipe(
        handle: Raw,
        data: Raw,
        len: u32,
        read: *mut u32,
        available: *mut u32,
        left: *mut u32,
    ) -> i32;
    pub fn GetCurrentProcess() -> Raw;
    pub fn GetComputerNameW(out: *mut u16, len: *mut u32) -> i32;
    pub fn GetFileSizeEx(handle: Raw, size: *mut i64) -> i32;
    pub fn SetFilePointerEx(handle: Raw, pos: i64, new_pos: *mut i64, origin: u32) -> i32;
    pub fn FlushFileBuffers(handle: Raw) -> i32;
    pub fn DuplicateHandle(
        source_process: Raw,
        source: Raw,
        dest_process: Raw,
        dest: *mut Raw,
        access: u32,
        inherit: i32,
        options: u32,
    ) -> i32;
    pub fn GetTickCount64() -> u64;
    pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> Raw;
    pub fn WaitForSingleObject(handle: Raw, timeout: u32) -> u32;
    pub fn WaitForMultipleObjects(count: u32, handles: *const Raw, all: i32, timeout: u32) -> u32;
    pub fn CreateEventW(security: Raw, manual: i32, initial: i32, name: *const u16) -> Raw;
    pub fn SetEvent(handle: Raw) -> i32;
    pub fn CreateNamedPipeW(
        name: *const u16,
        access: u32,
        mode: u32,
        count: u32,
        out: u32,
        input: u32,
        timeout: u32,
        security: *const SecurityAttributes,
    ) -> Raw;
    pub fn ConnectNamedPipe(pipe: Raw, overlapped: Raw) -> i32;
    pub fn DisconnectNamedPipe(pipe: Raw) -> i32;
    pub fn GetNamedPipeClientProcessId(pipe: Raw, pid: *mut u32) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtCreateFile(
        file: *mut Raw,
        access: u32,
        attributes: *const Attributes,
        status: *mut IoStatus,
        size: *const i64,
        file_attributes: u32,
        share: u32,
        disposition: u32,
        options: u32,
        ea: Raw,
        ea_len: u32,
    ) -> i32;
    pub fn RtlNtStatusToDosError(status: i32) -> u32;
}

pub struct Handle(Raw);

// Windows kernel handles can be used from any thread in their owning process.
unsafe impl Send for Handle {}
unsafe impl Sync for Handle {}

impl Handle {
    /// Takes ownership of an open handle returned by a Win32 or NT call.
    pub unsafe fn from_raw(raw: Raw) -> Result<Self, u32> {
        if raw == INVALID || raw.is_null() {
            Err(last_error())
        } else {
            Ok(Self(raw))
        }
    }

    pub fn raw(&self) -> Raw {
        self.0
    }

    pub fn close(self) -> Result<(), u32> {
        let raw = self.0;
        std::mem::forget(self);
        check(unsafe { CloseHandle(raw) })
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub struct Local(pub Raw);

impl Drop for Local {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                LocalFree(self.0);
            }
        }
    }
}

pub fn ascii(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

pub fn c_wide(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len() + 1);
    out.extend_from_slice(text);
    out.push(0);
    out
}

pub fn before_nul(text: &[u16]) -> &[u16] {
    &text[..text
        .iter()
        .position(|&unit| unit == 0)
        .unwrap_or(text.len())]
}

/// The pointer must refer to a live NUL-terminated wide string.
pub unsafe fn wide_z(text: *const u16) -> Vec<u16> {
    let mut length = 0;
    unsafe {
        while *text.add(length) != 0 {
            length += 1;
        }
        std::slice::from_raw_parts(text, length).to_vec()
    }
}

pub fn last_error() -> u32 {
    unsafe { GetLastError() }
}
pub fn check(ok: i32) -> Result<(), u32> {
    if ok == 0 { Err(last_error()) } else { Ok(()) }
}

pub fn input() -> Raw {
    unsafe { GetStdHandle(STDIN) }
}

pub fn read(handle: Raw, bytes: &mut [u8]) -> Result<usize, u32> {
    let mut count = 0;
    check(unsafe {
        ReadFile(
            handle,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            &mut count,
            null_mut(),
        )
    })?;
    Ok(count as usize)
}

pub fn read_exact(handle: Raw, mut bytes: &mut [u8]) -> Result<(), u32> {
    while !bytes.is_empty() {
        let count = read(handle, bytes)?;
        if count == 0 {
            return Err(38);
        }
        bytes = &mut bytes[count..];
    }
    Ok(())
}

pub fn write(handle: Raw, bytes: &[u8]) -> Result<usize, u32> {
    let mut count = 0;
    check(unsafe {
        WriteFile(
            handle,
            bytes.as_ptr().cast(),
            bytes.len() as u32,
            &mut count,
            null_mut(),
        )
    })?;
    Ok(count as usize)
}

pub fn write_all(handle: Raw, mut bytes: &[u8]) -> Result<(), u32> {
    while !bytes.is_empty() {
        let count = write(handle, bytes)?;
        if count == 0 {
            return Err(29);
        }
        bytes = &bytes[count..];
    }
    Ok(())
}

pub const STDOUT_LINE_ENDING: &str = "\r\n";

pub fn emit(text: &str) -> Result<(), u32> {
    write_all(
        unsafe { GetStdHandle(STDOUT) },
        format!("{text}{STDOUT_LINE_ENDING}").as_bytes(),
    )
}

pub fn diagnose(text: &str) {
    let _ = write_all(
        unsafe { GetStdHandle(STDERR) },
        format!("{text}\r\n").as_bytes(),
    );
}

pub fn seek(handle: Raw, offset: i64) -> Result<(), u32> {
    check(unsafe { SetFilePointerEx(handle, offset, null_mut(), 0) })
}

pub fn size(handle: Raw) -> Result<i64, u32> {
    let mut size = 0;
    check(unsafe { GetFileSizeEx(handle, &mut size) })?;
    Ok(size)
}

pub fn flush(handle: Raw) -> Result<(), u32> {
    check(unsafe { FlushFileBuffers(handle) })
}

pub fn volume_flags(handle: Raw) -> Result<u32, u32> {
    let mut flags = 0;
    check(unsafe {
        GetVolumeInformationByHandleW(
            handle,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            &mut flags,
            null_mut(),
            0,
        )
    })?;
    Ok(flags)
}

fn file_info<T: Default>(handle: Raw, class: i32) -> Result<T, u32> {
    let mut value = T::default();
    check(unsafe {
        GetFileInformationByHandleEx(
            handle,
            class,
            (&mut value as *mut T).cast(),
            size_of::<T>() as u32,
        )
    })?;
    Ok(value)
}

pub fn tag(handle: Raw) -> Result<Tag, u32> {
    file_info(handle, 9)
}
pub fn file_id(handle: Raw) -> Result<FileId, u32> {
    file_info(handle, 18)
}
pub fn basic(handle: Raw) -> Result<Basic, u32> {
    file_info(handle, 0)
}
pub fn legacy(handle: Raw) -> Result<Legacy, u32> {
    let mut value = Legacy::default();
    check(unsafe { GetFileInformationByHandle(handle, &mut value) })?;
    Ok(value)
}

pub fn open_root(root: &[u16], access: u32, share: u32) -> Result<Handle, u32> {
    let extended = if root.starts_with(&[92, 92]) {
        [ascii(r"\\?\UNC\"), root[2..].to_vec()].concat()
    } else {
        [ascii(r"\\?\"), root.to_vec()].concat()
    };
    unsafe {
        Handle::from_raw(CreateFileW(
            c_wide(&extended).as_ptr(),
            access,
            share,
            null_mut(),
            3,
            0x02200000,
            null_mut(),
        ))
    }
}

pub fn open_relative(
    parent: Raw,
    name: &[u16],
    access: u32,
    share: u32,
    disposition: u32,
    options: u32,
    security: Raw,
) -> Result<Handle, i32> {
    let len = u16::try_from(name.len() * 2).map_err(|_| 0xc0000033_u32 as i32)?;
    if len == 0 || name.iter().any(|unit| matches!(unit, 47 | 58 | 92)) {
        return Err(0xc0000033_u32 as i32);
    }
    let name = Unicode {
        len,
        capacity: len,
        text: name.as_ptr(),
    };
    let attributes = Attributes {
        len: size_of::<Attributes>() as u32,
        root: parent,
        name: &name,
        flags: 0x40,
        security,
        quality: null_mut(),
    };
    let mut status = IoStatus(0, 0);
    let mut handle = INVALID;
    let result = unsafe {
        NtCreateFile(
            &mut handle,
            access | SYNCHRONIZE,
            &attributes,
            &mut status,
            null(),
            0x80,
            share,
            disposition,
            options | 0x20,
            null_mut(),
            0,
        )
    };
    if result < 0 {
        return Err(result);
    }
    unsafe { Handle::from_raw(handle) }.map_err(|_| 0xc0000008_u32 as i32)
}

pub fn duplicate(handle: Raw) -> Result<Handle, u32> {
    let mut out = INVALID;
    let process = unsafe { GetCurrentProcess() };
    check(unsafe { DuplicateHandle(process, handle, process, &mut out, 0, 0, 2) })?;
    unsafe { Handle::from_raw(out) }
}

pub fn hex(bytes: impl IntoIterator<Item = u8>) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::new();
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize].into());
        out.push(HEX[(byte & 15) as usize].into());
    }
    out
}

pub fn decode_hex(text: &[u16], length: usize) -> Option<Vec<u8>> {
    fn digit(unit: u16) -> Option<u8> {
        match unit {
            48..=57 => Some((unit - 48) as u8),
            97..=102 => Some((unit - 87) as u8),
            _ => None,
        }
    }
    if text.len() != length * 2 {
        return None;
    }
    text.chunks_exact(2)
        .map(|pair| Some(digit(pair[0])? << 4 | digit(pair[1])?))
        .collect()
}

pub fn eq(text: &[u16], ascii: &str) -> bool {
    text.iter().copied().eq(ascii.bytes().map(u16::from))
}
