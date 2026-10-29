#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "macos")]
    {
        let args: Vec<_> = std::env::args().skip(1).collect();
        if args.len() == 2 && args[0] == "--finish-uninstall" {
            if let Ok(pid) = args[1].parse() {
                std::process::exit(openvpn_client::finish_uninstall(pid));
            }
            std::process::exit(1);
        }
    }
    if std::env::args_os().skip(1).collect::<Vec<_>>()
        == [std::ffi::OsString::from("--clear-saved-credentials")]
    {
        match openvpn_client::clear_saved_credentials() {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    #[cfg(windows)]
    if std::env::args_os().skip(1).collect::<Vec<_>>()
        == [std::ffi::OsString::from("--clear-uninstall-data")]
    {
        match openvpn_client::clear_uninstall_data() {
            Ok(()) => std::process::exit(0),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if let Some(directory) = std::env::args_os()
        .skip(1)
        .collect::<Vec<_>>()
        .as_slice()
        .strip_prefix(&[std::ffi::OsString::from("--vpn-worker")])
        .and_then(|args| {
            if args.len() == 1 {
                Some(args[0].clone())
            } else {
                None
            }
        })
    {
        std::process::exit(openvpn_client::worker::run(std::path::Path::new(
            &directory,
        )));
    }
    openvpn_client::run();
}
