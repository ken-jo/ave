use crate::directory::NameIdentity;
use crate::windows::*;
use std::ptr::null_mut;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI32, Ordering};

#[derive(Default, Eq, PartialEq)]
enum Boundary {
    #[default]
    None,
    RestoreTarget,
    RestoreError,
    UnsupportedIsolation,
    CommitMismatch,
    CommitBlocked,
    ReplaceCommitFailure,
    ReplaceRestoreFailure,
    ReplaceOccupied,
}

#[derive(Default)]
struct Faults {
    boundary: Boundary,
    path: Vec<u16>,
    stop: String,
    id_position: AtomicI32,
    zero_id: bool,
    no_file_ids: bool,
    volume_error: bool,
}

static FAULTS: OnceLock<Faults> = OnceLock::new();

#[link(name = "kernel32")]
unsafe extern "system" {
    fn DeleteFileW(path: *const u16) -> i32;
    fn MoveFileExW(path: *const u16, to: *const u16, flags: u32) -> i32;
    fn CreateDirectoryW(path: *const u16, security: Raw) -> i32;
}

pub fn configure(mode: &str, args: &[Vec<u16>]) -> Option<()> {
    let mut faults = Faults::default();
    let exact_copy = args.len() == 11;
    let path = |dir: usize, name: usize| [args[dir].clone(), vec![92], args[name].clone()].concat();
    match mode {
        "file-id-query-failure-first"
        | "file-id-query-failure-second"
        | "file-id-zero-first"
        | "file-id-zero-second"
        | "file-id-zero-recovery" => {
            let position = if mode.ends_with("recovery") {
                -1
            } else if mode.ends_with("second") {
                2
            } else {
                1
            };
            faults.id_position = AtomicI32::new(position);
            faults.zero_id = mode.contains("zero");
        }
        "volume-without-file-ids" => faults.no_file_ids = true,
        "volume-query-fails" => faults.volume_error = true,
        mode if exact_copy && mode.starts_with("stop-") => {
            faults.stop = mode[5..].to_owned();
            if faults.stop == "leftover" {
                faults.boundary = Boundary::ReplaceRestoreFailure;
            }
        }
        "replace-occupied" if exact_copy => {
            faults.boundary = Boundary::ReplaceOccupied;
            faults.path = path(5, 8);
        }
        "replace-commit-failure" if exact_copy => faults.boundary = Boundary::ReplaceCommitFailure,
        "replace-restore-failure" if exact_copy => {
            faults.boundary = Boundary::ReplaceRestoreFailure
        }
        "commit-mismatch" if exact_copy => faults.boundary = Boundary::CommitMismatch,
        "commit-blocked" if exact_copy => {
            faults.boundary = Boundary::CommitBlocked;
            faults.path = path(5, 9);
        }
        "restore-target" | "restore-write-error" | "no-exclusive-rename" => {
            faults.boundary = match mode {
                "restore-target" => Boundary::RestoreTarget,
                "restore-write-error" => Boundary::RestoreError,
                _ => Boundary::UnsupportedIsolation,
            };
            let name = if faults.boundary == Boundary::UnsupportedIsolation {
                4
            } else {
                5
            };
            faults.path = path(1, name);
        }
        _ => return None,
    }
    FAULTS.set(faults).ok()?;
    Some(())
}

pub fn volume_result(result: Result<u32, u32>) -> Result<u32, u32> {
    let Some(faults) = FAULTS.get() else {
        return result;
    };
    if faults.volume_error {
        Err(1)
    } else if faults.no_file_ids {
        result.map(|flags| flags & !0x01000000)
    } else {
        result
    }
}

pub fn file_id_result(result: Result<FileId, u32>) -> Result<FileId, u32> {
    let Some(faults) = FAULTS.get() else {
        return result;
    };
    let previous =
        faults
            .id_position
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |position| {
                (position > 0).then_some(position - 1)
            });
    if previous != Ok(1) && previous != Err(-1) {
        return result;
    }
    if faults.zero_id {
        result.map(|id| FileId {
            bytes: [0; 16],
            ..id
        })
    } else {
        Err(50)
    }
}

pub fn restore_write_result(result: Result<(), u32>) -> Result<(), u32> {
    use std::sync::atomic::AtomicBool;
    static ATTEMPTED: AtomicBool = AtomicBool::new(false);
    let Some(faults) = FAULTS.get() else {
        return result;
    };
    if !matches!(
        faults.boundary,
        Boundary::RestoreTarget | Boundary::RestoreError
    ) || ATTEMPTED.swap(true, Ordering::Relaxed)
    {
        return result;
    }
    let from = c_wide(&faults.path);
    let to = c_wide(&[faults.path.clone(), ascii(".moved")].concat());
    let remove = check(unsafe { DeleteFileW(from.as_ptr()) });
    let rename = check(unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) });
    if matches!(remove, Err(5 | 32)) && matches!(rename, Err(5 | 32)) {
        diagnose("boundary reached; replacement blocked");
    }
    if faults.boundary == Boundary::RestoreError {
        Err(29)
    } else {
        result
    }
}

pub fn fail_remove() -> bool {
    let Some(faults) = FAULTS.get() else {
        return false;
    };
    if faults.boundary != Boundary::UnsupportedIsolation {
        return false;
    }
    let from = c_wide(&faults.path);
    let to = c_wide(&[faults.path.clone(), ascii(".moved")].concat());
    match check(unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) }) {
        Ok(()) => unsafe {
            CreateDirectoryW(from.as_ptr(), null_mut());
        },
        Err(5 | 32) => diagnose("boundary reached; replacement blocked"),
        Err(_) => {}
    }
    true
}

fn occupy(path: &[u16]) -> Result<Handle, u32> {
    unsafe {
        Handle::from_raw(CreateFileW(
            c_wide(path).as_ptr(),
            WRITE_DATA,
            0,
            null_mut(),
            1,
            0,
            null_mut(),
        ))
    }
}

pub fn fail_replacement_rename(restoring: bool) -> bool {
    let Some(faults) = FAULTS.get() else {
        return false;
    };
    if !restoring && faults.boundary == Boundary::ReplaceOccupied {
        if let Ok(file) = occupy(&faults.path) {
            let _ = write_all(file.raw(), b"competing bytes");
        }
    }
    faults.boundary == Boundary::ReplaceRestoreFailure
        || (!restoring && faults.boundary == Boundary::ReplaceCommitFailure)
}

pub fn stop_replacement(boundary: &str) {
    if FAULTS.get().is_some_and(|faults| faults.stop == boundary) {
        std::process::exit(7);
    }
}

pub fn commit_result(result: NameIdentity) -> NameIdentity {
    let Some(faults) = FAULTS.get() else {
        return result;
    };
    if faults.boundary == Boundary::CommitMismatch
        || (faults.boundary == Boundary::CommitBlocked && occupy(&faults.path).is_ok())
    {
        NameIdentity::Unverified
    } else {
        result
    }
}
