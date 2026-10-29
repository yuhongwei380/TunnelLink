pub fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, "vpn-account").map_err(|error| error.to_string())
}

pub fn clear(service: &str) -> Result<(), String> {
    match entry(service)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("Unable to delete saved credentials: {error}")),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn deleting_saved_credentials_is_idempotent() {
        // An isolated entry avoids reading or deleting the user's real account.
        let service = format!("com.tunnellink.uninstall-test.{}", std::process::id());
        let entry = super::entry(&service).unwrap();
        entry.set_password("test-only-secret").unwrap();
        super::clear(&service).unwrap();
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        super::clear(&service).unwrap();
    }
}
