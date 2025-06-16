
import tkinter as tk
import threading
import time
import requests
import os
import sys
import winreg
import pystray
from PIL import Image, ImageDraw
import ctypes
import tkinter.messagebox as msg
import socket

# 防止重复运行
def check_single_instance(port=56789):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind(('127.0.0.1', port))
        return s  # 保持绑定状态
    except socket.error:
        msg.showwarning("提示", "GoldPriceBubble 已在运行中。")
        sys.exit()

# 防止高分屏模糊
ctypes.windll.shcore.SetProcessDpiAwareness(2)

def resource_path(relative_path):
    if hasattr(sys, '_MEIPASS'):
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath("."), relative_path)

class GoldPriceBubble:
    def __init__(self):
        self.scale = self.get_screen_scaling()
        self.root = tk.Tk()
        self.root.title("GoldPriceBubble")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-transparentcolor", "pink")
        self.root.configure(bg='pink')

        self.CANVAS_WIDTH = int(200 * self.scale)
        self.CANVAS_HEIGHT = int(60 * self.scale)

        self.canvas = tk.Canvas(
            self.root,
            width=self.CANVAS_WIDTH,
            height=self.CANVAS_HEIGHT,
            bg='pink',
            highlightthickness=0
        )
        self.canvas.pack()
        self._draw_background()

        # 字体大小不缩放
        font_size = 12
        self.inner_text = self.canvas.create_text(
            self.CANVAS_WIDTH // 2, int(18 * self.scale),
            text="国内金价: 获取中...",
            font=("Microsoft YaHei", font_size, "bold"),
            fill="#c88b00"
        )
        self.outer_text = self.canvas.create_text(
            self.CANVAS_WIDTH // 2, int(44 * self.scale),
            text="国际金价: 获取中...",
            font=("Microsoft YaHei", font_size, "bold"),
            fill="#1b5e20"
        )

        self.canvas.bind("<ButtonPress-1>", self._on_drag_start)
        self.canvas.bind("<B1-Motion>", self._on_drag_motion)

        self._update_position()
        self._start_update_thread()
        self._start_tray_icon()

    def get_screen_scaling(self):
        hdc = ctypes.windll.user32.GetDC(0)
        dpi_x = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)
        ctypes.windll.user32.ReleaseDC(0, hdc)
        return dpi_x / 96

    def _draw_background(self):
        def draw_rounded_rect(x, y, w, h, r, fill):
            points = [
                x + r, y,
                x + w - r, y, x + w, y, x + w, y + r,
                x + w, y + h - r, x + w, y + h, x + w - r, y + h,
                x + r, y + h, x, y + h, x, y + h - r,
                x, y + r, x, y, x + r, y
            ]
            return self.canvas.create_polygon(points, smooth=True, fill=fill, outline="")

        w, h = self.CANVAS_WIDTH, self.CANVAS_HEIGHT
        r = int(10 * self.scale)

        draw_rounded_rect(4, 4, w, h, r, fill="#b2b8c6")
        draw_rounded_rect(2, 2, w, h, r, fill="#c6ccda")

        for i in range(int(10 * self.scale), int(h - 10 * self.scale)):
            g = max(230, 255 - (i - int(10 * self.scale)) * 2)
            color = f"#{g:02x}{g:02x}{g:02x}"
            self.canvas.create_line(10, i, w - 10, i, fill=color)

        draw_rounded_rect(0, 0, w, h, r, fill="#f5f7fa")

        def draw_rounded_border(x, y, w, h, r, color, width):
            points = [
                x + r, y,
                x + w - r, y, x + w, y, x + w, y + r,
                x + w, y + h - r, x + w, y + h, x + w - r, y + h,
                x + r, y + h, x, y + h, x, y + h - r,
                x, y + r, x, y, x + r, y
            ]
            self.canvas.create_polygon(points, smooth=True, fill="", outline=color, width=width)

        draw_rounded_border(1, 1, w - 2, h - 2, r, color="#f5c242", width=2)

    def _on_drag_start(self, event):
        self._drag_offset_x = event.x
        self._drag_offset_y = event.y

    def _on_drag_motion(self, event):
        x = self.root.winfo_x() + event.x - self._drag_offset_x
        y = self.root.winfo_y() + event.y - self._drag_offset_y
        self.root.geometry(f"+{x}+{y}")

    def _update_position(self):
        w, h = self.CANVAS_WIDTH, self.CANVAS_HEIGHT
        sw = self.root.winfo_screenwidth()
        sh = self.root.winfo_screenheight()
        x = sw - w - 20
        y = sh - h - 60
        self.root.geometry(f"{w}x{h}+{x}+{y}")

    def _get_gold_price(self):
        try:
            url = "https://free.xwteam.cn/api/gold/trade"
            response = requests.get(url, timeout=5)
            data = response.json()
            if 'data' in data:
                g1 = next(item for item in data['data']['LF'] if item['Symbol'] == 'Au')
                g2 = next(item for item in data['data']['GJ'] if item['Symbol'] == 'GJ_Au')
                return g1['SP'], g2['SP']
        except Exception as e:
            print("获取金价失败:", e)
        return None, None

    def _update_loop(self):
        while True:
            inner, outer = self._get_gold_price()
            if inner:
                self.canvas.itemconfig(self.inner_text, text=f"国内金价:  {inner} ¥")
            if outer:
                self.canvas.itemconfig(self.outer_text, text=f"国际金价:  {outer} $")
            time.sleep(10)

    def _start_update_thread(self):
        threading.Thread(target=self._update_loop, daemon=True).start()

    def _set_autostart(self, enable):
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        name = "GoldPriceBubble"
        exe = sys.executable
        try:
            reg = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_ALL_ACCESS)
            if enable:
                winreg.SetValueEx(reg, name, 0, winreg.REG_SZ, exe)
            else:
                winreg.DeleteValue(reg, name)
            winreg.CloseKey(reg)
        except:
            pass

    def _is_autostart_enabled(self):
        key = r"Software\Microsoft\Windows\CurrentVersion\Run"
        name = "GoldPriceBubble"
        try:
            reg = winreg.OpenKey(winreg.HKEY_CURRENT_USER, key, 0, winreg.KEY_READ)
            _, _ = winreg.QueryValueEx(reg, name)
            winreg.CloseKey(reg)
            return True
        except:
            return False

    def create_icon(self):
        icon_path = resource_path("Price.png")
        return Image.open(icon_path)

    def _start_tray_icon(self):
        def on_quit(icon, item):
            icon.stop()
            self.root.destroy()
            os._exit(0)

        def toggle_autostart(icon, item):
            status = self._is_autostart_enabled()
            self._set_autostart(not status)
            icon.update_menu()

        def toggle_window(icon, item):
            if self.root.state() == "withdrawn":
                self.root.deiconify()
            else:
                self.root.withdraw()

        def show_about(icon, item):
            msg.showinfo("关于", "GoldPriceBubble v1.5\n修复 DPI 缩放问题\n新增防重复运行\n作者：Lucas Lee\n数据60秒更新一次")

        menu = pystray.Menu(
            pystray.MenuItem("显示/隐藏窗口", toggle_window),
            pystray.MenuItem("开机启动", toggle_autostart, checked=lambda item: self._is_autostart_enabled()),
            pystray.MenuItem("关于", show_about),
            pystray.MenuItem("退出", on_quit)
        )

        icon = pystray.Icon("gold_ball", self.create_icon(), "GoldPriceBubble v1.5", menu)
        threading.Thread(target=icon.run, daemon=True).start()

    def run(self):
        self.root.mainloop()

if __name__ == "__main__":
    lock = check_single_instance()
    app = GoldPriceBubble()
    app.run()
