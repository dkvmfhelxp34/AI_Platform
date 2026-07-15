"""가상(합성) 24h 예측 생성 (Phase 6) — **시연/모의용, 실제 기상·해양 예보가 아니다.**

관측 시계열(`timeseries.py` 의 points)의 마지막 관측값을 기준(anchor)으로:
  - 최근 추세(선형 기울기)를 Holt 감쇠추세(damped trend) 방식으로 시간이 갈수록 완만하게 반영,
  - 24시간 주기 사인파(진폭은 최근 변동성에서 추정, 마지막 관측시각 기준 위상 연속),
  - 작은 감쇠 노이즈(AR(1), 시드 고정)
를 더해 24시간 시간별 합성값을 만든다. 물리적으로 타당한 범위로 clamp 한다(파고≥0 등).

**결정론적**: `seed_key`(호출측에서 station id 등으로 구성)의 해시로 numpy `RandomState` 를 고정하므로
벽시계 난수에 의존하지 않는다 — 같은 입력(points, metric, hours, seed_key)이면 항상 같은 출력.
"""
from __future__ import annotations

import hashlib
from datetime import datetime, timedelta
from typing import Optional

import numpy as np

_TIME_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y%m%d%H%M", "%Y-%m-%dT%H:%M:%S")

# metric → (한글 라벨, 단위, 하한, 상한) — 물리적으로 타당한 clamp 범위(상한 None = 상한 없음)
METRIC_META: dict[str, tuple[str, str, Optional[float], Optional[float]]] = {
    "wave": ("파고", "m", 0.0, None),
    "water_temp": ("수온", "℃", -2.0, 40.0),
    "wind_speed": ("풍속", "m/s", 0.0, None),
    "pressure": ("기압", "hPa", 900.0, 1080.0),
}

_PHI_TREND = 0.90    # Holt 감쇠추세 계수(0<phi<1, 1에 가까울수록 추세가 오래 유지됨)
_PEAK_HOUR = 15.0     # 일주기 사인파의 임의 고정 위상(오후 피크) — 시연 단순화, 기상학적 정밀도 의도 없음
_PHI_NOISE = 0.6      # 노이즈 AR(1) 감쇠 계수(0<phi<1, 작을수록 노이즈가 빨리 0으로 되돌아감)


def _parse_time(t) -> Optional[datetime]:
    if t is None:
        return None
    if isinstance(t, datetime):
        return t
    s = str(t).strip()
    if not s:
        return None
    for fmt in _TIME_FORMATS:
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _seed_from_key(key: str) -> int:
    """station id 등 문자열 → 결정론적 32bit 시드(해시 기반, 벽시계 난수 미사용)."""
    h = hashlib.sha256((key or "").encode("utf-8")).hexdigest()
    return int(h[:8], 16)


def _clamp(v: float, lo: Optional[float], hi: Optional[float]) -> float:
    if lo is not None:
        v = max(lo, v)
    if hi is not None:
        v = min(hi, v)
    return v


def make_forecast(
    points: list[dict],
    metric: str,
    hours: int = 24,
    seed_key: str = "",
) -> dict:
    """points(timeseries.py 의 point 리스트)의 `metric` 값들로 24h(hours) 시간별 합성 예측을 만든다.

    Returns:
      {metric, label, unit, generated_from, points: [{t, value}], note}
    """
    label, unit, lo, hi = METRIC_META.get(metric, (metric, "", None, None))
    hours = max(1, min(int(hours or 24), 72))

    series: list[tuple[datetime, float]] = []
    for p in points:
        v = p.get(metric)
        t = _parse_time(p.get("t"))
        if v is None or t is None:
            continue
        try:
            series.append((t, float(v)))
        except (TypeError, ValueError):
            continue
    series.sort(key=lambda x: x[0])

    if not series:
        return {
            "metric": metric,
            "label": label,
            "unit": unit,
            "generated_from": None,
            "points": [],
            "note": "모의/시연 예측 — 실제 예보 아님 (입력 관측치 없음, 예측 생성 불가)",
        }

    last_t, last_v = series[-1]
    values = np.array([v for _, v in series], dtype=float)

    # 최근 추세(시간당 선형 기울기) — 최근 최대 12개 표본으로 최소자승 적합.
    recent = series[-12:]
    slope = 0.0
    if len(recent) >= 2:
        t0 = recent[0][0]
        xs = np.array([(t - t0).total_seconds() / 3600.0 for t, _ in recent])
        ys = np.array([v for _, v in recent])
        if float(np.ptp(xs)) > 0:
            slope = float(np.polyfit(xs, ys, 1)[0])

    # 최근 변동성 → 일주기 진폭 추정(최근 최대 48개 표본의 표준편차 기반).
    tail = values[-48:] if values.size >= 3 else values
    recent_std = float(np.std(tail)) if tail.size >= 3 else 0.0
    amplitude = max(recent_std * 0.6, abs(last_v) * 0.02, 0.02)
    base_noise_sigma = max(recent_std * 0.15, 0.01)

    rng = np.random.RandomState(_seed_from_key(seed_key or metric))

    last_hour_frac = last_t.hour + last_t.minute / 60.0
    phase0 = 2.0 * np.pi * (last_hour_frac - _PEAK_HOUR) / 24.0
    sin_phase0 = float(np.sin(phase0))

    out_points = []
    noise_prev = 0.0
    for h in range(1, hours + 1):
        t_h = last_t + timedelta(hours=h)
        hour_frac = t_h.hour + t_h.minute / 60.0
        phase_h = 2.0 * np.pi * (hour_frac - _PEAK_HOUR) / 24.0
        # 마지막 관측시각의 위상값을 기준(0)으로 뺀 "증분"만 더해 h=1 부근에서 관측값과 자연스럽게 이어지게 함.
        diurnal_delta = amplitude * (float(np.sin(phase_h)) - sin_phase0)

        if abs(1.0 - _PHI_TREND) > 1e-9:
            trend_cum = slope * _PHI_TREND * (1.0 - _PHI_TREND ** h) / (1.0 - _PHI_TREND)
        else:
            trend_cum = slope * h

        eps = float(rng.normal(0.0, base_noise_sigma))
        noise_prev = _PHI_NOISE * noise_prev + eps

        val = last_v + trend_cum + diurnal_delta + noise_prev
        val = _clamp(val, lo, hi)
        out_points.append({"t": t_h.strftime("%Y-%m-%d %H:%M"), "value": round(val, 3)})

    return {
        "metric": metric,
        "label": label,
        "unit": unit,
        "generated_from": last_t.strftime("%Y-%m-%d %H:%M"),
        "points": out_points,
        "note": "모의/시연 예측 — 실제 예보 아님",
    }
