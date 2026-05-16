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
    for h in ("Server", "X-Powered-By"):
        if h in response.headers:
            del response.headers[h]
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
