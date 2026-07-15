"""통합 부이 지점 레지스트리.

KMA(sea_obs 좌표 + list-table 제원)와 KHOA(odcloud 부이 목록)를 병합해 표준 스키마로 반환한다.
**병합은 하지 않는다** — 소스별 태그를 유지한 채 별도 지점으로 나열(PLAN.md §1 지점 통합 전략).

스코프: 부이만(KMA TP B/C, KHOA 해양관측부이 41). 조위관측소·기타 TP(D/L/N/F/J)는 제외.
지점 메타(제원)는 변동이 거의 없으므로 프로세스 캐시(TTL 길게)로 재계산 비용을 줄인다.
"""
from __future__ import annotations

import threading
import time

import kma_marine
import khoa_api

_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_TTL = 3600  # 1시간 — 지점 제원은 거의 불변, sea_obs 좌표만 갱신될 뿐

_KMA_BUOY_TP = ("B", "C")

# 제원 목록(형식·센서고·영문명) op → 대상 TP
_LIST_OPS_FOR_TP = {
    "B": "getBuoyLstTbl",
    "C": "getWaveBuoyLstTbl",
}


def _rows_for_latest_published_month(op: str, now, max_back: int = 12) -> list[dict]:
    """월보성 제원 API 는 발행 지연이 있어 당월·전월이 비어있을 수 있음 →
    가장 최근 발행된 달을 찾을 때까지 최대 max_back개월 소급."""
    year, month = now.year, now.month
    for _ in range(max_back):
        try:
            rows = kma_marine.fetch_list_table(op, year, month)
        except Exception:
            rows = []
        if rows:
            return rows
        year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return []


def _build_kma_spec_index() -> dict:
    """stn_id(str) → {form, stn_en, ht_*} 제원 인덱스. 실패해도 빈 dict(치명적이지 않음)."""
    now = kma_marine.now_kst()
    idx: dict[str, dict] = {}
    for op in set(_LIST_OPS_FOR_TP.values()):
        rows = _rows_for_latest_published_month(op, now)
        for row in rows:
            stn_id = str(row.get("stn_id"))
            if not stn_id:
                continue
            idx[stn_id] = {
                "form": row.get("form"),
                "name_en": row.get("stn_en"),
                "ht_wd": row.get("ht_wd"),
                "ht_ta": row.get("ht_ta"),
                "ht_pa": row.get("ht_pa"),
                "ht_tw": row.get("ht_tw"),
                "ht_wh": row.get("ht_wh"),
            }
    return idx


def _kma_stations() -> list[dict]:
    """sea_obs(B/C) 좌표 + list-table 제원(form/영문명/센서고) 병합."""
    obs = kma_marine.fetch_sea_obs()
    spec_idx = _build_kma_spec_index()

    out: list[dict] = []
    seen: set[str] = set()
    for o in obs:
        if o["tp"] not in _KMA_BUOY_TP:
            continue
        stn_id = o["stn_id"]
        if stn_id in seen:
            continue
        seen.add(stn_id)
        spec = spec_idx.get(stn_id, {})
        out.append({
            "source": "KMA",
            "id": o["id"],
            "stn_id": stn_id,
            "tp": o["tp"],
            "tp_label": o["tp_label"],
            "name": o["name"],
            "name_en": spec.get("name_en"),
            "type": "해양기상부이" if o["tp"] == "B" else "파고부이",
            "lon": o["lon"],
            "lat": o["lat"],
            "form": spec.get("form"),
            "sensor_heights": {
                "wd": spec.get("ht_wd"),
                "ta": spec.get("ht_ta"),
                "pa": spec.get("ht_pa"),
                "tw": spec.get("ht_tw"),
                "wh": spec.get("ht_wh"),
            },
        })
    return out


def _khoa_stations() -> list[dict]:
    buoys = khoa_api.fetch_buoy_list()
    out: list[dict] = []
    for b in buoys:
        out.append({
            "source": "KHOA",
            "id": b["id"],
            "stn_id": b["obsCode"],
            "tp": b.get("type") or "TW",
            "tp_label": "해양관측부이",
            "name": b.get("name"),
            "name_en": b.get("name_en"),
            "type": "해양관측부이",
            "lon": b.get("lon"),
            "lat": b.get("lat"),
            "form": None,
            "sensor_heights": None,
        })
    return out


def get_stations(force: bool = False) -> list[dict]:
    """통합 부이 지점 레지스트리(KMA B/C + KHOA 41). 소스 태그 유지, 병합 없음."""
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get("stations")
        if not force and hit and now - hit[0] < _TTL:
            return hit[1]

    kma_list = _kma_stations()
    khoa_list = _khoa_stations()
    result = kma_list + khoa_list

    if result:
        with _CACHE_LOCK:
            _CACHE["stations"] = (time.time(), result)
    return result
