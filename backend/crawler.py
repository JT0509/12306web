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
    _reverse_map = {code: name for name, code in matches}
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


# ── 直达车次查询 ──────────────────────────────────────────────

QUERY_URL = "https://kyfw.12306.cn/otn/leftTicket/query"

# 席别映射: 索引 -> 席别名称
SEAT_INDEX_MAP = {
    26: "无座",
    28: "硬座",
    29: "硬卧",
    30: "软卧",
}

HIGH_SPEED_SEAT_MAP = {
    28: "二等座",
    29: "一等座",
    30: "商务座",
}


def _parse_train_info(entry: str, data_map: dict) -> dict:
    """解析单条车次数据."""
    parts = entry.split("|")
    if len(parts) < 31:
        return {}

    train_code = parts[3]  # 显示车次，如 G1
    from_code = parts[6]
    to_code = parts[7]
    start_time = parts[8]
    arrive_time = parts[9]
    duration_raw = parts[10]  # "04:28"
    from_station = code_to_station(from_code) or from_code
    to_station = code_to_station(to_code) or to_code

    # 判断是否为高铁/动车
    is_high_speed = train_code.startswith(("G", "D", "C"))

    # 解析席别价格
    seat_map = HIGH_SPEED_SEAT_MAP if is_high_speed else SEAT_INDEX_MAP
    seats = []
    for idx, name in seat_map.items():
        price_str = parts[idx] if idx < len(parts) else ""
        if price_str and price_str not in ("", "无", "*", "—"):
            try:
                price = float(price_str)
                seats.append({"type": name, "price": price})
            except ValueError:
                seats.append({"type": name, "price": 0, "note": price_str})
        else:
            seats.append({"type": name, "sold_out": True})

    # 时长格式化
    try:
        h, m = duration_raw.split(":")
        duration = f"{int(h)}h{int(m)}m"
    except (ValueError, AttributeError):
        duration = duration_raw

    return {
        "train_no": train_code,
        "internal_no": parts[2],
        "from_station": from_station,
        "to_station": to_station,
        "depart_time": start_time,
        "arrive_time": arrive_time,
        "duration": duration,
        "seats": seats,
    }


def query_direct_trains(
    from_code: str, to_code: str, date: str
) -> list[dict]:
    """查询直达车次."""
    with _client() as client:
        # 先访问 init 页面获取 Cookie
        client.get("https://kyfw.12306.cn/otn/leftTicket/init")

        time.sleep(random.uniform(0.5, 1.5))

        params = {
            "leftTicketDTO.train_date": date,
            "leftTicketDTO.from_station": from_code,
            "leftTicketDTO.to_station": to_code,
            "purpose_codes": "ADULT",
        }
        resp = client.get(QUERY_URL, params=params)
        resp.raise_for_status()
        data = resp.json()

    if not data.get("status") and data.get("c_url"):
        raise RuntimeError("12306 触发风控，需要验证")

    result = data.get("data", {}).get("result", [])
    data_map = data.get("data", {}).get("map", {})

    trains = []
    for entry in result:
        info = _parse_train_info(entry, data_map)
        if info:
            # 附加购买链接
            info["buy_link"] = (
                "https://kyfw.12306.cn/otn/leftTicket/init?"
                f"leftTicketDTO.train_date={date}"
                f"&leftTicketDTO.from_station={from_code}"
                f"&leftTicketDTO.to_station={to_code}"
                "&purpose_codes=ADULT"
            )
            trains.append(info)

    return trains
