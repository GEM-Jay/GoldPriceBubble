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
            fallback_reason: Some("unsupported_os".to_string()),
            user_visible: false,
        }
    }
}

struct SharedState {
    requested_mode: PriceDisplayMode,
    user_visible: bool,
    payload: TaskbarDisplayPayload,
    status: TaskbarDisplayStatus,
    app: Option<AppHandle>,
    status_callback: Option<StatusCallback>,
}

pub struct TaskbarHost {
    shared: Arc<Mutex<SharedState>>,
}

pub type StatusCallback = Arc<dyn Fn(TaskbarDisplayStatus) + Send + Sync>;

impl TaskbarHost {
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Mutex::new(SharedState {
                requested_mode: PriceDisplayMode::Bubble,
                user_visible: false,
                payload: TaskbarDisplayPayload::default(),
                status: TaskbarDisplayStatus::default(),
                app: None,
                status_callback: None,
            })),
        }
    }

    pub fn start(&self, app: AppHandle, status_callback: StatusCallback) {
        {
            let mut shared = self.shared.lock().unwrap();
            shared.app = Some(app);
            shared.status_callback = Some(status_callback);
        }
        self.publish();
    }

    pub fn set_mode(&self, mode: PriceDisplayMode) {
        self.shared.lock().unwrap().requested_mode = mode;
        self.publish();
    }

    pub fn set_user_visible(&self, visible: bool) {
        self.shared.lock().unwrap().user_visible = visible;
        self.publish();
    }

    pub fn update(&self, payload: TaskbarDisplayPayload) {
        self.shared.lock().unwrap().payload = payload;
    }

    pub fn status(&self) -> TaskbarDisplayStatus {
        self.shared.lock().unwrap().status.clone()
    }

    pub fn restore_taskbar(&self) {}

    fn publish(&self) {
        let (next, app, callback, changed) = {
            let mut shared = self.shared.lock().unwrap();
            let next = TaskbarDisplayStatus {
                supported: false,
                requested_mode: shared.requested_mode,
                actual_display: if shared.user_visible {
                    "bubble".to_string()
                } else {
                    "hidden".to_string()
                },
                attached: false,
                fallback_reason: Some("unsupported_os".to_string()),
                user_visible: shared.user_visible,
            };
            let changed = shared.status != next;
            shared.status = next.clone();
            (
                next,
                shared.app.clone(),
                shared.status_callback.clone(),
                changed,
            )
        };
        if changed {
            if let Some(callback) = callback {
                callback(next.clone());
            }
            if let Some(app) = app {
                let _ = app.emit_all("taskbar-display-status", next);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unknown_display_mode() {
        assert_eq!(
            PriceDisplayMode::parse("bubble").unwrap(),
            PriceDisplayMode::Bubble
        );
        assert!(PriceDisplayMode::parse("always").is_err());
    }
}
