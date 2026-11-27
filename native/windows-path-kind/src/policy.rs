use crate::security::private_descriptor;
use crate::windows::*;
use std::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::AsRawHandle;
use std::process::exit;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, OnceLock};
use std::thread;

const MAX_POLICY: u32 = 4 * 1024 * 1024;
const PIPE_INSTANCES: u32 = 4;
const PIPE_PREFIX: &str = r"\\.\pipe\ave-mxc-";

// The bound process, or with `launched` the job launcher whose direct child reads.
struct Client {
    pid: u32,
    process: Handle,
    launched: bool,
    created: u64,
}

struct Delivery {
    bound: Handle,
    done: Handle,
    client: OnceLock<Client>,
    deadline: u64,
    accepted: AtomicU32,
    completed: AtomicU32,
    failed: AtomicBool,
    policy: Vec<u8>,
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

fn created(process: Raw) -> Option<u64> {
    let mut times = [0; 4];
    let [created, exited, kernel, user] = &mut times;
    (unsafe { GetProcessTimes(process, created, exited, kernel, user) } != 0).then_some(times[0])
}

fn parent(process: Raw) -> Option<usize> {
    // PROCESS_BASIC_INFORMATION: the last field is the parent process ID.
    let mut info = [0usize; 6];
    let status = unsafe {
        NtQueryInformationProcess(
            process,
            0,
            info.as_mut_ptr().cast::<c_void>(),
            size_of::<[usize; 6]>() as u32,
            null_mut(),
        )
    };
    (status == 0).then_some(info[5])
}

// The held launcher handle keeps its PID from reuse; a later creation time excludes older
// processes that recorded the same parent PID.
fn admits(client: &Client, connected: u32) -> bool {
    if !client.launched {
        return connected == client.pid;
    }
    if connected == client.pid {
        return false;
    }
    let Ok(reader) = (unsafe { Handle::from_raw(OpenProcess(QUERY_LIMITED, 0, connected)) }) else {
        return false;
    };
    parent(reader.raw()) == Some(client.pid as usize)
        && created(reader.raw()).is_some_and(|time| time >= client.created)
}

fn watch_owner(delivery: &Delivery) {
    let (Ok(pid), Ok(relation)) = (read_u32(), read_u32()) else {
        return;
    };
    if pid == 0 || relation > 1 {
        return;
    }
    let Ok(process) =
        (unsafe { Handle::from_raw(OpenProcess(SYNCHRONIZE | QUERY_LIMITED, 0, pid)) })
    else {
        return;
    };
    if unsafe { WaitForSingleObject(process.raw(), 0) } != WAIT_TIMEOUT {
        return;
    }
    let Some(created) = created(process.raw()) else {
        return;
    };
    let client = Client {
        pid,
        process,
        launched: relation == 1,
        created,
    };
    if delivery.client.set(client).is_err() {
        return;
    }
    delivery.signal(&delivery.bound);
    let _ = read(input(), &mut [0]);
}

fn send(pipe: Raw, delivery: &Delivery) -> bool {
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
        let Some(client) = delivery.client.get() else {
            return delivery.fail();
        };
        let mut connected = 0;
        if unsafe { GetNamedPipeClientProcessId(pipe, &mut connected) } == 0
            || !admits(client, connected)
            || unsafe { WaitForSingleObject(client.process.raw(), 0) } != WAIT_TIMEOUT
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
        if !send(pipe, delivery) {
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
    let [name, milliseconds] = args else {
        return 2;
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
    let delivery = Arc::new(Delivery {
        bound: event(),
        done: event(),
        client: OnceLock::new(),
        deadline,
        accepted: AtomicU32::new(0),
        completed: AtomicU32::new(0),
        failed: AtomicBool::new(false),
        policy,
    });
    let owner_delivery = Arc::clone(&delivery);
    let owner = thread::Builder::new()
        .spawn(move || watch_owner(&owner_delivery))
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
