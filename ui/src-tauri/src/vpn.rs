use crate::worker;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::Read,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const MAX_LOG_ENTRIES: usize = 50_000;
const DISPLAY_LOG_ENTRIES: usize = 300;

#[derive(Clone, Deserialize, Serialize)]
pub struct ConnectOptions {
    #[serde(default, rename = "profileId")]
    pub profile_id: String,
    pub username: String,
    pub password: String,
    pub remember: bool,
}
#[derive(Clone, Serialize)]
struct Log {
    ts: String,
    source: String,
    line: String,
}
struct Data {
    log_privacy: crate::log_privacy::LogPrivacy,
    state: &'static str,
    active_profile: Option<String>,
    active_revision: Option<String>,
    started: Option<Instant>,
    last_error: String,
    logs: VecDeque<Log>,
    assigned_ip: Option<String>,
    gateway_addr: Option<String>,
    bytes_in: u64,
    bytes_out: u64,
    metrics_available: bool,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            log_privacy: crate::log_privacy::LogPrivacy::new(None, ""),
            active_profile: None,
            active_revision: None,
            state: "DISCONNECTED",
            started: None,
            last_error: String::new(),
            logs: VecDeque::new(),
            assigned_ip: None,
            gateway_addr: None,
            bytes_in: 0,
            bytes_out: 0,
            metrics_available: false,
        }
    }
}
impl Data {
    fn log(&mut self, source: &str, line: impl Into<String>) {
        self.logs.push_back(Log {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source: source.into(),
            line: self.log_privacy.redact(&line.into()),
        });
        while self.logs.len() > MAX_LOG_ENTRIES {
            self.logs.pop_front();
        }
    }
    fn error(&mut self, message: impl Into<String>) {
        self.last_error = self.log_privacy.redact(&message.into());
        self.log("system", self.last_error.clone());
    }
}
struct Session {
    cancel: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}
#[derive(Clone)]
pub struct Controller {
    data: Arc<Mutex<Data>>,
    session: Arc<Mutex<Option<Session>>>,
    credential_io: Arc<Mutex<()>>,
    generation: Arc<AtomicU64>,
    uninstalling: Arc<AtomicBool>,
    service: String,
    profiles: Arc<Mutex<Option<crate::profiles::Store>>>,
}

fn connected(line: &str) -> bool {
    // An opened TUN interface is not proof that authentication/routes succeeded.
    line.contains("Initialization Sequence Completed")
        || line.split_once("EVENT:").is_some_and(|(_, event)| {
            event
                .trim_start()
                .split(|c: char| c.is_whitespace() || c == ',')
                .next()
                == Some("CONNECTED")
        })
}
fn is_ipv4(token: &str) -> bool {
    let token = token.trim_matches(|c: char| c == '"' || c == '\'');
    let parts: Vec<&str> = token.split('.').collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.len() <= 3 && part.parse::<u8>().is_ok())
}

// OpenVPN 3 Core Connected::render() in the pinned clievent.hpp emits:
// user@host:port (server_ip) via client_ip/proto on tun/ip4/ip6 gw=[gw4/gw6] mtu=...
fn connected_payload(line: &str) -> Option<&str> {
    let event = line.split_once("EVENT:")?.1.trim_start();
    let payload = event.strip_prefix("CONNECTED ")?.trim();
    (!payload.is_empty()).then_some(payload)
}

fn valid_address(value: &str) -> Option<String> {
    let address = value.parse::<std::net::IpAddr>().ok()?;
    (!address.is_unspecified()).then(|| address.to_string())
}

fn extract_counter(line: &str, name: &str) -> Option<u64> {
    let mut tokens = line.split(|c: char| c == ':' || c == ',' || c.is_whitespace());
    while let Some(token) = tokens.next() {
        if token.eq_ignore_ascii_case(name) {
            return tokens.find_map(|value| value.parse().ok());
        }
    }
    None
}

fn extract_assigned_ip(line: &str) -> Option<String> {
    if let Some(payload) = connected_payload(line) {
        let interface = payload.rsplit_once(" on ")?.1.split_whitespace().next()?;
        return interface.split('/').skip(1).find_map(valid_address);
    }
    if let Some((_, addresses)) = line.split_once("CONNECTED_VPN_IPV4_ADDRESS") {
        return addresses.split_whitespace().find_map(valid_address);
    }
    // PUSH_REPLY options are comma-delimited, including the final ifconfig argument.
    let token = line
        .split_once("ifconfig ")?
        .1
        .split(|c: char| c.is_whitespace() || c == ',')
        .next()?
        .trim_matches(|c: char| c == '"' || c == '\'');
    (is_ipv4(token)).then(|| valid_address(token)).flatten()
}

fn extract_gateway(line: &str) -> Option<String> {
    if let Some(payload) = connected_payload(line) {
        let gateways = payload.split_once(" gw=[")?.1.split_once(']')?.0;
        return gateways.split('/').find_map(valid_address);
    }
    let token = line
        .split_once("route-gateway ")?
        .1
        .split(|c: char| c.is_whitespace() || c == ',')
        .next()?;
    valid_address(token)
}

fn fatal_error(line: &str) -> Option<String> {
    let lower = line.to_ascii_lowercase();
    let message = if lower.contains("auth_failed") || lower.contains("authentication failed") {
        "Authentication failed. Check your username and password."
    } else if lower.contains("cannot acquire tap handle") {
        "Windows VPN adapter could not be opened. Close other VPN connections or run this installer again to repair the bundled TAP driver."
    } else if lower.contains("requires elevation")
        || lower.contains("cannot modify route: error 5")
        || lower.contains("nrpt_error")
    {
        "Administrator privileges are required to configure VPN routes/DNS."
    } else if lower.contains("utun_error:") {
        "Cannot create the macOS utun interface. Check administrator authorization and other VPN connections."
    } else if lower.contains("library not loaded:") {
        "A bundled VPN runtime library is missing. Reinstall the client."
    } else if lower.contains("[fatal-err]")
        || lower.contains("event: tun_setup_failed")
        || lower.contains("event: cert_verify_fail")
        || lower.contains("connect error")
    {
        line
    } else {
        return None;
    };
    Some(message.into())
}

impl Controller {
    pub fn initialize_profiles(&self, path: std::path::PathBuf) -> Result<(), String> {
        *self.profiles.lock().unwrap() = Some(crate::profiles::Store::new(path)?);
        // Never reuse the legacy global account for an arbitrary profile.
        match crate::credentials::entry(&self.service)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Cannot retire legacy VPN credentials: {e}")),
        }
    }
    pub fn list_profiles(&self) -> Result<Value, String> {
        Ok(self
            .profiles
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Profile store is unavailable")?
            .list())
    }
    pub fn import_profile(
        &self,
        name: &str,
        parsed: crate::profile_import::Parsed,
    ) -> Result<Value, String> {
        let session = self.session.lock().unwrap();
        if self.uninstalling.load(Ordering::SeqCst) {
            return Err("Uninstallation is in progress".into());
        }
        let mut profiles = self.profiles.lock().unwrap();
        let store = profiles.as_mut().ok_or("Profile store is unavailable")?;
        let profile = store.add(name, parsed)?;
        if !session.as_ref().is_some_and(|s| !s.thread.is_finished()) {
            store.select(Some(&profile.id))?;
        }
        Ok(store.list())
    }
    pub fn change_profile(&self, action: &str, id: &str, name: &str) -> Result<Value, String> {
        let session = self.session.lock().unwrap();
        if self.uninstalling.load(Ordering::SeqCst) {
            return Err("Uninstallation is in progress".into());
        }
        let running = session.as_ref().is_some_and(|s| !s.thread.is_finished());
        if running
            && (action == "select"
                || self.data.lock().unwrap().active_profile.as_deref() == Some(id))
        {
            return Err("Disconnect before changing the active profile".into());
        }
        let mut profiles = self.profiles.lock().unwrap();
        let store = profiles.as_mut().ok_or("Profile store is unavailable")?;
        match action {
            "select" => {
                store.select(Some(id))?;
                self.generation.fetch_add(1, Ordering::SeqCst);
            }
            "rename" => store.rename(id, name)?,
            "delete" => {
                if id == "builtin" || !crate::profiles::import_enabled() {
                    return Err("This profile cannot be deleted".into());
                }
                if !running {
                    self.generation.fetch_add(1, Ordering::SeqCst);
                }
                let _guard = self.credential_io.lock().unwrap();
                let mut values = crate::credentials::load_profiles(&self.service)?;
                values.retain(|key, _| !key.starts_with(&format!("{id}:")));
                crate::credentials::save_profiles(&self.service, &values)?;
                store.delete(id)?;
            }
            _ => return Err("Invalid profile action".into()),
        }
        if !running {
            let mut data = self.data.lock().unwrap();
            data.last_error.clear();
            data.active_profile = None;
            data.active_revision = None;
        }
        Ok(store.list())
    }
    pub fn new(service: String) -> Self {
        Self {
            data: Arc::new(Mutex::new(Data::default())),
            session: Arc::new(Mutex::new(None)),
            credential_io: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
            uninstalling: Arc::new(AtomicBool::new(false)),
            service,
            profiles: Arc::new(Mutex::new(None)),
        }
    }
    pub fn connect(&self, mut options: ConnectOptions) -> Result<Value, String> {
        options.username = options.username.trim().into();
        if options.username.contains('\0') || options.password.contains('\0') {
            return Ok(
                json!({ "ok": false, "error": "Username and password are required and must not contain NUL." }),
            );
        }
        if options.username.len() + options.password.len() > 16 * 1024 {
            return Ok(json!({ "ok": false, "error": "Credentials are too long." }));
        }
        let mut session = self.session.lock().unwrap();
        if self.uninstalling.load(Ordering::SeqCst) {
            return Err("Uninstallation is in progress.".into());
        }
        if session.as_ref().is_some_and(|s| !s.thread.is_finished()) {
            return Ok(json!({ "ok": true, "state": self.data.lock().unwrap().state }));
        }
        if let Some(old) = session.take() {
            let _ = old.thread.join();
        }
        let snapshot = self
            .profiles
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("Profile store is unavailable")?
            .snapshot(&options.profile_id)?;
        if snapshot.profile.requires_auth
            && (options.username.is_empty() || options.password.is_empty())
        {
            return Ok(json!({ "ok": false, "error": "Username and password are required." }));
        }
        if !snapshot.profile.requires_auth {
            options.username.clear();
            options.password.clear();
            options.remember = false;
        }
        {
            let mut data = self.data.lock().unwrap();
            data.active_profile = Some(snapshot.profile.id.clone());
            data.active_revision = Some(snapshot.profile.revision.clone());
            data.state = "CONNECTING";
            data.started = None;
            data.last_error.clear();
            data.assigned_ip = None;
            data.gateway_addr = None;
            data.bytes_in = 0;
            data.bytes_out = 0;
            data.metrics_available = false;
            data.log("system", "Connection requested (Tauri / OpenVPN 3).");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let controller = self.clone();
        let stop = cancel.clone();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let thread = thread::spawn(move || {
            if let Err(error) = controller.run_session(options, snapshot.content, &stop, generation)
            {
                if !stop.load(Ordering::SeqCst) {
                    controller.data.lock().unwrap().error(error);
                }
            }
            let mut data = controller.data.lock().unwrap();
            data.state = "DISCONNECTED";
            data.started = None;
            data.assigned_ip = None;
            data.gateway_addr = None;
            data.bytes_in = 0;
            data.bytes_out = 0;
            data.metrics_available = false;
            data.log("system", "Connection stopped.");
        });
        *session = Some(Session { cancel, thread });
        Ok(json!({ "ok": true, "state": "CONNECTING" }))
    }
    pub fn cancel(&self) {
        if let Some(session) = self.session.lock().unwrap().as_ref() {
            session.cancel.store(true, Ordering::SeqCst);
        }
    }
    pub fn disconnect(&self) -> Value {
        let mut session = self.session.lock().unwrap();
        if let Some(current) = session.take() {
            current.cancel.store(true, Ordering::SeqCst);
            let _ = current.thread.join();
        }
        let mut data = self.data.lock().unwrap();
        data.state = "DISCONNECTED";
        data.started = None;
        data.assigned_ip = None;
        data.gateway_addr = None;
        data.bytes_in = 0;
        data.bytes_out = 0;
        data.metrics_available = false;
        json!({ "ok": true, "state": "DISCONNECTED" })
    }
    pub fn status(&self) -> Value {
        let data = self.data.lock().unwrap();
        json!({ "state": data.state, "uptime": data.started.map(|t| t.elapsed().as_secs()).unwrap_or(0),
            "bytesIn": data.bytes_in, "bytesOut": data.bytes_out,
            "metricsAvailable": data.metrics_available,
            "assignedIp": data.assigned_ip, "gatewayAddress": data.gateway_addr,
            "activeProfileId": data.active_profile, "activeProfileRevision": data.active_revision,
            "lastError": data.last_error, "engine": "openvpn3" })
    }
    pub fn logs(&self) -> Value {
        let data = self.data.lock().unwrap();
        let logs: Vec<_> = data
            .logs
            .iter()
            .skip(data.logs.len().saturating_sub(DISPLAY_LOG_ENTRIES))
            .collect();
        json!({ "ok": true, "logs": logs, "lastError": data.last_error, "state": data.state })
    }
    pub fn export_logs(
        &self,
        range_minutes: u32,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<(String, usize), String> {
        if !matches!(range_minutes, 5 | 30 | 60) {
            return Err("Unsupported log export range.".into());
        }
        let cutoff = now - chrono::Duration::minutes(i64::from(range_minutes));
        let data = self.data.lock().unwrap();
        let selected: Vec<_> = data
            .logs
            .iter()
            .filter(|entry| {
                chrono::DateTime::parse_from_rfc3339(&entry.ts)
                    .is_ok_and(|timestamp| timestamp.with_timezone(&chrono::Utc) >= cutoff)
            })
            .collect();
        let mut output = String::new();
        for entry in &selected {
            output.push_str(&format!(
                "[{}] [{}] {}\n",
                entry.ts, entry.source, entry.line
            ));
        }
        Ok((output, selected.len()))
    }
    pub fn clear_logs(&self) -> Value {
        self.data.lock().unwrap().logs.clear();
        json!({ "ok": true })
    }
    #[cfg(any(target_os = "macos", windows, test))]
    pub fn prepare_uninstall(&self) -> Result<(), String> {
        if self.uninstalling.swap(true, Ordering::SeqCst) {
            return Err("Uninstallation is already in progress.".into());
        }
        self.disconnect();
        self.generation.fetch_add(1, Ordering::SeqCst);
        let _guard = self.credential_io.lock().unwrap();
        let result = crate::credentials::clear(&self.service);
        if result.is_err() {
            self.cancel_uninstall();
        }
        result
    }
    #[cfg(any(target_os = "macos", windows, test))]
    pub fn cancel_uninstall(&self) {
        self.uninstalling.store(false, Ordering::SeqCst);
    }
    pub fn credentials(&self) -> Result<Value, String> {
        let profiles = self.profiles.lock().unwrap();
        let Some(store) = profiles.as_ref() else {
            return Ok(json!({ "ok": true, "credentials": null }));
        };
        let Some(id) = store.selected() else {
            return Ok(json!({ "ok": true, "credentials": null }));
        };
        let snapshot = store.snapshot(id)?;
        let _guard = self.credential_io.lock().unwrap();
        let values = crate::credentials::load_profiles(&self.service)?;
        let key = format!("{}:{}", id, snapshot.profile.revision);
        let value = values
            .get(&key)
            .map(|v| serde_json::from_str::<ConnectOptions>(v))
            .transpose()
            .map_err(|e| e.to_string())?;
        Ok(json!({ "ok": true, "credentials": value }))
    }
    fn persist(
        &self,
        options: &ConnectOptions,
        generation: u64,
        revision: &str,
    ) -> Result<(), String> {
        let _guard = self.credential_io.lock().unwrap();
        if generation != self.generation.load(Ordering::SeqCst)
            || self.uninstalling.load(Ordering::SeqCst)
        {
            return Ok(());
        }
        let mut values = crate::credentials::load_profiles(&self.service)?;
        values.retain(|key, _| !key.starts_with(&format!("{}:", options.profile_id)));
        if options.remember {
            values.insert(
                format!("{}:{}", options.profile_id, revision),
                serde_json::to_string(options).map_err(|e| e.to_string())?,
            );
        }
        crate::credentials::save_profiles(&self.service, &values)
    }
    fn run_session(
        &self,
        options: ConnectOptions,
        profile: String,
        cancel: &AtomicBool,
        generation: u64,
    ) -> Result<(), String> {
        let directory = tempfile::Builder::new()
            .prefix("openvpn-session-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        crate::profiles::private_directory(directory.path())?;
        for name in [
            "request.json",
            "profile.ovpn",
            "engine.log",
            "exit.json",
            "heartbeat",
        ] {
            let mut opts = OpenOptions::new();
            opts.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            let mut file = opts
                .open(directory.path().join(name))
                .map_err(|e| e.to_string())?;
            if name == "profile.ovpn" {
                use std::io::Write;
                file.write_all(profile.as_bytes())
                    .map_err(|e| e.to_string())?;
            }
            if name == "request.json" {
                serde_json::to_writer(
                    &mut file,
                    &worker::Request {
                        username: options.username.clone(),
                        password: options.password.clone(),
                        parent_pid: std::process::id(),
                        profile_hash: crate::profiles::fingerprint(&profile),
                        imported: options.profile_id != "builtin",
                    },
                )
                .map_err(|e| e.to_string())?;
            }
        }
        let mut log = File::open(directory.path().join("engine.log")).map_err(|e| e.to_string())?;
        let mut launcher = worker::launch(directory.path())?;
        let mut pending = Vec::new();
        let mut connected_once = false;
        let mut deadline = Instant::now() + Duration::from_secs(120); // includes macOS authorization dialog
        let mut stop_requested: Option<Instant> = None;
        let mut heartbeat = Instant::now();
        loop {
            if heartbeat.elapsed() > Duration::from_secs(2) {
                let _ = fs::write(directory.path().join("heartbeat"), b"alive");
                heartbeat = Instant::now();
            }
            let mut bytes = [0u8; 8192];
            if let Ok(count) = log.read(&mut bytes) {
                pending.extend_from_slice(&bytes[..count]);
            }
            while let Some(end) = pending.iter().position(|b| *b == b'\n' || *b == b'\r') {
                let line = String::from_utf8_lossy(&pending.drain(..=end).collect::<Vec<_>>())
                    .trim()
                    .to_string();
                if line.is_empty() {
                    continue;
                }
                // Redact credentials even if a future engine emits them in a diagnostic.
                if line.contains("[supervisor] OpenVPN process started.") {
                    deadline = Instant::now() + Duration::from_secs(45);
                    let _ = fs::remove_file(directory.path().join("request.json"));
                }
                let mut data = self.data.lock().unwrap();
                data.log(
                    "engine",
                    if options.password.is_empty() {
                        line.to_string()
                    } else {
                        line.replace(&options.password, "[redacted]")
                    },
                );
                if let Some(ip) = extract_assigned_ip(&line) {
                    data.assigned_ip = Some(ip);
                }
                if let Some(endpoint) = extract_gateway(&line) {
                    data.gateway_addr = Some(endpoint);
                }
                if let Some(value) = extract_counter(&line, "BYTES_IN") {
                    data.bytes_in = value;
                    data.metrics_available = true;
                }
                if let Some(value) = extract_counter(&line, "BYTES_OUT") {
                    data.bytes_out = value;
                    data.metrics_available = true;
                }
                if let Some(error) = fatal_error(&line) {
                    data.error(if options.password.is_empty() {
                        error
                    } else {
                        error.replace(&options.password, "[redacted]")
                    });
                    cancel.store(true, Ordering::SeqCst);
                } else if connected(&line) && !cancel.load(Ordering::SeqCst) {
                    data.state = "CONNECTED";
                    data.started = Some(Instant::now());
                    drop(data);
                    if let Err(error) =
                        fs::write(directory.path().join("stats-enabled"), b"enabled")
                    {
                        self.data.lock().unwrap().log(
                            "system",
                            format!("Unable to enable traffic statistics: {error}"),
                        );
                    }
                    if !connected_once {
                        // Keychain may prompt the user; never block heartbeats or cancellation.
                        let controller = self.clone();
                        let credentials = options.clone();
                        let revision = crate::profiles::fingerprint(&profile);
                        thread::spawn(move || {
                            if let Err(error) =
                                controller.persist(&credentials, generation, &revision)
                            {
                                controller.data.lock().unwrap().log(
                                    "system",
                                    format!(
                                        "Connected, but credentials could not be saved: {error}"
                                    ),
                                );
                            }
                        });
                    }
                    connected_once = true;
                } else if line.contains("EVENT: RECONNECTING") {
                    let _ = fs::remove_file(directory.path().join("stats-enabled"));
                    data.state = "CONNECTING";
                    data.started = None;
                    data.assigned_ip = None;
                    data.gateway_addr = None;
                    data.bytes_in = 0;
                    data.bytes_out = 0;
                    data.metrics_available = false;
                    deadline = Instant::now() + Duration::from_secs(45);
                } else if line.contains("EVENT: DISCONNECTED") {
                    let _ = fs::remove_file(directory.path().join("stats-enabled"));
                    data.state = "DISCONNECTED";
                    data.started = None;
                    data.assigned_ip = None;
                    data.gateway_addr = None;
                    data.bytes_in = 0;
                    data.bytes_out = 0;
                    data.metrics_available = false;
                    cancel.store(true, Ordering::SeqCst);
                }
            }
            if pending.len() > 65536 {
                pending.clear();
            }
            let still_connecting = self.data.lock().unwrap().state == "CONNECTING";
            if still_connecting && Instant::now() > deadline && !cancel.load(Ordering::SeqCst) {
                self.data
                    .lock()
                    .unwrap()
                    .error("Connection timed out. Check the connection logs.");
                cancel.store(true, Ordering::SeqCst);
            }
            if cancel.load(Ordering::SeqCst) && stop_requested.is_none() {
                let _ = fs::remove_file(directory.path().join("stats-enabled"));
                let _ = fs::write(directory.path().join("stop"), b"stop");
                stop_requested = Some(Instant::now());
            }
            if let Ok(result) = fs::read(directory.path().join("exit.json")) {
                if let Ok(value) = serde_json::from_slice::<Value>(&result) {
                    if !cancel.load(Ordering::SeqCst) {
                        if let Some(error) = value["error"].as_str() {
                            self.data.lock().unwrap().error(error);
                        } else if !connected_once || value["code"].as_i64() != Some(0) {
                            self.data
                                .lock()
                                .unwrap()
                                .error(format!("OpenVPN process exited (code={}).", value["code"]));
                        }
                    }
                    let _ = launcher.wait();
                    break;
                }
            }
            if let Ok(Some(status)) = launcher.try_wait() {
                if !cancel.load(Ordering::SeqCst) {
                    let mut message = String::new();
                    if let Some(mut stderr) = launcher.stderr.take() {
                        let _ = stderr.read_to_string(&mut message);
                    }
                    self.data.lock().unwrap().error(format!(
                        "VPN supervisor exited ({status}). {}",
                        message.trim()
                    ));
                }
                break;
            }
            if stop_requested.is_some_and(|at| at.elapsed() > Duration::from_secs(8)) {
                let _ = launcher.kill();
                let _ = launcher.wait();
                break;
            }
            thread::sleep(Duration::from_millis(75));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_confirmed_connections_count() {
        assert!(connected("EVENT: CONNECTED user@server"));
        assert!(connected("Initialization Sequence Completed"));
        for line in [
            "EVENT: DISCONNECTED",
            "not connected",
            "tun device opened",
            "EVENT: CONNECTED_FAILED",
        ] {
            assert!(!connected(line), "{line}");
        }
    }
    #[test]
    fn address_extraction_covers_core_events_and_push_fallbacks() {
        assert_eq!(
            extract_assigned_ip("EVENT: CONNECTED_VPN_IPV4_ADDRESS 10.8.0.6 10.8.0.1").as_deref(),
            Some("10.8.0.6")
        );
        assert_eq!(
            extract_assigned_ip(
                "PUSH: Received control message: PUSH_REPLY,ifconfig 10.8.0.2 255.255.255.0"
            )
            .as_deref(),
            Some("10.8.0.2")
        );
        assert_eq!(
            extract_assigned_ip("WARNING: ifconfig parsing failed"),
            None
        );
        assert_eq!(
            extract_assigned_ip("EVENT: CONNECTED_VPN_IPV4_ADDRESS [unavailable]"),
            None
        );
        assert_eq!(
            extract_gateway("EVENT: CONNECTED demo@vpn.example.com:1194"),
            None
        );
        assert_eq!(
            extract_gateway("EVENT: CONNECTED a@b@example.org:443"),
            None
        );
        assert_eq!(extract_gateway("EVENT: CONNECTED_TUNNEL"), None);
        assert_eq!(extract_gateway("EVENT: DISCONNECTED"), None);
        assert_eq!(extract_gateway("EVENT: CONNECTED "), None);
    }
    #[test]
    fn driver_and_auth_failures_are_actionable_but_warnings_are_not_fatal() {
        assert!(fatal_error("EVENT: AUTH_FAILED")
            .unwrap()
            .contains("Authentication"));
        assert!(fatal_error("cannot acquire TAP handle")
            .unwrap()
            .contains("installer"));
        assert!(fatal_error("Cannot modify route: error 5")
            .unwrap()
            .contains("Administrator"));
        assert!(fatal_error("WARNING: failed to enable optional feature").is_none());
    }
    #[test]
    fn logs_are_bounded_and_idle_status_has_no_fake_traffic() {
        let controller = Controller::new("test".into());
        {
            let mut data = controller.data.lock().unwrap();
            for i in 0..MAX_LOG_ENTRIES {
                data.logs.push_back(Log {
                    ts: "2026-10-29T00:00:00.000Z".into(),
                    source: "engine".into(),
                    line: i.to_string(),
                });
            }
            data.log("engine", "newest");
        }
        assert_eq!(controller.data.lock().unwrap().logs.len(), MAX_LOG_ENTRIES);
        assert_eq!(
            controller.logs()["logs"].as_array().unwrap().len(),
            DISPLAY_LOG_ENTRIES
        );
        assert_eq!(controller.status()["metricsAvailable"], false);
        assert_eq!(controller.status()["state"], "DISCONNECTED");
    }
    #[test]
    fn log_exports_use_the_selected_recent_time_range() {
        use chrono::TimeZone;
        let controller = Controller::new("test".into());
        let now = chrono::Utc
            .with_ymd_and_hms(2026, 10, 29, 12, 0, 0)
            .unwrap();
        let mut data = controller.data.lock().unwrap();
        for (ts, line) in [
            ("2026-10-29T10:59:59.000Z", "too old"),
            ("2026-10-29T11:30:00.000Z", "thirty minutes"),
            ("2026-10-29T11:55:00.000Z", "five minutes"),
        ] {
            data.logs.push_back(Log {
                ts: ts.into(),
                source: "engine".into(),
                line: line.into(),
            });
        }
        drop(data);
        let (five, count) = controller.export_logs(5, now).unwrap();
        assert_eq!(count, 1);
        assert!(five.contains("five minutes"));
        assert!(!five.contains("thirty minutes"));
        let (hour, count) = controller.export_logs(60, now).unwrap();
        assert_eq!(count, 2);
        assert!(hour.ends_with("[engine] five minutes\n"));
        assert!(controller.export_logs(15, now).is_err());
    }
    #[test]
    fn invalid_credentials_do_not_spawn_a_process() {
        let controller = Controller::new("test".into());
        assert_eq!(
            controller
                .connect(ConnectOptions {
                    profile_id: "builtin".into(),
                    username: "\0".into(),
                    password: "p".into(),
                    remember: false
                })
                .unwrap()["ok"],
            false
        );
        assert!(controller.session.lock().unwrap().is_none());
    }
    #[test]
    fn uninstall_blocks_connections_and_stale_credential_writes() {
        let service = format!("com.tunnellink.uninstall-race-test.{}", std::process::id());
        let controller = Controller::new(service);
        let options = ConnectOptions {
            profile_id: "builtin".into(),
            username: "test-account".into(),
            password: "test-only-secret".into(),
            remember: true,
        };
        controller.generation.store(1, Ordering::SeqCst);
        controller.persist(&options, 1, "test-revision").unwrap();
        controller.prepare_uninstall().unwrap();
        // A save queued by an earlier successful connection must not recreate it.
        controller.persist(&options, 1, "test-revision").unwrap();
        assert!(controller.credentials().unwrap()["credentials"].is_null());
        assert!(controller.connect(options).is_err());
        assert!(controller.session.lock().unwrap().is_none());
        assert!(controller.prepare_uninstall().is_err());
        controller.cancel_uninstall();
        assert!(!controller.uninstalling.load(Ordering::SeqCst));
    }
    #[test]
    fn connected_render_provides_tunnel_addresses_not_remote_or_client_addresses() {
        // Matches Connected::render() from the pinned OpenVPN 3 Core release.
        let line = "2026-10-28 EVENT: CONNECTED a@b@vpn.example.com:1194 (203.0.113.1) via 192.0.2.2/UDPv4 on TAP-Windows6/10.20.0.2/ gw=[10.20.0.1/] mtu=1500 vpn_interface_index=17";
        assert!(connected(line));
        assert_eq!(extract_assigned_ip(line).as_deref(), Some("10.20.0.2"));
        assert_eq!(extract_gateway(line).as_deref(), Some("10.20.0.1"));
        let ipv6 = "EVENT: CONNECTED [2001:db8::1]:443 (2001:db8::1) via ::/TCPv6 on utun3//fd00::2 gw=[/fd00::1] mtu=1500";
        assert_eq!(extract_assigned_ip(ipv6).as_deref(), Some("fd00::2"));
        assert_eq!(extract_gateway(ipv6).as_deref(), Some("fd00::1"));
        let empty = "EVENT: CONNECTED vpn.example.com:443 (203.0.113.1) via /UDPv4 on tun0// gw=[/] mtu=1500";
        assert_eq!(extract_assigned_ip(empty), None);
        assert_eq!(extract_gateway(empty), None);
        assert_eq!(
            extract_assigned_ip("PUSH_REPLY,ifconfig 10.20.0.2,route-gateway 10.20.0.1").as_deref(),
            Some("10.20.0.2")
        );
        assert_eq!(
            extract_gateway("PUSH_REPLY,route-gateway 10.20.0.1,topology subnet").as_deref(),
            Some("10.20.0.1")
        );
        assert_eq!(
            extract_gateway("EVENT: CONNECTED_FAILED bad gw=[10.20.0.1/]"),
            None
        );
    }

    #[test]
    fn traffic_counters_are_read_from_engine_stats_lines() {
        assert_eq!(extract_counter("BYTES_IN : 3186", "BYTES_IN"), Some(3186));
        assert_eq!(
            extract_counter("STATS: BYTES_OUT : 5947", "BYTES_OUT"),
            Some(5947)
        );
        assert_eq!(extract_counter("TUN_BYTES_IN : 2849", "BYTES_IN"), None);
        assert_eq!(extract_counter("PACKETS_IN : 8", "BYTES_IN"), None);
    }
}
