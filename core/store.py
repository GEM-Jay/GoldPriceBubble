########################################
# core/store.py
########################################
import os, json
from .resource import data_dir_in_appdata

APP_DIR = "GoldPriceBubble"
FILE    = os.path.join(data_dir_in_appdata(APP_DIR), "portfolios.json")

def load():
    try:
        if os.path.exists(FILE):
            with open(FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                data.setdefault("portfolios", [])
                data.setdefault("active_index", None)
                data.setdefault("display_quotes", [])
                return data
    except Exception:
        pass
    return {"portfolios": [], "active_index": None, "display_quotes": []}

def save(portfolios, active_index, display_quotes):
    try:
        data = {
            "portfolios": portfolios,
            "active_index": active_index,
            "display_quotes": list(display_quotes or [])
        }
        with open(FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
