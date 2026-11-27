use std::collections::BTreeMap;
use std::env;
use std::error::Error;
use std::io;
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

fn run() -> Result<(), Box<dyn Error>> {
    let mut args = env::args_os().skip(1);
    let program = args.next().ok_or("missing command")?;
    if program == "--check-unix-socket" {
        let path = args.next().ok_or("missing Unix socket path")?;
        return match UnixStream::connect(path) {
            Err(error) if error.raw_os_error() == Some(libc::EPERM) => Ok(()),
            _ => Err("Unix socket creation was not refused".into()),
        };
    }
    let policy = filter()?;
    let clone3 = clone3_filter()?;
    apply_filter(&policy)?;
    apply_filter(&clone3)?;
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
