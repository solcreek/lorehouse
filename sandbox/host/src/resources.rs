//! What one sandbox gets: vCPUs, memory, disk, pids and how long one command may run.
//!
//! The host decides (docs/adr/0003-sandbox-trust-boundaries.md). A caller may send a
//! request with the calls that create a sandbox:
//!
//!   { "vcpus": 4, "memMib": 4096, "diskGib": 16, "pids": 128, "commandTimeoutSecs": 1800 }
//!
//! Every field is optional. One left out gets this host's default, the ones sandboxd has
//! always used (SANDBOXD_VCPUS, SANDBOXD_MEM_MIB, SANDBOXD_DISK_QUOTA_GIB, 64 pids, 10
//! minutes). One asked for is granted as asked, or the whole request is refused with a
//! code: it is never clamped, so a caller never believes it has what it doesn't.
//!
//!   invalid_resources       400  not an object, an unknown field, a value that isn't a
//!                                whole number, or one under the field's minimum
//!   resource_over_maximum   422  over this install's maximum (SANDBOXD_MAX_*; each
//!                                defaults to the default, so an install that sets none
//!                                grants nothing beyond it)
//!   disk_quota_unavailable  422  a disk size asked of a host that can't cap disks
//!   resources_mismatch      409  the sandbox exists already, with other values
//!
//! Resources are fixed when the sandbox is created (its disk is made): the grant is kept
//! in `<state>/<id>/resources.json` and every later boot uses it. A later request for the
//! same sandbox is a statement about it: fine if every field it asks for is what the
//! sandbox has (so a replay is fine), refused as a mismatch otherwise. Nothing is resized.

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::path::Path;

/// What a runner's status and `GET /v1/capabilities` list when requests are understood.
/// A sandboxd without it ignores a request, so Lorehouse refuses to send it one.
pub const FEATURE: &str = "resources";
/// The serve API's request header: the request as JSON.
pub const HEADER: &str = "x-lorehouse-sandbox-resources";
/// The grant, in the sandbox's directory (root's; the VM's uid only owns its jail).
pub const FILE: &str = "resources.json";

pub const DEFAULT_PIDS: u64 = 64;
pub const DEFAULT_COMMAND_TIMEOUT_SECS: u64 = 600;
/// A VM's cgroup holds Firecracker's threads, not the guest's processes: one per vCPU and
/// a few of its own (5 at 2 vCPUs). Fewer pids than this over its vCPUs and it can't boot.
pub const PIDS_OVER_VCPUS: u64 = 8;
/// After a command's own timeout, how long the host still waits for guestd's answer
/// before it drops the call (which kills the command): 10 min + this is the 15.5 min
/// backstop sandboxd has always had.
const BACKSTOP_SLACK_SECS: u64 = 330;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Field {
    Vcpus,
    MemMib,
    DiskGib,
    Pids,
    CommandTimeoutSecs,
}

pub const FIELDS: [Field; 5] = [Field::Vcpus, Field::MemMib, Field::DiskGib, Field::Pids, Field::CommandTimeoutSecs];

impl Field {
    /// Its name on the wire and in a profile.
    pub fn name(self) -> &'static str {
        match self {
            Field::Vcpus => "vcpus",
            Field::MemMib => "memMib",
            Field::DiskGib => "diskGib",
            Field::Pids => "pids",
            Field::CommandTimeoutSecs => "commandTimeoutSecs",
        }
    }

    /// The setting that holds this install's maximum for it.
    pub fn max_setting(self) -> &'static str {
        match self {
            Field::Vcpus => "SANDBOXD_MAX_VCPUS",
            Field::MemMib => "SANDBOXD_MAX_MEM_MIB",
            Field::DiskGib => "SANDBOXD_MAX_DISK_GIB",
            Field::Pids => "SANDBOXD_MAX_PIDS",
            Field::CommandTimeoutSecs => "SANDBOXD_MAX_COMMAND_TIMEOUT_SECS",
        }
    }

    /// The least and the most any install may grant (a maximum is set within these).
    pub fn bounds(self) -> (u64, u64) {
        match self {
            Field::Vcpus => (1, 32), // Firecracker's limit
            Field::MemMib => (128, 262_144),
            Field::DiskGib => (1, 65_536),
            Field::Pids => (16, 4096),
            Field::CommandTimeoutSecs => (1, 6 * 3600), // longer is a background job
        }
    }

    fn unit(self) -> &'static str {
        match self {
            Field::Vcpus => "vCPUs",
            Field::MemMib => "MiB of memory",
            Field::DiskGib => "GiB of disk",
            Field::Pids => "pids",
            Field::CommandTimeoutSecs => "seconds per command",
        }
    }
}

fn names() -> String {
    FIELDS.map(Field::name).join(", ")
}

/// A request, parsed: what was asked for, and nothing about whether it is granted.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Request {
    pub vcpus: Option<u64>,
    pub mem_mib: Option<u64>,
    pub disk_gib: Option<u64>,
    pub pids: Option<u64>,
    pub command_timeout_secs: Option<u64>,
}

impl Request {
    pub fn get(&self, f: Field) -> Option<u64> {
        match f {
            Field::Vcpus => self.vcpus,
            Field::MemMib => self.mem_mib,
            Field::DiskGib => self.disk_gib,
            Field::Pids => self.pids,
            Field::CommandTimeoutSecs => self.command_timeout_secs,
        }
    }

    fn slot(&mut self, f: Field) -> &mut Option<u64> {
        match f {
            Field::Vcpus => &mut self.vcpus,
            Field::MemMib => &mut self.mem_mib,
            Field::DiskGib => &mut self.disk_gib,
            Field::Pids => &mut self.pids,
            Field::CommandTimeoutSecs => &mut self.command_timeout_secs,
        }
    }

    /// Asks for nothing: the same as no request.
    pub fn is_empty(&self) -> bool {
        FIELDS.iter().all(|f| self.get(*f).is_none())
    }
}

/// What a sandbox has. `disk_gib` None: its disk isn't capped (the host's quota is off).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Granted {
    pub vcpus: u64,
    pub mem_mib: u64,
    pub disk_gib: Option<u64>,
    pub pids: u64,
    pub command_timeout_secs: u64,
}

impl Granted {
    pub fn get(&self, f: Field) -> Option<u64> {
        match f {
            Field::Vcpus => Some(self.vcpus),
            Field::MemMib => Some(self.mem_mib),
            Field::DiskGib => self.disk_gib,
            Field::Pids => Some(self.pids),
            Field::CommandTimeoutSecs => Some(self.command_timeout_secs),
        }
    }

    /// "vcpus 2, memMib 2048, diskGib 8, pids 64, commandTimeoutSecs 600", for a message
    /// or a log line.
    pub fn describe(&self) -> String {
        FIELDS.map(|f| format!("{} {}", f.name(), self.get(f).map_or("uncapped".to_string(), |v| v.to_string()))).join(", ")
    }

    /// The disk quota in bytes, where there is one.
    pub fn disk_bytes(&self) -> Option<u64> {
        self.disk_gib.map(|g| g << 30)
    }

    /// How long the host waits for one `POST /exec` before dropping it.
    pub fn exec_backstop(&self) -> std::time::Duration {
        std::time::Duration::from_secs(self.command_timeout_secs + BACKSTOP_SLACK_SECS)
    }

    /// A `POST /exec` body as guestd gets it: `timeoutMs` is what the caller asked, and
    /// never more than this sandbox's command timeout (none asked: that timeout). guestd
    /// kills the command's process group at it (exit code 124). A body that isn't a JSON
    /// object goes through as it is, for guestd to refuse.
    pub fn cap_exec_timeout(&self, body: Bytes) -> Bytes {
        let Ok(Value::Object(mut o)) = serde_json::from_slice::<Value>(&body) else { return body };
        let limit = self.command_timeout_secs.saturating_mul(1000);
        let asked = o.get("timeoutMs").and_then(Value::as_u64).filter(|ms| *ms > 0).unwrap_or(limit);
        o.insert("timeoutMs".into(), json!(asked.min(limit)));
        serde_json::to_vec(&o).map(Bytes::from).unwrap_or(body)
    }
}

/// This install's maxima, from sandboxd's own environment.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Maxima {
    pub vcpus: u64,
    pub mem_mib: u64,
    /// 0 where the disk quota is off: no size can be asked for there.
    pub disk_gib: u64,
    pub pids: u64,
    pub command_timeout_secs: u64,
}

impl Maxima {
    /// Nothing beyond the defaults: what an install that sets no maximum has.
    pub fn of_defaults(vcpus: u64, mem_mib: u64, disk_gib: u64) -> Maxima {
        Maxima { vcpus, mem_mib, disk_gib, pids: DEFAULT_PIDS, command_timeout_secs: DEFAULT_COMMAND_TIMEOUT_SECS }
    }

    pub fn get(&self, f: Field) -> u64 {
        match f {
            Field::Vcpus => self.vcpus,
            Field::MemMib => self.mem_mib,
            Field::DiskGib => self.disk_gib,
            Field::Pids => self.pids,
            Field::CommandTimeoutSecs => self.command_timeout_secs,
        }
    }
}

/// A request refused, for the caller (a model's tool error, an operator's log) to act on
/// without the source: a stable code, and a message that names the field, what was asked,
/// the limit and the next step.
#[derive(Clone, Debug, PartialEq)]
pub struct Refusal {
    pub status: u16,
    pub code: &'static str,
    pub message: String,
    /// `field`, and the numbers the message names (`asked`, `maximum`, `minimum`, `has`).
    pub detail: Map<String, Value>,
}

pub const INVALID: &str = "invalid_resources";
pub const OVER_MAXIMUM: &str = "resource_over_maximum";
pub const NO_DISK_QUOTA: &str = "disk_quota_unavailable";
pub const MISMATCH: &str = "resources_mismatch";

impl Refusal {
    fn new(status: u16, code: &'static str, message: String, detail: Value) -> Refusal {
        let detail = match detail {
            Value::Object(m) => m,
            _ => Map::new(),
        };
        Refusal { status, code, message, detail }
    }

    fn invalid(field: Option<&str>, message: String) -> Refusal {
        Refusal::new(400, INVALID, message, field.map_or(json!({}), |f| json!({ "field": f })))
    }

    /// The serve API's error body: `{ "error", "code", "field"?, "asked"?, … }`.
    pub fn body(&self) -> Value {
        let mut o = self.detail.clone();
        o.insert("error".into(), json!(self.message));
        o.insert("code".into(), json!(self.code));
        Value::Object(o)
    }
}

/// A request as it arrived (a job's `resources`, or the serve API's header as JSON).
pub fn parse(v: &Value) -> Result<Request, Refusal> {
    let Value::Object(o) = v else {
        return Err(Refusal::invalid(None, format!("resources must be an object with any of {}, each a whole number; got {}. Nothing was created or changed", names(), shown(v))));
    };
    let mut req = Request::default();
    for (key, value) in o {
        let Some(field) = FIELDS.into_iter().find(|f| f.name() == key) else {
            return Err(Refusal::invalid(Some(key.as_str()),format!("resources.{key} is not a resource this host knows (it knows {}). Remove it; nothing was created or changed", names())));
        };
        let (min, _) = field.bounds();
        let Some(n) = value.as_u64() else {
            return Err(Refusal::invalid(Some(key.as_str()),format!("resources.{key} must be a whole number of {}, at least {min}; got {}. Nothing was created or changed", field.unit(), shown(value))));
        };
        if n < min {
            let mut r = Refusal::invalid(Some(key.as_str()),format!("resources.{key} must be at least {min} ({}); got {n}. Nothing was created or changed", field.unit()));
            r.detail.insert("asked".into(), json!(n));
            r.detail.insert("minimum".into(), json!(min));
            return Err(r);
        }
        *req.slot(field) = Some(n);
    }
    Ok(req)
}

/// The serve API's header.
pub fn parse_header(text: &str) -> Result<Request, Refusal> {
    match serde_json::from_str::<Value>(text) {
        Ok(v) => parse(&v),
        Err(e) => Err(Refusal::invalid(None, format!("the {HEADER} header must be a JSON object with any of {} ({e}). Nothing was created or changed", names()))),
    }
}

fn shown(v: &Value) -> String {
    let s = v.to_string();
    if s.chars().count() > 80 {
        format!("{}…", s.chars().take(80).collect::<String>())
    } else {
        s
    }
}

/// The defaults and the maxima together: what decides a request.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Policy {
    /// What a sandbox created with no request gets. `disk_gib` None: the quota is off
    /// here (set to 0, or the state directory's filesystem has none sandboxd can use).
    pub defaults: Granted,
    pub maxima: Maxima,
}

impl Policy {
    /// A new sandbox's grant: the request where it asks, the defaults elsewhere.
    pub fn grant(&self, req: &Request) -> Result<Granted, Refusal> {
        if let Some(asked) = req.disk_gib.filter(|_| self.defaults.disk_gib.is_none()) {
            return Err(no_disk_quota(asked, "its disk quota is off (SANDBOXD_DISK_QUOTA_GIB=0, or the state directory's filesystem has no quota sandboxd can use)"));
        }
        for f in FIELDS {
            let (Some(asked), max) = (req.get(f), self.maxima.get(f)) else { continue };
            if asked > max {
                return Err(over_maximum(f, asked, max, "Nothing was created or changed"));
            }
        }
        let or = |f: Field| req.get(f).or(self.defaults.get(f));
        let g = Granted {
            vcpus: or(Field::Vcpus).unwrap_or(self.defaults.vcpus),
            mem_mib: or(Field::MemMib).unwrap_or(self.defaults.mem_mib),
            disk_gib: or(Field::DiskGib),
            pids: or(Field::Pids).unwrap_or(self.defaults.pids),
            command_timeout_secs: or(Field::CommandTimeoutSecs).unwrap_or(self.defaults.command_timeout_secs),
        };
        if g.pids < g.vcpus + PIDS_OVER_VCPUS {
            let need = g.vcpus + PIDS_OVER_VCPUS;
            let mut r = Refusal::invalid(
                Some("pids"),
                format!("resources.pids {} is too few for {} vCPUs: the VM's own threads count against it (one per vCPU and a few more), so it needs at least {need}. Ask for pids {need} or more, or fewer vcpus; nothing was created or changed", g.pids, g.vcpus),
            );
            r.detail.insert("asked".into(), json!(g.pids));
            r.detail.insert("minimum".into(), json!(need));
            return Err(r);
        }
        Ok(g)
    }

    /// A request for a sandbox that exists, which has `has`: every field it asks for
    /// must be what the sandbox has.
    pub fn check_existing(&self, id: &str, has: &Granted, req: &Request) -> Result<(), Refusal> {
        if let Some(asked) = req.disk_gib.filter(|_| self.defaults.disk_gib.is_none() && has.disk_gib.is_none()) {
            return Err(no_disk_quota(asked, "its disk quota is off (SANDBOXD_DISK_QUOTA_GIB=0, or the state directory's filesystem has no quota sandboxd can use)"));
        }
        let differs: Vec<Field> = FIELDS.into_iter().filter(|f| req.get(*f).is_some_and(|asked| has.get(*f) != Some(asked))).collect();
        let Some(first) = differs.first() else { return Ok(()) };
        let asked = differs.iter().map(|f| format!("{} {}", f.name(), req.get(*f).unwrap_or_default())).collect::<Vec<_>>().join(", ");
        Err(Refusal::new(
            409,
            MISMATCH,
            format!(
                "sandbox {id} already exists with {}, and this request asks for {asked}. A sandbox's resources are fixed when it is created and it is never resized: ask for what it has, or destroy the sandbox (its checkout goes with it) so the next request creates it anew. Nothing was changed",
                has.describe()
            ),
            json!({ "field": first.name(), "asked": req.get(*first), "has": has.get(*first) }),
        ))
    }

    /// Before a boot: a grant made under higher maxima than the install has now is not
    /// honored, and not shrunk either.
    pub fn recheck(&self, id: &str, stored: &Granted) -> Result<(), Refusal> {
        for f in FIELDS {
            // An uncapped disk is no grant; a capped one on a host whose quota is now off
            // would go unenforced.
            let Some(has) = stored.get(f) else { continue };
            if f == Field::DiskGib && self.defaults.disk_gib.is_none() {
                return Err(no_disk_quota(has, &format!("sandbox {id} was created with that cap, and the host's disk quota has been turned off since; destroy the sandbox, or turn the quota back on")));
            }
            let max = self.maxima.get(f);
            if has > max {
                return Err(over_maximum(f, has, max, &format!("Sandbox {id} was created with it under a higher maximum; it is not started, and not shrunk. Destroy the sandbox (its checkout goes with it), or raise the maximum again")));
            }
        }
        Ok(())
    }
}

fn over_maximum(f: Field, asked: u64, max: u64, then: &str) -> Refusal {
    let (name, setting) = (f.name(), f.max_setting());
    Refusal::new(
        422,
        OVER_MAXIMUM,
        format!("resources.{name} {asked} is over this sandbox host's maximum of {max} ({}; {setting}). Ask for at most {max}, or have the host's operator raise {setting} in sandboxd's environment. {then}", f.unit()),
        json!({ "field": name, "asked": asked, "maximum": max }),
    )
}

fn no_disk_quota(asked: u64, why: &str) -> Refusal {
    Refusal::new(
        422,
        NO_DISK_QUOTA,
        format!("resources.diskGib {asked} can't be honored: this sandbox host can't cap a sandbox's disk ({why}), so a size would be accepted and not enforced. Leave diskGib out to run with an uncapped disk, or have the host's operator turn the quota on (sandbox/host/README.md, \"Limits\"). Nothing was created or changed"),
        json!({ "field": "diskGib", "asked": asked }),
    )
}

/// A disk size asked of a sandbox whose directory no limit holds on (it was made before
/// the quota was on, so it is no subvolume): the number may agree, the cap isn't there.
pub fn uncapped_directory(id: &str, asked: u64) -> Refusal {
    no_disk_quota(asked, &format!("sandbox {id}'s directory has no quota: it was made before the host's disk quota was on, and stays uncapped; destroy the sandbox so the next request creates it capped"))
}

/// The grant a sandbox was created with, if it was created with a request.
pub fn read_stored(dir: &Path) -> Result<Option<Granted>, String> {
    let path = dir.join(FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("{}: {e}; it records what the sandbox was created with, so the sandbox isn't started without it. Destroy the sandbox, or restore the file", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// Written whole or not at all, before the sandbox's disk is made.
pub fn store(dir: &Path, granted: &Granted) -> Result<(), String> {
    let (path, tmp) = (dir.join(FILE), dir.join(format!("{FILE}.tmp")));
    let write = || -> std::io::Result<()> {
        std::fs::write(&tmp, serde_json::to_vec(granted).map_err(std::io::Error::other)?)?;
        std::fs::rename(&tmp, &path)
    };
    write().map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// An install that raised every maximum, with the disk quota on.
    pub fn roomy() -> Policy {
        Policy {
            defaults: Granted { vcpus: 2, mem_mib: 2048, disk_gib: Some(8), pids: 64, command_timeout_secs: 600 },
            maxima: Maxima { vcpus: 8, mem_mib: 8192, disk_gib: 32, pids: 256, command_timeout_secs: 3600 },
        }
    }

    /// An install that set nothing.
    fn stock() -> Policy {
        let defaults = Granted { vcpus: 2, mem_mib: 2048, disk_gib: Some(8), pids: 64, command_timeout_secs: 600 };
        Policy { defaults, maxima: Maxima::of_defaults(2, 2048, 8) }
    }

    fn req(v: Value) -> Request {
        parse(&v).unwrap()
    }

    #[test]
    fn a_request_is_an_object_of_known_fields_each_a_whole_number_at_or_over_its_minimum() {
        assert_eq!(req(json!({})), Request::default());
        assert!(req(json!({})).is_empty());
        let all = req(json!({ "vcpus": 4, "memMib": 4096, "diskGib": 16, "pids": 128, "commandTimeoutSecs": 1800 }));
        assert_eq!(all, Request { vcpus: Some(4), mem_mib: Some(4096), disk_gib: Some(16), pids: Some(128), command_timeout_secs: Some(1800) });
        assert_eq!(req(json!({ "memMib": 4096 })), Request { mem_mib: Some(4096), ..Request::default() });
        // Not an object at all.
        for v in [json!(null), json!("4"), json!(4), json!([{ "vcpus": 4 }])] {
            let r = parse(&v).unwrap_err();
            assert_eq!((r.status, r.code), (400, INVALID), "{v}");
            assert!(r.message.contains("must be an object") && r.message.contains("commandTimeoutSecs"), "{}", r.message);
        }
        // Zero, negative, a fraction, a string, null, absurd: each names the field and what it got.
        for (v, field) in [
            (json!({ "vcpus": 0 }), "vcpus"),
            (json!({ "vcpus": -2 }), "vcpus"),
            (json!({ "memMib": 2048.5 }), "memMib"),
            (json!({ "memMib": 2048.0 }), "memMib"),
            (json!({ "memMib": 64 }), "memMib"),
            (json!({ "diskGib": "16" }), "diskGib"),
            (json!({ "pids": null }), "pids"),
            (json!({ "pids": 8 }), "pids"),
            (json!({ "pids": true }), "pids"),
            (json!({ "commandTimeoutSecs": 1e30 }), "commandTimeoutSecs"),
            (json!({ "commandTimeoutSecs": [600] }), "commandTimeoutSecs"),
        ] {
            let r = parse(&v).unwrap_err();
            assert_eq!((r.status, r.code, r.detail["field"].as_str()), (400, INVALID, Some(field)), "{v}");
            assert!(r.message.contains(&format!("resources.{field}")), "{}", r.message);
        }
        // An unknown field is refused, not ignored: nothing would honor it.
        let r = parse(&json!({ "vcpus": 2, "gpus": 1 })).unwrap_err();
        assert_eq!((r.code, r.detail["field"].as_str()), (INVALID, Some("gpus")));
        assert!(r.message.contains("vcpus, memMib, diskGib, pids, commandTimeoutSecs"), "{}", r.message);
        // Snake case is not the wire's name.
        assert_eq!(parse(&json!({ "mem_mib": 4096 })).unwrap_err().code, INVALID);
        // The header: JSON, then the same rules.
        assert_eq!(parse_header(r#"{"vcpus":4}"#).unwrap(), Request { vcpus: Some(4), ..Request::default() });
        for bad in ["", "vcpus=4", "{", r#"{"vcpus":0}"#] {
            assert_eq!(parse_header(bad).unwrap_err().code, INVALID, "{bad}");
        }
    }

    #[test]
    fn no_request_and_an_empty_one_get_the_defaults() {
        for p in [stock(), roomy()] {
            assert_eq!(p.grant(&Request::default()).unwrap(), p.defaults);
            assert_eq!(p.grant(&Request::default()).unwrap().describe(), "vcpus 2, memMib 2048, diskGib 8, pids 64, commandTimeoutSecs 600");
        }
    }

    #[test]
    fn each_field_is_granted_at_and_under_its_maximum_and_refused_over_it() {
        let p = roomy();
        for (f, max) in [(Field::Vcpus, 8), (Field::MemMib, 8192), (Field::DiskGib, 32), (Field::Pids, 256), (Field::CommandTimeoutSecs, 3600)] {
            let ask = |n: u64| {
                let mut r = Request::default();
                *r.slot(f) = Some(n);
                p.grant(&r)
            };
            // At the maximum, and under it (more or less than the default): as asked, the
            // other fields at their defaults.
            for n in [max, max - 1, f.bounds().0] {
                let g = ask(n).unwrap_or_else(|r| panic!("{} {n}: {}", f.name(), r.message));
                assert_eq!(g.get(f), Some(n), "{}", f.name());
                for other in FIELDS.into_iter().filter(|o| *o != f) {
                    assert_eq!(g.get(other), p.defaults.get(other), "{} moved with {}", other.name(), f.name());
                }
            }
            // Over it: refused, never clamped, saying the field, both numbers and the setting.
            let r = ask(max + 1).unwrap_err();
            assert_eq!((r.status, r.code), (422, OVER_MAXIMUM), "{}", f.name());
            assert_eq!(r.body(), json!({ "error": r.message, "code": "resource_over_maximum", "field": f.name(), "asked": max + 1, "maximum": max }));
            for part in [format!("resources.{} {}", f.name(), max + 1), format!("maximum of {max}"), f.max_setting().to_string(), format!("at most {max}"), "Nothing was created".to_string()] {
                assert!(r.message.contains(&part), "{part:?} not in {}", r.message);
            }
            assert!(ask(u64::MAX).is_err());
        }
    }

    #[test]
    fn an_install_that_sets_no_maximum_grants_nothing_beyond_the_defaults() {
        let p = stock();
        for v in [json!({ "vcpus": 3 }), json!({ "memMib": 2049 }), json!({ "diskGib": 9 }), json!({ "pids": 65 }), json!({ "commandTimeoutSecs": 601 })] {
            assert_eq!(p.grant(&req(v.clone())).unwrap_err().code, OVER_MAXIMUM, "{v}");
        }
        // Less is fine, and so is asking for exactly the defaults.
        let less = p.grant(&req(json!({ "vcpus": 1, "memMib": 512, "diskGib": 2, "pids": 32, "commandTimeoutSecs": 60 }))).unwrap();
        assert_eq!(less, Granted { vcpus: 1, mem_mib: 512, disk_gib: Some(2), pids: 32, command_timeout_secs: 60 });
        assert_eq!(p.grant(&req(json!({ "vcpus": 2, "memMib": 2048, "diskGib": 8, "pids": 64, "commandTimeoutSecs": 600 }))).unwrap(), p.defaults);
    }

    #[test]
    fn too_few_pids_for_the_vcpus_is_refused_since_the_vm_could_not_boot() {
        let mut p = roomy();
        p.maxima.vcpus = 32;
        let r = p.grant(&req(json!({ "vcpus": 16, "pids": 16 }))).unwrap_err();
        assert_eq!((r.status, r.code, r.detail["field"].as_str(), r.detail["minimum"].as_u64()), (400, INVALID, Some("pids"), Some(24)));
        assert!(r.message.contains("at least 24"), "{}", r.message);
        assert_eq!(p.grant(&req(json!({ "vcpus": 16, "pids": 24 }))).unwrap().pids, 24);
        assert_eq!(p.grant(&req(json!({ "vcpus": 8, "pids": 16 }))).unwrap().pids, 16);
        // The default 64 pids covers every vCPU count there is.
        assert_eq!(p.grant(&req(json!({ "vcpus": 32 }))).unwrap().pids, 64);
    }

    #[test]
    fn a_disk_size_is_refused_where_the_host_cant_cap_disks() {
        let mut p = roomy();
        p.defaults.disk_gib = None;
        let r = p.grant(&req(json!({ "diskGib": 4 }))).unwrap_err();
        assert_eq!((r.status, r.code), (422, NO_DISK_QUOTA));
        assert_eq!(r.body()["field"], "diskGib");
        for part in ["resources.diskGib 4", "can't cap", "Leave diskGib out", "SANDBOXD_DISK_QUOTA_GIB"] {
            assert!(r.message.contains(part), "{part:?} not in {}", r.message);
        }
        // Even one the maximum would allow, and one over it: the code says why, either way.
        assert_eq!(p.grant(&req(json!({ "diskGib": 64 }))).unwrap_err().code, NO_DISK_QUOTA);
        // Without a disk size the rest is granted, uncapped as the host is.
        let g = p.grant(&req(json!({ "memMib": 4096 }))).unwrap();
        assert_eq!((g.mem_mib, g.disk_gib), (4096, None));
        assert!(g.describe().contains("diskGib uncapped"));
        // A later request for a sandbox there: the same answer, not a mismatch.
        assert_eq!(p.check_existing("s", &g, &req(json!({ "diskGib": 4 }))).unwrap_err().code, NO_DISK_QUOTA);
    }

    #[test]
    fn a_later_request_must_ask_for_what_the_sandbox_has() {
        let p = roomy();
        let asked = req(json!({ "vcpus": 4, "memMib": 4096, "commandTimeoutSecs": 1800 }));
        let has = p.grant(&asked).unwrap();
        // The same request again (a replay), a part of it, the whole grant, or none.
        p.check_existing("t.s1", &has, &asked).unwrap();
        p.check_existing("t.s1", &has, &req(json!({ "vcpus": 4 }))).unwrap();
        p.check_existing("t.s1", &has, &req(json!({ "vcpus": 4, "memMib": 4096, "diskGib": 8, "pids": 64, "commandTimeoutSecs": 1800 }))).unwrap();
        p.check_existing("t.s1", &has, &Request::default()).unwrap();
        // Other values, more or less: refused, naming both.
        for (v, field, want, got) in [(json!({ "vcpus": 2 }), "vcpus", 2, 4), (json!({ "vcpus": 4, "memMib": 8192 }), "memMib", 8192, 4096), (json!({ "diskGib": 16 }), "diskGib", 16, 8), (json!({ "pids": 128 }), "pids", 128, 64)] {
            let r = p.check_existing("t.s1", &has, &req(v.clone())).unwrap_err();
            assert_eq!((r.status, r.code), (409, MISMATCH), "{v}");
            assert_eq!(r.body(), json!({ "error": r.message, "code": "resources_mismatch", "field": field, "asked": want, "has": got }));
            for part in ["sandbox t.s1 already exists with vcpus 4, memMib 4096, diskGib 8, pids 64, commandTimeoutSecs 1800".to_string(), format!("asks for {field} {want}"), "never resized".into(), "destroy the sandbox".into()] {
                assert!(r.message.contains(&part), "{part:?} not in {}", r.message);
            }
        }
        // A mismatch is told before a maximum: the sandbox is what the request is about.
        assert_eq!(p.check_existing("t.s1", &has, &req(json!({ "vcpus": 64 }))).unwrap_err().code, MISMATCH);
        // A sandbox created with no request has the defaults, and is held to them.
        p.check_existing("t.s2", &p.defaults, &req(json!({ "vcpus": 2, "pids": 64 }))).unwrap();
        assert_eq!(p.check_existing("t.s2", &p.defaults, &req(json!({ "vcpus": 4 }))).unwrap_err().code, MISMATCH);
    }

    #[test]
    fn a_grant_from_under_a_higher_maximum_is_not_started_once_the_maximum_is_lowered() {
        let has = roomy().grant(&req(json!({ "memMib": 8192 }))).unwrap();
        roomy().recheck("t.s1", &has).unwrap();
        let r = stock().recheck("t.s1", &has).unwrap_err();
        assert_eq!((r.status, r.code, r.detail["field"].as_str()), (422, OVER_MAXIMUM, Some("memMib")));
        assert!(r.message.contains("Sandbox t.s1 was created with it") && r.message.contains("SANDBOXD_MAX_MEM_MIB"), "{}", r.message);
        // A capped disk on a host whose quota is off now: not started uncapped.
        let mut off = roomy();
        off.defaults.disk_gib = None;
        assert_eq!(off.recheck("t.s1", &has).unwrap_err().code, NO_DISK_QUOTA);
    }

    #[test]
    fn the_granted_command_timeout_is_what_guestd_is_told() {
        let g = Granted { vcpus: 2, mem_mib: 2048, disk_gib: None, pids: 64, command_timeout_secs: 120 };
        let sent = |body: &str| serde_json::from_slice::<Value>(&g.cap_exec_timeout(Bytes::from(body.to_string()))).unwrap();
        // None asked, zero, or more than granted: the grant. Less: as asked.
        assert_eq!(sent(r#"{"command":"make"}"#), json!({ "command": "make", "timeoutMs": 120_000 }));
        assert_eq!(sent(r#"{"command":"make","timeoutMs":0}"#)["timeoutMs"], 120_000);
        assert_eq!(sent(r#"{"command":"make","timeoutMs":600000}"#)["timeoutMs"], 120_000);
        assert_eq!(sent(r#"{"command":"make","timeoutMs":-5}"#)["timeoutMs"], 120_000);
        assert_eq!(sent(r#"{"command":"make","timeoutMs":"forever"}"#)["timeoutMs"], 120_000);
        assert_eq!(sent(r#"{"command":"make","timeoutMs":30000}"#)["timeoutMs"], 30_000);
        // The rest of the body is untouched.
        assert_eq!(sent(r#"{"command":"make","cwd":"/w","env":{"A":"b"},"timeoutMs":30000}"#), json!({ "command": "make", "cwd": "/w", "env": { "A": "b" }, "timeoutMs": 30_000 }));
        // Not an object: guestd's to refuse.
        assert_eq!(g.cap_exec_timeout(Bytes::from_static(b"not json")), Bytes::from_static(b"not json"));
        // The host's own deadline follows: the default's is the 15.5 minutes it always was.
        assert_eq!(g.exec_backstop(), std::time::Duration::from_secs(450));
        assert_eq!(stock().defaults.exec_backstop(), crate::REQUEST_DEADLINE);
    }

    #[test]
    fn a_grant_is_kept_beside_the_disk_and_read_back_or_refused_if_damaged() {
        let dir = std::env::temp_dir().join(format!("sandboxd-resources-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(read_stored(&dir), Ok(None));
        let g = Granted { vcpus: 4, mem_mib: 4096, disk_gib: None, pids: 128, command_timeout_secs: 1800 };
        store(&dir, &g).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(FILE)).unwrap(), r#"{"vcpus":4,"memMib":4096,"diskGib":null,"pids":128,"commandTimeoutSecs":1800}"#);
        assert_eq!(read_stored(&dir), Ok(Some(g)));
        assert!(!dir.join("resources.json.tmp").exists());
        for damaged in ["", "{}", r#"{"vcpus":4,"memMib":4096,"diskGib":null,"pids":128,"commandTimeoutSecs":1800,"gpus":1}"#] {
            std::fs::write(dir.join(FILE), damaged).unwrap();
            assert!(read_stored(&dir).unwrap_err().contains("resources.json"), "{damaged:?}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
