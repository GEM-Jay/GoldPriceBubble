#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, OnceLock,
};
use tauri::{
    AppHandle, CustomMenuItem, LogicalSize, Manager, PhysicalPosition, SystemTray, SystemTrayEvent,
    SystemTrayMenu, SystemTrayMenuItem, Window,
};
use window_shadows::set_shadow;

mod taskbar_host;
use taskbar_host::{
    PriceDisplayMode, StatusCallback, TaskbarDisplayPayload, TaskbarDisplayStatus, TaskbarHost,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

const CLIENT_LOG_MAX_BYTES: usize = 10 * 1024 * 1024;
const CLIENT_LOG_EXPORT_BYTES: usize = 1024 * 1024;
static RUNTIME_METADATA: OnceLock<serde_json::Value> = OnceLock::new();
static SESSION_STATE_PATH: OnceLock<PathBuf> = OnceLock::new();
static LAST_MANAGER_DPI_FIX_MS: AtomicU64 = AtomicU64::new(0);

#[derive(serde::Serialize, serde::Deserialize)]
struct ClientIdentity {
    install_id: String,
    legacy_client_id: Option<String>,
    created_at: String,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct SessionStateRecord {
    session_id: String,
    status: String,
    started_at: String,
    last_heartbeat_at: String,
    exit_at: Option<String>,
    exit_reason: Option<String>,
    app_version: String,
}

// ========== 状态管理 ==========
struct AppState {
    bubble_visible: Mutex<bool>,
    auto_start_enabled: Mutex<bool>,
    active_download_id: Mutex<Option<String>>,
}

// ========== Tauri Commands ==========

#[tauri::command]
async fn quit_app(app: AppHandle) {
    request_app_exit(&app, "quit_app_command");
}

#[cfg(target_os = "windows")]
fn fix_window_dpi(window: &tauri::Window) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOZORDER,
    };

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let previous = LAST_MANAGER_DPI_FIX_MS.swap(now_ms, Ordering::Relaxed);
    if now_ms.saturating_sub(previous) < 400 {
        return;
    }
    if let (Ok(hwnd), Ok(size)) = (window.hwnd(), window.outer_size()) {
        unsafe {
            let _ = SetWindowPos(
                HWND(hwnd.0),
                HWND(0),
                0,
                0,
                size.width as i32,
                size.height as i32,
                SWP_NOMOVE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
            );
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn fix_window_dpi(_window: &tauri::Window) {}

#[tauri::command]
async fn fix_manager_dpi(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("manager") {
        fix_window_dpi(&window);
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ManagerWindowFit {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

fn calculate_manager_window_fit(work_width: f64, work_height: f64) -> ManagerWindowFit {
    const TARGET_WIDTH: f64 = 1200.0;
    const TARGET_HEIGHT: f64 = 800.0;
    const PREFERRED_MIN_WIDTH: f64 = 900.0;
    const PREFERRED_MIN_HEIGHT: f64 = 600.0;

    let work_width = work_width.max(1.0).floor();
    let work_height = work_height.max(1.0).floor();
    ManagerWindowFit {
        width: TARGET_WIDTH.min(work_width),
        height: TARGET_HEIGHT.min(work_height),
        min_width: PREFERRED_MIN_WIDTH.min(work_width),
        min_height: PREFERRED_MIN_HEIGHT.min(work_height),
    }
}

#[cfg(target_os = "windows")]
fn manager_work_area(window: &tauri::Window) -> Result<(i32, i32, u32, u32), String> {
    use std::mem::size_of;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };

    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    unsafe {
        let monitor = MonitorFromWindow(HWND(hwnd.0), MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO {
            cbSize: size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if !GetMonitorInfoW(monitor, &mut info).as_bool() {
            return Err("GetMonitorInfoW failed".to_string());
        }
        let width = (info.rcWork.right - info.rcWork.left).max(1) as u32;
        let height = (info.rcWork.bottom - info.rcWork.top).max(1) as u32;
        Ok((info.rcWork.left, info.rcWork.top, width, height))
    }
}

fn clamp_window_position_to_work_area(
    x: i32,
    y: i32,
    window_width: u32,
    window_height: u32,
    work_left: i32,
    work_top: i32,
    work_width: u32,
    work_height: u32,
) -> (i32, i32) {
    let left = i64::from(work_left);
    let top = i64::from(work_top);
    let max_x = (left + i64::from(work_width) - i64::from(window_width)).max(left);
    let max_y = (top + i64::from(work_height) - i64::from(window_height)).max(top);
    (
        i64::from(x).clamp(left, max_x) as i32,
        i64::from(y).clamp(top, max_y) as i32,
    )
}

fn constrain_bubble_to_work_area(window: &tauri::Window) -> Result<(), String> {
    let position = window.outer_position().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    let (work_left, work_top, work_width, work_height) = manager_work_area(window)?;
    #[cfg(not(target_os = "windows"))]
    let (work_left, work_top, work_width, work_height) = {
        let monitor = window
            .current_monitor()
            .map_err(|e| e.to_string())?
            .or_else(|| window.primary_monitor().ok().flatten())
            .ok_or_else(|| "no monitor available".to_string())?;
        (
            monitor.position().x,
            monitor.position().y,
            monitor.size().width,
            monitor.size().height,
        )
    };

    let (x, y) = clamp_window_position_to_work_area(
        position.x,
        position.y,
        size.width,
        size.height,
        work_left,
        work_top,
        work_width,
        work_height,
    );
    if x != position.x || y != position.y {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn fit_manager_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("manager") {
        if window.is_maximized().unwrap_or(false) {
            fix_window_dpi(&window);
            return Ok(());
        }

        #[cfg(target_os = "windows")]
        let (work_left, work_top, work_physical_width, work_physical_height) =
            manager_work_area(&window)?;
        #[cfg(not(target_os = "windows"))]
        let (work_left, work_top, work_physical_width, work_physical_height) = {
            let monitor = window
                .current_monitor()
                .map_err(|e| e.to_string())?
                .or_else(|| window.primary_monitor().ok().flatten())
                .ok_or_else(|| "no monitor available".to_string())?;
            (
                monitor.position().x,
                monitor.position().y,
                monitor.size().width,
                monitor.size().height,
            )
        };

        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        let fit = calculate_manager_window_fit(
            work_physical_width as f64 / scale,
            work_physical_height as f64 / scale,
        );
        window
            .set_min_size(Some(LogicalSize::new(fit.min_width, fit.min_height)))
            .map_err(|e| e.to_string())?;
        window
            .set_size(LogicalSize::new(fit.width, fit.height))
            .map_err(|e| e.to_string())?;

        let physical_width = (fit.width * scale).round() as i32;
        let physical_height = (fit.height * scale).round() as i32;
        let x = work_left + (work_physical_width as i32 - physical_width).max(0) / 2;
        let y = work_top + (work_physical_height as i32 - physical_height).max(0) / 2;
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        fix_window_dpi(&window);
    }
    Ok(())
}

#[cfg(test)]
mod manager_window_fit_tests {
    use super::{calculate_manager_window_fit, ManagerWindowFit};

    #[test]
    fn keeps_preferred_size_when_work_area_is_large_enough() {
        assert_eq!(
            calculate_manager_window_fit(1920.0, 1040.0),
            ManagerWindowFit {
                width: 1200.0,
                height: 800.0,
                min_width: 900.0,
                min_height: 600.0,
            }
        );
    }

    #[test]
    fn uses_each_available_axis_without_aspect_ratio_gaps() {
        assert_eq!(
            calculate_manager_window_fit(1280.0, 680.0),
            ManagerWindowFit {
                width: 1200.0,
                height: 680.0,
                min_width: 900.0,
                min_height: 600.0,
            }
        );
    }

    #[test]
    fn never_exceeds_a_small_work_area() {
        assert_eq!(
            calculate_manager_window_fit(800.0, 450.0),
            ManagerWindowFit {
                width: 800.0,
                height: 450.0,
                min_width: 800.0,
                min_height: 450.0,
            }
        );
    }

    #[test]
    fn fits_a_4k_work_area_at_200_percent_scaling() {
        assert_eq!(
            calculate_manager_window_fit(3840.0 / 2.0, 2080.0 / 2.0),
            ManagerWindowFit {
                width: 1200.0,
                height: 800.0,
                min_width: 900.0,
                min_height: 600.0,
            }
        );
    }
}

#[cfg(test)]
mod bubble_position_tests {
    use super::clamp_window_position_to_work_area;

    #[test]
    fn keeps_bubble_below_a_top_taskbar() {
        assert_eq!(
            clamp_window_position_to_work_area(420, -80, 220, 120, 0, 48, 1920, 1032),
            (420, 48)
        );
    }

    #[test]
    fn keeps_bubble_above_a_bottom_taskbar() {
        assert_eq!(
            clamp_window_position_to_work_area(1720, 1040, 220, 120, 0, 0, 1920, 1040),
            (1700, 920)
        );
    }

    #[test]
    fn supports_negative_secondary_monitor_coordinates() {
        assert_eq!(
            clamp_window_position_to_work_area(-2100, 300, 220, 120, -1920, 0, 1920, 1040),
            (-1920, 300)
        );
    }
}

#[tauri::command]
async fn open_manager(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("manager") {
        window.unminimize().map_err(|e| e.to_string())?;
        fit_manager_window(app.clone()).await?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        fix_window_dpi(&window);
        let app_after_show = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
            let _ = fit_manager_window(app_after_show.clone()).await;
            if let Some(win) = app_after_show.get_window("manager") {
                fix_window_dpi(&win);
            }
        });
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_bubble(app: AppHandle) -> Result<(), String> {
    app.state::<TaskbarHost>().set_user_visible(false);
    synchronize_price_display(&app)?;
    Ok(())
}

#[tauri::command]
async fn show_bubble(app: AppHandle) -> Result<(), String> {
    app.state::<TaskbarHost>().set_user_visible(true);
    synchronize_price_display(&app)?;
    Ok(())
}

#[tauri::command]
async fn set_price_display_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let mode = PriceDisplayMode::parse(&mode)?;
    app.state::<TaskbarHost>().set_mode(mode);
    synchronize_price_display(&app)?;
    Ok(())
}

#[tauri::command]
async fn update_taskbar_display(
    app: AppHandle,
    payload: TaskbarDisplayPayload,
) -> Result<(), String> {
    app.state::<TaskbarHost>().update(payload);
    Ok(())
}

#[tauri::command]
async fn get_taskbar_display_status(app: AppHandle) -> Result<TaskbarDisplayStatus, String> {
    Ok(app.state::<TaskbarHost>().status())
}

#[tauri::command]
async fn resize_bubble(
    app: AppHandle,
    font_size: i32,
    rows: i32,
    pnl_rows: Option<i32>,
    content_width: Option<i32>,
    content_height: Option<i32>,
    dpi_scale: Option<f64>,
) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        let base_font_size = 12.0;
        let font_size_f = font_size as f64;
        let font_ratio = font_size_f / base_font_size;

        let scale = dpi_scale.unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));

        // 宽度：前端 offsetWidth（解除约束后的自然宽度）+ buffer 防高DPI舍入裁边
        let side_buffer = 4.0;
        let width = if let Some(w) = content_width {
            w as f64 + side_buffer
        } else {
            let base_width = 220.0;
            let width_per_font = 8.0;
            base_width + (font_size_f - base_font_size) * width_per_font
        };

        let bottom_buffer = 4.0;
        let total_height = if let Some(dom_h) = content_height {
            dom_h as f64 + bottom_buffer
        } else {
            // Fallback：公式估算
            let header_height = 36.0;
            let padding_vertical = 24.0;
            let line_height = 18.0 * font_ratio;
            let line_spacing = 2.0;
            let has_pnl = pnl_rows.unwrap_or(0) > 0;
            let separator_height = if has_pnl { 11.0 } else { 0.0 };
            let valid_rows = rows.max(1);
            let c_height =
                (line_height + line_spacing) * valid_rows as f64 - line_spacing + separator_height;
            header_height + padding_vertical + c_height + 20.0
        };

        // 获取屏幕可用高度，留出任务栏空间
        let max_height = if let Ok(Some(monitor)) = window.current_monitor() {
            let logical_height = monitor.size().height as f64 / scale;
            (logical_height * 0.80).floor()
        } else {
            800.0
        };

        // 高度范围：60px ~ min(屏幕80%, 1000px)
        let height = total_height.ceil().max(60.0).min(max_height.min(1000.0));

        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn open_devtools(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(window) = app.get_window(&label) {
        window.open_devtools();
    }
    Ok(())
}

#[tauri::command]
async fn set_bubble_size(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::Foundation::HWND;
            use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, SWP_NOMOVE, SWP_NOZORDER};
            let hwnd = window.hwnd().map_err(|e| e.to_string())?;
            // JS 已用 devicePixelRatio 换算为物理像素，直接使用
            let phys_w = width.round() as i32;
            let phys_h = height.round() as i32;
            unsafe {
                SetWindowPos(
                    HWND(hwnd.0),
                    HWND(0),
                    0,
                    0,
                    phys_w,
                    phys_h,
                    SWP_NOMOVE | SWP_NOZORDER,
                )
                .map_err(|e| e.to_string())?;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            window
                .set_size(LogicalSize::new(width, height))
                .map_err(|e| e.to_string())?;
        }
        constrain_bubble_to_work_area(&window)?;
    }
    Ok(())
}

#[tauri::command]
async fn get_bubble_position(app: AppHandle) -> Result<(i32, i32), String> {
    if let Some(window) = app.get_window("bubble") {
        let position = window.outer_position().map_err(|e| e.to_string())?;
        Ok((position.x, position.y))
    } else {
        // Return default position
        Ok((100, 100))
    }
}

#[tauri::command]
async fn move_bubble(app: AppHandle, x: i32, y: i32) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        window
            .set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        constrain_bubble_to_work_area(&window)?;
    }
    Ok(())
}

#[tauri::command]
async fn save_bubble_position(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        constrain_bubble_to_work_area(&window)?;
        let position = window.outer_position().map_err(|e| e.to_string())?;

        // Save to file
        let app_data_dir = app
            .path_resolver()
            .app_data_dir()
            .ok_or("Failed to get app data dir")?;

        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;

        let config_path = app_data_dir.join("bubble-position.json");
        let config = serde_json::json!({
            "x": position.x,
            "y": position.y
        });

        std::fs::write(config_path, config.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn load_bubble_position(app: AppHandle) -> Result<Option<(i32, i32)>, String> {
    let app_data_dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to get app data dir")?;

    let config_path = app_data_dir.join("bubble-position.json");

    if config_path.exists() {
        let content = std::fs::read_to_string(config_path).map_err(|e| e.to_string())?;
        let config: serde_json::Value =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;

        if let (Some(x), Some(y)) = (config["x"].as_i64(), config["y"].as_i64()) {
            return Ok(Some((x as i32, y as i32)));
        }
    }

    Ok(None)
}

#[tauri::command]
async fn show_bubble_context_menu(_app: AppHandle, _window: Window) -> Result<(), String> {
    // Note: Context menu in Tauri requires custom implementation
    // For now, right-clicking will be handled by system tray menu
    Ok(())
}

#[tauri::command]
async fn clear_all_data_and_quit(app: AppHandle) -> Result<(), String> {
    // 清除应用数据目录
    if let Some(app_data_dir) = app.path_resolver().app_data_dir() {
        if app_data_dir.exists() {
            std::fs::remove_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
        }
    }

    // 退出应用
    request_app_exit(&app, "clear_all_data_and_quit");
    Ok(())
}

#[tauri::command]
async fn set_auto_start(app: AppHandle, enabled: bool) -> Result<(), String> {
    use auto_launch::*;

    let app_name = "GoldPrice";
    let app_path = std::env::current_exe().map_err(|e| e.to_string())?;

    let auto = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&format!("\"{}\"", app_path.to_string_lossy()))
        .build()
        .map_err(|e| e.to_string())?;

    if enabled {
        auto.enable().map_err(|e| e.to_string())?;
    } else {
        auto.disable().map_err(|e| e.to_string())?;
    }

    // Update state and tray menu
    let state: tauri::State<AppState> = app.state();
    *state.auto_start_enabled.lock().unwrap() = enabled;
    update_tray_menu(&app);

    Ok(())
}

#[tauri::command]
async fn get_auto_start_status(_app: AppHandle) -> Result<bool, String> {
    use auto_launch::*;

    let app_name = "GoldPrice";
    let app_path = std::env::current_exe().map_err(|e| e.to_string())?;

    let auto = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&format!("\"{}\"", app_path.to_string_lossy()))
        .build()
        .map_err(|e| e.to_string())?;

    auto.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn notify_bubble(app: AppHandle, message: String) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        window.emit(&message, ()).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn refresh_bubble(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        window
            .emit("bubble-refresh-now", ())
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path_resolver()
        .app_data_dir()
        .ok_or("Failed to get app data dir")?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("client-identity.json"))
}

fn logs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_data_dir(app)?.join("logs");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn log_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(logs_dir(app)?.join("app.log"))
}

fn session_state_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("session-state.json"))
}

fn read_session_state(path: &PathBuf) -> Option<SessionStateRecord> {
    let content = fs::read_to_string(path).ok()?;
    serde_json::from_str(&content).ok()
}

fn write_session_state(path: &PathBuf, record: &SessionStateRecord) -> Result<(), String> {
    let content = serde_json::to_vec_pretty(record).map_err(|e| e.to_string())?;
    fs::write(path, content).map_err(|e| e.to_string())
}

fn update_session_state(
    app: &AppHandle,
    status: &str,
    exit_reason: Option<&str>,
) -> Result<(), String> {
    let path = SESSION_STATE_PATH
        .get()
        .cloned()
        .unwrap_or(session_state_path(app)?);
    let now = chrono_like_now();
    let mut record = read_session_state(&path).unwrap_or(SessionStateRecord {
        session_id: uuid::Uuid::new_v4().to_string(),
        status: "running".to_string(),
        started_at: now.clone(),
        last_heartbeat_at: now.clone(),
        exit_at: None,
        exit_reason: None,
        app_version: app.package_info().version.to_string(),
    });
    record.status = status.to_string();
    record.last_heartbeat_at = now.clone();
    record.app_version = app.package_info().version.to_string();
    if status == "running" {
        record.exit_at = None;
        record.exit_reason = None;
    } else {
        record.exit_at = Some(now);
        record.exit_reason = exit_reason.map(|s| s.to_string());
    }
    write_session_state(&path, &record)
}

fn install_panic_hook() {
    static PANIC_HOOK_INSTALLED: AtomicBool = AtomicBool::new(false);
    if PANIC_HOOK_INSTALLED.swap(true, Ordering::SeqCst) {
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic_info| {
        if let Some(path) = SESSION_STATE_PATH.get() {
            let now = chrono_like_now();
            let mut record = read_session_state(path).unwrap_or(SessionStateRecord {
                session_id: uuid::Uuid::new_v4().to_string(),
                status: "panic".to_string(),
                started_at: now.clone(),
                last_heartbeat_at: now.clone(),
                exit_at: Some(now.clone()),
                exit_reason: None,
                app_version: String::new(),
            });
            let payload = if let Some(msg) = panic_info.payload().downcast_ref::<&str>() {
                (*msg).to_string()
            } else if let Some(msg) = panic_info.payload().downcast_ref::<String>() {
                msg.clone()
            } else {
                "unknown panic payload".to_string()
            };
            let location = panic_info
                .location()
                .map(|loc| format!("{}:{}", loc.file(), loc.line()))
                .unwrap_or_else(|| "unknown location".to_string());
            record.status = "panic".to_string();
            record.last_heartbeat_at = now.clone();
            record.exit_at = Some(now);
            record.exit_reason = Some(format!("panic at {}: {}", location, payload));
            let _ = write_session_state(path, &record);
        }
        default_hook(panic_info);
    }));
}

fn initialize_session_tracking(app: &AppHandle) -> Result<(), String> {
    let path = session_state_path(app)?;
    let _ = SESSION_STATE_PATH.set(path.clone());
    install_panic_hook();

    if let Some(previous) = read_session_state(&path) {
        if previous.status == "running" {
            let _ = append_client_log_entry(
                app,
                "error",
                "lifecycle",
                "previous_session_unclean_exit",
                "previous session did not finish cleanly",
                Some(serde_json::json!({
                    "previousSessionId": previous.session_id,
                    "startedAt": previous.started_at,
                    "lastHeartbeatAt": previous.last_heartbeat_at,
                    "appVersion": previous.app_version,
                    "exitReason": previous.exit_reason,
                })),
            );
        }
    }

    let now = chrono_like_now();
    let record = SessionStateRecord {
        session_id: uuid::Uuid::new_v4().to_string(),
        status: "running".to_string(),
        started_at: now.clone(),
        last_heartbeat_at: now,
        exit_at: None,
        exit_reason: None,
        app_version: app.package_info().version.to_string(),
    };
    write_session_state(&path, &record)?;
    append_client_log_entry(
        app,
        "info",
        "lifecycle",
        "session_started",
        "session tracking started",
        Some(serde_json::json!({
            "sessionId": record.session_id,
            "appVersion": record.app_version,
        })),
    )?;

    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let _ = update_session_state(&app_handle, "running", None);
        }
    });
    Ok(())
}

fn request_app_exit(app: &AppHandle, reason: &str) {
    let _ = append_client_log_entry(
        app,
        "warn",
        "lifecycle",
        "app_exit_requested",
        "app exit requested",
        Some(serde_json::json!({ "reason": reason })),
    );
    let _ = update_session_state(app, "clean_exit", Some(reason));
    app.state::<TaskbarHost>().restore_taskbar();
    app.exit(0);
}

fn command_output_trimmed(program: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args);
    #[cfg(target_os = "windows")]
    {
        // Hide helper subprocess consoles during startup/runtime diagnostics.
        command.creation_flags(0x08000000);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(target_os = "windows")]
fn detect_windows_version() -> Option<String> {
    command_output_trimmed("cmd", &["/C", "ver"])
        .map(|text| text.replace('\r', "").replace('\n', " "))
}

#[cfg(not(target_os = "windows"))]
fn detect_windows_version() -> Option<String> {
    None
}

#[cfg(target_os = "windows")]
fn detect_webview2_runtime_version() -> Option<String> {
    let keys = [
        r#"HKLM\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"#,
        r#"HKLM\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"#,
        r#"HKCU\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"#,
    ];
    for key in keys {
        if let Some(output) = command_output_trimmed("reg", &["query", key, "/v", "pv"]) {
            for line in output.lines() {
                let trimmed = line.trim();
                if trimmed.starts_with("pv") {
                    let parts: Vec<&str> = trimmed.split_whitespace().collect();
                    if let Some(version) = parts.last() {
                        return Some((*version).to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "windows"))]
fn detect_webview2_runtime_version() -> Option<String> {
    None
}

fn runtime_metadata() -> &'static serde_json::Value {
    RUNTIME_METADATA.get_or_init(|| {
        serde_json::json!({
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "windows_version": detect_windows_version(),
            "webview2_runtime_version": detect_webview2_runtime_version(),
        })
    })
}

fn append_client_log_entry(
    app: &AppHandle,
    level: &str,
    module: &str,
    event: &str,
    message: &str,
    context: Option<serde_json::Value>,
) -> Result<(), String> {
    let path = log_file_path(app)?;
    let entry = serde_json::json!({
        "ts": chrono_like_now(),
        "level": level,
        "module": module,
        "event": event,
        "message": message,
        "context": context,
        "app_version": app.package_info().version.to_string(),
        "runtime": runtime_metadata(),
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    file.write_all(entry.to_string().as_bytes())
        .map_err(|e| e.to_string())?;
    file.write_all(b"\n").map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    trim_log_file(&path, CLIENT_LOG_MAX_BYTES)
}

fn trim_log_file(path: &PathBuf, max_bytes: usize) -> Result<(), String> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return Ok(()),
    };
    if meta.len() as usize <= max_bytes {
        return Ok(());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() <= max_bytes {
        return Ok(());
    }
    let start = buf.len().saturating_sub(max_bytes);
    let slice = &buf[start..];
    let aligned = match slice.iter().position(|b| *b == b'\n') {
        Some(pos) if pos + 1 < slice.len() => &slice[pos + 1..],
        _ => slice,
    };
    fs::write(path, aligned).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_or_create_client_identity(
    app: AppHandle,
    legacy_client_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = identity_path(&app)?;
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let mut identity: ClientIdentity =
            serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if identity.legacy_client_id.is_none()
            && legacy_client_id
                .as_deref()
                .map(|s| !s.trim().is_empty())
                .unwrap_or(false)
        {
            identity.legacy_client_id = legacy_client_id.filter(|s| !s.trim().is_empty());
            fs::write(
                &path,
                serde_json::to_vec_pretty(&identity).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
        }
        return Ok(serde_json::json!(identity));
    }

    let identity = ClientIdentity {
        install_id: uuid::Uuid::new_v4().to_string(),
        legacy_client_id: legacy_client_id.filter(|s| !s.trim().is_empty()),
        created_at: chrono_like_now(),
    };
    fs::write(
        &path,
        serde_json::to_vec_pretty(&identity).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(serde_json::json!(identity))
}

fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let dt = now as i64;
    let tm = time_from_unix(dt);
    tm
}

fn time_from_unix(secs: i64) -> String {
    use std::time::{Duration, UNIX_EPOCH};
    let st = UNIX_EPOCH + Duration::from_secs(secs as u64);
    let datetime: chrono_stub::DateTime = st.into();
    datetime.to_rfc3339()
}

mod chrono_stub {
    use std::time::{SystemTime, UNIX_EPOCH};

    pub struct DateTime(SystemTime);

    impl From<SystemTime> for DateTime {
        fn from(value: SystemTime) -> Self {
            Self(value)
        }
    }

    impl DateTime {
        pub fn to_rfc3339(&self) -> String {
            let secs = self
                .0
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let tm = time::OffsetDateTime::from_unix_timestamp(secs)
                .unwrap_or(time::OffsetDateTime::UNIX_EPOCH);
            tm.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
        }
    }
}

#[tauri::command]
fn append_client_log(
    app: AppHandle,
    level: String,
    module: String,
    event: String,
    message: String,
    context: Option<serde_json::Value>,
) -> Result<(), String> {
    append_client_log_entry(&app, &level, &module, &event, &message, context)
}

#[tauri::command]
fn get_recent_client_logs(app: AppHandle) -> Result<String, String> {
    let path = log_file_path(&app)?;
    if !path.exists() {
        return Ok(String::new());
    }
    let mut buf = fs::read(&path).map_err(|e| e.to_string())?;
    if buf.len() > CLIENT_LOG_EXPORT_BYTES {
        let start = buf.len().saturating_sub(CLIENT_LOG_EXPORT_BYTES);
        buf = buf[start..].to_vec();
        if let Some(pos) = buf.iter().position(|b| *b == b'\n') {
            if pos + 1 < buf.len() {
                buf = buf[pos + 1..].to_vec();
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

#[tauri::command]
fn open_bubble_devtools(app: AppHandle) {
    if let Some(window) = app.get_window("bubble") {
        window.open_devtools();
    }
}

/// 带 Cookie Jar 的预请求抓取，支持两阶段 Session 建立。
/// 流程：①访问 pre_url（HTML页面）→ ②第一次调 API（触发服务端创建 Java Session / 种下 JSESSIONID）
/// → ③若返回 JSON 直接用，否则等短暂延迟后 ④第二次调 API（此时 Cookie Jar 已有 JSESSIONID）。
/// 解决建行等需要 JSESSIONID 但依赖 JS 初始化的站点问题。
#[tauri::command]
async fn fetch_with_pre(
    pre_url: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<String, String> {
    use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
    use std::str::FromStr;

    let ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    let client = reqwest::Client::builder()
        .cookie_store(true)
        .timeout(std::time::Duration::from_secs(15))
        .danger_accept_invalid_certs(false)
        .build()
        .map_err(|e| e.to_string())?;

    // ① 访问公开页面，让服务端通过 HTTP Set-Cookie 初始化基础 Cookie
    let _ = client
        .get(&pre_url)
        .header("User-Agent", ua)
        .header(
            "Accept",
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await; // 忽略错误，继续尝试

    // 随机延迟，模拟用户停留页面
    let jitter = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis() as u64
        % 400;
    tokio::time::sleep(std::time::Duration::from_millis(300 + jitter)).await;

    // 构建 API 请求头
    let build_headers = |h: &std::collections::HashMap<String, String>| -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in h {
            if let (Ok(name), Ok(value)) = (HeaderName::from_str(k), HeaderValue::from_str(v)) {
                map.insert(name, value);
            }
        }
        map
    };

    // ② 第一次调 API：即使返回 HTML 登录页，服务端也会在响应头中 Set-Cookie JSESSIONID
    //    Cookie Jar 自动捕获，为第二次调用做准备
    let first_body = client
        .get(&url)
        .headers(build_headers(&headers))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    // 如果已经拿到 JSON（不以 '<' 开头），直接返回
    if !first_body.trim_start().starts_with('<') {
        return Ok(first_body);
    }

    // ③ 第一次返回 HTML（登录页），等待后用已积累的 Cookie（含 JSESSIONID）再试一次
    let jitter2 = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .subsec_millis() as u64
        % 300;
    tokio::time::sleep(std::time::Duration::from_millis(200 + jitter2)).await;

    let second_body = client
        .get(&url)
        .headers(build_headers(&headers))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    Ok(second_body)
}

#[tauri::command]
async fn cancel_download_update(app: AppHandle, download_id: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut active = state.active_download_id.lock().map_err(|e| e.to_string())?;
    if active.as_deref() == Some(download_id.as_str()) {
        *active = None;
    }
    Ok(())
}

fn is_download_active(app: &AppHandle, download_id: &str) -> bool {
    let state = app.state::<AppState>();
    state
        .active_download_id
        .lock()
        .map(|active| active.as_deref() == Some(download_id))
        .unwrap_or(false)
}

fn cleanup_update_downloads(keep_path: Option<&str>) {
    let temp_dir = std::env::temp_dir();
    let keep = keep_path.and_then(|path| std::fs::canonicalize(path).ok());
    let Ok(entries) = std::fs::read_dir(temp_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let is_goldprice_setup = name.starts_with("GoldPrice_") && name.ends_with("_x64-setup.exe");
        let is_goldprice_part = name.starts_with("GoldPrice_")
            && name.contains("_x64-setup.exe.")
            && name.ends_with(".download");
        if !is_goldprice_setup && !is_goldprice_part {
            continue;
        }
        if let Some(keep_path) = &keep {
            if std::fs::canonicalize(&path).ok().as_ref() == Some(keep_path) {
                continue;
            }
        }
        let _ = std::fs::remove_file(path);
    }
}

#[tauri::command]
async fn cleanup_update_downloads_cmd(keep_path: Option<String>) -> Result<(), String> {
    cleanup_update_downloads(keep_path.as_deref());
    Ok(())
}

#[tauri::command]
async fn download_update(
    app: AppHandle,
    url: String,
    filename: String,
    download_id: String,
) -> Result<String, String> {
    use futures_util::StreamExt;
    use tokio::time::{timeout, Duration};

    {
        let state = app.state::<AppState>();
        let mut active = state.active_download_id.lock().map_err(|e| e.to_string())?;
        *active = Some(download_id.clone());
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let _ = app.emit_all(
        "download-progress",
        serde_json::json!({
            "id": download_id,
            "downloaded": 0,
            "total": 0,
            "percent": 0,
            "phase": "connecting"
        }),
    );

    let resp = timeout(Duration::from_secs(25), client.get(&url).send())
        .await
        .map_err(|_| "连接下载服务器超时".to_string())?
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：服务器返回 HTTP {}", status.as_u16()));
    }

    let total = resp.content_length().unwrap_or(0);
    let mut downloaded: u64 = 0;
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join(&filename);
    let part_path = temp_dir.join(format!("{}.{}.download", filename, download_id));
    cleanup_update_downloads(None);
    let mut file = std::fs::File::create(&part_path).map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = timeout(Duration::from_secs(20), stream.next())
        .await
        .map_err(|_| "下载长时间无响应".to_string())?
    {
        if !is_download_active(&app, &download_id) {
            let _ = std::fs::remove_file(&part_path);
            return Err("下载已取消".to_string());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        downloaded += chunk.len() as u64;
        file.write_all(&chunk).map_err(|e| e.to_string())?;

        let percent = if total > 0 {
            (downloaded * 100 / total).min(99) // 写入完成前最多 99%
        } else {
            0
        };
        let _ = app.emit_all(
            "download-progress",
            serde_json::json!({
                "id": download_id,
                "downloaded": downloaded,
                "total": total,
                "percent": percent,
                "phase": "downloading"
            }),
        );
    }

    // 安装包最小应有 1 MB，防止把错误页当成安装包保存
    if downloaded < 1024 * 1024 {
        let _ = std::fs::remove_file(&part_path);
        return Err(format!(
            "下载内容异常（{}字节），可能不是有效安装包",
            downloaded
        ));
    }

    file.flush().map_err(|e| e.to_string())?;
    drop(file);

    if !is_download_active(&app, &download_id) {
        let _ = std::fs::remove_file(&part_path);
        return Err("下载已取消".to_string());
    }

    if file_path.exists() {
        let _ = std::fs::remove_file(&file_path);
    }
    std::fs::rename(&part_path, &file_path).map_err(|e| e.to_string())?;

    {
        let state = app.state::<AppState>();
        let mut active = state.active_download_id.lock().map_err(|e| e.to_string())?;
        if active.as_deref() == Some(download_id.as_str()) {
            *active = None;
        }
    }

    // 写入完成，推送 100%
    let _ = app.emit_all(
        "download-progress",
        serde_json::json!({
            "id": download_id,
            "downloaded": downloaded,
            "total": total.max(downloaded),
            "percent": 100,
            "phase": "done"
        }),
    );

    Ok(file_path.to_string_lossy().to_string())
}

/// WebSocket 数据源抓取：支持自定义请求头（含 Origin），可选发送订阅消息，
/// 返回第一条有效文本消息供 JS 侧用 JSONPath/Regex 提取数据。
#[tauri::command]
async fn fetch_ws(
    url: String,
    headers: std::collections::HashMap<String, String>,
    send_msg: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio::time::Duration;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::Message;

    let timeout = Duration::from_secs(timeout_secs.unwrap_or(15));

    // 构建带自定义请求头的 WS 握手请求
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|e| e.to_string())?;
    for (key, value) in &headers {
        if let (Ok(name), Ok(val)) = (
            tokio_tungstenite::tungstenite::http::header::HeaderName::from_bytes(key.as_bytes()),
            tokio_tungstenite::tungstenite::http::header::HeaderValue::from_str(value),
        ) {
            request.headers_mut().insert(name, val);
        }
    }

    let (ws_stream, _) = tokio::time::timeout(timeout, tokio_tungstenite::connect_async(request))
        .await
        .map_err(|_| "WebSocket connection timeout".to_string())?
        .map_err(|e| e.to_string())?;

    let (mut write, mut read) = ws_stream.split();

    // 发送订阅消息（如果配置了）
    if let Some(msg) = send_msg {
        write
            .send(Message::Text(msg))
            .await
            .map_err(|e| e.to_string())?;
    }

    // 等待第一条有效文本/二进制消息
    let result = tokio::time::timeout(timeout, async {
        while let Some(msg_result) = read.next().await {
            match msg_result {
                Ok(Message::Text(text)) if !text.trim().is_empty() => {
                    return Ok(text);
                }
                Ok(Message::Binary(data)) => {
                    return Ok(String::from_utf8_lossy(&data).to_string());
                }
                Ok(_) => continue, // Ping/Pong/Close 忽略
                Err(e) => return Err(e.to_string()),
            }
        }
        Err("WebSocket closed without data".to_string())
    })
    .await
    .map_err(|_| "WebSocket message timeout".to_string())?;

    result
}

// ========== 辅助函数 ==========

// WebView2 Runtime 144.x.x 回归 Bug：透明窗口会被重新画上系统标题栏
// 参考：https://github.com/MicrosoftEdge/WebView2Feedback/issues/5492
// 用替换 WNDPROC 方式拦截 WM_NCACTIVATE / WM_NCPAINT，阻止非客户区重绘
#[cfg(target_os = "windows")]
static ORIG_BUBBLE_PROC: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);

#[cfg(target_os = "windows")]
unsafe extern "system" fn bubble_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{
        CallWindowProcW, DefWindowProcW, WM_NCACTIVATE, WM_NCPAINT, WNDPROC,
    };
    match msg {
        WM_NCACTIVATE => LRESULT(1), // 阻止激活/失活时重绘标题栏
        WM_NCPAINT => LRESULT(0),    // 阻止非客户区绘制
        _ => {
            let orig = ORIG_BUBBLE_PROC.load(std::sync::atomic::Ordering::SeqCst);
            if orig != 0 {
                let orig_fn: WNDPROC = std::mem::transmute(orig);
                CallWindowProcW(orig_fn, hwnd, msg, wparam, lparam)
            } else {
                DefWindowProcW(hwnd, msg, wparam, lparam)
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn apply_frameless_style(window: &Window) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::*;
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            let hwnd = HWND(hwnd.0 as isize);

            // 移除标题栏/边框样式，保留 POPUP
            let style = GetWindowLongW(hwnd, GWL_STYLE) as u32;
            SetWindowLongW(
                hwnd,
                GWL_STYLE,
                ((style | WS_POPUP.0)
                    & !(WS_CAPTION.0
                        | WS_BORDER.0
                        | WS_DLGFRAME.0
                        | WS_THICKFRAME.0
                        | WS_SYSMENU.0)) as i32,
            );

            // 移除边框扩展样式，添加分层 + 不激活
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            SetWindowLongW(
                hwnd,
                GWL_EXSTYLE,
                ((ex & !(WS_EX_DLGMODALFRAME.0
                    | WS_EX_WINDOWEDGE.0
                    | WS_EX_CLIENTEDGE.0
                    | WS_EX_STATICEDGE.0))
                    | WS_EX_LAYERED.0
                    | WS_EX_NOACTIVATE.0) as i32,
            );

            // 替换窗口过程以拦截 WM_NCACTIVATE/WM_NCPAINT（只安装一次）
            if ORIG_BUBBLE_PROC.load(std::sync::atomic::Ordering::SeqCst) == 0 {
                let orig =
                    SetWindowLongPtrW(hwnd, GWLP_WNDPROC, bubble_wnd_proc as *const () as isize);
                if orig != 0 {
                    ORIG_BUBBLE_PROC.store(orig, std::sync::atomic::Ordering::SeqCst);
                }
            }

            let _ = SetWindowPos(
                hwnd,
                HWND(0),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOOWNERZORDER | SWP_NOZORDER,
            );
        }
    }
}

fn set_bubble_to_default_position(window: &Window) -> Result<(), String> {
    const MARGIN_RIGHT: f64 = 24.0;
    const BUBBLE_W: f64 = 220.0;
    const BUBBLE_H: f64 = 80.0;

    let (x, y) = if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();

        // 尝试通过 Win32 SPI_GETWORKAREA 获取排除任务栏的工作区域
        #[cfg(target_os = "windows")]
        let (work_right, work_bottom) = {
            use std::mem;
            use windows::Win32::Foundation::RECT;
            use windows::Win32::UI::WindowsAndMessaging::{SystemParametersInfoW, SPI_GETWORKAREA};
            let mut rc: RECT = unsafe { mem::zeroed() };
            let ok = unsafe {
                SystemParametersInfoW(
                    SPI_GETWORKAREA,
                    0,
                    Some(&mut rc as *mut _ as *mut _),
                    windows::Win32::UI::WindowsAndMessaging::SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
                )
                .is_ok()
            };
            if ok {
                (rc.right as i32, rc.bottom as i32)
            } else {
                (pos.x + size.width as i32, pos.y + size.height as i32)
            }
        };
        #[cfg(not(target_os = "windows"))]
        let (work_right, work_bottom) = (pos.x + size.width as i32, pos.y + size.height as i32);

        let margin_right_phys = (MARGIN_RIGHT * scale) as i32;
        let bubble_w_phys = (BUBBLE_W * scale) as i32;
        let bubble_h_phys = (BUBBLE_H * scale) as i32;
        let x = work_right - bubble_w_phys - margin_right_phys;
        let y = work_bottom - bubble_h_phys;
        (x.max(pos.x), y.max(pos.y))
    } else {
        (1660, 940)
    };

    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========== 系统托盘 ==========
fn tray_toggle_label(label: &str, enabled: bool) -> String {
    let dot = if enabled { "●" } else { "○" };
    format!("{}\t{}", label, dot)
}

fn create_tray_menu() -> SystemTray {
    let manager_item = CustomMenuItem::new("manager".to_string(), "管理界面");
    let bubble_item = CustomMenuItem::new(
        "bubble_toggle".to_string(),
        tray_toggle_label("行情显示", false),
    );
    let taskbar_item = CustomMenuItem::new(
        "taskbar_toggle".to_string(),
        tray_toggle_label("任务栏展示", false),
    );
    let reset_pos_item = CustomMenuItem::new("reset_position".to_string(), "重置浮窗位置");
    let auto_start_item = CustomMenuItem::new(
        "auto_start".to_string(),
        tray_toggle_label("开机自启", false),
    );
    let quit_item = CustomMenuItem::new("quit".to_string(), "退出");

    let tray_menu = SystemTrayMenu::new()
        .add_item(manager_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(bubble_item)
        .add_item(taskbar_item)
        .add_item(reset_pos_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(auto_start_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit_item);

    SystemTray::new().with_menu(tray_menu)
}

fn update_tray_menu(app: &AppHandle) {
    let state: tauri::State<AppState> = app.state();
    let display_status = app.state::<TaskbarHost>().status();
    let display_visible = display_status.user_visible;
    let auto_start_enabled = *state.auto_start_enabled.lock().unwrap();

    let manager_item = CustomMenuItem::new("manager".to_string(), "管理界面");
    let bubble_item = CustomMenuItem::new(
        "bubble_toggle".to_string(),
        tray_toggle_label("行情显示", display_visible),
    );
    let taskbar_item = CustomMenuItem::new(
        "taskbar_toggle".to_string(),
        tray_toggle_label(
            "任务栏展示",
            display_status.requested_mode == PriceDisplayMode::Taskbar,
        ),
    );
    let reset_pos_item = CustomMenuItem::new("reset_position".to_string(), "重置浮窗位置");
    let auto_start_item = CustomMenuItem::new(
        "auto_start".to_string(),
        tray_toggle_label("开机自启", auto_start_enabled),
    );
    let quit_item = CustomMenuItem::new("quit".to_string(), "退出");

    let mut tray_menu = SystemTrayMenu::new()
        .add_item(manager_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(bubble_item);
    tray_menu = tray_menu.add_item(taskbar_item);
    if display_status.requested_mode == PriceDisplayMode::Bubble {
        tray_menu = tray_menu.add_item(reset_pos_item);
    }
    let tray_menu = tray_menu
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(auto_start_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(quit_item);

    let tray = app.tray_handle();
    let _ = tray.set_menu(tray_menu);
}

fn handle_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            show_manager_from_tray(app);
        }
        SystemTrayEvent::MenuItemClick { id, .. } => {
            match id.as_str() {
                "manager" => {
                    show_manager_from_tray(app);
                }
                "bubble_toggle" => {
                    toggle_price_display(app);
                }
                "taskbar_toggle" => {
                    let host = app.state::<TaskbarHost>();
                    let mode = if host.status().requested_mode == PriceDisplayMode::Taskbar {
                        PriceDisplayMode::Bubble
                    } else {
                        PriceDisplayMode::Taskbar
                    };
                    host.set_mode(mode);
                    let _ = app.emit_all(
                        "price-display-mode-changed",
                        if mode == PriceDisplayMode::Taskbar {
                            "taskbar"
                        } else {
                            "bubble"
                        },
                    );
                    let _ = synchronize_price_display(app);
                }
                "refresh" => {
                    if let Some(window) = app.get_window("bubble") {
                        let _ = window.emit("bubble-refresh-now", ());
                    }
                }
                "reset_position" => {
                    if let Some(window) = app.get_window("bubble") {
                        // Reset to top-left corner
                        let _ = set_bubble_to_default_position(&window);
                    }
                }
                "auto_start" => {
                    // Toggle auto-start
                    use auto_launch::*;

                    let state: tauri::State<AppState> = app.state();
                    let mut auto_start_enabled = state.auto_start_enabled.lock().unwrap();

                    if let Ok(app_path) = std::env::current_exe() {
                        if let Ok(auto) = AutoLaunchBuilder::new()
                            .set_app_name("GoldPrice")
                            .set_app_path(&format!("\"{}\"", app_path.to_string_lossy()))
                            .build()
                        {
                            let new_state = !*auto_start_enabled;
                            let result = if new_state {
                                auto.enable()
                            } else {
                                auto.disable()
                            };

                            if result.is_ok() {
                                *auto_start_enabled = new_state;
                                drop(auto_start_enabled);
                                update_tray_menu(app);

                                // Notify manager window to update checkbox
                                if let Some(manager_window) = app.get_window("manager") {
                                    let _ = manager_window.emit("auto-start-changed", new_state);
                                }
                            }
                        }
                    }
                }
                "quit" => {
                    request_app_exit(app, "tray_quit");
                }
                _ => {}
            }
        }
        _ => {}
    }
}

fn show_manager_from_tray(app: &AppHandle) {
    let _ = tauri::async_runtime::block_on(open_manager(app.clone()));
}

fn toggle_price_display(app: &AppHandle) {
    let host = app.state::<TaskbarHost>();
    let visible = !host.status().user_visible;
    host.set_user_visible(visible);
    let _ = synchronize_price_display(app);
}

fn synchronize_price_display(app: &AppHandle) -> Result<(), String> {
    let status = app.state::<TaskbarHost>().status();
    let show_bubble = status.user_visible && status.actual_display == "bubble";
    if let Some(window) = app.get_window("bubble") {
        if show_bubble {
            let was_visible = window.is_visible().unwrap_or(false);
            constrain_bubble_to_work_area(&window)?;
            window.show().map_err(|e| e.to_string())?;
            #[cfg(target_os = "windows")]
            apply_frameless_style(&window);
            if !was_visible {
                let _ = window.emit(
                    "bubble-refresh-now",
                    serde_json::json!({ "reason": "display_mode_restored" }),
                );
            }
        } else {
            window.hide().map_err(|e| e.to_string())?;
        }
    }
    let state = app.state::<AppState>();
    *state.bubble_visible.lock().unwrap() = show_bubble;
    update_tray_menu(app);
    Ok(())
}

// ========== Main ==========
fn main() {
    let context = tauri::generate_context!();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 当用户尝试启动第二个实例时，将焦点放到已有的窗口上
            if let Some(window) = app.get_window("manager") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }))
        .setup(|app| {
            let app_handle_for_status = app.handle();
            let display_transition_generation = std::sync::Arc::new(AtomicU64::new(0));
            let status_callback: StatusCallback = std::sync::Arc::new(move |status| {
                let generation = display_transition_generation.fetch_add(1, Ordering::SeqCst) + 1;
                let app_for_dispatch = app_handle_for_status.clone();
                let status_for_log = status.clone();
                let _ = app_handle_for_status.run_on_main_thread(move || {
                    let _ = append_client_log_entry(
                        &app_for_dispatch,
                        if status_for_log.fallback_reason.is_some() {
                            "warn"
                        } else {
                            "info"
                        },
                        "taskbar_host",
                        "status_changed",
                        "taskbar display status changed",
                        serde_json::to_value(status_for_log).ok(),
                    );
                });

                let is_transient_taskbar_fallback = status.user_visible
                    && status.requested_mode == PriceDisplayMode::Taskbar
                    && status.actual_display == "bubble";
                if is_transient_taskbar_fallback {
                    let app_for_fallback = app_handle_for_status.clone();
                    let fallback_generation = display_transition_generation.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(1800)).await;
                        if fallback_generation.load(Ordering::SeqCst) != generation {
                            return;
                        }
                        let current = app_for_fallback.state::<TaskbarHost>().status();
                        if !current.user_visible
                            || current.requested_mode != PriceDisplayMode::Taskbar
                            || current.actual_display != "bubble"
                        {
                            return;
                        }
                        let app_for_sync = app_for_fallback.clone();
                        let _ = app_for_fallback.run_on_main_thread(move || {
                            let _ = synchronize_price_display(&app_for_sync);
                        });
                    });
                } else {
                    let app_for_sync = app_handle_for_status.clone();
                    let _ = app_handle_for_status.run_on_main_thread(move || {
                        let _ = synchronize_price_display(&app_for_sync);
                    });
                }
            });
            app.manage(TaskbarHost::new());
            app.state::<TaskbarHost>()
                .start(app.handle(), status_callback);
            let app_handle_for_taskbar_init = app.handle();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(750)).await;
                let status = app_handle_for_taskbar_init.state::<TaskbarHost>().status();
                let _ = append_client_log_entry(
                    &app_handle_for_taskbar_init,
                    if status.supported { "info" } else { "warn" },
                    "taskbar_host",
                    "initialized",
                    "taskbar display host initialized",
                    serde_json::to_value(status).ok(),
                );
            });

            // Setup windows with shadows
            if let Some(window) = app.get_window("manager") {
                #[cfg(target_os = "windows")]
                let _ = set_shadow(&window, true);
            }

            // Setup bubble window
            if let Some(window) = app.get_window("bubble") {
                let _ = window.hide();
                let _ = window.set_decorations(false);

                #[cfg(target_os = "windows")]
                {
                    let _ = set_shadow(&window, false);
                    apply_frameless_style(&window);

                    let win_ev = window.clone();
                    let app_handle_for_close = app.handle();
                    window.on_window_event(move |event| match event {
                        tauri::WindowEvent::Focused(true) => {
                            apply_frameless_style(&win_ev);
                        }
                        tauri::WindowEvent::Moved(_) => {
                            apply_frameless_style(&win_ev);
                            let _ = constrain_bubble_to_work_area(&win_ev);
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            api.prevent_close();
                            let _ = win_ev.hide();
                            let state: tauri::State<AppState> = app_handle_for_close.state();
                            *state.bubble_visible.lock().unwrap() = false;
                            update_tray_menu(&app_handle_for_close);
                            let _ = append_client_log_entry(
                                &app_handle_for_close,
                                "warn",
                                "window",
                                "bubble_close_intercepted",
                                "bubble close request intercepted and hidden instead",
                                None,
                            );
                        }
                        tauri::WindowEvent::Destroyed => {
                            let _ = append_client_log_entry(
                                &app_handle_for_close,
                                "error",
                                "window",
                                "bubble_window_destroyed",
                                "bubble window was destroyed",
                                None,
                            );
                        }
                        _ => {}
                    });
                }

                let _ = window.set_always_on_top(true);

                let app_handle = app.handle();
                if let Ok(Some((x, y))) =
                    tauri::async_runtime::block_on(load_bubble_position(app_handle))
                {
                    // 检查保存的位置是否仍在某个显示器范围内，防止切换/缩放后气泡飞出屏幕
                    let in_bounds = window
                        .available_monitors()
                        .ok()
                        .map(|monitors| {
                            monitors.iter().any(|m| {
                                let pos = m.position();
                                let size = m.size();
                                x >= pos.x
                                    && x < pos.x + size.width as i32
                                    && y >= pos.y
                                    && y < pos.y + size.height as i32
                            })
                        })
                        .unwrap_or(false);
                    if in_bounds {
                        let _ = window.set_position(PhysicalPosition::new(x, y));
                        let _ = constrain_bubble_to_work_area(&window);
                        let _ = append_client_log_entry(
                            &app.handle(),
                            "info",
                            "window",
                            "bubble_position_restored",
                            "restored saved bubble position",
                            Some(serde_json::json!({ "x": x, "y": y })),
                        );
                    } else {
                        let _ = set_bubble_to_default_position(&window);
                        let _ = append_client_log_entry(
                            &app.handle(),
                            "warn",
                            "window",
                            "bubble_position_out_of_bounds",
                            "saved bubble position was out of bounds; reset to default",
                            Some(serde_json::json!({ "x": x, "y": y })),
                        );
                    }
                } else {
                    let _ = set_bubble_to_default_position(&window);
                    let _ = append_client_log_entry(
                        &app.handle(),
                        "info",
                        "window",
                        "bubble_position_defaulted",
                        "no saved bubble position found; using default position",
                        None,
                    );
                }

                // 气泡窗口不在此处 show：等 JS 第一次数据就绪后再通过 show_bubble 命令显示，
                // 避免空白气泡在数据加载前出现。bubble_visible 保持 false，
                // tray 菜单也会正确反映"浮窗隐藏"状态。
                #[cfg(target_os = "windows")]
                {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    apply_frameless_style(&window);
                }
            }

            // Setup manager window
            if let Some(window) = app.get_window("manager") {
                // 关闭改为隐藏
                let app_handle_for_manager = app.handle();
                let window_clone = window.clone();
                window.on_window_event(move |event| match event {
                    tauri::WindowEvent::ScaleFactorChanged { .. } => {
                        let fit_app = app_handle_for_manager.clone();
                        tauri::async_runtime::spawn(async move {
                            tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                            let _ = fit_manager_window(fit_app).await;
                        });
                    }
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                    tauri::WindowEvent::Destroyed => {
                        let _ = append_client_log_entry(
                            &app_handle_for_manager,
                            "error",
                            "window",
                            "manager_window_destroyed",
                            "manager window was destroyed",
                            None,
                        );
                    }
                    _ => {}
                });

                // 只有第一次安装/启动才主动打开管理界面
                let is_first_launch = app
                    .path_resolver()
                    .app_data_dir()
                    .map(|dir| {
                        let flag = dir.join(".launched");
                        if !flag.exists() {
                            std::fs::create_dir_all(&dir).ok();
                            std::fs::write(&flag, "").ok();
                            true
                        } else {
                            false
                        }
                    })
                    .unwrap_or(true);

                if cfg!(debug_assertions) || is_first_launch {
                    let _ = window.show();
                    let _ = window.set_focus();
                    fix_window_dpi(&window);
                    let win_delay = window.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(600));
                        let _ = win_delay.show();
                        let _ = win_delay.set_focus();
                        fix_window_dpi(&win_delay);
                    });
                }
                // 非首次启动：管理界面隐藏，通过托盘菜单打开
            }

            // 检查实际的开机自启状态并更新
            let state: tauri::State<AppState> = app.state();
            if let Ok(app_path) = std::env::current_exe() {
                if let Ok(auto) = auto_launch::AutoLaunchBuilder::new()
                    .set_app_name("GoldPrice")
                    .set_app_path(&format!("\"{}\"", app_path.to_string_lossy()))
                    .build()
                {
                    if let Ok(is_enabled) = auto.is_enabled() {
                        *state.auto_start_enabled.lock().unwrap() = is_enabled;
                    }
                }
            }

            // 更新托盘菜单以反映当前状态
            update_tray_menu(&app.handle());
            initialize_session_tracking(&app.handle())?;
            Ok(())
        })
        .manage(AppState {
            bubble_visible: Mutex::new(false),
            auto_start_enabled: Mutex::new(false),
            active_download_id: Mutex::new(None),
        })
        .system_tray(create_tray_menu())
        .on_system_tray_event(handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            open_manager,
            fix_manager_dpi,
            fit_manager_window,
            hide_bubble,
            show_bubble,
            set_price_display_mode,
            update_taskbar_display,
            get_taskbar_display_status,
            resize_bubble,
            set_bubble_size,
            open_devtools,
            get_bubble_position,
            move_bubble,
            save_bubble_position,
            load_bubble_position,
            show_bubble_context_menu,
            set_auto_start,
            get_auto_start_status,
            clear_all_data_and_quit,
            quit_app,
            notify_bubble,
            refresh_bubble,
            get_app_version,
            get_or_create_client_identity,
            append_client_log,
            get_recent_client_logs,
            download_update,
            cancel_download_update,
            cleanup_update_downloads_cmd,
            fetch_with_pre,
            fetch_ws,
            open_bubble_devtools,
        ])
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::ExitRequested { api, .. } => {
                api.prevent_exit();
                let _ = append_client_log_entry(
                    app,
                    "info",
                    "lifecycle",
                    "automatic_exit_prevented",
                    "automatic event-loop exit prevented for tray-resident app",
                    None,
                );
            }
            tauri::RunEvent::Exit => {
                let _ = append_client_log_entry(
                    app,
                    "error",
                    "lifecycle",
                    "event_loop_exited",
                    "tauri event loop exited directly",
                    None,
                );
            }
            _ => {}
        });
}
