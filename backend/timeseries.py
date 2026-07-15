"""통합 시계열 API 로직 — `GET /api/timeseries` (Phase 3).

- KMA: `kma_marine.fetch_buoy_series(stn, tm1, tm2)`(kma_buoy2.php 기간조회) → AQC/MQC 관측기관 QC 병합.
- KHOA: `khoa_api.fetch_tw_recent_series(obsCode)`(twRecent 최근 롤링, 실측 최대 10건) → 기관 QC 없음.
  과거(기간) 이력이 더 필요하면 docs/oceangrid_probe.md 의 비공식 백필 경로 — 이번 Phase 는 미구현.

정규화 스키마:
  { id, source, name, unit_notes, points: [{t, wave, wave_period, wind_speed, wind_dir,
    water_temp, air_temp, pressure, qc: {flagged, checked, note?}}], qc_summary: {flagged_count, checked} }
"""
from __future__ import annotations

import threading
import time
from datetime import datetime, timedelta
from typing import Optional

import kma_marine
import khoa_api
import qc as qc_mod

_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_TTL = 120  # 2분 — 상세 패널 재오픈/리렌더 시 재계산 비용 절감(내부 fetch 계층에도 자체 캐시가 있음)


# ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

def _strip_kma_prefix(id_: str) -> str:
    return id_[4:] if id_.startswith("KMA_") else id_


def _fmt_kma_tm(tm: Optional[str]) -> Optional[str]:
    """'YYYYMMDDHHMI' → 'YYYY-MM-DD HH:MM' (KHOA obsrvnDt 와 표시 포맷 통일)."""
    if not tm or len(tm) != 12:
        return tm
    return f"{tm[0:4]}-{tm[4:6]}-{tm[6:8]} {tm[8:10]}:{tm[10:12]}"


def _num(v):
    """문자열/숫자 혼재 방어적 파싱. KMA 결측(-99 이하)은 None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
    else:
        s = str(v).strip()
        if not s:
            return None
        try:
            f = float(s)
        except ValueError:
            return None
    if f <= -99.0:
        return None
    return f


def _parse_kma_qc(aqc: Optional[str], mqc: Optional[str]) -> dict:
    """KMA AQC(자동)/MQC(수동) 자리별 플래그 문자열 파싱.

    실측 확인(2026-07-15): `/`(미검사) 뿐 아니라 `-`(미검사/해당없음)도 쓰이며, 자리 수·의미는 지점마다
    다르게 관측됨(예: MQC 가 전부 '1'인 지점도 존재) — 자리→관측변수 매핑은 비공개(undocumented).
    따라서 "숫자이면서 0이 아닌 문자가 하나라도 있으면 그 관측 레코드(포인트) 전체를 flagged" 로
    보수적으로 처리한다(포인트 단위 플래그, 변수별 세분화는 하지 않음).
    """
    flagged = False
    checked = False
    for s in (aqc, mqc):
        if not s:
            continue
        for ch in s:
            if not ch.isdigit():
                continue  # '/', '-' 등은 미검사/해당없음 — 검사여부 판단에서 제외
            checked = True
            if ch != "0":
                flagged = True
    out = {"flagged": flagged, "checked": checked}
    if flagged:
        out["note"] = "관측기관 QC 이상치 플래그(AQC/MQC) — 자리별→변수 매핑 비공개, 레코드 단위 표시"
    return out


# ── KMA ──────────────────────────────────────────────────────────────────────

def _kma_timeseries(stn_id: str, hours: int) -> dict:
    now = kma_marine.now_kst()
    tm2_dt = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    tm1_dt = tm2_dt - timedelta(hours=hours)
    tm1 = tm1_dt.strftime("%Y%m%d%H%M")
    tm2 = tm2_dt.strftime("%Y%m%d%H%M")

    records = kma_marine.fetch_buoy_series(stn_id, tm1, tm2)

    points = []
    flagged_count = 0
    any_checked = False
    for r in records:
        wave = r.get("wh_sig")
        if wave is None:
            wave = r.get("wh_ave")
        qc = _parse_kma_qc(r.get("aqc"), r.get("mqc"))
        if qc["checked"]:
            any_checked = True
        if qc["flagged"]:
            flagged_count += 1
        points.append({
            "t": _fmt_kma_tm(r.get("tm")),
            "wave": wave,
            "wave_period": r.get("wp"),
            "wind_speed": r.get("ws1"),
            "wind_dir": r.get("wd1"),
            "water_temp": r.get("tw"),
            "air_temp": r.get("ta"),
            "pressure": r.get("pa"),
            "qc": qc,
        })

    return {
        "id": f"KMA_{stn_id}",
        "source": "KMA",
        "name": None,
        "unit_notes": (
            "파고 m(WH_SIG, 미관측시 WH_AVE) · 파주기 s · 풍속 m/s · 풍향 deg · 수온/기온 ℃ · 기압 hPa"
            " — KMA kma_buoy2.php 기간조회(tm1~tm2), AQC/MQC 관측기관 QC 포함"
        ),
        "points": points,
        "qc_summary": {"flagged_count": flagged_count, "checked": any_checked},
    }


# ── KHOA ─────────────────────────────────────────────────────────────────────

def _khoa_timeseries(obs_code: str, hours: int) -> dict:
    # TODO oceangrid backfill: twRecent 는 "최근 N건 롤링" 서비스라 hours 를 넘겨도 과거로 확장되지
    # 않는다(실측 최대 10건, 지점별 5~30분 간격 → 대략 45분~5시간 범위). 이보다 긴 과거 이력이 필요하면
    # docs/oceangrid_probe.md 의 비공식 oceangrid GIS 일자별 백필 루프를 별도 파이프라인으로 붙여야 한다
    # (이번 Phase 3 패스에서는 미구현 — 트리비얼하지 않아 보류).
    records = khoa_api.fetch_tw_recent_series(obs_code)

    now = kma_marine.now_kst()
    cutoff = now - timedelta(hours=hours)

    points = []
    for r in records:
        t = r.get("obsrvnDt")
        try:
            t_dt = datetime.strptime(t, "%Y-%m-%d %H:%M") if t else None
        except ValueError:
            t_dt = None
        if t_dt is not None and t_dt < cutoff:
            continue
        points.append({
            "t": t,
            "wave": _num(r.get("wvhgt")),
            "wave_period": _num(r.get("wvpd")),
            "wind_speed": _num(r.get("wspd")),
            "wind_dir": _num(r.get("wndrct")),
            "water_temp": _num(r.get("wtem")),
            "air_temp": _num(r.get("artmp")),
            "pressure": _num(r.get("atmpr")),
            "qc": {"flagged": False, "checked": False},
        })

    return {
        "id": obs_code,
        "source": "KHOA",
        "name": None,
        "unit_notes": (
            "파고 m · 파주기 s · 풍속 m/s · 풍향 deg · 수온/기온 ℃ · 기압 hPa"
            " — KHOA twRecent 최근 롤링 관측(실측 최대 10건, 지점별 간격 5~30분), 기관 QC 미제공"
        ),
        "points": points,
        "qc_summary": {"flagged_count": 0, "checked": False},
    }


# ── 알고리즘 AI-QC 병합(Phase 4) ────────────────────────────────────────────

def _apply_ai_qc(result: dict, metric: str = "wave") -> None:
    """`qc.py`(robust z-score 스파이크 + 결측/간격 탐지)를 points 에 병합한다.

    관측기관 QC(각 포인트의 `qc` 필드, AQC/MQC 기반)는 그대로 두고 `ai_qc` 필드를 추가한다 —
    두 QC 는 서로 다른 근거(기관 검증 vs 통계적 이상치)이므로 프론트에서 구분 표시할 수 있게 병합하지
    않는다. 헤드라인 변수인 파고(wave)를 기준으로 판정한다(KMA/KHOA 공통 필드).
    """
    qc_out = qc_mod.run_qc(result["points"], metric)
    result["points"] = qc_out["points"]
    result["qc_summary"]["ai_spike_count"] = qc_out["summary"]["spike_count"]
    result["qc_summary"]["ai_gap_count"] = qc_out["summary"]["gap_count"]


# ── 공개 진입점 + 캐시 ─────────────────────────────────────────────────────────

def get_timeseries(source: str, id_: str, hours: int) -> Optional[dict]:
    hours = max(1, min(int(hours or 24), 48))
    cache_key = (source, id_, hours)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < _TTL:
            return hit[1]

    if source == "KMA":
        result = _kma_timeseries(_strip_kma_prefix(id_), hours)
    elif source == "KHOA":
        result = _khoa_timeseries(id_, hours)
    else:
        return None

    _apply_ai_qc(result)

    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.time(), result)
    return result
