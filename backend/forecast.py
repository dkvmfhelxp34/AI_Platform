"""가상(합성) 24h 예측 생성 (Phase 6) — **시연/모의용, 실제 기상·해양 예보가 아니다.**

## 모델: 목표상한(capped-target) OU 감쇠회귀 + 물리 고정 일주기 + 램프인 노이즈 + rate-limit + 성장 밴드

관측 시계열(`timeseries.py` 의 points)의 마지막 관측값(anchor)에서 출발해, 시간(hour)당:

  1. **강건 기울기**(Theil-Sen, 시간창 기반 — 표본수 고정 아님)로 최근 추세를 추정하되,
     `k_drift * sigma_r` 로 상한을 씌운 "목표 이동폭"만 반영한다(선형 외삽 폭주 방지).
  2. 목표 레벨 `L` = anchor + (캡된) 추세이동 + 평균회귀(최근 중앙값 쪽으로 당김).
  3. `g(h) = L + (anchor - L)*exp(-h/tau) + diurnal(h)` — OU 감쇠회귀로 anchor→목표 사이를
     매끄럽게 잇는다. `g(0) = anchor` 항등식이 성립해 연속성이 항상 보장된다.
  4. **일주기 사인은 물리적으로 근거가 있는 지표(수온·풍속)에만** 고정 절대진폭으로 넣는다.
     파고·기압은 24h 주기가 물리적으로 없으므로 진폭 0(사인 항 없음).
  5. AR(1) 노이즈에 `1-exp(-h/tau_ramp)` 램프를 곱해 h→0 근방에서 노이즈가 죽어 이음매가
     안 보이게 하고, 매 스텝 `max_step`(시간당 최대 변화량)으로 rate-limit 한 뒤 물리 clamp.
  6. 표본 변동성(MAD 기반, floor 有)에서 `sqrt(h)` 로 자라다 cap 에서 포화하는 불확실성 밴드
     (`lower`/`upper`, `band_z`=p10/p90 대응)를 함께 낸다.

**결정론적**: `seed_key`(호출측에서 station id 등으로 구성)의 해시로 numpy `RandomState` 를 고정하므로
벽시계 난수에 의존하지 않는다 — 같은 입력(points, metric, hours, seed_key)이면 항상 같은 출력.

**불변식**(수학적으로 항상 성립 — 아래 각 for-loop 안의 assert 로도 매 스텝 검증):
  - `|value_h - value_{h-1}| <= max_step` (rate-limit 후 물리 clamp 는 [lo,hi] 로의 사영이고
    anchor 가 이미 [lo,hi] 안에 있으므로 비확장(non-expansive) 성질에 의해 자동 성립).
  - `lower_h <= value_h <= upper_h` (동일한 [lo,hi] 사영의 단조성에 의해 성립).
  - `sigma_band(h)` 는 h 에 대해 비감소(`sqrt(h)` 증가 후 cap 포화).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
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


@dataclass(frozen=True)
class MetricParams:
    """지표별 물리 파라미터(오케스트레이터 확정값). 단위: 시간(h)/원 지표 단위."""

    tau_h: float                 # OU 감쇠 시정수(τ) — 클수록 anchor→목표 수렴이 느림(열관성 큼)
    k_drift: float                # 추세이동 상한 = k_drift * sigma_r (발산 방지 캡)
    baseline_pull: float          # 평균회귀 계수(0~1) — 최근 중앙값 쪽으로 목표를 당기는 비중
    diurnal_amp_abs: float        # 일주기 절대진폭(물리 고정값). 파고·기압은 0(사인 항 없음)
    peak_hour: Optional[float]    # 일주기 피크 시각(시, KST). 일주기 없는 지표는 None
    noise_sigma_scale: float      # 노이즈 표준편차 = noise_sigma_scale * sigma_r
    phi_noise: float              # 노이즈 AR(1) 감쇠 계수
    tau_ramp: float               # 노이즈 램프인 시정수(h=0 근방 노이즈 억제)
    max_step: float                # 시간당 최대 변화량(rate limit)
    band_k: float                  # 밴드 성장 계수: sigma_band(h) = band_k*sigma_r*sqrt(h)
    band_cap_mult: float           # 밴드 상한 = band_cap_mult * sigma_r
    band_z: float                   # 밴드 z-value (1.2816 ≈ p10/p90)
    slope_window_h: float           # 강건기울기(Theil-Sen) 산정용 시간창(시간)
    vol_window_h: float             # 변동성(MAD)·기준레벨(M0) 산정용 시간창(시간)
    sigma_floor: float               # sigma_r 최소값(0-분산/희소표본 방지)


METRIC_PARAMS: dict[str, MetricParams] = {
    "wave": MetricParams(
        tau_h=12, k_drift=2.5, baseline_pull=0.20, diurnal_amp_abs=0.0, peak_hour=None,
        noise_sigma_scale=0.14, phi_noise=0.6, tau_ramp=2.0, max_step=0.4,
        band_k=0.55, band_cap_mult=3.0, band_z=1.2816,
        slope_window_h=12, vol_window_h=24, sigma_floor=0.03,
    ),
    "water_temp": MetricParams(
        tau_h=24, k_drift=2.5, baseline_pull=0.20, diurnal_amp_abs=0.4, peak_hour=15.0,
        noise_sigma_scale=0.10, phi_noise=0.6, tau_ramp=2.0, max_step=0.3,
        band_k=0.40, band_cap_mult=2.5, band_z=1.2816,
        slope_window_h=24, vol_window_h=48, sigma_floor=0.05,
    ),
    "wind_speed": MetricParams(
        tau_h=6, k_drift=3.0, baseline_pull=0.15, diurnal_amp_abs=0.6, peak_hour=15.0,
        noise_sigma_scale=0.16, phi_noise=0.55, tau_ramp=1.5, max_step=2.5,
        band_k=0.60, band_cap_mult=3.0, band_z=1.2816,
        slope_window_h=6, vol_window_h=24, sigma_floor=0.20,
    ),
    "pressure": MetricParams(
        tau_h=18, k_drift=2.5, baseline_pull=0.20, diurnal_amp_abs=0.0, peak_hour=None,
        noise_sigma_scale=0.08, phi_noise=0.6, tau_ramp=2.0, max_step=0.8,
        band_k=0.40, band_cap_mult=2.5, band_z=1.2816,
        slope_window_h=24, vol_window_h=48, sigma_floor=0.15,
    ),
}


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


def _window(series: list[tuple[datetime, float]], last_t: datetime, window_h: float) -> list[tuple[datetime, float]]:
    """last_t 기준 최근 window_h 시간 이내 표본만 남긴다(고정 개수 창이 아닌 시간창)."""
    return [(t, v) for t, v in series if (last_t - t).total_seconds() / 3600.0 <= window_h]


def _theil_sen_slope(sub: list[tuple[datetime, float]]) -> float:
    """강건 기울기(시간당) — 모든 쌍의 기울기의 중앙값. 표본<3개 또는 시간span<2h 면 0.0(추세 무시).

    고정 표본수 창(예: series[-12:])이 희소 데이터(예: 45분에 10개)를 "하루 추세"로 오인하는
    문제를 막기 위해, 표본수와 무관하게 실제 시간 span 이 짧으면 추세를 아예 반영하지 않는다.
    """
    n = len(sub)
    if n < 3:
        return 0.0
    t0 = sub[0][0]
    xs = np.array([(t - t0).total_seconds() / 3600.0 for t, _ in sub])
    ys = np.array([v for _, v in sub])
    span = float(xs[-1] - xs[0])
    if span < 2.0:
        return 0.0
    xi, xj = np.meshgrid(xs, xs, indexing="ij")
    yi, yj = np.meshgrid(ys, ys, indexing="ij")
    dx = xj - xi
    dy = yj - yi
    mask = dx > 1e-9  # i<j 인 쌍만(시간순 정렬 가정 — 동시각 중복은 제외)
    if not np.any(mask):
        return 0.0
    slopes = dy[mask] / dx[mask]
    return float(np.median(slopes))


def _mad_sigma(values: np.ndarray, floor: float) -> float:
    """MAD(median absolute deviation) 기반 표준편차 추정(*1.4826) — floor 로 0-분산/희소표본 방지."""
    if values.size == 0:
        return floor
    med = float(np.median(values))
    mad = float(np.median(np.abs(values - med)))
    return max(mad * 1.4826, floor)


def make_forecast(
    points: list[dict],
    metric: str,
    hours: int = 24,
    seed_key: str = "",
) -> dict:
    """points(timeseries.py 의 point 리스트)의 `metric` 값들로 24h(hours) 시간별 합성 예측을 만든다.

    Returns:
      {metric, label, unit, generated_from, points: [{t, value, lower, upper}],
       note, band: {method, z}, model: {type, tau_hours}}
    """
    label, unit, lo, hi = METRIC_META.get(metric, (metric, "", None, None))
    params = METRIC_PARAMS.get(metric)
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

    if not series or params is None:
        return {
            "metric": metric,
            "label": label,
            "unit": unit,
            "generated_from": None,
            "points": [],
            "note": "모의/시연 예측 — 실제 예보 아님 (입력 관측치 없음, 예측 생성 불가)",
        }

    last_t, last_v = series[-1]

    # ── 강건 통계량(시간창 기반) ─────────────────────────────────────────
    slope_sub = _window(series, last_t, params.slope_window_h)
    slope = _theil_sen_slope(slope_sub)

    vol_sub = _window(series, last_t, params.vol_window_h)
    vol_values = np.array([v for _, v in vol_sub], dtype=float)
    sigma_r = _mad_sigma(vol_values, params.sigma_floor)
    M0 = float(np.median(vol_values)) if vol_values.size else last_v

    # ── 목표 레벨 L: 캡된 추세이동 + 평균회귀 ───────────────────────────
    trend_shift = _clamp(slope * params.tau_h, -params.k_drift * sigma_r, params.k_drift * sigma_r)
    L = last_v + trend_shift + params.baseline_pull * (M0 - last_v)
    # 목표 레벨 자체를 물리 범위로 사영: 강한 실측 추세(예: 급감하는 풍속)가 k_drift 캡을 통과해도
    # 목표가 물리 벽 너머(예: 음의 풍속)로 넘어가면 g(h) 가 "벽보다 훨씬 아래"를 향해 수렴하다
    # 노이즈만으로 벽을 못 넘어서는 다시간 평탄벽(dead-flat)이 생긴다. L 을 [lo,hi] 로 먼저 사영해
    # anchor·목표가 둘 다 물리 범위 안에 있게 하면 g(h) 는 두 물리값의 볼록결합이라 노이즈 없이도
    # 벽에 매끄럽게(점근적으로) 접근할 뿐 충돌하지 않는다("추세-벽 충돌" 대신 "평균회귀 점근").
    L = _clamp(L, lo, hi)

    # ── 일주기(수온·풍속만; 파고·기압은 amp=0 → 항상 0) ─────────────────
    has_diurnal = params.diurnal_amp_abs != 0.0 and params.peak_hour is not None
    if has_diurnal:
        last_hour_frac = last_t.hour + last_t.minute / 60.0
        phase0 = 2.0 * np.pi * (last_hour_frac - params.peak_hour) / 24.0
        sin_phase0 = float(np.sin(phase0))
    else:
        sin_phase0 = 0.0

    rng = np.random.RandomState(_seed_from_key(seed_key or metric))

    out_points = []
    value_prev = last_v      # value_0 := anchor (rate-limit 기준점, g(0)=anchor 항등식과 정합)
    band_prev = -1.0
    e_prev = 0.0
    for h in range(1, hours + 1):
        t_h = last_t + timedelta(hours=h)

        if has_diurnal:
            hour_frac = t_h.hour + t_h.minute / 60.0
            phase_h = 2.0 * np.pi * (hour_frac - params.peak_hour) / 24.0
            # anchor 위상 오프셋(-sin(phase0))을 tau_ramp 로 지수감쇠시켜: h=0 근방에서는 델타형
            # (연속성 보장, diurnal(0)=0) 이지만 h 가 커지면 오프셋이 사라져 물리적으로 유계인
            # ±diurnal_amp_abs 절대 사인 사이클로 수렴한다. 감쇠 없이 델타를 그대로 24h 내내 쓰면
            # anchor 위상이 평균위상(sin=0)에서 멀 때 오프셋이 안 죽어 진폭이 최대 2배로 증폭되고
            # (예: 풍속 baseline 이 0 부근인 야간에 -2×amp 만큼 끌어내려 다시간 0 평탄벽 재발) —
            # 오프셋 감쇠로 "물리적으로 유계인 일주기"라는 원래 의도를 지킨다.
            offset_decay = float(np.exp(-h / params.tau_ramp))
            diurnal_h = params.diurnal_amp_abs * float(np.sin(phase_h)) - params.diurnal_amp_abs * sin_phase0 * offset_decay
        else:
            diurnal_h = 0.0

        g_h = L + (last_v - L) * float(np.exp(-h / params.tau_h)) + diurnal_h

        eps = float(rng.normal(0.0, params.noise_sigma_scale * sigma_r))
        e_h = params.phi_noise * e_prev + eps
        e_prev = e_h
        n_h = e_h * (1.0 - float(np.exp(-h / params.tau_ramp)))

        raw = g_h + n_h
        rate_limited = _clamp(raw, value_prev - params.max_step, value_prev + params.max_step)
        value = _clamp(rate_limited, lo, hi)

        # 불변식 점검(결정론 합성이므로 항상 성립 — 비확장 사영 성질에 의한 수학적 보장, 부동소수 여유 1e-6)
        assert abs(value - value_prev) <= params.max_step + 1e-6, "rate-limit invariant violated"

        sigma_band = min(params.band_k * sigma_r * float(np.sqrt(h)), params.band_cap_mult * sigma_r)
        assert sigma_band + 1e-9 >= band_prev, "band non-decreasing invariant violated"
        band_prev = sigma_band

        lower = _clamp(value - params.band_z * sigma_band, lo, hi)
        upper = _clamp(value + params.band_z * sigma_band, lo, hi)
        assert lower - 1e-6 <= value <= upper + 1e-6, "band clip invariant violated"

        out_points.append({
            "t": t_h.strftime("%Y-%m-%d %H:%M"),
            "value": round(value, 3),
            "lower": round(lower, 3),
            "upper": round(upper, 3),
        })
        value_prev = value

    return {
        "metric": metric,
        "label": label,
        "unit": unit,
        "generated_from": last_t.strftime("%Y-%m-%d %H:%M"),
        "points": out_points,
        "note": "모의/시연 예측 — 실제 예보 아님 (불확실성 밴드는 통계 보정 없는 시연용 참고치)",
        "band": {"method": "mad_sqrt_time_capped", "z": params.band_z},
        "model": {"type": "ou_capped_target", "tau_hours": params.tau_h},
    }
