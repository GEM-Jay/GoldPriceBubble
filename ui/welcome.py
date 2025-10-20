# -*- coding: utf-8 -*-
import datetime
import tkinter as tk
from tkinter import ttk, messagebox
import re

from ui.theme import BG_APP
from core.prices import probe_all_lines

SPREAD_NAME = "伦-纽差价"
LONDON_KEY  = "伦敦金（现货黄金）"
NEWYORK_KEY = "纽约黄金"

T_BLUE       = "#1E80FF"
T_BLUE_HOVER = "#1669D7"
T_TEXT       = "#1F2329"
T_SUBTEXT    = "#606770"
BG_COLOR     = BG_APP
FONT_FAMILY  = "Microsoft YaHei UI"

CHK_ON  = "✔"
CHK_OFF = ""

def _is_jd_name(name: str) -> bool:
    n = (name or "").strip()
    if "(JD)" in n:
        return True
    for k in ("黄金T+D", "Au(T+D)"):
        if k in n:
            return True
    return False

def is_sina_reco(name: str) -> bool:
    n = (name or "").strip()
    if _is_jd_name(n):
        return False
    if "伦敦金（现货黄金）" in n:
        return True
    if "黄金延期" in n:
        return True
    return False


class WelcomeSelector(ttk.Frame):
    def __init__(self, master, header_text="请选择正好两个关注品种", min_pick=2, max_pick=2,
                 on_confirm=None, on_cancel=None):
        super().__init__(master, padding=(12, 12, 12, 12))
        self.on_confirm = on_confirm
        self.on_cancel  = on_cancel
        self.min_pick   = min_pick
        self.max_pick   = max_pick

        self.selected = []
        self._rowmap  = {}

        # 一次性取数
        self.fetched_at = datetime.datetime.now()
        self.data = self._fetch_once()

        self._setup_style()
        self._build_ui(header_text)
        self._fill_tree(self.data)

    def _fetch_once(self):
        price_map = {}
        rows = []
        try:
            for s in probe_all_lines():
                try:
                    n, p = s.split(",", 1)
                except ValueError:
                    continue
                raw = (n or "").strip()
                p = (p or "").strip()
                try:
                    val = float(p)
                    price_str = f"{val:.2f}"
                except Exception:
                    val = None
                    price_str = ""
                price_map[raw] = val
                reco = is_sina_reco(raw)
                show = raw + ("（推荐）" if reco else "")
                rows.append({
                    "raw": raw, "price": val, "price_str": price_str,
                    "reco": reco, "show": show
                })
        except Exception:
            pass

        # 计算一次差价
        spread_str = ""
        try:
            ln = price_map.get(LONDON_KEY)
            ny = price_map.get(NEWYORK_KEY)
            if (ln is not None) and (ny is not None) and ln != 0:
                spread = (ny - ln) / ln * 100.0
                spread_str = f"{spread:.2f}%"
        except Exception:
            spread_str = ""

        rows.append({
            "raw": SPREAD_NAME,
            "price": None,           # 不参与数值排序
            "price_str": spread_str, # 展示方便
            "reco": True,            # 给个推荐标记便于靠前展示
            "show": SPREAD_NAME
        })

        # 推荐优先，再按名称
        rows.sort(key=lambda d: (0 if d["reco"] else 1, d["raw"]))
        return rows

    # Style
    def _setup_style(self):
        s = ttk.Style(self)
        s.configure("Header.TLabel", background=BG_APP, foreground=T_TEXT,
                    font=(FONT_FAMILY, 11, "bold"))
        s.configure("Sub.TLabel", background=BG_APP, foreground=T_SUBTEXT,
                    font=(FONT_FAMILY, 9))
        s.configure("Primary.TButton", font=(FONT_FAMILY, 10, "bold"),
                    foreground="#FFFFFF", background=T_BLUE, borderwidth=0, padding=(14, 8))
        s.map("Primary.TButton",
              background=[("active", T_BLUE_HOVER), ("disabled", "#AFCDFB")],
              foreground=[("disabled", "#FFFFFF")])
        s.configure("Ghost.TButton", font=(FONT_FAMILY, 10),
                    foreground=T_BLUE, background="#FFFFFF", borderwidth=1, padding=(14, 8))
        s.configure("Welcome.Treeview", font=(FONT_FAMILY, 10), rowheight=26)
        s.configure("Welcome.Treeview.Heading", font=(FONT_FAMILY, 10, "bold"))

    # UI
    def _build_ui(self, header_text: str):
        self.grid_columnconfigure(0, weight=1)
        self.grid_rowconfigure(2, weight=1)

        ttk.Label(self, text=header_text, style="Header.TLabel").grid(row=0, column=0, sticky="w")
        ts = self.fetched_at.strftime("%Y-%m-%d %H:%M:%S")
        ttk.Label(self, text=f"更新于 {ts}", style="Sub.TLabel").grid(row=1, column=0, sticky="w", pady=(2, 8))

        wrap = ttk.Frame(self); wrap.grid(row=2, column=0, sticky="nsew")
        wrap.grid_columnconfigure(0, weight=1); wrap.grid_rowconfigure(0, weight=1)

        self.tree = ttk.Treeview(
            wrap, columns=("name","price","pick"), show="headings",
            style="Welcome.Treeview", selectmode="browse"  # 允许行被选中（点击任意列）
        )
        self.tree.grid(row=0, column=0, sticky="nsew")
        vsb = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        vsb.grid(row=0, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=vsb.set)

        self.tree.heading("name",  text="名称")
        self.tree.heading("price", text="价格")
        self.tree.heading("pick",  text="选择")

        self.tree.column("name",  width=380, anchor="w", stretch=False)
        self.tree.column("price", width=228, anchor="w", stretch=False)
        self.tree.column("pick",  width=152, anchor="center", stretch=False)

        self.tree.bind("<Button-1>", self._on_click)
        self.tree.bind("<Double-1>", self._on_double)
        self.tree.bind("<Key-space>", self._on_space)

        ttk.Separator(self, orient="horizontal").grid(row=3, column=0, sticky="ew", pady=(8, 6))
        footer = ttk.Frame(self); footer.grid(row=4, column=0, sticky="ew")
        footer.columnconfigure(0, weight=1)
        btns = ttk.Frame(footer); btns.grid(row=0, column=0, sticky="e")
        self.btn_cancel  = ttk.Button(btns, text="取消", style="Ghost.TButton", command=self._on_cancel)
        self.btn_confirm = ttk.Button(btns, text="确认", style="Primary.TButton", command=self._on_confirm)
        self.btn_cancel.grid(row=0, column=0, padx=(0, 8))
        self.btn_confirm.grid(row=0, column=1)
        self._update_confirm_state()

    def _fill_tree(self, rows):
        if not self.selected:
            for d in rows:
                raw = d["raw"]
                if ("伦敦金" in raw and not _is_jd_name(raw)) or ("黄金延期" in raw and not _is_jd_name(raw)):
                    if raw not in self.selected:
                        self.selected.append(raw)
                if len(self.selected) >= self.max_pick:
                    break

        for d in rows:
            iid = self.tree.insert(
                "", "end",
                values=(d["show"], d["price_str"], CHK_ON if d["raw"] in self.selected else CHK_OFF),
            )
            if d["reco"]:
                self.tree.tag_configure("reco", font=(FONT_FAMILY, 10, "bold"))
                self.tree.item(iid, tags=("reco",))
            self._rowmap[d["raw"]] = iid

        self._update_confirm_state()

    def _toggle_by_iid(self, iid):
        name_show = self.tree.set(iid, "name")
        raw = name_show.replace("（推荐）", "")
        if raw in self.selected:
            self.selected = [x for x in self.selected if x != raw]
            self.tree.set(iid, "pick", CHK_OFF)
        else:
            if len(self.selected) >= self.max_pick:
                messagebox.showinfo("选择上限", f"最多只能选择 {self.max_pick} 个。")
                return
            self.selected.append(raw)
            self.tree.set(iid, "pick", CHK_ON)
        self._update_confirm_state()

    def _on_click(self, e):
        iid = self.tree.identify_row(e.y)
        if not iid:
            return
        # 点击任意列都切换
        self.tree.focus(iid)
        self.tree.selection_set(iid)
        self._toggle_by_iid(iid)
        return "break"

    def _on_double(self, e):
        iid = self.tree.identify_row(e.y)
        if iid:
            self._toggle_by_iid(iid)
            return "break"

    def _on_space(self, _e):
        iid = self.tree.focus() or (self.tree.get_children()[0] if self.tree.get_children() else None)
        if iid:
            self._toggle_by_iid(iid)
            return "break"

    def _update_confirm_state(self):
        can = (self.min_pick <= len(self.selected) <= self.max_pick)
        try:
            self.btn_confirm.state(["!disabled" if can else "disabled"])
        except Exception:
            pass

    def _on_confirm(self):
        if not (self.min_pick <= len(self.selected) <= self.max_pick):
            messagebox.showwarning("选择不合法", f"请正好选择 {self.max_pick} 个。")
            return
        if callable(self.on_confirm):
            self.on_confirm(self.selected[: self.max_pick])

    def _on_cancel(self):
        if callable(self.on_cancel):
            self.on_cancel()

    def preset_selected(self, raw_names):
        try:
            self.selected = list(raw_names or [])[: self.max_pick]
            for iid in self.tree.get_children():
                name_show = self.tree.set(iid, "name")
                raw = name_show.replace("（推荐）", "")
                self.tree.set(iid, "pick", CHK_ON if raw in self.selected else CHK_OFF)
            self._update_confirm_state()
        except Exception:
            pass

    def destroy(self):
        try:
            super().destroy()
        except Exception:
            pass
