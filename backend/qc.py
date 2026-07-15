"""알고리즘 기반 AI-QC (Phase 4) — `timeseries.py` 의 관측기관 QC(AQC/MQC)와는 독립적으로,
수치 시계열 자체에서 튐값(spike)·결측/시간간격(gap)을 통계적으로 탐지한다.

결정론적(같은 입력 → 항상 같은 출력), 외부 API·난수 없음(numpy 는 통계 연산에만 사용).
프론트에서 기관 QC(`qc`)와 AI-QC(`ai_qc`)를 구분해 표시할 수 있도록 필드를 분리해 둔다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np

_TIME_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y%m%d%H%M", "%Y-%m-%dT%H:%M:%S")

_DEFAULT_WINDOW = 7       # 스파이크 판정 시 좌우로 볼 표본 수(대략 2*half+1)
_DEFAULT_Z_THRESH = 3.5   # robust z-score 임계값
_DEFAULT_GAP_FACTOR = 2.5  # 중앙값 샘플링 간격의 몇 배부터 "간격(gap)"으로 볼지


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


def _to_float_array(values: list) -> "np.ndarray":
    out = np.empty(len(values), dtype=float)
    for i, v in enumerate(values):
        if v is None:
            out[i] = np.nan
            continue
        try:
            out[i] = float(v)
        except (TypeError, ValueError):
            out[i] = np.nan
    return out


# ── 스파이크 탐지: 롤링 median + MAD(robust z-score) ──────────────────────────

def detect_spikes(
    values: list,
    times: Optional[list] = None,
    window: int = _DEFAULT_WINDOW,
    z_thresh: float = _DEFAULT_Z_THRESH,
) -> list[bool]:
    """롤링 median + MAD 기반 robust z-score 로 튐값(outlier) 플래그.

    지점 i 를 중심으로 한 창(window, 결측 제외 최소 5개 표본 필요)에서
    |x_i - median| / (1.4826 * MAD) > z_thresh 이면 스파이크로 플래그한다.

    창(window)의 MAD 가 0(=창 내 값이 사실상 상수, 센서 양자화/평온한 구간에서 흔함)이면 그 창만으로는
    판단할 수 없으므로 시리즈 전체(valid 값 전체)의 전역 MAD 로 대체한다. 전역 MAD 도 0(=시리즈 전체가
    상수)이면 판단 불가로 보고 스킵한다 — "튐"이라는 개념 자체가 성립하지 않는 퇴화 사례이기 때문.

    표본이 5개 미만인 시리즈는 판단을 보류(모두 False)한다.
    times 파라미터는 시그니처 호환용으로만 받는다(현재 스파이크 판정에는 값 순서만 사용, 결측 구간·시간
    간격 판정은 `detect_gaps` 가 담당).
    """
    n = len(values)
    flags = [False] * n
    if n < 5:
        return flags

    arr = _to_float_array(values)
    valid_all = arr[~np.isnan(arr)]
    if valid_all.size < 5:
        return flags

    global_med = float(np.median(valid_all))
    global_mad = float(np.median(np.abs(valid_all - global_med)))

    half = max(2, window // 2)
    for i in range(n):
        if np.isnan(arr[i]):
            continue
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        win = arr[lo:hi]
        win = win[~np.isnan(win)]
        if win.size < 5:
            continue

        med = float(np.median(win))
        mad = float(np.median(np.abs(win - med)))
        scale = mad if mad > 1e-9 else global_mad
        if scale <= 1e-9:
            continue  # 창도 전역도 사실상 상수 — 튐 판단 불가, 과탐 방지 위해 스킵

        robust_z = abs(arr[i] - med) / (1.4826 * scale)
        if robust_z > z_thresh:
            flags[i] = True
    return flags


# ── 결측/시간간격 탐지 ────────────────────────────────────────────────────────

def detect_gaps(
    times: list,
    values: list,
    gap_factor: float = _DEFAULT_GAP_FACTOR,
) -> tuple[list[bool], list[dict]]:
    """결측값(None/NaN) 포인트 플래그 + 비정상적으로 벌어진 시간 간격(gap) 구간 탐지.

    Returns:
      missing_flags: 포인트별 결측 여부(값이 None/NaN 이면 True).
      gap_segments: 인접 관측 사이 시간 간격이 "중앙값 샘플링 간격 * gap_factor" 를 넘는 구간 목록,
        각 원소는 {"from": t_i, "to": t_{i+1}, "minutes": Δ분}.
    """
    n = len(values)
    missing: list[bool] = []
    for v in values:
        if v is None:
            missing.append(True)
            continue
        try:
            missing.append(bool(np.isnan(float(v))))
        except (TypeError, ValueError):
            missing.append(True)

    dts = [_parse_time(t) for t in times]
    deltas_min: list[float] = []
    for i in range(1, n):
        if dts[i] is not None and dts[i - 1] is not None:
            d = (dts[i] - dts[i - 1]).total_seconds() / 60.0
            if d > 0:
                deltas_min.append(d)

    gap_segments: list[dict] = []
    if deltas_min:
        median_interval = float(np.median(deltas_min))
        if median_interval > 0:
            threshold = median_interval * gap_factor
            for i in range(1, n):
                if dts[i] is None or dts[i - 1] is None:
                    continue
                d = (dts[i] - dts[i - 1]).total_seconds() / 60.0
                if d > threshold:
                    gap_segments.append({
                        "from": times[i - 1],
                        "to": times[i],
                        "minutes": round(d, 1),
                    })
    return missing, gap_segments


# ── 공개 진입점 ────────────────────────────────────────────────────────────────

def run_qc(points: list[dict], metric: str) -> dict:
    """points(timeseries.py 의 point 리스트, 각 dict 에 't' 와 `metric` 키 존재)에 대해
    알고리즘 AI-QC 를 실행한다.

    Returns:
      {
        "points": [원본 point + {"ai_qc": {"spike": bool, "missing": bool}}, ...],
        "summary": {"spike_count": int, "gap_count": int, "missing_count": int, "gaps": [...]},
      }

    원본 points 는 변경하지 않는다(각 포인트를 얕은 복사 후 ai_qc 를 추가).
    """
    times = [p.get("t") for p in points]
    values = [p.get(metric) for p in points]

    spikes = detect_spikes(values, times)
    missing, gap_segments = detect_gaps(times, values)

    out_points = []
    for i, p in enumerate(points):
        q = dict(p)
        q["ai_qc"] = {"spike": bool(spikes[i]), "missing": bool(missing[i])}
        out_points.append(q)

    summary = {
        "spike_count": int(sum(spikes)),
        "gap_count": len(gap_segments),
        "missing_count": int(sum(missing)),
        "gaps": gap_segments,
    }
    return {"points": out_points, "summary": summary}
