# ui/manager.py
import tkinter as tk
from tkinter import ttk
import tkinter.messagebox as msg

from utils.icons import set_window_icon
from core.styles import *
from core.resource import get_scaling
from .theme import apply_tencent_theme
from .detail import DetailWindow, NewPortfolioDialog


class ManagerWindow:
    def __init__(self, app_ref):
        self.app = app_ref
        self.win = tk.Toplevel(self.app.root)
        self.win.title("自定义仓库")
        set_window_icon(self.win)
        self.scale = get_scaling()
        self.win.geometry(self._dpi("760x520"))
        self.win.configure(bg="#F7F8FA")
        self.win.attributes("-topmost", True)
        apply_tencent_theme(self.win)

        header = ttk.Frame(self.win, padding=(16, 14, 16, 8)); header.pack(fill=tk.X)
        ttk.Label(header, text="我的仓库", style="Title.TLabel").pack(side=tk.LEFT)

        btns = ttk.Frame(header); btns.pack(side=tk.RIGHT)
        ttk.Button(btns, text="新建仓库", style="Primary.TButton", command=self._new).pack(side=tk.LEFT, padx=6)
        ttk.Button(btns, text="打开（管理）", command=self._open_detail).pack(side=tk.LEFT, padx=6)
        ttk.Button(btns, text="删除选中", style="Danger.TButton", command=self._delete).pack(side=tk.LEFT, padx=6)

        card = ttk.Labelframe(self.win, labelwidget=ttk.Label(self.win, text="仓库列表"), style="Card.TLabelframe")
        card.pack(fill=tk.BOTH, expand=True, padx=16, pady=(4, 16))
        inner = ttk.Frame(card, padding=12); inner.pack(fill=tk.BOTH, expand=True)

        cols = ("name", "grams", "avg")
        self.tree = ttk.Treeview(inner, columns=cols, show="headings", selectmode="browse")
        self.tree.heading("name",  text="仓名");      self.tree.column("name",  width=280, anchor="w")
        self.tree.heading("grams", text="持仓(g)");   self.tree.column("grams", width=140, anchor="center")
        self.tree.heading("avg",   text="均价(¥/g)"); self.tree.column("avg",   width=140, anchor="center")

        vsb = ttk.Scrollbar(inner, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=vsb.set)
        self.tree.pack(side=tk.LEFT, fill=tk.BOTH, expand=True); vsb.pack(side=tk.RIGHT, fill=tk.Y)

        self.hint = ttk.Label(self.win, text="", style="Subtle.TLabel")
        self.hint.pack(side=tk.TOP, anchor="w", padx=16, pady=(0, 8))

        self._refresh()
        self.tree.bind("<Double-Button-1>", lambda _e: self._open_detail())

    def _dpi(self, geom: str):
        try:
            w, h = geom.lower().split("x")
            return f"{int(int(w) * self.scale)}x{int(int(h) * self.scale)}"
        except Exception:
            return geom

    def _notify_bubble(self):
        if hasattr(self.app, "notify_portfolios_changed"):
            self.app.notify_portfolios_changed(self.app.portfolios, self.app.active_index)
        elif getattr(self.app, "bubble", None):
            try:
                self.app.bubble.reload_all(
                    display_quotes=self.app.display_quotes,
                    portfolios=self.app.portfolios,
                    active_index=self.app.active_index
                )
            except Exception:
                pass

    def _refresh(self):
        for i in self.tree.get_children():
            self.tree.delete(i)
        for idx, p in enumerate(self.app.portfolios):
            iid = self.tree.insert(
                "", "end", iid=str(idx),
                values=(p["name"], f"{p['grams']:.3f}", f"{p['cost_per_g']:.2f}")
            )
            if idx % 2 == 1:
                self.tree.item(iid, tags=("odd",))
        self.tree.tag_configure("odd", background="#F7F8FA")
        self.hint.config(text=("暂无仓库，请点击右上角“新建仓库”创建。" if not self.app.portfolios else ""))

    def _selected_index(self):
        sel = self.tree.selection()
        if not sel:
            return None
        return int(sel[0])

    def _new(self):
        # 刷新 + 保存 + 通知气泡
        def _done():
            self._refresh()
            self.app.save_all()
            self._notify_bubble()
        NewPortfolioDialog(self.app, on_done=_done)

    def _delete(self):
        idx = self._selected_index()
        if idx is None:
            msg.showwarning("提示", "请先选择一个仓库"); return
        name = self.app.portfolios[idx]["name"]
        if not msg.askyesno("确认删除", f"确定删除“{name}”吗？该仓流水将一并删除。"):
            return
        del self.app.portfolios[idx]
        if self.app.active_index is not None:
            if idx < self.app.active_index:
                self.app.active_index -= 1
            elif idx == self.app.active_index:
                self.app.active_index = 0 if self.app.portfolios else None

        self._refresh()
        self.app.save_all()
        self._notify_bubble()

    def _open_detail(self):
        idx = self._selected_index()
        if idx is None:
            msg.showwarning("提示", "请先选择一个仓库"); return

        DetailWindow(
            self.app, idx,
            on_change=self._on_detail_change,
            on_close=self._refresh
        )

    def _on_detail_change(self):
        self._refresh()
        self.app.save_all()
        self._notify_bubble()
