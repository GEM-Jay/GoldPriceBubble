# -*- coding: utf-8 -*-
# 主入口
import os
import sys
import tkinter as tk
from tkinter import messagebox as msg

from core.resource import set_dpi_awareness
from core.singleton import check_single_instance
from utils.icons import set_window_icon
from ui.theme import apply_tencent_theme

from core.store import load as load_store, save as save_store
from ui.welcome import WelcomeSelector
from ui.bubble import Bubble
from ui.manager import ManagerWindow


def _ensure_tcltk():
    base = sys.base_prefix or sys.prefix
    tcl_cands = [os.path.join(base, "tcl", "tcl8.6"),
                 os.path.join(base, "tcl8.6"),
                 os.path.join(base, "Lib", "tcl8.6")]
    tk_cands  = [os.path.join(base, "tcl", "tk8.6"),
                 os.path.join(base, "tk8.6"),
                 os.path.join(base, "Lib", "tk8.6")]
    def pick(cands):
        for d in cands:
            if os.path.isfile(os.path.join(d, "init.tcl")) or os.path.isfile(os.path.join(d, "tk.tcl")):
                return d
        return None
    tcl_dir = pick(tcl_cands); tk_dir = pick(tk_cands)
    if tcl_dir and not os.environ.get("TCL_LIBRARY"): os.environ["TCL_LIBRARY"] = tcl_dir
    if tk_dir and not os.environ.get("TK_LIBRARY"):   os.environ["TK_LIBRARY"] = tk_dir
    dll_dir = os.path.join(base, "DLLs")
    if os.path.isdir(dll_dir):
        try: os.add_dll_directory(dll_dir)
        except Exception: os.environ["PATH"] = dll_dir + os.pathsep + os.environ.get("PATH", "")


class App:
    """启动逻辑： 1) 首次：打开选择器。
      2) 之后：创建 Bubble；更换展示只刷新文字，不重建、不移动。"""
    def __init__(self):
        self._single_lock = check_single_instance(port=56789)
        set_dpi_awareness()

        st = load_store()
        self.portfolios     = st.get("portfolios") or []
        self.active_index   = st.get("active_index")
        self.display_quotes = st.get("display_quotes") or []
        self.minimal_mode   = bool(st.get("minimal_mode", False))
        self.unit_overrides = st.get("unit_overrides") or {}

        _ensure_tcltk()

        self.root = tk.Tk()
        self.root.title("GoldPrice")
        try:
            self.root.overrideredirect(True)
            self.root.attributes("-alpha", 0.0)
        except Exception:
            pass
        self.root.geometry("0x0+0+0")
        set_window_icon(self.root)
        apply_tencent_theme(self.root)

        self.selector_win = None
        self.bubble = None

        if len(self.display_quotes) != 2:
            self.open_selector(mode="welcome")
        else:
            self.open_bubble()

    # 选择器
    def open_selector(self, mode: str = "welcome"):
        if self.selector_win:
            try: self.selector_win.destroy()
            except Exception: pass
            self.selector_win = None

        win = tk.Toplevel(self.root)
        self.selector_win = win
        win.title("选择展示数据" if mode != "welcome" else "欢迎使用 GoldPrice")
        set_window_icon(win)
        apply_tencent_theme(win)

        w, h = 780, 560
        try:
            sw = win.winfo_screenwidth(); sh = win.winfo_screenheight()
            x = max(0, (sw - w) // 2); y = max(0, (sh - h) // 3)
            win.geometry(f"{w}x{h}+{x}+{y}")
        except Exception:
            win.geometry("780x560")

        try:
            win.attributes("-topmost", True)
            win.transient(self.root)
            win.grab_set()
        except Exception:
            pass

        win.protocol("WM_DELETE_WINDOW", lambda w=win, m=mode: self._on_selector_close(w, m))

        header_text = ("欢迎使用 GoldPrice — 请选择正好两个关注品种"
                       if mode == "welcome"
                       else "请选择需要展示的两个品种（保存后立即应用）")

        sel = WelcomeSelector(
            win,
            header_text=header_text,
            min_pick=2,
            max_pick=2,
            on_confirm=lambda picks: self._on_select_confirm(win, picks, mode),
            on_cancel=lambda: self._on_select_cancel(win, mode)
        )
        sel.pack(fill="both", expand=True)

        def reflect():
            try:
                if hasattr(sel, "preset_selected"):
                    sel.preset_selected(self.display_quotes)
            except Exception:
                pass
        try: win.after(200, reflect)
        except Exception: pass

    def _on_select_confirm(self, win, picks, mode):
        if len(picks) != 2:
            msg.showwarning("选择不合法", "必须选择正好 2 个品种。"); return

        self.display_quotes = list(picks)
        self.save_all()

        try:
            try: win.grab_release()
            except Exception: pass
            win.destroy()
            self.selector_win = None
        except Exception:
            pass

        if mode == "welcome":
            self.open_bubble()
        else:
            if self.bubble and hasattr(self.bubble, "apply_quotes"):
                self.bubble.apply_quotes(self.display_quotes)

    def _on_select_cancel(self, win, mode):
        try:
            try: win.grab_release()
            except Exception: pass
            win.destroy()
            self.selector_win = None
        except Exception:
            pass
        if mode == "welcome":
            self.quit()

    def _on_selector_close(self, win, mode):
        try:
            try: win.grab_release()
            except Exception: pass
            win.destroy()
            self.selector_win = None
        except Exception:
            pass
        if mode == "welcome":
            self.quit()

    # Bubble
    def open_bubble(self):
        bubble_win = tk.Toplevel(self.root)
        try:
            bubble_win.overrideredirect(True)
            bubble_win.attributes("-topmost", True)
        except Exception:
            pass
        bubble_win.geometry("+1040+470")

        def open_manager_cb():
            ManagerWindow(self)

        def open_selector_cb():
            self.open_selector(mode="change")

        def autostart_changed_cb():
            pass

        self.bubble = Bubble(
            bubble_win,
            portfolios_state={
                "portfolios": self.portfolios,
                "active_index": self.active_index,
                "display_quotes": self.display_quotes,
                "minimal_mode": self.minimal_mode,
                "unit_overrides": self.unit_overrides,
                "on_open_manager": open_manager_cb,
                "on_open_selector": open_selector_cb,
                "on_autostart_changed": autostart_changed_cb,
            }
        )

        # 默认自启
        try:
            if not self.bubble._is_autostart_enabled():
                self.bubble._set_autostart(True)
        except Exception:
            pass

    # 仓变更回调
    def notify_portfolios_changed(self, portfolios, active_index=None):
        self.portfolios   = portfolios or []
        self.active_index = active_index
        self.save_all()
        if self.bubble and hasattr(self.bubble, "reload_all"):
            self.bubble.reload_all(
                display_quotes=self.display_quotes,
                portfolios=self.portfolios,
                active_index=self.active_index
            )

    # 存储
    def save_all(self):
        try:
            save_store(self.portfolios, self.active_index, self.display_quotes)
        except Exception:
            pass

    # 退出
    def quit(self):
        try:
            if self.bubble and hasattr(self.bubble, "_quit"):
                self.bubble._running = False
                self.bubble._quit()
                return
        except Exception:
            pass
        try: self.root.quit()
        except Exception: pass
        try: self.root.destroy()
        except Exception: pass


if __name__ == "__main__":
    App()
    tk.mainloop()
