"""부이 수신상태 판정 — 관측시각 freshness 기준 3단계.

관측주기가 소스별로 다르므로(KMA sea_obs 10분 격자 / KHOA twRecent 1~수분·noonWave 30분)
임계값도 소스별로 다르게 둔다. CLAUDE.md §"부이 상태 판정" 기준.
"""
from __future__ import annotations

import re
from datetime import datetime
from enum import Enum
from typing import Optional, Union

import kma_marine

DateLike = Union[str, datetime, None]


class Status(str, Enum):
    OK = "정상"
    DELAYED = "지연"
    LOST = "미수신"


# (정상 상한분, 지연 상한분) — 이 이상이면 미수신. 소스별 관측주기 기준.
_THRESHOLDS = {
    "KMA": (30, 120),    # 10분 격자 → 정상 ≤30분, 지연 ≤2시간
    "KHOA": (40, 150),   # twRecent 1~수분/noonWave 30분 → 정상 ≤40분, 지연 ≤2.5시간
}
_DEFAULT_THRESHOLD = (30, 120)


def _parse_obs_time(obs_time: DateLike) -> Optional[datetime]:
    """다양한 포맷(YYYYMMDDHHMI / 'YYYY-MM-DD HH:MM' / ISO / datetime)을 naive KST datetime 으로 정규화."""
    if obs_time is None:
        return None
    if isinstance(obs_time, datetime):
        return obs_time
    s = str(obs_time).strip()
    if not s:
        return None
    # YYYYMMDDHHMI (KMA sea_obs/kma_buoy2 tm)
    if re.fullmatch(r"\d{12}", s):
        try:
            return datetime.strptime(s, "%Y%m%d%H%M")
        except ValueError:
            return None
    # "YYYY-MM-DD HH:MM" (KHOA obsrvnDt)
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return datetime.strptime(s[: len(fmt) + 2], fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def classify(obs_time_kst: DateLike, now_kst: Optional[datetime] = None, source: str = "KMA") -> dict:
    """관측시각·현재시각(둘 다 KST naive)으로 상태 판정.

    Returns: {"status": Status, "minutes_since": float|None}
    관측시각을 파싱할 수 없으면 미수신으로 간주(결측 = 수신 실패로 취급).
    """
    if now_kst is None:
        now_kst = kma_marine.now_kst()

    obs_dt = _parse_obs_time(obs_time_kst)
    if obs_dt is None:
        return {"status": Status.LOST, "minutes_since": None}

    minutes = (now_kst - obs_dt).total_seconds() / 60.0
    ok_max, delayed_max = _THRESHOLDS.get(source, _DEFAULT_THRESHOLD)

    if minutes < 0:
        # 시계 오차/미래 타임스탬프 — 정상으로 간주(음수를 지연/미수신으로 오판하지 않음)
        status = Status.OK
    elif minutes <= ok_max:
        status = Status.OK
    elif minutes <= delayed_max:
        status = Status.DELAYED
    else:
        status = Status.LOST

    return {"status": status, "minutes_since": round(minutes, 1)}
