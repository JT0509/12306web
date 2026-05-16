"""中转路线规划 — 枚举枢纽站，拼接中转方案."""
from backend.crawler import query_direct_trains, station_to_code

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


def find_transfers(from_code: str, to_code: str, date: str, passenger_count: int = 1) -> list[dict]:
    """查找中转方案，枚举枢纽站拼接两段直达."""
    results = []

    for hub in HUB_STATIONS:
        if hub in (from_code, to_code):
            continue

        try:
            leg1 = query_direct_trains(from_code, hub, date, passenger_count)
            leg2 = query_direct_trains(hub, to_code, date, passenger_count)
        except Exception:
            continue

        for t1 in leg1:
            for t2 in leg2:
                # 换乘时间必须在 30 分钟到 6 小时之间
                try:
                    h1, m1 = t1["arrive_time"].split(":")
                    h2, m2 = t2["depart_time"].split(":")
                    arrive_mins = int(h1) * 60 + int(m1)
                    depart_mins = int(h2) * 60 + int(m2)
                    transfer_mins = depart_mins - arrive_mins
                except (ValueError, KeyError):
                    continue

                if 30 <= transfer_mins <= 360:
                    # 取第一可用席别计算价格
                    seg1_price = _first_available_price(t1)
                    seg2_price = _first_available_price(t2)
                    if seg1_price is None or seg2_price is None:
                        continue

                    results.append({
                        "segments": [
                            _segment_info(t1, seg1_price),
                            _segment_info(t2, seg2_price),
                        ],
                        "transfer_station": t1["to_station"],
                        "total_duration": _format_duration(
                            _duration_mins(t2["arrive_time"])
                            - _duration_mins(t1["depart_time"])
                        ),
                        "total_price": seg1_price + seg2_price,
                        "transfer_time": f"{transfer_mins // 60}h{transfer_mins % 60}m",
                    })

        # 限制结果数，避免过多
        if len(results) >= 5:
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


def _segment_info(train: dict, price: float) -> dict:
    return {
        "train_no": train["train_no"],
        "from_station": train["from_station"],
        "to_station": train["to_station"],
        "depart_time": train["depart_time"],
        "arrive_time": train["arrive_time"],
        "duration": train["duration"],
        "seat": {"type": "参考价", "price": price},
    }


def _duration_mins(t: str) -> int:
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def _format_duration(mins: int) -> str:
    return f"{mins // 60}h{mins % 60}m"
