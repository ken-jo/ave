use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::thread;

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule, TargetArch, apply_filter,
};

/// The longest Unix socket path `sockaddr_un` holds, without its terminating NUL.
const UNIX_PATH_MAX: usize = 107;

// Linux ABI values newer than the pinned libc headers.
const SYS_OPEN_TREE_ATTR: libc::c_long = 467;
const CLONE_EMPTY_MNTNS: u64 = 0x1_0000_0000;

fn filter() -> Result<BpfProgram, Box<dyn Error>> {
    let arch: TargetArch = env::consts::ARCH.try_into()?;
    let denied = SeccompAction::Errno(libc::EPERM as u32);
    let mut rules = BTreeMap::new();
    for syscall in [
        libc::SYS_setns,
        libc::SYS_mount,
        libc::SYS_umount2,
        libc::SYS_pivot_root,
        libc::SYS_open_tree,
        SYS_OPEN_TREE_ATTR,
        libc::SYS_move_mount,
        libc::SYS_fsopen,
        libc::SYS_fsconfig,
        libc::SYS_fsmount,
        libc::SYS_fspick,
        libc::SYS_mount_setattr,
        libc::SYS_io_uring_setup,
        libc::SYS_io_uring_enter,
        libc::SYS_io_uring_register,
    ] {
        rules.insert(syscall, vec![]);
    }
    // New mount and user namespaces must not be reachable through either legacy syscall.
    for syscall in [libc::SYS_clone, libc::SYS_unshare] {
        let mut flags = Vec::new();
        for flag in [libc::CLONE_NEWUSER as u64, libc::CLONE_NEWNS as u64, CLONE_EMPTY_MNTNS] {
            flags.push(SeccompRule::new(vec![SeccompCondition::new(
                0,
                SeccompCmpArgLen::Qword,
                SeccompCmpOp::MaskedEq(flag),
                flag,
            )?])?);
        }
        rules.insert(syscall, flags);
    }
    let mut socket_families = Vec::new();
    for family in [libc::AF_UNIX, libc::AF_VSOCK] {
        socket_families.push(SeccompRule::new(vec![SeccompCondition::new(
            0,
            SeccompCmpArgLen::Dword,
            SeccompCmpOp::Eq,
            family as u64,
        )?])?);
    }
    rules.insert(libc::SYS_socket, socket_families);
    // x32 syscall numbers share the x86-64 audit architecture.
    #[cfg(target_arch = "x86_64")]
    for (number, conditions) in rules.clone() {
        rules.insert(number | 0x4000_0000, conditions);
    }
    Ok(SeccompFilter::new(rules, SeccompAction::Allow, denied, arch)?.try_into()?)
}

fn clone3_filter() -> Result<BpfProgram, Box<dyn Error>> {
    // clone3 takes an indirect argument. ENOSYS lets libc retry ordinary thread creation with clone.
    #[cfg(target_arch = "x86_64")]
    let rules = BTreeMap::from([(libc::SYS_clone3, vec![]), (libc::SYS_clone3 | 0x4000_0000, vec![])]);
    #[cfg(target_arch = "aarch64")]
    let rules = BTreeMap::from([(libc::SYS_clone3, vec![])]);
    Ok(SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::ENOSYS as u32),
        env::consts::ARCH.try_into()?,
    )?
    .try_into()?)
}

/// What the helper does before it applies the filter and executes its command.
#[derive(Default)]
struct Launch {
    /// Close every descriptor above 2, except `ready` until it is written and those in `keep`.
    close_other_fds: bool,
    /// A descriptor that receives one `\n` once the filter is on, and is then closed.
    ready: Option<libc::c_int>,
    /// Descriptors `close_other_fds` leaves open for the command, such as an environment it reads.
    keep: Vec<libc::c_int>,
    /// Variables set for the command.
    env: Vec<(OsString, OsString)>,
    /// A loopback port in the command's network namespace, forwarded to a Unix socket outside the filter.
    bridge: Option<(u16, PathBuf)>,
}

fn descriptor(value: Option<OsString>, option: &str) -> Result<libc::c_int, Box<dyn Error>> {
    let value = value.ok_or_else(|| format!("{option} needs a descriptor"))?;
    let fd: libc::c_int = value
        .to_str()
        .and_then(|text| text.parse().ok())
        .filter(|fd| *fd > 2)
        .ok_or_else(|| format!("{option} needs a descriptor above 2"))?;
    // SAFETY: F_GETFD only reads the descriptor table.
    if unsafe { libc::fcntl(fd, libc::F_GETFD) } < 0 {
        return Err(format!("{option} {fd} is not open").into());
    }
    Ok(fd)
}

/// Options come first and end at `--`. Without options the first word is the command, as before.
fn parse(first: OsString, args: &mut impl Iterator<Item = OsString>) -> Result<(Launch, OsString), Box<dyn Error>> {
    let mut launch = Launch::default();
    if !first.as_bytes().starts_with(b"--") {
        return Ok((launch, first));
    }
    let mut option = first;
    loop {
        match option.to_str() {
            Some("--") => return Ok((launch, args.next().ok_or("missing command")?)),
            Some("--close-other-fds") => launch.close_other_fds = true,
            Some("--ready-fd") if launch.ready.is_none() => {
                launch.ready = Some(descriptor(args.next(), "--ready-fd")?)
            }
            Some("--keep-fd") => launch.keep.push(descriptor(args.next(), "--keep-fd")?),
            Some("--env") => {
                let pair = args.next().ok_or("--env needs NAME=VALUE")?;
                let bytes = pair.as_bytes();
                let split = bytes
                    .iter()
                    .position(|byte| *byte == b'=')
                    .filter(|index| *index > 0)
                    .ok_or("--env needs NAME=VALUE")?;
                launch.env.push((
                    OsString::from_vec(bytes[..split].to_vec()),
                    OsString::from_vec(bytes[split + 1..].to_vec()),
                ));
            }
            Some("--proxy-bridge") if launch.bridge.is_none() => {
                let port: u16 = args
                    .next()
                    .and_then(|value| value.to_str().and_then(|text| text.parse().ok()))
                    .filter(|port| *port != 0)
                    .ok_or("--proxy-bridge needs a port from 1 to 65535")?;
                let socket = PathBuf::from(args.next().ok_or("--proxy-bridge needs a socket path")?);
                if !socket.is_absolute() || socket.as_os_str().len() > UNIX_PATH_MAX {
                    return Err(format!("--proxy-bridge needs an absolute socket path of at most {UNIX_PATH_MAX} bytes").into());
                }
                launch.bridge = Some((port, socket));
            }
            _ => return Err(format!("unknown option {}", option.to_string_lossy()).into()),
        }
        option = args.next().ok_or("options must end with --")?;
    }
}

fn close_other_fds(open: &[libc::c_int]) -> Result<(), Box<dyn Error>> {
    let mut open = open.to_vec();
    open.sort_unstable();
    open.dedup();
    let mut first: libc::c_uint = 3;
    for fd in open.iter().map(|fd| *fd as libc::c_uint).chain([libc::c_uint::MAX]) {
        if fd > first {
            // SAFETY: close_range only closes descriptors this process owns; no Rust object holds one above 2.
            if unsafe { libc::syscall(libc::SYS_close_range, first, fd - 1, 0) } != 0 {
                return Err(io::Error::last_os_error().into());
            }
        }
        if fd == libc::c_uint::MAX {
            break;
        }
        first = fd + 1;
    }
    Ok(())
}

/// bwrap options that take a descriptor. The record carries the bytes of `--file` and `--seccomp`; any other one
/// cannot be replayed from a record, so the capture refuses it.
const CAPTURED_DESCRIPTOR_OPTIONS: [&str; 2] = ["--file", "--seccomp"];
const REFUSED_DESCRIPTOR_OPTIONS: [&str; 11] = [
    "--args",
    "--userns",
    "--userns2",
    "--pidns",
    "--info-fd",
    "--json-status-fd",
    "--block-fd",
    "--sync-fd",
    "--add-seccomp-fd",
    "--bind-data",
    "--ro-bind-data",
];
/// How many words follow each option the launcher's measured call uses (Ave's allowlist,
/// `mxc-linux-holder-launch.ts`). The capture walks the words by these arities, so an operand (an
/// environment value that reads `--`, `--file` or `--seccomp`) is never taken for an option.
const OPTION_ARITY: [(&str, usize); 21] = [
    ("--new-session", 0),
    ("--unshare-user", 0),
    ("--unshare-pid", 0),
    ("--unshare-ipc", 0),
    ("--unshare-uts", 0),
    ("--die-with-parent", 0),
    ("--unshare-net", 0),
    ("--symlink", 2),
    ("--ro-bind-try", 2),
    ("--dev", 1),
    ("--proc", 1),
    ("--tmpfs", 1),
    ("--dir", 1),
    ("--file", 2),
    ("--remount-ro", 1),
    ("--ro-bind", 2),
    ("--bind", 2),
    ("--chdir", 1),
    ("--clearenv", 0),
    ("--setenv", 2),
    ("--seccomp", 1),
];
/// The most bytes one captured descriptor may hold.
const CAPTURED_DESCRIPTOR_LIMIT: usize = 1 << 20;
const RECORD_MAGIC: &[u8; 8] = b"AVEBWRAP";

fn push_bytes(record: &mut Vec<u8>, bytes: &[u8]) {
    record.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    record.extend_from_slice(bytes);
}

fn read_descriptor(fd: libc::c_int) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut bytes = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        // SAFETY: reads into a local buffer from a descriptor the launcher handed to bwrap.
        let read = unsafe { libc::read(fd, chunk.as_mut_ptr().cast(), chunk.len()) };
        if read < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error.into());
        }
        if read == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&chunk[..read as usize]);
        if bytes.len() > CAPTURED_DESCRIPTOR_LIMIT {
            return Err(format!("descriptor {fd} holds more than {CAPTURED_DESCRIPTOR_LIMIT} bytes").into());
        }
    }
}

/// The call's words, then the bytes of each captured descriptor, as one record.
fn capture_record(args: &[OsString]) -> Result<Vec<u8>, Box<dyn Error>> {
    let mut record = RECORD_MAGIC.to_vec();
    record.push(b'R');
    record.extend_from_slice(&(args.len() as u32).to_le_bytes());
    for arg in args {
        push_bytes(&mut record, arg.as_bytes());
    }
    let mut descriptors = Vec::new();
    // Walked by arity up to the `--` that stands where an option would. An option outside the measured
    // set ends the walk: the record still carries every word, and Ave refuses that option by name.
    let mut index = 0;
    while index < args.len() {
        let Some(name) = args[index].to_str() else { break };
        if name == "--" {
            break;
        }
        if REFUSED_DESCRIPTOR_OPTIONS.contains(&name) {
            return Err(format!("{name} takes a descriptor the capture cannot replay").into());
        }
        let Some(&(_, arity)) = OPTION_ARITY.iter().find(|(option, _)| *option == name) else { break };
        if CAPTURED_DESCRIPTOR_OPTIONS.contains(&name) {
            let fd: libc::c_int = args
                .get(index + 1)
                .and_then(|value| value.to_str())
                .and_then(|text| text.parse().ok())
                .filter(|fd| *fd > 2)
                .ok_or_else(|| format!("{name} needs a descriptor above 2"))?;
            descriptors.push((fd, read_descriptor(fd)?));
        }
        index += 1 + arity;
    }
    record.extend_from_slice(&(descriptors.len() as u32).to_le_bytes());
    for (fd, bytes) in descriptors {
        record.extend_from_slice(&(fd as u32).to_le_bytes());
        push_bytes(&mut record, &bytes);
    }
    Ok(record)
}

fn write_all(fd: libc::c_int, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: writes from a live slice to the capture descriptor Ave handed the launcher.
        let written = unsafe { libc::write(fd, bytes.as_ptr().cast(), bytes.len()) };
        if written < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return Err(error);
        }
        bytes = &bytes[written as usize..];
    }
    Ok(())
}

/// Invoked as `bwrap` from the capture folder: record the launcher's call for Ave and exit, never run it. Only
/// `--version` reaches the real bwrap, named by Ave.
fn capture(args: Vec<OsString>) -> ExitCode {
    if args.len() == 1 && args[0] == "--version" {
        let error = match env::var_os("AVE_BWRAP_PATH") {
            Some(path) if PathBuf::from(&path).is_absolute() => Command::new(path).arg("--version").exec(),
            _ => io::Error::other("AVE_BWRAP_PATH must name the real bwrap by absolute path"),
        };
        eprintln!("Cannot report the bwrap version: {error}");
        return ExitCode::from(127);
    }
    let Some(fd) = env::var("AVE_BWRAP_CAPTURE_FD")
        .ok()
        .and_then(|text| text.parse::<libc::c_int>().ok())
        .filter(|fd| *fd > 2)
    else {
        eprintln!("Cannot capture the bwrap call: AVE_BWRAP_CAPTURE_FD names no descriptor");
        return ExitCode::from(1);
    };
    let (record, status) = match capture_record(&args) {
        Ok(record) => (record, ExitCode::SUCCESS),
        Err(error) => {
            let mut record = RECORD_MAGIC.to_vec();
            record.push(b'E');
            push_bytes(&mut record, error.to_string().as_bytes());
            (record, ExitCode::from(1))
        }
    };
    if let Err(error) = write_all(fd, &record) {
        eprintln!("Cannot write the bwrap capture record: {error}");
        return ExitCode::from(1);
    }
    status
}

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let first = args.next().ok_or("missing command")?;
    if first == "--check-unix-socket" {
        let path = args.next().ok_or("missing Unix socket path")?;
        return match UnixStream::connect(path) {
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => Ok(()),
            _ => Err("Unix socket creation was not refused".into()),
        };
    }
    let (launch, program) = parse(first, &mut args)?;
    if let Some((port, socket)) = &launch.bridge {
        let listener = TcpListener::bind(("127.0.0.1", *port))?;
        // Bound before the fork, so the command finds the port ready. The bridge stays outside the command's filter,
        // so it must be out of the command's reach: a non-dumpable process refuses /proc and ptrace access to a
        // process without CAP_SYS_PTRACE over it.
        #[cfg(not(feature = "dumpable-bridge-control"))]
        // SAFETY: prctl with PR_SET_DUMPABLE only changes this process's own flag.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error().into());
        }
        // SAFETY: the helper is single-threaded here; the child continues to exec and the parent starts threads only
        // after the fork.
        match unsafe { libc::fork() } {
            -1 => return Err(io::Error::last_os_error().into()),
            // The listener is close-on-exec, so the command never holds it.
            0 => {}
            child => bridge(listener, socket.clone(), child, launch.ready),
        }
    }
    for (name, value) in &launch.env {
        // SAFETY: the helper is single-threaded until it executes its command.
        unsafe { env::set_var(name, value) };
    }
    if launch.close_other_fds {
        let open: Vec<libc::c_int> = launch.keep.iter().copied().chain(launch.ready).collect();
        close_other_fds(&open)?;
    }
    let policy = filter()?;
    let clone3 = clone3_filter()?;
    apply_filter(&policy)?;
    apply_filter(&clone3)?;
    if let Some(ready) = launch.ready {
        // SAFETY: the descriptor was checked open; it is written once and closed before the command runs.
        let written = unsafe { libc::write(ready, b"\n".as_ptr().cast(), 1) };
        unsafe { libc::close(ready) };
        if written != 1 {
            return Err("cannot signal readiness".into());
        }
    }
    Err(Command::new(program).args(args).exec().into())
}

/// The parent after the fork: forward each loopback connection to the socket, then exit with the command's status.
fn bridge(listener: TcpListener, socket: PathBuf, child: libc::pid_t, ready: Option<libc::c_int>) -> ! {
    // Only the command writes the ready byte and holds the descriptors it keeps; the bridge keeps the listener.
    let keep = [listener.as_raw_fd()];
    if let Some(ready) = ready {
        // SAFETY: closing the bridge's copy; the command holds its own.
        unsafe { libc::close(ready) };
    }
    if close_other_fds(&keep).is_err() {
        // SAFETY: the command must not run without its bridge.
        unsafe { libc::kill(child, libc::SIGKILL) };
    }
    thread::spawn(move || {
        for connection in listener.incoming().flatten() {
            let socket = socket.clone();
            thread::spawn(move || forward(connection, &socket));
        }
    });
    let mut status = 0;
    loop {
        // SAFETY: waits for the bridge's own child.
        if unsafe { libc::waitpid(child, &mut status, 0) } == child {
            break;
        }
        if io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            std::process::exit(126);
        }
    }
    if libc::WIFEXITED(status) {
        std::process::exit(libc::WEXITSTATUS(status));
    }
    std::process::exit(128 + libc::WTERMSIG(status));
}

fn forward(connection: TcpStream, socket: &PathBuf) {
    let Ok(upstream) = UnixStream::connect(socket) else {
        let _ = connection.shutdown(Shutdown::Both);
        return;
    };
    let (Ok(mut from_command), Ok(mut to_upstream)) = (connection.try_clone(), upstream.try_clone()) else {
        return;
    };
    let outbound = thread::spawn(move || {
        let _ = io::copy(&mut from_command, &mut to_upstream);
        let _ = to_upstream.shutdown(Shutdown::Write);
    });
    let (mut from_upstream, mut to_command) = (upstream, connection);
    let _ = io::copy(&mut from_upstream, &mut to_command);
    let _ = to_command.shutdown(Shutdown::Write);
    let _ = outbound.join();
}

fn main() -> ExitCode {
    let invoked = env::args_os().next().unwrap_or_default();
    if PathBuf::from(invoked).file_name().is_some_and(|name| name == "bwrap") {
        return capture(env::args_os().skip(1).collect());
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("Cannot establish the shell filter or start its command: {error}");
            if error
                .downcast_ref::<io::Error>()
                .is_some_and(|error| error.kind() == io::ErrorKind::NotFound)
            {
                ExitCode::from(127)
            } else {
                ExitCode::from(126)
            }
        }
    }
}
