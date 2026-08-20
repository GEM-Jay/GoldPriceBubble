use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PriceDisplayMode {
    Bubble,
    Taskbar,
}

impl PriceDisplayMode {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "bubble" => Ok(Self::Bubble),
            "taskbar" => Ok(Self::Taskbar),
            _ => Err("price display mode must be bubble or taskbar".to_string()),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarDisplayItem {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub value: String,
    pub tone: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarDisplayPayload {
    pub ts: u64,
    pub online: bool,
    pub items: Vec<TaskbarDisplayItem>,
    #[serde(default)]
    pub hide_labels: bool,
    #[serde(default = "default_placement")]
    pub placement: String,
}

fn default_placement() -> String {
    "right".to_string()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskbarDisplayStatus {
    pub supported: bool,
    pub requested_mode: PriceDisplayMode,
    pub actual_display: String,
    pub attached: bool,
    pub fallback_reason: Option<String>,
    pub user_visible: bool,
}

impl Default for TaskbarDisplayStatus {
    fn default() -> Self {
        Self {
            supported: false,
            requested_mode: PriceDisplayMode::Bubble,
            actual_display: "hidden".to_string(),
            attached: false,
            fallback_reason: Some("unsupported_shell".to_string()),
            user_visible: false,
        }
    }
}

struct SharedState {
    requested_mode: PriceDisplayMode,
    user_visible: bool,
    payload: TaskbarDisplayPayload,
    status: TaskbarDisplayStatus,
}

pub struct TaskbarHost {
    shared: Arc<Mutex<SharedState>>,
    wake_hwnd: Arc<Mutex<isize>>,
}

pub type StatusCallback = Arc<dyn Fn(TaskbarDisplayStatus) + Send + Sync>;

impl TaskbarHost {
    pub fn new() -> Self {
        let shared = Arc::new(Mutex::new(SharedState {
            requested_mode: PriceDisplayMode::Bubble,
            user_visible: false,
            payload: TaskbarDisplayPayload::default(),
            status: TaskbarDisplayStatus::default(),
        }));
        let wake_hwnd = Arc::new(Mutex::new(0));
        Self { shared, wake_hwnd }
    }

    pub fn start(&self, app: AppHandle, status_callback: StatusCallback) {
        #[cfg(target_os = "windows")]
        {
            let thread_shared = self.shared.clone();
            let thread_hwnd = self.wake_hwnd.clone();
            std::thread::Builder::new()
                .name("goldprice-taskbar-host".to_string())
                .spawn(move || windows_host::run(app, thread_shared, thread_hwnd, status_callback))
                .expect("failed to start taskbar host thread");
        }

        #[cfg(not(target_os = "windows"))]
        {
            let mut guard = self.shared.lock().unwrap();
            guard.status.fallback_reason = Some("unsupported_os".to_string());
            status_callback(guard.status.clone());
            let _ = app.emit_all("taskbar-display-status", guard.status.clone());
        }
    }

    pub fn set_mode(&self, mode: PriceDisplayMode) {
        self.shared.lock().unwrap().requested_mode = mode;
        self.wake();
    }

    pub fn set_user_visible(&self, visible: bool) {
        self.shared.lock().unwrap().user_visible = visible;
        self.wake();
    }

    pub fn update(&self, payload: TaskbarDisplayPayload) {
        self.shared.lock().unwrap().payload = payload;
        self.wake();
    }

    pub fn status(&self) -> TaskbarDisplayStatus {
        self.shared.lock().unwrap().status.clone()
    }

    pub fn restore_taskbar(&self) {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{
                SendMessageTimeoutW, SMTO_ABORTIFHUNG, SMTO_BLOCK,
            };
            let hwnd = *self.wake_hwnd.lock().unwrap();
            if hwnd != 0 {
                let _ = SendMessageTimeoutW(
                    HWND(hwnd),
                    windows_host::WM_RESTORE_TASKBAR,
                    WPARAM(0),
                    LPARAM(0),
                    SMTO_ABORTIFHUNG | SMTO_BLOCK,
                    1000,
                    None,
                );
            }
        }
    }

    fn wake(&self) {
        #[cfg(target_os = "windows")]
        unsafe {
            use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::PostMessageW;
            let hwnd = *self.wake_hwnd.lock().unwrap();
            if hwnd != 0 {
                let _ = PostMessageW(HWND(hwnd), windows_host::WM_RECONCILE, WPARAM(0), LPARAM(0));
            }
        }
    }
}

pub(crate) fn dip_to_px(dip: i32, dpi: u32) -> i32 {
    ((dip as i64 * dpi.max(96) as i64 + 48) / 96) as i32
}

pub(crate) fn taskbar_font_height(dpi: u32) -> i32 {
    -((9_i64 * dpi.max(96) as i64 + 36) / 72) as i32
}

pub(crate) fn safe_region_width(task_list_right: i32, tray_left: i32, margin: i32) -> i32 {
    (tray_left - task_list_right - margin.saturating_mul(2)).max(0)
}

pub(crate) fn modern_left_position(
    taskbar_left: i32,
    task_list_left: i32,
    ticker_width: i32,
    margin: i32,
    widgets_reserve: i32,
) -> Option<i32> {
    let x = taskbar_left + widgets_reserve + margin;
    (x + ticker_width + margin <= task_list_left).then_some(x - taskbar_left)
}

pub(crate) fn win11_widgets_reserve_dip(widgets_enabled: bool) -> i32 {
    if widgets_enabled {
        180
    } else {
        0
    }
}

pub(crate) fn classic_horizontal_layout(
    original_x: i32,
    original_width: i32,
    ticker_width: i32,
    gap: i32,
    minimum_task_width: i32,
    ticker_on_left: bool,
) -> Option<(i32, i32, i32)> {
    let task_width = original_width - ticker_width - gap;
    if task_width < minimum_task_width {
        return None;
    }
    if ticker_on_left {
        Some((original_x + ticker_width + gap, task_width, original_x))
    } else {
        Some((original_x, task_width, original_x + task_width + gap))
    }
}

#[cfg(test)]
pub(crate) fn resolved_display(
    mode: PriceDisplayMode,
    user_visible: bool,
    taskbar_attached: bool,
) -> &'static str {
    if !user_visible {
        "hidden"
    } else if mode == PriceDisplayMode::Taskbar && taskbar_attached {
        "taskbar"
    } else {
        "bubble"
    }
}

#[cfg(target_os = "windows")]
mod windows_host {
    use super::*;
    use std::ffi::c_void;
    use std::mem;
    use std::time::{Duration, Instant};
    use windows::core::{w, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        BOOL, COLORREF, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
    };
    use windows::Win32::Graphics::Gdi::*;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
    use windows::Win32::UI::Controls::{
        TOOLTIPS_CLASSW, TTF_IDISHWND, TTF_SUBCLASS, TTM_ADDTOOLW, TTM_SETMAXTIPWIDTH,
        TTM_UPDATETIPTEXTW, TTS_ALWAYSTIP, TTS_NOPREFIX, TTTOOLINFOW,
    };
    use windows::Win32::UI::HiDpi::GetDpiForWindow;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetCapture, ReleaseCapture, SetCapture};
    use windows::Win32::UI::WindowsAndMessaging::*;

    pub const WM_RECONCILE: u32 = WM_APP + 41;
    pub const WM_RESTORE_TASKBAR: u32 = WM_APP + 42;
    const TIMER_GEOMETRY: usize = 1;
    const TIMER_CAROUSEL: usize = 2;
    const TIMER_ANIMATION: usize = 3;
    const PAGE_SIZE: usize = 4;
    const CAROUSEL_INTERVAL_MS: u32 = 8000;
    const SLIDE_DURATION: Duration = Duration::from_millis(220);
    const MODERN_OVERLAP_GRACE: Duration = Duration::from_secs(5);
    const MENU_DISABLE_TASKBAR: usize = 1;
    const MENU_HIDE_LABELS: usize = 2;
    const MIN_SAFE_DIP: i32 = 72;
    const MAX_TICKER_DIP: i32 = 420;
    const MIN_TASK_LIST_DIP: i32 = 240;

    #[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
    struct Geometry {
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        dpi: u32,
    }

    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    struct ClassicReservation {
        taskbar: HWND,
        rebar: HWND,
        task_list: HWND,
        original: Geometry,
        target: Geometry,
        ticker: Geometry,
    }

    #[derive(Clone, Copy)]
    struct TaskbarLayout {
        parent: HWND,
        geometry: Geometry,
        classic: Option<ClassicReservation>,
    }

    struct ThreadContext {
        app: AppHandle,
        shared: Arc<Mutex<SharedState>>,
        ticker: HWND,
        control: HWND,
        tooltip: HWND,
        tooltip_registered: bool,
        tooltip_text: Vec<u16>,
        geometry: Option<Geometry>,
        active_placement: String,
        page_index: usize,
        animation: Option<PageAnimation>,
        suppress_next_button_up: bool,
        last_paint_request: Instant,
        paint_count: u64,
        first_attach_failure: Option<Instant>,
        modern_overlap_since: Option<Instant>,
        classic_reservation: Option<ClassicReservation>,
        taskbar_created: u32,
        status_callback: StatusCallback,
    }

    #[derive(Clone, Copy)]
    struct PageAnimation {
        from: usize,
        to: usize,
        started: Instant,
    }

    pub fn run(
        app: AppHandle,
        shared: Arc<Mutex<SharedState>>,
        wake_hwnd: Arc<Mutex<isize>>,
        status_callback: StatusCallback,
    ) {
        unsafe {
            let module = match GetModuleHandleW(None) {
                Ok(value) => HINSTANCE(value.0),
                Err(_) => return,
            };
            let mut context = Box::new(ThreadContext {
                app,
                shared,
                ticker: HWND(0),
                control: HWND(0),
                tooltip: HWND(0),
                tooltip_registered: false,
                tooltip_text: vec![0],
                geometry: None,
                active_placement: "right".to_string(),
                page_index: 0,
                animation: None,
                suppress_next_button_up: false,
                last_paint_request: Instant::now() - Duration::from_secs(1),
                paint_count: 0,
                first_attach_failure: None,
                modern_overlap_since: None,
                classic_reservation: None,
                taskbar_created: RegisterWindowMessageW(w!("TaskbarCreated")),
                status_callback,
            });
            let context_ptr = (&mut *context) as *mut ThreadContext as *const c_void;

            let control_class = w!("GoldPriceTaskbarControl");
            let ticker_class = w!("GoldPriceTaskbarTicker");
            let control_wc = WNDCLASSW {
                lpfnWndProc: Some(control_proc),
                hInstance: module,
                lpszClassName: control_class,
                ..Default::default()
            };
            let ticker_wc = WNDCLASSW {
                style: CS_DBLCLKS,
                lpfnWndProc: Some(ticker_proc),
                hInstance: module,
                hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                lpszClassName: ticker_class,
                ..Default::default()
            };
            if RegisterClassW(&control_wc) == 0 || RegisterClassW(&ticker_wc) == 0 {
                publish_unavailable(&mut context, "attach_failed");
                return;
            }

            let control = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
                control_class,
                w!("GoldPrice taskbar controller"),
                WS_POPUP,
                0,
                0,
                0,
                0,
                HWND(0),
                None,
                module,
                Some(context_ptr),
            );
            if control.0 == 0 {
                publish_unavailable(&mut context, "attach_failed");
                return;
            }
            context.control = control;
            *wake_hwnd.lock().unwrap() = control.0;
            // Do not touch Explorer during startup. Reconciliation in bubble mode
            // must be observational only; taskbar layout changes are allowed only
            // after the user explicitly selects taskbar mode.
            let _ = SetTimer(control, TIMER_GEOMETRY, 1000, None);
            let _ = SetTimer(control, TIMER_CAROUSEL, CAROUSEL_INTERVAL_MS, None);
            reconcile(&mut context, true);

            let mut message = MSG::default();
            while GetMessageW(&mut message, HWND(0), 0, 0).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            *wake_hwnd.lock().unwrap() = 0;
            restore_classic_reservation(&mut context);
            if context.ticker.0 != 0 {
                let _ = DestroyWindow(context.ticker);
            }
            if context.tooltip.0 != 0 {
                let _ = DestroyWindow(context.tooltip);
            }
            let _ = DestroyWindow(control);
        }
    }

    unsafe extern "system" fn control_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ThreadContext;
        if !ptr.is_null() {
            let context = &mut *ptr;
            if msg == context.taskbar_created {
                context.first_attach_failure = Some(Instant::now());
                detach(context);
                reconcile(context, true);
                return LRESULT(0);
            }
            match msg {
                WM_RESTORE_TASKBAR => {
                    let _ = restore_classic_reservation(context);
                    if context.ticker.0 != 0 {
                        let _ = ShowWindow(context.ticker, SW_HIDE);
                    }
                    return LRESULT(0);
                }
                WM_RECONCILE => {
                    reconcile(context, false);
                    return LRESULT(0);
                }
                WM_TIMER => {
                    match wparam.0 {
                        TIMER_GEOMETRY => reconcile(context, false),
                        TIMER_CAROUSEL => advance_page(context, false),
                        TIMER_ANIMATION => update_page_animation(context),
                        _ => {}
                    }
                    return LRESULT(0);
                }
                _ => {}
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe extern "system" fn ticker_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        if msg == WM_NCCREATE {
            let create = &*(lparam.0 as *const CREATESTRUCTW);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, create.lpCreateParams as isize);
        }
        let ptr = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ThreadContext;
        if !ptr.is_null() {
            let context = &mut *ptr;
            match msg {
                WM_ERASEBKGND => return LRESULT(1),
                WM_PAINT => {
                    paint(context, hwnd);
                    return LRESULT(0);
                }
                WM_NCHITTEST => return LRESULT(HTCLIENT as isize),
                WM_LBUTTONDOWN | WM_RBUTTONDOWN => {
                    let _ = SetCapture(hwnd);
                    return LRESULT(0);
                }
                WM_LBUTTONUP => {
                    if GetCapture() == hwnd {
                        let _ = ReleaseCapture();
                    }
                    if context.suppress_next_button_up {
                        context.suppress_next_button_up = false;
                    } else {
                        advance_page(context, true);
                    }
                    return LRESULT(0);
                }
                WM_LBUTTONDBLCLK => {
                    context.suppress_next_button_up = true;
                    open_manager(&context.app);
                    return LRESULT(0);
                }
                WM_RBUTTONUP => {
                    if GetCapture() == hwnd {
                        let _ = ReleaseCapture();
                    }
                    show_context_menu(context, hwnd);
                    return LRESULT(0);
                }
                WM_CONTEXTMENU => {
                    show_context_menu(context, hwnd);
                    return LRESULT(0);
                }
                WM_COMMAND => {
                    match wparam.0 & 0xffff {
                        MENU_DISABLE_TASKBAR => {
                            context.shared.lock().unwrap().requested_mode =
                                PriceDisplayMode::Bubble;
                            let _ = context.app.emit_all("price-display-mode-changed", "bubble");
                            reconcile(context, false);
                        }
                        MENU_HIDE_LABELS => {
                            // The manager owns persistence and immediately sends the
                            // authoritative payload back. Mutating here first could race
                            // with a live-price payload carrying the previous value.
                            let hidden = !context.shared.lock().unwrap().payload.hide_labels;
                            let _ = context.app.emit_all("taskbar-hide-labels-changed", hidden);
                        }
                        _ => {}
                    }
                    return LRESULT(0);
                }
                _ => {}
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    unsafe fn show_context_menu(context: &ThreadContext, hwnd: HWND) {
        let Ok(menu) = CreatePopupMenu() else { return };
        let hide_labels = context.shared.lock().unwrap().payload.hide_labels;
        let _ = AppendMenuW(menu, MF_STRING, MENU_DISABLE_TASKBAR, w!("取消任务栏显示"));
        let hide_flags = if hide_labels {
            MENU_ITEM_FLAGS(MF_STRING.0 | MF_CHECKED.0)
        } else {
            MF_STRING
        };
        let _ = AppendMenuW(menu, hide_flags, MENU_HIDE_LABELS, w!("隐藏汉字"));
        let mut point = POINT::default();
        if GetCursorPos(&mut point).is_ok() {
            let _ = SetForegroundWindow(hwnd);
            let _ = TrackPopupMenu(
                menu,
                TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON,
                point.x,
                point.y,
                0,
                hwnd,
                None,
            );
            let _ = PostMessageW(hwnd, WM_NULL, WPARAM(0), LPARAM(0));
        }
        let _ = DestroyMenu(menu);
    }

    unsafe fn reconcile(context: &mut ThreadContext, force_attach: bool) {
        let (requested_mode, user_visible) = {
            let shared = context.shared.lock().unwrap();
            (shared.requested_mode, shared.user_visible)
        };

        if !is_windows_10_or_later() {
            detach(context);
            publish(
                context,
                false,
                requested_mode,
                "bubble",
                false,
                Some("unsupported_os"),
                user_visible,
            );
            return;
        }

        if requested_mode == PriceDisplayMode::Bubble || !user_visible {
            context.modern_overlap_since = None;
            let restored = restore_classic_reservation(context);
            if context.ticker.0 != 0 {
                let _ = ShowWindow(context.ticker, SW_HIDE);
            }
            let actual = if user_visible { "bubble" } else { "hidden" };
            publish(
                context,
                shell_supported(),
                requested_mode,
                actual,
                false,
                (!restored).then_some("restore_pending"),
                user_visible,
            );
            return;
        }

        let payload = context.shared.lock().unwrap().payload.clone();
        let placement_changed =
            context.geometry.is_some() && context.active_placement != payload.placement;
        if placement_changed {
            context.modern_overlap_since = None;
            // Never drag a visible child window across Explorer. Clear the old
            // reservation first, calculate once from a clean taskbar layout,
            // and reveal only the final frame at the new edge.
            let _ = ShowWindow(context.ticker, SW_HIDE);
            if !restore_classic_reservation(context) {
                publish(
                    context,
                    true,
                    requested_mode,
                    "bubble",
                    false,
                    Some("layout_unstable"),
                    user_visible,
                );
                return;
            }
            context.geometry = None;
        }
        context.active_placement = payload.placement.clone();
        let Some(layout) = locate_geometry(context, &payload) else {
            detach(context);
            let explorer_restarting = context
                .first_attach_failure
                .is_some_and(|started| started.elapsed() < Duration::from_secs(5));
            let reason = if explorer_restarting {
                "explorer_restarting"
            } else if shell_supported() {
                "no_space"
            } else {
                "unsupported_shell"
            };
            publish(
                context,
                reason != "unsupported_shell",
                requested_mode,
                "bubble",
                false,
                Some(reason),
                user_visible,
            );
            return;
        };

        if context.ticker.0 == 0 || force_attach {
            if !attach(context, layout.parent) {
                let started = context
                    .first_attach_failure
                    .get_or_insert_with(Instant::now);
                let reason = if started.elapsed() < Duration::from_secs(5) {
                    "explorer_restarting"
                } else {
                    "attach_failed"
                };
                detach(context);
                publish(
                    context,
                    true,
                    requested_mode,
                    "bubble",
                    false,
                    Some(reason),
                    user_visible,
                );
                return;
            }
            context.first_attach_failure = None;
        }

        let geometry = layout.geometry;
        if context.geometry != Some(geometry) {
            let had_geometry = context.geometry.is_some();
            if had_geometry {
                let _ = ShowWindow(context.ticker, SW_HIDE);
            }
            if SetWindowPos(
                context.ticker,
                HWND_TOP,
                geometry.x,
                geometry.y,
                geometry.width,
                geometry.height,
                SWP_NOACTIVATE | SWP_NOREDRAW,
            )
            .is_err()
            {
                detach(context);
                publish(
                    context,
                    true,
                    requested_mode,
                    "bubble",
                    false,
                    Some("attach_failed"),
                    user_visible,
                );
                return;
            }
            context.geometry = Some(geometry);
            // Resize while hidden, invalidate the stretched old backing store,
            // then synchronously paint one complete frame before composition.
            let _ = InvalidateRect(context.ticker, None, false);
            let _ = ShowWindow(context.ticker, SW_SHOWNOACTIVATE);
            let paint_count = context.paint_count;
            let _ = UpdateWindow(context.ticker);
            if context.paint_count == paint_count {
                detach(context);
                publish(
                    context,
                    true,
                    requested_mode,
                    "bubble",
                    false,
                    Some("attach_failed"),
                    user_visible,
                );
                return;
            }
            context.last_paint_request = Instant::now();
        } else {
            let _ = ShowWindow(context.ticker, SW_SHOWNOACTIVATE);
        }
        if !ticker_is_ready(context.ticker, geometry) {
            detach(context);
            publish(
                context,
                true,
                requested_mode,
                "bubble",
                false,
                Some("attach_failed"),
                user_visible,
            );
            return;
        }
        if !apply_classic_reservation(context, layout.classic) {
            detach(context);
            publish(
                context,
                true,
                requested_mode,
                "bubble",
                false,
                Some("attach_failed"),
                user_visible,
            );
            return;
        }
        publish(
            context,
            true,
            requested_mode,
            "taskbar",
            true,
            None,
            user_visible,
        );
        request_paint(context);
    }

    unsafe fn attach(context: &mut ThreadContext, taskbar: HWND) -> bool {
        if context.ticker.0 != 0 && !IsWindow(context.ticker).as_bool() {
            context.ticker = HWND(0);
            context.tooltip = HWND(0);
            context.tooltip_registered = false;
            context.geometry = None;
        }
        if context.ticker.0 == 0 {
            let module = match GetModuleHandleW(None) {
                Ok(value) => HINSTANCE(value.0),
                Err(_) => return false,
            };
            let ptr = context as *mut ThreadContext as *const c_void;
            context.ticker = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_LAYERED,
                w!("GoldPriceTaskbarTicker"),
                w!("GoldPrice taskbar prices"),
                WS_POPUP,
                0,
                0,
                1,
                1,
                context.control,
                None,
                module,
                Some(ptr),
            );
            if context.ticker.0 == 0 {
                return false;
            }
            if SetLayeredWindowAttributes(context.ticker, COLORREF(1), 255, LWA_COLORKEY).is_err() {
                let _ = DestroyWindow(context.ticker);
                context.ticker = HWND(0);
                return false;
            }
            context.tooltip = CreateWindowExW(
                WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST,
                TOOLTIPS_CLASSW,
                None,
                WS_POPUP | WINDOW_STYLE(TTS_ALWAYSTIP | TTS_NOPREFIX),
                0,
                0,
                0,
                0,
                context.ticker,
                None,
                module,
                None,
            );
            if context.tooltip.0 != 0 {
                update_tooltip(context);
                let tooltip_dpi = GetDpiForWindow(taskbar).max(96);
                let _ = SendMessageW(
                    context.tooltip,
                    TTM_SETMAXTIPWIDTH,
                    WPARAM(0),
                    LPARAM(dip_to_px(720, tooltip_dpi) as isize),
                );
            }
        }
        let style = GetWindowLongPtrW(context.ticker, GWL_STYLE) as u32;
        let child_style = (style & !WS_POPUP.0) | WS_CHILD.0 | WS_CLIPSIBLINGS.0;
        let _ = SetWindowLongPtrW(context.ticker, GWL_STYLE, child_style as isize);
        let _ = SetParent(context.ticker, taskbar);
        if GetParent(context.ticker) != taskbar {
            return false;
        }
        let _ = SetWindowPos(
            context.ticker,
            HWND_TOP,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        );
        true
    }

    unsafe fn detach(context: &mut ThreadContext) {
        let _ = restore_classic_reservation(context);
        context.geometry = None;
        if context.ticker.0 != 0 {
            if IsWindow(context.ticker).as_bool() {
                let _ = ShowWindow(context.ticker, SW_HIDE);
            } else {
                context.ticker = HWND(0);
                context.tooltip = HWND(0);
                context.tooltip_registered = false;
            }
        }
    }

    unsafe fn locate_geometry(
        context: &mut ThreadContext,
        payload: &TaskbarDisplayPayload,
    ) -> Option<TaskbarLayout> {
        if is_windows_10() {
            return locate_classic_geometry(context, payload);
        }
        locate_modern_geometry(context, payload)
    }

    unsafe fn locate_modern_geometry(
        context: &mut ThreadContext,
        payload: &TaskbarDisplayPayload,
    ) -> Option<TaskbarLayout> {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), None);
        if taskbar.0 == 0 {
            return None;
        }
        let tray = find_descendant(taskbar, &["TrayNotifyWnd"])?;
        let task_list = find_descendant(taskbar, &["MSTaskListWClass", "MSTaskSwWClass"])?;
        let mut taskbar_rect = RECT::default();
        let mut tray_rect = RECT::default();
        let mut list_rect = RECT::default();
        GetWindowRect(taskbar, &mut taskbar_rect).ok()?;
        GetWindowRect(tray, &mut tray_rect).ok()?;
        GetWindowRect(task_list, &mut list_rect).ok()?;
        let taskbar_width = taskbar_rect.right - taskbar_rect.left;
        let taskbar_height = taskbar_rect.bottom - taskbar_rect.top;
        if taskbar_width <= taskbar_height || tray_rect.left <= list_rect.left {
            return None;
        }
        let dpi = GetDpiForWindow(taskbar).max(96);
        let margin = dip_to_px(4, dpi);
        let width = measured_content_width(taskbar, payload, dpi)
            .clamp(dip_to_px(MIN_SAFE_DIP, dpi), dip_to_px(MAX_TICKER_DIP, dpi));
        let height = taskbar_height.clamp(dip_to_px(30, dpi), dip_to_px(40, dpi));
        let y = (taskbar_height - height) / 2;
        let existing = context.geometry;
        let right_anchor_x = tray_rect.left - taskbar_rect.left - margin;
        let existing_is_right_anchored = existing.is_some_and(|geometry| {
            (geometry.x + geometry.width - right_anchor_x).abs() <= dip_to_px(3, dpi)
        });

        if payload.placement == "left" {
            let widgets_reserve = dip_to_px(
                win11_widgets_reserve_dip(win11_widgets_enabled().unwrap_or(true)),
                dpi,
            );
            let left_x = widgets_reserve + margin;
            let existing_is_left_anchored = existing.is_some_and(|geometry| {
                !existing_is_right_anchored && (geometry.x - left_x).abs() <= dip_to_px(3, dpi)
            });
            let left_has_space = left_x + width + margin <= list_rect.left - taskbar_rect.left;
            // Keep the ticker in the left-side group, immediately after the
            // Widgets/weather slot. The task-list boundary is only the available
            // space limit; using it as the anchor made the ticker drift toward
            // the centered application icons.
            if modern_slot_is_usable(context, left_has_space, existing_is_left_anchored) {
                return Some(TaskbarLayout {
                    parent: taskbar,
                    geometry: Geometry {
                        x: left_x,
                        y,
                        width,
                        height,
                        dpi,
                    },
                    classic: None,
                });
            }
            if let Some(x) = modern_left_position(
                taskbar_rect.left,
                list_rect.left,
                width,
                margin,
                widgets_reserve,
            ) {
                return Some(TaskbarLayout {
                    parent: taskbar,
                    geometry: Geometry {
                        x,
                        y,
                        width,
                        height,
                        dpi,
                    },
                    classic: None,
                });
            }
        }

        let safe_width = safe_region_width(list_rect.right, tray_rect.left, margin);
        let left_screen = tray_rect.left - margin - width;
        // Win11 transiently expands the task-list bounds when Start or some
        // system panels open. Preserve an existing slot briefly so those events
        // do not bounce between taskbar and bubble. Persistent overlap means
        // application buttons have consumed the slot and must fall back safely.
        if !modern_slot_is_usable(context, safe_width >= width, existing_is_right_anchored) {
            return None;
        }
        Some(TaskbarLayout {
            parent: taskbar,
            geometry: Geometry {
                x: left_screen - taskbar_rect.left,
                y,
                width,
                height,
                dpi,
            },
            classic: None,
        })
    }

    fn modern_slot_is_usable(
        context: &mut ThreadContext,
        has_space: bool,
        preserving_existing_slot: bool,
    ) -> bool {
        if has_space {
            context.modern_overlap_since = None;
            return true;
        }
        if !preserving_existing_slot {
            return false;
        }
        let overlap_started = context
            .modern_overlap_since
            .get_or_insert_with(Instant::now);
        overlap_started.elapsed() < MODERN_OVERLAP_GRACE
    }

    unsafe fn locate_classic_geometry(
        context: &mut ThreadContext,
        payload: &TaskbarDisplayPayload,
    ) -> Option<TaskbarLayout> {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), None);
        if taskbar.0 == 0 {
            return None;
        }
        let rebar = find_direct_child(taskbar, &["ReBarWindow32", "WorkerW"])?;
        let task_list = find_direct_child(rebar, &["MSTaskSwWClass", "MSTaskListWClass"])?;

        let dpi = GetDpiForWindow(taskbar).max(96);
        let ticker_width = measured_content_width(taskbar, payload, dpi)
            .clamp(dip_to_px(MIN_SAFE_DIP, dpi), dip_to_px(MAX_TICKER_DIP, dpi));
        if let Some(reservation) = context.classic_reservation {
            if IsWindow(reservation.rebar).as_bool()
                && IsWindow(reservation.task_list).as_bool()
                && reservation.taskbar == taskbar
                && reservation.rebar == rebar
                && reservation.task_list == task_list
                && reservation.ticker.width == ticker_width
                && context.active_placement == payload.placement
            {
                return Some(TaskbarLayout {
                    parent: rebar,
                    geometry: reservation.ticker,
                    classic: Some(reservation),
                });
            }
            if !restore_classic_reservation(context) {
                return None;
            }
        }

        let mut taskbar_rect = RECT::default();
        let mut rebar_rect = RECT::default();
        let mut list_rect = RECT::default();
        GetWindowRect(taskbar, &mut taskbar_rect).ok()?;
        GetWindowRect(rebar, &mut rebar_rect).ok()?;
        GetWindowRect(task_list, &mut list_rect).ok()?;
        if taskbar_rect.right - taskbar_rect.left <= taskbar_rect.bottom - taskbar_rect.top
            || list_rect.right <= list_rect.left
            || list_rect.bottom <= list_rect.top
        {
            return None;
        }

        let reserve_gap = dip_to_px(2, dpi);
        let original_width = list_rect.right - list_rect.left;
        let on_left = payload.placement == "left";
        let (target_x, target_width, ticker_x) = classic_horizontal_layout(
            list_rect.left - rebar_rect.left,
            original_width,
            ticker_width,
            reserve_gap,
            dip_to_px(MIN_TASK_LIST_DIP, dpi),
            on_left,
        )?;
        let rebar_height = rebar_rect.bottom - rebar_rect.top;
        let ticker_height = (taskbar_rect.bottom - taskbar_rect.top)
            .clamp(dip_to_px(30, dpi), dip_to_px(40, dpi))
            .min(rebar_height.max(1));
        let original_x = list_rect.left - rebar_rect.left;
        let original_y = list_rect.top - rebar_rect.top;
        let target = Geometry {
            x: target_x,
            y: original_y,
            width: target_width,
            height: list_rect.bottom - list_rect.top,
            dpi,
        };
        let ticker = Geometry {
            x: ticker_x,
            y: (rebar_height - ticker_height).max(0) / 2,
            width: ticker_width,
            height: ticker_height,
            dpi,
        };
        let reservation = ClassicReservation {
            taskbar,
            rebar,
            task_list,
            original: Geometry {
                x: original_x,
                y: original_y,
                width: original_width,
                height: list_rect.bottom - list_rect.top,
                dpi,
            },
            target,
            ticker,
        };
        Some(TaskbarLayout {
            parent: rebar,
            geometry: ticker,
            classic: Some(reservation),
        })
    }

    unsafe fn ticker_is_ready(ticker: HWND, expected: Geometry) -> bool {
        if ticker.0 == 0 || !IsWindowVisible(ticker).as_bool() || GetParent(ticker).0 == 0 {
            return false;
        }
        let mut rect = RECT::default();
        GetClientRect(ticker, &mut rect).is_ok()
            && rect.right - rect.left == expected.width
            && rect.bottom - rect.top == expected.height
    }

    unsafe fn apply_classic_reservation(
        context: &mut ThreadContext,
        reservation: Option<ClassicReservation>,
    ) -> bool {
        let Some(reservation) = reservation else {
            return true;
        };
        if GetParent(reservation.task_list) != reservation.rebar {
            return false;
        }
        if context.classic_reservation == Some(reservation) {
            if classic_geometry_matches(reservation, reservation.target) {
                return true;
            }
            // Explorer may restore its child geometry during a theme/DPI change.
            // Reapply only the recorded target; never derive a new baseline from
            // the already shortened task list.
            if classic_geometry_matches(reservation, reservation.original) {
                return SetWindowPos(
                    reservation.task_list,
                    HWND_TOP,
                    reservation.target.x,
                    reservation.target.y,
                    reservation.target.width,
                    reservation.target.height,
                    SWP_NOACTIVATE,
                )
                .is_ok()
                    && classic_geometry_matches(reservation, reservation.target);
            }
            return false;
        }
        if SetWindowPos(
            reservation.task_list,
            HWND_TOP,
            reservation.target.x,
            reservation.target.y,
            reservation.target.width,
            reservation.target.height,
            SWP_NOACTIVATE,
        )
        .is_err()
            || !classic_geometry_matches(reservation, reservation.target)
        {
            let _ = SetWindowPos(
                reservation.task_list,
                HWND_TOP,
                reservation.original.x,
                reservation.original.y,
                reservation.original.width,
                reservation.original.height,
                SWP_NOACTIVATE,
            );
            return false;
        }
        context.classic_reservation = Some(reservation);
        true
    }

    unsafe fn classic_geometry_matches(
        reservation: ClassicReservation,
        expected: Geometry,
    ) -> bool {
        let mut rebar_rect = RECT::default();
        let mut actual = RECT::default();
        GetWindowRect(reservation.rebar, &mut rebar_rect).is_ok()
            && GetWindowRect(reservation.task_list, &mut actual).is_ok()
            && (actual.left - rebar_rect.left - expected.x).abs() <= 2
            && (actual.top - rebar_rect.top - expected.y).abs() <= 2
            && (actual.right - actual.left - expected.width).abs() <= 2
            && (actual.bottom - actual.top - expected.height).abs() <= 2
    }

    unsafe fn restore_classic_reservation(context: &mut ThreadContext) -> bool {
        let Some(reservation) = context.classic_reservation else {
            return true;
        };
        if !IsWindow(reservation.rebar).as_bool()
            || !IsWindow(reservation.task_list).as_bool()
            || GetParent(reservation.task_list) != reservation.rebar
        {
            // Keep the record. Clearing it here would allow a later retry to
            // treat a shortened task list as the new original width.
            return false;
        }
        if !classic_geometry_matches(reservation, reservation.original)
            && (SetWindowPos(
                reservation.task_list,
                HWND_TOP,
                reservation.original.x,
                reservation.original.y,
                reservation.original.width,
                reservation.original.height,
                SWP_NOACTIVATE,
            )
            .is_err()
                || !classic_geometry_matches(reservation, reservation.original))
        {
            return false;
        }
        context.classic_reservation = None;
        true
    }

    unsafe fn find_descendant(parent: HWND, classes: &[&str]) -> Option<HWND> {
        struct Search<'a> {
            classes: &'a [&'a str],
            result: HWND,
        }
        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = &mut *(lparam.0 as *mut Search<'_>);
            let mut buffer = [0u16; 96];
            let length = GetClassNameW(hwnd, &mut buffer);
            if length > 0 {
                let name = String::from_utf16_lossy(&buffer[..length as usize]);
                if search.classes.iter().any(|class| *class == name) {
                    search.result = hwnd;
                    return BOOL(0);
                }
            }
            BOOL(1)
        }
        let mut search = Search {
            classes,
            result: HWND(0),
        };
        let _ = EnumChildWindows(
            parent,
            Some(callback),
            LPARAM(&mut search as *mut _ as isize),
        );
        (search.result.0 != 0).then_some(search.result)
    }

    unsafe fn find_direct_child(parent: HWND, classes: &[&str]) -> Option<HWND> {
        struct Search<'a> {
            parent: HWND,
            classes: &'a [&'a str],
            result: HWND,
        }
        unsafe extern "system" fn callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
            let search = &mut *(lparam.0 as *mut Search<'_>);
            if GetParent(hwnd) != search.parent {
                return BOOL(1);
            }
            let mut buffer = [0u16; 96];
            let length = GetClassNameW(hwnd, &mut buffer);
            if length > 0 {
                let name = String::from_utf16_lossy(&buffer[..length as usize]);
                if search.classes.iter().any(|class| *class == name) {
                    search.result = hwnd;
                    return BOOL(0);
                }
            }
            BOOL(1)
        }
        let mut search = Search {
            parent,
            classes,
            result: HWND(0),
        };
        let _ = EnumChildWindows(
            parent,
            Some(callback),
            LPARAM(&mut search as *mut _ as isize),
        );
        (search.result.0 != 0).then_some(search.result)
    }

    unsafe fn shell_supported() -> bool {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), None);
        taskbar.0 != 0
            && find_descendant(taskbar, &["TrayNotifyWnd"]).is_some()
            && find_descendant(taskbar, &["MSTaskListWClass", "MSTaskSwWClass"]).is_some()
    }

    #[repr(C)]
    struct RtlOsVersionInfo {
        size: u32,
        major: u32,
        minor: u32,
        build: u32,
        platform: u32,
        service_pack: [u16; 128],
    }

    #[link(name = "ntdll")]
    extern "system" {
        fn RtlGetVersion(info: *mut RtlOsVersionInfo) -> i32;
    }

    unsafe fn is_windows_10_or_later() -> bool {
        let mut info: RtlOsVersionInfo = mem::zeroed();
        info.size = mem::size_of::<RtlOsVersionInfo>() as u32;
        RtlGetVersion(&mut info) == 0 && info.major >= 10
    }

    unsafe fn is_windows_10() -> bool {
        let mut info: RtlOsVersionInfo = mem::zeroed();
        info.size = mem::size_of::<RtlOsVersionInfo>() as u32;
        RtlGetVersion(&mut info) == 0 && info.major == 10 && info.build < 22000
    }

    pub(super) fn page_count(item_count: usize) -> usize {
        item_count.max(1).div_ceil(PAGE_SIZE)
    }

    unsafe fn advance_page(context: &mut ThreadContext, reset_interval: bool) {
        let count = page_count(context.shared.lock().unwrap().payload.items.len());
        if count <= 1 || context.ticker.0 == 0 {
            context.page_index = 0;
            context.animation = None;
            return;
        }
        let from = context.page_index.min(count - 1);
        let to = (from + 1) % count;
        context.page_index = to;
        context.animation = Some(PageAnimation {
            from,
            to,
            started: Instant::now(),
        });
        let _ = SetTimer(context.control, TIMER_ANIMATION, 16, None);
        if reset_interval {
            let _ = KillTimer(context.control, TIMER_CAROUSEL);
            let _ = SetTimer(context.control, TIMER_CAROUSEL, CAROUSEL_INTERVAL_MS, None);
        }
        let _ = InvalidateRect(context.ticker, None, false);
    }

    unsafe fn update_page_animation(context: &mut ThreadContext) {
        if context
            .animation
            .is_some_and(|animation| animation.started.elapsed() >= SLIDE_DURATION)
        {
            context.animation = None;
            let _ = KillTimer(context.control, TIMER_ANIMATION);
        }
        if context.ticker.0 != 0 {
            let _ = InvalidateRect(context.ticker, None, false);
            let _ = UpdateWindow(context.ticker);
        }
    }

    unsafe fn paint(context: &mut ThreadContext, hwnd: HWND) {
        let mut ps = PAINTSTRUCT::default();
        let hdc = BeginPaint(hwnd, &mut ps);
        let mut rect = RECT::default();
        if GetClientRect(hwnd, &mut rect).is_err() {
            let _ = EndPaint(hwnd, &ps);
            return;
        }
        let width = rect.right.max(1);
        let height = rect.bottom.max(1);
        let memory_dc = CreateCompatibleDC(hdc);
        let bitmap = CreateCompatibleBitmap(hdc, width, height);
        let old_bitmap = SelectObject(memory_dc, bitmap);

        let sampled_bg = sample_background(hwnd).unwrap_or(COLORREF(0x00f0f0f0));
        // Color-key pixels in a layered window are transparent to mouse hit
        // testing. Paint the taskbar's actual color so the background blends
        // visually while the complete ticker rectangle remains clickable.
        let brush = CreateSolidBrush(sampled_bg);
        FillRect(memory_dc, &rect, brush);
        let _ = DeleteObject(brush);

        let dpi = context.geometry.map(|value| value.dpi).unwrap_or(96);
        let label_font = create_label_font(dpi);
        let value_font = create_value_font(dpi);
        let old_font = SelectObject(memory_dc, label_font);
        SetBkMode(memory_dc, TRANSPARENT);

        let mut payload = context.shared.lock().unwrap().payload.clone();
        payload.placement.clone_from(&context.active_placement);
        if context.animation.is_none() {
            update_tooltip(context);
        }
        let entries = display_entries(&payload);
        let dark = system_uses_light_theme()
            .map(|light| !light)
            .unwrap_or_else(|| luminance(sampled_bg) < 140);
        let neutral = if dark {
            COLORREF(0x00f5f5f5)
        } else {
            COLORREF(0x00202020)
        };

        SetTextColor(
            memory_dc,
            if payload.online {
                neutral
            } else {
                COLORREF(0x00888888)
            },
        );
        let align_right = payload.placement == "right";
        let count = page_count(entries.len());
        context.page_index = context.page_index.min(count - 1);
        if context
            .animation
            .is_some_and(|animation| animation.from >= count || animation.to >= count)
        {
            context.animation = None;
            let _ = KillTimer(context.control, TIMER_ANIMATION);
        }
        if let Some(animation) = context.animation {
            let progress = (animation.started.elapsed().as_secs_f32()
                / SLIDE_DURATION.as_secs_f32())
            .clamp(0.0, 1.0);
            let offset = (height as f32 * progress).round() as i32;
            draw_page(
                memory_dc,
                label_font,
                value_font,
                page_entries(&entries, animation.from),
                width,
                height,
                -offset,
                dpi,
                align_right,
            );
            draw_page(
                memory_dc,
                label_font,
                value_font,
                page_entries(&entries, animation.to),
                width,
                height,
                height - offset,
                dpi,
                align_right,
            );
        } else {
            draw_page(
                memory_dc,
                label_font,
                value_font,
                page_entries(&entries, context.page_index),
                width,
                height,
                0,
                dpi,
                align_right,
            );
        }

        let _ = BitBlt(hdc, 0, 0, width, height, memory_dc, 0, 0, SRCCOPY);
        SelectObject(memory_dc, old_font);
        SelectObject(memory_dc, old_bitmap);
        let _ = DeleteObject(label_font);
        let _ = DeleteObject(value_font);
        let _ = DeleteObject(bitmap);
        let _ = DeleteDC(memory_dc);
        let _ = EndPaint(hwnd, &ps);
        context.paint_count = context.paint_count.saturating_add(1);
    }

    fn page_entries(entries: &[(String, String)], page: usize) -> &[(String, String)] {
        let start = page.saturating_mul(PAGE_SIZE).min(entries.len());
        let end = (start + PAGE_SIZE).min(entries.len());
        &entries[start..end]
    }

    unsafe fn draw_page(
        hdc: HDC,
        label_font: HFONT,
        value_font: HFONT,
        entries: &[(String, String)],
        width: i32,
        height: i32,
        y_offset: i32,
        dpi: u32,
        align_right: bool,
    ) {
        let labels_hidden = entries.iter().all(|(label, _)| label.is_empty());
        let padding = dip_to_px(if labels_hidden { 2 } else { 5 }, dpi);
        let gap = dip_to_px(6, dpi);
        let page_width = entries
            .chunks(2)
            .map(|pair| {
                measure_pair_layout(hdc, label_font, value_font, pair, dpi).total_width
                    + padding * 2
            })
            .sum::<i32>()
            + gap * entries.chunks(2).len().saturating_sub(1) as i32;
        let mut x = if align_right {
            (width - padding - page_width).max(padding)
        } else {
            padding
        };
        for pair in entries.chunks(2) {
            let layout = measure_pair_layout(hdc, label_font, value_font, pair, dpi);
            let column_width = layout.total_width + padding * 2;
            for (row, (label, value)) in pair.iter().enumerate() {
                let (number, unit) = split_value(value);
                let content_left = x + padding;
                let top = row as i32 * height / 2 + y_offset;
                let bottom = (row as i32 + 1) * height / 2 + y_offset;
                if !label.is_empty() {
                    SelectObject(hdc, label_font);
                    SetTextCharacterExtra(hdc, 0);
                    let mut wide: Vec<u16> = label.encode_utf16().collect();
                    let mut label_rect = RECT {
                        left: content_left,
                        top,
                        right: content_left + layout.label_width,
                        bottom,
                    };
                    DrawTextW(
                        hdc,
                        &mut wide,
                        &mut label_rect,
                        (if align_right { DT_RIGHT } else { DT_LEFT })
                            | DT_VCENTER
                            | DT_SINGLELINE
                            | DT_NOPREFIX,
                    );
                }
                let number_left = content_left + layout.label_width + layout.label_separator;
                let number_width = measure_half_tracked(hdc, value_font, number);
                let number_rect = RECT {
                    left: number_left + layout.number_width - number_width,
                    top,
                    right: number_left + layout.number_width + layout.safety,
                    bottom,
                };
                draw_half_tracked(hdc, value_font, number, number_rect);
                let mut unit_wide: Vec<u16> = unit.encode_utf16().collect();
                let mut unit_rect = RECT {
                    left: number_left + layout.number_width + layout.unit_separator,
                    top,
                    right: content_left + layout.total_width + layout.safety,
                    bottom,
                };
                SelectObject(hdc, value_font);
                DrawTextW(
                    hdc,
                    &mut unit_wide,
                    &mut unit_rect,
                    DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
                );
            }
            x += column_width + gap;
        }
    }

    unsafe fn create_font(dpi: u32, face: windows::core::PCWSTR) -> HFONT {
        CreateFontW(
            taskbar_font_height(dpi),
            0,
            0,
            0,
            FW_NORMAL.0 as i32,
            0,
            0,
            0,
            DEFAULT_CHARSET.0 as u32,
            OUT_DEFAULT_PRECIS.0 as u32,
            CLIP_DEFAULT_PRECIS.0 as u32,
            CLEARTYPE_QUALITY.0 as u32,
            DEFAULT_PITCH.0 as u32,
            face,
        )
    }

    unsafe fn create_label_font(dpi: u32) -> HFONT {
        if is_windows_10() {
            create_font(dpi, w!("Segoe UI"))
        } else {
            create_font(dpi, w!("Segoe UI Variable Text"))
        }
    }

    unsafe fn create_value_font(dpi: u32) -> HFONT {
        if is_windows_10() {
            create_font(dpi, w!("Segoe UI"))
        } else {
            create_font(dpi, w!("Segoe UI Variable Text"))
        }
    }

    unsafe fn measured_content_width(
        taskbar: HWND,
        payload: &TaskbarDisplayPayload,
        dpi: u32,
    ) -> i32 {
        let dc = GetDC(taskbar);
        if dc.0 == 0 {
            return dip_to_px(MIN_SAFE_DIP, dpi);
        }
        let label_font = create_label_font(dpi);
        let value_font = create_value_font(dpi);
        let old_font = SelectObject(dc, label_font);
        let padding = dip_to_px(if payload.hide_labels { 2 } else { 5 }, dpi);
        let gap = dip_to_px(6, dpi);
        let entries = display_entries(payload);
        let text_width = entries
            .chunks(PAGE_SIZE)
            .map(|page| {
                let columns = page.chunks(2).len();
                page.chunks(2)
                    .map(|pair| {
                        measure_pair_layout(dc, label_font, value_font, pair, dpi).total_width
                            + padding * 2
                    })
                    .sum::<i32>()
                    + gap * columns.saturating_sub(1) as i32
            })
            .max()
            .unwrap_or(1);
        SelectObject(dc, old_font);
        let _ = DeleteObject(label_font);
        let _ = DeleteObject(value_font);
        let _ = ReleaseDC(taskbar, dc);
        padding * 2 + text_width
    }

    fn display_entries(payload: &TaskbarDisplayPayload) -> Vec<(String, String)> {
        if payload.items.is_empty() {
            return vec![("等待行情".to_string(), String::new())];
        }
        payload
            .items
            .iter()
            .map(|item| {
                let label = if payload.hide_labels {
                    String::new()
                } else {
                    item.label.clone()
                };
                (label, item.value.clone())
            })
            .collect()
    }

    #[derive(Clone, Copy)]
    struct PairLayout {
        label_width: i32,
        label_separator: i32,
        number_width: i32,
        unit_separator: i32,
        safety: i32,
        total_width: i32,
    }

    fn split_value(value: &str) -> (&str, &str) {
        value.rsplit_once(' ').unwrap_or((value, ""))
    }

    unsafe fn select_and_measure(hdc: HDC, font: HFONT, text: &str) -> i32 {
        SelectObject(hdc, font);
        measure(hdc, text)
    }

    unsafe fn measure_half_tracked(hdc: HDC, font: HFONT, text: &str) -> i32 {
        let length = text.encode_utf16().count();
        select_and_measure(hdc, font, text) + length.saturating_sub(1).div_ceil(2) as i32
    }

    unsafe fn measure_pair_layout(
        hdc: HDC,
        label_font: HFONT,
        value_font: HFONT,
        pair: &[(String, String)],
        dpi: u32,
    ) -> PairLayout {
        let label_width = pair
            .iter()
            .map(|(label, _)| {
                if label.is_empty() {
                    0
                } else {
                    select_and_measure(hdc, label_font, label)
                }
            })
            .max()
            .unwrap_or(0);
        let has_value = pair.iter().any(|(_, value)| !value.is_empty());
        let number_width = if has_value {
            let has_sign = pair.iter().any(|(_, value)| {
                let number = split_value(value).0;
                number.starts_with('+') || number.starts_with('-')
            });
            let actual_width = pair
                .iter()
                .map(|(_, value)| measure_half_tracked(hdc, value_font, split_value(value).0))
                .max()
                .unwrap_or(0);
            let stable_width = stable_number_width(hdc, value_font, has_sign);
            stable_width.max(actual_width)
        } else {
            0
        };
        let unit_width = pair
            .iter()
            .map(|(_, value)| select_and_measure(hdc, value_font, split_value(value).1))
            .max()
            .unwrap_or(0);
        let label_separator = if label_width > 0 && has_value {
            dip_to_px(3, dpi)
        } else {
            0
        };
        let unit_separator = if unit_width > 0 { dip_to_px(2, dpi) } else { 0 };
        let safety = dip_to_px(2, dpi);
        let total_width =
            label_width + label_separator + number_width + unit_separator + unit_width + safety;
        PairLayout {
            label_width,
            label_separator,
            number_width,
            unit_separator,
            safety,
            total_width,
        }
    }

    unsafe fn stable_number_width(hdc: HDC, font: HFONT, include_sign: bool) -> i32 {
        let widest_digit = ('0'..='9')
            .map(|digit| select_and_measure(hdc, font, &digit.to_string()))
            .max()
            .unwrap_or(0);
        let decimal = select_and_measure(hdc, font, ".");
        let sign = if include_sign {
            select_and_measure(hdc, font, "+").max(select_and_measure(hdc, font, "-"))
        } else {
            0
        };
        // Six digits + decimal point + an optional sign. Seven character gaps
        // at average 0.5 px require four physical pixels at 96 DPI.
        widest_digit * 6 + decimal + sign + if include_sign { 4 } else { 3 }
    }

    unsafe fn draw_half_tracked(hdc: HDC, font: HFONT, text: &str, rect: RECT) {
        if text.is_empty() {
            return;
        }
        SelectObject(hdc, font);
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut advances = Vec::with_capacity(wide.len());
        for (index, unit) in wide.iter().enumerate() {
            let mut size = SIZE::default();
            let _ = GetTextExtentPoint32W(hdc, &[*unit], &mut size);
            advances.push(size.cx + i32::from(index + 1 < wide.len() && index % 2 == 0));
        }
        let mut metrics = TEXTMETRICW::default();
        let _ = GetTextMetricsW(hdc, &mut metrics);
        let y = rect.top + ((rect.bottom - rect.top - metrics.tmHeight).max(0) / 2);
        let _ = ExtTextOutW(
            hdc,
            rect.left,
            y,
            ETO_CLIPPED,
            Some(&rect),
            PCWSTR(wide.as_ptr()),
            wide.len() as u32,
            Some(advances.as_ptr()),
        );
    }

    unsafe fn update_tooltip(context: &mut ThreadContext) {
        if context.tooltip.0 == 0 || context.ticker.0 == 0 {
            return;
        }
        let payload = context.shared.lock().unwrap().payload.clone();
        let count = page_count(payload.items.len());
        let page = context.page_index.min(count - 1);
        let start = page * PAGE_SIZE;
        let visible_items = payload
            .items
            .iter()
            .skip(start)
            .take(PAGE_SIZE)
            .collect::<Vec<_>>();
        let mut lines = (0..2)
            .filter_map(|row| {
                let parts = [row, row + 2]
                    .into_iter()
                    .filter_map(|index| visible_items.get(index))
                    .map(|item| format!("{}  {}", item.label, item.value))
                    .collect::<Vec<_>>();
                (!parts.is_empty()).then(|| parts.join("　　"))
            })
            .collect::<Vec<_>>();
        if count > 1 {
            lines.insert(0, format!("第 {}/{} 组", page + 1, count));
        }
        let mut text = if lines.is_empty() {
            "等待行情".to_string()
        } else {
            lines.join("\r\n")
        };
        if !payload.online && !payload.items.is_empty() {
            text.push_str("\r\n行情连接已断开，显示最后数据");
        }
        context.tooltip_text = text.encode_utf16().chain(std::iter::once(0)).collect();
        let tooltip_dpi = context.geometry.map(|geometry| geometry.dpi).unwrap_or(96);
        let _ = SendMessageW(
            context.tooltip,
            TTM_SETMAXTIPWIDTH,
            WPARAM(0),
            LPARAM(dip_to_px(720, tooltip_dpi) as isize),
        );
        let mut info = TTTOOLINFOW {
            cbSize: mem::size_of::<TTTOOLINFOW>() as u32,
            uFlags: TTF_IDISHWND | TTF_SUBCLASS,
            hwnd: context.ticker,
            uId: context.ticker.0 as usize,
            lpszText: PWSTR(context.tooltip_text.as_mut_ptr()),
            ..Default::default()
        };
        if !context.tooltip_registered {
            context.tooltip_registered = SendMessageW(
                context.tooltip,
                TTM_ADDTOOLW,
                WPARAM(0),
                LPARAM(&mut info as *mut _ as isize),
            )
            .0 != 0;
        }
        if context.tooltip_registered {
            let _ = SendMessageW(
                context.tooltip,
                TTM_UPDATETIPTEXTW,
                WPARAM(0),
                LPARAM(&mut info as *mut _ as isize),
            );
        }
    }

    unsafe fn measure(hdc: HDC, text: &str) -> i32 {
        let wide: Vec<u16> = text.encode_utf16().collect();
        let mut size = SIZE::default();
        let _ = GetTextExtentPoint32W(hdc, &wide, &mut size);
        size.cx.max(1)
    }

    unsafe fn sample_background(hwnd: HWND) -> Option<COLORREF> {
        let taskbar = FindWindowW(w!("Shell_TrayWnd"), None);
        if taskbar.0 == 0 {
            return None;
        }
        let mut ticker_rect = RECT::default();
        let mut taskbar_rect = RECT::default();
        GetWindowRect(hwnd, &mut ticker_rect).ok()?;
        GetWindowRect(taskbar, &mut taskbar_rect).ok()?;
        let ticker_center = ticker_rect.left + (ticker_rect.right - ticker_rect.left) / 2;
        let taskbar_center = taskbar_rect.left + (taskbar_rect.right - taskbar_rect.left) / 2;
        let sample_x = if ticker_center <= taskbar_center {
            ticker_rect.right + 2
        } else {
            ticker_rect.left - 2
        }
        .clamp(taskbar_rect.left + 1, taskbar_rect.right - 2);
        // Sample close to the taskbar edge, outside the usual app-button hover
        // fill. Sampling beside the ticker at vertical center picked up orange
        // icons and dark hover rectangles when the task list became crowded.
        let sample_y = if taskbar_rect.bottom - taskbar_rect.top > 4 {
            taskbar_rect.top + 2
        } else {
            taskbar_rect.top
        };
        // Read the final desktop composition next to the ticker. Reading the
        // taskbar's own DC returns its pre-acrylic white backing surface.
        let desktop = HWND(0);
        let dc = GetDC(desktop);
        if dc.0 == 0 {
            return None;
        }
        let color = GetPixel(dc, sample_x, sample_y);
        let _ = ReleaseDC(desktop, dc);
        (color.0 != CLR_INVALID).then_some(color)
    }

    fn luminance(color: COLORREF) -> u32 {
        let r = color.0 & 0xff;
        let g = (color.0 >> 8) & 0xff;
        let b = (color.0 >> 16) & 0xff;
        (r * 299 + g * 587 + b * 114) / 1000
    }

    pub(super) unsafe fn system_uses_light_theme() -> Option<bool> {
        let mut value = 1u32;
        let mut size = mem::size_of::<u32>() as u32;
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"),
            w!("SystemUsesLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut _ as *mut c_void),
            Some(&mut size),
        )
        .ok()?;
        Some(value != 0)
    }

    pub(super) unsafe fn win11_widgets_enabled() -> Option<bool> {
        let mut value = 1u32;
        let mut size = mem::size_of::<u32>() as u32;
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!("Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced"),
            w!("TaskbarDa"),
            RRF_RT_REG_DWORD,
            None,
            Some(&mut value as *mut _ as *mut c_void),
            Some(&mut size),
        )
        .ok()?;
        Some(value != 0)
    }

    unsafe fn request_paint(context: &mut ThreadContext) {
        if context.ticker.0 == 0
            || context.last_paint_request.elapsed() < Duration::from_millis(250)
        {
            return;
        }
        context.last_paint_request = Instant::now();
        let _ = InvalidateRect(context.ticker, None, false);
    }

    fn publish_unavailable(context: &mut ThreadContext, reason: &str) {
        let (mode, visible) = {
            let shared = context.shared.lock().unwrap();
            (shared.requested_mode, shared.user_visible)
        };
        publish(
            context,
            false,
            mode,
            if visible { "bubble" } else { "hidden" },
            false,
            Some(reason),
            visible,
        );
    }

    fn publish(
        context: &mut ThreadContext,
        supported: bool,
        requested_mode: PriceDisplayMode,
        actual_display: &str,
        attached: bool,
        fallback_reason: Option<&str>,
        user_visible: bool,
    ) {
        let next = TaskbarDisplayStatus {
            supported,
            requested_mode,
            actual_display: actual_display.to_string(),
            attached,
            fallback_reason: fallback_reason.map(str::to_string),
            user_visible,
        };
        let changed = {
            let mut shared = context.shared.lock().unwrap();
            if shared.status == next {
                false
            } else {
                shared.status = next.clone();
                true
            }
        };
        if changed {
            (context.status_callback)(next.clone());
            let _ = context.app.emit_all("taskbar-display-status", next);
        }
    }

    fn open_manager(app: &AppHandle) {
        if let Some(window) = app.get_window("manager") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_dip_using_dpi() {
        assert_eq!(dip_to_px(120, 96), 120);
        assert_eq!(dip_to_px(120, 144), 180);
        assert_eq!(dip_to_px(120, 192), 240);
    }

    #[test]
    fn scales_taskbar_font_for_high_dpi_displays() {
        assert_eq!(taskbar_font_height(96), -12);
        assert_eq!(taskbar_font_height(144), -18);
        assert_eq!(taskbar_font_height(192), -24);
    }

    #[test]
    fn calculates_safe_region_without_negative_width() {
        assert_eq!(safe_region_width(600, 900, 6), 288);
        assert_eq!(safe_region_width(900, 600, 6), 0);
    }

    #[test]
    fn positions_win11_left_slot_between_widgets_and_centered_apps() {
        assert_eq!(modern_left_position(0, 760, 220, 4, 180), Some(184));
        assert_eq!(modern_left_position(0, 360, 220, 4, 180), None);
    }

    #[test]
    fn reserves_left_space_only_when_win11_widgets_are_enabled() {
        assert_eq!(win11_widgets_reserve_dip(true), 180);
        assert_eq!(win11_widgets_reserve_dip(false), 0);
    }

    #[test]
    fn plans_classic_taskbar_in_rebar_coordinates() {
        assert_eq!(
            classic_horizontal_layout(48, 1200, 280, 2, 240, false),
            Some((48, 918, 968))
        );
        assert_eq!(
            classic_horizontal_layout(48, 1200, 280, 2, 240, true),
            Some((330, 918, 48))
        );
        assert_eq!(classic_horizontal_layout(48, 500, 280, 2, 240, false), None);
    }

    #[test]
    fn rejects_unknown_display_mode() {
        assert_eq!(
            PriceDisplayMode::parse("bubble").unwrap(),
            PriceDisplayMode::Bubble
        );
        assert!(PriceDisplayMode::parse("always").is_err());
    }

    #[test]
    fn resolves_mode_fallback_and_recovery() {
        assert_eq!(
            resolved_display(PriceDisplayMode::Taskbar, true, false),
            "bubble"
        );
        assert_eq!(
            resolved_display(PriceDisplayMode::Taskbar, true, true),
            "taskbar"
        );
        assert_eq!(
            resolved_display(PriceDisplayMode::Bubble, true, true),
            "bubble"
        );
        assert_eq!(
            resolved_display(PriceDisplayMode::Taskbar, false, true),
            "hidden"
        );
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_windows_taskbar_theme() {
        let theme = unsafe { windows_host::system_uses_light_theme() };
        println!("system light theme: {theme:?}");
        assert!(theme.is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_windows_widgets_setting() {
        let enabled = unsafe { windows_host::win11_widgets_enabled() };
        println!("windows widgets enabled: {enabled:?}");
        assert!(enabled.is_some());
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn paginates_taskbar_items_four_at_a_time() {
        assert_eq!(windows_host::page_count(0), 1);
        assert_eq!(windows_host::page_count(4), 1);
        assert_eq!(windows_host::page_count(5), 2);
        assert_eq!(windows_host::page_count(9), 3);
    }
}
