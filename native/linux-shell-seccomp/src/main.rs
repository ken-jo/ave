use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::ffi::OsString;
use std::io;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::process::{Command, ExitCode};

use seccompiler::{
    BpfProgram, SeccompAction, SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompFilter,
    SeccompRule, TargetArch, apply_filter,
};

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

fn main() -> ExitCode {
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
