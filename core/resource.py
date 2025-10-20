########################################
# core/resource.py
########################################
import os, sys, ctypes

def is_frozen():
    return hasattr(sys, "_MEIPASS")

def resource_path(relative_path: str) -> str:
    if is_frozen():
        return os.path.join(sys._MEIPASS, relative_path)
    return os.path.join(os.path.abspath("."), relative_path)

def data_dir_in_appdata(appdir_name: str) -> str:
    appdata = os.getenv("APPDATA")
    if appdata:
        p = os.path.join(appdata, appdir_name)
    else:
        base = os.path.dirname(sys.executable) if is_frozen() else os.path.dirname(__file__)
        p = os.path.join(base, "data")
    os.makedirs(p, exist_ok=True)
    return p

def set_dpi_awareness():
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        pass

def get_scaling() -> float:
    try:
        hdc = ctypes.windll.user32.GetDC(0)
        dpi_x = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)
        ctypes.windll.user32.ReleaseDC(0, hdc)
        return dpi_x / 96 if dpi_x else 1.0
    except Exception:
        return 1.0