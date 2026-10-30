//! OpenVPN Connect profile validation with an explicit safety boundary. Never
//! pass unresolved file references or executable directives to the elevated
//! supervisor; ordinary client directives are validated by the bundled engine.
use base64::Engine;
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

pub const MAX_PROFILE: usize = 8 * 1024 * 1024;
pub const MAX_INPUT: usize = 2 * 1024 * 1024;
pub const MAX_MATERIAL: usize = 1024 * 1024;

fn pem_der(value: &str) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut result = Vec::new();
    let mut rest = value.trim();
    while !rest.is_empty() {
        let (label, body) = rest
            .strip_prefix("-----BEGIN ")
            .ok_or("Invalid PEM header")?
            .split_once("-----")
            .ok_or("Invalid PEM header")?;
        let end = format!("-----END {label}-----");
        let (data, tail) = body.split_once(&end).ok_or("Incomplete PEM block")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(
                data.chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>(),
            )
            .map_err(|_| "Invalid PEM encoding")?;
        result.push((label.to_string(), bytes));
        rest = tail.trim();
    }
    Ok(result)
}

fn signing_key(value: &str) -> Result<std::sync::Arc<dyn rustls::sign::SigningKey>, String> {
    use rustls::pki_types::{
        PrivateKeyDer, PrivatePkcs1KeyDer, PrivatePkcs8KeyDer, PrivateSec1KeyDer,
    };
    let (label, bytes) = pem_der(value)?
        .into_iter()
        .next()
        .ok_or("Missing private key")?;
    let key = match label.as_str() {
        "RSA PRIVATE KEY" => PrivateKeyDer::Pkcs1(PrivatePkcs1KeyDer::from(bytes)),
        "PRIVATE KEY" => PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(bytes)),
        "EC PRIVATE KEY" => PrivateKeyDer::Sec1(PrivateSec1KeyDer::from(bytes)),
        _ => return Err("Unsupported private key format".into()),
    };
    rustls::crypto::ring::sign::any_supported_type(&key)
        .map_err(|_| "Invalid or unsupported private key".into())
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub host: String,
    pub port: u16,
    pub protocol: String,
}

pub struct Parsed {
    pub content: String,
    pub endpoints: Vec<Endpoint>,
    pub requires_auth: bool,
    pub has_client_certificate: bool,
    pub dependencies: BTreeMap<String, String>,
}

const PROTOCOLS: &[&str] = &[
    "udp",
    "udp4",
    "udp6",
    "tcp",
    "tcp-client",
    "tcp4",
    "tcp6",
    "tcp4-client",
    "tcp6-client",
];

// OpenVPN Connect documents these directives as unsupported or unsafe for a
// profile handled by this elevated client. Ordinary client directives are
// left to the bundled OpenVPN 3 engine so this list does not become a second,
// incomplete OpenVPN parser.
const BLOCKED_DIRECTIVES: &[&str] = &[
    "askpass",
    "auth-user-pass-verify",
    "capath",
    "cd",
    "chroot",
    "client-connect",
    "client-disconnect",
    "client-config-dir",
    "config",
    "cryptoapicert",
    "daemon",
    "down",
    "down-pre",
    "execve",
    "dev-node",
    "group",
    "ifconfig-pool-persist",
    "ipchange",
    "fragment",
    "learn-address",
    "log",
    "log-append",
    "management",
    "plugin",
    "route-pre-down",
    "route-noexec",
    "route-up",
    "replay-persist",
    "script-security",
    "secret",
    "setenv-safe",
    "socks-proxy",
    "status",
    "status-version",
    "syslog",
    "tls-server",
    "tls-verify",
    "tls-crypt-v2-verify",
    "tls-export-cert",
    "tmp-dir",
    "up",
    "up-delay",
    "user",
    "pkcs11-id",
    "pkcs11-providers",
    "writepid",
];

// These options take a file name in an OpenVPN profile.  The importer turns
// them into inline data after the user explicitly selects each file.  Keeping
// this list separate from BLOCKED_DIRECTIVES is important: a valid client
// profile may use any of these options, but the elevated worker must never
// resolve a path supplied by profile text on its own.
const EXTERNAL_PATH_DIRECTIVES: &[&str] = &[
    "auth-user-pass",
    "auth-gen-token-secret",
    "ca",
    "cert",
    "crl-verify",
    "dh",
    "extra-certs",
    "key",
    "http-proxy-user-pass",
    "pkcs12",
    "tls-auth",
    "tls-crypt",
    "tls-crypt-v2",
];

const HTTP_PROXY_AUTH_MODES: &[&str] = &[
    "", "stdin", "none", "basic", "ntlm", "ntlm2", "auto", "auto-nct",
];

const TLS_CRYPT_V2_MODES: &[&str] = &["force-cookie", "allow-noncookie"];

fn blocked_directive(name: &str, in_connection: bool) -> Option<&'static str> {
    if BLOCKED_DIRECTIVES.contains(&name) {
        return Some("unsupported or executable directive");
    }
    if EXTERNAL_PATH_DIRECTIVES.contains(&name) {
        return Some("external file reference is not supported");
    }
    if in_connection && matches!(name, "http-proxy" | "http-proxy-option") {
        return Some("proxy directives are not supported in <connection> blocks");
    }
    None
}

fn parse_protocol(value: &str) -> Result<String, String> {
    if PROTOCOLS.contains(&value) {
        Ok(value.to_string())
    } else {
        Err("Unsupported remote protocol".into())
    }
}

fn parse_endpoint(
    fields: &[String],
    default_port: u16,
    default_protocol: &str,
) -> Result<Endpoint, String> {
    if !(2..=4).contains(&fields.len()) || fields[0].trim_start_matches("--") != "remote" {
        return Err("Invalid remote directive".into());
    }
    if fields[1].is_empty()
        || fields[1].chars().count() > 255
        || fields[1].chars().any(char::is_control)
    {
        return Err("Invalid remote host".into());
    }
    let (port, protocol) = match fields.len() {
        2 => (default_port, default_protocol.to_string()),
        3 if PROTOCOLS.contains(&fields[2].as_str()) => (default_port, fields[2].clone()),
        3 => (
            fields[2]
                .parse::<u16>()
                .map_err(|_| "Invalid remote port")?,
            default_protocol.to_string(),
        ),
        4 => (
            fields[2]
                .parse::<u16>()
                .map_err(|_| "Invalid remote port")?,
            parse_protocol(&fields[3])?,
        ),
        _ => unreachable!(),
    };
    if port == 0 {
        return Err("Invalid remote port".into());
    }
    Ok(Endpoint {
        host: fields[1].clone(),
        port,
        protocol: parse_protocol(&protocol)?,
    })
}

fn parse_connection_block(
    content: &str,
    default_port: u16,
    default_protocol: &str,
) -> Result<Vec<Endpoint>, String> {
    let mut port = default_port;
    let mut protocol = default_protocol.to_string();
    let mut remotes = Vec::new();
    for raw in content.lines() {
        let fields = tokens(raw.trim())?;
        if fields.is_empty() {
            continue;
        }
        let name = fields[0].trim_start_matches("--");
        match name {
            "remote" => remotes.push(fields),
            "setenv" if fields.get(1).is_some_and(|value| value == "opt") => {
                let Some(optional_name) = fields.get(2) else {
                    return Err("Invalid setenv opt directive in <connection> block".into());
                };
                if let Some(reason) =
                    blocked_directive(optional_name.trim_start_matches("--"), true)
                {
                    return Err(format!(
                        "Optional directive '{}' in <connection> block is {reason}",
                        optional_name.trim_start_matches("--")
                    ));
                }
            }
            "setenv" => {}
            "port" | "rport" => {
                if fields.len() != 2 {
                    return Err(format!("Invalid {name} directive in <connection> block"));
                }
                port = fields[1]
                    .parse::<u16>()
                    .map_err(|_| format!("Invalid {name} in <connection> block"))?;
                if port == 0 {
                    return Err(format!("Invalid {name} in <connection> block"));
                }
            }
            "proto" => {
                if fields.len() != 2 {
                    return Err("Invalid proto directive in <connection> block".into());
                }
                protocol = parse_protocol(&fields[1])?;
            }
            "tls-auth" => {
                if !(2..=3).contains(&fields.len()) {
                    return Err("Invalid tls-auth directive in <connection> block".into());
                }
            }
            "tls-crypt" => {
                if fields.len() != 2 {
                    return Err("Invalid tls-crypt directive in <connection> block".into());
                }
            }
            "tls-crypt-v2" => {
                if !(2..=3).contains(&fields.len())
                    || (fields.len() == 3 && !TLS_CRYPT_V2_MODES.contains(&fields[2].as_str()))
                {
                    return Err("Invalid tls-crypt-v2 directive in <connection> block".into());
                }
            }
            _ => {
                if let Some(reason) = blocked_directive(name, true) {
                    return Err(format!(
                        "Directive '{name}' in <connection> block is {reason}"
                    ));
                }
            }
        }
    }
    remotes
        .into_iter()
        .map(|fields| parse_endpoint(&fields, port, &protocol))
        .collect()
}

/// Replace file references used by connection-scoped control-channel options
/// with OpenVPN's inline marker.  Connection profiles are emitted into the
/// normalized profile before the shared inline material is appended, so the
/// elevated worker never needs to resolve a path from the imported text.
fn normalize_connection_block(
    content: &str,
    references: &mut BTreeMap<String, String>,
) -> Result<String, String> {
    let mut normalized = String::new();
    for raw in content.lines() {
        let fields = tokens(raw.trim())?;
        let replacement = if fields.is_empty() {
            None
        } else {
            let name = fields[0].trim_start_matches("--");
            match name {
                "tls-auth" => {
                    if !(2..=3).contains(&fields.len()) || fields[1].is_empty() {
                        return Err("Invalid tls-auth directive in <connection> block".into());
                    }
                    if fields.len() == 3 && !matches!(fields[2].as_str(), "0" | "1") {
                        return Err("Invalid tls-auth direction in <connection> block".into());
                    }
                    if fields[1] == "[inline]" {
                        None
                    } else {
                        if let Some(existing) = references.get(name) {
                            if existing != &fields[1] {
                                return Err(
                                    "Different external tls-auth files in connection profiles are not supported"
                                        .into(),
                                );
                            }
                        } else {
                            references.insert(name.to_string(), fields[1].clone());
                        }
                        Some(if fields.len() == 3 {
                            format!("tls-auth [inline] {}", fields[2])
                        } else {
                            "tls-auth [inline]".into()
                        })
                    }
                }
                "tls-crypt" => {
                    if fields.len() != 2 || fields[1].is_empty() {
                        return Err("Invalid tls-crypt directive in <connection> block".into());
                    }
                    if fields[1] == "[inline]" {
                        None
                    } else {
                        if let Some(existing) = references.get(name) {
                            if existing != &fields[1] {
                                return Err(
                                    "Different external tls-crypt files in connection profiles are not supported"
                                        .into(),
                                );
                            }
                        } else {
                            references.insert(name.to_string(), fields[1].clone());
                        }
                        Some("tls-crypt [inline]".into())
                    }
                }
                "tls-crypt-v2" => {
                    if !(2..=3).contains(&fields.len())
                        || fields[1].is_empty()
                        || (fields.len() == 3 && !TLS_CRYPT_V2_MODES.contains(&fields[2].as_str()))
                    {
                        return Err("Invalid tls-crypt-v2 directive in <connection> block".into());
                    }
                    if fields[1] == "[inline]" {
                        None
                    } else {
                        if let Some(existing) = references.get(name) {
                            if existing != &fields[1] {
                                return Err(
                                    "Different external tls-crypt-v2 files in connection profiles are not supported"
                                        .into(),
                                );
                            }
                        } else {
                            references.insert(name.to_string(), fields[1].clone());
                        }
                        Some(if fields.len() == 3 {
                            format!("tls-crypt-v2 [inline] {}", fields[2])
                        } else {
                            "tls-crypt-v2 [inline]".into()
                        })
                    }
                }
                _ => None,
            }
        };
        if let Some(line) = replacement {
            normalized.push_str(&line);
        } else {
            normalized.push_str(raw);
        }
        normalized.push('\n');
    }
    Ok(normalized)
}

const INLINE_BLOCKS: &[&str] = &[
    "auth-user-pass",
    "auth-gen-token-secret",
    "ca",
    "cert",
    "connection",
    "crl-verify",
    "dh",
    "extra-certs",
    "http-proxy-user-pass",
    "key",
    "peer-fingerprint",
    "pkcs12",
    "tls-auth",
    "tls-crypt",
    "tls-crypt-v2",
    "verify-hash",
];

fn validate_inline_block(kind: &str, content: &str) -> Result<(), String> {
    if content.len() > MAX_MATERIAL || content.contains('\0') {
        return Err(format!("Invalid or oversized {kind} block"));
    }
    let closing = format!("</{kind}>");
    if content.lines().any(|line| line.trim() == closing) {
        return Err(format!("Invalid nested closing tag in {kind} block"));
    }
    match kind {
        "ca" | "cert" | "key" | "crl-verify" | "tls-auth" | "tls-crypt" => {
            validate_material(kind, content)
        }
        "auth-user-pass" | "http-proxy-user-pass" => {
            let lines = content
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .collect::<Vec<_>>();
            if lines.is_empty() || lines.len() > 2 {
                Err(format!("Invalid {kind} block"))
            } else {
                Ok(())
            }
        }
        // These inline options are text or binary material interpreted by the
        // bundled OpenVPN engine.  They are deliberately not treated as
        // executable paths; the size/NUL checks above are the importer
        // boundary and the engine performs the option-specific validation.
        "auth-gen-token-secret" | "dh" | "peer-fingerprint" | "verify-hash" => {
            if content.trim().is_empty() {
                Err(format!("Empty {kind} block"))
            } else {
                Ok(())
            }
        }
        "connection" => Ok(()),
        "pkcs12" => base64::engine::general_purpose::STANDARD
            .decode(
                content
                    .chars()
                    .filter(|c| !c.is_whitespace())
                    .collect::<String>(),
            )
            .map(|_| ())
            .map_err(|_| "Invalid pkcs12 base64 data".into()),
        _ => {
            if content.trim().is_empty() {
                Err(format!("Empty {kind} block"))
            } else {
                Ok(())
            }
        }
    }
}

pub fn tokens(line: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut token_started = false;
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // OpenVPN's option parser uses a backslash to quote the next
            // character, both inside and outside quoted values.  Preserve a
            // literal trailing backslash as an error instead of silently
            // changing a path or secret.
            let Some(next) = chars.next() else {
                return Err("Trailing escape in option".into());
            };
            word.push(next);
            token_started = true;
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_some() {
            word.push(c);
            token_started = true;
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
            token_started = true;
        } else if matches!(c, '#' | ';') && !token_started {
            break;
        } else if c.is_whitespace() {
            if token_started {
                result.push(std::mem::take(&mut word));
                token_started = false;
            }
        } else {
            word.push(c);
            token_started = true;
        }
    }
    if quote.is_some() {
        return Err("Unterminated quoted option".into());
    }
    if token_started {
        result.push(word);
    }
    Ok(result)
}

pub fn validate_material(kind: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_MATERIAL
        || value.contains('\0')
        || value.contains('<')
        || value.contains('>')
    {
        return Err(format!("Invalid or oversized {kind} material"));
    }
    if value.contains("ENCRYPTED") {
        return Err("Encrypted private keys are not supported".into());
    }
    let allowed: &[&str] = if kind == "key" {
        &["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY"]
    } else if kind == "crl-verify" {
        &["X509 CRL", "CRL"]
    } else if kind == "dh" {
        &["DH PARAMETERS"]
    } else if matches!(kind, "tls-auth" | "tls-crypt") {
        &["OpenVPN Static key V1"]
    } else {
        &["CERTIFICATE"]
    };
    let filtered = value
        .lines()
        .filter(|line| !line.trim_start().starts_with('#'))
        .collect::<Vec<_>>()
        .join("\n");
    let mut remaining = filtered.trim();
    let mut count = 0;
    while !remaining.is_empty() {
        let label = allowed
            .iter()
            .find(|label| remaining.starts_with(&format!("-----BEGIN {label}-----")))
            .ok_or_else(|| format!("Invalid {kind} PEM block"))?;
        let start = format!("-----BEGIN {label}-----");
        let end = format!("-----END {label}-----");
        let (body, tail) = remaining[start.len()..]
            .split_once(&end)
            .ok_or_else(|| format!("Incomplete {kind} PEM block"))?;
        let body: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        if kind.starts_with("tls-") {
            if body.len() != 512 || !body.bytes().all(|v| v.is_ascii_hexdigit()) {
                return Err("Invalid static TLS key".into());
            }
        } else {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(body)
                .map_err(|_| format!("Invalid {kind} encoding"))?;
            // DER sequence envelope. Cryptographic trust and key matching are
            // checked by the bundled engine before establishing a tunnel.
            if bytes.len() < 16 || bytes[0] != 0x30 {
                return Err(format!("Invalid {kind} DER data"));
            }
        }
        remaining = tail.trim();
        count += 1;
    }
    if count == 0 || (kind == "key" && count != 1) {
        return Err(format!("Missing or ambiguous {kind} material"));
    }
    if kind == "key" {
        signing_key(&filtered)?;
    } else if kind == "crl-verify" {
        // The OpenVPN engine performs the CRL semantic checks.
    } else if kind == "dh" {
        // DH parameters are validated by the OpenVPN engine.
    } else if !kind.starts_with("tls-") {
        let mut roots = rustls::RootCertStore::empty();
        for (_, bytes) in pem_der(&filtered)? {
            roots
                .add(rustls::pki_types::CertificateDer::from(bytes))
                .map_err(|_| format!("Invalid {kind} certificate"))?;
        }
    }
    Ok(())
}

pub fn parse(
    input: &str,
    materials: &BTreeMap<String, String>,
    allow_external: bool,
) -> Result<Parsed, String> {
    if input.len() > MAX_PROFILE || input.contains('\0') || input.trim().is_empty() {
        return Err("Empty, binary or oversized VPN profile".into());
    }
    let mut output = String::new();
    let mut blocks = HashSet::new();
    let mut references = BTreeMap::new();
    let mut remote: Vec<Vec<String>> = Vec::new();
    let mut connection_blocks: Vec<(String, u16, String)> = Vec::new();
    let mut port = 1194;
    let mut protocol = "udp".to_string();
    let mut requires_auth = false;
    let mut client_cert_not_required = false;
    let mut block: Option<(String, String)> = None;
    let mut certificate = None;
    let mut private_key = None;
    // Do not maintain a second, incomplete OpenVPN option whitelist here.
    // OpenVPN 3 is the source of truth for client directives and their
    // argument counts.  This parser only handles options which affect local
    // file access, profile metadata, or the endpoint list, and blocks the
    // unsafe directives listed above.
    for (i, raw) in input.trim_start_matches('\u{feff}').lines().enumerate() {
        let line = raw.trim();
        if let Some((kind, content)) = &mut block {
            if line == format!("</{kind}>") {
                let normalized_content = if kind == "connection" {
                    let normalized = normalize_connection_block(content, &mut references)?;
                    // OpenVPN applies top-level connection defaults to blocks
                    // that appear after the option.  Capture them at the
                    // closing tag instead of applying the final global value
                    // to every block (the engine still receives the original
                    // ordering and performs the authoritative interpretation).
                    connection_blocks.push((normalized.clone(), port, protocol.clone()));
                    normalized
                } else {
                    validate_inline_block(kind, content)?;
                    blocks.insert(kind.clone());
                    if kind == "cert" {
                        certificate = Some(content.clone());
                    }
                    if kind == "key" {
                        private_key = Some(content.clone());
                    }
                    if kind == "auth-user-pass"
                        && content
                            .lines()
                            .filter(|line| !line.trim().is_empty())
                            .count()
                            < 2
                    {
                        requires_auth = true;
                    }
                    content.clone()
                };
                output.push_str(&format!("<{kind}>\n{normalized_content}</{kind}>\n"));
                block = None;
            } else {
                content.push_str(raw);
                content.push('\n');
            }
            continue;
        }
        let fields = tokens(line).map_err(|e| format!("Line {}: {e}", i + 1))?;
        if fields.is_empty() {
            continue;
        }
        let name = fields[0].trim_start_matches("--");
        if name.starts_with('<') {
            let kind = name.trim_start_matches('<').trim_end_matches('>');
            if fields.len() != 1 || name != format!("<{kind}>") || !INLINE_BLOCKS.contains(&kind) {
                return Err(format!(
                    "Unsupported or duplicate inline block at line {}",
                    i + 1
                ));
            }
            block = Some((kind.into(), String::new()));
            continue;
        }
        match name {
            "setenv" => {
                if fields.get(1).is_some_and(|value| value == "opt") {
                    if fields.len() != 3 {
                        return Err("Invalid setenv opt directive".into());
                    }
                    if let Some(optional_name) = fields.get(2) {
                        if let Some(reason) =
                            blocked_directive(optional_name.trim_start_matches("--"), false)
                        {
                            return Err(format!(
                                "Optional directive '{}' is {reason}",
                                optional_name.trim_start_matches("--")
                            ));
                        }
                    }
                } else if fields.len() == 3 && fields[1] == "CLIENT_CERT" {
                    if fields[2] != "0" {
                        return Err("Only setenv CLIENT_CERT 0 is supported".into());
                    }
                    client_cert_not_required = true;
                    // OpenVPN Connect uses this metadata directive to state
                    // that a profile intentionally has no client certificate.
                } else if fields.len() != 3 {
                    return Err("Invalid setenv directive".into());
                }
            }
            "client-cert-not-required" => {
                if fields.len() != 1 {
                    return Err("client-cert-not-required does not accept arguments".into());
                }
                client_cert_not_required = true;
                // This legacy server-side directive is intentionally not sent
                // to OpenVPN 3 (which reports it as unsupported).  OpenVPN
                // Connect's documented compatibility marker has the same
                // meaning for a client profile.
                output.push_str("setenv CLIENT_CERT 0\n");
                continue;
            }
            "http-proxy" => {
                if !(3..=5).contains(&fields.len()) {
                    return Err("Invalid http-proxy directive".into());
                }
                // OpenVPN permits the third argument to be a credentials
                // file.  Resolve that file through the same explicit picker
                // used by http-proxy-user-pass instead of allowing the engine
                // to open a profile-controlled path.
                if fields.len() >= 4 && !HTTP_PROXY_AUTH_MODES.contains(&fields[3].as_str()) {
                    references.insert("http-proxy-user-pass".into(), fields[3].clone());
                    let method = fields
                        .get(4)
                        .map(String::as_str)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("auto");
                    if !HTTP_PROXY_AUTH_MODES.contains(&method) {
                        return Err("Invalid http-proxy authentication method".into());
                    }
                    // Once the credentials are moved into an inline block,
                    // the auth method becomes the third argument.  Keeping a
                    // supplied method (basic/ntlm/auto...) is important: it
                    // changes proxy negotiation semantics.
                    output.push_str(&format!(
                        "http-proxy {} {} {}\n",
                        fields[1], fields[2], method
                    ));
                    continue;
                }
            }
            "ca"
            | "cert"
            | "key"
            | "auth-gen-token-secret"
            | "dh"
            | "extra-certs"
            | "tls-auth"
            | "tls-crypt"
            | "crl-verify"
            | "tls-crypt-v2"
            | "pkcs12"
            | "http-proxy-user-pass" => {
                if name == "dh" && fields.get(1).is_some_and(|value| value == "none") {
                    // OpenVPN uses `dh none` to disable finite-field DH and
                    // rely on ECDH.  `none` is a value, not a file path.
                    output.push_str(raw);
                    output.push('\n');
                    continue;
                }
                let valid_arity = match name {
                    "tls-auth" => (2..=3).contains(&fields.len()),
                    "tls-crypt-v2" => (2..=3).contains(&fields.len()),
                    _ => fields.len() == 2,
                };
                if name == "tls-auth"
                    && fields.len() == 3
                    && !matches!(fields[2].as_str(), "0" | "1")
                {
                    return Err("Invalid tls-auth direction".into());
                }
                if name == "tls-crypt-v2"
                    && fields.len() == 3
                    && !TLS_CRYPT_V2_MODES.contains(&fields[2].as_str())
                {
                    return Err("Invalid tls-crypt-v2 mode".into());
                }
                if !valid_arity || fields[1].is_empty() {
                    return Err(format!("Invalid {name} directive"));
                }
                // OpenVPN follows its normal option precedence rules for
                // repeated singleton file options.  Keep the last reference
                // (the engine's effective value) while still preserving any
                // inline blocks already present in the profile.
                references.insert(name.to_string(), fields[1].clone());
                if name == "tls-auth" && fields.len() == 3 {
                    // The optional direction/algorithm argument belongs to
                    // the option, not to the file.  Rebind the selected file
                    // to OpenVPN's inline marker before appending the block.
                    output.push_str(&format!("{name} [inline] {}\n", fields[2]));
                }
                if name == "tls-crypt-v2" && fields.len() == 3 {
                    output.push_str(&format!("{name} [inline] {}\n", fields[2]));
                }
                continue;
            }
            "auth-user-pass" => {
                if fields.len() == 2 {
                    if fields[1].is_empty() || fields[1] == "stdin" {
                        // An empty argument and stdin both mean interactive
                        // credentials.  They are supplied through the app's
                        // credential fields, not read from a profile path.
                        requires_auth = true;
                        output.push_str("auth-user-pass\n");
                        continue;
                    } else {
                        references.insert(name.to_string(), fields[1].clone());
                        continue;
                    }
                } else if fields.len() != 1 {
                    return Err("Invalid auth-user-pass directive".into());
                }
                requires_auth = true;
            }
            "remote" => {
                if !(2..=4).contains(&fields.len()) {
                    return Err("Invalid remote directive".into());
                }
                remote.push(fields.clone());
            }
            "port" | "rport" => {
                if fields.len() != 2 {
                    return Err(format!("Invalid {name} directive"));
                }
                port = fields
                    .get(1)
                    .ok_or("Missing port")?
                    .parse::<u16>()
                    .map_err(|_| "Invalid port")?;
            }
            "proto" => {
                if fields.len() != 2 {
                    return Err("Invalid proto directive".into());
                }
                protocol = parse_protocol(&fields[1])?;
            }
            "dev" => {
                // OpenVPN accepts numbered and platform-specific device names
                // (for example tun2, tap4, or utun).  Keep the value opaque so
                // the bundled engine, rather than this importer, decides what
                // the current platform supports.
                if fields.len() != 2
                    || fields[1].is_empty()
                    || fields[1].chars().count() > 64
                    || fields[1].chars().any(char::is_control)
                    || fields[1].chars().any(|c| matches!(c, '/' | '\\'))
                {
                    return Err("Invalid dev directive".into());
                }
            }
            _ => {
                if let Some(reason) = blocked_directive(name, false) {
                    return Err(format!("Directive '{name}' is {reason}"));
                }
            }
        }
        output.push_str(raw);
        output.push('\n');
    }
    if block.is_some() {
        return Err("Unclosed inline certificate block".into());
    }
    let mut dependencies = BTreeMap::new();
    for (kind, path) in references {
        if path == "[inline]" {
            if !blocks.contains(&kind) {
                return Err(format!("Missing inline {kind}"));
            }
            continue;
        }
        if blocks.contains(&kind) {
            return Err(format!("Both inline and external {kind} specified"));
        }
        let embeddable = [
            "auth-user-pass",
            "auth-gen-token-secret",
            "ca",
            "cert",
            "crl-verify",
            "dh",
            "extra-certs",
            "http-proxy-user-pass",
            "key",
            "pkcs12",
            "tls-auth",
            "tls-crypt",
            "tls-crypt-v2",
        ];
        if !embeddable.contains(&kind.as_str()) {
            return Err(format!("Embed {kind} in the profile before importing"));
        }
        if let Some(value) = materials.get(&kind) {
            if kind == "pkcs12" {
                validate_inline_block(&kind, value)?;
            } else if matches!(kind.as_str(), "auth-user-pass" | "http-proxy-user-pass") {
                validate_inline_block(&kind, value)?;
            } else if kind == "auth-gen-token-secret" {
                validate_inline_block(&kind, value)?;
            } else if kind == "tls-crypt-v2" {
                if value.trim().is_empty() {
                    return Err("Invalid tls-crypt-v2 material".into());
                }
            } else {
                validate_material(&kind, value)?;
            }
            if kind == "cert" {
                certificate = Some(value.clone());
            }
            if kind == "key" {
                private_key = Some(value.clone());
            }
            if kind == "auth-user-pass"
                && value.lines().filter(|line| !line.trim().is_empty()).count() < 2
            {
                requires_auth = true;
            }
            output.push_str(&format!(
                "<{kind}>\n{}\n</{kind}>\n",
                value.trim().replace("\r\n", "\n")
            ));
            blocks.insert(kind);
        } else if allow_external {
            dependencies.insert(kind, path);
        } else {
            return Err(format!("Unresolved external {kind}"));
        }
    }
    let mut endpoints = remote
        .into_iter()
        .map(|fields| parse_endpoint(&fields, port, &protocol))
        .collect::<Result<Vec<_>, _>>()?;
    for (connection, default_port, default_protocol) in connection_blocks {
        endpoints.extend(parse_connection_block(
            &connection,
            default_port,
            &default_protocol,
        )?);
    }
    if endpoints.is_empty() {
        return Err("The profile must contain a remote server".into());
    }
    if dependencies.is_empty() {
        if blocks.contains("cert") != blocks.contains("key") {
            return Err("Client certificate and private key must be supplied together".into());
        }
        if !requires_auth
            && !blocks.contains("cert")
            && !blocks.contains("pkcs12")
            && !blocks.contains("auth-user-pass")
            && !client_cert_not_required
        {
            return Err("Profile needs auth-user-pass or a client certificate and key".into());
        }
        if let (Some(cert), Some(key)) = (certificate, private_key) {
            let certs = pem_der(&cert)?
                .into_iter()
                .map(|(_, data)| rustls::pki_types::CertificateDer::from(data))
                .collect();
            let certified = rustls::sign::CertifiedKey::new(certs, signing_key(&key)?);
            certified
                .keys_match()
                .map_err(|_| "Client certificate does not match the private key")?;
        }
    }
    if output.len() > MAX_PROFILE {
        return Err("Normalized profile is too large".into());
    }
    Ok(Parsed {
        content: output,
        endpoints,
        requires_auth,
        has_client_certificate: blocks.contains("cert") || blocks.contains("pkcs12"),
        dependencies,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_defaults_and_quotes() {
        let p = parse("client\nremote \"vpn.example.com\"\nremote 2001:db8::1 443 tcp-client\nport 1195\nauth-user-pass # prompt\n", &BTreeMap::new(), false).unwrap();
        assert_eq!(p.endpoints[0].port, 1195);
        assert_eq!(p.endpoints[1].host, "2001:db8::1");
        assert!(p.requires_auth);
    }
    #[test]
    fn official_connection_profiles_and_empty_arguments_are_supported() {
        let input = r#"client
dev tun
nobind
auth-user-pass
setenv CLIENT_CERT 0
<connection>
#proto tcp-client
remote vpn.example.test 11999 tcp
</connection>
<connection>
remote vpn.example.test 11999 udp
</connection>
http-proxy proxy.example.test 8080 "" basic
"#;
        let parsed = parse(input, &BTreeMap::new(), false).unwrap();
        assert_eq!(parsed.endpoints.len(), 2);
        assert_eq!(parsed.endpoints[0].protocol, "tcp");
        assert_eq!(parsed.endpoints[1].protocol, "udp");
        assert!(parsed
            .content
            .contains("http-proxy proxy.example.test 8080 \"\" basic"));
        assert!(parsed.content.contains("setenv CLIENT_CERT 0"));
    }
    #[test]
    fn repeated_file_option_uses_openvpn_last_value_semantics() {
        let parsed = parse(
            "client\nremote vpn.example.test\nauth-user-pass\nca first.pem\nca second.pem\n",
            &BTreeMap::new(),
            true,
        )
        .unwrap();
        assert_eq!(
            parsed.dependencies.get("ca"),
            Some(&"second.pem".to_string())
        );
    }
    #[test]
    fn proxy_auth_file_is_imported_as_inline_credentials() {
        let parsed = parse(
            "client\nremote vpn.example.test\nauth-user-pass\nhttp-proxy proxy.example.test 8080 proxy.txt basic\n",
            &BTreeMap::new(),
            true,
        )
        .unwrap();
        assert_eq!(
            parsed.dependencies.get("http-proxy-user-pass"),
            Some(&"proxy.txt".to_string())
        );
        assert!(parsed
            .content
            .contains("http-proxy proxy.example.test 8080 basic"));
    }
    #[test]
    fn tls_auth_direction_survives_external_material_import() {
        let key = format!(
            "-----BEGIN OpenVPN Static key V1-----\n{}\n-----END OpenVPN Static key V1-----",
            "A".repeat(512)
        );
        let parsed = parse(
            "client\nremote vpn.example.test\nauth-user-pass\ntls-auth ta.key 1\n",
            &BTreeMap::from([("tls-auth".into(), key)]),
            false,
        )
        .unwrap();
        assert!(parsed.content.contains("tls-auth [inline] 1"));
        assert!(parsed.content.contains("<tls-auth>"));
        assert_eq!(
            parse(&parsed.content, &BTreeMap::new(), false)
                .unwrap()
                .content,
            parsed.content
        );
    }
    #[test]
    fn connection_scoped_tls_material_is_normalized_without_losing_direction() {
        let key = format!(
            "-----BEGIN OpenVPN Static key V1-----\n{}\n-----END OpenVPN Static key V1-----",
            "A".repeat(512)
        );
        let parsed = parse(
            "client\nsetenv CLIENT_CERT 0\n<connection>\nremote vpn.example.test 11999 tcp\ntls-auth ta.key 1\n</connection>\n",
            &BTreeMap::from([("tls-auth".into(), key)]),
            false,
        )
        .unwrap();
        assert!(parsed
            .content
            .contains("tls-auth [inline] 1\n</connection>"));
        assert!(parsed.content.contains("<tls-auth>"));
        assert_eq!(parsed.endpoints.len(), 1);
        assert_eq!(parsed.endpoints[0].protocol, "tcp");
    }
    #[test]
    fn connection_defaults_follow_profile_order() {
        let parsed = parse(
            "client\nsetenv CLIENT_CERT 0\nport 1111\nproto tcp\n<connection>\nremote first.example\n</connection>\nport 2222\nproto udp\n<connection>\nremote second.example\n</connection>\n",
            &BTreeMap::new(),
            false,
        )
        .unwrap();
        assert_eq!(
            parsed
                .endpoints
                .iter()
                .map(|endpoint| (
                    endpoint.host.as_str(),
                    endpoint.port,
                    endpoint.protocol.as_str()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("first.example", 1111, "tcp"),
                ("second.example", 2222, "udp")
            ]
        );
    }
    #[test]
    fn tls_crypt_v2_optional_mode_is_preserved() {
        let key = "-----BEGIN OpenVPN tls-crypt-v2 client key-----\nZm9v\n-----END OpenVPN tls-crypt-v2 client key-----";
        let parsed = parse(
            "client\nremote vpn.example.test\nsetenv CLIENT_CERT 0\ntls-crypt-v2 client.key force-cookie\n",
            &BTreeMap::from([("tls-crypt-v2".into(), key.into())]),
            false,
        )
        .unwrap();
        assert!(parsed
            .content
            .contains("tls-crypt-v2 [inline] force-cookie"));
        assert!(parsed.content.contains("<tls-crypt-v2>"));
    }
    #[test]
    fn interactive_auth_user_pass_does_not_open_stdin_as_a_file() {
        for directive in ["auth-user-pass stdin", "auth-user-pass \"\""] {
            let parsed = parse(
                &format!("client\nremote vpn.example.test\n{directive}\n"),
                &BTreeMap::new(),
                false,
            )
            .unwrap();
            assert!(parsed.requires_auth);
            assert!(parsed.dependencies.is_empty());
            assert!(parsed.content.contains("auth-user-pass\n"));
        }
    }
    #[test]
    fn official_value_form_dh_none_is_not_treated_as_a_path() {
        let parsed = parse(
            "client\nremote vpn.example.test\nsetenv CLIENT_CERT 0\ndh none\n",
            &BTreeMap::new(),
            false,
        )
        .unwrap();
        assert!(parsed.dependencies.is_empty());
        assert!(parsed.content.contains("dh none\n"));
        assert!(parse(
            "client\nremote \"\"\nsetenv CLIENT_CERT 0\n",
            &BTreeMap::new(),
            false,
        )
        .is_err());
    }
    #[test]
    fn external_auth_file_keeps_optional_password_semantics() {
        let parsed = parse(
            "client\nremote vpn.example.test\nauth-user-pass credentials.txt\n",
            &BTreeMap::from([(String::from("auth-user-pass"), String::from("alice\n"))]),
            false,
        )
        .unwrap();
        assert!(parsed.requires_auth);
        assert!(parsed.content.contains("<auth-user-pass>\nalice\n"));
    }
    #[test]
    fn password_profile_without_client_certificate_preserves_server_verification() {
        let ca = rcgen::generate_simple_self_signed(vec!["ca.test".into()]).unwrap();
        let input = format!("client\nremote vpn.example.com\nauth-user-pass\nclient-cert-not-required\nremote-cert-tls server\n<ca>\n{}</ca>\n", ca.cert.pem());
        let parsed = parse(&input, &BTreeMap::new(), false).unwrap();
        assert!(parsed.requires_auth);
        assert!(!parsed.has_client_certificate);
        assert!(parsed.content.contains("setenv CLIENT_CERT 0\n"));
        assert!(!parsed.content.contains("client-cert-not-required"));
        assert!(parsed.content.contains("remote-cert-tls server\n"));
        assert!(parsed
            .content
            .contains(&ca.cert.pem().replace("\r\n", "\n")));
        let no_auth = parse(
            "client\nremote vpn.example.com\nclient-cert-not-required\n",
            &BTreeMap::new(),
            false,
        )
        .unwrap();
        assert!(!no_auth.requires_auth);
        assert_eq!(
            no_auth.content.matches("setenv CLIENT_CERT 0").count(),
            1
        );
        assert!(parse(
            "remote test\nauth-user-pass\nclient-cert-not-required extra\n",
            &BTreeMap::new(),
            false
        )
        .is_err());
    }
    #[test]
    fn reject_privileged_and_unresolved_inputs() {
        for directive in [
            "up evil",
            "plugin evil",
            "config other.ovpn",
            "log /tmp/output",
            "auth-user-pass creds.txt",
            "<connection>",
            "ca ca.crt",
        ] {
            assert!(
                parse(
                    &format!("remote test\nauth-user-pass\n{directive}\n"),
                    &BTreeMap::new(),
                    false
                )
                .is_err(),
                "{directive}"
            );
        }
    }
    #[test]
    fn discover_material_without_exposing_it() {
        let p = parse(
            "remote test\nauth-user-pass\nca \"certs/my ca.crt\"",
            &BTreeMap::new(),
            true,
        )
        .unwrap();
        assert_eq!(p.dependencies["ca"], "certs/my ca.crt");
    }
    #[test]
    fn certificate_key_matching_and_external_normalization() {
        let first = rcgen::generate_simple_self_signed(vec!["client.test".into()]).unwrap();
        let second = rcgen::generate_simple_self_signed(vec!["other.test".into()]).unwrap();
        let mut materials = BTreeMap::from([
            ("ca".into(), first.cert.pem()),
            ("cert".into(), first.cert.pem()),
            ("key".into(), first.key_pair.serialize_pem()),
        ]);
        let input = "client\ndev tun\nremote vpn.test 443 tcp-client\nca ca.crt\ncert client.crt\nkey client.key\n";
        let parsed = parse(input, &materials, false).unwrap();
        assert!(!parsed.requires_auth);
        assert!(parsed.has_client_certificate);
        assert!(!parsed.content.contains("ca ca.crt"));
        assert!(parsed.content.contains("<ca>"));
        assert_eq!(
            parse(&parsed.content, &BTreeMap::new(), false)
                .unwrap()
                .content,
            parsed.content
        );
        materials.insert("key".into(), second.key_pair.serialize_pem());
        assert!(parse(input, &materials, false)
            .err()
            .unwrap()
            .contains("match"));
    }
    #[test]
    fn malformed_certificates_and_inline_injection_are_rejected() {
        for content in [
            "",
            "-----BEGIN CERTIFICATE-----\nMDAwMDAwMDAwMDAwMDAwMDAwMDAw\n-----END CERTIFICATE-----",
            "</ca>\nup evil\n<ca>",
        ] {
            assert!(validate_material("ca", content).is_err());
        }
        assert!(parse(
            "remote test\nauth-user-pass\n<ca>\nmissing end",
            &BTreeMap::new(),
            false
        )
        .is_err());
        assert!(parse(
            "remote test\nauth-user-pass\ndev /tmp/other",
            &BTreeMap::new(),
            false
        )
        .is_err());
        assert!(validate_inline_block("auth-user-pass", "user\n</auth-user-pass>\n").is_err());
    }
}
