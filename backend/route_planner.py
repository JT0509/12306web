"""中转路线规划 — 枚举枢纽站，拼接中转方案."""
from backend.crawler import query_direct_trains, station_to_code
from concurrent.futures import ThreadPoolExecutor, as_completed

# 主要枢纽站（电报码）
HUB_STATIONS = [
    "NJH",  # 南京南
    "ZZF",  # 郑州东
    "WHN",  # 武汉
    "CSQ",  # 长沙南
    "JNK",  # 济南西
    "HFH",  # 合肥南
    "XAY",  # 西安北
    "ICW",  # 成都东
    "HZJ",  # 杭州东
]


def _query_hub(hub, from_code, to_code, date, passenger_count):
    """查询单个枢纽的两段直达."""
    if hub in (from_code, to_code):
        return []
    try:
        leg1 = query_direct_trains(from_code, hub, date, passenger_count)
        leg2 = query_direct_trains(hub, to_code, date, passenger_count)
    except Exception:
        return []

    pairs = []
    for t1 in leg1:
        for t2 in leg2:
            try:
                h1, m1 = t1["arrive_time"].split(":")
                h2, m2 = t2["depart_time"].split(":")
                arrive_mins = int(h1) * 60 + int(m1)
                depart_mins = int(h2) * 60 + int(m2)
                transfer_mins = depart_mins - arrive_mins
            except (ValueError, KeyError):
                continue

            if 30 <= transfer_mins <= 360:
                seg1_price = _first_available_price(t1)
                seg2_price = _first_available_price(t2)
                if seg1_price is None or seg2_price is None:
                    continue

                pairs.append({
                    "segments": [
                        _segment_info(t1, seg1_price, date),
                        _segment_info(t2, seg2_price, date),
                    ],
                    "transfer_station": t1["to_station"],
                    "total_duration": _format_duration(
                        _duration_mins(t2["arrive_time"])
                        - _duration_mins(t1["depart_time"])
                    ),
                    "total_price": seg1_price + seg2_price,
                    "transfer_time": f"{transfer_mins // 60}h{transfer_mins % 60}m",
                })
    return pairs


def find_transfers(from_code: str, to_code: str, date: str, passenger_count: int = 1) -> list[dict]:
    """查找中转方案，并行枚举枢纽站拼接两段直达."""
    results = []
    hubs = [h for h in HUB_STATIONS if h not in (from_code, to_code)]

    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {
            executor.submit(_query_hub, h, from_code, to_code, date, passenger_count): h
            for h in hubs
        }
        for future in as_completed(futures):
            pairs = future.result()
            results.extend(pairs)
            if len(results) >= 15:  # 提前收工
                executor.shutdown(wait=False, cancel_futures=True)
                break

    results.sort(key=lambda x: x["total_price"])
    return results[:10]


def _first_available_price(train: dict) -> float | None:
    for s in train.get("seats", []):
        if s.get("price") and s["price"] > 0:
            return s["price"]
    # 有席别但价格尚未查询，返回 0 中转仍可展示
    if train.get("seats"):
        return 0
    return None


from urllib.parse import quote

def _segment_info(train: dict, price: float, date: str = "") -> dict:
    fc = train.get("from_code", "")
    tc = train.get("to_code", "")
    fs = train.get("from_station", "")
    ts = train.get("to_station", "")
    return {
        "train_no": train["train_no"],
        "from_station": fs,
        "to_station": ts,
        "from_code": fc,
        "to_code": tc,
        "depart_time": train["depart_time"],
        "arrive_time": train["arrive_time"],
        "duration": train["duration"],
        "seat": {"type": "参考价", "price": price},
        "search_link": (
            "https://kyfw.12306.cn/otn/leftTicket/init?linktypeid=dc"
            f"&fs={quote(fc + ',' + fs)}&ts={quote(tc + ',' + ts)}"
            f"&date={quote(date)}&flag=N,N,Y&purpose_codes=ADULT"
        ) if date else "",
    }


def _duration_mins(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _format_duration(mins: int) -> str:
    return f"{mins // 60}h{mins % 60}m"
