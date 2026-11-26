use crate::security::private_descriptor;
use crate::windows::*;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::exit;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{Receiver, SyncSender, sync_channel};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

const MAX_POLICY: u32 = 4 * 1024 * 1024;
const PIPE_INSTANCES: u32 = 4;
const PIPE_PREFIX: &str = r"\\.\pipe\ave-mxc-";
const INVALID_FILE_ATTRIBUTES: u32 = u32::MAX;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;

struct Delivery {
    bound: Handle,
    done: Handle,
    client: OnceLock<(u32, Handle)>,
    deadline: u64,
    accepted: AtomicU32,
    completed: AtomicU32,
    failed: AtomicBool,
    authorization: Option<Authorization>,
    policy: Vec<u8>,
}

struct Authorization {
    gate: Vec<u16>,
    permit: Mutex<Receiver<()>>,
}

impl Authorization {
    fn request(&self, remaining: impl FnOnce() -> u32) -> bool {
        let Ok(permit) = self.permit.lock() else {
            return false;
        };
        write(unsafe { GetStdHandle(STDOUT) }, b"authorize\n") == Ok(10)
            && permit.recv_timeout(std::time::Duration::from_millis(u64::from(remaining()))).is_ok()
    }
}

impl Delivery {
    fn remaining(&self) -> u32 {
        self.deadline.saturating_sub(unsafe { GetTickCount64() }) as u32
    }

    fn signal(&self, event: &Handle) {
        unsafe {
            SetEvent(event.raw());
        }
    }

    fn fail(&self) {
        self.failed.store(true, Ordering::SeqCst);
        self.signal(&self.done);
    }
}

fn read_u32() -> Result<u32, u32> {
    let mut bytes = [0; 4];
    read_exact(input(), &mut bytes)?;
    Ok(u32::from_le_bytes(bytes))
}

fn watch_owner(delivery: &Delivery, authorization: Option<SyncSender<()>>) {
    let Ok(pid) = read_u32() else {
        return;
    };
    if pid == 0 {
        return;
    }
    let Ok(client) = (unsafe { Handle::from_raw(OpenProcess(SYNCHRONIZE, 0, pid)) }) else {
        return;
    };
    if unsafe { WaitForSingleObject(client.raw(), 0) } != WAIT_TIMEOUT {
        return;
    }
    if delivery.client.set((pid, client)).is_err() {
        return;
    }
    delivery.signal(&delivery.bound);
    if let Some(authorization) = authorization {
        let mut reply = [0];
        while read_exact(input(), &mut reply).is_ok() && reply[0] == 1 {
            if authorization.send(()).is_err() { break; }
        }
    } else {
        let _ = read(input(), &mut [0]);
    }
}

fn gate_allows_write(attributes: u32) -> bool {
    attributes != INVALID_FILE_ATTRIBUTES
        && attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT) == 0
}

fn delivery_is_authorized(request: impl FnOnce() -> bool, attributes: impl FnOnce() -> u32) -> bool {
    request() && gate_allows_write(attributes())
}

fn send(pipe: Raw, delivery: &Delivery, client: &Handle) -> bool {
    if let Some(authorization) = &delivery.authorization {
        if !delivery_is_authorized(
            || authorization.request(|| delivery.remaining()),
            || unsafe { GetFileAttributesW(authorization.gate.as_ptr()) },
        ) || delivery.remaining() == 0
            || unsafe { WaitForSingleObject(client.raw(), 0) } != WAIT_TIMEOUT
        {
            return false;
        }
    }
    let result: Result<(), u32> = match write(pipe, &delivery.policy) {
        Ok(written) if written != delivery.policy.len() => return false,
        Ok(_) => flush(pipe).and_then(|_| write(pipe, &[])).and_then(|_| {
            let mut discard = [0; 256];
            while read(pipe, &mut discard).is_ok() {
                if delivery.remaining() == 0 {
                    return Err(0);
                }
            }
            Err(last_error())
        }),
        Err(error) => Err(error),
    };
    matches!(result, Err(109 | 232))
}

fn serve(pipe: Arc<Handle>, delivery: &Delivery) {
    let pipe = pipe.raw();
    while unsafe { WaitForSingleObject(delivery.done.raw(), 0) } == WAIT_TIMEOUT {
        if unsafe { ConnectNamedPipe(pipe, null_mut()) } == 0 && last_error() != 535 {
            return delivery.fail();
        }
        if unsafe { WaitForSingleObject(delivery.bound.raw(), delivery.remaining()) } != 0 {
            return delivery.fail();
        }
        let Some((pid, client)) = delivery.client.get() else {
            return delivery.fail();
        };
        let mut connected = 0;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut connected) } == 0
            || connected != *pid
            || unsafe { WaitForSingleObject(client.raw(), 0) } != WAIT_TIMEOUT
        {
            unsafe {
                DisconnectNamedPipe(pipe);
            }
            continue;
        }
        if delivery
            .accepted
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                (count < 2).then_some(count + 1)
            })
            .is_err()
        {
            unsafe {
                DisconnectNamedPipe(pipe);
            }
            return;
        }
        if !send(pipe, delivery, client) {
            return delivery.fail();
        }
        unsafe {
            DisconnectNamedPipe(pipe);
        }
        if delivery.completed.fetch_add(1, Ordering::SeqCst) == 1 {
            delivery.signal(&delivery.done);
        }
    }
}

fn timeout(text: &[u16]) -> Option<u32> {
    let text = String::from_utf16(text).ok()?;
    let text = text.trim_start_matches(|ch: char| ch.is_ascii_whitespace() || ch == '\x0b');
    let (negative, digits) = if let Some(digits) = text.strip_prefix('-') {
        (true, digits)
    } else {
        (false, text.strip_prefix('+').unwrap_or(text))
    };
    if !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let value = digits.parse::<u32>().ok()?;
    let value = if negative {
        value.wrapping_neg()
    } else {
        value
    };
    (value != 0 && value != u32::MAX).then_some(value)
}

fn event() -> Handle {
    unsafe { Handle::from_raw(CreateEventW(null_mut(), 1, 0, null())) }.unwrap_or_else(|_| exit(1))
}

pub fn run(args: &[Vec<u16>]) -> u8 {
    let (name, milliseconds, gate) = match args {
        [name, milliseconds] => (name, milliseconds, None),
        [name, milliseconds, gate, authorize] if *authorize == ascii("--authorize") => {
            (name, milliseconds, Some(c_wide(gate)))
        }
        _ => return 2,
    };
    let prefix = ascii(PIPE_PREFIX);
    let Some(suffix) = name.strip_prefix(prefix.as_slice()) else {
        return 2;
    };
    if suffix.len() != 32 || decode_hex(suffix, 16).is_none() {
        return 2;
    }
    let Some(timeout) = timeout(milliseconds) else {
        return 2;
    };
    let Ok(size) = read_u32() else {
        return 2;
    };
    if size == 0 || size > MAX_POLICY {
        return 2;
    }
    let deadline = unsafe { GetTickCount64() } + u64::from(timeout);
    let mut policy = vec![0; size as usize];
    if read_exact(input(), &mut policy).is_err() {
        return 2;
    }
    let Ok(descriptor) = private_descriptor("GA") else {
        return 1;
    };
    let security = SecurityAttributes {
        length: size_of::<SecurityAttributes>() as u32,
        descriptor: descriptor.0,
        inherit: 0,
    };
    let name = c_wide(name);
    let mut pipes = Vec::with_capacity(PIPE_INSTANCES as usize);
    for index in 0..PIPE_INSTANCES {
        let access = 3 | if index == 0 { 0x80000 } else { 0 };
        let pipe = unsafe {
            Handle::from_raw(CreateNamedPipeW(
                name.as_ptr(),
                access,
                0x0c,
                PIPE_INSTANCES,
                MAX_POLICY,
                256,
                0,
                &security,
            ))
        };
        match pipe {
            Ok(pipe) => pipes.push(Arc::new(pipe)),
            Err(error) => {
                diagnose(&format!(
                    "Windows sandbox policy pipe creation failed ({error})"
                ));
                return 1;
            }
        }
    }
    drop(descriptor);
    let (authorization, permits) = match gate {
        Some(gate) => {
            let (send, receive) = sync_channel(0);
            (Some(Authorization { gate, permit: Mutex::new(receive) }), Some(send))
        }
        None => (None, None),
    };
    let delivery = Arc::new(Delivery {
        bound: event(),
        done: event(),
        client: OnceLock::new(),
        deadline,
        accepted: AtomicU32::new(0),
        completed: AtomicU32::new(0),
        failed: AtomicBool::new(false),
        authorization,
        policy,
    });
    let owner_delivery = Arc::clone(&delivery);
    let owner = thread::Builder::new()
        .spawn(move || watch_owner(&owner_delivery, permits))
        .unwrap_or_else(|_| exit(1));
    let workers: Vec<_> = pipes
        .iter()
        .cloned()
        .map(|pipe| {
            let delivery = Arc::clone(&delivery);
            thread::Builder::new()
                .spawn(move || serve(pipe, &delivery))
                .unwrap_or_else(|_| exit(1))
        })
        .collect();
    if write(unsafe { GetStdHandle(STDOUT) }, b"ready\n") != Ok(6) {
        exit(1);
    }
    let waits = [delivery.done.raw(), owner.as_raw_handle()];
    let result = unsafe { WaitForMultipleObjects(2, waits.as_ptr(), 0, delivery.remaining()) };
    let code = i32::from(result != 0 || delivery.failed.load(Ordering::SeqCst));
    if code != 0 {
        diagnose("Windows sandbox policy delivery failed or expired");
    }
    // The process boundary cancels blocking pipe and owner reads together.
    let _workers = workers;
    exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_release_gate_requires_a_regular_path() {
        assert!(gate_allows_write(0x80));
        assert!(!gate_allows_write(INVALID_FILE_ATTRIBUTES));
        assert!(!gate_allows_write(FILE_ATTRIBUTE_DIRECTORY));
        assert!(!gate_allows_write(FILE_ATTRIBUTE_REPARSE_POINT | 0x80));
        assert!(!gate_allows_write(
            FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT
        ));
    }

    #[test]
    fn a_write_requires_a_fresh_permit_and_a_live_gate_after_the_reply() {
        assert!(!delivery_is_authorized(|| false, || 0x80));
        let attrs = std::cell::Cell::new(0x80);
        assert!(!delivery_is_authorized(
            || {
                attrs.set(INVALID_FILE_ATTRIBUTES);
                true
            },
            || attrs.get(),
        ));
        assert!(delivery_is_authorized(|| true, || 0x80));
    }

    #[test]
    fn policy_pipe_rejects_extra_arguments() {
        assert_eq!(run(&[ascii(PIPE_PREFIX), ascii("1000"), vec![], vec![]]), 2);
    }
}
