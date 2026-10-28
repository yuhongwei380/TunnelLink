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

#[derive(Clone, Deserialize, Serialize)]
pub struct ConnectOptions {
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
    state: &'static str,
    started: Option<Instant>,
    last_error: String,
    logs: VecDeque<Log>,
    assigned_ip: Option<String>,
    gateway_addr: Option<String>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            state: "DISCONNECTED",
            started: None,
            last_error: String::new(),
            logs: VecDeque::new(),
            assigned_ip: None,
            gateway_addr: None,
        }
    }
}
impl Data {
    fn log(&mut self, source: &str, line: impl Into<String>) {
        self.logs.push_back(Log {
            ts: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            source: source.into(),
            line: line.into(),
        });
        while self.logs.len() > 600 {
            self.logs.pop_front();
        }
    }
    fn error(&mut self, message: impl Into<String>) {
        self.last_error = message.into();
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
    service: String,
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
    pub fn new(service: String) -> Self {
        Self {
            data: Arc::new(Mutex::new(Data::default())),
            session: Arc::new(Mutex::new(None)),
            credential_io: Arc::new(Mutex::new(())),
            generation: Arc::new(AtomicU64::new(0)),
            service,
        }
    }
    pub fn connect(&self, mut options: ConnectOptions) -> Result<Value, String> {
        options.username = options.username.trim().into();
        if options.username.is_empty()
            || options.password.is_empty()
            || options.username.contains('\0')
            || options.password.contains('\0')
        {
            return Ok(
                json!({ "ok": false, "error": "Username and password are required and must not contain NUL." }),
            );
        }
        if options.username.len() + options.password.len() > 16 * 1024 {
            return Ok(json!({ "ok": false, "error": "Credentials are too long." }));
        }
        let mut session = self.session.lock().unwrap();
        if session.as_ref().is_some_and(|s| !s.thread.is_finished()) {
            return Ok(json!({ "ok": true, "state": self.data.lock().unwrap().state }));
        }
        if let Some(old) = session.take() {
            let _ = old.thread.join();
        }
        {
            let mut data = self.data.lock().unwrap();
            data.state = "CONNECTING";
            data.started = None;
            data.last_error.clear();
            data.assigned_ip = None;
            data.gateway_addr = None;
            data.log("system", "Connection requested (Tauri / OpenVPN 3).");
        }
        let cancel = Arc::new(AtomicBool::new(false));
        let controller = self.clone();
        let stop = cancel.clone();
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let thread = thread::spawn(move || {
            if let Err(error) = controller.run_session(options, &stop, generation) {
                if !stop.load(Ordering::SeqCst) {
                    controller.data.lock().unwrap().error(error);
                }
            }
            let mut data = controller.data.lock().unwrap();
            data.state = "DISCONNECTED";
            data.started = None;
            data.assigned_ip = None;
            data.gateway_addr = None;
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
        json!({ "ok": true, "state": "DISCONNECTED" })
    }
    pub fn status(&self) -> Value {
        let data = self.data.lock().unwrap();
        json!({ "state": data.state, "uptime": data.started.map(|t| t.elapsed().as_secs()).unwrap_or(0),
            "bytesIn": 0, "bytesOut": 0, "metricsAvailable": false,
            "assignedIp": data.assigned_ip, "gatewayAddress": data.gateway_addr,
            "lastError": data.last_error, "engine": "openvpn3" })
    }
    pub fn logs(&self) -> Value {
        let data = self.data.lock().unwrap();
        let logs: Vec<_> = data
            .logs
            .iter()
            .skip(data.logs.len().saturating_sub(300))
            .collect();
        json!({ "ok": true, "logs": logs, "lastError": data.last_error, "state": data.state })
    }
    pub fn clear_logs(&self) -> Value {
        self.data.lock().unwrap().logs.clear();
        json!({ "ok": true })
    }
    fn keyring(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, "vpn-account").map_err(|e| e.to_string())
    }
    pub fn credentials(&self) -> Result<Value, String> {
        let _guard = self.credential_io.lock().unwrap();
        match self.keyring()?.get_password() {
            Ok(value) => {
                let credentials: ConnectOptions =
                    serde_json::from_str(&value).map_err(|e| e.to_string())?;
                Ok(json!({ "ok": true, "credentials": credentials }))
            }
            Err(keyring::Error::NoEntry) => Ok(json!({ "ok": true, "credentials": null })),
            Err(error) => Err(format!("Unable to read system credential store: {error}")),
        }
    }
    fn persist(&self, options: &ConnectOptions, generation: u64) -> Result<(), String> {
        let _guard = self.credential_io.lock().unwrap();
        if generation != self.generation.load(Ordering::SeqCst) {
            return Ok(());
        }
        let entry = self.keyring()?;
        if options.remember {
            entry
                .set_password(&serde_json::to_string(options).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())
        } else {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        }
    }
    fn run_session(
        &self,
        options: ConnectOptions,
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
        for name in ["request.json", "engine.log", "exit.json", "heartbeat"] {
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
            if name == "request.json" {
                serde_json::to_writer(
                    &mut file,
                    &worker::Request {
                        username: options.username.clone(),
                        password: options.password.clone(),
                        parent_pid: std::process::id(),
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
                data.log("engine", line.replace(&options.password, "[redacted]"));
                if let Some(ip) = extract_assigned_ip(&line) {
                    data.assigned_ip = Some(ip);
                }
                if let Some(endpoint) = extract_gateway(&line) {
                    data.gateway_addr = Some(endpoint);
                }
                if let Some(error) = fatal_error(&line) {
                    data.error(error.replace(&options.password, "[redacted]"));
                    cancel.store(true, Ordering::SeqCst);
                } else if connected(&line) && !cancel.load(Ordering::SeqCst) {
                    data.state = "CONNECTED";
                    data.started = Some(Instant::now());
                    drop(data);
                    if !connected_once {
                        // Keychain may prompt the user; never block heartbeats or cancellation.
                        let controller = self.clone();
                        let credentials = options.clone();
                        thread::spawn(move || {
                            if let Err(error) = controller.persist(&credentials, generation) {
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
                    data.state = "CONNECTING";
                    data.started = None;
                    data.assigned_ip = None;
                    data.gateway_addr = None;
                    deadline = Instant::now() + Duration::from_secs(45);
                } else if line.contains("EVENT: DISCONNECTED") {
                    data.state = "DISCONNECTED";
                    data.started = None;
                    data.assigned_ip = None;
                    data.gateway_addr = None;
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
        for i in 0..1000 {
            controller.data.lock().unwrap().log("engine", i.to_string());
        }
        assert_eq!(controller.data.lock().unwrap().logs.len(), 600);
        assert_eq!(controller.logs()["logs"].as_array().unwrap().len(), 300);
        assert_eq!(controller.status()["metricsAvailable"], false);
        assert_eq!(controller.status()["state"], "DISCONNECTED");
    }
    #[test]
    fn invalid_credentials_do_not_spawn_a_process() {
        let controller = Controller::new("test".into());
        assert_eq!(
            controller
                .connect(ConnectOptions {
                    username: " ".into(),
                    password: "p".into(),
                    remember: false
                })
                .unwrap()["ok"],
            false
        );
        assert!(controller.session.lock().unwrap().is_none());
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
}
