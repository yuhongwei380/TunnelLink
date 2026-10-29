//! A short-lived native supervisor. On macOS only this process is elevated.
//! It accepts credentials, never an executable path or arbitrary shell command.
use serde::{Deserialize, Serialize};
#[cfg(not(unix))]
use std::fs::OpenOptions;
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

#[derive(Serialize, Deserialize)]
pub struct Request {
    pub username: String,
    pub password: String,
    pub parent_pid: u32,
}

pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // GUI/runtime threads can block signals. exec preserves that mask,
        // including across macOS administrator authorization. ovpncli installs
        // handlers but does not unblock inherited signals, so stats and graceful
        // stop requests would remain pending. Only use async-signal-safe calls
        // here: this closure runs in the child between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                let mut mask: libc::sigset_t = std::mem::zeroed();
                if libc::sigemptyset(&mut mask) != 0
                    || libc::sigprocmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut()) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn engine_path() -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let base = executable
        .parent()
        .ok_or("Executable directory is missing")?;
    #[cfg(target_os = "macos")]
    let packaged = base.join("../Resources/bin/macos/ovpncli");
    #[cfg(not(target_os = "macos"))]
    let packaged = base.join("bin/windows-x64/ovpncli.exe");
    if packaged.is_file() {
        return Ok(packaged);
    }
    #[cfg(debug_assertions)]
    {
        let platform = if cfg!(target_os = "macos") {
            "macos/ovpncli"
        } else {
            "windows-x64/ovpncli.exe"
        };
        let development = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../.cache/native/bin")
            .join(platform);
        if development.is_file() {
            return Ok(development);
        }
    }
    Err(format!(
        "Bundled OpenVPN engine is missing: {}",
        packaged.display()
    ))
}

// Open pre-created session files without following symlinks. The privileged
// worker never creates/truncates a user-selected path, nor accepts engine paths.
fn session_file(directory: &Path, name: &str, writable: bool) -> std::io::Result<File> {
    #[cfg(unix)]
    {
        use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
        let dir = std::ffi::CString::new(directory.as_os_str().as_bytes())?;
        let name = std::ffi::CString::new(name)?;
        // Pin the directory fd so a concurrent rename cannot redirect the open.
        let dir_fd = unsafe {
            libc::open(
                dir.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if dir_fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        use std::os::fd::{AsRawFd, FromRawFd};
        let dir_file = unsafe { File::from_raw_fd(dir_fd) };
        let metadata = dir_file.metadata()?;
        if metadata.mode() & 0o077 != 0 {
            return Err(std::io::Error::other("Session directory must be private"));
        }
        let flags = if writable {
            libc::O_RDWR | libc::O_APPEND
        } else {
            libc::O_RDONLY
        };
        let fd = unsafe {
            libc::openat(
                dir_file.as_raw_fd(),
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let file = unsafe { File::from_raw_fd(fd) };
        let info = file.metadata()?;
        if !info.is_file()
            || info.uid() != metadata.uid()
            || info.nlink() != 1
            || info.mode() & 0o077 != 0
        {
            return Err(std::io::Error::other("Unsafe session file permissions"));
        }
        Ok(file)
    }
    #[cfg(not(unix))]
    OpenOptions::new()
        .read(true)
        .append(writable)
        .open(directory.join(name))
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGTERM);
    }
    #[cfg(windows)]
    crate::windows_process::request_graceful_stop();
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn request_stats(child: &Child) {
    // Upstream ovpncli prints statistics on SIGUSR1 (Unix) or F2 (Windows).
    // Run this in the supervisor, which owns the privileged engine process.
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as i32, libc::SIGUSR1);
    }
    #[cfg(windows)]
    {
        let _ = child;
        crate::windows_process::request_stats();
    }
}

fn supervise(directory: &Path, log: &File) -> Result<i32, String> {
    if directory.join("stop").exists() {
        return Ok(0);
    }
    let mut raw = String::new();
    session_file(directory, "request.json", false)
        .map_err(|e| e.to_string())?
        .take(64 * 1024)
        .read_to_string(&mut raw)
        .map_err(|e| e.to_string())?;
    let request: Request = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if request.username.is_empty() || request.password.is_empty() || request.parent_pid == 0 {
        return Err("Invalid connection request".into());
    }
    let engine = engine_path()?;
    // Profile is compiled into the supervisor; callers cannot provide root-run directives.
    let profile = tempfile::Builder::new()
        .prefix("openvpn-profile-")
        .suffix(".ovpn")
        .tempfile()
        .map_err(|e| e.to_string())?;
    profile
        .as_file()
        .write_all(include_bytes!("../../../resources/settings/client.ovpn"))
        .map_err(|e| e.to_string())?;
    let mut cmd = command(engine);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0); // inherit the supervisor's hidden console for F4 stop
        cmd.stdin(crate::windows_process::console_input().map_err(|e| e.to_string())?);
    }
    #[cfg(not(windows))]
    cmd.stdin(Stdio::null());
    let mut child = cmd
        .args(["-u", &request.username, "-p", &request.password])
        .arg(profile.path())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log.try_clone().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("Unable to start OpenVPN: {e}"))?;
    #[cfg(windows)]
    let _job = match crate::windows_process::EngineJob::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            stop_child(&mut child);
            return Err(format!("Cannot supervise VPN process: {error}"));
        }
    };
    // The GUI removes the request file when it sees this marker.
    if let Err(error) = writeln!(&*log, "[supervisor] OpenVPN process started.") {
        stop_child(&mut child);
        return Err(error.to_string());
    }
    let started = Instant::now();
    let mut last_stats: Option<Instant> = None;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code().unwrap_or(-1)),
            Err(error) => {
                stop_child(&mut child);
                return Err(error.to_string());
            }
            _ => {}
        }
        #[cfg(unix)]
        let parent_gone = unsafe { libc::kill(request.parent_pid as i32, 0) } != 0;
        #[cfg(not(unix))]
        let parent_gone = false;
        // A heartbeat also covers Windows GUI crashes and a reused process id.
        let stale = fs::metadata(directory.join("heartbeat"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|time| time.elapsed().ok())
            .is_none_or(|age| age > Duration::from_secs(15));
        if directory.join("stop").exists()
            || parent_gone
            || (started.elapsed() > Duration::from_secs(15) && stale)
        {
            stop_child(&mut child);
            return Ok(0);
        }
        // The GUI creates this marker only after a confirmed CONNECTED event.
        // Never send SIGUSR1 during startup: before handlers are installed it
        // would terminate the engine. Reconnection/teardown remove the marker.
        if directory.join("stats-enabled").exists() {
            let previous = last_stats.get_or_insert_with(Instant::now);
            if previous.elapsed() >= Duration::from_secs(1) {
                request_stats(&child);
                last_stats = Some(Instant::now());
            }
        } else {
            last_stats = None;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

pub fn run(directory: &Path) -> i32 {
    let Ok(log) = session_file(directory, "engine.log", true) else {
        return 1;
    };
    let Ok(mut result) = session_file(directory, "exit.json", true) else {
        return 1;
    };
    let outcome = supervise(directory, &log);
    let value = match &outcome {
        Ok(code) => serde_json::json!({ "code": code }),
        Err(error) => serde_json::json!({ "code": -1, "error": error }),
    };
    let _ = result.write_all(value.to_string().as_bytes());
    outcome.unwrap_or(1)
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

pub fn launch(directory: &Path) -> Result<Child, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let shell = format!(
            "{} --vpn-worker {}",
            shell_quote(&executable.to_string_lossy()),
            shell_quote(&directory.to_string_lossy())
        );
        let escaped = shell.replace('\\', "\\\\").replace('"', "\\\"");
        let mut cmd = command("/usr/bin/osascript");
        cmd.args(["-e", &format!("with timeout of 31536000 seconds\n do shell script \"{escaped}\" with administrator privileges\nend timeout")]);
        cmd
    };
    #[cfg(not(target_os = "macos"))]
    let mut cmd = {
        let mut cmd = command(executable);
        cmd.arg("--vpn-worker").arg(directory);
        cmd
    };
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn unix_engine_commands_clear_inherited_signal_masks() {
        const CHILD: &str = "TUNNELLINK_TEST_SIGNAL_CHILD";
        if std::env::var_os(CHILD).is_some() {
            let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
            assert_eq!(
                unsafe { libc::pthread_sigmask(0, std::ptr::null(), &mut mask) },
                0
            );
            for signal in [
                libc::SIGUSR1,
                libc::SIGUSR2,
                libc::SIGTERM,
                libc::SIGINT,
                libc::SIGHUP,
            ] {
                assert_eq!(
                    unsafe { libc::sigismember(&mask, signal) },
                    0,
                    "signal {signal} remained blocked"
                );
            }
            return;
        }
        let mut blocked: libc::sigset_t = unsafe { std::mem::zeroed() };
        let mut original: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe {
            libc::sigemptyset(&mut blocked);
            for signal in [
                libc::SIGUSR1,
                libc::SIGUSR2,
                libc::SIGTERM,
                libc::SIGINT,
                libc::SIGHUP,
            ] {
                libc::sigaddset(&mut blocked, signal);
            }
        }
        assert_eq!(
            unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut original) },
            0
        );
        let child = command(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "worker::tests::unix_engine_commands_clear_inherited_signal_masks",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn();
        let restored =
            unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &original, std::ptr::null_mut()) };
        assert_eq!(restored, 0);
        let output = child.unwrap().wait_with_output().unwrap();
        assert!(
            output.status.success(),
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    #[cfg(unix)]
    #[test]
    fn unix_stats_request_signals_the_engine() {
        let directory = tempfile::tempdir().unwrap();
        let ready = directory.path().join("ready");
        let output = directory.path().join("stats");
        let mut child = command("/bin/sh")
            .args(["-c", "trap 'printf \"BYTES_IN : 123\\nBYTES_OUT : 456\\n\" > \"$STATS_OUTPUT\"; exit 0' USR1; touch \"$STATS_READY\"; while :; do sleep 0.1; done"])
            .env("STATS_READY", &ready)
            .env("STATS_OUTPUT", &output)
            .spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(25));
        }
        if !ready.exists() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("Mock engine did not install its statistics handler");
        }
        request_stats(&child);
        while Instant::now() < deadline {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                assert_eq!(
                    fs::read_to_string(output).unwrap(),
                    "BYTES_IN : 123\nBYTES_OUT : 456\n"
                );
                return;
            }
            thread::sleep(Duration::from_millis(25));
        }
        let _ = child.kill();
        let _ = child.wait();
        panic!("Mock engine did not receive the statistics signal");
    }
    #[test]
    fn shell_paths_cannot_inject_commands() {
        assert_eq!(shell_quote("/Apps/a'b $x.app"), "'/Apps/a'\"'\"'b $x.app'");
    }
    #[test]
    fn cancelled_session_never_starts_the_engine() {
        let directory = tempfile::tempdir().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(directory.path(), fs::Permissions::from_mode(0o700)).unwrap();
        }
        for name in ["engine.log", "exit.json", "stop"] {
            let file = File::create(directory.path().join(name)).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                file.set_permissions(fs::Permissions::from_mode(0o600))
                    .unwrap();
            }
            drop(file);
        }
        assert_eq!(run(directory.path()), 0);
        let result: serde_json::Value =
            serde_json::from_slice(&fs::read(directory.path().join("exit.json")).unwrap()).unwrap();
        assert_eq!(result["code"], 0);
        assert!(fs::read(directory.path().join("engine.log"))
            .unwrap()
            .is_empty());
    }
}
