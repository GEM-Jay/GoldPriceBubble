# -*- coding: utf-8 -*-
import sys
import tkinter as tk
from tkinter import messagebox as msg

# 基础设施
from core.resource import set_dpi_awareness
from core.singleton import check_single_instance
from utils.icons import set_window_icon
from ui.theme import apply_tencent_theme

# 数据存取
from core.store import load as load_store, save as save_store

# 子窗口
from ui.welcome import WelcomeSelector
from ui.bubble import Bubble
from ui.manager import ManagerWindow


class App:
    """
    GoldPrice 启动应用：
      1) 首次/未选满2个 -> 显示欢迎选择器（必须正好2个）。
      2) 欢迎页确认 -> 创建一次 Bubble。
         更换展示数据确认 -> 仅刷新已有 Bubble 的文字（apply_quotes），不重建、不移动。
      3) 托盘：显示/隐藏、更换展示数据、自定义仓库、开机自启动、更多（清除数据/退出）。
    """
    def __init__(self):
        # 单实例、防 DPI 模糊
        self._single_lock = check_single_instance(port=56789)
        set_dpi_awareness()

        # 载入历史
        st = load_store()
        self.portfolios = st.get("portfolios") or []
        self.active_index = st.get("active_index")
        self.display_quotes = st.get("display_quotes") or []   # 原始名称列表

        # Tk 根窗体（0×0 全透明常驻父窗口）
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

        # 占位
        self.welcome = None
        self.selector_win = None
        self.bubble = None

        # 进入流程
        if len(self.display_quotes) != 2:
            self.open_selector(mode="welcome")
        else:
            self.open_bubble()

    # ---------- 欢迎/选择器 ----------
    def open_selector(self, mode: str = "welcome"):
        # 关闭旧选择窗口
        if self.welcome:
            try: self.welcome.destroy()
            except Exception: pass
            self.welcome = None
        if self.selector_win:
            try: self.selector_win.destroy()
            except Exception: pass
            self.selector_win = None

        # 新建选择窗（Toplevel）
        win = tk.Toplevel(self.root)
        self.selector_win = win
        win.title("选择展示数据" if mode != "welcome" else "欢迎使用 GoldPrice")
        set_window_icon(win)
        apply_tencent_theme(win)

        # 尺寸并居中
        w, h = 780, 560
        try:
            sw = win.winfo_screenwidth(); sh = win.winfo_screenheight()
            x = max(0, (sw - w) // 2); y = max(0, (sh - h) // 3)
            win.geometry(f"{w}x{h}+{x}+{y}")
        except Exception:
            win.geometry("780x560")

        # 置顶 + 模态
        try:
            win.attributes("-topmost", True)
            win.transient(self.root)
            win.grab_set()
        except Exception:
            pass

        # 右上角 X 行为：首次欢迎页 -> 退出；更换模式 -> 仅关闭
        win.protocol("WM_DELETE_WINDOW", lambda m=mode, w=win: self._on_selector_close(w, m))

        header_text = ("欢迎使用 GoldPrice — 请选择正好两个关注品种"
                       if mode == "welcome"
                       else "请选择需要展示的两个品种（保存后立即应用）")

        self.welcome = WelcomeSelector(
            win,
            header_text=header_text,
            min_pick=2,
            max_pick=2,
            on_confirm=lambda picks: self._on_select_confirm(win, picks, mode),
            on_cancel=lambda: self._on_select_cancel(win, mode)
        )
        self.welcome.pack(fill="both", expand=True)

        # 回显历史（原始名称）
        def reflect():
            try:
                if hasattr(self.welcome, "preset_selected"):
                    self.welcome.preset_selected(self.display_quotes)
            except Exception:
                pass
        try:
            win.after(200, reflect)
        except Exception:
            pass

    def _on_select_confirm(self, win, picks, mode):
        if len(picks) != 2:
            msg.showwarning("选择不合法", "必须选择正好 2 个品种。")
            return

        # 保存（原始名称）
        self.display_quotes = list(picks)
        self.save_all()

        # 关闭选择窗
        try:
            try: win.grab_release()
            except Exception: pass
            win.destroy()
            self.selector_win = None
        except Exception:
            pass

        if mode == "welcome":
            # 首次：创建一次 Bubble
            self.open_bubble()
        else:
            # 更换展示数据：只刷新已有 Bubble 文本
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
            self.quit()  # 首次欢迎页取消 => 退出

    def _on_selector_close(self, win, mode):
        # 点窗口右上角 X 的行为
        try:
            try: win.grab_release()
            except Exception: pass
            win.destroy()
            self.selector_win = None
        except Exception:
            pass
        if mode == "welcome":
            self.quit()  # 首次欢迎页关闭 => 退出

    # ---------- Bubble ----------
    def open_bubble(self):
        # 建立 Bubble 容器窗口（只在 welcome 后或有历史时建一次）
        bubble_win = tk.Toplevel(self.root)
        bubble_win.overrideredirect(True)
        bubble_win.attributes("-topmost", True)
        # 一个初始位置；你的 Bubble 内部如果有“吸附右下角”，会自行纠正
        bubble_win.geometry("+1040+470")

        def open_manager_cb():
            # 打开自定义仓库
            mw = ManagerWindow(self)
            # 建议在 ManagerWindow 保存时调用：
            #   self.app.notify_portfolios_changed(portfolios, active_index)

        def open_selector_cb():
            # 更换展示数据（不会重建 Bubble）
            self.open_selector(mode="change")

        def autostart_changed_cb():
            pass

        self.bubble = Bubble(
            bubble_win,
            portfolios_state={
                "portfolios": self.portfolios,
                "active_index": self.active_index,
                "display_quotes": self.display_quotes,
                "on_open_manager": open_manager_cb,
                "on_open_selector": open_selector_cb,
                "on_autostart_changed": autostart_changed_cb,
            }
        )

        # 默认开启开机自启（若尚未开启）
        try:
            if not self.bubble._is_autostart_enabled():
                self.bubble._set_autostart(True)
        except Exception:
            pass

    # 供 ManagerWindow 在保存后调用（推荐）
    def notify_portfolios_changed(self, portfolios, active_index=None):
        self.portfolios = portfolios or []
        self.active_index = active_index
        self.save_all()
        if self.bubble and hasattr(self.bubble, "reload_all"):
            # 即时刷新气泡（行数、高度、盈亏都会跟随变化），不移动、不重建
            self.bubble.reload_all(
                display_quotes=self.display_quotes,
                portfolios=self.portfolios,
                active_index=self.active_index
            )

    # ---------- 存储 ----------
    def save_all(self):
        try:
            save_store(self.portfolios, self.active_index, self.display_quotes)
        except Exception:
            pass

    # ---------- 退出 ----------
    def quit(self):
        try:
            if self.bubble and hasattr(self.bubble, "_quit"):
                self.bubble._running = False
                self.bubble._quit()
                return
        except Exception:
            pass
        try:
            self.root.quit()
        except Exception:
            pass
        try:
            self.root.destroy()
        except Exception:
            pass


if __name__ == "__main__":
    App()
    tk.mainloop()
