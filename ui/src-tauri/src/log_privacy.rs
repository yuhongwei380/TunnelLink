//! Presentation-only masking. Never change the profile or connection addresses.
use std::collections::HashSet;
use std::net::IpAddr;

pub struct LogPrivacy {
    alias: Option<String>,
    hosts: HashSet<String>,
    ports: HashSet<u16>,
    resolved: HashSet<IpAddr>,
}

fn host_name(value: &str) -> String {
    value
        .trim_matches(['\'', '"', '[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase()
}

fn endpoint(value: &str) -> Option<(&str, u16)> {
    let value = value
        .strip_prefix("[AF_INET]")
        .or_else(|| value.strip_prefix("[AF_INET6]"))
        .unwrap_or(value);
    let (host, port) = value.rsplit_once(':')?;
    // Unbracketed IPv6 is an address, not a host:port pair.
    if host.contains(':') && !(host.starts_with('[') && host.ends_with(']')) {
        return None;
    }
    Some((host.trim_matches(['[', ']']), port.parse().ok()?))
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%' | '@')
}

/// Internal/local addresses remain visible even when builtin privacy is enabled.
pub fn is_local_address(value: &str) -> bool {
    match host_name(value).parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            ip.is_private()
                || ip.is_loopback()
                || ip.is_link_local()
                || ip.is_unspecified()
                || ip.is_multicast()
                || ip.is_broadcast()
        }
        Ok(IpAddr::V6(ip)) => {
            ip.to_ipv4_mapped()
                .is_some_and(|v| is_local_address(&v.to_string()))
                || ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (ip.segments()[0] & 0xfe00) == 0xfc00
                || (ip.segments()[0] & 0xffc0) == 0xfe80
        }
        Err(_) => false,
    }
}

impl LogPrivacy {
    /// Recreate per session so imported profiles never inherit builtin masking.
    pub fn for_profile(profile_id: &str, profile: &str, builtin_enabled: bool) -> Self {
        let alias = (builtin_enabled && profile_id == "builtin").then(|| "[hidden]".into());
        Self::new(alias, profile)
    }

    pub fn new(alias: Option<String>, profile: &str) -> Self {
        let mut hosts = HashSet::new();
        let mut ports = HashSet::new();
        let mut default_port = None;
        let mut uses_default_port = false;
        let mut inline = false;
        for line in profile.lines() {
            let line = line.trim();
            if line.starts_with("</") {
                inline = false;
                continue;
            }
            if line.starts_with('<') && line != "<connection>" {
                inline = true;
                continue;
            }
            if inline {
                continue;
            }
            let fields = crate::profile_import::tokens(line).unwrap_or_default();
            let option = fields
                .first()
                .map(String::as_str)
                .unwrap_or("")
                .trim_start_matches("--");
            if option == "remote" {
                if let Some(host) = fields.get(1) {
                    hosts.insert(host_name(host));
                }
                if let Some(port) = fields.get(2).and_then(|p| p.parse().ok()) {
                    ports.insert(port);
                } else {
                    uses_default_port = true;
                }
            } else if matches!(option, "port" | "rport") {
                if let Some(port) = fields.get(1).and_then(|p| p.parse().ok()) {
                    ports.insert(port);
                    default_port = Some(port);
                }
            }
        }
        if uses_default_port {
            ports.insert(default_port.unwrap_or(1194));
        }
        Self {
            alias: alias.filter(|s| !s.is_empty()),
            hosts,
            ports,
            resolved: HashSet::new(),
        }
    }

    fn remote_host(&self, value: &str) -> bool {
        let host = host_name(value);
        !is_local_address(&host)
            && (self.hosts.contains(&host)
                || host
                    .parse::<IpAddr>()
                    .is_ok_and(|ip| self.resolved.contains(&ip)))
    }

    fn remember_address(&mut self, value: &str) {
        if let Ok(address) = value.trim_matches(['[', ']', '.', ',']).parse::<IpAddr>() {
            if !is_local_address(value) {
                self.resolved.insert(address);
            }
        }
    }

    fn observe_remote(&mut self, line: &str) {
        if self.hosts.is_empty() {
            return;
        }
        // The pinned TCP/UDP transports emit "Contacting IP:port via ...".
        // Only that endpoint is learned; never scan all addresses on the line.
        if let Some(contact) = line.split_once("Contacting ").map(|(_, tail)| tail) {
            if let Some((host, port)) = contact.split_whitespace().next().and_then(endpoint) {
                if self.ports.contains(&port) {
                    self.remember_address(host);
                }
            }
        }
        // Connected::render() and transport logs associate a configured host
        // with its resolved server IP in parentheses, before the local/tun IPs.
        for marker in [
            "EVENT: CONNECTED ",
            "Received event CONNECTED ",
            "Connecting to ",
            "Contacting ",
            "",
        ] {
            let Some(tail) = line.split_once(marker).map(|(_, tail)| tail) else {
                continue;
            };
            let server_field = tail
                .split_once(" (")
                .map(|(server, _)| server)
                .unwrap_or_else(|| tail.split_whitespace().next().unwrap_or(""));
            let server = server_field.rsplit('@').next().unwrap_or(server_field);
            let host = endpoint(server).map(|(host, _)| host).unwrap_or(server);
            if self.remote_host(host) {
                if let Some(address) = tail
                    .strip_prefix(server_field)
                    .and_then(|rest| rest.trim_start().strip_prefix('('))
                    .and_then(|rest| rest.split_once(')').map(|(ip, _)| ip))
                {
                    self.remember_address(address);
                }
            }
        }
    }

    fn redact_token(&self, token: &str, alias: &str) -> String {
        let unwrapped = token
            .strip_prefix("[AF_INET]")
            .or_else(|| token.strip_prefix("[AF_INET6]"))
            .unwrap_or(token);
        if let Some((name, server)) = unwrapped.rsplit_once('@') {
            if self.remote_host(server)
                || endpoint(server).is_some_and(|(host, _)| self.remote_host(host))
            {
                return format!("{name}@{alias}");
            }
        }
        if let Some((host, port)) = endpoint(unwrapped) {
            if is_local_address(host)
                && self.hosts.contains(&host_name(host))
                && self.ports.contains(&port)
            {
                return if host.contains(':') {
                    format!("[{host}]:{alias}")
                } else {
                    format!("{host}:{alias}")
                };
            }
        }
        if self.remote_host(unwrapped)
            || endpoint(unwrapped).is_some_and(|(host, _)| self.remote_host(host))
        {
            return alias.to_string();
        }
        if unwrapped
            .strip_suffix(':')
            .is_some_and(|host| self.remote_host(host))
        {
            return format!("{alias}:");
        }
        if let Some((label, value)) = unwrapped.split_once(':') {
            let label_name = label.trim_matches(['[', ']']).to_ascii_lowercase();
            if label_name == "remote" {
                let masked = self.redact_token(value, alias);
                if masked != value {
                    return format!("{label}:{masked}");
                }
            }
            if matches!(
                label_name.as_str(),
                "port" | "rport" | "remote_port" | "server_port"
            ) && value
                .parse::<u16>()
                .is_ok_and(|port| self.ports.contains(&port))
            {
                return format!("{label}:{alias}");
            }
        }
        token.to_string()
    }

    pub fn redact(&mut self, line: &str) -> String {
        let Some(alias) = self.alias.clone() else {
            return line.to_string();
        };
        self.observe_remote(line);
        // Preserve the entire username (including dots and @), along with the
        // client/tunnel addresses following "via" in the connected event.
        let connected = ["EVENT: CONNECTED ", "Received event CONNECTED "]
            .into_iter()
            .find_map(|marker| {
                line.split_once(marker)
                    .map(|(prefix, payload)| (prefix, marker, payload))
            })
            .or_else(|| {
                // Some engine callbacks print CONNECTED and its payload on separate lines.
                let (server, _) = line.split_once(" via ")?;
                let server = server.split_once(" (")?.0.rsplit('@').next()?;
                let host = endpoint(server).map(|(host, _)| host).unwrap_or(server);
                self.remote_host(host).then_some(("", "", line))
            });
        if let Some((prefix, marker, payload)) = connected {
            let (server, local) = payload.split_once(" via ").unwrap_or((payload, ""));
            let name_end = server
                .split_once(" (")
                .map(|(endpoint, _)| endpoint)
                .unwrap_or(server)
                .rfind('@')
                .map(|at| at + 1)
                .unwrap_or(0);
            let masked = self.redact_fields(&server[name_end..], &alias);
            return format!(
                "{prefix}{marker}{}{masked}{}",
                &server[..name_end],
                if local.is_empty() {
                    String::new()
                } else {
                    format!(" via {local}")
                }
            );
        }
        self.redact_fields(line, &alias)
    }

    fn redact_fields(&self, line: &str, alias: &str) -> String {
        let mut output = String::new();
        let mut previous = "";
        for token in line.split_inclusive(|c: char| !token_char(c)) {
            // Retain punctuation so non-sensitive text stays exact.
            let field = token.trim_end_matches(|c: char| !token_char(c));
            let value = field.trim_matches(['[', ']']);
            let label = previous.trim_matches(['[', ']', ':']).to_ascii_lowercase();
            let is_port = value
                .parse::<u16>()
                .is_ok_and(|port| self.ports.contains(&port))
                && (matches!(
                    label.as_str(),
                    "port" | "rport" | "remote_port" | "server_port"
                ) || self.remote_host(previous)
                    || self.hosts.contains(&host_name(previous)));
            if !field.is_empty() {
                if matches!(label.as_str(), "username" | "user") {
                    output.push_str(field);
                } else if is_port {
                    output.push_str(alias);
                } else if let Some((host, _)) = endpoint(field).filter(|(host, port)| {
                    label == "contacting" && is_local_address(host) && self.ports.contains(port)
                }) {
                    if host.contains(':') {
                        output.push_str(&format!("[{host}]:{alias}"));
                    } else {
                        output.push_str(&format!("{host}:{alias}"));
                    }
                } else {
                    output.push_str(&self.redact_token(field, alias));
                }
                previous = field;
            }
            output.push_str(&token[field.len()..]);
        }
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn privacy() -> LogPrivacy {
        LogPrivacy::new(
            Some("demo.vpn".into()),
            "remote vpn.example.com 443\nrport 8443",
        )
    }
    #[test]
    fn builtin_switch_leaves_imported_profiles_untouched() {
        let profile = "remote vpn.example.com 443";
        let line = "EVENT: CONNECTED user@vpn.example.com:443 (203.0.113.7) via /UDP on tun0/10.8.0.6/ gw=[10.8.0.1/]";
        for (id, enabled, masked) in [
            ("builtin", true, true),
            ("builtin", false, false),
            ("imported-profile", true, false),
            ("imported-profile", false, false),
        ] {
            let result = LogPrivacy::for_profile(id, profile, enabled).redact(line);
            if masked {
                assert!(!result.contains("vpn.example.com"));
                assert!(!result.contains("443"));
                assert!(!result.contains("203.0.113.7"));
                assert!(result.contains("user@[hidden] ([hidden])"));
                assert!(result.contains("tun0/10.8.0.6/ gw=[10.8.0.1/]"));
            } else {
                assert_eq!(result, line);
            }
        }
    }

    #[test]
    fn split_connected_payloads_preserve_private_server_ips() {
        let mut privacy = LogPrivacy::for_profile("builtin", "remote vpn.example.com 11194", true);
        assert_eq!(
            privacy.redact("Received event CONNECTED"),
            "Received event CONNECTED"
        );
        assert_eq!(privacy.redact("user@example.org@vpn.example.com:11194 (192.168.20.30) via /UDP on TUN_WIN/10.20.0.2/ gw=[10.20.0.1/] mtu=1500"),
            "user@example.org@[hidden] (192.168.20.30) via /UDP on TUN_WIN/10.20.0.2/ gw=[10.20.0.1/] mtu=1500");
        assert_eq!(
            privacy.redact("remote:[AF_INET]192.168.20.30:11194"),
            "remote:[AF_INET]192.168.20.30:11194"
        );
        assert_eq!(
            privacy.redact("Contacting [fd00::7]:11194 via TCPv6"),
            "Contacting [fd00::7]:[hidden] via TCPv6"
        );
        assert_eq!(
            privacy.redact("fd00::7 fe80::2 10.20.0.2"),
            "fd00::7 fe80::2 10.20.0.2"
        );
    }

    #[test]
    fn quoted_ports_and_escaped_profile_hosts_use_the_openvpn_parser() {
        let profile = r#"remote "vpn\.example.com" "11194""#;
        let mut privacy = LogPrivacy::for_profile("builtin", profile, true);
        assert_eq!(
            privacy.redact("Contacting 192.168.20.30:11194 via UDP"),
            "Contacting 192.168.20.30:[hidden] via UDP"
        );
        assert_eq!(privacy.redact("user@vpn.example.com:11194 (192.168.20.30) via /UDP on tun0/192.168.20.31/ gw=[192.168.20.30/]"),
            "user@[hidden] (192.168.20.30) via /UDP on tun0/192.168.20.31/ gw=[192.168.20.30/]");
        assert_eq!(privacy.redact("Received event CONNECTED user@vpn.example.com:11194 (192.168.20.30) via /UDP on tun0/192.168.20.31/ gw=[192.168.20.30/]"),
            "Received event CONNECTED user@[hidden] (192.168.20.30) via /UDP on tun0/192.168.20.31/ gw=[192.168.20.30/]");
    }

    #[test]
    fn disabled_preserves_logs_exactly() {
        let line = "Contacting vpn.example.com:443 (203.0.113.7)";
        assert_eq!(LogPrivacy::new(None, "").redact(line), line);
    }
    #[test]
    fn masks_only_configured_hosts_and_endpoint_ports() {
        let mut privacy = privacy();
        assert_eq!(
            privacy.redact("remote vpn.example.com 443 udp"),
            "remote demo.vpn demo.vpn udp"
        );
        assert_eq!(privacy.redact("VPN.EXAMPLE.COM.:443"), "demo.vpn");
        assert_eq!(
            privacy.redact("DNS error for vpn.example.com: retrying"),
            "DNS error for demo.vpn: retrying"
        );
        assert_eq!(privacy.redact("rport 8443"), "rport demo.vpn");
        assert_eq!(privacy.redact("server_port:443"), "server_port:demo.vpn");
        for line in [
            "BYTES_IN : 443",
            "PACKETS_OUT : 1194",
            "Username: john.doe",
            "Username: 443",
            "Username: john@vpn.example.com",
            "Username: vpn.example.com",
            "other.example.com:443",
            "203.0.113.8:443",
            "443",
        ] {
            assert_eq!(privacy.redact(line), line, "{line}");
        }
    }
    #[test]
    fn transport_observation_masks_resolved_server_but_preserves_other_addresses() {
        let mut privacy = privacy();
        assert_eq!(
            privacy.redact("Contacting 203.0.113.7:443 via UDP"),
            "Contacting demo.vpn via UDP"
        );
        assert_eq!(
            privacy.redact("remote:[AF_INET]203.0.113.7:443"),
            "remote:demo.vpn"
        );
        assert_eq!(
            privacy.redact("route 203.0.113.7/32 via 192.168.1.1"),
            "route demo.vpn/32 via 192.168.1.1"
        );
        let line = "PUSH_REPLY,ifconfig 10.8.0.6 255.255.255.0,route-gateway 10.8.0.1,dhcp-option DNS 8.8.8.8";
        assert_eq!(privacy.redact(line), line);
        assert_eq!(
            privacy.redact("Username: 203.0.113.7"),
            "Username: 203.0.113.7"
        );
        assert_eq!(
            privacy.redact("Contacting 192.168.1.5:443 via UDP"),
            "Contacting 192.168.1.5:demo.vpn via UDP"
        );
        assert_eq!(
            privacy.redact("Contacting 203.0.113.8:9443 via TCPv4"),
            "Contacting 203.0.113.8:9443 via TCPv4"
        );
    }
    #[test]
    fn connected_event_preserves_username_virtual_ip_gateway_and_local_ip() {
        let mut privacy = privacy();
        assert_eq!(privacy.redact("EVENT: CONNECTED john.doe@example.org@vpn.example.com:443 (203.0.113.7) via 192.168.1.5/UDPv4 on utun3/10.8.0.6/ gw=[10.8.0.1/] mtu=1500"),
            "EVENT: CONNECTED john.doe@example.org@demo.vpn (demo.vpn) via 192.168.1.5/UDPv4 on utun3/10.8.0.6/ gw=[10.8.0.1/] mtu=1500");
        assert_eq!(privacy.redact("EVENT: CONNECTED 443@vpn.example.com:443 (203.0.113.7) via 192.0.2.1/TCPv4 on tun0/10.8.0.6/ gw=[10.8.0.1/]"),
            "EVENT: CONNECTED 443@demo.vpn (demo.vpn) via 192.0.2.1/TCPv4 on tun0/10.8.0.6/ gw=[10.8.0.1/]");
        assert_eq!(privacy.redact("203.0.113.7"), "demo.vpn");
        assert_eq!(privacy.redact("EVENT: CONNECTED John Doe@example.org@vpn.example.com:443 (203.0.113.9) via 192.168.1.5/UDPv4 on utun3/10.8.0.6/ gw=[10.8.0.1/]"),
            "EVENT: CONNECTED John Doe@example.org@demo.vpn (demo.vpn) via 192.168.1.5/UDPv4 on utun3/10.8.0.6/ gw=[10.8.0.1/]");
    }
    #[test]
    fn ipv6_transport_and_tunnel_addresses_are_distinguished() {
        let mut privacy = privacy();
        assert_eq!(
            privacy.redact("Contacting [2001:db8::7]:443 via TCPv6"),
            "Contacting demo.vpn via TCPv6"
        );
        assert_eq!(privacy.redact("[AF_INET6][2001:db8::7]:443"), "demo.vpn");
        assert_eq!(privacy.redact("EVENT: CONNECTED alice@vpn.example.com:443 (2001:db8::7) via fe80::2/TCPv6 on utun3//fd00::2 gw=[/fd00::1]"),
            "EVENT: CONNECTED alice@demo.vpn (demo.vpn) via fe80::2/TCPv6 on utun3//fd00::2 gw=[/fd00::1]");
        assert_eq!(
            privacy.redact("2001:db8::7 fd00::2 fe80::2 ::1"),
            "demo.vpn fd00::2 fe80::2 ::1"
        );
    }
    #[test]
    fn literal_remote_and_connection_blocks_are_supported() {
        let mut privacy = LogPrivacy::new(Some("demo.vpn".into()), "<ca>\nremote certificate.name 9443\n</ca>\n<connection>\nremote '[2001:db8::7]' 443\n</connection>\nremote 'vpn.example.com' 8443");
        assert_eq!(
            privacy.redact("[2001:db8::7]:443 vpn.example.com:8443"),
            "demo.vpn demo.vpn"
        );
        assert_eq!(
            privacy.redact("certificate.name:9443"),
            "certificate.name:9443"
        );
    }
    #[test]
    fn only_effective_default_and_configured_ports_are_masked() {
        for (profile, expected) in [
            ("remote vpn.example.com", "port demo.vpn"),
            ("remote vpn.example.com 443", "port 1194"),
            ("remote vpn.example.com\nrport 443", "port 1194"),
        ] {
            let mut privacy = LogPrivacy::new(Some("demo.vpn".into()), profile);
            assert_eq!(privacy.redact("port 1194"), expected, "{profile}");
        }
    }
    #[test]
    fn unknown_hosts_do_not_teach_unrelated_addresses() {
        let mut privacy = privacy();
        let line = "EVENT: CONNECTED john.doe@other.example.com:443 (203.0.113.8) via 192.168.1.5/UDPv4 on tun0/10.8.0.6/ gw=[10.8.0.1/]";
        assert_eq!(privacy.redact(line), line);
        assert_eq!(privacy.redact("203.0.113.8"), "203.0.113.8");
        assert_eq!(
            privacy.redact("Connecting to vpn.example.com:443 (203.0.113.7) via TCPv4"),
            "Connecting to demo.vpn (demo.vpn) via TCPv4"
        );
    }
}
