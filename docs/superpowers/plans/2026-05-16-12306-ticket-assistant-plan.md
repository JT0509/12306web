# 12306 购票助手 V1 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个帮助用户查询 12306 火车票的交互式网页，支持直达/中转查询、按价格/耗时排序、查看车次详情、跳转官网购买。

**Architecture:** Python FastAPI 后端代理请求 12306 API (httpx)，前端 Vanilla JS 调用后端接口渲染 UI。后端分层为 crawler(爬虫解析)、route_planner(中转规划)、main(API 路由+安全)。

**Tech Stack:** Python 3.10+, FastAPI, httpx, uvicorn / HTML5, CSS3, Vanilla JS

---

### Task 1: 项目骨架与依赖

**Files:**
- Create: `backend/requirements.txt`
- Create: `frontend/index.html` (骨架)
- Create: `frontend/css/style.css` (空)
- Create: `frontend/js/app.js` (空)
- Create: `backend/__init__.py` (空)
- Create: `.env`

- [ ] **Step 1: 创建 requirements.txt**

```txt
fastapi==0.115.6
uvicorn[standard]==0.34.0
httpx==0.28.1
```

- [ ] **Step 2: 创建 .env**

```env
HOST=127.0.0.1
PORT=8765
```

- [ ] **Step 3: 创建 index.html 骨架**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>12306 购票助手</title>
    <link rel="stylesheet" href="css/style.css">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self';">
</head>
<body>
    <div id="app"></div>
    <script src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: 安装 Python 依赖**

Run: `cd "D:/claude test" && pip install -r backend/requirements.txt`

- [ ] **Step 5: 验证前端静态文件可访问**

Run: `cd "D:/claude test/frontend" && python -m http.server 8080`
Expected: `Serving HTTP on 0.0.0.0 port 8080`，浏览器打开 `http://127.0.0.1:8080` 显示空白页

---

### Task 2: 爬虫模块 — 站名映射与基础请求

**Files:**
- Create: `backend/crawler.py`

- [ ] **Step 1: 创建 crawler.py 站名映射模块**

```python
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
```

- [ ] **Step 2: 测试站名映射**

Run: `cd "D:/claude test" && python -c "from backend.crawler import load_station_map, station_to_code; load_station_map(); print(station_to_code('北京南'))"`
Expected: 打印 `VNP`（北京南的电报码）

- [ ] **Step 3: 提交**

```bash
git add backend/requirements.txt backend/crawler.py backend/__init__.py frontend/index.html .env
git commit -m "feat: 项目骨架与站名映射模块"
```

---

### Task 3: 爬虫模块 — 直达车次查询与解析

**Files:**
- Modify: `backend/crawler.py` (追加代码)

- [ ] **Step 1: 在 crawler.py 中追加查询与解析函数**

```python
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
```

- [ ] **Step 2: 测试直达查询**

Run: `cd "D:/claude test" && python -c "
from backend.crawler import load_station_map, station_to_code, query_direct_trains
load_station_map()
from_code = station_to_code('北京')
to_code = station_to_code('上海')
print(f'北京={from_code}, 上海={to_code}')
trains = query_direct_trains(from_code, to_code, '2026-05-20')
print(f'找到 {len(trains)} 趟车次')
for t in trains[:3]:
    print(f\"  {t['train_no']} {t['from_station']}->{t['to_station']} {t['depart_time']}-{t['arrive_time']} {t['duration']}\")
"`

Expected: 打印车次列表（如 G1, G3 等）

- [ ] **Step 3: 提交**

```bash
git add backend/crawler.py
git commit -m "feat: 直达车次查询与解析"
```

---

### Task 4: 爬虫模块 — 车次详情查询

**Files:**
- Modify: `backend/crawler.py` (追加代码)

- [ ] **Step 1: 在 crawler.py 中追加详情查询函数**

```python
TRAIN_DETAIL_URL = "https://kyfw.12306.cn/otn/czxx/queryByTrainNo"


def query_train_detail(train_no: str, date: str) -> dict:
    """查询车次经停站详情."""
    with _client() as client:
        params = {
            "train_no": train_no,
            "from_station_telecode": "",
            "to_station_telecode": "",
            "depart_date": date,
        }
        resp = client.get(TRAIN_DETAIL_URL, params=params)
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
```

- [ ] **Step 2: 测试详情查询**

Run: `cd "D:/claude test" && python -c "
from backend.crawler import query_train_detail
detail = query_train_detail('G1', '2026-05-20')
print(f\"车次: {detail['train_no']}\")
for s in detail['route']:
    print(f\"  {s['station']} 到{s['arrive']} 发{s['depart']}\")
"`

Expected: 打印 G1 次列车的完整经停站列表

- [ ] **Step 3: 提交**

```bash
git add backend/crawler.py
git commit -m "feat: 车次详情查询"
```

---

### Task 5: 中转路线规划

**Files:**
- Create: `backend/route_planner.py`

- [ ] **Step 1: 创建 route_planner.py**

```python
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


def find_transfers(from_code: str, to_code: str, date: str) -> list[dict]:
    """查找中转方案，枚举枢纽站拼接两段直达."""
    results = []

    for hub in HUB_STATIONS:
        if hub in (from_code, to_code):
            continue

        try:
            leg1 = query_direct_trains(from_code, hub, date)
            leg2 = query_direct_trains(hub, to_code, date)
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
        if not s.get("sold_out") and s.get("price", 0) > 0:
            return s["price"]
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
```

- [ ] **Step 2: 测试中转规划**

Run: `cd "D:/claude test" && python -c "
from backend.crawler import load_station_map, station_to_code
from backend.route_planner import find_transfers
load_station_map()
from_code = station_to_code('北京')
to_code = station_to_code('上海')
results = find_transfers(from_code, to_code, '2026-05-20')
print(f'找到 {len(results)} 个中转方案')
for r in results[:3]:
    print(f\"  经{r['transfer_station']} 总价¥{r['total_price']} 换乘{r['transfer_time']}\")
"`

Expected: 打印中转方案列表

- [ ] **Step 3: 提交**

```bash
git add backend/route_planner.py
git commit -m "feat: 中转路线规划"
```

---

### Task 6: FastAPI 后端服务

**Files:**
- Create: `backend/main.py`

- [ ] **Step 1: 创建 main.py**

```python
"""12306 购票助手后端 — FastAPI 服务."""
import time
import logging
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.crawler import (
    load_station_map,
    station_to_code,
    query_direct_trains,
    query_train_detail,
)
from backend.route_planner import find_transfers

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("train-api")

# 速率限制
_ratelimit: dict[str, list[float]] = defaultdict(list)
_banlist: dict[str, float] = {}
RATE_LIMIT = 10       # 每分钟最多请求数
RATE_WINDOW = 60      # 窗口秒数
BAN_DURATION = 1800   # 封禁秒数

# 查询缓存
_cache: dict[str, tuple[float, dict]] = {}
CACHE_TTL = 120


def _check_rate_limit(ip: str) -> None:
    now = time.time()
    if ip in _banlist and now - _banlist[ip] < BAN_DURATION:
        remaining = int(BAN_DURATION - (now - _banlist[ip]))
        raise HTTPException(429, detail={
            "error": "操作太频繁，请稍后重试",
            "retry_after": remaining,
        })
    _ratelimit[ip] = [t for t in _ratelimit[ip] if now - t < RATE_WINDOW]
    if len(_ratelimit[ip]) >= RATE_LIMIT:
        _banlist[ip] = now
        raise HTTPException(429, detail={
            "error": "操作太频繁，请 {} 秒后重试".format(BAN_DURATION),
            "retry_after": BAN_DURATION,
        })
    _ratelimit[ip].append(now)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("预加载站名映射...")
    load_station_map()
    logger.info("服务启动完成")
    yield

app = FastAPI(
    title="12306 购票助手",
    version="1.0.0",
    lifespan=lifespan,
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:8765",
        "http://127.0.0.1:8765",
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers.pop("Server", None)
    response.headers.pop("X-Powered-By", None)
    return response


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f"未处理异常: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": "服务异常，请稍后重试"},
    )


@app.get("/api/health")
def health():
    return {"status": "ok"}


ALLOWED_SORT = {"price", "duration", "departure"}


@app.post("/api/search")
async def search(request: Request):
    ip = request.client.host if request.client else "unknown"
    _check_rate_limit(ip)

    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, detail={"error": "参数格式错误"})

    from_name = str(body.get("from", "")).strip()
    to_name = str(body.get("to", "")).strip()
    date = str(body.get("date", "")).strip()
    sort_by = str(body.get("sort_by", "price")).strip()

    # 输入校验
    if not from_name or not to_name or not date:
        raise HTTPException(400, detail={"error": "出发站、到达站和日期不能为空"})
    if len(from_name) > 20 or len(to_name) > 20:
        raise HTTPException(400, detail={"error": "站名长度不能超过20个字符"})
    if not all("一" <= c <= "鿿" or c.isalnum() for c in from_name + to_name):
        raise HTTPException(400, detail={"error": "站名包含不允许的字符"})
    if sort_by not in ALLOWED_SORT:
        sort_by = "price"
    # 日期格式校验
    import re
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", date):
        raise HTTPException(400, detail={"error": "日期格式错误"})

    # 缓存检查
    cache_key = f"{from_name}|{to_name}|{date}|{sort_by}"
    now = time.time()
    if cache_key in _cache:
        cached_time, cached_data = _cache[cache_key]
        if now - cached_time < CACHE_TTL:
            return cached_data

    # 站名转换
    from_code = station_to_code(from_name)
    to_code = station_to_code(to_name)
    if not from_code:
        raise HTTPException(400, detail={"error": f"未找到出发站「{from_name}」"})
    if not to_code:
        raise HTTPException(400, detail={"error": f"未找到到达站「{to_name}」"})

    # 查询直达
    logger.info(f"查询: {from_name}({from_code}) -> {to_name}({to_code}) 日期:{date}")
    try:
        direct = query_direct_trains(from_code, to_code, date)
    except RuntimeError as e:
        raise HTTPException(503, detail={"error": str(e)})
    except Exception as e:
        logger.error(f"12306 查询失败: {e}")
        raise HTTPException(503, detail={"error": "12306 查询服务暂不可用，请稍后重试"})

    # 查询中转（如果直达为空或直达少，总是搜中转）
    transfers = []
    try:
        transfers = find_transfers(from_code, to_code, date)
    except Exception as e:
        logger.warning(f"中转查询失败: {e}")

    # 排序
    if sort_by == "price":
        direct.sort(key=lambda t: _min_price(t))
        # transfers 已在 route_planner 按价格排序
    elif sort_by == "duration":
        direct.sort(key=lambda t: _duration_key(t))
        transfers.sort(key=lambda t: _duration_key_transfer(t))
    elif sort_by == "departure":
        direct.sort(key=lambda t: t.get("depart_time", "99:99"))

    result = {
        "from": from_name,
        "to": to_name,
        "date": date,
        "direct": direct,
        "transfers": transfers,
    }

    _cache[cache_key] = (now, result)
    return result


@app.get("/api/train/{train_no}")
async def train_detail(train_no: str, date: str = ""):
    """查询车次详情（经停站）."""
    if not date:
        raise HTTPException(400, detail={"error": "日期参数必填"})
    try:
        detail = query_train_detail(train_no, date)
    except Exception as e:
        logger.error(f"车次详情查询失败: {e}")
        raise HTTPException(503, detail={"error": "车次详情查询失败"})
    return detail


@app.get("/api/stations")
async def search_stations(q: str = ""):
    """站名模糊搜索，用于输入框下拉建议."""
    if not q or len(q) < 1:
        return {"stations": []}
    m = load_station_map()
    results = [n for n in m if q in n][:10]
    return {"stations": results}


def _min_price(train: dict) -> float:
    prices = [s["price"] for s in train.get("seats", []) if s.get("price", 0) > 0]
    return min(prices) if prices else float("inf")


def _duration_key(train: dict) -> int:
    d = train.get("duration", "0h0m")
    try:
        h, m = d.replace("h", " ").replace("m", "").split()
        return int(h) * 60 + int(m)
    except Exception:
        return 9999


def _duration_key_transfer(transfer: dict) -> int:
    d = transfer.get("total_duration", "0h0m")
    try:
        h, m = d.replace("h", " ").replace("m", "").split()
        return int(h) * 60 + int(m)
    except Exception:
        return 9999
```

- [ ] **Step 2: 启动后端服务**

Run: `cd "D:/claude test" && python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765`
Expected: 服务启动在 `http://127.0.0.1:8765`

- [ ] **Step 3: 测试 API 端点**

Run: `curl -s http://127.0.0.1:8765/api/health`
Expected: `{"status":"ok"}`

Run: `curl -s http://127.0.0.1:8765/api/stations?q=北京`
Expected: `{"stations": ["北京", "北京南", "北京西", ...]}`

Run:
```bash
curl -s -X POST http://127.0.0.1:8765/api/search \
  -H "Content-Type: application/json" \
  -d '{"from":"北京","to":"上海","date":"2026-05-20","sort_by":"price"}' | head -c 500
```
Expected: 返回 JSON 包含 `direct` 和 `transfers` 数组

- [ ] **Step 4: 提交**

```bash
git add backend/main.py
git commit -m "feat: FastAPI 后端服务与安全中间件"
```

---

### Task 7: 前端 — HTML 结构与 CSS 样式

**Files:**
- Modify: `frontend/index.html` (完整结构)
- Modify: `frontend/css/style.css` (完整样式)

- [ ] **Step 1: 更新 index.html 完整结构**

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>12306 购票助手</title>
    <link rel="stylesheet" href="css/style.css">
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' http://127.0.0.1:8765 http://localhost:8765;">
</head>
<body>
    <div id="app">
        <!-- 头部 -->
        <header class="header">
            <div class="header-inner">
                <h1 class="logo">
                    <span class="logo-icon">🚆</span> 12306 购票助手
                </h1>
                <p class="subtitle">直达 · 中转 · 比价 · 一键购票</p>
            </div>
        </header>

        <!-- 主内容区 -->
        <main class="main">
            <!-- 搜索面板 -->
            <section class="search-panel" id="searchPanel">
                <div class="search-row">
                    <div class="input-group">
                        <label for="fromInput">出发站</label>
                        <input type="text" id="fromInput" placeholder="输入城市或站名" autocomplete="off" maxlength="20">
                        <ul class="suggestions" id="fromSuggestions"></ul>
                    </div>
                    <button class="swap-btn" id="swapBtn" title="交换出发/到达">🔄</button>
                    <div class="input-group">
                        <label for="toInput">到达站</label>
                        <input type="text" id="toInput" placeholder="输入城市或站名" autocomplete="off" maxlength="20">
                        <ul class="suggestions" id="toSuggestions"></ul>
                    </div>
                    <div class="input-group date-group">
                        <label for="dateInput">出发日期</label>
                        <input type="date" id="dateInput">
                    </div>
                </div>

                <div class="search-actions">
                    <div class="sort-options">
                        <span class="sort-label">排序:</span>
                        <label class="sort-radio"><input type="radio" name="sort" value="price" checked> 价格</label>
                        <label class="sort-radio"><input type="radio" name="sort" value="duration"> 耗时</label>
                        <label class="sort-radio"><input type="radio" name="sort" value="departure"> 出发时间</label>
                    </div>
                    <button class="search-btn" id="searchBtn">🔍 查询</button>
                </div>

                <div class="filter-row" id="filterRow" style="display:none;">
                    <button class="filter-btn active" data-filter="all">全部</button>
                    <button class="filter-btn" data-filter="direct">直达</button>
                    <button class="filter-btn" data-filter="transfer">中转</button>
                </div>
            </section>

            <!-- 状态提示 -->
            <div class="status-bar" id="statusBar"></div>

            <!-- 结果区域 -->
            <section class="results" id="results"></section>
        </main>

        <!-- 页脚 -->
        <footer class="footer">
            <p>数据来源: 12306 官网 · 仅供查询参考，请以官网实际价格为准</p>
        </footer>
    </div>

    <script src="js/app.js"></script>
</body>
</html>
```

- [ ] **Step 2: 编写 style.css 完整样式**

```css
/* ===== Reset & Base ===== */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
    --primary: #1A73E8;
    --primary-dark: #1557B0;
    --bg: #F8F9FA;
    --card: #FFFFFF;
    --text: #202124;
    --text-secondary: #5F6368;
    --danger: #EA4335;
    --success: #34A853;
    --warning: #FBBC04;
    --border: #E8EAED;
    --shadow: 0 1px 3px rgba(0,0,0,0.08);
    --shadow-hover: 0 4px 12px rgba(0,0,0,0.12);
    --radius: 12px;
    --radius-sm: 8px;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.6;
    min-height: 100vh;
}

/* ===== Header ===== */
.header {
    background: linear-gradient(135deg, var(--primary) 0%, var(--primary-dark) 100%);
    color: #fff;
    padding: 20px 0 16px;
}
.header-inner {
    max-width: 960px;
    margin: 0 auto;
    padding: 0 20px;
}
.logo {
    font-size: 24px;
    font-weight: 700;
    letter-spacing: 1px;
}
.logo-icon { font-size: 28px; }
.subtitle {
    font-size: 13px;
    opacity: 0.85;
    margin-top: 4px;
}

/* ===== Main ===== */
.main {
    max-width: 960px;
    margin: 0 auto;
    padding: 20px;
}

/* ===== Search Panel ===== */
.search-panel {
    background: var(--card);
    border-radius: var(--radius);
    padding: 20px 24px;
    box-shadow: var(--shadow);
    margin-bottom: 16px;
}
.search-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
}
.input-group {
    flex: 1;
    position: relative;
}
.input-group label {
    display: block;
    font-size: 12px;
    color: var(--text-secondary);
    margin-bottom: 6px;
    font-weight: 500;
}
.input-group input {
    width: 100%;
    padding: 10px 12px;
    border: 1.5px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 15px;
    color: var(--text);
    outline: none;
    transition: border-color 0.2s;
}
.input-group input:focus {
    border-color: var(--primary);
    box-shadow: 0 0 0 3px rgba(26,115,232,0.12);
}
.input-group input.error {
    border-color: var(--danger);
    animation: shake 0.4s ease-in-out;
}
.input-group input:disabled {
    background: #f1f3f4;
    color: #9aa0a6;
}
.date-group { max-width: 160px; flex: none; }
.swap-btn {
    margin-top: 22px;
    width: 40px;
    height: 40px;
    border: 1.5px solid var(--border);
    border-radius: 50%;
    background: var(--card);
    cursor: pointer;
    font-size: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
    flex-shrink: 0;
}
.swap-btn:hover {
    background: var(--primary);
    color: #fff;
    border-color: var(--primary);
    transform: rotate(180deg);
}

/* Suggestions */
.suggestions {
    display: none;
    position: absolute;
    top: 100%;
    left: 0; right: 0;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: var(--shadow-hover);
    list-style: none;
    z-index: 100;
    max-height: 200px;
    overflow-y: auto;
}
.suggestions.show { display: block; }
.suggestions li {
    padding: 8px 12px;
    cursor: pointer;
    font-size: 14px;
    transition: background 0.15s;
}
.suggestions li:hover, .suggestions li.active { background: #E8F0FE; }

/* Search Actions */
.search-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 16px;
    gap: 12px;
    flex-wrap: wrap;
}
.sort-options { display: flex; align-items: center; gap: 12px; }
.sort-label { font-size: 13px; color: var(--text-secondary); }
.sort-radio {
    font-size: 14px;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 4px;
    color: var(--text-secondary);
    transition: color 0.15s;
}
.sort-radio input { display: none; }
.sort-radio:has(input:checked) { color: var(--primary); font-weight: 600; }
.search-btn {
    padding: 10px 28px;
    background: var(--primary);
    color: #fff;
    border: none;
    border-radius: var(--radius-sm);
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
}
.search-btn:hover:not(:disabled) { background: var(--primary-dark); transform: translateY(-1px); }
.search-btn:disabled { opacity: 0.6; cursor: not-allowed; }

/* Filter Row */
.filter-row { display: flex; gap: 8px; margin-top: 14px; }
.filter-btn {
    padding: 6px 16px;
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--card);
    font-size: 13px;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
}
.filter-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
.filter-btn:hover:not(.active) { background: #f1f3f4; }

/* ===== Status Bar ===== */
.status-bar { min-height: 20px; margin-bottom: 8px; }
.status-msg {
    padding: 10px 16px;
    border-radius: var(--radius-sm);
    font-size: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
}
.status-msg.success { background: #E6F4EA; color: #1E7E34; }
.status-msg.warning { background: #FEF7E0; color: #B06000; }
.status-msg.error { background: #FCE8E6; color: #C5221F; }
.status-msg.loading { background: #E8F0FE; color: var(--primary); }
.retry-btn {
    margin-left: auto;
    padding: 4px 12px;
    border: 1px solid currentColor;
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font-size: 12px;
}

/* ===== Results ===== */
.results { display: flex; flex-direction: column; gap: 12px; }

/* Section Title */
.section-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text);
    padding: 4px 0;
    display: flex;
    align-items: center;
    gap: 8px;
}
.section-title .count {
    font-weight: 400;
    font-size: 13px;
    color: var(--text-secondary);
}

/* ===== Train Card ===== */
.train-card {
    background: var(--card);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
    transition: all 0.25s ease;
    cursor: default;
}
.train-card:hover {
    box-shadow: var(--shadow-hover);
    transform: translateY(-2px);
}
.card-header {
    display: flex;
    align-items: center;
    padding: 14px 18px;
    gap: 12px;
}
.badge {
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
}
.badge.best-price { background: #E6F4EA; color: var(--success); }
.badge.best-time { background: #E8F0FE; color: var(--primary); }
.badge.transfer { background: #FEF7E0; color: #B06000; }
.train-code {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 1px;
}
.card-route { font-size: 14px; color: var(--text); flex: 1; }
.card-route .arrow { color: var(--text-secondary); margin: 0 6px; }
.card-time {
    font-size: 14px;
    color: var(--text-secondary);
    white-space: nowrap;
}

/* Seats */
.seat-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 18px 10px;
}
.seat-item {
    padding: 6px 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    font-size: 13px;
    display: flex;
    align-items: center;
    gap: 6px;
    transition: all 0.2s;
}
.seat-item:hover { border-color: var(--primary); background: #E8F0FE; }
.seat-item.sold-out {
    opacity: 0.45;
    text-decoration: line-through;
    cursor: not-allowed;
}
.seat-type { color: var(--text-secondary); }
.seat-price { color: var(--danger); font-weight: 600; }
.seat-item.sold-out .seat-price { color: var(--text-secondary); }

/* Card Actions */
.card-actions {
    display: flex;
    gap: 8px;
    padding: 0 18px 14px;
}
.btn {
    padding: 7px 16px;
    border-radius: 6px;
    font-size: 13px;
    cursor: pointer;
    font-weight: 500;
    border: none;
    transition: all 0.2s;
}
.btn-detail {
    background: #F1F3F4;
    color: var(--text);
}
.btn-detail:hover { background: #E8EAED; }
.btn-buy {
    background: var(--danger);
    color: #fff;
}
.btn-buy:hover { filter: brightness(1.1); }

/* Detail Expand */
.card-detail {
    display: none;
    border-top: 1px solid var(--border);
    padding: 14px 18px;
    background: #FAFAFA;
}
.card-detail.show { display: block; }
.route-timeline {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    overflow-x: auto;
    padding: 8px 0;
}
.route-stop {
    flex-shrink: 0;
    text-align: center;
    padding: 0 8px;
    position: relative;
}
.route-stop .station-name { font-size: 13px; font-weight: 500; }
.route-stop .station-time { font-size: 11px; color: var(--text-secondary); }
.route-stop:not(:last-child)::after {
    content: "→";
    position: absolute;
    right: -14px;
    top: 8px;
    color: var(--text-secondary);
    font-size: 12px;
}

/* Transfer Card */
.transfer-card {
    background: var(--card);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
    overflow: hidden;
    transition: all 0.25s ease;
}
.transfer-card:hover {
    box-shadow: var(--shadow-hover);
    transform: translateY(-2px);
}
.transfer-header {
    padding: 12px 18px;
    background: #FFF8E1;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
}
.transfer-segment {
    padding: 10px 18px;
    border-bottom: 1px dashed var(--border);
    font-size: 14px;
}
.transfer-segment:last-of-type { border-bottom: none; }
.transfer-wait {
    text-align: center;
    padding: 6px 0;
    color: var(--warning);
    font-size: 13px;
    font-weight: 500;
}
.transfer-total {
    padding: 10px 18px;
    font-size: 14px;
    font-weight: 600;
    display: flex;
    gap: 16px;
}

/* ===== Skeleton Loading ===== */
.skeleton {
    background: var(--card);
    border-radius: var(--radius);
    padding: 18px;
    box-shadow: var(--shadow);
}
.skeleton-line {
    height: 14px;
    background: linear-gradient(90deg, #eee 25%, #f5f5f5 50%, #eee 75%);
    background-size: 200% 100%;
    animation: shimmer 1.5s infinite;
    border-radius: 4px;
    margin-bottom: 10px;
}
.skeleton-line:last-child { margin-bottom: 0; width: 60%; }
@keyframes shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
}

/* ===== Empty State ===== */
.empty-state {
    text-align: center;
    padding: 48px 20px;
    color: var(--text-secondary);
}
.empty-state .empty-icon { font-size: 48px; margin-bottom: 12px; }
.empty-state p { font-size: 15px; }

/* ===== History ===== */
.history-bar {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-bottom: 12px;
}
.history-tag {
    padding: 4px 12px;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    font-size: 12px;
    cursor: pointer;
    color: var(--text-secondary);
    transition: all 0.2s;
}
.history-tag:hover { border-color: var(--primary); color: var(--primary); }

/* ===== Shake ===== */
@keyframes shake {
    0%, 100% { transform: translateX(0); }
    25% { transform: translateX(-6px); }
    75% { transform: translateX(6px); }
}

/* ===== Footer ===== */
.footer {
    text-align: center;
    padding: 20px;
    color: var(--text-secondary);
    font-size: 12px;
    opacity: 0.7;
}

/* ===== Responsive ===== */
@media (max-width: 640px) {
    .search-row { flex-direction: column; }
    .date-group { max-width: 100%; }
    .swap-btn { margin-top: 0; align-self: center; }
    .search-actions { flex-direction: column; }
    .card-header { flex-wrap: wrap; }
}
```

- [ ] **Step 3: 提交**

```bash
git add frontend/index.html frontend/css/style.css
git commit -m "feat: 前端 HTML 结构与完整 CSS 样式"
```

---

### Task 8: 前端 JS — 核心交互逻辑

**Files:**
- Modify: `frontend/js/app.js` (完整脚本)

- [ ] **Step 1: 创建 app.js 完整脚本**

```javascript
/* global fetch, localStorage, setTimeout, clearTimeout, console, window, document, DOMParser */

(function() {
    'use strict';

    // ===== 常量 =====
    const API_BASE = 'http://127.0.0.1:8765';
    const HISTORY_KEY = 'train_query_history';
    const MAX_HISTORY = 5;

    // ===== DOM 引用 =====
    const $ = sel => document.querySelector(sel);
    const $$ = sel => document.querySelectorAll(sel);

    const fromInput = $('#fromInput');
    const toInput = $('#toInput');
    const dateInput = $('#dateInput');
    const searchBtn = $('#searchBtn');
    const swapBtn = $('#swapBtn');
    const statusBar = $('#statusBar');
    const results = $('#results');
    const filterRow = $('#filterRow');
    const fromSuggestions = $('#fromSuggestions');
    const toSuggestions = $('#toSuggestions');

    // ===== 初始化 =====
    function init() {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        dateInput.min = tomorrow.toISOString().split('T')[0];
        dateInput.value = tomorrow.toISOString().split('T')[0];

        loadHistory();
        bindEvents();
    }

    // ===== 事件绑定 =====
    function bindEvents() {
        searchBtn.addEventListener('click', doSearch);
        swapBtn.addEventListener('click', swapStations);
        fromInput.addEventListener('input', debounce(() => suggestStations(fromInput, fromSuggestions), 250));
        toInput.addEventListener('input', debounce(() => suggestStations(toInput, toSuggestions), 250));
        document.addEventListener('click', closeSuggestions);

        $$('input[name="sort"]').forEach(r => r.addEventListener('change', () => {
            if (results.children.length > 0) doSearch();
        }));

        $$('.filter-btn').forEach(b => b.addEventListener('click', function() {
            $$('.filter-btn').forEach(x => x.classList.remove('active'));
            this.classList.add('active');
            applyFilter(this.dataset.filter);
        }));
    }

    // ===== 车站建议 =====
    async function suggestStations(input, listEl) {
        const q = input.value.trim();
        if (q.length < 1) { listEl.classList.remove('show'); return; }
        try {
            const resp = await fetch(`${API_BASE}/api/stations?q=${encodeURIComponent(q)}`);
            const data = await resp.json();
            renderSuggestions(listEl, data.stations || [], input);
        } catch (e) {
            console.error('车站搜索失败', e);
        }
    }

    function renderSuggestions(el, stations, input) {
        el.innerHTML = '';
        if (stations.length === 0) { el.classList.remove('show'); return; }
        stations.forEach(s => {
            const li = document.createElement('li');
            li.textContent = s;
            li.addEventListener('mousedown', () => {
                input.value = s;
                el.classList.remove('show');
            });
            el.appendChild(li);
        });
        el.classList.add('show');
    }

    function closeSuggestions(e) {
        if (!e.target.closest('.input-group')) {
            fromSuggestions.classList.remove('show');
            toSuggestions.classList.remove('show');
        }
    }

    // ===== 交换车站 =====
    function swapStations() {
        const tmp = fromInput.value;
        fromInput.value = toInput.value;
        toInput.value = tmp;
    }

    // ===== 输入校验 =====
    function validateInputs() {
        let ok = true;
        [fromInput, toInput].forEach(inp => {
            inp.classList.remove('error');
            if (!inp.value.trim()) {
                inp.classList.add('error');
                ok = false;
            }
        });
        return ok;
    }

    // ===== 查询 =====
    async function doSearch() {
        if (!validateInputs()) {
            showStatus('请填写出发站和到达站', 'error');
            return;
        }

        const from = fromInput.value.trim();
        const to = toInput.value.trim();
        const date = dateInput.value;
        const sortBy = document.querySelector('input[name="sort"]:checked')?.value || 'price';

        setLoading(true);
        showStatus('正在查询车次信息...', 'loading');
        results.innerHTML = renderSkeletons(3);

        try {
            const resp = await fetch(`${API_BASE}/api/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ from, to, date, sort_by: sortBy }),
            });
            const data = await resp.json();

            if (!resp.ok) {
                showStatus(data.error || '查询失败', 'error');
                results.innerHTML = '';
                return;
            }

            saveHistory({ from, to, date });
            renderResults(data);
            filterRow.style.display = (data.direct.length > 0 && data.transfers.length > 0) ? 'flex' : 'none';
            $$('.filter-btn').forEach(b => b.classList.toggle('active', b.dataset.filter === 'all'));

            const total = data.direct.length + data.transfers.length;
            if (total === 0) {
                showStatus('未找到该线路的车次，请尝试调整日期或拆段查询', 'warning');
            } else {
                showStatus(`找到 ${data.direct.length} 趟直达 + ${data.transfers.length} 个中转方案`, 'success');
            }
        } catch (e) {
            console.error('查询失败', e);
            showStatus('网络连接失败，请检查后端服务是否已启动', 'error');
            results.innerHTML = '';
        } finally {
            setLoading(false);
        }
    }

    // ===== 渲染结果 =====
    function renderResults(data) {
        results.innerHTML = '';

        if (data.direct.length > 0) {
            results.appendChild(createSectionTitle('直达车次', data.direct.length, 'direct'));
            data.direct.forEach((train, idx, arr) => {
                results.appendChild(createTrainCard(train, idx, arr));
            });
        }

        if (data.transfers.length > 0) {
            results.appendChild(createSectionTitle('中转方案', data.transfers.length, 'transfer'));
            data.transfers.forEach(t => results.appendChild(createTransferCard(t)));
        }

        if (data.direct.length === 0 && data.transfers.length === 0) {
            results.innerHTML = '<div class="empty-state"><div class="empty-icon">🔍</div><p>暂无车次，请尝试其他日期或线路</p></div>';
        }
    }

    function createSectionTitle(text, count, type) {
        const div = document.createElement('div');
        div.className = 'section-title';
        div.dataset.type = type;
        div.innerHTML = `📌 ${text} <span class="count">(${count}个)</span>`;
        return div;
    }

    function createTrainCard(train, idx, arr) {
        const card = document.createElement('div');
        card.className = 'train-card';
        card.dataset.type = 'direct';

        // 找最低/最快标记
        const minPrice = Math.min(...arr.map(t => minPriceOf(t)).filter(p => p > 0));
        const minDur = Math.min(...arr.map(t => durMins(t)));
        const thisPrice = minPriceOf(train);
        const thisDur = durMins(train);

        let badges = '';
        if (thisPrice > 0 && thisPrice === minPrice) badges += '<span class="badge best-price">💡 最实惠</span>';
        if (thisDur > 0 && thisDur === minDur) badges += '<span class="badge best-time">⚡ 最快</span>';

        const seatsHtml = train.seats.map(s => {
            const cls = s.sold_out ? 'seat-item sold-out' : 'seat-item';
            const price = s.sold_out ? '已售罄' : `¥${s.price}`;
            return `<div class="${cls}"><span class="seat-type">${s.type}</span><span class="seat-price">${price}</span></div>`;
        }).join('');

        card.innerHTML = `
            <div class="card-header">
                ${badges}
                <span class="train-code">${escapeHtml(train.train_no)}</span>
                <span class="card-route">${escapeHtml(train.from_station)} <span class="arrow">→</span> ${escapeHtml(train.to_station)}</span>
                <span class="card-time">${escapeHtml(train.depart_time)} - ${escapeHtml(train.arrive_time)}</span>
                <span style="color:var(--text-secondary);font-size:13px;">${escapeHtml(train.duration)}</span>
            </div>
            <div class="seat-list">${seatsHtml || '<span style="font-size:12px;color:var(--text-secondary);">暂无可选席别</span>'}</div>
            <div class="card-actions">
                <button class="btn btn-detail" data-action="detail" data-train="${escapeHtml(train.train_no)}">📋 查看详情</button>
                <button class="btn btn-buy" data-action="buy" data-link="${escapeHtml(train.buy_link)}">🔗 去官网购买</button>
            </div>
            <div class="card-detail" data-train-detail="${escapeHtml(train.train_no)}"></div>
        `;

        card.querySelector('.btn-detail')?.addEventListener('click', e => toggleDetail(e, train.train_no));
        card.querySelector('.btn-buy')?.addEventListener('click', e => openBuyLink(e, train.buy_link));
        return card;
    }

    function createTransferCard(transfer) {
        const card = document.createElement('div');
        card.className = 'transfer-card';
        card.dataset.type = 'transfer';

        const segmentsHtml = transfer.segments.map(s => `
            <div class="transfer-segment">
                <span style="font-weight:600;">${escapeHtml(s.train_no)}</span>
                ${escapeHtml(s.from_station)} → ${escapeHtml(s.to_station)}
                <span style="color:var(--text-secondary);">${escapeHtml(s.depart_time)} - ${escapeHtml(s.arrive_time)} (${escapeHtml(s.duration)})</span>
            </div>
        `).join('') + `<div class="transfer-wait">⏳ 换乘 ${escapeHtml(transfer.transfer_time)}</div>`;

        const warnClass = transfer.transfer_time.includes('0h') && parseInt(transfer.transfer_time) < 30
            ? 'color:var(--danger);' : '';

        card.innerHTML = `
            <div class="transfer-header">
                🔄 经 <b>${escapeHtml(transfer.transfer_station)}</b> 中转
                <span>总价: <b style="color:var(--danger);">¥${transfer.total_price}</b></span>
                <span style="${warnClass}">总耗时: ${escapeHtml(transfer.total_duration)}</span>
            </div>
            ${segmentsHtml}
            <div class="card-actions" style="padding-top:8px;">
                <button class="btn btn-buy" data-action="buy" data-link="https://kyfw.12306.cn/otn/leftTicket/init">🔗 分段购票（去官网）</button>
            </div>
            <div class="card-detail" data-train-detail="transfer-${escapeHtml(transfer.transfer_station)}"></div>
        `;
        return card;
    }

    // ===== 详情展开 =====
    async function toggleDetail(e, trainNo) {
        const card = e.target.closest('.train-card, .transfer-card');
        const detailEl = card?.querySelector('.card-detail');
        if (!detailEl) return;

        if (detailEl.classList.contains('show')) {
            detailEl.classList.remove('show');
            return;
        }

        const date = dateInput.value;
        detailEl.innerHTML = '<div class="skeleton-line" style="width:80%;"></div><div class="skeleton-line" style="width:60%;"></div>';
        detailEl.classList.add('show');

        try {
            const resp = await fetch(`${API_BASE}/api/train/${encodeURIComponent(trainNo)}?date=${encodeURIComponent(date)}`);
            const data = await resp.json();
            detailEl.innerHTML = `
                <div class="route-timeline">
                    ${data.route.map(s => `
                        <div class="route-stop">
                            <div class="station-name">${escapeHtml(s.station)}</div>
                            <div class="station-time">到 ${escapeHtml(s.arrive)} 发 ${escapeHtml(s.depart)}</div>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (e) {
            detailEl.innerHTML = '<p style="color:var(--danger);font-size:13px;">详情加载失败</p>';
        }
    }

    // ===== 跳转购买 =====
    function openBuyLink(e, link) {
        e.stopPropagation();
        const url = new URL(link);
        if (!url.hostname.endsWith('12306.cn')) {
            showStatus('链接无效，已被拦截', 'error');
            return;
        }
        window.open(link, '_blank', 'noopener');
    }

    // ===== 筛选 =====
    function applyFilter(filter) {
        $$('.train-card, .transfer-card, .section-title').forEach(el => {
            if (filter === 'all') { el.style.display = ''; return; }
            if (el.dataset.type === filter) el.style.display = '';
            else if (el.dataset.type) el.style.display = 'none';
        });
    }

    // ===== 骨架屏 =====
    function renderSkeletons(n) {
        return Array(n).fill(0).map(() => `
            <div class="skeleton">
                <div class="skeleton-line" style="width:40%;"></div>
                <div class="skeleton-line" style="width:70%;"></div>
                <div class="skeleton-line"></div>
            </div>
        `).join('');
    }

    // ===== 状态提示 =====
    function showStatus(msg, type) {
        statusBar.innerHTML = `<div class="status-msg ${type}">${msg}</div>`;
    }

    // ===== 加载态 =====
    function setLoading(loading) {
        searchBtn.disabled = loading;
        searchBtn.textContent = loading ? '查询中...' : '🔍 查询';
        fromInput.disabled = loading;
        toInput.disabled = loading;
        dateInput.disabled = loading;
    }

    // ===== 查询历史 =====
    function saveHistory(query) {
        try {
            let history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            history = history.filter(h => !(h.from === query.from && h.to === query.to));
            history.unshift(query);
            history = history.slice(0, MAX_HISTORY);
            localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
            loadHistory();
        } catch (e) { /* ignore */ }
    }

    function loadHistory() {
        try {
            const history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
            let bar = $('.history-bar');
            if (!bar) {
                bar = document.createElement('div');
                bar.className = 'history-bar';
                $('#searchPanel').insertBefore(bar, $('.search-row'));
            }
            bar.innerHTML = history.length > 0 ? '<span style="font-size:12px;color:var(--text-secondary);">最近查询:</span>' : '';
            history.forEach(h => {
                const tag = document.createElement('span');
                tag.className = 'history-tag';
                tag.textContent = `${h.from}→${h.to}`;
                tag.addEventListener('click', () => {
                    fromInput.value = h.from;
                    toInput.value = h.to;
                    dateInput.value = h.date;
                    doSearch();
                });
                bar.appendChild(tag);
            });
        } catch (e) { /* ignore */ }
    }

    // ===== 工具函数 =====
    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function minPriceOf(train) {
        const prices = (train.seats || []).map(s => s.price || 0).filter(p => p > 0);
        return prices.length > 0 ? Math.min(...prices) : 0;
    }

    function durMins(train) {
        const d = train.duration || '0h0m';
        const m = d.match(/(\d+)h(\d+)m/);
        return m ? parseInt(m[1]) * 60 + parseInt(m[2]) : 9999;
    }

    function debounce(fn, delay) {
        let timer;
        return function(...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }

    // ===== 启动 =====
    init();
})();
```

- [ ] **Step 2: 提交**

```bash
git add frontend/js/app.js
git commit -m "feat: 前端核心交互逻辑（查询/展示/详情/购买/排序/筛选/历史）"
```

---

### Task 9: 集成验证与完善

- [ ] **Step 1: 启动后端服务**

Run (background): `cd "D:/claude test" && python -m uvicorn backend.main:app --host 127.0.0.1 --port 8765`

- [ ] **Step 2: 启动前端静态服务**

Run (background): `cd "D:/claude test/frontend" && python -m http.server 8080 --bind 127.0.0.1`

- [ ] **Step 3: 浏览器验证**

1. 打开 `http://127.0.0.1:8080`
2. 验证站名建议下拉（输入"北京"应显示建议列表）
3. 输入出发"北京"、到达"上海"、选择未来日期，点击查询
4. 验证直达列表正常渲染，合并显示「💡最实惠」「⚡最快」标记
5. 验证中转方案显示
6. 验证"查看详情"展开/收起经停站
7. 验证"去官网购买"新窗口打开 12306 链接
8. 验证排序切换（价格/耗时/出发时间）
9. 验证筛选（全部/直达/中转）
10. 验证交换出发/到达按钮
11. 验证查询历史记录
12. 验证空输入时的错误抖动
13. 验证 60 秒内重复查询超过 10 次触发 429

- [ ] **Step 4: 提交最终**

```bash
git add -A
git commit -m "feat: 12306 购票助手 V1 完成"
```
