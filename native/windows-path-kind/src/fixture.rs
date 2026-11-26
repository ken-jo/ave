#![cfg(windows)]
#![allow(dead_code)]

mod directory;
mod faults;
mod pin;
mod security;
mod windows;

use pin::{PinnedPath, pin, read_facts, verify};
use std::fs::{self, OpenOptions};
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use std::ptr::null_mut;
use std::thread::sleep;
use std::time::Duration;
use windows::*;

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().collect()
}

fn open(path: &Path, access: u32, flags: u32) -> Result<Handle, u32> {
    unsafe {
        Handle::from_raw(CreateFileW(
            c_wide(&wide(path)).as_ptr(),
            access,
            SHARE_ALL,
            null_mut(),
            3,
            flags,
            null_mut(),
        ))
    }
}

fn create(path: &Path) {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .unwrap();
}

fn device(file: Raw, code: u32, input: &mut [u8]) -> Result<(), u32> {
    let mut written = 0;
    check(unsafe {
        DeviceIoControl(
            file,
            code,
            input.as_mut_ptr().cast(),
            input.len() as u32,
            null_mut(),
            0,
            &mut written,
            null_mut(),
        )
    })
}

fn junction(path: &Path, target: &Path) {
    let opened = open(path, 0x40000000, 0x02200000).unwrap();
    let print = wide(target);
    let substitute = [ascii(r"\??\"), print.clone()].concat();
    let len = substitute.len() * 2;
    let print_len = print.len() * 2;
    let offset = len + 2;
    let mut data = vec![0; 16 + offset + print_len + 2];
    let put = |data: &mut [u8], index: usize, value: usize| {
        data[index..index + 2].copy_from_slice(&(value as u16).to_le_bytes());
    };
    data[..4].copy_from_slice(&0xa0000003_u32.to_le_bytes());
    let body = data.len() - 8;
    put(&mut data, 4, body);
    put(&mut data, 10, len);
    put(&mut data, 12, offset);
    put(&mut data, 14, print_len);
    for (units, start) in [(substitute, 16), (print, 16 + offset)] {
        for (index, unit) in units.into_iter().enumerate() {
            put(&mut data, start + index * 2, unit as usize);
        }
    }
    device(opened.raw(), 0x900a4, &mut data).unwrap();
}

fn snapshot(path: &Path) -> PinnedPath {
    let file = open(path, READ_ATTRIBUTES | READ_CONTROL, 0x02200000).unwrap();
    let facts = read_facts(file.raw()).unwrap();
    PinnedPath {
        handles: vec![file],
        facts: vec![facts],
    }
}

fn child(parent: Raw) -> Result<Handle, i32> {
    open_relative(
        parent,
        &ascii("child"),
        READ_ATTRIBUTES | READ_CONTROL,
        SHARE_READ,
        OPEN,
        BACKUP | OPEN_REPARSE,
        null_mut(),
    )
}

fn change_time(root: &Path) {
    let path = root.join("change-time");
    let renamed = root.join("change-time-renamed");
    create(&path);
    let original = pin(&wide(&path), false).unwrap().facts.pop().unwrap();
    let unchanged = pin(&wide(&path), false).unwrap().facts.pop().unwrap();
    let file = open(&path, READ_ATTRIBUTES, 0).unwrap();
    let mut fs_name = [0; 261];
    check(unsafe {
        GetVolumeInformationByHandleW(
            file.raw(),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            fs_name.as_mut_ptr(),
            261,
        )
    })
    .unwrap();
    drop(file);
    assert_eq!(original.filesystem, before_nul(&fs_name));
    assert_eq!(unchanged.filesystem, before_nul(&fs_name));
    assert!(pin::Facts::default().filesystem.is_empty());
    emit("native filesystem: pins match the retained handle volume query").unwrap();
    assert!(
        original.change != 0 && original.change == unchanged.change && original.id == unchanged.id
    );
    sleep(Duration::from_millis(20));
    let file = open(&path, READ_CONTROL | 0x40000, 0x00200000).unwrap();
    security::add_fixture_ace(file.raw()).unwrap();
    drop(file);
    let secured = pin(&wide(&path), false).unwrap().facts.pop().unwrap();
    assert!(original.change != secured.change && original.id == secured.id);
    sleep(Duration::from_millis(20));
    fs::rename(path, &renamed).unwrap();
    let moved = pin(&wide(&renamed), false).unwrap().facts.pop().unwrap();
    assert!(secured.change != moved.change && secured.id == moved.id);
    emit("native changeTime: stable pins; ACL and rename advance time while volume serial and file ID stay equal").unwrap();
}

fn non_surrogate(root: &Path) {
    let path = root.join("non-surrogate");
    fs::create_dir(&path).unwrap();
    let file = open(&path, 0xc0000000, 0x02200000).unwrap();
    // A fixture-owned non-surrogate tag with no filesystem provider.
    let mut data = [
        0x42, 0, 0, 0, 0, 0, 0, 0, 0x66, 0xd8, 0x26, 0xdb, 0x21, 0x53, 0x43, 0x4f, 0x97, 0x7f,
        0x45, 0x91, 0xca, 0x0b, 0xf0, 0xee,
    ];
    device(file.raw(), 0x900a4, &mut data).unwrap();
    match open_relative(
        file.raw(),
        &ascii("child"),
        0x40000000,
        SHARE_READ,
        CREATE,
        BACKUP | OPEN_REPARSE,
        null_mut(),
    ) {
        Ok(child) => drop(child),
        Err(status) => {
            device(file.raw(), 0x900ac, &mut data).unwrap();
            emit(&format!(
                "non-surrogate child fixture unavailable: NtCreateFile status=0x{:08x}",
                status as u32
            ))
            .unwrap();
            assert_eq!(status as u32, 0xc0000279);
            return;
        }
    }
    let pinned = pin(&wide(&path.join("child")), false).unwrap();
    assert_eq!(pinned.facts.last().unwrap().exists, Some(true));
    assert_eq!(pinned.facts[pinned.facts.len() - 2].tag.reparse, 0x42);
}

fn run(root: &Path) {
    change_time(root);
    let parent = root.join("retag-parent");
    let target = root.join("retag-target");
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&target).unwrap();
    let child_path = target.join("child");
    create(&child_path);
    {
        let pinned = snapshot(&parent);
        junction(&parent, &target);
        assert!(child(pinned.handles[0].raw()).is_err());
        assert!(!verify(&pinned));
    }
    fs::remove_dir(&parent).unwrap();
    fs::create_dir(&parent).unwrap();
    {
        let pinned = snapshot(&parent);
        fs::rename(&parent, root.join("parked")).unwrap();
        fs::create_dir(&parent).unwrap();
        junction(&parent, &target);
        assert!(child(pinned.handles[0].raw()).is_err());
        assert!(!verify(&pinned));
    }
    let pinned = pin(&wide(&child_path), false).unwrap();
    assert!(verify(&pinned));
    let tag = tag(pinned.handles.last().unwrap().raw()).unwrap();
    assert_eq!(tag.attributes & (DIRECTORY | REPARSE), 0);
    non_surrogate(root);
    emit("native pin: retagged ancestor and swapped ancestor refused; handle-relative child lookup stayed on original parent").unwrap();
}

fn main() -> std::process::ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if let [root] = args.as_slice() {
        run(Path::new(root));
        return 0.into();
    }
    if args.len() >= 7 {
        if let Some(fault) = args[0].to_str() {
            let rest: Vec<Vec<u16>> = args[1..]
                .iter()
                .map(|value| value.encode_wide().collect())
                .collect();
            if let Some(mode) = args[1].to_str()
                && faults::configure(fault, &rest).is_some()
            {
                return directory::run(mode, &rest[1..]).into();
            }
        }
    }
    2.into()
}
