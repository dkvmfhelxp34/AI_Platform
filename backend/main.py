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
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import Response, StreamingResponse

import chat as chat_mod
import config
import field_service
import kma_marine
import live_cache
import live_snapshot
import stations as stations_mod
import timeseries as timeseries_mod
import forecast as forecast_mod


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    # 백그라운드 라이브 스냅샷 리프레셔 시작(live_cache.py) — 서버 기동은 이 완료를 기다리지 않는다
    # (첫 채움은 KMA 는 즉시, KHOA 는 burst 소요시간 ≈6초 후 대부분 채워짐. /api/health 는 스냅샷과 무관).
    live_cache.start_refresher()
    # 2D 필드 오버레이(바람+수온) 배경 리프레셔(field_service.py) — 동일 패턴. 신선한 디스크
    # 캐시가 있으면 즉시 ready=True, 없으면 배경에서 첫 수집을 마칠 때까지 /api/field 는 미준비.
    field_service.start_refresher()
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
# `/api/field` 가 이진(application/octet-stream)으로 바뀌어도(§27) gzip 은 여전히 도움이 된다
# (육지 nodata 센티널 반복·완만한 그라디언트 구간이 꽤 압축됨). Accept-Encoding: gzip 인 요청에만
# 자동 적용되고, minimum_size 미만 응답은 그냥 통과한다.
app.add_middleware(GZipMiddleware, minimum_size=500)


# ── /api/live 스냅샷·상태 집계 ────────────────────────────────────────────────
# 실제 구현은 live_snapshot.py 로 이전(Phase 5) — main.py(/api/live·/api/status)와
# chat.py(챗봇 도구)가 동일 계산을 공유해 "화면과 챗봇 답이 다른" 불일치를 막는다.
build_live_snapshot = live_snapshot.build_live_snapshot


# ── 라우트 ────────────────────────────────────────────────────────────────

@app.get("/api/health")
def api_health():
    return {"ok": True, "time": kma_marine.now_kst().strftime("%Y-%m-%dT%H:%M:%S")}


@app.get("/api/stations")
def api_stations():
    items = stations_mod.get_stations()
    return {"count": len(items), "items": items}


@app.get("/api/station/{station_id}")
def api_station_detail(station_id: str):
    """지점 상세(Wave 3b 상세패널용) — `/api/stations` 와 같은 정규화 레코드 1건.
    id 예: KMA_22101(KMA) 또는 KG_0024(KHOA obsCode 그대로).

    `available_metrics`(§14 지표 탭 동적화): 라이브 스냅샷에서 이 지점을 찾아 그 값을 그대로
    싣는다(live_snapshot.available_metrics — 라이브 존재분 + 부이종류 capability 보강). 라이브
    스냅샷에 아직 없는 지점(부팅 직후 등)은 라이브값 없이(전부 결측으로 간주) 같은 규칙으로
    폴백 계산한다.
    """
    items = stations_mod.get_stations()
    match = next((s for s in items if s["id"] == station_id), None)
    if match is None:
        return {"error": "station not found", "id": station_id}

    result = dict(match)
    live_item = next((it for it in build_live_snapshot() if it["id"] == station_id), None)
    if live_item is not None:
        result["available_metrics"] = live_item["available_metrics"]
    else:
        result["available_metrics"] = live_snapshot.available_metrics(match.get("source"), match.get("tp"), {})
    return result


@app.get("/api/live")
def api_live():
    items = build_live_snapshot()
    return {"count": len(items), "items": items}


@app.get("/api/status")
def api_status():
    """부이별 수신상태 집계(정상/지연/미수신, 소스별) + freshness/운영 KPI 집계(Fix 3).

    실제 계산은 `live_snapshot.build_status_overview()` 로 이전(Phase 5) — chat.py 의
    `get_status_overview` 도구가 같은 함수를 호출하므로, 챗봇 답변과 이 응답은 항상 같은 숫자다.

    **SSOT**: `data_freshness` 는 items 의 `minutes_since`(= status.classify() 가 상태 판정에 실제
    쓴 값, status.py §SSOT)에서 뽑는다. 헤더 live 배지·KPI "최근 갱신"·리스트의 "N분 전"이 전부
    이 하나의 계산 결과를 읽으면, "40분 전인데 정상"류 모순이 구조적으로 발생할 수 없다.
    """
    return live_snapshot.build_status_overview()


@app.get("/api/field")
def api_field():
    """2D 필드 오버레이(바람·표층수온) — 현재 KST 1시간 프레임 1장(타임라인 없음, `field_service.py`).

    **이진 응답(§27, 2026-07-17)**: `application/octet-stream` — 4바이트 length-prefix(uint32 LE)
    + UTF-8 JSON 헤더 + Int16 스케일 본문(바람 u/v·수온 각각). 정확한 바이트 레이아웃·스케일/오프셋/
    nodata 규약은 `field_service.py` 모듈 독스트링 "프레임 계약" 참고.

    배경 스레드가 미리 인코딩까지 끝내둔 바이트열을 그대로 반환한다(요청측 외부호출·재계산·
    재인코딩 0). 아직 첫 수집 전(부팅 직후, 신선한 디스크 캐시도 없음)이면 헤더만 있는
    `{"ready": false, "error": ...}` 프레임(본문 0바이트).
    """
    return Response(content=field_service.get_field_payload_bytes(),
                     media_type="application/octet-stream")


@app.get("/api/timeseries")
def api_timeseries(
    source: str, id: str, hours: int = 24, range: str | None = None, days: int | None = None,
    metric: str = "wave",
):
    """상세 패널 시계열. source=KMA|KHOA, id=지점 id(KMA_22101 또는 KHOA obsCode).

    조회 범위(Wave 3a Fix 2, 연구용 과거 이력):
      - `range`=24h|7d|30d|1y 또는 `days`=N 을 주면 과거 이력 경로(둘 중 하나만 있어도 됨, `days` 우선).
      - 둘 다 생략하면 레거시 `hours`(≤48) 그대로(기존 동작 호환).
    KMA B(해양기상부이)=kma_buoy2.php 30분 해상도, KMA C(파고부이)=getDailyWaveBuoy 일별 대체.
    KHOA=oceangrid day-loop(~30일 캡) + twRecent 최근 롤링 보강. 상세는 `timeseries.py` 모듈독스트링.

    `metric`(wave|water_temp|wind_speed|pressure, 기본 wave): 알고리즘 AI-QC(`qc.run_qc`)가
    어느 지표를 대상으로 스파이크/결측을 판정할지 결정한다. 프론트가 지표 탭을 바꿀 때 이
    파라미터를 함께 보내면, 탭마다 그 지표 기준 AI 이상감지가 반영된다(생략 시 기존처럼 wave
    기준 — 하위호환).
    """
    src = source.upper().strip()
    if src not in ("KMA", "KHOA"):
        return {"error": "source must be KMA or KHOA"}
    if metric not in forecast_mod.METRIC_META:
        return {"error": f"metric must be one of {list(forecast_mod.METRIC_META)}"}

    result = timeseries_mod.get_timeseries(src, id, hours, range_=range, days=days, metric=metric)
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


# ── /api/chat (Phase 5) — 데이터 그라운디드 AI 챗봇, SSE. 실제 로직은 chat.py(claude -p CLI 전용:
# 도구루프·시스템프롬프트·세션기억·jsonl 로그)에 있고, 여기서는 SSE 응답으로 감싸기만 한다.
@app.post("/api/chat")
async def api_chat(req: chat_mod.ChatRequest):
    return StreamingResponse(
        chat_mod.generate_chat_response(req),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ── /api/chat/history — 세션 대화 복원(새로고침·백엔드 재시작 내성). 프론트가 localStorage 로
# 고정한 session_id 를 그대로 넘기면, chat.py 가 실제 답변에 쓰는 것과 동일한 in-memory/jsonl
# 경로(`_chat_hist_get`)로 이전 user/assistant 턴을 되돌려준다(7일 보존, chat.py 참고).
@app.get("/api/chat/history")
def api_chat_history(session_id: str | None = None):
    return chat_mod.get_chat_history(session_id)


# ── SPA(dist) 정적 서빙 — Phase 1 이후 frontend/dist 가 생기면 자동 반영.
# 반드시 모든 /api 라우트 정의 이후의 최후 mount.
_DIST_DIR = Path(__file__).resolve().parent.parent / "frontend" / "dist"
if _DIST_DIR.exists():
    from fastapi.staticfiles import StaticFiles

    app.mount("/", StaticFiles(directory=str(_DIST_DIR), html=True), name="spa")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="0.0.0.0", port=config.PORT, reload=False)
