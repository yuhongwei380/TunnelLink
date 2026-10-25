use std::{
    fs::{File, OpenOptions},
    io,
    os::windows::io::AsRawHandle,
    process::Child,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::{
        Console::{
            AllocConsole, GetConsoleWindow, WriteConsoleInputW, INPUT_RECORD, KEY_EVENT,
            KEY_EVENT_RECORD,
        },
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    },
    UI::WindowsAndMessaging::{ShowWindow, SW_HIDE},
};

pub struct EngineJob(HANDLE);
impl EngineJob {
    pub fn attach(child: &Child) -> io::Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Self(handle);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(handle, child.as_raw_handle() as _) == 0
            {
                return Err(io::Error::last_os_error());
            }
            Ok(job)
        }
    }
}
impl Drop for EngineJob {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

pub fn console_input() -> io::Result<File> {
    unsafe {
        AllocConsole();
        let window = GetConsoleWindow();
        if !window.is_null() {
            ShowWindow(window, SW_HIDE);
        }
    }
    OpenOptions::new().read(true).write(true).open("CONIN$")
}

pub fn request_graceful_stop() {
    // Upstream ovpncli's Windows loop maps scan code 0x3e (F4) to client.stop().
    // The supervisor and engine share a private, hidden console, not the UI's console.
    if let Ok(input) = OpenOptions::new().read(true).write(true).open("CONIN$") {
        unsafe {
            let mut record: INPUT_RECORD = std::mem::zeroed();
            record.EventType = KEY_EVENT as u16;
            record.Event.KeyEvent = KEY_EVENT_RECORD {
                bKeyDown: 1,
                wRepeatCount: 1,
                wVirtualKeyCode: 0x73,
                wVirtualScanCode: 0x3e,
                uChar: std::mem::zeroed(),
                dwControlKeyState: 0,
            };
            let mut written = 0;
            WriteConsoleInputW(input.as_raw_handle() as _, &record, 1, &mut written);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::windows::process::CommandExt,
        process::{Command, Stdio},
        thread,
        time::{Duration, Instant},
    };

    fn wait(child: &mut Child) -> std::process::ExitStatus {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                return status;
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Supervisor did not stop the child");
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn console_stop_and_crash_cleanup_reach_the_child() {
        let input = console_input().unwrap();
        let mut child = Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "if ([Console]::ReadKey($true).Key -eq [ConsoleKey]::F4) { exit 0 } else { exit 1 }"])
            .stdin(input).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let job = EngineJob::attach(&child).unwrap();
        request_graceful_stop();
        assert!(wait(&mut child).success());
        drop(job);

        let mut child = Command::new("powershell.exe")
            .creation_flags(0x08000000)
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 60"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let job = EngineJob::attach(&child).unwrap();
        drop(job);
        wait(&mut child);
    }
}
