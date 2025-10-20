# ui/detail.py
import tkinter as tk
from tkinter import ttk
import tkinter.messagebox as msg

from utils.icons import set_window_icon
from core.styles import *
from core.resource import get_scaling
from ui.theme import apply_tencent_theme
from core.prices import probe_all_lines  # 仅用该接口


class NewPortfolioDialog:
    def __init__(self, app_ref, on_done=None):
        self.app = app_ref
        self.on_done = on_done

        self.win = tk.Toplevel(self.app.root)
        self.win.title("新建仓库")
        set_window_icon(self.win)
        self.scale = get_scaling()
        self.win.geometry(self._dpi("420x260"))
        self.win.attributes("-topmost", True)
        apply_tencent_theme(self.win)

        card = ttk.Labelframe(self.win, labelwidget=ttk.Label(self.win, text="基本信息"), style="Card.TLabelframe")
        card.pack(fill=tk.BOTH, expand=True, padx=16, pady=16)
        frm = ttk.Frame(card, padding=16); frm.pack(fill=tk.BOTH, expand=True)

        row = 0
        ttk.Label(frm, text="仓名").grid(row=row, column=0, sticky="e", padx=8, pady=6)
        self.ent_name = ttk.Entry(frm, width=28); self.ent_name.grid(row=row, column=1, sticky="w"); row += 1

        ttk.Label(frm, text="初始克数").grid(row=row, column=0, sticky="e", padx=8, pady=6)
        self.ent_grams = ttk.Entry(frm, width=28); self.ent_grams.insert(0, "0"); self.ent_grams.grid(row=row, column=1, sticky="w"); row += 1

        ttk.Label(frm, text="成本价/克(¥)").grid(row=row, column=0, sticky="e", padx=8, pady=6)
        self.ent_cost = ttk.Entry(frm, width=28); self.ent_cost.insert(0, "0"); self.ent_cost.grid(row=row, column=1, sticky="w"); row += 1

        btns = ttk.Frame(frm); btns.grid(row=row, column=0, columnspan=2, sticky="e", pady=(8, 0))
        ttk.Button(btns, text="取消", command=self.win.destroy).pack(side=tk.RIGHT, padx=6)
        ttk.Button(btns, text="创建", style="Primary.TButton", command=self._create).pack(side=tk.RIGHT, padx=6)

    def _dpi(self, geom: str):
        try:
            w, h = geom.lower().split("x"); return f"{int(int(w) * self.scale)}x{int(int(h) * self.scale)}"
        except Exception:
            return geom

    def _create(self):
        name = self.ent_name.get().strip()
        try:
            grams = float(self.ent_grams.get()); cost = float(self.ent_cost.get())
        except Exception:
            msg.showwarning("提示", "请输入有效数字"); return
        if not name:
            msg.showwarning("提示", "请填写仓名"); return
        if grams < 0 or cost < 0:
            msg.showwarning("提示", "克数/成本需为非负"); return

        p = {"name": name, "grams": grams, "cost_per_g": (cost if grams > 0 else 0.0), "txns": []}
        self.app.portfolios.append(p)
        if self.app.active_index is None:
            self.app.active_index = 0
        if self.on_done:
            self.on_done()
        self.win.destroy()


class DetailWindow:
    def __init__(self, app_ref, index: int, on_change=None, on_close=None):
        self.app = app_ref
        self.index = index
        self.on_change = on_change
        self.on_close = on_close

        self.win = tk.Toplevel(self.app.root)
        self.win.title(f"仓库管理 - {self.portfolio['name']}")
        set_window_icon(self.win)
        self.scale = get_scaling()
        self.win.geometry(self._dpi("900x620"))
        self.win.attributes("-topmost", True)
        apply_tencent_theme(self.win)

        def _close():
            try:
                if callable(self.on_close):
                    self.on_close()
            finally:
                self.win.destroy()
        self.win.protocol("WM_DELETE_WINDOW", _close)

        header = ttk.Frame(self.win, padding=(16, 14, 16, 8)); header.pack(fill=tk.X)
        self.lbl_pos = ttk.Label(header, text="", style="Title.TLabel"); self.lbl_pos.pack(side=tk.LEFT)

        #交易卡片
        trade_card = ttk.Labelframe(self.win, labelwidget=ttk.Label(self.win, text="交易（按当前黄金T+D价）"), style="Card.TLabelframe")
        trade_card.pack(fill=tk.X, padx=16, pady=(8, 8))
        tfrm = ttk.Frame(trade_card, padding=12); tfrm.pack(fill=tk.X)

        ttk.Label(tfrm, text="数量(克)").grid(row=0, column=0, sticky="e", padx=8, pady=6)
        self.ent_qty = ttk.Entry(tfrm, width=16); self.ent_qty.grid(row=0, column=1, sticky="w")

        # 勾选 ✓ 时启用费率输入
        self.var_fee_on = tk.BooleanVar(value=False)
        self.chk_fee = ttk.Checkbutton(tfrm, text="含手续费", variable=self.var_fee_on, command=self._on_fee_toggle)
        self.chk_fee.grid(row=0, column=2, sticky="w", padx=8)

        ttk.Label(tfrm, text="费率(%)").grid(row=0, column=3, sticky="e", padx=8)
        self.ent_fee = ttk.Entry(tfrm, width=12)
        self.ent_fee.insert(0, "0")
        self.ent_fee.grid(row=0, column=4, sticky="w")
        self._on_fee_toggle()  # 初始禁用

        btns = ttk.Frame(tfrm); btns.grid(row=1, column=1, columnspan=4, sticky="w", pady=(6, 0))
        ttk.Button(btns, text="买入", style="Primary.TButton", command=self._buy).pack(side=tk.LEFT, padx=6)
        ttk.Button(btns, text="卖出", command=self._sell).pack(side=tk.LEFT, padx=6)

        #校正均价 + 总克数 + 仓名
        adj_card = ttk.Labelframe(self.win, labelwidget=ttk.Label(self.win, text="校正（可同时修改仓名 / 总克数 / 均价）"), style="Card.TLabelframe")
        adj_card.pack(fill=tk.X, padx=16, pady=8)
        afr = ttk.Frame(adj_card, padding=12); afr.pack(fill=tk.X)

        r = 0
        ttk.Label(afr, text="新仓名（可选）").grid(row=r, column=0, sticky="e", padx=8, pady=6)
        self.ent_new_name = ttk.Entry(afr, width=24)
        self.ent_new_name.insert(0, self.portfolio["name"])
        self.ent_new_name.grid(row=r, column=1, sticky="w"); r += 1

        ttk.Label(afr, text="新的总克数 (g)").grid(row=r, column=0, sticky="e", padx=8, pady=6)
        self.ent_new_grams = ttk.Entry(afr, width=16)
        self.ent_new_grams.insert(0, f"{self.portfolio['grams']:.3f}")
        self.ent_new_grams.grid(row=r, column=1, sticky="w"); r += 1

        ttk.Label(afr, text="新的均价/克 (¥)").grid(row=r, column=0, sticky="e", padx=8, pady=6)
        self.ent_new_avg = ttk.Entry(afr, width=16)
        self.ent_new_avg.insert(0, f"{self.portfolio['cost_per_g']:.2f}")
        self.ent_new_avg.grid(row=r, column=1, sticky="w")

        ttk.Button(afr, text="应用", style="Primary.TButton", command=self._apply_adjustments).grid(row=r, column=2, padx=8)

        #流水
        log_card = ttk.Labelframe(self.win, labelwidget=ttk.Label(self.win, text="流水记录"), style="Card.TLabelframe")
        log_card.pack(fill=tk.BOTH, expand=True, padx=16, pady=(8, 16))
        lfrm = ttk.Frame(log_card, padding=8); lfrm.pack(fill=tk.BOTH, expand=True)

        cols = ("ts", "side", "g", "price", "fee", "post_g", "post_avg")
        self.log = ttk.Treeview(lfrm, columns=cols, show="headings", selectmode="browse")
        self.log.heading("ts",       text="时间");     self.log.column("ts",       width=160, anchor="center")
        self.log.heading("side",     text="类型");     self.log.column("side",     width=80,  anchor="center")
        self.log.heading("g",        text="数量(g)");  self.log.column("g",        width=100, anchor="e")
        self.log.heading("price",    text="价格(¥)");  self.log.column("price",    width=100, anchor="e")
        self.log.heading("fee",      text="手续费");    self.log.column("fee",      width=130, anchor="center")
        self.log.heading("post_g",   text="持仓(g)");  self.log.column("post_g",   width=100, anchor="e")
        self.log.heading("post_avg", text="均价");      self.log.column("post_avg", width=100, anchor="e")

        vsb = ttk.Scrollbar(lfrm, orient="vertical", command=self.log.yview)
        self.log.configure(yscrollcommand=vsb.set)
        self.log.pack(side=tk.LEFT, fill=tk.BOTH, expand=True); vsb.pack(side=tk.RIGHT, fill=tk.Y)

        self._refresh_header()
        self._refresh_log()

    # 属性
    @property
    def portfolio(self):
        return self.app.portfolios[self.index]

    def _dpi(self, geom: str):
        try:
            w, h = geom.lower().split("x"); return f"{int(int(w) * self.scale)}x{int(int(h) * self.scale)}"
        except Exception:
            return geom

    def _inner_price(self):
        try:
            lines = probe_all_lines()
            for s in lines:
                name, price = s.split(",", 1)
                if ("Au(T+D)" in name) or ("黄金T+D" in name):
                    return float(price) if price.strip() else None
        except Exception:
            return None
        return None

    def _now(self):
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    # 头部 / 流水
    def _refresh_header(self):
        inner = self._inner_price()
        g = self.portfolio["grams"]; avg = self.portfolio["cost_per_g"]
        pnl = (inner - avg) * g if inner is not None else None
        inner_str = f"{inner:.2f} ¥" if inner is not None else "--"
        pnl_str = f"{pnl:+.2f} ¥" if pnl is not None else "--"
        self.lbl_pos.config(
            text=f"仓名: {self.portfolio['name']}    持仓: {g:.3f} g    "
                 f"均价: {avg:.2f} ¥/g    参考价(黄金T+D): {inner_str}    当前仓盈亏: {pnl_str}"
        )

    def _refresh_log(self):
        for i in self.log.get_children():
            self.log.delete(i)
        for t in self.portfolio.get("txns", []):
            iid = self.log.insert(
                "", "end",
                values=(
                    t["ts"], t["side"], f"{t['grams']:.3f}", f"{t['price']:.2f}",
                    f"{t['fee_rate']:.2f}%(" + f"{t['fee_amt']:.2f})",
                    f"{t['post_grams']:.3f}", f"{t['post_avg']:.2f}"
                )
            )
            if len(self.log.get_children()) % 2 == 0:
                self.log.item(iid, tags=("odd",))
        self.log.tag_configure("odd", background="#F7F8FA")

    #交互
    def _on_fee_toggle(self):
        on = bool(self.var_fee_on.get())
        try:
            if on:
                self.ent_fee.state(["!disabled"])
            else:
                self.ent_fee.state(["disabled"])
                self.ent_fee.delete(0, tk.END)
                self.ent_fee.insert(0, "0")
        except Exception:
            self.ent_fee.configure(state=("normal" if on else "disabled"))
            if not on:
                self.ent_fee.delete(0, tk.END); self.ent_fee.insert(0, "0")

    def _read_trade(self):
        try:
            qty = float(self.ent_qty.get())
            if qty <= 0:
                msg.showwarning("提示", "数量需大于 0"); return None
        except Exception:
            msg.showwarning("提示", "请输入有效数量(克)"); return None

        fee_rate = 0.0
        if self.var_fee_on.get():
            try:
                fee_rate = float(self.ent_fee.get())
                if fee_rate < 0:
                    msg.showwarning("提示", "费率需为非负"); return None
            except Exception:
                msg.showwarning("提示", "请输入有效费率(%)"); return None
        return qty, fee_rate

    # 交易
    def _buy(self):
        inner = self._inner_price()
        if inner is None:
            msg.showwarning("提示", "当前无法获取黄金T+D价格"); return
        r = self._read_trade()
        if not r: return
        qty, fee_rate = r

        fee_amt = inner * qty * (fee_rate / 100.0)
        g0 = self.portfolio["grams"]; c0 = self.portfolio["cost_per_g"]
        cost_total1 = g0 * c0 + inner * qty + fee_amt
        g1 = g0 + qty; c1 = (cost_total1 / g1) if g1 > 0 else 0.0

        self.portfolio["grams"] = g1
        self.portfolio["cost_per_g"] = c1
        self._append("BUY", qty, inner, fee_rate, fee_amt, g1, c1)
        self._after_change()

    def _sell(self):
        inner = self._inner_price()
        if inner is None:
            msg.showwarning("提示", "当前无法获取黄金T+D价格"); return
        r = self._read_trade()
        if not r: return
        qty, fee_rate = r

        if qty > self.portfolio["grams"]:
            msg.showwarning("提示", "卖出克数不可大于持仓"); return

        fee_amt = inner * qty * (fee_rate / 100.0)
        g0 = self.portfolio["grams"]; c0 = self.portfolio["cost_per_g"]
        g1 = g0 - qty; c1 = c0 if g1 > 0 else 0.0

        self.portfolio["grams"] = g1
        self.portfolio["cost_per_g"] = c1
        self._append("SELL", qty, inner, fee_rate, fee_amt, g1, c1)
        self._after_change()

    def _append(self, side, qty, price, fee_rate, fee_amt, post_g, post_avg):
        self.portfolio.setdefault("txns", []).append({
            "ts": self._now(), "side": side, "grams": float(qty), "price": float(price),
            "fee_rate": float(fee_rate), "fee_amt": float(fee_amt),
            "post_grams": float(post_g), "post_avg": float(post_avg)
        })

    #统一应用仓名、克数、均价的校正
    def _apply_adjustments(self):
        new_name = self.ent_new_name.get().strip()
        try:
            new_grams_str = self.ent_new_grams.get().strip()
            new_grams = float(new_grams_str) if new_grams_str != "" else self.portfolio["grams"]
            if new_grams < 0:
                msg.showwarning("提示", "新的总克数需为非负"); return
        except Exception:
            msg.showwarning("提示", "请输入有效的总克数 (g)"); return
        try:
            new_avg_str = self.ent_new_avg.get().strip()
            new_avg = float(new_avg_str) if new_avg_str != "" else self.portfolio["cost_per_g"]
            if new_avg < 0:
                msg.showwarning("提示", "新的均价需非负"); return
        except Exception:
            msg.showwarning("提示", "请输入有效均价"); return
        if new_grams == 0:
            new_avg = 0.0

        if new_name:
            self.portfolio["name"] = new_name
            try:
                self.win.title(f"仓库管理 - {self.portfolio['name']}")
            except Exception:
                pass

        self.portfolio["grams"] = new_grams
        self.portfolio["cost_per_g"] = new_avg

        # 记录一条 ADJ 流水
        self._append("ADJ", 0.0, 0.0, 0.0, 0.0, new_grams, new_avg)

        # 刷新 & 落盘 & 通知
        self._after_change()
        msg.showinfo("成功", "已应用校正")

    def _after_change(self):
        # 刷新本页
        self._refresh_header()
        self._refresh_log()
        self.app.save_all()

        if callable(self.on_change):
            self.on_change()

        if hasattr(self.app, "notify_portfolios_changed"):
            try:
                self.app.notify_portfolios_changed(self.app.portfolios, self.app.active_index)
            except Exception:
                pass
