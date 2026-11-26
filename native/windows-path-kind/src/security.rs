use crate::windows::*;
use std::mem::size_of;
use std::ptr::{null, null_mut};

pub const SE_DACL_PROTECTED: u16 = 0x1000;

#[repr(C)]
struct SidAndAttributes {
    sid: Raw,
    attributes: u32,
}

#[repr(C)]
struct Acl {
    revision: u8,
    reserved: u8,
    size: u16,
    count: u16,
    reserved2: u16,
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn GetSecurityInfo(
        handle: Raw,
        kind: i32,
        info: u32,
        owner: *mut Raw,
        group: *mut Raw,
        dacl: *mut *mut Acl,
        sacl: *mut Raw,
        descriptor: *mut Raw,
    ) -> u32;
    fn IsValidSecurityDescriptor(descriptor: Raw) -> i32;
    fn GetSecurityDescriptorControl(descriptor: Raw, control: *mut u16, revision: *mut u32) -> i32;
    fn IsValidAcl(acl: *const Acl) -> i32;
    fn GetAce(acl: *const Acl, index: u32, ace: *mut Raw) -> i32;
    fn IsValidSid(sid: Raw) -> i32;
    pub fn EqualSid(first: Raw, second: Raw) -> i32;
    fn ConvertSidToStringSidW(sid: Raw, text: *mut *mut u16) -> i32;
    fn ConvertStringSidToSidW(text: *const u16, sid: *mut Raw) -> i32;
    fn ConvertStringSecurityDescriptorToSecurityDescriptorW(
        text: *const u16,
        revision: u32,
        descriptor: *mut Raw,
        length: *mut u32,
    ) -> i32;
    fn LookupAccountSidW(
        system: *const u16,
        sid: Raw,
        name: *mut u16,
        name_len: *mut u32,
        domain: *mut u16,
        domain_len: *mut u32,
        kind: *mut i32,
    ) -> i32;
    fn LookupAccountNameW(
        system: *const u16,
        name: *const u16,
        sid: Raw,
        sid_len: *mut u32,
        domain: *mut u16,
        domain_len: *mut u32,
        kind: *mut i32,
    ) -> i32;
    fn OpenProcessToken(process: Raw, access: u32, token: *mut Raw) -> i32;
    fn GetTokenInformation(token: Raw, class: i32, out: Raw, len: u32, returned: *mut u32) -> i32;
}

pub struct Descriptor {
    pub owner: Raw,
    pub group: Raw,
    pub control: u16,
    acl: *const Acl,
    _allocation: Local,
}

impl Descriptor {
    pub fn read(handle: Raw) -> Option<Self> {
        let mut owner = null_mut();
        let mut group = null_mut();
        let mut acl = null_mut();
        let mut control = 0;
        let mut revision = 0;
        let mut allocation = Local(null_mut());
        let result = unsafe {
            GetSecurityInfo(
                handle,
                1,
                7,
                &mut owner,
                &mut group,
                &mut acl,
                null_mut(),
                &mut allocation.0,
            )
        };
        if result != 0
            || allocation.0.is_null()
            || unsafe { IsValidSecurityDescriptor(allocation.0) } == 0
            || unsafe { GetSecurityDescriptorControl(allocation.0, &mut control, &mut revision) }
                == 0
            || (!acl.is_null() && unsafe { IsValidAcl(acl) } == 0)
        {
            return None;
        }
        Some(Self {
            owner,
            group,
            acl,
            control,
            _allocation: allocation,
        })
    }

    pub fn null_dacl(&self) -> bool {
        self.acl.is_null()
    }

    pub fn aces(&self) -> impl Iterator<Item = Option<Ace<'_>>> {
        let count = if self.null_dacl() {
            0
        } else {
            unsafe { (*self.acl).count }
        };
        (0..u32::from(count)).map(|index| {
            let mut raw = null_mut();
            check(unsafe { GetAce(self.acl, index, &mut raw) }).ok()?;
            // GetAce returns an aligned ACE within the validated descriptor.
            let len = unsafe { *raw.cast::<u16>().add(1) } as usize;
            Some(Ace(unsafe { std::slice::from_raw_parts(raw.cast(), len) }))
        })
    }
}

pub struct Ace<'a>(&'a [u8]);

impl Ace<'_> {
    pub fn kind(&self) -> u8 {
        self.0[0]
    }
    pub fn flags(&self) -> u8 {
        self.0[1]
    }

    pub fn mask(&self) -> Option<u32> {
        Some(u32::from_le_bytes(self.0.get(4..8)?.try_into().ok()?))
    }

    pub fn sid(&self, offset: usize) -> Option<Raw> {
        let bytes = self.0.get(offset..)?;
        let size = 8 + 4 * usize::from(*bytes.get(1)?);
        if bytes.len() < size {
            return None;
        }
        let sid = bytes.as_ptr().cast_mut().cast();
        (unsafe { IsValidSid(sid) } != 0).then_some(sid)
    }

    pub fn object_flags(&self) -> Option<u32> {
        let flags = u32::from_le_bytes(self.0.get(8..12)?.try_into().ok()?);
        (flags & !3 == 0).then_some(flags)
    }
}

pub fn sid_text(sid: Raw) -> Result<Vec<u16>, u32> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(1337);
    }
    let mut text = null_mut();
    check(unsafe { ConvertSidToStringSidW(sid, &mut text) })?;
    let _allocation = Local(text.cast());
    Ok(unsafe { wide_z(text) })
}

pub fn parse_sid(text: &[u16]) -> Option<Local> {
    let mut sid = Local(null_mut());
    check(unsafe { ConvertStringSidToSidW(c_wide(text).as_ptr(), &mut sid.0) }).ok()?;
    Some(sid)
}

pub fn account_text(sid: Raw) -> Option<Vec<u16>> {
    let (mut name_len, mut domain_len, mut kind) = (0, 0, 0);
    unsafe {
        LookupAccountSidW(
            null(),
            sid,
            null_mut(),
            &mut name_len,
            null_mut(),
            &mut domain_len,
            &mut kind,
        );
    }
    if name_len == 0 {
        return None;
    }
    let mut name = vec![0; name_len as usize];
    let mut domain = vec![0; domain_len as usize];
    check(unsafe {
        LookupAccountSidW(
            null(),
            sid,
            name.as_mut_ptr(),
            &mut name_len,
            domain.as_mut_ptr(),
            &mut domain_len,
            &mut kind,
        )
    })
    .ok()?;
    domain.truncate(before_nul(&domain).len());
    if domain_len != 0 {
        domain.push(92);
    }
    domain.extend_from_slice(before_nul(&name));
    Some(domain)
}

fn token() -> Result<Handle, u32> {
    let mut raw = null_mut();
    check(unsafe { OpenProcessToken(GetCurrentProcess(), 8, &mut raw) })?;
    unsafe { Handle::from_raw(raw) }
}

fn user_sid(token: Raw) -> Result<Vec<u16>, u32> {
    let mut needed = 0;
    unsafe {
        GetTokenInformation(token, 1, null_mut(), 0, &mut needed);
    }
    if (needed as usize) < size_of::<SidAndAttributes>() {
        return Err(last_error());
    }
    let mut storage = vec![0_usize; (needed as usize).div_ceil(size_of::<usize>())];
    check(unsafe {
        GetTokenInformation(token, 1, storage.as_mut_ptr().cast(), needed, &mut needed)
    })?;
    sid_text(unsafe { (*storage.as_ptr().cast::<SidAndAttributes>()).sid })
}

pub fn private_descriptor(rights: &str) -> Result<Local, u32> {
    let token = token()?;
    let sid = user_sid(token.raw())?;
    let text = [ascii(&format!("D:P(A;;{rights};;;")), sid, vec![41, 0]].concat();
    let mut descriptor = Local(null_mut());
    check(unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            text.as_ptr(),
            1,
            &mut descriptor.0,
            null_mut(),
        )
    })?;
    Ok(descriptor)
}

pub struct TokenContext {
    pub user: Vec<u16>,
    pub elevated: bool,
    pub principals: Vec<(Vec<u16>, &'static str)>,
}

pub fn context() -> Option<TokenContext> {
    let token = token().ok()?;
    let user = user_sid(token.raw()).ok()?;
    let mut elevated = 0_u32;
    let mut needed = 0;
    check(unsafe {
        GetTokenInformation(
            token.raw(),
            20,
            (&mut elevated as *mut u32).cast(),
            4,
            &mut needed,
        )
    })
    .ok()?;
    let mut machine = [0; 16];
    let mut size = machine.len() as u32;
    check(unsafe { GetComputerNameW(machine.as_mut_ptr(), &mut size) }).ok()?;
    let mut principals = vec![];
    for name in ["srt-sandbox", "sandbox-runtime-users"] {
        let qualified = [
            machine[..size as usize].to_vec(),
            vec![92],
            ascii(name),
            vec![0],
        ]
        .concat();
        let (mut sid_len, mut domain_len, mut kind) = (0, 0, 0);
        unsafe {
            LookupAccountNameW(
                null(),
                qualified.as_ptr(),
                null_mut(),
                &mut sid_len,
                null_mut(),
                &mut domain_len,
                &mut kind,
            );
        }
        if last_error() == 1332 {
            continue;
        }
        let mut sid = vec![0_u32; (sid_len as usize).div_ceil(4)];
        let mut domain = vec![0; domain_len as usize];
        let ptr = sid.as_mut_ptr().cast();
        check(unsafe {
            LookupAccountNameW(
                null(),
                qualified.as_ptr(),
                ptr,
                &mut sid_len,
                domain.as_mut_ptr(),
                &mut domain_len,
                &mut kind,
            )
        })
        .ok()?;
        principals.push((sid_text(ptr).ok()?, name));
    }
    Some(TokenContext {
        user,
        elevated: elevated != 0,
        principals,
    })
}

#[cfg(feature = "fixture")]
#[link(name = "advapi32")]
unsafe extern "system" {
    fn InitializeAcl(acl: *mut Acl, len: u32, revision: u32) -> i32;
    fn AddAce(acl: *mut Acl, revision: u32, index: u32, bytes: *const u8, len: u32) -> i32;
    fn AddAccessAllowedAceEx(acl: *mut Acl, revision: u32, flags: u32, mask: u32, sid: Raw) -> i32;
    fn SetSecurityInfo(
        file: Raw,
        kind: i32,
        info: u32,
        owner: Raw,
        group: Raw,
        dacl: *mut Acl,
        sacl: Raw,
    ) -> u32;
    fn GetLengthSid(sid: Raw) -> u32;
}

#[cfg(feature = "fixture")]
pub fn add_fixture_ace(file: Raw) -> Option<()> {
    let token = token().ok()?;
    let sid = parse_sid(&user_sid(token.raw()).ok()?)?;
    let previous = Descriptor::read(file)?;
    if previous.null_dacl() {
        return None;
    }
    let (size, revision) = unsafe { ((*previous.acl).size, (*previous.acl).revision) };
    let revision = u32::from(revision);
    let len = u32::from(size) + 8 + unsafe { GetLengthSid(sid.0) };
    let mut storage = vec![0_u32; (len as usize).div_ceil(4)];
    let acl = storage.as_mut_ptr().cast();
    check(unsafe { InitializeAcl(acl, len, revision) }).ok()?;
    for ace in previous.aces() {
        let ace = ace?;
        check(unsafe { AddAce(acl, revision, u32::MAX, ace.0.as_ptr(), ace.0.len() as u32) })
            .ok()?;
    }
    check(unsafe { AddAccessAllowedAceEx(acl, revision, 0, READ_ATTRIBUTES, sid.0) }).ok()?;
    let status = unsafe { SetSecurityInfo(file, 1, 4, null_mut(), null_mut(), acl, null_mut()) };
    (status == 0).then_some(())
}
