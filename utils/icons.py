########################################
# utils/icons.py
########################################
import os, tkinter as tk
from PIL import Image as PILImage
from core.resource import resource_path

def set_window_icon(win):
    try:
        ico_path = resource_path("assets/Price.ico")
        if os.path.exists(ico_path):
            win.iconbitmap(ico_path); return
    except Exception: pass
    try:
        png_path = resource_path("assets/Price.png")
        if os.path.exists(png_path):
            img = tk.PhotoImage(file=png_path)
            win.iconphoto(True, img)
            win._win_icon_ref = img
    except Exception: pass

def tray_image():
    path = resource_path("assets/Price.png")
    return PILImage.open(path)
