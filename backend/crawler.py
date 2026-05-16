"""12306 API 爬虫模块 — 负责站名映射、车次查询、详情查询、价格查询."""
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

PRICE_URL = "https://kyfw.12306.cn/otn/leftTicket/queryTicketPrice"
QUERY_URL = "https://kyfw.12306.cn/otn/leftTicket/query"
DETAIL_URL = "https://kyfw.12306.cn/otn/czxx/queryByTrainNo"

# 12306 席别代码 → 中文名
SEAT_CODE_NAMES = {
    "9": "商务座",
    "A9": "商务座",
    "M": "一等座",
    "O": "二等座",
    "WZ": "无座",
    "6": "动卧",
    "4": "软卧",
    "3": "硬卧",
    "1": "硬座",
}

# 高铁/动车的席别代码 → 结果索引映射
# 12306 结果数组中的固定索引位置
HIGH_SPEED_AVAIL_INDEX = {
    "WZ": 26,  # 无座
    "O": 32,   # 二等座
    "M": 31,   # 一等座
    "9": 30,   # 商务座
}

# 普通列车
NORMAL_AVAIL_INDEX = {
    "WZ": 26,   # 无座
    "1": 27,    # 硬座
    "3": 29,    # 硬卧
    "4": 30,    # 软卧
}

_station_map: dict[str, str] = {}
_reverse_map: dict[str, str] = {}


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
    global _station_map, _reverse_map
    if _station_map:
        return _station_map
    with _client() as client:
        resp = client.get(STATION_NAME_URL)
        resp.raise_for_status()
        text = resp.text
    matches = re.findall(r"@[a-z]+\|([^\|]+)\|([A-Z]+)\|", text)
    _station_map = {name: code for name, code in matches}
    _reverse_map = {code: name for name, code in matches}
    return _station_map


def station_to_code(name: str) -> Optional[str]:
    m = load_station_map()
    if name in m:
        return m[name]
    for n, c in m.items():
        if name in n or n in name:
            return c
    return None


def code_to_station(code: str) -> Optional[str]:
    rm = _reverse_map
    if not rm:
        load_station_map()
        rm = _reverse_map
    return rm.get(code)


def _parse_seat_types(seat_types_str: str) -> list[str]:
    """解析 seat_types 字段，提取席别代码。
    格式如 '90M0O0W0': 每个代码(数字或字母大组)后跟一个数字标志位.
    """
    codes = []
    i = 0
    chars = list(seat_types_str)
    while i < len(chars):
        c = chars[i]
        if c.isdigit():
            # 单个数字作为席别代码（如 9=商务座, 1=硬座）
            codes.append(c)
            i += 1
            # 跳过紧随的纯数字标志位（通常 1 位）
            while i < len(chars) and chars[i].isdigit():
                i += 1
        elif c.isalpha():
            # 字母组作为席别代码（如 M=一等座, O=二等座, WZ=无座）
            code = ""
            while i < len(chars) and chars[i].isalpha():
                code += chars[i]
                i += 1
            codes.append(code)
            # 跳过紧随的数字标志位
            while i < len(chars) and chars[i].isdigit():
                i += 1
        else:
            i += 1
    return codes


def _query_prices(
    client: httpx.Client, train_no: str, from_no: str, to_no: str,
    seat_types: str, date: str
) -> dict[str, float]:
    """查询票价，返回 {席别代码: 价格(元)}."""
    try:
        time.sleep(random.uniform(0.3, 0.8))
        params = {
            "train_no": train_no,
            "from_station_no": from_no,
            "to_station_no": to_no,
            "seat_types": seat_types,
            "train_date": date,
        }
        resp = client.get(PRICE_URL, params=params)
        if resp.status_code != 200:
            return {}
        data = resp.json().get("data", {})
    except Exception:
        return {}

    prices = {}
    # 解析每个席别代码对应的价格（单位：角，需 /10 转元）
    for key, val in data.items():
        if key in ("train_no", "OT"):
            continue
        if isinstance(val, str) and val.startswith("¥"):
            try:
                prices[key] = float(val.replace("¥", ""))
            except ValueError:
                pass
        elif val and val.isdigit():
            prices[key] = float(val) / 10.0
    return prices


def _parse_train_info(entry: str, date: str) -> Optional[dict]:
    """解析单条车次数据，过滤全售罄车次（不查价格，快速返回）."""
    parts = entry.split("|")
    if len(parts) < 35:
        return None

    train_code = parts[3]
    internal_no = parts[2]
    from_code = parts[6]
    to_code = parts[7]
    start_time = parts[8]
    arrive_time = parts[9]
    duration_raw = parts[10]
    from_station = code_to_station(from_code) or from_code
    to_station = code_to_station(to_code) or to_code
    from_no = parts[16]
    to_no = parts[17]
    seat_types_str = parts[34]
    is_high_speed = train_code.startswith(("G", "D", "C"))

    seat_codes = _parse_seat_types(seat_types_str)
    avail_index = HIGH_SPEED_AVAIL_INDEX if is_high_speed else NORMAL_AVAIL_INDEX

    available_codes = []
    for code in seat_codes:
        idx = avail_index.get(code)
        if idx is not None and idx < len(parts):
            val = parts[idx]
            if val and val != "" and val != "无":
                available_codes.append(code)

    if not available_codes:
        return None

    # 只记录席别名称和可用状态，不查价格
    seats = []
    for code in seat_codes:
        if code not in available_codes:
            continue
        name = SEAT_CODE_NAMES.get(code, code)
        seats.append({"type": name})

    try:
        h, m = duration_raw.split(":")
        duration = f"{int(h)}h{int(m)}m"
    except (ValueError, AttributeError):
        duration = duration_raw

    buy_link = (
        "https://kyfw.12306.cn/otn/leftTicket/init?"
        f"leftTicketDTO.train_date={date}"
        f"&leftTicketDTO.from_station={from_code}"
        f"&leftTicketDTO.to_station={to_code}"
        "&purpose_codes=ADULT"
    )

    return {
        "train_no": train_code,
        "internal_no": internal_no,
        "from_station": from_station,
        "to_station": to_station,
        "from_code": from_code,
        "to_code": to_code,
        "from_no": from_no,
        "to_no": to_no,
        "seat_types": seat_types_str,
        "depart_time": start_time,
        "arrive_time": arrive_time,
        "duration": duration,
        "seats": seats,
        "buy_link": buy_link,
    }


def query_ticket_price(
    train_no: str, from_no: str, to_no: str,
    seat_types: str, date: str,
) -> dict[str, float]:
    """查询单趟车次的票价（公共函数，供前端懒加载调用）."""
    with _client() as client:
        client.get("https://kyfw.12306.cn/otn/leftTicket/init")
        time.sleep(random.uniform(0.3, 0.8))
        return _query_prices(client, train_no, from_no, to_no, seat_types, date)


def query_direct_trains(
    from_code: str, to_code: str, date: str
) -> list[dict]:
    """查询直达车次，过滤全售罄，带真实票价."""
    with _client() as client:
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

        trains = []
        for entry in result:
            info = _parse_train_info(entry, date)
            if info:
                trains.append(info)

    return trains


def query_train_detail(
    train_no: str,
    date: str,
    from_code: str = "",
    to_code: str = "",
    internal_no: str = "",
) -> dict:
    """查询车次经停站详情."""
    with _client() as client:
        client.get("https://kyfw.12306.cn/otn/leftTicket/init")
        time.sleep(random.uniform(0.3, 0.8))

        if not internal_no:
            # 如果未提供内部编号，尝试搜索
            load_station_map()
            internal_no, fc, tc = _resolve_train_info(train_no, date, client)
            if not from_code:
                from_code = fc
            if not to_code:
                to_code = tc

        params = {
            "train_no": internal_no,
            "from_station_telecode": from_code,
            "to_station_telecode": to_code,
            "depart_date": date,
        }
        resp = client.get(DETAIL_URL, params=params)
        resp.raise_for_status()
        data = resp.json()

    raw_stations = data.get("data", {}).get("data", [])
    route = []
    for s in raw_stations:
        route.append({
            "station": s.get("station_name", ""),
            "arrive": s.get("arrive_time", "—") or "—",
            "depart": s.get("start_time", "—") or "—",
        })

    return {"train_no": train_no, "route": route}


def _resolve_train_info(
    train_no: str, date: str, client: httpx.Client
) -> tuple[str, str, str]:
    """搜索常用路线获取内部车次编号和电报码."""
    load_station_map()

    common_routes = [
        ("北京南", "上海虹桥"), ("北京南", "上海"),
        ("北京", "上海"), ("北京", "上海虹桥"),
        ("北京南", "杭州东"), ("北京南", "南京南"),
        ("北京西", "广州南"), ("北京西", "深圳北"),
        ("上海虹桥", "北京南"), ("广州南", "深圳北"),
    ]

    for from_name, to_name in common_routes:
        fc = station_to_code(from_name)
        tc = station_to_code(to_name)
        if not fc or not tc:
            continue
        try:
            params = {
                "leftTicketDTO.train_date": date,
                "leftTicketDTO.from_station": fc,
                "leftTicketDTO.to_station": tc,
                "purpose_codes": "ADULT",
            }
            resp = client.get(QUERY_URL, params=params)
            resp.raise_for_status()
            data = resp.json()
            results = data.get("data", {}).get("result", [])
            for entry in results:
                parts = entry.split("|")
                if len(parts) > 7 and parts[3] == train_no:
                    return parts[2], parts[6], parts[7]
        except Exception:
            continue

    raise ValueError(f"无法解析车次 {train_no}，请提供 from_code/to_code 参数")
