########################################
# ui/theme.py
########################################
import tkinter as tk
from tkinter import ttk, font as tkfont

PRIMARY      = "#1890FF"
PRIMARY_HOV  = "#40A9FF"
PRIMARY_ACT  = "#096DD9"
BG_APP       = "#F7F8FA"
CARD_BG      = "#FFFFFF"
BORDER       = "#E5E6EB"
TEXT_MAIN    = "#1F2329"
TEXT_SECOND  = "#4E5969"
SUCCESS      = "#07C160"
DANGER       = "#F53F3F"

def apply_tencent_theme(root: tk.Misc):
    style = ttk.Style(root)
    try: style.theme_use("clam")
    except Exception: pass

    base_font = tkfont.Font(family="Microsoft YaHei UI", size=10)
    title_font = tkfont.Font(family="Microsoft YaHei UI", size=11, weight="bold")
    root.option_add("*Font", base_font)
    root.configure(bg=BG_APP)

    style.configure("TButton", padding=(10,6), borderwidth=0, background="#FFFFFF", foreground=TEXT_MAIN)
    style.map("TButton", background=[("active","#F2F3F5")])

    style.configure("Primary.TButton", padding=(12,8), borderwidth=0, background=PRIMARY, foreground="#FFFFFF")
    style.map(
        "Primary.TButton",
        background=[("active", PRIMARY_HOV), ("pressed", PRIMARY_ACT), ("disabled", "#BCDDFD")],
        foreground=[("disabled", "#FFFFFF")]  # <<< 禁用也保持白字，避免“文字变淡”错觉
    )

    style.configure("Danger.TButton", padding=(12,8), borderwidth=0, background=DANGER, foreground="#FFFFFF")
    style.configure("Link.TButton", padding=(4,2), borderwidth=0, background=BG_APP, foreground=PRIMARY)

    style.configure("TEntry", fieldbackground="#FFFFFF", bordercolor=BORDER, lightcolor=PRIMARY, darkcolor=BORDER,
                    borderwidth=1, relief="solid", padding=6)
    style.map("TEntry", bordercolor=[("focus",PRIMARY)], lightcolor=[("focus",PRIMARY)])

    style.configure("Card.TLabelframe", background=CARD_BG, borderwidth=1, relief="solid", bordercolor=BORDER)
    style.configure("Card.TLabelframe.Label", background=CARD_BG, foreground=TEXT_SECOND, font=base_font)

    style.configure("TTreeview", background="#FFFFFF", fieldbackground="#FFFFFF", foreground=TEXT_MAIN,
                    bordercolor=BORDER, borderwidth=1, rowheight=28)
    style.configure("TTreeview.Heading", background="#FAFAFA", foreground=TEXT_SECOND,
                    bordercolor=BORDER, borderwidth=1, relief="flat")

    style.configure("Title.TLabel", background=BG_APP, foreground=TEXT_MAIN, font=title_font)
    style.configure("Subtle.TLabel", background=BG_APP, foreground=TEXT_SECOND)
    style.configure("TSeparator", background=BORDER)

