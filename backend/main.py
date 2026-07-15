"""Buoy Platform 백엔드 — FastAPI 앱·라우트 (Phase 0: 데이터 레이어만).

부이 위주(조위관측소 제외) 다기관(KMA·KHOA) 해양부이 통합 모니터링 API.
포트는 .env PORT(기본 8506). React `frontend/dist` 가 있으면 SPA 정적 서빙(Phase 1 이후 대상).
"""
from __future__ import annotations

import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import config
import kma_marine
import live_cache
import stations as stations_mod
import status as status_mod
import timeseries as timeseries_mod
import forecast as forecast_mod


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # 백그라운드 라이브 스냅샷 리프레셔 시작(live_cache.py) — 서버 기동은 이 완료를 기다리지 않는다
    # (첫 채움은 KMA 는 즉시, KHOA 는 burst 소요시간 ≈6초 후 대부분 채워짐. /api/health 는 스냅샷과 무관).
    live_cache.start_refresher()
    yield


app = FastAPI(title="Buoy Platform API", lifespan=_lifespan)

_CORS_ORIGINS = os.environ.get(
    "CORS_ORIGINS", "http://localhost:5173,http://localhost:4173"
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── /api/live 레코드 변환 헬퍼 ────────────────────────────────────────────────

def _fmt_kma_tm(tm: str) -> str | None:
    """'YYYYMMDDHHMI' → 'YYYY-MM-DD HH:MM' (KHOA obsrvnDt 와 표시 포맷 통일)."""
    if not tm or len(tm) != 12:
        return tm
    return f"{tm[0:4]}-{tm[4:6]}-{tm[6:8]} {tm[8:10]}:{tm[10:12]}"


def _kma_live_item(o: dict, now) -> dict:
    st = status_mod.classify(o["tm"], now, source="KMA")
    return {
        "source": "KMA",
        "id": o["id"],
        "name": o["name"],
        "lon": o["lon"],
        "lat": o["lat"],
        "tp": o["tp"],
        "tp_label": o["tp_label"],
        "obs_time": _fmt_kma_tm(o["tm"]),
        "status": st["status"].value,
        "minutes_since": st["minutes_since"],
        "values": {
            "wave_height": o["wh"],
            "wind_dir": o["wd"],
            "wind_speed": o["ws"],
            "wind_gust": o["ws_gst"],
            "water_temp": o["tw"],
            "air_temp": o["ta"],
            "pressure": o["pa"],
            "humidity": o["hm"],
        },
    }


def _khoa_live_item(obs_code: str, rec: dict, now) -> dict:
    st = status_mod.classify(rec.get("obsrvnDt"), now, source="KHOA")
    return {
        "source": "KHOA",
        "id": obs_code,
        "name": rec.get("obsvtrNm"),
        "lon": rec.get("lot"),  # KHOA 응답 필드명 lot=경도 (오타 아님, API 원 필드명)
        "lat": rec.get("lat"),
        "tp": obs_code.split("_")[0],
        "tp_label": "해양관측부이",
        "obs_time": rec.get("obsrvnDt"),
        "status": st["status"].value,
        "minutes_since": st["minutes_since"],
        "values": {
            "wave_height": rec.get("wvhgt"),
            "wave_period": rec.get("wvpd"),
            "wind_dir": rec.get("wndrct"),
            "wind_speed": rec.get("wspd"),
            "wind_gust": rec.get("maxMmntWspd"),
            "water_temp": rec.get("wtem"),
            "air_temp": rec.get("artmp"),
            "pressure": rec.get("atmpr"),
            "current_dir": rec.get("crdir"),
            "current_speed_cms": rec.get("crsp"),
            "salinity": rec.get("slnty"),
        },
    }


def build_live_snapshot() -> list[dict]:
    """`live_cache.py` 백그라운드 스냅샷을 읽어 상태만 **현재시각 기준**으로 매 요청 재계산한다.

    외부 API 호출 0회(스냅샷 갱신은 백그라운드 데몬 스레드가 전담) — 요청 빈도가 아무리 높아도
    KMA/KHOA 호출량은 늘지 않는다. 상세는 `live_cache.py` 모듈독스트링(Rate budget 계산 포함).
    """
    now = kma_marine.now_kst()
    out: list[dict] = []

    kma_obs, _kma_at = live_cache.get_kma_snapshot()
    for o in kma_obs:
        if o["tp"] not in ("B", "C"):
            continue
        out.append(_kma_live_item(o, now))

    khoa_obs, _khoa_at = live_cache.get_khoa_snapshot()
    for obs_code, rec in khoa_obs.items():
        out.append(_khoa_live_item(obs_code, rec, now))

    return out


# ── 라우트 ────────────────────────────────────────────────────────────────

@app.get("/api/health")
def api_health():
    return {"ok": True, "time": kma_marine.now_kst().strftime("%Y-%m-%dT%H:%M:%S")}


@app.get("/api/stations")
def api_stations():
    items = stations_mod.get_stations()
    return {"count": len(items), "items": items}


@app.get("/api/live")
def api_live():
    items = build_live_snapshot()
    return {"count": len(items), "items": items}


@app.get("/api/status")
def api_status():
    """부이별 수신상태 집계(정상/지연/미수신, 소스별) + 라이브 캐시 신선도(디버그용).

    `build_live_snapshot()`(외부 호출 0회)를 그대로 재사용 — `/api/live` 와 동일한 데이터를
    소스별/상태별 카운트로 요약한다.
    """
    items = build_live_snapshot()
    total: dict[str, int] = {}
    by_source: dict[str, dict[str, int]] = {}
    for it in items:
        src, st = it["source"], it["status"]
        total[st] = total.get(st, 0) + 1
        by_source.setdefault(src, {})[st] = by_source.setdefault(src, {}).get(st, 0) + 1

    kma_snap, kma_at = live_cache.get_kma_snapshot()
    khoa_snap, khoa_at = live_cache.get_khoa_snapshot()
    now = time.time()
    return {
        "count": len(items),
        "total": total,
        "by_source": by_source,
        "cache": {
            "kma_count": len(kma_snap),
            "kma_age_sec": round(now - kma_at, 1) if kma_at else None,
            "khoa_count": len(khoa_snap),
            "khoa_age_sec": round(now - khoa_at, 1) if khoa_at else None,
        },
    }


@app.get("/api/timeseries")
def api_timeseries(source: str, id: str, hours: int = 24):
    """상세 패널 시계열. source=KMA|KHOA, id=지점 id(KMA_22101 또는 KHOA obsCode), hours=조회 시간(≤48)."""
    src = source.upper().strip()
    if src not in ("KMA", "KHOA"):
        return {"error": "source must be KMA or KHOA"}

    result = timeseries_mod.get_timeseries(src, id, hours)
    if result is None:
        return {"error": "no data"}

    # 지점명 보강(레지스트리 조회) — timeseries.py 는 stations 를 몰라도 되게 분리
    full_id = id if (src == "KHOA" or id.startswith("KMA_")) else f"KMA_{id}"
    station = next((s for s in stations_mod.get_stations() if s["id"] == full_id), None)
    if station:
        result["name"] = station.get("name")
    return result


# ── /api/forecast 캐시(Phase 6) — 결정론적 합성 예측이라 재계산 비용은 낮지만, timeseries 와 같은
# TTL(2분)로 캐시해 반복 조회 시 재계산·재직렬화를 줄인다. get_timeseries() 자체도 자체 캐시가 있어
# KHOA/KMA 외부호출은 늘지 않는다.
_FORECAST_CACHE: dict = {}
_FORECAST_CACHE_LOCK = threading.Lock()
_FORECAST_TTL = 120


@app.get("/api/forecast")
def api_forecast(source: str, id: str, metric: str = "wave", hours: int = 24):
    """부이별 24h(가상/합성) 예측. **시연/모의용 — 실제 예보 아님**(forecast.py 참고).

    source=KMA|KHOA, id=지점 id, metric=wave|water_temp|wind_speed|pressure, hours=예측시간(≤72).
    """
    src = source.upper().strip()
    if src not in ("KMA", "KHOA"):
        return {"error": "source must be KMA or KHOA"}
    if metric not in forecast_mod.METRIC_META:
        return {"error": f"metric must be one of {list(forecast_mod.METRIC_META)}"}
    hours = max(1, min(int(hours or 24), 72))

    cache_key = (src, id, metric, hours)
    now = time.time()
    with _FORECAST_CACHE_LOCK:
        hit = _FORECAST_CACHE.get(cache_key)
        if hit and now - hit[0] < _FORECAST_TTL:
            return hit[1]

    # 예측 앵커(추세·진폭 추정)로 넉넉한 48h 관측 이력을 사용(요청 hours 와 무관).
    ts = timeseries_mod.get_timeseries(src, id, 48)
    if ts is None:
        return {"error": "no data"}

    result = forecast_mod.make_forecast(
        ts["points"], metric, hours=hours, seed_key=f"{src}_{id}_{metric}"
    )
    result["source"] = src
    result["id"] = id

    with _FORECAST_CACHE_LOCK:
        _FORECAST_CACHE[cache_key] = (time.time(), result)
    return result


# ── SPA(dist) 정적 서빙 — Phase 1 이후 frontend/dist 가 생기면 자동 반영.
# 반드시 모든 /api 라우트 정의 이후의 최후 mount.
_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST_DIR.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="spa")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=config.PORT, reload=False)
