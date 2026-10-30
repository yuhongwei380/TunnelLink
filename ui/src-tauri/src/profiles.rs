use crate::profile_import::{self, Parsed};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

include!(concat!(env!("OUT_DIR"), "/client_features.rs"));

pub fn features() -> Value {
    serde_json::from_str(FEATURES).expect("Validated compiled features")
}
pub fn import_enabled() -> bool {
    features()["profileImport"]["enabled"] == true
}
pub fn builtin_enabled() -> bool {
    features()["builtinProfile"]["enabled"] == true
}
pub fn fingerprint(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub source: String,
    pub display_name: String,
    pub description: String,
    pub endpoints: Vec<profile_import::Endpoint>,
    pub requires_auth: bool,
    pub revision: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    schema_version: u8,
    display_name: String,
    content: String,
}

pub struct Snapshot {
    pub profile: Profile,
    pub content: String,
}
pub struct Store {
    root: PathBuf,
    selected: Option<String>,
}

pub fn regular(path: &Path) -> Result<(), String> {
    for part in path.ancestors() {
        if !part.exists() {
            continue;
        }
        let meta = fs::symlink_metadata(part).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err("Redirected profile path is not allowed".into());
            }
        }
        if meta.file_type().is_symlink() {
            return Err("Symbolic profile paths are not allowed".into());
        }
    }
    Ok(())
}

pub fn read_bytes(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    regular(path)?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit as u64 {
        return Err("Not a regular file, or file is too large".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err("Redirected file is not allowed".into());
        }
    }
    let mut value = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut value)
        .map_err(|e| e.to_string())?;
    if value.len() > limit {
        return Err("File is too large".into());
    }
    Ok(value)
}

pub fn read_text(path: &Path, limit: usize) -> Result<String, String> {
    String::from_utf8(read_bytes(path, limit)?).map_err(|_| "File must be UTF-8 text".into())
}

/// Restrict a new directory before storing certificate material inside it.
pub fn private_directory(path: &Path) -> Result<(), String> {
    regular(path)?;
    fs::create_dir_all(path).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        // SID is read from the running account, never supplied by the UI.
        let system = std::env::var_os("SystemRoot").ok_or("Missing SystemRoot")?;
        let bin = PathBuf::from(system).join("System32");
        let who = crate::worker::command(bin.join("whoami.exe"))
            .args(["/user", "/fo", "csv", "/nh"])
            .output()
            .map_err(|e| e.to_string())?;
        let raw = String::from_utf8_lossy(&who.stdout);
        let sid = raw
            .trim()
            .split(',')
            .next_back()
            .unwrap_or("")
            .trim_matches('"');
        if !who.status.success()
            || !sid.starts_with("S-1-")
            || !sid
                .bytes()
                .all(|v| v.is_ascii_digit() || matches!(v, b'S' | b'-'))
        {
            return Err("Cannot determine profile owner SID".into());
        }
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::LocalFree,
            Security::{
                Authorization::{
                    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW,
                    SE_FILE_OBJECT,
                },
                GetSecurityDescriptorDacl, DACL_SECURITY_INFORMATION,
                PROTECTED_DACL_SECURITY_INFORMATION,
            },
        };
        let sddl: Vec<u16> = format!("D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)")
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let name: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            let mut descriptor = std::ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut acl = std::ptr::null_mut();
            let mut present = 0;
            let mut defaulted = 0;
            let valid =
                GetSecurityDescriptorDacl(descriptor, &mut present, &mut acl, &mut defaulted);
            let result = if valid != 0 && present != 0 && !acl.is_null() {
                SetNamedSecurityInfoW(
                    name.as_ptr(),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    acl,
                    std::ptr::null(),
                )
            } else {
                87
            };
            LocalFree(descriptor);
            if result != 0 {
                return Err(format!(
                    "Cannot restrict profile directory permissions: {result}"
                ));
            }
        }
    }
    Ok(())
}

fn write_atomic(path: &Path, value: &[u8]) -> Result<(), String> {
    regular(path)?;
    let mut file = tempfile::NamedTempFile::new_in(path.parent().ok_or("Missing parent")?)
        .map_err(|e| e.to_string())?;
    file.write_all(value)
        .and_then(|_| file.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn display_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 100 || value.chars().any(char::is_control) {
        return Err("Profile name must contain 1–100 printable characters".into());
    }
    Ok(value.into())
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        private_directory(&root)?;
        let state = root.join("selection.json");
        let selected = if state.exists() {
            let value: Value =
                serde_json::from_str(&read_text(&state, 4096)?).map_err(|e| e.to_string())?;
            if value["schemaVersion"] != 1 {
                return Err("Unsupported profile store version".into());
            }
            value["selectedProfileId"].as_str().map(str::to_string)
        } else {
            None
        };
        let mut store = Self { root, selected };
        if store
            .selected
            .as_ref()
            .is_none_or(|id| store.snapshot(id).is_err())
        {
            store.selected = builtin_enabled().then(|| "builtin".into());
        }
        Ok(store)
    }
    fn path(&self, id: &str) -> Result<PathBuf, String> {
        if uuid::Uuid::parse_str(id).map_or(true, |value| value.to_string() != id) {
            return Err("Invalid profile ID".into());
        }
        Ok(self.root.join(format!("{id}.json")))
    }
    fn record(&self, id: &str) -> Result<Record, String> {
        if !import_enabled() {
            return Err("Imported profiles are disabled in this build".into());
        }
        let value: Record = serde_json::from_str(&read_text(
            &self.path(id)?,
            profile_import::MAX_PROFILE * 2,
        )?)
        .map_err(|_| "Damaged profile record")?;
        if value.schema_version != 1 {
            return Err("Unsupported profile version".into());
        }
        Ok(value)
    }
    pub fn snapshot(&self, id: &str) -> Result<Snapshot, String> {
        let (name, description, content, source) = if id == "builtin" {
            if !builtin_enabled() {
                return Err("Built-in profile is disabled".into());
            }
            let f = features();
            let name = f["builtinProfile"]["displayName"]
                .as_str()
                .unwrap_or("Internal Tunnel")
                .trim();
            (
                if name.is_empty() {
                    "Internal Tunnel"
                } else {
                    name
                }
                .to_string(),
                f["builtinProfile"]["description"]
                    .as_str()
                    .unwrap_or("")
                    .to_string(),
                BUILTIN.to_string(),
                "builtin",
            )
        } else {
            let r = self.record(id)?;
            (r.display_name, String::new(), r.content, "imported")
        };
        let parsed = profile_import::parse(&content, &BTreeMap::new(), false)?;
        Ok(Snapshot {
            profile: Profile {
                id: id.into(),
                source: source.into(),
                display_name: name,
                description,
                endpoints: parsed.endpoints,
                requires_auth: parsed.requires_auth,
                revision: fingerprint(&parsed.content),
                error: None,
            },
            content: parsed.content,
        })
    }
    pub fn list(&self) -> Value {
        let mut ids = Vec::new();
        if builtin_enabled() {
            ids.push("builtin".to_string());
        }
        if import_enabled() {
            if let Ok(entries) = fs::read_dir(&self.root) {
                for entry in entries.flatten() {
                    if let Some(id) = entry.path().file_stem().and_then(|v| v.to_str()) {
                        if uuid::Uuid::parse_str(id).is_ok() {
                            ids.push(id.to_string());
                        }
                    }
                }
            }
        }
        ids.sort();
        let profiles: Vec<_> = ids
            .iter()
            .map(|id| match self.snapshot(id) {
                Ok(s) => s.profile,
                Err(error) => Profile {
                    id: id.clone(),
                    source: if id == "builtin" {
                        "builtin"
                    } else {
                        "imported"
                    }
                    .into(),
                    display_name: if id == "builtin" {
                        features()["builtinProfile"]["displayName"]
                            .as_str()
                            .filter(|v| !v.trim().is_empty())
                            .unwrap_or("Internal Tunnel")
                            .into()
                    } else {
                        self.record(id)
                            .map(|r| r.display_name)
                            .unwrap_or_else(|_| id.clone())
                    },
                    description: String::new(),
                    endpoints: vec![],
                    requires_auth: true,
                    revision: String::new(),
                    error: Some(error),
                },
            })
            .collect();
        json!({ "profiles": profiles, "selectedProfileId": self.selected, "capabilities": features() })
    }
    pub fn select(&mut self, id: Option<&str>) -> Result<(), String> {
        if let Some(id) = id {
            self.snapshot(id)?;
        }
        write_atomic(
            &self.root.join("selection.json"),
            &serde_json::to_vec(&json!({ "schemaVersion": 1, "selectedProfileId": id })).unwrap(),
        )?;
        self.selected = id.map(str::to_string);
        Ok(())
    }
    pub fn selected(&self) -> Option<&str> {
        self.selected.as_deref()
    }
    pub fn add(&mut self, name: &str, parsed: Parsed) -> Result<Profile, String> {
        if !import_enabled() {
            return Err("Profile import is disabled".into());
        }
        let list = self.list();
        let profiles = list["profiles"].as_array().unwrap();
        if profiles
            .iter()
            .filter(|p| p["source"] == "imported")
            .count()
            >= 100
        {
            return Err("Profile limit reached".into());
        }
        let revision = fingerprint(&parsed.content);
        if profiles.iter().any(|p| p["revision"] == revision) {
            return Err("This profile has already been imported".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let record = Record {
            schema_version: 1,
            display_name: display_name(name)?,
            content: parsed.content,
        };
        write_atomic(
            &self.path(&id)?,
            &serde_json::to_vec(&record).map_err(|e| e.to_string())?,
        )?;
        self.snapshot(&id).map(|s| s.profile)
    }
    pub fn rename(&self, id: &str, name: &str) -> Result<(), String> {
        let mut record = self.record(id)?;
        record.display_name = display_name(name)?;
        write_atomic(
            &self.path(id)?,
            &serde_json::to_vec(&record).map_err(|e| e.to_string())?,
        )
    }
    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        if !import_enabled() {
            return Err("Profile import is disabled".into());
        }
        let path = self.path(id)?;
        regular(&path)?;
        if self.selected.as_deref() == Some(id) {
            self.select(None)?;
        }
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

/// Native file selections are the only way to introduce external material.
/// Windows currently runs the GUI elevated: never automatically read a path
/// named by an imported profile, even if it looks relative and harmless.
pub fn import_dialog() -> Result<Option<(String, Parsed)>, String> {
    if !import_enabled() {
        return Err("Profile import is disabled".into());
    }
    let Some(path) = rfd::FileDialog::new()
        .add_filter("OpenVPN", &["ovpn"])
        .pick_file()
    else {
        return Ok(None);
    };
    let input = read_text(&path, profile_import::MAX_INPUT)?;
    let initial = profile_import::parse(&input, &BTreeMap::new(), true)?;
    let mut materials = BTreeMap::new();
    for (kind, reference) in initial.dependencies {
        let title = format!("Select {kind} material / 选择 {kind} 文件: {reference}");
        let dialog = rfd::FileDialog::new()
            .set_title(&title)
            .set_directory(path.parent().unwrap_or(Path::new(".")));
        let dialog = match kind.as_str() {
            "pkcs12" => dialog.add_filter("PKCS#12 certificate", &["p12", "pfx"]),
            "auth-user-pass" | "http-proxy-user-pass" => {
                dialog.add_filter("Credentials text", &["txt", "cred", "conf"])
            }
            "auth-gen-token-secret" => {
                dialog.add_filter("OpenVPN text material", &["txt", "pem", "conf"])
            }
            _ => dialog.add_filter(
                "PEM certificate, key or CRL",
                &["crt", "pem", "cer", "key", "crl", "dh"],
            ),
        };
        let Some(material) = dialog.pick_file() else {
            return Ok(None);
        };
        let value = if kind == "pkcs12" {
            base64::engine::general_purpose::STANDARD
                .encode(read_bytes(&material, profile_import::MAX_MATERIAL)?)
        } else {
            read_text(&material, profile_import::MAX_MATERIAL)?
        };
        materials.insert(kind, value);
    }
    let parsed = profile_import::parse(&input, &materials, false)?;
    evaluate(&parsed)?;
    let name = path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("Imported VPN")
        .to_string();
    Ok(Some((name, parsed)))
}

fn eval_message(result: &str) -> Option<String> {
    ["message=", "Main thread exception: ", "Error: "]
        .into_iter()
        .find_map(|prefix| {
            result
                .lines()
                .find_map(|line| line.strip_prefix(prefix))
                .map(str::trim)
                .filter(|message| !message.is_empty())
                .map(|message| message.chars().take(512).collect::<String>())
        })
}

fn evaluate(parsed: &Parsed) -> Result<(), String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    private_directory(dir.path())?;
    // ovpncli's merge stage requires the input path to carry an `.ovpn`
    // extension, even when the profile contents are otherwise valid.
    let mut profile = tempfile::Builder::new()
        .prefix("openvpn-profile-")
        .suffix(".ovpn")
        .tempfile_in(dir.path())
        .map_err(|e| e.to_string())?;
    profile
        .write_all(parsed.content.as_bytes())
        .map_err(|e| e.to_string())?;
    let stdout_log = tempfile::NamedTempFile::new_in(dir.path()).map_err(|e| e.to_string())?;
    let stderr_log = tempfile::NamedTempFile::new_in(dir.path()).map_err(|e| e.to_string())?;
    let mut command = crate::worker::command(crate::worker::engine_path()?);
    command.arg("--eval");
    if !parsed.has_client_certificate {
        command.arg("--no-cert");
    }
    let mut child = command
        .arg(profile.path())
        .stdin(Stdio::null())
        .stdout(stdout_log.as_file().try_clone().map_err(|e| e.to_string())?)
        .stderr(stderr_log.as_file().try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {}
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(e.to_string());
            }
        }
        if start.elapsed() > Duration::from_secs(15)
            || stdout_log
                .as_file()
                .metadata()
                .map_err(|e| e.to_string())?
                .len()
                .saturating_add(
                    stderr_log
                        .as_file()
                        .metadata()
                        .map_err(|e| e.to_string())?
                        .len(),
                )
                > 64 * 1024
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Profile validation timed out or exceeded output limit".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let stdout = read_text(stdout_log.path(), 64 * 1024)?;
    let stderr = read_text(stderr_log.path(), 64 * 1024)?;
    let result = [stdout.as_str(), stderr.as_str()]
        .into_iter()
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let field = |key: &str| result.lines().find_map(|line| line.strip_prefix(key));
    if !status.success() || field("error=") != Some("0") {
        let detail = eval_message(&result).or_else(|| {
            status
                .code()
                .map(|code| format!("engine exited with status {code}"))
        });
        return Err(match detail {
            Some(message) => format!(
                "The bundled OpenVPN engine rejected this profile: {message}"
            ),
            None => {
                "The bundled OpenVPN engine rejected this profile. Check its options and certificates."
                    .into()
            }
        });
    }
    if field("privateKeyPasswordRequired=") != Some("0")
        || field("externalPki=") != Some("0")
        || field("staticChallenge=").is_some_and(|v| !v.is_empty())
    {
        return Err(
            "Encrypted keys, external PKI and challenge authentication are not supported".into(),
        );
    }
    if (field("autologin=") == Some("0")) != parsed.requires_auth {
        return Err("Unsupported profile authentication mode".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_validation_error_preserves_diagnostic_message() {
        let output = "EVAL PROFILE\nerror=1\nmessage=ERR_PROFILE_GENERIC: unsupported directive\nautologin=0\n";
        assert_eq!(
            eval_message(output).as_deref(),
            Some("ERR_PROFILE_GENERIC: unsupported directive")
        );
        assert_eq!(
            eval_message("error=1\nmessage=\nMain thread exception: bad profile\n").as_deref(),
            Some("bad profile")
        );
    }

    #[test]
    fn profiles_survive_restart_and_have_independent_identity() {
        if !import_enabled() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().join("profiles")).unwrap();
        let parse = |server| {
            profile_import::parse(
                &format!("client\nremote {server}\nauth-user-pass\n"),
                &BTreeMap::new(),
                false,
            )
            .unwrap()
        };
        let a = store.add("Office", parse("office.test")).unwrap();
        let b = store.add("Office", parse("other.test")).unwrap();
        assert_ne!(a.id, b.id);
        assert!(store.add("Duplicate", parse("office.test")).is_err());
        store.select(Some(&b.id)).unwrap();
        store.rename(&a.id, "Office A").unwrap();
        let mut restored = Store::new(dir.path().join("profiles")).unwrap();
        assert_eq!(restored.selected(), Some(b.id.as_str()));
        assert_eq!(
            restored.snapshot(&a.id).unwrap().profile.display_name,
            "Office A"
        );
        assert!(restored.snapshot("../../outside").is_err());
        assert!(restored.delete("builtin").is_err());
        restored.delete(&b.id).unwrap();
        assert!(restored.selected().is_none());
        assert!(restored.snapshot(&b.id).is_err());
        assert!(restored.snapshot(&a.id).is_ok());
    }
    #[test]
    fn corrupt_record_does_not_hide_valid_profiles() {
        if !import_enabled() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::new(dir.path().join("profiles")).unwrap();
        let p = store
            .add(
                "Valid",
                profile_import::parse("remote test\nauth-user-pass", &BTreeMap::new(), false)
                    .unwrap(),
            )
            .unwrap();
        let bad = uuid::Uuid::new_v4().to_string();
        fs::write(store.path(&bad).unwrap(), "corrupt").unwrap();
        let list = store.list();
        assert!(list["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == p.id && v["error"].is_null()));
        assert!(list["profiles"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["id"] == bad && v["error"].is_string()));
        store.delete(&bad).unwrap();
    }
}
