"""알고리즘 기반 AI-QC (Phase 4) — `timeseries.py` 의 관측기관 QC(AQC/MQC)와는 독립적으로,
수치 시계열 자체에서 튐값(spike)·결측/시간간격(gap)을 통계적으로 탐지한다.

결정론적(같은 입력 → 항상 같은 출력), 외부 API·난수 없음(numpy 는 통계 연산에만 사용).
프론트에서 기관 QC(`qc`)와 AI-QC(`ai_qc`)를 구분해 표시할 수 있도록 필드를 분리해 둔다.

## §AIQC-RANGE 픽스(2026-07-22) — range-독립성 + 과탐 저감

기존엔 국지창(window) MAD 가 0 이면 시리즈 전체(요청 range 가 넘겨준 배열 전체)의 **전역** MAD 로
대체했다(`global_med`/`global_mad`). 이게 문제였다 — `timeseries.py` 는 range(24h/7d/30d/1y) 별로
**서로 다른 길이의 배열**을 넘기므로, 같은 절대시각 T 의 전역 MAD 가 range 마다 달라져 T 의 스파이크
판정이 range 에 따라 뒤집혔다(실측: KMA_22441 독도 파고, 2025-12-03 12:00 → 30d 에서 spike=True,
1y 에서 spike=False, 값은 동일). 전역 폴백을 걷어내고 그 자리를 **절대(단위 고정) MAD 플로어**로
대체한다 — 국지창이 우연히 평탄(MAD≈0)해도 그 지표의 "이 정도 흔들림은 정상" 최소치 아래로는
scale 이 내려가지 않게 한다. 근본 원인(경계 근처 점이 실제로는 더 넓은 이웃을 갖는데 range 가
배열을 잘라 국지창 자체가 절단됨)은 `timeseries.py`(padding/canonical 컨텍스트, `run_qc`의
`view_start` 트림)에서 고친다 — 이 모듈은 "같은 이웃이 주어지면 같은 판정"만 보장하면 된다.

윈도우도 7→11(half 3→5)로 넓혀 MAD 추정을 더 안정화했다. 그래도 풍속(wind_speed)은 국지적으로
자연스러운 돌풍 변동폭이 커서(실측: 윈도우=11·z=3.5·플로어 없음 기준 정상 지점도 ~0.4~1.4%가
튐으로 잡힘) 지표별로 z_thresh/mad_floor 를 다르게 준다(`_METRIC_QC_PARAMS`, 근거는 그 옆 주석).
파고(wave)는 기존과 체감상 거의 동일(≈0.05~0.1%)하게 유지한다.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

import numpy as np

_TIME_FORMATS = ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S", "%Y%m%d%H%M", "%Y-%m-%dT%H:%M:%S")

_DEFAULT_WINDOW = 11      # 스파이크 판정 시 좌우로 볼 표본 수(대략 2*half+1) — 7→11, MAD 추정 안정화
_DEFAULT_Z_THRESH = 3.5   # robust z-score 임계값(지표 미등록 시 폴백)
_DEFAULT_MAD_FLOOR = 0.05  # 절대 MAD 플로어(지표 미등록 시 폴백) — 단위는 그 지표 원 단위
_DEFAULT_GAP_FACTOR = 2.5  # 중앙값 샘플링 간격의 몇 배부터 "간격(gap)"으로 볼지

# 지표별 z_thresh/mad_floor — 2026-07-22 실측(KMA 10여개 지점 × range=30d, 윈도우=11) 기반 결정.
#   - wave(파고, m): 정상 지점 튐률이 윈도우 확대만으로 이미 낮음(≈0.04~0.07%, 옛 window=7 과
#     비슷한 수준) → z_thresh 는 그대로 3.5 유지. mad_floor=0.05m 는 "국지창이 우연히 평탄해도
#     0.05m(센서 분해능 절반 수준) 미만의 흔들림을 튐으로 보지 않는다"는 안전장치 — 부여 전/후
#     정상 지점 튐률(0.04~0.07%)이 거의 그대로다(실측), 반면 진짜 절단-경계 오탐(독도 사례)은
#     `timeseries.py` 의 range-독립 컨텍스트 픽스로 해소.
#   - wind_speed(풍속, m/s): 옛 window=7·z=3.5·전역폴백 기준 정상 지점도 ~1.5~6% 튐(과탐) —
#     돌풍(gust)의 자연 변동폭이 7~11 표본(30분 간격 기준 3~5.5시간 창) 안에서도 꽤 크기 때문.
#     실측(윈도우=11 기준): z=3.5/플로어0 은 아직 0.4~1.4%, z=4.5/mad_floor=0.8 로 올리면 정상
#     지점 대부분 0~0.07%까지 떨어지면서도, 국지 중앙값 대비 +8m/s 이상(거의 2배) 튀는 합성
#     주입 스파이크는 여전히 잡힌다(+3m/s 수준의 "그냥 좀 센 돌풍"은 더 이상 안 잡힘 — 의도된
#     동작, 요구사항의 "ordinary gusts stop being flagged").
#   - water_temp(수온, ℃)/pressure(기압, hPa): wave 만큼 자주 쓰이진 않지만 같은 원리로 실측
#     기반 플로어를 준다(water_temp 0.1℃, pressure 0.3hPa) — z_thresh 는 3.5 유지(원래도 과탐이
#     심하지 않았음, 실측 0.4%/0.08% 수준을 추가로 낮추는 목적).
_METRIC_QC_PARAMS: dict[str, dict[str, float]] = {
    "wave": {"z_thresh": 3.5, "mad_floor": 0.05},
    "wind_speed": {"z_thresh": 4.5, "mad_floor": 0.8},
    "water_temp": {"z_thresh": 3.5, "mad_floor": 0.1},
    "pressure": {"z_thresh": 3.5, "mad_floor": 0.3},
}


def _params_for_metric(metric: str) -> tuple[float, float]:
    p = _METRIC_QC_PARAMS.get(metric)
    if p:
        return p["z_thresh"], p["mad_floor"]
    return _DEFAULT_Z_THRESH, _DEFAULT_MAD_FLOOR


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
    mad_floor: float = _DEFAULT_MAD_FLOOR,
) -> list[bool]:
    """롤링 median + MAD 기반 robust z-score 로 튐값(outlier) 플래그 — PURE LOCAL(§AIQC-RANGE).

    지점 i 를 중심으로 한 창(window, 결측 제외 최소 5개 표본 필요)에서
    |x_i - median| / (1.4826 * max(MAD, mad_floor)) > z_thresh 이면 스파이크로 플래그한다.

    §AIQC-RANGE 픽스: 예전엔 창의 MAD 가 0 이면 시리즈 전체(호출부가 넘긴 배열 전체)의 **전역** MAD 로
    대체했는데, 그 배열이 range(24h/7d/30d/1y) 마다 길이가 달라(`timeseries.py`) 같은 절대시각의
    판정이 range 에 따라 뒤집히는 원인이 됐다(실측: 독도 KMA_22441 파고, 2025-12-03 12:00 → 30d
    spike=True / 1y spike=False, 동일 값). 전역 폴백을 완전히 제거하고, 그 자리를 **절대(단위 고정)
    MAD 플로어**(`mad_floor`, 지표별 값은 `qc.py` 상단 `_METRIC_QC_PARAMS` 참고)로 대체한다 — 창이
    우연히 평탄(MAD≈0)해도 scale 이 "이 지표에서 이 정도는 정상 흔들림" 최소치 아래로 내려가지
    않으므로 국지 정보만으로 결정론적이다(호출부가 넘긴 배열 길이에 더 이상 의존하지 않음).
    남은 range-의존성(경계 근처 점이 실제로는 더 넓은 실제 이웃을 갖는데 range 가 배열 자체를
    잘라 국지창이 절단되는 문제)은 이 함수의 책임이 아니라 호출부(`timeseries.py`)가 각 점에
    "잘리지 않은 진짜 이웃"을 담은 배열을 넘기도록 고쳐서 해결한다(padding/canonical 컨텍스트).

    scale 이 mad_floor 를 적용해도 0(=mad_floor 자체가 0 이고 창도 상수)이면 판단 불가로 스킵한다.
    표본이 5개 미만인 시리즈는 판단을 보류(모두 False)한다.
    times 파라미터는 시그니처 호환용으로만 받는다(현재 스파이크 판정에는 값 순서만 사용, 결측 구간·시간
    간격 판정은 `detect_gaps` 가 담당).
    """
    n = len(values)
    flags = [False] * n
    if n < 5:
        return flags

    arr = _to_float_array(values)
    if np.count_nonzero(~np.isnan(arr)) < 5:
        return flags

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
        scale = max(mad, mad_floor)
        if scale <= 1e-9:
            continue  # 창도 플로어도 사실상 0 — 튐 판단 불가, 과탐 방지 위해 스킵

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

def run_qc(points: list[dict], metric: str, view_start: Optional[str] = None) -> dict:
    """points(timeseries.py 의 point 리스트, 각 dict 에 't' 와 `metric` 키 존재)에 대해
    알고리즘 AI-QC 를 실행한다.

    `view_start`(§AIQC-RANGE, 선택): `timeseries.py` 가 표시 구간(view window) 시작 이전의 실제 과거
    표본을 "패딩"으로 덧붙여 `points` 를 넘길 때, 그 경계 문자열("t" 와 같은 포맷)을 전달한다.
    스파이크는 **패딩을 포함한 전체 배열**에서 계산한다(경계 근처 점도 실제 이웃 컨텍스트를 갖게
    되어 range 에 따라 판정이 안 바뀐다 — qc.py 모듈독스트링 §AIQC-RANGE 참고). 결측(missing)·시간간격
    (gap)은 점 자체 값/인접 관측 간격만 보는 순수 지역적 판정이라 range 의존성이 원래 없으므로,
    반환하는 `points`/`summary` 는 `view_start` 로 트림한 **표시 구간만**을 기준으로 다시 계산한다
    (패딩 구간은 결과에 노출하지 않음 — 응답 스키마·표시 범위는 기존과 동일하게 유지).
    `view_start` 가 None 이면 트림 없이 넘어온 points 전체를 그대로 사용한다(레거시 `hours` 경로 등).

    Returns:
      {
        "points": [원본 point + {"ai_qc": {"spike": bool, "missing": bool}}, ...],
        "summary": {"spike_count": int, "gap_count": int, "missing_count": int, "gaps": [...]},
      }

    원본 points 는 변경하지 않는다(각 포인트를 얕은 복사 후 ai_qc 를 추가).
    """
    times_all = [p.get("t") for p in points]
    values_all = [p.get(metric) for p in points]

    z_thresh, mad_floor = _params_for_metric(metric)
    spikes_all = detect_spikes(values_all, window=_DEFAULT_WINDOW, z_thresh=z_thresh, mad_floor=mad_floor)

    if view_start is not None:
        keep_idx = [i for i, t in enumerate(times_all) if t and t >= view_start]
    else:
        keep_idx = list(range(len(points)))

    trimmed_points = [points[i] for i in keep_idx]
    trimmed_times = [times_all[i] for i in keep_idx]
    trimmed_values = [values_all[i] for i in keep_idx]
    trimmed_spikes = [spikes_all[i] for i in keep_idx]

    missing, gap_segments = detect_gaps(trimmed_times, trimmed_values)

    out_points = []
    for i, p in enumerate(trimmed_points):
        q = dict(p)
        q["ai_qc"] = {"spike": bool(trimmed_spikes[i]), "missing": bool(missing[i])}
        out_points.append(q)

    summary = {
        "spike_count": int(sum(trimmed_spikes)),
        "gap_count": len(gap_segments),
        "missing_count": int(sum(missing)),
        "gaps": gap_segments,
    }
    return {"points": out_points, "summary": summary}
