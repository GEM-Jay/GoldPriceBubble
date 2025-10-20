# -*- coding: utf-8 -*-
import sys, os, shutil, threading, time
import tkinter as tk
from tkinter import font as tkfont
import tkinter.messagebox as msg
import winreg, pystray

from core.styles import (
    T_BLUE, T_LONDON, T_GREEN, T_RED, T_TEXT_2,
    BORDER_COLOR, BORDER_PX,
    FONT_FAMILY, FONT_PRICE_PX, FONT_PNL_PX,
    CORNER_RADIUS_PX,
)
from core.resource import get_scaling, data_dir_in_appdata
from utils.icons import tray_image
from core.prices import probe_all_lines

try:
    from core.store import APP_DIR
except Exception:
    APP_DIR = "GoldPriceBubble"

# 透明键与卡片底色
TRANSPARENT_KEY = "#FF00FE"    # 窗口透明色键
CARD_FILL       = "#EDEDED"    # 237,237,237 圆角卡片背景

# 右下角锚定偏移
ANCHOR_SIDE_PX  = 20   # 距右侧
ANCHOR_BOTTOM_PX= 60   # 距底部

class Bubble:
    def __init__(self, root, portfolios_state):
        self.root  = root
        self.state = portfolios_state or {}
        self.scale = get_scaling()

        # 初始尺寸（运行中会自适应）
        self.WIDTH   = int(240 * self.scale)
        self.LINE_H  = int(22 * self.scale)
        self.TOP_Y   = int(10 * self.scale)
        self.HEIGHT  = int(56 * self.scale)
        self.side_pad  = int(16 * self.scale)
        self.min_width = int(160 * self.scale)
        self.max_width = int(520 * self.scale)

        # 字体（加粗）
        self.tkfont_price = tkfont.Font(family=FONT_FAMILY, size=int(FONT_PRICE_PX * self.scale), weight="bold")
        self.tkfont_pnl   = tkfont.Font(family=FONT_FAMILY, size=int(FONT_PNL_PX   * self.scale), weight="bold")

        # 透明窗口（显示圆角）
        try:
            self.root.attributes("-transparentcolor", TRANSPARENT_KEY)
        except Exception:
            pass

        self.canvas = tk.Canvas(self.root, width=self.WIDTH, height=self.HEIGHT,
                                highlightthickness=0, bg=TRANSPARENT_KEY)
        self.canvas.pack()

        # 状态
        self.display_quotes = list(self.state.get("display_quotes") or [])  # 原始名称列表（来自 welcome）
        self.line_colors    = [T_BLUE, T_LONDON]  # 保留你的配色
        self._running = True
        self._wake    = False   # 小唤醒旗标：收到 apply/reload 后立即刷新

        # 初始绘制
        self._draw_card()
        self.line_ids = []
        self.pnl_text = None
        self._layout_texts()

        # 初始就定位到右下角（+偏移）
        self._snap_to_bottom_right()

        # 拖动
        self._drag_start = None
        self.canvas.bind("<ButtonPress-1>", self._on_drag_start)
        self.canvas.bind("<B1-Motion>", self._on_drag_motion)

        # 刷新线程
        threading.Thread(target=self._loop, daemon=True).start()

        # 托盘
        self.icon = None
        self._start_tray()

    # ========== 对外：欢迎页确认后只刷新文字 ==========
    def apply_quotes(self, names):
        """只更新展示名称；不改变窗口位置，不重建托盘。"""
        self.display_quotes = list(names or [])
        # 行数可能变化，重铺文本项
        line_count = max(1, min(2, len(self.display_quotes)))
        if len(self.line_ids) != line_count:
            self._layout_texts()
        # 唤醒立即刷新
        self._wake = True
        try:
            self.root.after(0, lambda: None)
        except Exception:
            pass

    # ========== 对外：改仓后整体刷新（不移动，不重建） ==========
    def reload_all(self, display_quotes=None, portfolios=None, active_index=None):
        if display_quotes is not None:
            self.display_quotes = list(display_quotes or [])
        if portfolios is not None:
            self.state["portfolios"] = list(portfolios or [])
        if active_index is not None:
            self.state["active_index"] = active_index

        line_count = max(1, min(2, len(self.display_quotes)))
        if len(self.line_ids) != line_count:
            self._layout_texts()

        self._wake = True
        try:
            self.root.after(0, lambda: None)
        except Exception:
            pass

    # ========== 右下角锚定 ==========
    def _snap_to_bottom_right(self):
        """把窗口锚定在屏幕右下角，距离右侧 20、底部 60。"""
        try:
            self.root.update_idletasks()
            sw = self.root.winfo_screenwidth()
            sh = self.root.winfo_screenheight()
            x = max(0, sw - self.WIDTH  - ANCHOR_SIDE_PX)
            y = max(0, sh - self.HEIGHT - ANCHOR_BOTTOM_PX)
            self.root.geometry(f"+{x}+{y}")
        except Exception:
            pass

    # ========== 卡片绘制 ==========
    def _draw_card(self):
        try:
            self.canvas.delete("bg_card")
        except Exception:
            pass
        x, y = 0, 0
        w, h = self.WIDTH, self.HEIGHT
        r = int(CORNER_RADIUS_PX * self.scale)
        self._rounded_rect(x+1, y+1, w-2, h-2, r,
                           fill=CARD_FILL, outline=BORDER_COLOR, width=BORDER_PX, tag="bg_card")
        try:
            self.canvas.tag_lower("bg_card")   # 背景置底
        except Exception:
            pass

    def _rounded_rect(self, x, y, w, h, r, fill=None, outline=None, width=1, tag=None):
        kw = dict(outline=fill, fill=fill, tags=tag)
        c  = self.canvas
        c.create_arc(x, y, x+2*r, y+2*r, start=90, extent=90, style="pieslice", **kw)
        c.create_arc(x+w-2*r, y, x+w, y+2*r, start=0, extent=90, style="pieslice", **kw)
        c.create_arc(x, y+h-2*r, x+2*r, y+h, start=180, extent=90, style="pieslice", **kw)
        c.create_arc(x+w-2*r, y+h-2*r, x+w, y+h, start=270, extent=90, style="pieslice", **kw)
        c.create_rectangle(x+r, y, x+w-r, y+h, **kw)
        c.create_rectangle(x, y+r, x+r, y+h-r, **kw)
        c.create_rectangle(x+w-r, y+r, x+w, y+h-r, **kw)
        c.create_rectangle(x, y, x+w, y+h, outline=outline, width=width, tags=tag)

    # ========== 文本布局 ==========
    def _layout_texts(self):
        self.canvas.config(height=self.HEIGHT)
        self._draw_card()
        self.line_ids = []
        for i in range(max(1, min(2, len(self.display_quotes)))):
            tid = self.canvas.create_text(self.WIDTH // 2, self.TOP_Y + i * self.LINE_H,
                                          anchor="center", fill=self.line_colors[i % 2])
            self.line_ids.append(tid)
        # pnl 文本先不创建，交给 _ensure_pnl_line 根据是否有持仓动态建/删
        self._ensure_pnl_line(False, self.LINE_H)

    def _ensure_pnl_line(self, want_ports: bool, line_h: int):
        """根据是否有持仓动态创建/删除 pnl_text，并放在价格行下方。"""
        if want_ports and self.pnl_text is None:
            y = self.TOP_Y + line_h * len(self.line_ids)
            self.pnl_text = self.canvas.create_text(self.WIDTH // 2, y, anchor="center", fill=T_TEXT_2)
        elif (not want_ports) and self.pnl_text is not None:
            try:
                self.canvas.delete(self.pnl_text)
            except Exception:
                pass
            self.pnl_text = None

    # ========== 交互：拖动 ==========
    def _on_drag_start(self, e):
        try:
            self._drag_start = (e.x_root - self.root.winfo_x(), e.y_root - self.root.winfo_y())
        except Exception:
            self._drag_start = None

    def _on_drag_motion(self, e):
        if not self._drag_start:
            return
        try:
            dx, dy = self._drag_start
            self.root.geometry(f"+{e.x_root - dx}+{e.y_root - dy}")
        except Exception:
            pass

    # ========== 字体自适配（加粗） ==========
    def _fit_all_texts(self, texts, base_px):
        max_w = int(self.WIDTH * 0.92)
        size  = max(10, int(base_px * self.scale))
        probe = tkfont.Font(family=FONT_FAMILY, size=size, weight="bold")
        def w(s): return probe.measure("" if s is None else str(s))
        while size > 9:
            probe.configure(size=size)
            if all((t is None) or (w(t) <= max_w) for t in texts if t):
                break
            size -= 1
        return tkfont.Font(family=FONT_FAMILY, size=size, weight="bold")

    # ========== 文本垂直居中 ==========
    def _centerline_ys(self, line_count: int, has_pnl: bool, line_h: int):
        pad   = int(8 * self.scale)
        total = line_count + (1 if has_pnl else 0)
        block_h = max(1, total) * line_h
        start_center = max(pad + line_h // 2, (self.HEIGHT - block_h) // 2 + line_h // 2)
        ys     = [start_center + i * line_h for i in range(line_count)]
        pnl_y  = start_center + line_count * line_h if has_pnl else None
        return ys, pnl_y

    # ========== 刷新线程 ==========
    def _loop(self):
        import _tkinter

        # 显示别名（仅 UI）
        def show_alias(raw: str) -> str:
            n = (raw or "").strip()
            n = n.replace("(JD)", "").strip()
            n = n.replace("（现货黄金）", "")
            for k in ("黄金延期", "黄金T+D", "Au(T+D)"):
                if k in n:
                    return "上海金"
            if "伦敦金" in n:
                return "伦敦金"
            return n

        # 单位
        def unit_for_show(show: str) -> str:
            if show == "上海金":
                return "¥"
            if "伦敦金" in show:
                return "$"
            return "¥"

        while self._running:
            # 1) 抓价（原始名 -> 价格）
            price_map_raw = {}
            try:
                for s in probe_all_lines():
                    try:
                        name, price = s.split(",", 1)
                    except ValueError:
                        continue
                    name = name.strip()
                    try:
                        val = float(price.strip()) if price.strip() else None
                    except Exception:
                        val = None
                    if name not in price_map_raw:
                        price_map_raw[name] = val
            except Exception:
                pass

            # 2) 投递到主线程渲染
            def apply():
                if not self._running:
                    return
                try:
                    if not (self.canvas and str(self.canvas)):
                        return
                except Exception:
                    return

                # 价格行文本
                line_count = max(1, min(2, len(self.display_quotes or [])))
                texts = []
                for i in range(line_count):
                    raw = self.display_quotes[i] if i < len(self.display_quotes or []) else None
                    if not raw:
                        txt = "未选择品种"
                    else:
                        price = price_map_raw.get(raw)
                        show  = show_alias(raw)
                        unit  = unit_for_show(show)
                        txt = (f"{show}:  {price:.2f} {unit}"
                               if isinstance(price, (int, float))
                               else f"{show}: 获取中...")
                    texts.append(txt)

                # 盈亏：参考所选“上海金”（黄金延期/黄金T+D/Au(T+D) 任何一个）
                ports = self.state.get("portfolios") or []
                inner_price = None
                if ports:
                    for key, val in price_map_raw.items():
                        if any(k in key for k in ("黄金延期", "黄金T+D", "Au(T+D)")):
                            inner_price = val
                            break

                pnl_line = None
                if ports:
                    if isinstance(inner_price, (int, float)):
                        total = sum(p["grams"] * (inner_price - p["cost_per_g"]) for p in ports)
                        pnl_line = f"总仓盈亏:  {total:+.2f} ¥"
                    else:
                        pnl_line = "总仓盈亏: -- ¥"

                # 自适配字体
                fnt    = self._fit_all_texts(texts + [pnl_line], FONT_PRICE_PX)
                line_h = max(self.LINE_H, int(fnt.metrics("linespace")))
                pad    = int(8 * self.scale)

                # 动态建/删 pnl_text
                self._ensure_pnl_line(bool(ports), line_h)
                has_pnl = self.pnl_text is not None

                # 高度（变化则立即重绘并重新锚定右下）
                wanted_h = pad * 2 + (line_count + (1 if has_pnl else 0)) * line_h
                if wanted_h != self.HEIGHT:
                    self.HEIGHT = wanted_h
                    self.canvas.config(height=self.HEIGHT)
                    self._draw_card()
                    self._snap_to_bottom_right()

                # 宽度（用最终字体测量，变化则重新锚定右下）
                measure = fnt.measure
                longest = 0
                for t in texts + [pnl_line]:
                    if t:
                        longest = max(longest, measure(str(t)))
                target_w = int(longest * 1.2) + self.side_pad * 2
                new_w = max(self.min_width, min(self.max_width, target_w))
                if new_w != self.WIDTH:
                    self.WIDTH = new_w
                    self.canvas.config(width=self.WIDTH)
                    self._draw_card()
                    self._snap_to_bottom_right()

                # 行数变化时重铺文本行
                if len(self.line_ids) != line_count:
                    self._layout_texts()

                # 垂直居中坐标
                ys, pnl_y = self._centerline_ys(line_count, has_pnl, line_h)

                try:
                    for i, tid in enumerate(self.line_ids[:line_count]):
                        self.canvas.itemconfig(tid, text=texts[i], font=fnt, fill=self.line_colors[i % 2])
                        self.canvas.coords(tid, self.WIDTH // 2, ys[i])

                    if has_pnl and self.pnl_text is not None:
                        color = T_TEXT_2
                        if isinstance(inner_price, (int, float)):
                            total = sum(p["grams"] * (inner_price - p["cost_per_g"]) for p in ports)
                            color = T_GREEN if total >= 0 else T_RED
                        self.canvas.itemconfig(self.pnl_text, text=(pnl_line or ""), font=fnt, fill=color)
                        self.canvas.coords(self.pnl_text, self.WIDTH // 2,
                                           pnl_y if pnl_y is not None else ys[-1] + line_h)
                except _tkinter.TclError:
                    return

            try:
                if self._running:
                    self.root.after(0, apply)
            except Exception:
                pass

            # 2 秒节奏，但收到唤醒则立即刷新
            for _ in range(20):
                if not self._running or self._wake:
                    break
                time.sleep(0.1)
            self._wake = False

    # ========== 托盘与菜单 ==========
    def _start_tray(self):
        if getattr(self, "icon", None):  # 已有托盘就不再创建
            return

        def open_selector(icon, item):
            cb = self.state.get("on_open_selector")
            if callable(cb):
                self.root.after(0, cb)

        def open_manager(icon, item):
            cb = self.state.get("on_open_manager")
            if callable(cb):
                self.root.after(0, cb)

        def toggle_autostart(icon, item):
            self.root.after(0, lambda: self._toggle_autostart(icon, item))

        def toggle_window(icon, item):
            self.root.after(0, self._toggle_win)

        def on_quit(icon, item):
            self.root.after(0, self._quit)

        def clear_data(icon, item):
            self.root.after(0, self._clear_data_confirm)

        more = pystray.Menu(pystray.MenuItem("清除数据…", clear_data),
                            pystray.MenuItem("退出", on_quit))
        menu = pystray.Menu(
            pystray.MenuItem("显示/隐藏窗口", toggle_window),
            pystray.MenuItem("更换展示数据…", open_selector),
            pystray.MenuItem("自定义仓库…", open_manager),
            pystray.MenuItem("开机自启动", toggle_autostart, checked=lambda _: self._is_autostart_enabled()),
            pystray.MenuItem("更多", more),
        )
        self.icon = pystray.Icon("gold_ball", tray_image(), "GoldPriceBubble", menu)
        threading.Thread(target=self.icon.run, daemon=True).start()

    def _toggle_win(self):
        try:
            if self.root.state() == "withdrawn":
                self.root.deiconify()
            else:
                self.root.withdraw()
        except Exception:
            pass

    # ========== 退出 ==========
    def _quit(self):
        try:
            if self.icon:
                self.icon.visible = False
                self.icon.stop()
        except Exception:
            pass
        self._running = False
        try:
            self.root.after(0, self.root.quit)
        except Exception:
            pass
        try:
            self.root.after(0, self.root.destroy)
        except Exception:
            pass

    # ========== 开机自启 ==========
    def _exe_path_for_autostart(self) -> str:
        if getattr(sys, "frozen", False):
            return sys.executable
        return os.path.abspath(sys.argv[0])

    def _set_autostart(self, enable: bool):
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        name = "GoldPriceBubble"
        try:
            reg = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE)
            if enable:
                winreg.SetValueEx(reg, name, 0, winreg.REG_SZ, self._exe_path_for_autostart())
            else:
                try:
                    winreg.DeleteValue(reg, name)
                except FileNotFoundError:
                    pass
            winreg.CloseKey(reg)
        except Exception:
            pass

    def _toggle_autostart(self, icon, item):
        status = self._is_autostart_enabled()
        self._set_autostart(not status)
        try:
            icon.update_menu()
        except Exception:
            pass
        cb = self.state.get("on_autostart_changed")
        if callable(cb):
            cb()

    def _is_autostart_enabled(self) -> bool:
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        name = "GoldPriceBubble"
        try:
            reg = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ)
            _ = winreg.QueryValueEx(reg, name)
            winreg.CloseKey(reg)
            return True
        except Exception:
            return False

    # ========== 清除数据（清除并退出） ==========
    def _clear_data_confirm(self):
        if not msg.askyesno("清除数据", "这将清空所有用户数据（仓库/设置等），exe 不会被删除。\n\n确定继续吗？"):
            return
        try:
            user_data_dir = data_dir_in_appdata(APP_DIR)
            if os.path.isdir(user_data_dir):
                shutil.rmtree(user_data_dir, ignore_errors=True)
        except Exception:
            pass
        # 先告知，再退出
        msg.showinfo("完成", "已清理数据。程序将退出。")
        self._quit()
