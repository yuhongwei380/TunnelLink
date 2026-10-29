pub fn entry(service: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, "vpn-account").map_err(|error| error.to_string())
}

fn remove(entry: keyring::Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// Each index stays below Windows Credential Manager's blob limit. Secrets are
// separate entries, so importing more profiles cannot enlarge one secret blob.
const INDEX_PARTS: usize = 16;
const KEYS_PER_PART: usize = 8;
fn index_entry(service: &str, part: usize) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, &format!("vpn-profile-index-{part}")).map_err(|e| e.to_string())
}
fn profile_entry(service: &str, key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        service,
        &format!("vpn-profile-{}", crate::profiles::fingerprint(key)),
    )
    .map_err(|e| e.to_string())
}
fn keys(service: &str) -> Result<Vec<String>, String> {
    let mut result = Vec::new();
    for part in 0..INDEX_PARTS {
        match index_entry(service, part)?.get_password() {
            Ok(value) => {
                let entries: Vec<String> =
                    serde_json::from_str(&value).map_err(|e| e.to_string())?;
                result.extend(entries);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(result)
}
fn write_keys(service: &str, keys: &[String]) -> Result<(), String> {
    if keys.len() > INDEX_PARTS * KEYS_PER_PART {
        return Err("Credential index is full".into());
    }
    for part in 0..INDEX_PARTS {
        let start = part * KEYS_PER_PART;
        if start < keys.len() {
            let value = serde_json::to_string(&keys[start..keys.len().min(start + KEYS_PER_PART)])
                .map_err(|e| e.to_string())?;
            index_entry(service, part)?
                .set_password(&value)
                .map_err(|e| e.to_string())?;
        } else {
            remove(index_entry(service, part)?)?;
        }
    }
    Ok(())
}
pub fn clear(service: &str) -> Result<(), String> {
    for key in keys(service)? {
        remove(profile_entry(service, &key)?)?;
    }
    write_keys(service, &[])?;
    remove(entry(service)?)
}

pub fn load_profiles(service: &str) -> Result<std::collections::BTreeMap<String, String>, String> {
    let mut result = std::collections::BTreeMap::new();
    for key in keys(service)? {
        match profile_entry(service, &key)?.get_password() {
            Ok(value) => {
                result.insert(key, value);
            }
            Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(result)
}

pub fn save_profiles(
    service: &str,
    values: &std::collections::BTreeMap<String, String>,
) -> Result<(), String> {
    let old = keys(service)?;
    let mut union = old.clone();
    for key in values.keys() {
        if !union.contains(key) {
            union.push(key.clone());
        }
    }
    // Register before writing secrets so interrupted saves remain removable.
    write_keys(service, &union)?;
    for (key, value) in values {
        profile_entry(service, key)?
            .set_password(value)
            .map_err(|e| e.to_string())?;
    }
    for key in &old {
        if !values.contains_key(key) {
            remove(profile_entry(service, key)?)?;
        }
    }
    union.retain(|key| values.contains_key(key));
    write_keys(service, &union)
}

#[cfg(test)]
mod tests {
    #[test]
    fn profile_credentials_are_independent_and_all_are_removable() {
        let service = format!("com.tunnellink.profile-test.{}", std::process::id());
        let first = "11111111-1111-4111-8111-111111111111:revision-a".to_string();
        let second = "22222222-2222-4222-8222-222222222222:revision-b".to_string();
        let mut values = std::collections::BTreeMap::from([
            (first.clone(), "secret-a".into()),
            (second.clone(), "secret-b".into()),
        ]);
        super::save_profiles(&service, &values).unwrap();
        assert_eq!(super::load_profiles(&service).unwrap(), values);
        values.remove(&first);
        super::save_profiles(&service, &values).unwrap();
        assert_eq!(super::load_profiles(&service).unwrap(), values);
        assert!(matches!(
            super::profile_entry(&service, &first)
                .unwrap()
                .get_password(),
            Err(keyring::Error::NoEntry)
        ));
        super::clear(&service).unwrap();
        assert!(super::load_profiles(&service).unwrap().is_empty());
        assert!(matches!(
            super::profile_entry(&service, &second)
                .unwrap()
                .get_password(),
            Err(keyring::Error::NoEntry)
        ));
    }
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
