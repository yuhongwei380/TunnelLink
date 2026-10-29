//! A deliberately bounded client profile dialect. Never pass unresolved file
//! references or executable directives to the elevated supervisor.
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

pub fn tokens(line: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    let mut word = String::new();
    let mut quote = None;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\'
            && chars
                .peek()
                .is_some_and(|v| matches!(v, '\\' | '"' | '\'' | ' '))
        {
            word.push(chars.next().unwrap());
        } else if quote == Some(c) {
            quote = None;
        } else if quote.is_some() {
            word.push(c);
        } else if matches!(c, '\'' | '"') {
            quote = Some(c);
        } else if matches!(c, '#' | ';') && word.is_empty() {
            break;
        } else if c.is_whitespace() {
            if !word.is_empty() {
                result.push(std::mem::take(&mut word));
            }
        } else {
            word.push(c);
        }
    }
    if quote.is_some() {
        return Err("Unterminated quoted option".into());
    }
    if !word.is_empty() {
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
    let mut port = 1194;
    let mut protocol = "udp".to_string();
    let mut requires_auth = false;
    let mut block: Option<(String, String)> = None;
    let mut certificate = None;
    let mut private_key = None;
    // No script, plugin, config include, external PKI, proxy authentication,
    // output paths, server directives or unknown options are accepted.
    const SIMPLE: &[&str] = &[
        "client",
        "tls-client",
        "dev",
        "dev-type",
        "nobind",
        "persist-key",
        "persist-tun",
        "resolv-retry",
        "remote-random",
        "remote-random-hostname",
        "connect-retry",
        "connect-retry-max",
        "connect-timeout",
        "server-poll-timeout",
        "auth",
        "cipher",
        "data-ciphers",
        "data-ciphers-fallback",
        "remote-cert-tls",
        "remote-cert-ku",
        "remote-cert-eku",
        "verify-x509-name",
        "tls-version-min",
        "tls-version-max",
        "tls-cipher",
        "tls-ciphersuites",
        "tls-cert-profile",
        "key-direction",
        "reneg-sec",
        "reneg-bytes",
        "reneg-pkts",
        "hand-window",
        "tran-window",
        "tls-timeout",
        "route",
        "route-ipv6",
        "route-nopull",
        "route-delay",
        "route-metric",
        "route-gateway",
        "redirect-gateway",
        "redirect-private",
        "dhcp-option",
        "block-outside-dns",
        "pull",
        "pull-filter",
        "ping",
        "ping-restart",
        "ping-exit",
        "keepalive",
        "tun-mtu",
        "mssfix",
        "sndbuf",
        "rcvbuf",
        "verb",
        "mute",
        "auth-nocache",
        "auth-retry",
        "explicit-exit-notify",
        "socket-flags",
        "comp-lzo",
        "compress",
        "allow-compression",
        "float",
        "inactive",
        "peer-fingerprint",
    ];
    for (i, raw) in input.trim_start_matches('\u{feff}').lines().enumerate() {
        let line = raw.trim();
        if let Some((kind, content)) = &mut block {
            if line == format!("</{kind}>") {
                validate_material(kind, content)?;
                if kind == "cert" {
                    certificate = Some(content.clone());
                }
                if kind == "key" {
                    private_key = Some(content.clone());
                }
                output.push_str(&format!("<{kind}>\n{content}</{kind}>\n"));
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
            if fields.len() != 1
                || name != format!("<{kind}>")
                || !["ca", "cert", "key", "tls-auth", "tls-crypt", "extra-certs"].contains(&kind)
                || !blocks.insert(kind.to_string())
            {
                return Err(format!(
                    "Unsupported or duplicate inline block at line {}",
                    i + 1
                ));
            }
            block = Some((kind.into(), String::new()));
            continue;
        }
        match name {
            "ca" | "cert" | "key" | "extra-certs" | "tls-auth" | "tls-crypt" => {
                if fields.len() != 2
                    || references
                        .insert(name.to_string(), fields[1].clone())
                        .is_some()
                {
                    return Err(format!("Invalid or duplicate {name} directive"));
                }
                continue;
            }
            "auth-user-pass" => {
                if fields.len() != 1 {
                    return Err("Use auth-user-pass without a credentials file".into());
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
                port = fields
                    .get(1)
                    .ok_or("Missing port")?
                    .parse::<u16>()
                    .map_err(|_| "Invalid port")?;
            }
            "proto" => {
                protocol = fields.get(1).ok_or("Missing protocol")?.clone();
            }
            "dev" => {
                if fields.len() != 2 || !["tun", "tap"].contains(&fields[1].as_str()) {
                    return Err("Only tun or tap devices are supported".into());
                }
            }
            _ if SIMPLE.contains(&name) => {}
            _ => return Err(format!("Unsupported directive '{name}' at line {}", i + 1)),
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
        if !["ca", "cert", "key"].contains(&kind.as_str()) {
            return Err(format!("Embed {kind} in the profile before importing"));
        }
        if let Some(value) = materials.get(&kind) {
            validate_material(&kind, value)?;
            if kind == "cert" {
                certificate = Some(value.clone());
            }
            if kind == "key" {
                private_key = Some(value.clone());
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
    if remote.is_empty() {
        return Err("The profile must contain a remote server".into());
    }
    let endpoints = remote
        .into_iter()
        .map(|v| {
            let port = v
                .get(2)
                .map(|p| p.parse::<u16>())
                .transpose()
                .map_err(|_| "Invalid remote port")?
                .unwrap_or(port);
            let protocol = v.get(3).cloned().unwrap_or_else(|| protocol.clone());
            if port == 0
                || ![
                    "udp",
                    "udp4",
                    "udp6",
                    "tcp",
                    "tcp-client",
                    "tcp4",
                    "tcp6",
                    "tcp4-client",
                    "tcp6-client",
                ]
                .contains(&protocol.as_str())
            {
                return Err("Unsupported remote protocol or port");
            }
            Ok(Endpoint {
                host: v[1].clone(),
                port,
                protocol,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    if dependencies.is_empty() {
        if blocks.contains("cert") != blocks.contains("key") {
            return Err("Client certificate and private key must be supplied together".into());
        }
        if !requires_auth && !blocks.contains("cert") {
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
        has_client_certificate: blocks.contains("cert"),
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
    }
}
