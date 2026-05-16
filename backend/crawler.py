"""12306 API 爬虫模块 — 负责站名映射、车次查询、详情查询."""
import httpx
import re
import time
import random
from typing import Optional

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
]

STATION_NAME_URL = (
    "https://kyfw.12306.cn/otn/resources/js/framework/station_name.js"
    "?station_version=1.9345"
)

_station_map: dict[str, str] = {}   # 站名 -> 代码
_reverse_map: dict[str, str] = {}   # 代码 -> 站名


def _random_ua() -> str:
    return random.choice(USER_AGENTS)


def _client() -> httpx.Client:
    return httpx.Client(
        headers={
            "User-Agent": _random_ua(),
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "zh-CN,zh;q=0.9",
        },
        timeout=15.0,
        follow_redirects=True,
        verify=True,
    )


def load_station_map() -> dict[str, str]:
    """从 12306 加载站名 -> 电报码映射，带内存在缓存."""
    global _station_map, _reverse_map
    if _station_map:
        return _station_map

    with _client() as client:
        resp = client.get(STATION_NAME_URL)
        resp.raise_for_status()
        text = resp.text

    # 格式: @bjb|北京北|VAP|beijingbei|bjb|0|0357|北京|||
    matches = re.findall(r"@[a-z]+\|([^\|]+)\|([A-Z]+)\|", text)
    _station_map = {name: code for name, code in matches}
    _reverse_map = {code: name for code, name in matches}
    return _station_map


def station_to_code(name: str) -> Optional[str]:
    """站名 -> 电报码。支持模糊匹配."""
    m = load_station_map()
    if name in m:
        return m[name]
    for n, c in m.items():
        if name in n or n in name:
            return c
    return None


def code_to_station(code: str) -> Optional[str]:
    """电报码 -> 站名."""
    rm = _reverse_map
    if not rm:
        load_station_map()
        rm = _reverse_map
    return rm.get(code)
