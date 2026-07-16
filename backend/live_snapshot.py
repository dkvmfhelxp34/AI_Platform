"""라이브 스냅샷 + 운영 집계 공유 모듈.

`main.py`(`/api/live`, `/api/status`)와 `chat.py`(챗봇 도구)가 **동일한 계산**을 공유한다 —
로직 중복·재계산을 막고, 챗봇이 화면에 보이는 것과 다른 숫자를 말하는 불일치를 원천 차단한다
(챗봇 도구는 이 모듈이 반환하는 값만 읽고, KMA/KHOA API 를 직접 재호출하지 않는다).

원래 main.py 안에 있던 `_kma_live_item`/`_khoa_live_item`/`build_live_snapshot`(Phase 0~2)과
`api_status()`의 집계 블록(Wave 2 Fix 3)을 그대로 옮긴 것 — 동작 변경 없음(Phase 5 리팩터).
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import demo_scenario
import kma_marine
import live_cache
import stations as stations_mod
import status as status_mod
import timeseries as timeseries_mod


def _fmt_kma_tm(tm: str) -> str | None:
    """'YYYYMMDDHHMI' → 'YYYY-MM-DD HH:MM' (KHOA obsrvnDt 와 표시 포맷 통일)."""
    if not tm or len(tm) != 12:
        return tm
    return f"{tm[0:4]}-{tm[4:6]}-{tm[6:8]} {tm[8:10]}:{tm[10:12]}"


# ── 지표 탭 동적화(§14) — 지점이 실제 제공하는 charted 지표만 노출 ────────────────────────────
# 대상 지표(고정 순서 — 프론트 탭 순서와 일치): 파고·수온·풍속·기압.
CHARTED_METRICS: tuple[str, ...] = ("wave", "water_temp", "wind_speed", "pressure")
_LIVE_VALUE_KEY = {"wave": "wave_height", "water_temp": "water_temp", "wind_speed": "wind_speed", "pressure": "pressure"}


def available_metrics(source: str, tp: Optional[str], values: dict) -> list[str]:
    """지점이 실제 제공하는 charted 지표 목록(§14 산정 규칙).

    기본: 라이브값이 non-null 인 지표만. 부이종류 capability 로 보강:
      - KMA 해양기상부이(B) → 4종 항상 보장(일시 결측이 탭을 숨기지 않게).
      - 그 외(KMA 파고부이 C, KHOA 전체) → 라이브 존재분만(보장 없음).
    결과가 비면(전부 결측) 종류 보장셋(B 는 위에서 이미 비지 않음) 또는 최소 {"wave"} 로 폴백.
    원 순서(wave, water_temp, wind_speed, pressure) 유지.
    """
    present = [m for m in CHARTED_METRICS if values.get(_LIVE_VALUE_KEY[m]) is not None]
    guaranteed = list(CHARTED_METRICS) if (source == "KMA" and tp == "B") else []
    avail = set(present) | set(guaranteed)
    result = [m for m in CHARTED_METRICS if m in avail]
    return result or (guaranteed or ["wave"])


def _kma_live_item(o: dict, now) -> dict:
    # KMA sea_obs 는 단일 최신값이라 관측 이력 기반 cadence 가 없다 → status.py 의 KMA 정적 기본값(10분)
    # 으로 폴백된다(observed_cadence_min 미전달). stn_id 는 KMA 판정에 미사용.
    st = status_mod.classify(o["tm"], now, source="KMA", stn_id=o["id"])
    values = {
        "wave_height": o["wh"],
        "wind_dir": o["wd"],
        "wind_speed": o["ws"],
        "wind_gust": o["ws_gst"],
        "water_temp": o["tw"],
        "air_temp": o["ta"],
        "pressure": o["pa"],
        "humidity": o["hm"],
    }
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
        "cadence_min": st["cadence_min"],
        "values": values,
        "available_metrics": available_metrics("KMA", o["tp"], values),
    }


def _khoa_live_item(obs_code: str, rec: dict, now) -> dict:
    # obs_code(예: KG_0101) → status.py 가 접두사로 심해/연안 cadence 를 구분(KG_=30분 폴백).
    # cadence_min_observed(live_cache 가 롤링 이력에서 0회 추가호출로 실측한 중앙값)가 있으면 최우선.
    st = status_mod.classify(
        rec.get("obsrvnDt"), now, source="KHOA",
        stn_id=obs_code, observed_cadence_min=rec.get("cadence_min_observed"),
    )
    tp = obs_code.split("_")[0]
    values = {
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
    }
    return {
        "source": "KHOA",
        "id": obs_code,
        "name": rec.get("obsvtrNm"),
        "lon": rec.get("lot"),  # KHOA 응답 필드명 lot=경도 (오타 아님, API 원 필드명)
        "lat": rec.get("lat"),
        "tp": tp,
        "tp_label": "해양관측부이",
        "obs_time": rec.get("obsrvnDt"),
        "status": st["status"].value,
        "minutes_since": st["minutes_since"],
        "cadence_min": st["cadence_min"],
        "values": values,
        "available_metrics": available_metrics("KHOA", tp, values),
    }


# §Issue2 픽스 — "방어적 미수신"(등록부엔 있지만 이번 폴링 사이클 라이브 스냅샷 어디에도 없는) 지점의
# obs_time/minutes_since 를 시계열 마지막 포인트로 백필한다. 대상은 `build_live_snapshot()` 세 번째
# 루프(등록부 - {kma_obs ∪ khoa_obs})뿐이라 호출량이 원래도 작은 지점 집합에 한정된다.
#
# **왜 백그라운드 스레드인가**: KHOA 지점은 `timeseries.get_timeseries(..., days=30)` 가 내부적으로
# `khoa_api.fetch_oceangrid_range()`(2일 간격 day-loop × 4항목 엔드포인트 = 요청 범위 전체를 순회하는
# 수십 회의 순차 POST, 공유 throttle 0.15초/회)를 타므로 **초 단위가 아니라 수십 초가 걸릴 수 있다**
# (실측: KG_0028 1개 지점 백필이 120초 넘게 걸림). 이걸 `/api/live` 요청 스레드에서 동기 호출하면
# 그 요청(그리고 그 요청을 처리하는 스레드풀 워커)이 그만큼 블로킹된다 — "비용 상한"이라는 요구사항에
# 정면으로 위배된다. 그래서 조회는 항상 **전용 스레드풀에 위임**하고, `/api/live` 요청은 그 순간 캐시에
# 있는 값(첫 조회 전이면 None)을 즉시 반환한다. 최초 호출(그리고 TTL 만료 후 첫 호출)은 obs_time=None
# (기존 D1 동작과 동일, 상태만 미수신)으로 보이고, 백그라운드 작업이 끝나면 그 다음 `/api/live` 호출부터
# 백필된 값이 보인다 — "매 요청마다 무거운 외부호출을 추가하지 않는다"는 요구사항을 요청 지연이
# 아니라 스레드 분리로 만족시킨다(외부호출 총량 자체는 그대로: 지점당 15분 TTL에 한 번).
_BACKFILL_TTL = 900  # 15분 — 캐시(성공/실패 결과 모두) 유효기간, 이후 재조회 트리거
_backfill_cache: dict[str, tuple[float, Optional[str]]] = {}
_backfill_inflight: set[str] = set()
_backfill_lock = threading.Lock()
_backfill_executor = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="live-backfill"
)


def _backfill_worker(source: str, sid: str) -> None:
    """스레드풀에서 실행 — 시계열 마지막 포인트를 조회해 캐시에 채워 넣는다(요청 스레드와 무관)."""
    obs_time: Optional[str] = None
    try:
        ts = timeseries_mod.get_timeseries(source, sid, days=30)
        points = (ts or {}).get("points") or []
        if points:
            obs_time = points[-1].get("t")
    except Exception:
        obs_time = None  # 방어적 레코드 채우는 경로 — 백필 실패는 침묵하고 None 유지
    with _backfill_lock:
        _backfill_cache[sid] = (time.time(), obs_time)
        _backfill_inflight.discard(sid)


def _last_seen_obs_time(source: Optional[str], sid: Optional[str]) -> Optional[str]:
    """`sid`(등록부 id, KMA 는 'KMA_22107' 형태 그대로) 의 과거 30일 시계열 마지막 포인트 시각
    ('YYYY-MM-DD HH:MM') — 아직 조회 전/조회 중이거나 이력이 전혀 없으면 None. 절대 이 함수
    자체는 블로킹하지 않는다(무거운 조회는 `_backfill_executor` 로 위임, 위 모듈독스트링 참고)."""
    if not source or not sid:
        return None
    now = time.time()
    with _backfill_lock:
        hit = _backfill_cache.get(sid)
        cached_val = hit[1] if hit else None
        is_fresh = bool(hit) and (now - hit[0] < _BACKFILL_TTL)
        should_kick_off = not is_fresh and sid not in _backfill_inflight
        if should_kick_off:
            _backfill_inflight.add(sid)
    if should_kick_off:
        _backfill_executor.submit(_backfill_worker, source, sid)
    return cached_val


def _missing_live_item(station: dict, now) -> dict:
    """§D1 픽스 — 등록부(`stations.py`)에는 있지만 라이브 소스(sea_obs/twRecent burst) 어느
    쪽에도 아직 안 잡힌 지점의 방어적 레코드.

    발생 사례(실측): (1) KHOA 지점이 twRecent burst 폴링 대상에서 한 번도 성공 응답을 못 받은 경우,
    (2) KMA sea_obs 가 매 10분 슬롯의 단일 관측 스냅샷이라, 보고주기가 느리거나 간헐적인 지점(주로
    파고부이 C타입)이 특정 호출 타이밍엔 그 슬롯에 빠져 있는 경우. 원인이 무엇이든 등록부에 있는
    지점은 지도·리스트·카운트에서 통째로 사라지면 안 되므로, status='미수신' 정직한 레코드를 채워
    넣는다(값을 지어내지 않음, `values` 는 항상 전부 결측).

    §Issue2 픽스: obs_time/minutes_since 는 더 이상 무조건 None 이 아니다 — `_last_seen_obs_time()`
    으로 과거 시계열의 마지막 포인트를 값싸게 조회해, 있으면 그 시각으로 백필한다("미수신 · —"처럼
    끊김과 결측을 혼동시키는 표시 대신 "미수신 · N일 전"처럼 실제 마지막 수신 이후 경과를 보여준다).
    이력이 전혀 없는 지점(§Issue1 픽스로 그런 지점은 등록부 자체에서 이미 제외되지만, 방어적으로)은
    그대로 None 유지. status 는 백필 여부와 무관하게 항상 '미수신'으로 고정한다(이 레코드는 이번
    사이클 라이브 응답이 없다는 사실 자체를 나타내는 것이지, 재분류가 목적이 아니다).
    """
    values: dict = {}
    source = station.get("source")
    tp = station.get("tp")
    sid = station.get("id")
    obs_time = _last_seen_obs_time(source, sid)
    minutes_since = None
    cadence_min = None
    if obs_time:
        classified = status_mod.classify(obs_time, now, source=source, stn_id=sid)
        minutes_since = classified["minutes_since"]
        cadence_min = classified["cadence_min"]
    return {
        "source": source,
        "id": sid,
        "name": station.get("name"),
        "lon": station.get("lon"),
        "lat": station.get("lat"),
        "tp": tp,
        "tp_label": station.get("tp_label"),
        "obs_time": obs_time,
        "status": status_mod.Status.LOST.value,
        "minutes_since": minutes_since,
        "cadence_min": cadence_min,
        "values": values,
        "available_metrics": available_metrics(source, tp, values),
    }


def build_live_snapshot() -> list[dict]:
    """`live_cache.py` 백그라운드 스냅샷을 읽어 상태만 **현재시각 기준**으로 매 요청 재계산한다.

    외부 API 호출 0회(스냅샷 갱신은 백그라운드 데몬 스레드가 전담) — 요청 빈도가 아무리 높아도
    KMA/KHOA 호출량은 늘지 않는다. 상세는 `live_cache.py` 모듈독스트링(Rate budget 계산 포함).

    마지막 단계에서 `demo_scenario.apply_status_override()` 를 거친다 — 큐레이션된 소수 지점만
    상태·경과시간·표시 관측시각이 시연용으로 재연출되고(§13-2), 나머지는 그대로다. 게이트
    (`DEMO_SCENARIO`)가 꺼져 있으면 이 호출은 완전히 무해(원본 그대로 반환)하다.

    §D1 픽스: 조립이 끝나면 `stations.get_stations()`(전체 등록부)와 **합집합**한다 — 등록된
    지점인데 위 두 라이브 소스 어디에도 없으면(KHOA 미폴링·KMA sea_obs 슬롯 누락 등) `_missing_live_item()`
    으로 "미수신" 방어 레코드를 채워 넣는다. 그래야 `/api/stations` 에는 있는데 `/api/live`(지도·
    리스트·카운트)에선 통째로 사라지는 지점이 구조적으로 없어진다. `stations.get_stations()` 는
    자체 1시간 캐시가 있어 매 요청마다 추가 외부호출이 생기지 않는다.

    §Issue1 픽스(D1 의 보완 반대방향): 위 합집합과 별개로, **라이브 소스 자체가 등록부보다 넓은
    경우**도 있다 — 예: KHOA twRecent burst 폴링이 등록부가 이미 제외한 지점(이름은 관측부이인데
    실제로는 twRecent·관측개시일 둘 다 무데이터라 `stations._khoa_stations()` 가 걸러낸 지점,
    실측 사례 YS_0007)을 두 캐시의 TTL 이 어긋나는 순간에 일시적으로 다시 잡아버리는 경우. 그러면
    `/api/stations` 에는 없는데 `/api/live` 에만 있는(그리고 진짜 데이터가 없어 obs_time=None
    으로 뜨는) "유령" 지점이 생긴다. 등록부를 유일한 유니버스로 삼기 위해, 조립이 끝나면 등록부
    id 집합에 없는 item 은 전부 드롭한다(D1 의 합집합 방향은 그대로 유지 — 등록부에는 있는데
    라이브에 없는 지점은 여전히 `_missing_live_item()` 으로 채워지므로 이 필터에 걸리지 않는다).
    """
    now = kma_marine.now_kst()
    out: list[dict] = []
    seen_ids: set[str] = set()

    kma_obs, _kma_at = live_cache.get_kma_snapshot()
    for o in kma_obs:
        if o["tp"] not in ("B", "C"):
            continue
        item = demo_scenario.apply_status_override(_kma_live_item(o, now))
        out.append(item)
        seen_ids.add(item["id"])

    khoa_obs, _khoa_at = live_cache.get_khoa_snapshot()
    for obs_code, rec in khoa_obs.items():
        item = demo_scenario.apply_status_override(_khoa_live_item(obs_code, rec, now))
        out.append(item)
        seen_ids.add(item["id"])

    registry = stations_mod.get_stations()
    registry_ids = {s["id"] for s in registry if s.get("id")}

    for station in registry:
        sid = station.get("id")
        if not sid or sid in seen_ids:
            continue
        out.append(demo_scenario.apply_status_override(_missing_live_item(station, now)))
        seen_ids.add(sid)

    # §Issue1 — 등록부에 없는 id 는 라이브 소스가 무엇을 잡았든 드롭(위 독스트링 참고).
    out = [item for item in out if item.get("id") in registry_ids]

    return out


# 유의파고 실측 상한(main.py 의 예전 KPI 필터와 동일 근거) — 국내외 실측 유의파고가 20m 를 넘는 사례는
# 없다. 이 상한을 넘는 값은 명백한 센서 오류라 "최대 파고" 헤드라인에서 걸러낸다(원본 레코드는 유지).
_PLAUSIBLE_WAVE_MAX_M = 20.0


def build_status_overview() -> dict:
    """부이별 수신상태 집계(정상/지연/미수신, 소스별) + freshness/운영 KPI 집계.

    `/api/status` 응답과 완전히 동일한 스키마 — main.py 와 chat.py 가 이 함수 하나를 공유하므로
    "화면엔 40분전인데 챗봇은 정상이라고 함" 류 불일치가 구조적으로 발생할 수 없다(SSOT).
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

    ages = [it["minutes_since"] for it in items if it["minutes_since"] is not None]
    refresh_times = [t for t in (kma_at, khoa_at) if t]
    last_refresh_unix = max(refresh_times) if refresh_times else None
    last_refresh_kst = (
        datetime.fromtimestamp(last_refresh_unix, tz=timezone.utc) + timedelta(hours=9)
        if last_refresh_unix else None
    )
    data_freshness = {
        "newest_obs_age_min": round(min(ages), 1) if ages else None,
        "oldest_obs_age_min": round(max(ages), 1) if ages else None,
        "last_cache_refresh": last_refresh_kst.strftime("%Y-%m-%dT%H:%M:%S") if last_refresh_kst else None,
        "cache_age_sec": round(now - last_refresh_unix, 1) if last_refresh_unix else None,
    }

    wave_readings = [
        (it["values"].get("wave_height"), it["name"], it["id"], it["source"])
        for it in items
        if it.get("values", {}).get("wave_height") is not None
        and 0 <= it["values"]["wave_height"] <= _PLAUSIBLE_WAVE_MAX_M
    ]
    max_wave = None
    if wave_readings:
        v, name, sid, src = max(wave_readings, key=lambda r: r[0])
        max_wave = {"value": v, "station_name": name, "station_id": sid, "source": src}
    mean_wave = (
        round(sum(v for v, *_ in wave_readings) / len(wave_readings), 2) if wave_readings else None
    )
    alerts = total.get("지연", 0) + total.get("미수신", 0)

    return {
        "count": len(items),
        "total": total,
        "by_source": by_source,
        "data_freshness": data_freshness,
        "max_wave": max_wave,
        "mean_wave": mean_wave,
        "alerts": alerts,
        "cache": {
            "kma_count": len(kma_snap),
            "kma_age_sec": round(now - kma_at, 1) if kma_at else None,
            "khoa_count": len(khoa_snap),
            "khoa_age_sec": round(now - khoa_at, 1) if khoa_at else None,
        },
    }
