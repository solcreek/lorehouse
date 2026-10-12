//! A per-sandbox disk quota. A sandbox's disk is a reflink of the golden, so it costs
//! only what the guest changes, but nothing bounded that: a guest could write until the
//! state directory's filesystem was full, for every sandbox and the mirrors with it.
//!
//! On btrfs with quotas on, each new sandbox directory is a subvolume with an
//! exclusive-bytes limit (`btrfs qgroup limit -e`): what the reflink shares with the golden
//! doesn't count, what the guest writes does, and a write past the limit fails (EDQUOT,
//! which the guest sees as an I/O error on its disk). Simple quotas
//! (`btrfs quota enable --simple`) are enough and cheap. XFS would need project quotas,
//! which sandboxd doesn't set up (README.md says how). Elsewhere, or with quotas off, a
//! default limit is skipped with a warning at start; one set explicitly refuses the start.

use crate::config::DiskQuota;
use std::path::Path;
use tokio::process::Command;

// Compared as u32: statfs's f_type is signed and 32 bits wide on some targets.
const BTRFS_SUPER_MAGIC: u32 = 0x9123_683E;
const XFS_SUPER_MAGIC: u32 = 0x5846_5342;
/// A btrfs subvolume's root directory always has this inode number.
const SUBVOLUME_INO: u64 = 256;

#[derive(Clone, Debug, PartialEq)]
pub enum Quota {
    /// Each sandbox is a btrfs subvolume limited to this many exclusive bytes.
    Btrfs { bytes: u64 },
    Off,
}

/// The state directory's btrfs quota mode, from `btrfs quota status`.
#[derive(Debug, PartialEq)]
pub enum BtrfsQuotas {
    Off,
    /// Simple quotas: an extent counts against whoever wrote it, for good.
    Simple,
    /// Full qgroups: "exclusive" is recomputed as sharing changes, so replacing the golden
    /// would turn every sandbox's shared extents exclusive and put each over its limit.
    Full,
    /// No usable btrfs-progs to ask or to set limits with.
    NoTool,
}

#[derive(Debug, PartialEq)]
pub enum Fs {
    Btrfs(BtrfsQuotas),
    Xfs,
    Other,
}

/// The mode in `btrfs quota status` output ("Enabled: yes", "Mode: squota (…)").
pub fn quota_mode(status: &str) -> BtrfsQuotas {
    let field = |name: &str| status.lines().find_map(|l| l.trim().strip_prefix(name).map(|v| v.trim().to_string()));
    match (field("Enabled:").as_deref(), field("Mode:")) {
        (Some("yes"), Some(mode)) if mode.starts_with("squota") => BtrfsQuotas::Simple,
        (Some("yes"), _) => BtrfsQuotas::Full,
        _ => BtrfsQuotas::Off,
    }
}

fn fs_kind(f_type: u32) -> Option<bool> {
    match f_type {
        BTRFS_SUPER_MAGIC => Some(true),
        XFS_SUPER_MAGIC => Some(false),
        _ => None,
    }
}

/// What to enforce, given the filesystem and the setting. An explicit limit that can't be
/// enforced is an error (fail closed); the default one is skipped, with the reason.
pub fn decide(fs: &Fs, setting: &DiskQuota, mount_hint: &Path) -> Result<(Quota, Option<String>), String> {
    let (gib, explicit) = match *setting {
        DiskQuota::Off => return Ok((Quota::Off, None)),
        DiskQuota::Default(g) => (g, false),
        DiskQuota::Set(g) => (g, true),
    };
    let why = match fs {
        Fs::Btrfs(BtrfsQuotas::Simple) => return Ok((Quota::Btrfs { bytes: gib << 30 }, None)),
        Fs::Btrfs(BtrfsQuotas::Off) => {
            format!("quotas are off on this btrfs; turn them on with `btrfs quota enable --simple {}`", mount_hint.display())
        }
        Fs::Btrfs(BtrfsQuotas::Full) => {
            "this btrfs has full qgroups, where replacing the golden would put every sandbox over its limit; simple quotas are needed (`btrfs quota disable`, then `btrfs quota enable --simple`)".into()
        }
        Fs::Btrfs(BtrfsQuotas::NoTool) => "btrfs-progs (the `btrfs` command, with `quota status`) isn't available".into(),
        Fs::Xfs => "on XFS it would take project quotas, which sandboxd doesn't set up (README.md, \"Limits\")".into(),
        Fs::Other => "the state directory is on neither btrfs nor XFS".into(),
    };
    if explicit {
        Err(format!("SANDBOXD_DISK_QUOTA_GIB={gib} can't be enforced: {why}"))
    } else {
        Ok((Quota::Off, Some(format!("sandbox disks are not capped: {why}; set SANDBOXD_DISK_QUOTA_GIB=0 to silence this"))))
    }
}

async fn probe(state_dir: &Path) -> Result<Fs, String> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(state_dir.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
    // SAFETY: path is NUL-terminated and buf is a zeroed statfs the call fills in.
    let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statfs(path.as_ptr(), &mut buf) } != 0 {
        return Err(format!("statfs {}: {}", state_dir.display(), std::io::Error::last_os_error()));
    }
    #[allow(clippy::unnecessary_cast)] // f_type's type differs by target
    Ok(match fs_kind(buf.f_type as u32) {
        Some(true) => Fs::Btrfs(match Command::new("btrfs").args(["quota", "status"]).arg(state_dir).output().await {
            Ok(out) if out.status.success() => quota_mode(&String::from_utf8_lossy(&out.stdout)),
            _ => BtrfsQuotas::NoTool,
        }),
        Some(false) => Fs::Xfs,
        None => Fs::Other,
    })
}

/// At start: what this host can enforce, and a warning to log when it can't.
pub async fn detect(state_dir: &Path, setting: &DiskQuota) -> Result<Quota, String> {
    let fs = if *setting == DiskQuota::Off { Fs::Other } else { probe(state_dir).await? };
    let (quota, warning) = decide(&fs, setting, state_dir)?;
    match (&quota, warning) {
        (Quota::Btrfs { bytes }, _) => eprintln!("sandboxd: each sandbox's disk is capped at {} GiB of its own writes (btrfs qgroup)", bytes >> 30),
        (_, Some(w)) => eprintln!("sandboxd: WARNING: {w}"),
        _ => eprintln!("sandboxd: sandbox disks are not capped (SANDBOXD_DISK_QUOTA_GIB=0)"),
    }
    Ok(quota)
}

async fn btrfs(args: &[&str]) -> Result<(), String> {
    let out = Command::new("btrfs").args(args).output().await.map_err(|e| format!("btrfs: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("btrfs {}: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
    }
}

/// `btrfs qgroup limit` for a sandbox's subvolume: exclusive bytes, so the extents it
/// shares with the golden don't count.
pub fn limit_args(bytes: u64, dir: &Path) -> Vec<String> {
    vec!["qgroup".into(), "limit".into(), "-e".into(), bytes.to_string(), dir.display().to_string()]
}

/// The sandbox's directory, made if it's new (a subvolume, under a btrfs quota), and its
/// limit (re)applied, so a raised or lowered SANDBOXD_DISK_QUOTA_GIB reaches existing
/// sandboxes (0 doesn't lift a limit already set: `btrfs qgroup limit none <dir>`). A
/// directory made before quotas were on stays as it is, uncapped, and says so, even with
/// the quota set explicitly.
pub async fn prepare_dir(quota: &Quota, dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::MetadataExt;
    match quota {
        Quota::Off => tokio::fs::create_dir_all(dir).await.map_err(|e| format!("state dir: {e}")),
        Quota::Btrfs { bytes } => {
            if !dir.exists() {
                btrfs(&["subvolume", "create", &dir.to_string_lossy()]).await?;
            }
            let is_subvolume = tokio::fs::metadata(dir).await.is_ok_and(|m| m.ino() == SUBVOLUME_INO);
            if !is_subvolume {
                eprintln!("sandboxd: {} predates the disk quota (not a subvolume); its disk is not capped", dir.display());
                return Ok(());
            }
            let args = limit_args(*bytes, dir);
            btrfs(&args.iter().map(String::as_str).collect::<Vec<_>>()).await
        }
    }
}

/// After a sandbox's subvolume is deleted: its qgroup, once empty, removed (kernels before
/// 6.10 leave it). Best effort.
pub async fn after_destroy(quota: &Quota, state_dir: &Path) {
    if matches!(quota, Quota::Btrfs { .. }) {
        let _ = btrfs(&["qgroup", "clear-stale", &state_dir.to_string_lossy()]).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::DiskQuota;

    #[test]
    fn an_explicit_quota_that_cant_be_enforced_refuses_the_start() {
        let at = Path::new("/var/lib/lorehouse-sandboxes");
        let on = Fs::Btrfs(BtrfsQuotas::Simple);
        assert_eq!(decide(&on, &DiskQuota::Default(8), at).unwrap(), (Quota::Btrfs { bytes: 8 << 30 }, None));
        assert_eq!(decide(&on, &DiskQuota::Set(2), at).unwrap().0, Quota::Btrfs { bytes: 2 << 30 });
        for fs in [Fs::Btrfs(BtrfsQuotas::Off), Fs::Btrfs(BtrfsQuotas::Full), Fs::Btrfs(BtrfsQuotas::NoTool), Fs::Xfs, Fs::Other] {
            // The default: run, uncapped, and say why.
            let (q, warning) = decide(&fs, &DiskQuota::Default(8), at).unwrap();
            assert_eq!(q, Quota::Off);
            assert!(warning.is_some_and(|w| w.contains("not capped")), "{fs:?}");
            // Asked for explicitly: refuse.
            assert!(decide(&fs, &DiskQuota::Set(8), at).unwrap_err().contains("can't be enforced"), "{fs:?}");
        }
        assert!(decide(&Fs::Btrfs(BtrfsQuotas::Off), &DiskQuota::Default(8), at).unwrap().1.unwrap().contains("btrfs quota enable --simple /var/lib/lorehouse-sandboxes"));
        // Turned off: nothing to say.
        assert_eq!(decide(&Fs::Other, &DiskQuota::Off, at).unwrap(), (Quota::Off, None));
    }

    #[test]
    fn the_limit_counts_only_what_the_sandbox_writes() {
        // -e: exclusive bytes. Referenced bytes would count the golden's shared extents,
        // which under full qgroups is the whole image the moment it's reflinked.
        assert_eq!(limit_args(8 << 30, Path::new("/s/x")).join(" "), "qgroup limit -e 8589934592 /s/x");
        assert_eq!(fs_kind(BTRFS_SUPER_MAGIC), Some(true));
        assert_eq!(fs_kind(XFS_SUPER_MAGIC), Some(false));
        assert_eq!(fs_kind(0xEF53), None); // ext4
        // A 32-bit target's signed f_type, sign-extended, still reads as btrfs.
        assert_eq!(fs_kind(0x9123_683Eu32 as i32 as i64 as u32), Some(true));
    }

    #[test]
    fn only_simple_quotas_are_trusted() {
        // btrfs-progs 7.1's `btrfs quota status`, as seen on starship (2026-10-12).
        let simple = "Quotas on /x:\n  Enabled:                 yes\n  Mode:                    squota (simplified accounting)\n  Inconsistent:            no\n";
        assert_eq!(quota_mode(simple), BtrfsQuotas::Simple);
        assert_eq!(quota_mode("Quotas on /x:\n  Enabled:                 yes\n  Mode:                    qgroup (full accounting)\n"), BtrfsQuotas::Full);
        assert_eq!(quota_mode("Quotas on /var/lib/lorehouse-sandboxes:\n  Enabled: no\n"), BtrfsQuotas::Off);
    }
}
