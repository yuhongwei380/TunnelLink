//! Presentation-only masking. Never change the profile or connection addresses.
pub struct LogPrivacy {
    alias: Option<String>,
    hosts: Vec<String>,
    ports: Vec<String>,
}

impl LogPrivacy {
    pub fn new(alias: Option<String>, profile: &str) -> Self {
        let mut hosts = Vec::new();
        // OpenVPN uses 1194 when no remote port is specified.
        let mut ports = vec!["1194".to_string()];
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
            let fields: Vec<_> = line.split_whitespace().collect();
            let option = fields
                .first()
                .copied()
                .unwrap_or("")
                .trim_start_matches("--");
            if option == "remote" {
                if let Some(host) = fields.get(1) {
                    hosts.push(host.trim_matches(['\'', '"']).to_ascii_lowercase());
                }
                if let Some(port) = fields.get(2).filter(|p| p.parse::<u16>().is_ok()) {
                    ports.push(port.to_string());
                }
            } else if matches!(option, "port" | "rport") {
                if let Some(port) = fields.get(1).filter(|p| p.parse::<u16>().is_ok()) {
                    ports.push(port.to_string());
                }
            }
        }
        Self {
            alias: alias.filter(|s| !s.is_empty()),
            hosts,
            ports,
        }
    }

    fn sensitive(&self, token: &str) -> bool {
        let token = token.trim_end_matches('.');
        let token = token
            .strip_prefix("[AF_INET]")
            .or_else(|| token.strip_prefix("[AF_INET6]"))
            .unwrap_or(token);
        if self
            .hosts
            .iter()
            .any(|host| host.eq_ignore_ascii_case(token))
            || self.ports.iter().any(|port| port == token)
        {
            return true;
        }
        let address = token.trim_matches(['[', ']']);
        if address.parse::<std::net::IpAddr>().is_ok() {
            return true;
        }
        if let Some(address) = token.strip_suffix(':') {
            if self.sensitive(address) {
                return true;
            }
        }
        if let Some((host, port)) = token.rsplit_once(':') {
            if port.parse::<u16>().is_ok() && self.sensitive(host) {
                return true;
            }
        }
        if let Some((_, address)) = token.split_once(':') {
            if self.sensitive(address) {
                return true;
            }
        }
        // Resolve/transport logs can introduce addresses absent from the profile,
        // including DNS rotation, redirect targets, and IPv6 endpoints.
        let host = token.trim_end_matches('.');
        host.contains('.')
            && host.split('.').all(|label| {
                !label.is_empty() && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            && host
                .rsplit('.')
                .next()
                .is_some_and(|label| label.chars().all(|c| c.is_ascii_alphabetic()))
    }

    pub fn redact(&self, line: &str) -> String {
        let Some(alias) = &self.alias else {
            return line.to_string();
        };
        let mut output = String::new();
        let mut token = String::new();
        let flush = |output: &mut String, token: &mut String| {
            if !token.is_empty() {
                output.push_str(if self.sensitive(token) { alias } else { token });
                token.clear();
            }
        };
        for c in line.chars() {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%') {
                token.push(c);
            } else {
                flush(&mut output, &mut token);
                output.push(c);
            }
        }
        flush(&mut output, &mut token);
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_preserves_logs_exactly() {
        let line = "Contacting vpn.example.com:443 (203.0.113.7)";
        assert_eq!(LogPrivacy::new(None, "").redact(line), line);
    }
    #[test]
    fn masks_profile_and_discovered_endpoints() {
        let privacy = LogPrivacy::new(
            Some("demo.vpn".into()),
            "remote internal 443\nremote 'vpn.example.com' 8443\nrport 9443",
        );
        for value in [
            "vpn.example.com:8443",
            "internal:443",
            "203.0.113.7:443",
            "[2001:db8::7]:443",
            "2001:db8::7",
            "redirect.example.net",
            "443",
            "9443",
            "[AF_INET]203.0.113.7:443",
            "remote:203.0.113.7:443",
            "203.0.113.7.",
        ] {
            assert_eq!(privacy.redact(value), "demo.vpn", "{value}");
        }
        assert_eq!(
            privacy.redact("EVENT: CONNECTED user@vpn.example.com:8443 (203.0.113.7)"),
            "EVENT: CONNECTED user@demo.vpn (demo.vpn)"
        );
        assert_eq!(privacy.redact("BYTES_IN : 3186"), "BYTES_IN : 3186");
    }
}
