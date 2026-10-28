#[cfg(target_os = "linux")]
mod native_server;
#[cfg(any(windows, test))]
mod wsl_server;
#[cfg(not(any(target_os = "linux", windows)))]
use std::net::TcpStream;
use std::process::Child;
#[cfg(not(any(target_os = "linux", windows)))]
use std::process::Command;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder};
use tauri::Manager;

struct ServerProcess(Mutex<Option<Child>>);

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Some(child) = self
            .0
            .get_mut()
            .unwrap_or_else(|error| error.into_inner())
            .take()
        {
            kill_server(child);
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn start_server(server_dir: &std::path::Path) -> Result<Child, String> {
    for attempt in 1..=3 {
        let result = Command::new("node")
            .args(["server.js", "--no-open"])
            .current_dir(server_dir)
            .spawn();
        match result {
            Ok(child) => return Ok(child),
            Err(e) if attempt < 3 => {
                eprintln!("Server start attempt {}/3 failed: {}", attempt, e);
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            Err(e) => return Err(format!("Failed to start server after 3 attempts: {}", e)),
        }
    }
    unreachable!()
}

#[cfg(not(any(target_os = "linux", windows)))]
fn wait_for_server(port: u16, timeout_ms: u64) -> bool {
    let start = std::time::Instant::now();
    let timeout = std::time::Duration::from_millis(timeout_ms);
    while start.elapsed() < timeout {
        if TcpStream::connect(format!("127.0.0.1:{}", port)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    false
}

fn kill_server(child: Child) {
    #[cfg(target_os = "linux")]
    if let Err(error) = native_server::stop(&mut { child }) {
        eprintln!("{error}");
    }
    #[cfg(windows)]
    {
        // Windows connects to the shared WSL service and owns no server process.
        drop(child);
    }
    #[cfg(not(any(windows, target_os = "linux")))]
    {
        let mut child = child;
        let _ = child.kill();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "linux", windows)))]
    let server_dir = if cfg!(debug_assertions) {
        std::env::current_dir()
            .unwrap()
            .parent()
            .unwrap()
            .to_path_buf()
    } else {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|p| p.to_path_buf()))
            .unwrap_or_else(|| std::env::current_dir().unwrap())
    };

    #[cfg(not(any(target_os = "linux", windows)))]
    let child =
        start_server(&server_dir).expect("Failed to start node server. Is Node.js installed?");

    #[cfg(not(any(target_os = "linux", windows)))]
    if !wait_for_server(3847, 8000) {
        eprintln!("Warning: Server did not respond within 8 seconds");
    }

    let context = tauri::generate_context!();
    #[cfg(any(target_os = "linux", windows))]
    let context = {
        let mut context = context;
        // Navigate only after selecting and verifying the configured native server.
        for window in &mut context.config_mut().app.windows {
            #[cfg(target_os = "linux")]
            {
                window.url = tauri::WebviewUrl::External("about:blank".parse().unwrap());
            }
            #[cfg(windows)]
            {
                window.url = tauri::WebviewUrl::External(wsl_server::status_page(
                    "WSL의 Cockpit 서버에 연결하고 있습니다.",
                ));
            }
        }
        context
    };

    tauri::Builder::default()
        .manage(ServerProcess(Mutex::new({
            #[cfg(any(target_os = "linux", windows))]
            {
                None
            }
            #[cfg(not(any(target_os = "linux", windows)))]
            {
                Some(child)
            }
        })))
        .setup(|app| {
            #[cfg(windows)]
            {
                let app = app.handle().clone();
                // Keep watching the server: a WSL restart can change its IP or take it down,
                // and the window must reconnect on its own instead of staying on a dead page.
                std::thread::spawn(move || {
                    use std::time::Duration;
                    let mut current: Option<tauri::Url> = None;
                    let mut misses = 0;
                    loop {
                        if let Some(url) = &current {
                            if wsl_server::is_up(url) {
                                misses = 0;
                                std::thread::sleep(Duration::from_secs(5));
                                continue;
                            }
                            // Short blips (server restart) are left to the page's own reconnect.
                            misses += 1;
                            if misses < 3 {
                                std::thread::sleep(Duration::from_secs(2));
                                continue;
                            }
                        }
                        let next = wsl_server::connect();
                        let target = match &next {
                            Ok(url) => url.clone(),
                            Err(error) => wsl_server::status_page(&format!("연결하지 못했습니다. {error} 5초 뒤 다시 연결합니다. 계속 실패하면 Ubuntu의 cockpit-prod.service를 확인해 주세요.")),
                        };
                        if let Some(window) = app.get_webview_window("main") {
                            if window.navigate(target).is_err() {
                                let _ = window.set_title("Cockpit — 연결 화면을 열지 못했습니다");
                            }
                        }
                        current = next.ok();
                        misses = 0;
                        if current.is_none() {
                            std::thread::sleep(Duration::from_secs(5));
                        }
                    }
                });
            }
            #[cfg(target_os = "linux")]
            {
                let root = if cfg!(debug_assertions) {
                    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .unwrap()
                        .to_path_buf()
                } else {
                    app.path().resource_dir()?
                };
                let binary = root.join(if cfg!(debug_assertions) {
                    "rust-server/target/release/cockpit-server"
                } else {
                    "cockpit-server"
                });
                let home = app.path().home_dir()?;
                let data = std::env::var_os("LOCALAPPDATA")
                    .filter(|value| !value.is_empty())
                    .or_else(|| std::env::var_os("APPDATA").filter(|value| !value.is_empty()))
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| home.join(".local/share"))
                    .join("cockpit");
                let port = std::env::var("COCKPIT_PORT")
                    .ok()
                    .and_then(|value| value.parse::<u16>().ok())
                    .filter(|port| *port > 0)
                    .unwrap_or(3847);
                *app.state::<ServerProcess>().0.lock().unwrap() =
                    native_server::start(&binary, &root, &data, &home, port)?;
                if let Some(window) = app.get_webview_window("main") {
                    window.navigate(format!("http://127.0.0.1:{port}").parse()?)?;
                }
            }
            // System tray
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Cockpit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut builder = TrayIconBuilder::new()
                .tooltip("Cockpit")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        let state = app.state::<ServerProcess>();
                        if let Some(child) = state.0.lock().unwrap().take() {
                            kill_server(child);
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon().cloned() {
                builder = builder.icon(icon);
            }

            builder.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Minimize to tray instead of closing
                    api.prevent_close();
                    let _ = window.hide();
                }
                tauri::WindowEvent::Destroyed => {
                    let state = window.state::<ServerProcess>();
                    let mut guard = state.0.lock().unwrap();
                    if let Some(child) = guard.take() {
                        kill_server(child);
                    }
                    drop(guard);
                }
                _ => {}
            }
        })
        .run(context)
        .expect("error while running tauri application");
}
