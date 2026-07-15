"""라이브 스냅샷 + 운영 집계 공유 모듈.

`main.py`(`/api/live`, `/api/status`)와 `chat.py`(챗봇 도구)가 **동일한 계산**을 공유한다 —
로직 중복·재계산을 막고, 챗봇이 화면에 보이는 것과 다른 숫자를 말하는 불일치를 원천 차단한다
(챗봇 도구는 이 모듈이 반환하는 값만 읽고, KMA/KHOA API 를 직접 재호출하지 않는다).

원래 main.py 안에 있던 `_kma_live_item`/`_khoa_live_item`/`build_live_snapshot`(Phase 0~2)과
`api_status()`의 집계 블록(Wave 2 Fix 3)을 그대로 옮긴 것 — 동작 변경 없음(Phase 5 리팩터).
"""
from __future__ import annotations

import time
from datetime import datetime, timezone, timedelta
from typing import Optional

import demo_scenario
import kma_marine
import live_cache
import status as status_mod


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


def build_live_snapshot() -> list[dict]:
    """`live_cache.py` 백그라운드 스냅샷을 읽어 상태만 **현재시각 기준**으로 매 요청 재계산한다.

    외부 API 호출 0회(스냅샷 갱신은 백그라운드 데몬 스레드가 전담) — 요청 빈도가 아무리 높아도
    KMA/KHOA 호출량은 늘지 않는다. 상세는 `live_cache.py` 모듈독스트링(Rate budget 계산 포함).

    마지막 단계에서 `demo_scenario.apply_status_override()` 를 거친다 — 큐레이션된 소수 지점만
    상태·경과시간·표시 관측시각이 시연용으로 재연출되고(§13-2), 나머지는 그대로다. 게이트
    (`DEMO_SCENARIO`)가 꺼져 있으면 이 호출은 완전히 무해(원본 그대로 반환)하다.
    """
    now = kma_marine.now_kst()
    out: list[dict] = []

    kma_obs, _kma_at = live_cache.get_kma_snapshot()
    for o in kma_obs:
        if o["tp"] not in ("B", "C"):
            continue
        out.append(demo_scenario.apply_status_override(_kma_live_item(o, now)))

    khoa_obs, _khoa_at = live_cache.get_khoa_snapshot()
    for obs_code, rec in khoa_obs.items():
        out.append(demo_scenario.apply_status_override(_khoa_live_item(obs_code, rec, now)))

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
