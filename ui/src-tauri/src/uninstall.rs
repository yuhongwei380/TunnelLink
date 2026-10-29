use std::path::{Path, PathBuf};

fn valid_identifier(identifier: &str) -> bool {
    identifier.len() <= 255
        && identifier.split('.').all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        })
}

#[cfg(any(target_os = "macos", test))]
fn macos_data_paths(home: &Path, identifier: &str) -> Result<Vec<PathBuf>, String> {
    if !home.is_absolute() || !valid_identifier(identifier) {
        return Err("Invalid uninstall data location".into());
    }
    let library = home.join("Library");
    Ok(vec![
        library.join("Application Support").join(identifier),
        library.join("Caches").join(identifier),
        library.join("WebKit").join(identifier),
        library.join("HTTPStorages").join(identifier),
        library.join("Logs").join(identifier),
        library
            .join("Preferences")
            .join(format!("{identifier}.plist")),
        library
            .join("Saved Application State")
            .join(format!("{identifier}.savedState")),
    ])
}

fn remove_path(path: &Path, protected_parents: &[PathBuf]) -> std::io::Result<()> {
    fn redirected(metadata: &std::fs::Metadata) -> bool {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // Directory junctions are reparse points but are not always reported
            // as ordinary symlinks. Never let elevated uninstall follow either.
            metadata.file_attributes() & 0x400 != 0 // FILE_ATTRIBUTE_REPARSE_POINT
        }
        #[cfg(not(windows))]
        {
            metadata.file_type().is_symlink()
        }
    }

    // Never traverse a redirected home/data parent while uninstalling.
    for parent in protected_parents {
        match std::fs::symlink_metadata(parent) {
            Ok(meta) if redirected(&meta) => {
                return Err(std::io::Error::other("Data parent is redirected"));
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    match std::fs::symlink_metadata(path) {
        Ok(meta) if redirected(&meta) => {
            Err(std::io::Error::other("Application data path is redirected"))
        }
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        Ok(_) => std::fs::remove_file(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(any(target_os = "macos", test))]
fn remove_macos_app_data(home: &Path, identifier: &str) -> Result<(), String> {
    let mut errors = Vec::new();
    for path in macos_data_paths(home, identifier)? {
        let parents = [home.join("Library"), path.parent().unwrap().to_path_buf()];
        if let Err(error) = remove_path(&path, &parents) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[cfg(any(windows, test))]
fn windows_data_paths(
    roaming: &Path,
    local: &Path,
    identifier: &str,
) -> Result<Vec<(PathBuf, PathBuf)>, String> {
    if !roaming.is_absolute() || !local.is_absolute() || !valid_identifier(identifier) {
        return Err("Invalid uninstall data location".into());
    }
    Ok(vec![
        (roaming.to_path_buf(), roaming.join(identifier)),
        (local.to_path_buf(), local.join(identifier)),
    ])
}

#[cfg(any(windows, test))]
fn remove_windows_app_data_at(
    roaming: &Path,
    local: &Path,
    identifier: &str,
) -> Result<(), String> {
    let mut errors = Vec::new();
    for (root, path) in windows_data_paths(roaming, local, identifier)? {
        if let Err(error) = remove_path(&path, &[root]) {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

#[cfg(windows)]
pub fn remove_windows_app_data(identifier: &str) -> Result<(), String> {
    let roaming = std::env::var_os("APPDATA").ok_or("APPDATA is unavailable")?;
    let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    remove_windows_app_data_at(&PathBuf::from(roaming), &PathBuf::from(local), identifier)
}

#[cfg(target_os = "macos")]
pub fn trash_bundle(bundle: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let url = NSURL::fileURLWithPath(&NSString::from_str(
        bundle.to_str().ok_or("Invalid application path")?,
    ));
    NSFileManager::defaultManager()
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| format!("Unable to move the application to Trash: {error}"))
}

/// This short-lived child waits for the GUI to exit before deleting WebKit data,
/// so the closing WebView cannot recreate preferences or its login cache.
#[cfg(target_os = "macos")]
pub fn finish(parent_pid: u32, identifier: &str) -> Result<(), String> {
    use objc2_foundation::{NSHomeDirectory, NSString, NSUserDefaults};
    use std::io::Read;
    use std::time::{Duration, Instant};
    let mut commit = String::new();
    std::io::stdin()
        .take(32)
        .read_to_string(&mut commit)
        .map_err(|e| e.to_string())?;
    if commit != "uninstall\n" {
        return Ok(());
    }
    if parent_pid <= 1 || parent_pid == std::process::id() {
        return Err("Invalid uninstall parent process".into());
    }
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let result = unsafe { libc::kill(parent_pid as libc::pid_t, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            break;
        }
        if Instant::now() >= deadline {
            return Err("The client did not exit. Application data has been kept.".into());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let home = PathBuf::from(NSHomeDirectory().to_string());
    let defaults = NSUserDefaults::standardUserDefaults();
    defaults.removePersistentDomainForName(&NSString::from_str(identifier));
    remove_macos_app_data(&home, identifier)
}

#[cfg(test)]
mod tests {
    #[test]
    fn cleanup_removes_only_this_apps_data_and_can_be_repeated() {
        let home = tempfile::tempdir().unwrap();
        let id = "com.example.uninstall-test";
        for path in super::macos_data_paths(home.path(), id).unwrap() {
            if path.extension().is_some_and(|ext| ext == "plist") {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(path, "preferences").unwrap();
            } else {
                std::fs::create_dir_all(&path).unwrap();
                std::fs::write(path.join("data"), "cached data").unwrap();
            }
        }
        let other = home.path().join("Library/Caches/com.example.other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("keep"), "other app").unwrap();
        super::remove_macos_app_data(home.path(), id).unwrap();
        super::remove_macos_app_data(home.path(), id).unwrap();
        for path in super::macos_data_paths(home.path(), id).unwrap() {
            assert!(!path.exists());
        }
        assert!(other.join("keep").exists());
    }

    #[test]
    fn invalid_identifiers_cannot_escape_the_data_directories() {
        let home = tempfile::tempdir().unwrap();
        for id in ["", ".", "..", "../other", "a/b", "a\\b", "a..b"] {
            assert!(super::macos_data_paths(home.path(), id).is_err(), "{id}");
            assert!(
                super::windows_data_paths(home.path(), home.path(), id).is_err(),
                "{id}"
            );
        }
    }

    #[test]
    fn windows_cleanup_removes_roaming_and_local_data_only() {
        let roaming = tempfile::tempdir().unwrap();
        let local = tempfile::tempdir().unwrap();
        let id = "com.example.uninstall-test";
        for (_, path) in super::windows_data_paths(roaming.path(), local.path(), id).unwrap() {
            std::fs::create_dir_all(&path).unwrap();
            std::fs::write(path.join("data"), "cached data").unwrap();
        }
        let other = local.path().join("com.example.other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("keep"), "other app").unwrap();
        super::remove_windows_app_data_at(roaming.path(), local.path(), id).unwrap();
        super::remove_windows_app_data_at(roaming.path(), local.path(), id).unwrap();
        for (_, path) in super::windows_data_paths(roaming.path(), local.path(), id).unwrap() {
            assert!(!path.exists());
        }
        assert!(other.join("keep").exists());
    }

    #[cfg(unix)]
    #[test]
    fn redirected_data_parent_is_not_followed() {
        let home = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let id = "com.example.uninstall-test";
        std::fs::create_dir_all(other.path().join(id)).unwrap();
        std::fs::create_dir_all(home.path().join("Library")).unwrap();
        std::os::unix::fs::symlink(other.path(), home.path().join("Library/Caches")).unwrap();
        assert!(super::remove_macos_app_data(home.path(), id).is_err());
        assert!(other.path().join(id).exists());
    }
}
