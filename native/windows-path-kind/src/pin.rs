use crate::windows::*;
use std::ptr::null_mut;

const SEPARATOR: u16 = b'\\' as u16;
const MOUNT_POINT: u32 = 0xa0000003;
const SYMLINK: u32 = 0xa000000c;

#[derive(Default)]
pub struct Facts {
    pub exists: Option<bool>,
    pub canonical: Vec<u16>,
    pub id: FileId,
    pub legacy: Legacy,
    pub change: i64,
    pub filesystem: Vec<u16>,
    pub tag: Tag,
    pub target: Vec<u16>,
}

pub struct PinnedPath {
    pub handles: Vec<Handle>,
    pub facts: Vec<Facts>,
}

fn dos_absolute(path: &[u16]) -> bool {
    matches!(path, [_, 58, SEPARATOR, ..])
}

pub fn components(input: &[u16]) -> Option<Vec<Vec<u16>>> {
    if input.starts_with(&ascii(r"\\.\")) {
        return None;
    }
    let mut path = if let Some(tail) = input.strip_prefix(ascii(r"\\?\UNC\").as_slice()) {
        [vec![SEPARATOR, SEPARATOR], tail.to_vec()].concat()
    } else {
        input
            .strip_prefix(ascii(r"\\?\").as_slice())
            .unwrap_or(input)
            .to_vec()
    };
    for unit in &mut path {
        if *unit == 47 {
            *unit = SEPARATOR;
        }
    }
    if !dos_absolute(&path) && !path.starts_with(&[SEPARATOR, SEPARATOR]) {
        return None;
    }
    let original = c_wide(&path);
    let length = unsafe { GetFullPathNameW(original.as_ptr(), 0, null_mut(), null_mut()) };
    if length == 0 || length > 32768 {
        return None;
    }
    path.resize(length as usize, 0);
    let written =
        unsafe { GetFullPathNameW(original.as_ptr(), length, path.as_mut_ptr(), null_mut()) };
    if written == 0 || written >= length {
        return None;
    }
    path.truncate(written as usize);

    let root = if dos_absolute(&path) {
        3
    } else if matches!(path.as_slice(), [SEPARATOR, SEPARATOR, first, ..] if *first != 46) {
        let server = path[2..].iter().position(|unit| *unit == SEPARATOR)? + 2;
        if server == 2 {
            return None;
        }
        let share_start = server + 1;
        let root_end = path[share_start..]
            .iter()
            .position(|unit| *unit == SEPARATOR)
            .map_or(path.len(), |offset| share_start + offset + 1);
        if root_end <= share_start {
            return None;
        }
        root_end
    } else {
        return None;
    };
    while path.len() > root && path.last() == Some(&SEPARATOR) {
        path.pop();
    }
    if path[root..].contains(&58) {
        return None;
    }

    let mut components = vec![path[..root].to_vec()];
    let mut end = root;
    for name in path[root..].split(|unit| *unit == SEPARATOR) {
        end += name.len();
        if !name.is_empty() {
            components.push(path[..end].to_vec());
        }
        end += 1;
    }
    Some(components)
}

pub fn child_name<'a>(above: &[u16], component: &'a [u16]) -> &'a [u16] {
    &component[above.len() + usize::from(above.last() != Some(&SEPARATOR))..]
}

pub(crate) fn read_facts(handle: Raw) -> Result<Facts, u32> {
    let tag = tag(handle)?;
    let id = file_id(handle)?;
    let change = basic(handle)?.change;
    let legacy = legacy(handle)?;
    let mut filesystem = vec![0; 261];
    if unsafe {
        GetVolumeInformationByHandleW(
            handle,
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    } != 0
    {
        filesystem.truncate(before_nul(&filesystem).len());
    } else {
        filesystem.clear();
    }

    let length = unsafe { GetFinalPathNameByHandleW(handle, null_mut(), 0, 0) };
    if length == 0 || length > 32768 {
        return Err(last_error());
    }
    let mut canonical = vec![0; length as usize + 1];
    let written = unsafe {
        GetFinalPathNameByHandleW(handle, canonical.as_mut_ptr(), canonical.len() as u32, 0)
    } as usize;
    if written == 0 || written >= canonical.len() {
        return Err(last_error());
    }
    canonical.truncate(written);
    Ok(Facts {
        exists: Some(true),
        canonical,
        id,
        legacy,
        change,
        filesystem,
        tag,
        target: vec![],
    })
}

fn reparse_target(handle: Raw, tag: u32) -> Option<Vec<u16>> {
    if tag != MOUNT_POINT && tag != SYMLINK {
        return Some(vec![]);
    }
    let mut bytes = vec![0; 16 * 1024];
    let mut returned = 0;
    check(unsafe {
        DeviceIoControl(
            handle,
            0x900a8,
            null_mut(),
            0,
            bytes.as_mut_ptr().cast(),
            bytes.len() as u32,
            &mut returned,
            null_mut(),
        )
    })
    .ok()?;
    if returned < 16 || u32::from_le_bytes(bytes[..4].try_into().ok()?) != tag {
        return None;
    }
    let field = |start| u16::from_le_bytes([bytes[start], bytes[start + 1]]) as usize;
    let length = field(4) + 8;
    let offset = field(8);
    let size = field(10);
    let start = if tag == SYMLINK { 20 } else { 16 };
    if length > returned as usize
        || size == 0
        || offset % 2 != 0
        || size % 2 != 0
        || start + offset + size > length
    {
        return None;
    }
    let target: Vec<_> = bytes[start + offset..start + offset + size]
        .chunks_exact(2)
        .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
        .collect();
    if target.contains(&0) {
        return None;
    }
    let flags = if tag == SYMLINK {
        u32::from_le_bytes(bytes[16..20].try_into().ok()?)
    } else {
        0
    };
    match flags {
        1 => {
            return (!matches!(target.first().copied(), Some(47 | SEPARATOR))
                && !target.contains(&58))
            .then_some(target);
        }
        0 => {}
        _ => return None,
    }
    let mut target = target;
    if target.starts_with(&ascii(r"\??\UNC\")) {
        target.splice(..8, [SEPARATOR, SEPARATOR]);
    } else if target.starts_with(&ascii(r"\??\")) {
        target.drain(..4);
    }
    (target.starts_with(&[SEPARATOR, SEPARATOR]) || dos_absolute(&target)).then_some(target)
}

pub fn verify(pinned: &PinnedPath) -> bool {
    pinned
        .handles
        .iter()
        .zip(&pinned.facts)
        .all(|(handle, previous)| {
            read_facts(handle.raw()).is_ok_and(|current| {
                current.id == previous.id
                    && current.tag == previous.tag
                    && current.canonical == previous.canonical
            })
        })
}

pub fn redirects(tag: Tag) -> bool {
    tag.attributes & REPARSE != 0 && (tag.reparse == 0 || tag.reparse & 0x20000000 != 0)
}

pub fn pin(input: &[u16], content: bool) -> Option<PinnedPath> {
    let components = components(input)?;
    pin_components(&components, content, false)
}

pub fn hold(input: &[u16]) -> Option<(PinnedPath, Vec<u16>)> {
    let mut components = components(input)?;
    let pinned = pin_components(&components, false, true)?;
    let leaf = pinned.facts.last()?;
    if pinned.handles.len() != components.len() || leaf.tag.attributes & DIRECTORY == 0 {
        return None;
    }
    Some((pinned, components.pop()?))
}

pub fn leaf_still_pinned(pinned: &PinnedPath, leaf: &[u16]) -> bool {
    verify(pinned)
        && open_root(leaf, READ_ATTRIBUTES, SHARE_ALL)
            .and_then(|handle| read_facts(handle.raw()))
            .is_ok_and(|current| {
                pinned
                    .facts
                    .last()
                    .is_some_and(|issued| current.id == issued.id)
                    && current.tag.attributes & REPARSE == 0
            })
}

fn pin_components(components: &[Vec<u16>], content: bool, hold: bool) -> Option<PinnedPath> {
    // Hold permits writes and traversal while denying delete sharing on every component.
    let (access, share) = if hold {
        (TRAVERSE, SHARE_READ | SHARE_WRITE)
    } else {
        (0, SHARE_READ)
    };
    let mut pinned = PinnedPath {
        handles: vec![],
        facts: vec![],
    };
    let mut blocked = false;
    let mut missing = false;
    for (index, component) in components.iter().enumerate() {
        if blocked || missing {
            pinned.facts.push(Facts {
                exists: missing.then_some(false),
                ..Facts::default()
            });
            continue;
        }
        let last = index + 1 == components.len();
        let access =
            access | READ_ATTRIBUTES | READ_CONTROL | if content && last { READ_DATA } else { 0 };
        let opened = if index == 0 {
            open_root(component, access, share)
        } else {
            open_relative(
                pinned.handles.last()?.raw(),
                child_name(&components[index - 1], component),
                access,
                share,
                OPEN,
                OPEN_REPARSE | BACKUP,
                null_mut(),
            )
            .map_err(|status| match status as u32 {
                0xc0000034 => 2,
                0xc000003a => 3,
                _ => 110,
            })
        };
        let handle = match opened {
            Ok(handle) => handle,
            Err(2 | 3) => {
                missing = true;
                pinned.facts.push(Facts {
                    exists: Some(false),
                    ..Facts::default()
                });
                continue;
            }
            Err(_) => return None,
        };
        let mut facts = read_facts(handle.raw()).ok()?;
        facts.target = reparse_target(handle.raw(), facts.tag.reparse)?;
        blocked = redirects(facts.tag);
        if !blocked && !last && facts.tag.attributes & DIRECTORY == 0 {
            return None;
        }
        pinned.handles.push(handle);
        pinned.facts.push(facts);
    }
    verify(&pinned).then_some(pinned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::windows::ffi::OsStrExt;

    #[test]
    fn hold_refuses_missing_paths_and_files_and_rechecks_the_issued_directory() {
        let current = std::env::current_dir().unwrap();
        let wide = |path: &std::path::Path| path.as_os_str().encode_wide().collect::<Vec<_>>();
        let (held, leaf) = hold(&wide(&current)).unwrap();
        assert!(leaf_still_pinned(&held, &leaf));
        assert!(hold(&wide(&current.join("Cargo.toml"))).is_none());
        assert!(!leaf_still_pinned(
            &held,
            &wide(&current.join("Cargo.toml"))
        ));
        assert!(hold(&wide(&current.join("missing").join("directory"))).is_none());
        assert!(open_root(&leaf, DELETE, SHARE_ALL).is_err());
        assert!(open_root(&leaf, WRITE_DATA, SHARE_ALL).is_ok());
    }

    #[test]
    fn unc_root_preserves_the_separator_after_the_share() {
        for root in [r"\\server\share", r"\\server\share\"] {
            assert_eq!(components(&ascii(root)), Some(vec![ascii(root)]));
        }
    }

    #[test]
    fn unc_descendants_keep_the_root_separator_and_resolve_relative_child_names() {
        let root = ascii(r"\\server\share\");
        let child = ascii(r"\\server\share\child");
        let descendant = ascii(r"\\server\share\child\file");
        for (input, expected) in [
            (r"\\server\share\child\", vec![root.clone(), child.clone()]),
            (
                r"\\?\UNC\server\share\child\file",
                vec![root, child, descendant],
            ),
        ] {
            let parts = components(&ascii(input)).unwrap();
            assert_eq!(parts, expected);
            assert_eq!(child_name(&parts[0], &parts[1]), ascii("child"));
            if parts.len() == 3 {
                assert_eq!(child_name(&parts[1], &parts[2]), ascii("file"));
            }
        }
    }
}
