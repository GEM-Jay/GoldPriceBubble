# 抓包逻辑，需要自己写
import time, json, random, traceback
from typing import List, Optional

import requests
from requests.adapters import HTTPAdapter, Retry
import certifi

SERVER_URL  = "your url"                # 你的服务端地址
API_KEY     = "changeme"                # 你的 API key
TIMEOUT_S   = 5.0
MAX_STALE   = 8
DEBUG_MODE  = False

_session: Optional[requests.Session] = None
_last_lines: List[str] = []
_last_ok_ts: float = 0.0

def _build_session() -> requests.Session:
    s = requests.Session()
    s.trust_env = False
    s.verify = certifi.where()
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

    if _last_lines and (time.time() - _last_ok_ts) <= MAX_STALE:
        return list(_last_lines)
    return []

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
