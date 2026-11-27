//! Ends every process whose Seatbelt sandbox carries one Ave holder label (README.md). No crates; libSystem only.
//!
//!   ave-holder-sweep sweep <label> <control>   signal every member, repeat until two passes in a row find none
//!   ave-holder-sweep watch <label> <control>   ignore HUP, INT, TERM and PIPE; read stdin to EOF; then `sweep`
//!   ave-holder-sweep prove <label> <control>   check that a stale identity of one member is refused; signal nothing
//!
//! A member is a process whose sandbox allows `mach-lookup` of <label> and denies it for <control>; an unsandboxed
//! process allows both, so the control removes it. Every check and signal goes through one audit token per process
//! per pass, built from the pid and its pid version, so a recycled pid is never signalled.
//!
//! Exit: 0 clean (sweep) or proven (prove); 3 members remained after the pass bound; 4 a member refused the signal;
//! 5 not proven; 64 usage; 70 the process list or a process query failed.
use std::ffi::{CString, c_char, c_int, c_void};
use std::io::{Read, Write};

#[repr(C)]
#[derive(Clone, Copy)]
struct AuditToken {
    val: [u32; 8],
}

// struct proc_uniqidentifierinfo (xnu bsd/sys/proc_info.h; not in the public SDK headers).
#[repr(C)]
struct ProcUniqIdentifierInfo {
    uuid: [u8; 16],
    uniqueid: u64,
    puniqueid: u64,
    idversion: i32,
    orig_ppidversion: i32,
    reserve2: u64,
    reserve3: u64,
}

// struct proc_bsdshortinfo (<sys/proc_info.h>).
#[repr(C)]
struct ProcBsdShortInfo {
    pid: u32,
    ppid: u32,
    pgid: u32,
    status: u32,
    comm: [c_char; 16],
    flags: u32,
    uid: u32,
    gid: u32,
    ruid: u32,
    rgid: u32,
    svuid: u32,
    svgid: u32,
    rfu: u32,
}

const PROC_PIDT_SHORTBSDINFO: c_int = 13;
const PROC_PIDUNIQIDENTIFIERINFO: c_int = 17;
const SANDBOX_FILTER_GLOBAL_NAME: c_int = 2;
const SIGHUP: c_int = 1;
const SIGINT: c_int = 2;
const SIGKILL: c_int = 9;
const SIGPIPE: c_int = 13;
const SIGTERM: c_int = 15;
const SIG_IGN: usize = 1;
const ESRCH: i32 = 3;
const PASS_BOUND: usize = 50;
const LIST_ATTEMPTS: usize = 8;
const PASS_PAUSE_MICROS: u32 = 5_000;

unsafe extern "C" {
    static SANDBOX_CHECK_NO_REPORT: c_int;
    fn proc_listallpids(buffer: *mut c_void, buffersize: c_int) -> c_int;
    fn proc_pidinfo(pid: c_int, flavor: c_int, arg: u64, buffer: *mut c_void, buffersize: c_int) -> c_int;
    // Variadic on purpose: on arm64 macOS the name argument then goes on the stack, where the C function reads it.
    fn sandbox_check_by_audit_token(token: AuditToken, operation: *const c_char, kind: c_int, ...) -> c_int;
    fn proc_signal_with_audittoken(token: *const AuditToken, sig: c_int) -> c_int;
    fn getpid() -> c_int;
    fn usleep(micros: u32) -> c_int;
    fn signal(sig: c_int, handler: usize) -> usize;
}

fn say(line: &str) {
    // Ave reads these lines; a closed stdout must not turn into a different exit code.
    let _ = writeln!(std::io::stdout().lock(), "{line}");
}

fn pids() -> Option<Vec<c_int>> {
    for _ in 0..LIST_ATTEMPTS {
        let count = unsafe { proc_listallpids(std::ptr::null_mut(), 0) };
        if count <= 0 {
            return None;
        }
        let capacity = count as usize + 256;
        let mut buffer = vec![0 as c_int; capacity];
        let got = unsafe { proc_listallpids(buffer.as_mut_ptr().cast(), (capacity * size_of::<c_int>()) as c_int) };
        if got <= 0 {
            return None;
        }
        if (got as usize) < capacity {
            buffer.truncate(got as usize);
            return Some(buffer);
        }
    }
    None // the list kept outgrowing the buffer
}

// None: the process went away between the list and the query.
fn token(pid: c_int) -> Option<AuditToken> {
    let mut uniq = std::mem::MaybeUninit::<ProcUniqIdentifierInfo>::zeroed();
    let mut short = std::mem::MaybeUninit::<ProcBsdShortInfo>::zeroed();
    let uniq_size = size_of::<ProcUniqIdentifierInfo>() as c_int;
    let short_size = size_of::<ProcBsdShortInfo>() as c_int;
    let a = unsafe { proc_pidinfo(pid, PROC_PIDUNIQIDENTIFIERINFO, 0, uniq.as_mut_ptr().cast(), uniq_size) };
    let b = unsafe { proc_pidinfo(pid, PROC_PIDT_SHORTBSDINFO, 0, short.as_mut_ptr().cast(), short_size) };
    if a != uniq_size || b != short_size {
        return None;
    }
    let (uniq, short) = unsafe { (uniq.assume_init(), short.assume_init()) };
    Some(AuditToken { val: [0, short.uid, short.gid, short.ruid, short.rgid, pid as u32, 0, uniq.idversion as u32] })
}

fn allowed(token: &AuditToken, name: &CString) -> bool {
    let filter = SANDBOX_FILTER_GLOBAL_NAME | unsafe { SANDBOX_CHECK_NO_REPORT };
    unsafe { sandbox_check_by_audit_token(*token, c"mach-lookup".as_ptr(), filter, name.as_ptr()) == 0 }
}

fn is_member(token: &AuditToken, label: &CString, control: &CString) -> bool {
    allowed(token, label) && !allowed(token, control)
}

// Members of one pass, each with the token its checks used.
fn members(label: &CString, control: &CString) -> Option<Vec<(c_int, AuditToken)>> {
    let me = unsafe { getpid() };
    let mut found = Vec::new();
    for pid in pids()? {
        if pid <= 1 || pid == me {
            continue;
        }
        let Some(token) = token(pid) else { continue };
        if is_member(&token, label, control) {
            found.push((pid, token));
        }
    }
    Some(found)
}

// Ok(()) signalled or already gone; Err(()) the kernel refused for another reason.
#[cfg(not(feature = "fixture"))]
fn kill(token: &AuditToken) -> Result<(), ()> {
    if unsafe { proc_signal_with_audittoken(token, SIGKILL) } == 0 {
        return Ok(());
    }
    if std::io::Error::last_os_error().raw_os_error() == Some(ESRCH) { Ok(()) } else { Err(()) }
}

// The test variant finds members and reports them signalled, but signals nothing.
#[cfg(feature = "fixture")]
fn kill(_token: &AuditToken) -> Result<(), ()> {
    Ok(())
}

fn sweep(label: &CString, control: &CString) -> i32 {
    let mut clean = 0;
    let mut signalled = 0usize;
    for round in 0..PASS_BOUND {
        let Some(found) = members(label, control) else {
            say(&format!("result failed signalled={signalled}"));
            return 70;
        };
        let refused = found.iter().filter(|(_, token)| kill(token).is_err()).count();
        signalled += found.len() - refused;
        say(&format!("pass {round} members={} refused={refused}", found.len()));
        if refused > 0 {
            say(&format!("result refused signalled={signalled}"));
            return 4;
        }
        if found.is_empty() {
            clean += 1;
            if clean == 2 {
                say(&format!("result clean signalled={signalled}"));
                return 0;
            }
        } else {
            clean = 0;
            unsafe { usleep(PASS_PAUSE_MICROS) };
        }
    }
    say(&format!("result unclean signalled={signalled}"));
    3
}

// The kernel must refuse a token whose pid version is stale, for the check and for the signal alike, and the process
// must still be a member afterwards.
fn prove(label: &CString, control: &CString) -> i32 {
    let Some(found) = members(label, control) else {
        say("result failed");
        return 70;
    };
    let Some((pid, member)) = found.first() else {
        say("result unproven members=0");
        return 5;
    };
    let mut stale = *member;
    stale.val[7] = stale.val[7].wrapping_add(1);
    let check_refused = !allowed(&stale, label);
    let signal_refused = unsafe { proc_signal_with_audittoken(&stale, SIGKILL) } != 0
        && std::io::Error::last_os_error().raw_os_error() == Some(ESRCH);
    let still_member = token(*pid).is_some_and(|again| again.val == member.val && is_member(&again, label, control));
    let proven = check_refused && signal_refused && still_member;
    say(&format!("result {} check={check_refused} signal={signal_refused} member={still_member}", if proven { "proven" } else { "unproven" }));
    if proven { 0 } else { 5 }
}

fn valid_name(name: &str) -> bool {
    let rest = name.strip_prefix("dev.ave.holder.").unwrap_or("");
    (1..=96).contains(&rest.len()) && rest.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.')
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 || !valid_name(&args[2]) || !valid_name(&args[3]) || args[2] == args[3] {
        std::process::exit(64);
    }
    let (Ok(label), Ok(control)) = (CString::new(args[2].as_str()), CString::new(args[3].as_str())) else {
        std::process::exit(64);
    };
    let code = match args[1].as_str() {
        "sweep" => sweep(&label, &control),
        "prove" => prove(&label, &control),
        "watch" => {
            for sig in [SIGHUP, SIGINT, SIGTERM, SIGPIPE] {
                unsafe { signal(sig, SIG_IGN) };
            }
            let mut sink = [0u8; 256];
            let mut stdin = std::io::stdin().lock();
            while matches!(stdin.read(&mut sink), Ok(n) if n > 0) {}
            sweep(&label, &control)
        }
        _ => 64,
    };
    std::process::exit(code);
}
