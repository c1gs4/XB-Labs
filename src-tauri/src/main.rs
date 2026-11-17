// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The desktop shell is a window onto the hub. On start it runs the bundled hub (runtime/node.exe
//! + runtime/server/index.mjs) with its database in the app's data folder, waits for the port, then
//! opens the window on it. A hub already listening on the port (a dev hub) is used as is.
//! Closing the app stops the hub it started, with every process under it.

use std::net::TcpStream;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const NO_WINDOW: u32 = 0x0800_0000;

const PORT: u16 = 5200;

struct Hub(Mutex<Option<Child>>);

fn hub_up() -> bool {
    TcpStream::connect_timeout(&([127, 0, 0, 1], PORT).into(), Duration::from_millis(300)).is_ok()
}

fn start_hub(app: &tauri::App) -> Result<Option<Child>, Box<dyn std::error::Error>> {
    if hub_up() {
        return Ok(None);
    }
    let rt = app.path().resource_dir()?.join("runtime");
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let node = rt.join(if cfg!(windows) { "node.exe" } else { "node" });
    let mut cmd = Command::new(node);
    cmd.arg(rt.join("server").join("index.mjs"))
        .current_dir(app.path().home_dir()?)
        .env("XBLABS_DB", data.join("xblabs.db"))
        .env("PORT", PORT.to_string());
    #[cfg(windows)]
    cmd.creation_flags(NO_WINDOW);
    Ok(Some(cmd.spawn()?))
}

fn stop_hub(child: &mut Child) {
    #[cfg(windows)]
    {
        // The hub owns terminals and agent runs: end the whole tree, not just node.exe.
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
fn app_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn main() {
    let app = tauri::Builder::default()
        .manage(Hub(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![app_version])
        .setup(|app| {
            let child = start_hub(app)?;
            *app.state::<Hub>().0.lock().unwrap() = child;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let t = Instant::now();
                while !hub_up() && t.elapsed() < Duration::from_secs(30) {
                    std::thread::sleep(Duration::from_millis(150));
                }
                let url = format!("http://127.0.0.1:{PORT}").parse().expect("hub url");
                let built = WebviewWindowBuilder::new(&handle, "main", WebviewUrl::External(url))
                    .title("XBLabs")
                    .inner_size(1280.0, 820.0)
                    .min_inner_size(800.0, 560.0)
                    .decorations(false)
                    .resizable(true)
                    .center()
                    .theme(Some(tauri::Theme::Dark))
                    .disable_drag_drop_handler()
                    .additional_browser_args("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required")
                    .build();
                if let Err(err) = built {
                    eprintln!("XBLabs window failed: {err}");
                    handle.exit(1);
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building XBLabs");
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = handle.state::<Hub>().0.lock().unwrap().take() {
                stop_hub(&mut child);
            }
        }
    });
}
