// QuotaOps Tauri proof of concept.
//
// Deliberately minimal, and structurally matched to the Electron PoC so the
// measurements are comparable: it supervises the same trusted dashboard server
// as a child process, waits for the runtime descriptor, confirms the listener's
// identity, and loads the allocated loopback URL in a WebView2 window.
//
// Not production code. No tray, no settings, no updater.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{WebviewUrl, WebviewWindowBuilder};

const INSTANCE_PATH: &str = "/__quotaops/instance";

fn repo_root() -> PathBuf {
    // target/release/quotaops.exe -> desktop/tauri -> desktop -> repo
    let mut path = std::env::current_exe().expect("current exe");
    for _ in 0..5 {
        path.pop();
    }
    path
}

fn descriptor_path() -> PathBuf {
    let home = std::env::var("USERPROFILE").expect("USERPROFILE");
    PathBuf::from(home).join(".quotaops").join("dashboard-runtime.json")
}

/// Starts the same entry point `npm start` uses, so the PoC measures the real
/// runtime rather than a stripped-down stand-in.
fn start_dashboard_server(root: &PathBuf) -> std::io::Result<Child> {
    let server = root.join("server").join("dashboard-server.ts");
    Command::new("node")
        .arg("--experimental-strip-types")
        .arg(server)
        .arg("--production")
        .current_dir(root)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

/// Resolves the dashboard the same way the launcher and the Electron PoC do:
/// read the descriptor, then require the listener to echo the recorded
/// instance id. A port alone is never treated as proof that QuotaOps owns it.
fn wait_for_dashboard(timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;

    while Instant::now() < deadline {
        if let Ok(raw) = fs::read_to_string(descriptor_path()) {
            if let Ok(descriptor) = serde_json::from_str::<serde_json::Value>(&raw) {
                let port = descriptor.get("port").and_then(|v| v.as_u64());
                let expected = descriptor.get("instanceId").and_then(|v| v.as_str());

                if let (Some(port), Some(expected)) = (port, expected) {
                    let url = format!("http://127.0.0.1:{port}{INSTANCE_PATH}");
                    if let Ok(response) = http_get(&url) {
                        if response.contains(expected) {
                            return Some(format!("http://127.0.0.1:{port}/"));
                        }
                    }
                }
            }
        }
        thread::sleep(Duration::from_millis(250));
    }

    None
}

/// Minimal blocking GET. The PoC avoids pulling a full HTTP client in so the
/// measured binary stays representative of a shell that only needs to confirm
/// one local endpoint.
fn http_get(url: &str) -> Result<String, ()> {
    use std::io::{Read, Write};
    use std::net::TcpStream;

    let rest = url.strip_prefix("http://").ok_or(())?;
    let (authority, path) = rest.split_once('/').ok_or(())?;
    let mut stream = TcpStream::connect(authority).map_err(|_| ())?;
    stream
        .set_read_timeout(Some(Duration::from_millis(1500)))
        .map_err(|_| ())?;
    let request = format!("GET /{path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|_| ())?;

    let mut body = String::new();
    stream.read_to_string(&mut body).map_err(|_| ())?;
    Ok(body)
}

fn main() {
    let root = repo_root();
    let server = start_dashboard_server(&root).expect("dashboard server");

    let url = wait_for_dashboard(Duration::from_secs(60))
        .expect("dashboard did not become ready");

    tauri::Builder::default()
        .setup(move |app| {
            let parsed = url.parse().expect("dashboard url");
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
                .title("QuotaOps")
                .inner_size(1280.0, 860.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                // The supervised server must not outlive the window.
                let _ = Command::new("taskkill")
                    .args(["/PID", &server.id().to_string(), "/T", "/F"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        });
}
