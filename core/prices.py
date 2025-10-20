# -*- coding: utf-8 -*-
# 客户端从服务端取价：保持 probe_all_lines() 接口不变
import time, json, random, traceback
from typing import List, Optional

import requests
from requests.adapters import HTTPAdapter, Retry
import certifi

# ===== 直接硬编码配置（不再读取文件/环境变量）=====
SERVER_URL  = "http://123.207.22.15:8787"   # 你的服务端地址（支持 http/https）
API_KEY     = "changeme"                # 你的 API key
TIMEOUT_S   = 5.0                       # 客户端请求超时（秒）
MAX_STALE   = 8                         # 失败后可接受的缓存陈旧秒数
DEBUG_MODE  = False                     # 调试日志开关：True/False

_session: Optional[requests.Session] = None
_last_lines: List[str] = []
_last_ok_ts: float = 0.0

def _build_session() -> requests.Session:
    s = requests.Session()
    s.trust_env = False                 # 不继承系统代理环境变量（避免误走公司代理）
    s.verify = certifi.where()          # 显式指定根证书（对 http 无影响）
    s.headers.update({"User-Agent": "GoldPriceBubble/Client"})

    retries = Retry(
        total=2, connect=2, read=2,
        backoff_factor=0.2,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(pool_connections=8, pool_maxsize=8, max_retries=retries)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s

def _get_session() -> requests.Session:
    global _session
    if _session is None:
        _session = _build_session()
    return _session

def _lines_url() -> str:
    base = SERVER_URL.rstrip("/")
    return f"{base}/api/v1/lines?key={API_KEY}&t={int(time.time()*1000)}{random.randint(10,99)}"

def probe_all_lines() -> List[str]:
    """
    拉取：{"updated_at": 1710000000, "lines": ["伦敦金,4296.00", ...]}
    返回: ["名称,价格", ...]
    """
    global _last_lines, _last_ok_ts

    url = _lines_url()
    s = _get_session()
    try:
        r = s.get(url, timeout=TIMEOUT_S)
        if DEBUG_MODE:
            print(f"[price client] GET {url} -> {r.status_code} {r.headers.get('content-type')}")
        r.raise_for_status()
        js = r.json()
        lines = js.get("lines") or []
        lines = [str(x) for x in lines if isinstance(x, str)]
        if lines:
            _last_lines = lines
            _last_ok_ts = time.time()
            return lines
    except Exception as e:
        if DEBUG_MODE:
            print("[price client] fetch error:", repr(e))
            try:
                txt = r.text if 'r' in locals() else ""
                snippet = txt[:200].replace("\n", " ")
                print("[price client] resp snippet:", snippet + (" ..." if len(txt) > 200 else ""))
            except Exception:
                pass
            traceback.print_exc()

    # 失败时，若有不超过 MAX_STALE 秒的本地缓存，先用缓存兜底
    if _last_lines and (time.time() - _last_ok_ts) <= MAX_STALE:
        return list(_last_lines)
    return []

# --------- 可执行主入口：本地自测 ---------
if __name__ == "__main__":
    print("SERVER_URL =", SERVER_URL)
    print("API_KEY    =", API_KEY)
    print("TIMEOUT_S  =", TIMEOUT_S, " MAX_STALE =", MAX_STALE, " DEBUG =", DEBUG_MODE)
    try:
        for i in range(5):
            lines = probe_all_lines()
            print(f"[{time.strftime('%H:%M:%S')}] got {len(lines)} lines")
            for row in lines[:11]:
                print("  ", row)
            time.sleep(2)
    except KeyboardInterrupt:
        pass
