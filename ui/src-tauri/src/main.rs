#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
