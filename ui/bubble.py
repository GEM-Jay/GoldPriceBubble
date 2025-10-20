# ui/bubble.py
import sys, os, shutil, threading, time, re
import tkinter as tk
from tkinter import font as tkfont
import tkinter.messagebox as msg
import winreg, pystray

try:
    from PIL import Image, ImageDraw, ImageFont, ImageTk
    _PIL_OK = True
except Exception:
    _PIL_OK = False

from core.styles import (
    T_BLUE, T_LONDON, T_GREEN, T_RED, T_TEXT_2,
    BORDER_COLOR, BORDER_PX, FONT_FAMILY, FONT_PRICE_PX, FONT_PNL_PX,
    CORNER_RADIUS_PX,
    MINIMAL_FONT_FAMILY, MINIMAL_FONT_SCALE, MINIMAL_FONT_WEIGHT,
    MINIMAL_COLOR_1, MINIMAL_COLOR_2,
)

try:
    from core.styles import MINIMAL_FONT_PX
except Exception:
    MINIMAL_FONT_PX = None

from core.resource import get_scaling, data_dir_in_appdata
from utils.icons import tray_image
from core.prices import probe_all_lines

try:
    from core.store import APP_DIR
except Exception:
    APP_DIR = "GoldPriceBubble"

# ===== 统一配置 =====
SPREAD_NAME = "伦-纽差价"
LONDON_KEY  = "伦敦金（现货黄金）"
NEWYORK_KEY = "纽约黄金"

TRANSPARENT_KEY   = "#FF00FE"
CARD_FILL         = "#EDEDED"
ANCHOR_SIDE_PX    = 20
ANCHOR_BOTTOM_PX  = 60


class Bubble:
    def __init__(self, root, portfolios_state):
        self.root  = root
        self.state = portfolios_state or {}
        self.scale = get_scaling()

        self.WIDTH   = int(240 * self.scale)
        self.HEIGHT  = int(56 * self.scale)
        self.side_pad  = int(16 * self.scale)
        self.min_width = int(160 * self.scale)
        self.max_width = int(560 * self.scale)

        try:
            self.root.attributes("-transparentcolor", TRANSPARENT_KEY)
        except Exception:
            pass

        self.canvas = tk.Canvas(self.root, width=self.WIDTH, height=self.HEIGHT,
                                highlightthickness=0, bg=TRANSPARENT_KEY)
        self.canvas.pack()

        # 状态
        self.display_quotes  = list(self.state.get("display_quotes") or [])
        self.line_colors     = [T_BLUE, T_LONDON]                   # 完整模式颜色
        self.min_line_colors = [MINIMAL_COLOR_1, MINIMAL_COLOR_2]   # 极简模式颜色
        self._running = True
        self._wake    = False

        # 模式 & 悬停/拖动
        self.minimal_mode  = bool(self.state.get("minimal_mode", False))
        self._hovering     = False
        self._user_dragged = False
        self._render_mode  = "minimal" if self.minimal_mode else "full"

        self._last_full_font = None

        # 极简窗口
        self._img_items = []

        # 画布对象
        self.line_ids = []
        self.pnl_text = None
        self._layout_texts()

        # 初始定位
        self._draw_card()
        self._snap_to_bottom_right()

        # 拖动
        self._drag_start = None
        self.canvas.bind("<ButtonPress-1>", self._on_drag_start)
        self.canvas.bind("<B1-Motion>", self._on_drag_motion)

        # 悬停
        self.canvas.bind("<Enter>", lambda e: self._on_hover(True))
        self.canvas.bind("<Leave>", lambda e: self._on_hover(False))

        # 刷新线程
        threading.Thread(target=self._loop, daemon=True).start()

        # 托盘
        self.icon = None
        self._start_tray()

    def apply_quotes(self, names):
        self.display_quotes = list(names or [])
        lc = max(1, min(2, len(self.display_quotes)))
        if len(self.line_ids) != lc:
            self._layout_texts()
        self._wake = True
        try:
            self.root.after(0, lambda: None)
        except Exception:
            pass

    # 整体刷新
    def reload_all(self, display_quotes=None, portfolios=None, active_index=None):
        if display_quotes is not None:
            self.display_quotes = list(display_quotes or [])
        if portfolios is not None:
            self.state["portfolios"] = list(portfolios or [])
        if active_index is not None:
            self.state["active_index"] = active_index

        lc = max(1, min(2, len(self.display_quotes)))
        if len(self.line_ids) != lc:
            self._layout_texts()

        self._wake = True
        try:
            self.root.after(0, lambda: None)
        except Exception:
            pass

    #  切换摸鱼模式
    def _prepare_mode(self, mode: str):
        if mode == self._render_mode:
            return
        self._clear_pil_images()
        try:
            for tid in self.line_ids:
                self.canvas.itemconfig(tid, text="")
            if self.pnl_text:
                self.canvas.itemconfig(self.pnl_text, text="")
        except Exception:
            pass
        self._render_mode = mode

    def _on_hover(self, is_enter: bool):
        self._hovering = bool(is_enter)
        target = "full" if (self._hovering or not self.minimal_mode) else "minimal"
        self._prepare_mode(target)
        self._wake = True
        try:
            self.root.after(0, self._draw_card)
        except Exception:
            pass

    def _snap_to_bottom_right(self):
        try:
            self.root.update_idletasks()
            sw = self.root.winfo_screenwidth(); sh = self.root.winfo_screenheight()
            x = max(0, sw - self.WIDTH  - ANCHOR_SIDE_PX)
            y = max(0, sh - self.HEIGHT - ANCHOR_BOTTOM_PX)
            self.root.geometry(f"+{x}+{y}")
        except Exception:
            pass

    def _draw_card(self):
        try:
            self.canvas.delete("bg_card")
        except Exception:
            pass

        # 极简非悬停：完全透明
        if self.minimal_mode and (not self._hovering):
            return

        w, h = self.WIDTH, self.HEIGHT
        r = int(CORNER_RADIUS_PX * self.scale)
        self._rounded_rect(1, 1, w-2, h-2, r,
                           fill=CARD_FILL, outline=BORDER_COLOR, width=BORDER_PX, tag="bg_card")
        try:
            self.canvas.tag_lower("bg_card")
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

    # 文本占位
    def _layout_texts(self):
        self.line_ids = []
        for _ in range(max(1, min(2, len(self.display_quotes)))):
            tid = self.canvas.create_text(self.WIDTH // 2, 0, anchor="center", fill=T_BLUE)
            self.line_ids.append(tid)
        self._ensure_pnl_line(False, 16)  # 初始占位，真实行高运行时计算

    def _ensure_pnl_line(self, want_ports: bool, line_h: int):
        if want_ports and self.pnl_text is None:
            self.pnl_text = self.canvas.create_text(self.WIDTH // 2, 0, anchor="center", fill=T_TEXT_2)
        elif (not want_ports) and self.pnl_text is not None:
            try:
                self.canvas.delete(self.pnl_text)
            except Exception:
                pass
            self.pnl_text = None

    # 拖动逻辑
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
            self._user_dragged = True
        except Exception:
            pass

    # 名称清洗
    def _normalize_name(self, raw: str) -> str:
        if not raw:
            return ""
        if raw == SPREAD_NAME:
            return SPREAD_NAME
        name = re.sub(r"[（(][^（）()]*[）)]", "", str(raw))
        for k in ("(JD)", "（现货黄金）", "现货", "报价", "价格"):
            name = name.replace(k, "")
        name = name.strip()
        key  = name.upper()
        if any(k in key for k in ("黄金延期", "黄金T+D", "AU(T+D)", "AUTD")): return "上海金"
        if any(k in key for k in ("伦敦金", "XAUUSD", "COMEX", "NYGOLD", "GC")): return "伦敦金"
        if any(k in key for k in ("白银TD", "AGTD", "白银延期")):             return "上海银"
        if any(k in key for k in ("XAGUSD", "SILVER", "NY SILVER", "SI")):   return "伦敦银"
        return name or ""

    # 单位（虚拟项返回空串，文案自行拼 %）
    def _resolve_unit(self, normalized_name: str) -> str:
        if normalized_name == SPREAD_NAME:
            return ""
        ov = self.state.get("unit_overrides") or {}
        if isinstance(ov, dict) and ov:
            if normalized_name in ov: return ov[normalized_name]
            for k, v in ov.items():
                if k and k in normalized_name: return v
        n = normalized_name
        if any(k in n for k in ("伦敦金", "伦敦银", "纽约白银", "纽约", "期货")): return "$"
        if any(k in n for k in ("上海金", "上海银", "黄金TD", "白银TD", "延期")):  return "¥"
        return "¥"

    def _extract_lny_prices(self, price_map_raw):
        if not price_map_raw:
            return None, None
        london  = price_map_raw.get(LONDON_KEY)
        newyork = price_map_raw.get(NEWYORK_KEY)
        return london, newyork

    # 字体/行高
    def _fit_all_texts(self, texts, base_px):
        max_w = int(self.WIDTH * 0.92)
        size  = max(10, int(base_px * self.scale))
        probe = tkfont.Font(family=FONT_FAMILY, size=size, weight="bold")
        def w(s): return probe.measure("" if s is None else str(s))
        while size > 9:
            probe.configure(size=size)
            if all((t is None) or (w(t) <= max_w) for t in texts if t): break
            size -= 1
        return tkfont.Font(family=FONT_FAMILY, size=size, weight="bold")

    def _line_h(self, fnt: tkfont.Font) -> int:
        try:
            asc = int(fnt.metrics("ascent") or 0)
            dsc = int(fnt.metrics("descent") or 0)
            h   = int((asc + dsc) * 0.95)
        except Exception:
            h = int(fnt.metrics("linespace"))
        return max(13, h)

    # Pillow 位图渲染
    def _pil_render_text(self, text, family, px, color_hex):
        if not (_PIL_OK and text):
            return None
        try:
            font = ImageFont.truetype(family or "arial.ttf", max(1, int(px)))
        except Exception:
            try:
                font = ImageFont.truetype("arial.ttf", max(1, int(px)))
            except Exception:
                font = ImageFont.load_default()
        tmp = Image.new("L", (1, 1), 0)
        d   = ImageDraw.Draw(tmp)
        w, h = d.textbbox((0, 0), text, font=font)[2:]
        w = max(1, w); h = max(1, h)

        mask = Image.new("L", (w, h), 0)
        d    = ImageDraw.Draw(mask)
        d.text((0, 0), text, fill=255, font=font)
        mask = mask.point(lambda a: 255 if a > 0 else 0, mode="L")

        rgb = tuple(int(color_hex.lstrip("#")[i:i+2], 16) for i in (0, 2, 4))
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        glyph = Image.new("RGBA", (w, h), rgb + (255,))
        img.paste(glyph, (0, 0), mask)

        return ImageTk.PhotoImage(img), w, h

    def _clear_pil_images(self):
        for iid, _tkimg in self._img_items:
            try: self.canvas.delete(iid)
            except Exception: pass
        self._img_items.clear()

    # 刷新线程
    def _loop(self):
        import _tkinter

        while self._running:
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

            def apply():
                if not self._running: return
                try:
                    if not (self.canvas and str(self.canvas)): return
                except Exception:
                    return

                minimal_active = self.minimal_mode and (not self._hovering)
                mode = "minimal" if minimal_active else "full"
                self._prepare_mode(mode)

                # 计算伦敦-纽约差价
                spread_pct = None
                ln_price, ny_price = self._extract_lny_prices(price_map_raw)
                if (ln_price is not None) and (ny_price is not None) and (ln_price != 0):
                    spread_pct = (ny_price - ln_price) / ln_price * 100.0

                line_count = max(1, min(2, len(self.display_quotes or [])))
                full_texts, mini_texts = [], []
                for i in range(line_count):
                    raw = self.display_quotes[i] if i < len(self.display_quotes or []) else None
                    if not raw:
                        full_texts.append("未选择品种"); mini_texts.append(""); continue

                    # 展示伦敦-纽约差价
                    if raw == SPREAD_NAME:
                        if spread_pct is None:
                            full_texts.append(f"{SPREAD_NAME}: 获取中...")
                            mini_texts.append("…")
                        else:
                            full_texts.append(f"{SPREAD_NAME}:  {spread_pct:.2f}%")
                            mini_texts.append(f"{spread_pct:.2f}%")
                        continue

                    # 普通品种
                    price = price_map_raw.get(raw)
                    show  = self._normalize_name(raw)
                    unit  = self._resolve_unit(show)
                    if isinstance(price, (int, float)):
                        full_texts.append(f"{show}:  {price:.2f} {unit}")
                        mini_texts.append(f"{price:.2f} {unit}")
                    else:
                        full_texts.append(f"{show}: 获取中...")
                        mini_texts.append("…")

                display_texts = mini_texts if minimal_active else full_texts

                # 参考“上海金”计算出盈亏巧克力
                ports = self.state.get("portfolios") or []
                inner_price = None
                if ports:
                    for key, val in price_map_raw.items():
                        if self._normalize_name(key) == "上海金":
                            inner_price = val; break

                pnl_full = pnl_mini = None
                total = None
                if ports:
                    if isinstance(inner_price, (int, float)):
                        total = sum(p["grams"] * (inner_price - p["cost_per_g"]) for p in ports)
                        pnl_full = f"总仓盈亏:  {total:+.2f} ¥"
                        pnl_mini = f"{total:+.2f} ¥"
                    else:
                        pnl_full = "总仓盈亏: -- ¥"
                        pnl_mini = "-- ¥"
                pnl_line = pnl_mini if minimal_active else pnl_full

                # 字体
                if minimal_active:
                    if MINIMAL_FONT_PX:
                        base_px = int(MINIMAL_FONT_PX)
                    else:
                        base_px = int(FONT_PRICE_PX * (float(MINIMAL_FONT_SCALE or 1.0)))
                    fnt = tkfont.Font(
                        family=(MINIMAL_FONT_FAMILY or FONT_FAMILY),
                        size=int(base_px * self.scale),
                        weight=str(MINIMAL_FONT_WEIGHT or "bold"),
                    )
                else:
                    fnt = self._fit_all_texts(full_texts + ([pnl_full] if pnl_full else []),
                                              base_px=FONT_PRICE_PX)
                    self._last_full_font = fnt

                line_h = self._line_h(fnt)
                pad    = int(8 * self.scale)

                # 盈亏行
                self._ensure_pnl_line(bool(pnl_line), line_h)
                has_pnl = self.pnl_text is not None

                # 计算布局宽高（两遍以稳定字号变化后的宽度）
                def layout_once():
                    measure = fnt.measure
                    longest = 0
                    for t in display_texts + ([pnl_line] if pnl_line else []):
                        if t: longest = max(longest, measure(str(t)))
                    target_w = int(longest * 1.2) + self.side_pad * 2
                    new_w = max(self.min_width, min(self.max_width, target_w))
                    total_lines = line_count + (1 if has_pnl else 0)
                    new_h = pad * 2 + total_lines * line_h
                    return new_w, new_h

                w1, h1 = layout_once()
                changed = (w1 != self.WIDTH) or (h1 != self.HEIGHT)

                if changed:
                    self.WIDTH, self.HEIGHT = w1, h1
                    self.canvas.config(width=self.WIDTH, height=self.HEIGHT)
                    self._draw_card()
                    if not self._user_dragged:
                        self._snap_to_bottom_right()

                    if not minimal_active:
                        fnt = self._fit_all_texts(full_texts + ([pnl_full] if pnl_full else []),
                                                  base_px=FONT_PRICE_PX)
                        line_h = self._line_h(fnt)

                w2, h2 = layout_once()
                if (w2 != self.WIDTH) or (h2 != self.HEIGHT):
                    self.WIDTH, self.HEIGHT = w2, h2
                    self.canvas.config(width=self.WIDTH, height=self.HEIGHT)
                    self._draw_card()
                    if not self._user_dragged:
                        self._snap_to_bottom_right()

                # 行对齐
                start_y = max(pad + line_h // 2, (self.HEIGHT - (line_count + (1 if has_pnl else 0))*line_h)//2 + line_h//2)
                ys = [start_y + i * line_h for i in range(line_count)]
                pnl_y = start_y + line_count * line_h if has_pnl else None

                colors = self.min_line_colors if minimal_active else self.line_colors

                try:
                    if minimal_active and _PIL_OK:
                        # 极简：仅位图渲染（不落回 Tk 文本）
                        self._clear_pil_images()
                        fam = fnt.cget("family")
                        px  = int(fnt.cget("size"))
                        for i, tid in enumerate(self.line_ids[:line_count]):
                            self.canvas.itemconfig(tid, text="")
                            tkimg = self._pil_render_text(display_texts[i], fam, px, colors[i % 2])
                            if tkimg:
                                img, _w, _h = tkimg
                                iid = self.canvas.create_image(self.WIDTH//2, ys[i], image=img)
                                self._img_items.append((iid, img))

                        if has_pnl and self.pnl_text is not None:
                            self.canvas.itemconfig(self.pnl_text, text="")
                            pnl_color = T_TEXT_2
                            if isinstance(total, (int, float)):
                                pnl_color = T_GREEN if total >= 0 else T_RED
                            tkimg = self._pil_render_text(pnl_line or "", fam, px, pnl_color)
                            if tkimg:
                                img, _w, _h = tkimg
                                iid = self.canvas.create_image(self.WIDTH//2,
                                                               pnl_y if pnl_y is not None else ys[-1] + line_h,
                                                               image=img)
                                self._img_items.append((iid, img))
                    else:
                        # 完整模式：Tk 文本
                        self._clear_pil_images()
                        for i, tid in enumerate(self.line_ids[:line_count]):
                            self.canvas.itemconfig(tid, text=display_texts[i], font=fnt, fill=colors[i % 2])
                            self.canvas.coords(tid, self.WIDTH // 2, ys[i])

                        if has_pnl and self.pnl_text is not None:
                            color = T_TEXT_2
                            if isinstance(total, (int, float)):
                                color = T_GREEN if total >= 0 else T_RED
                            self.canvas.itemconfig(self.pnl_text, text=(pnl_line or ""), font=fnt, fill=color)
                            self.canvas.coords(self.pnl_text, self.WIDTH // 2,
                                               pnl_y if pnl_y is not None else ys[-1] + line_h)
                except _tkinter.TclError:
                    return

                self._draw_card()

            try:
                if self._running:
                    self.root.after(0, apply)
            except Exception:
                pass

            # 刷新间隔 2s
            for _ in range(20):
                if not self._running or self._wake: break
                time.sleep(0.1)
            self._wake = False

    # 托盘与退出/自启/清理
    def _start_tray(self):
        if getattr(self, "icon", None): return

        def open_selector(icon, item):
            cb = self.state.get("on_open_selector")
            if callable(cb): self.root.after(0, cb)

        def open_manager(icon, item):
            cb = self.state.get("on_open_manager")
            if callable(cb): self.root.after(0, cb)

        def toggle_autostart(icon, item):
            self.root.after(0, lambda: self._toggle_autostart(icon, item))

        def toggle_window(icon, item):
            self.root.after(0, self._toggle_win)

        def on_quit(icon, item):
            self.root.after(0, self._quit)

        def clear_data(icon, item):
            self.root.after(0, self._clear_data_confirm)

        def toggle_minimal(icon, item):
            self.root.after(0, self._toggle_minimal)

        more = pystray.Menu(pystray.MenuItem("清除用户数据", clear_data),
                            pystray.MenuItem("退出", on_quit))
        menu = pystray.Menu(
            pystray.MenuItem("显示/隐藏窗口", toggle_window),
            pystray.MenuItem("更换展示数据", open_selector),
            pystray.MenuItem("自定义仓库", open_manager),
            pystray.MenuItem("极简悬浮", toggle_minimal,
                             checked=lambda _: self.minimal_mode),
            pystray.MenuItem("开机自启动", toggle_autostart, checked=lambda _: self._is_autostart_enabled()),
            pystray.MenuItem("更多", more),
        )
        self.icon = pystray.Icon("gold_ball", tray_image(), "GoldPriceBubble", menu)
        threading.Thread(target=self.icon.run, daemon=True).start()

    def _toggle_minimal(self):
        self.minimal_mode = not self.minimal_mode
        self.state["minimal_mode"] = self.minimal_mode
        target = "minimal" if self.minimal_mode else "full"
        self._prepare_mode(target)   # 先切，避免闪
        self._wake = True
        try:
            if self.icon: self.icon.update_menu()
        except Exception:
            pass
        try:
            self.root.after(0, self._draw_card)
        except Exception:
            pass

    def _toggle_win(self):
        try:
            if self.root.state() == "withdrawn":
                self.root.deiconify()
            else:
                self.root.withdraw()
        except Exception:
            pass

    def _quit(self):
        try:
            if self.icon:
                self.icon.visible = False
                self.icon.stop()
        except Exception:
            pass
        self._running = False
        try: self.root.after(0, self.root.quit)
        except Exception: pass
        try: self.root.after(0, self.root.destroy)
        except Exception: pass

    def _exe_path_for_autostart(self) -> str:
        if getattr(sys, "frozen", False): return sys.executable
        return os.path.abspath(sys.argv[0])

    def _set_autostart(self, enable: bool):
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        name = "GoldPriceBubble"
        try:
            reg = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_SET_VALUE)
            if enable:
                winreg.SetValueEx(reg, name, 0, winreg.REG_SZ, self._exe_path_for_autostart())
            else:
                try: winreg.DeleteValue(reg, name)
                except FileNotFoundError: pass
            winreg.CloseKey(reg)
        except Exception:
            pass

    def _toggle_autostart(self, icon, item):
        status = self._is_autostart_enabled()
        self._set_autostart(not status)
        try: icon.update_menu()
        except Exception: pass
        cb = self.state.get("on_autostart_changed")
        if callable(cb): cb()

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

    def _clear_data_confirm(self):
        if not msg.askyesno("清除数据", "这将清空所有用户数据（仓库/设置等），exe 不会被删除。\n\n确定继续吗？"):
            return
        try:
            user_data_dir = data_dir_in_appdata(APP_DIR)
            if os.path.isdir(user_data_dir):
                shutil.rmtree(user_data_dir, ignore_errors=True)
        except Exception:
            pass
        msg.showinfo("完成", "已清理数据。程序将退出。")
        self._quit()
