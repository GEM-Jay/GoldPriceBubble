#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{
    AppHandle, CustomMenuItem, Manager, PhysicalPosition, LogicalSize, SystemTray,
    SystemTrayEvent, SystemTrayMenu, SystemTrayMenuItem, Window,
};
use window_shadows::set_shadow;

// ========== 状态管理 ==========
struct AppState {
    bubble_visible: Mutex<bool>,
    auto_start_enabled: Mutex<bool>,
}

// ========== Tauri Commands ==========

#[tauri::command]
async fn open_manager(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("manager") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        
        // 强制窗口显示在前面
        window.set_always_on_top(true).map_err(|e| e.to_string())?;
        window.set_always_on_top(false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn hide_bubble(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        window.hide().map_err(|e| e.to_string())?;
        let state: tauri::State<AppState> = app.state();
        *state.bubble_visible.lock().unwrap() = false;
        update_tray_menu(&app);
    }
    Ok(())
}

#[tauri::command]
async fn show_bubble(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        window.show().map_err(|e| e.to_string())?;
        let state: tauri::State<AppState> = app.state();
        *state.bubble_visible.lock().unwrap() = true;
        update_tray_menu(&app);
    }
    Ok(())
}

#[tauri::command]
async fn resize_bubble(app: AppHandle, font_size: i32, rows: i32, content_width: Option<i32>, dpi_scale: Option<f64>) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
        // 基础配置
        let base_font_size = 12.0;
        let font_size_f = font_size as f64;
        let font_ratio = font_size_f / base_font_size;
        
        // 获取DPI缩放因子（优先使用前端传来的，否则获取窗口的）
        let scale = dpi_scale.unwrap_or_else(|| window.scale_factor().unwrap_or(1.0));
        
        // 使用前端传来的内容宽度，或使用默认计算
        let width = if let Some(w) = content_width {
            // 使用前端计算的宽度，添加一些余量
            let calculated = (w as f64 * 1.15).ceil(); // 增加15%余量
            calculated
        } else {
            // 回退到基础计算（如果前端没传宽度）
            let base_width = 220.0;
            let width_per_font = 10.0;
            base_width + (font_size_f - base_font_size) * width_per_font
        };
        
        // 计算高度：更精确的计算
        let header_height = 38.0; // header + border-bottom
        let padding_vertical = 24.0; // 上下 padding (12px * 2)
        
        // 每行的实际高度（包含字体大小和行间距）
        let base_line_height = 18.0; // 基础行高
        let line_height = base_line_height * font_ratio;
        let line_spacing = 6.0; // 行间距（gap）
        
        // 考虑分隔线的高度（如果有盈亏显示）
        let separator_height = if rows > 0 { 17.0 } else { 0.0 }; // 分隔线 + margin
        
        // 总行数不超过8行，确保不会过高
        let valid_rows = rows.max(1).min(8);
        
        // 内容区高度 = (行高 + 间距) × 行数 + 分隔线高度
        let content_height = (line_height + line_spacing) * valid_rows as f64 + separator_height;
        
        // 总高度 = header + padding + 内容 + 底部余量
        let total_height = header_height + padding_vertical + content_height + 4.0;
        
        // 获取屏幕可用高度，考虑 DPI 缩放
        let max_height = if let Ok(Some(monitor)) = window.current_monitor() {
            // 将物理像素转换为逻辑像素
            let logical_height = monitor.size().height as f64 / scale;
            // 限制为屏幕逻辑高度的75%，为任务栏留出空间
            let max_h = (logical_height * 0.75).floor();
            max_h
        } else {
            500.0 // 默认最大高度
        };
        
        // 高度范围：100px ~ min(700px, 屏幕逻辑高度的75%)
        let height = total_height.ceil().max(100.0).min(max_height.min(700.0));
        
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|e| {
                e.to_string()
            })?;
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
    }
    Ok(())
}

#[tauri::command]
async fn save_bubble_position(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("bubble") {
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
        let config: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        
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
    app.exit(0);
    Ok(())
}

#[tauri::command]
async fn set_auto_start(app: AppHandle, enabled: bool) -> Result<(), String> {
    use auto_launch::*;
    
    let app_name = "GoldPrice";
    let app_path = std::env::current_exe().map_err(|e| e.to_string())?;
    
    let auto = AutoLaunchBuilder::new()
        .set_app_name(app_name)
        .set_app_path(&app_path.to_string_lossy())
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
        .set_app_path(&app_path.to_string_lossy())
        .build()
        .map_err(|e| e.to_string())?;
    
    auto.is_enabled().map_err(|e| e.to_string())
}

#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    app.exit(0);
    Ok(())
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

// ========== 辅助函数 ==========
fn set_bubble_to_default_position(window: &Window) -> Result<(), String> {
    // Position at top-left corner with 20px margin
    let x = 20;
    let y = 20;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ========== 系统托盘 ==========
fn create_tray_menu() -> SystemTray {
    let manager_item = CustomMenuItem::new("manager".to_string(), "显示管理界面");
    let bubble_item = CustomMenuItem::new("bubble_toggle".to_string(), "浮窗显示");
    let reset_pos_item = CustomMenuItem::new("reset_position".to_string(), "重置浮窗位置");
    let auto_start_item = CustomMenuItem::new("auto_start".to_string(), "开机自启");
    let quit_item = CustomMenuItem::new("quit".to_string(), "退出");

    let tray_menu = SystemTrayMenu::new()
        .add_item(manager_item)
        .add_item(bubble_item)
        .add_item(reset_pos_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(auto_start_item)
        .add_item(quit_item);

    SystemTray::new().with_menu(tray_menu)
}

fn update_tray_menu(app: &AppHandle) {
    let state: tauri::State<AppState> = app.state();
    let bubble_visible = *state.bubble_visible.lock().unwrap();
    let auto_start_enabled = *state.auto_start_enabled.lock().unwrap();
    
    let manager_item = CustomMenuItem::new("manager".to_string(), "显示管理界面");
    let bubble_text = if bubble_visible { "✓ 浮窗显示" } else { "浮窗显示" };
    let bubble_item = CustomMenuItem::new("bubble_toggle".to_string(), bubble_text);
    let reset_pos_item = CustomMenuItem::new("reset_position".to_string(), "重置浮窗位置");
    let auto_start_text = if auto_start_enabled { "✓ 开机自启" } else { "开机自启" };
    let auto_start_item = CustomMenuItem::new("auto_start".to_string(), auto_start_text);
    let quit_item = CustomMenuItem::new("quit".to_string(), "退出");

    let tray_menu = SystemTrayMenu::new()
        .add_item(manager_item)
        .add_item(bubble_item)
        .add_item(reset_pos_item)
        .add_native_item(SystemTrayMenuItem::Separator)
        .add_item(auto_start_item)
        .add_item(quit_item);

    let tray = app.tray_handle();
    let _ = tray.set_menu(tray_menu);
}

fn handle_tray_event(app: &AppHandle, event: SystemTrayEvent) {
    match event {
        SystemTrayEvent::LeftClick { .. } => {
            // Toggle bubble window
            if let Some(window) = app.get_window("bubble") {
                let state: tauri::State<AppState> = app.state();
                let mut bubble_visible = state.bubble_visible.lock().unwrap();
                
                if *bubble_visible {
                    let _ = window.hide();
                    *bubble_visible = false;
                } else {
                    let _ = window.show();
                    *bubble_visible = true;
                }
                drop(bubble_visible);
                update_tray_menu(app);
            }
        }
        SystemTrayEvent::MenuItemClick { id, .. } => {
            match id.as_str() {
                "manager" => {
                    if let Some(window) = app.get_window("manager") {
                        // 确保窗口显示出来
                        let _ = window.unminimize();
                        let _ = window.show();
                        let _ = window.set_focus();
                        let _ = window.set_always_on_top(true);
                        let _ = window.set_always_on_top(false);
                        
                        // 尝试将窗口置顶
                        #[cfg(target_os = "windows")]
                        {
                            let _ = window.set_focus();
                        }
                    }
                }
                "bubble_toggle" => {
                    if let Some(window) = app.get_window("bubble") {
                        let state: tauri::State<AppState> = app.state();
                        let mut bubble_visible = state.bubble_visible.lock().unwrap();
                        
                        if *bubble_visible {
                            let _ = window.hide();
                            *bubble_visible = false;
                        } else {
                            let _ = window.show();
                            *bubble_visible = true;
                        }
                        drop(bubble_visible);
                        update_tray_menu(app);
                    }
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
                            .set_app_path(&app_path.to_string_lossy())
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
                    app.exit(0);
                }
                _ => {}
            }
        }
        _ => {}
    }
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
            // Setup windows with shadows
            if let Some(window) = app.get_window("manager") {
                #[cfg(target_os = "windows")]
                let _ = set_shadow(&window, true);
            }
            
            // Setup bubble window
            if let Some(window) = app.get_window("bubble") {
                // Load saved position or use default top-left
                let app_handle = app.handle();
                if let Ok(Some((x, y))) = tauri::async_runtime::block_on(load_bubble_position(app_handle)) {
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                } else {
                    // Default position: top-left corner
                    let _ = set_bubble_to_default_position(&window);
                }
                
                // Always show bubble window on startup
                let _ = window.show();
                let state: tauri::State<AppState> = app.state();
                *state.bubble_visible.lock().unwrap() = true;
            }
            
            // Setup manager window 并在启动时显示
            if let Some(window) = app.get_window("manager") {
                // 监听管理窗口关闭事件，改为隐藏而不是关闭
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // 阻止默认关闭行为
                        api.prevent_close();
                        // 隐藏窗口而不是关闭
                        let _ = window_clone.hide();
                    }
                });
                
                // 启动时显示管理窗口
                let _ = window.show();
                let _ = window.set_focus();
            }
            
            // 检查实际的开机自启状态并更新
            let state: tauri::State<AppState> = app.state();
            if let Ok(app_path) = std::env::current_exe() {
                if let Ok(auto) = auto_launch::AutoLaunchBuilder::new()
                    .set_app_name("GoldPrice")
                    .set_app_path(&app_path.to_string_lossy())
                    .build()
                {
                    if let Ok(is_enabled) = auto.is_enabled() {
                        *state.auto_start_enabled.lock().unwrap() = is_enabled;
                    }
                }
            }
            
            // 更新托盘菜单以反映当前状态
            update_tray_menu(&app.handle());
            
            Ok(())
        })
        .manage(AppState {
            bubble_visible: Mutex::new(true),
            auto_start_enabled: Mutex::new(false),
        })
        .system_tray(create_tray_menu())
        .on_system_tray_event(handle_tray_event)
        .invoke_handler(tauri::generate_handler![
            open_manager,
            hide_bubble,
            show_bubble,
            resize_bubble,
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
        ])
        .run(context)
        .expect("error while running tauri application");
}

