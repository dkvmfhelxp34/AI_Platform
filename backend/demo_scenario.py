"""시연 시나리오 주입 — "대다수 정상 운영 중 예외를 관리한다" 서사(ui_revision_notes.md §13-2).

## 왜 필요한가

`status.py` 를 고정 임계값(정상<2h/지연≥2h/미수신≥6h)으로 바꾸면 실데이터 기준 거의 모든 지점이
"정상"이 된다(실측 2026-07-15: 전 지점 관측나이 최대 52.1분 — 6시간은커녕 2시간도 안 됨). 이러면
지연/미수신 UI, QC 이상감지 UI 가 화면에 전혀 안 잡혀 "이 플랫폼이 예외를 어떻게 다루는지"를
시연할 수 없다. 이 모듈은 **소수(8개) 고정 지점**에 한해 상태·시계열을 결정론적으로 재연출한다.

## 원칙

  - **게이트**: `DEMO_SCENARIO` 환경변수. 미설정 시 기본 ON(이 플랫폼은 CLAUDE.md 상 명시적
    "시연용" 이므로 기본 켜짐이 맞다). `DEMO_SCENARIO=0`(또는 false/off/no)이면 완전 비활성 —
    이 모듈의 모든 공개 함수가 입력을 그대로 통과시킨다(실데이터/실계산 그대로).
  - **결정론**: 난수·`datetime.now()` 직접 사용 없음. 고정 station id → 고정 (상태, 합성
    경과시간) 또는 (metric, 스파이크 값, 최신관측 기준 상대 위치) 표만 사용한다. 유일하게
    "지금" 을 참조하는 곳은 `kma_marine.now_kst()`(합성 관측시각을 "지금 - 합성 경과시간"으로
    역산하기 위함)뿐이고, 이는 매 요청 재계산돼도 "상태·경과시간 자체는 고정"이라는 결정론이
    깨지지 않는다(경과시간이 고정이므로 계산되는 시각도 그 순간 기준으로 항상 일관됨).
  - **분량 절제**: 총 8개 지점(미수신 2 · 지연 3 · QC 스파이크 3, 서로 겹치지 않음). 최대
    파고/최대 풍속 헤드라인 지점은 회피(기존 실측 통계와 혼동 방지). KMA·KHOA 를 섞고,
    지리적으로 분산된 인지도 있는 지점을 골랐다(아래 표 주석 참고).
  - **정직성**: 이 파일명·주석·env 게이트 자체가 "시연 연출"임을 코드상 명시한다(CLAUDE.md
    "가상 예측·QC 결과는 시연/모의" 원칙과 동일선상 — 화면엔 실제 사례처럼 표출되지만, 소스에서는
    항상 이 모듈을 거쳐야만 발생하는 것으로 구분돼 있다).
"""
from __future__ import annotations

import os
from datetime import timedelta
from typing import Optional

import kma_marine

# ── 게이트 ──────────────────────────────────────────────────────────────────
_OFF_VALUES = {"0", "false", "off", "no"}


def is_enabled() -> bool:
    """DEMO_SCENARIO 환경변수 — 기본 ON(미설정 시 켜짐), 명시적으로 끄려면 0/false/off/no."""
    v = os.environ.get("DEMO_SCENARIO")
    if v is None:
        return True
    return v.strip().lower() not in _OFF_VALUES


# ── 13-2a. 상태 override — 지연 3 · 미수신 2 (총 5, 서로 다른 지점) ─────────────────────────
# 값: (status_label, synthetic_age_minutes). status_label 은 status.Status.value 와 동일 문자열.
# 나이는 새 고정 임계값(정상<120분/지연≥120분/미수신≥360분) 경계 안쪽에 확실히 들어가도록 선택.
# 최대파고 지점(독도 KMA_22441)·최대풍속 지점(울산 KMA_22189)은 회피.
DEMO_STATUS_OVERRIDE: dict[str, tuple[str, float]] = {
    # 지연(≈150·200·240분 — 2시간 이상 6시간 미만)
    "KMA_22106": ("지연", 150.0),  # 포항(KMA 해양기상부이, 동해안 대표 도시)
    "TW_0078": ("지연", 200.0),    # 완도항(KHOA 해양관측부이, 남해/전남)
    "KG_0025": ("지연", 240.0),    # 남해동부(KHOA 심해부이, 국가해양관측망)
    # 미수신(≈440·520분 — 6시간 이상)
    "KMA_22107": ("미수신", 440.0),  # 마라도(KMA 해양기상부이, 국토 최남단 — 인지도 높음)
    "TW_0076": ("미수신", 520.0),    # 인천항(KHOA 해양관측부이, 서해/수도권 관문)
}


def apply_status_override(item: dict) -> dict:
    """`live_snapshot.py` 가 계산한 라이브 아이템(status/minutes_since/obs_time 포함)에 시연
    override 를 적용한다. 대상 지점이 아니거나 게이트가 꺼져 있으면 손대지 않고 그대로 반환한다.

    override 되는 필드: `status`, `minutes_since`, `obs_time`(합성 경과시간만큼 노후화). 원본
    `values`(라이브 관측값)는 건드리지 않는다 — "미수신 직전 마지막으로 받은 값" 이라는 실제
    운영 의미와 같다. `obs_time` 을 함께 노후화하는 이유는 상태·타임스탬프 불일치("미수신인데
    관측시각은 방금")를 팝업/상세에서 노출하지 않기 위함(§13-2 요구사항).
    """
    if not is_enabled():
        return item
    override = DEMO_STATUS_OVERRIDE.get(item.get("id"))
    if override is None:
        return item

    status_label, age_min = override
    now = kma_marine.now_kst()
    synthetic_obs = now - timedelta(minutes=age_min)

    item["status"] = status_label
    item["minutes_since"] = age_min
    item["obs_time"] = synthetic_obs.strftime("%Y-%m-%d %H:%M")
    return item


# ── 13-2b. QC 스파이크 — 3개 지점, 서로 다른 metric/조합 (정상 상태 유지) ───────────────────
# offset_from_end: 시계열 points 배열의 "끝에서 N번째"(0=마지막) 인덱스에 주입 — 절대시각이
# 아니라 "최신 관측 기준" 상대 위치라 range(24h/7d/…)나 호출 시각이 달라져도 항상 재현 가능하게
# "최근이지만 맨 끝(=지금)은 아닌" 자리에 놓인다. qc.detect_spikes 는 좌우로 최소 5개 표본이
# 있어야 판정하므로(창 window=7, half=3) 4 이상 여유를 둔다.
# gap_offset_from_end/gap_len: (선택) 그 지점의 포인트를 통째로 gap_len 개 제거해 실제 결측
# 구간(시간 간격 확대)을 재현한다 — spike 위치와 겹치지 않게 충분히 떨어뜨려 둔다.
DEMO_QC_SPIKES: dict[str, dict] = {
    "KMA_22104": {  # 거제도(KMA 해양기상부이) — 파고 실측 1~2m대 → 4.2m 단발
        "metric": "wave", "value": 4.2, "offset_from_end": 4,
        "gap_offset_from_end": 20, "gap_len": 3,  # 남해 남부, 24h(48pt) 여유 충분 → gap 도 시연
    },
    "TW_0087": {  # 부산항(KHOA 해양관측부이) — 수온 실측 ~20℃대 → 26.5℃ 단발
        "metric": "water_temp", "value": 26.5, "offset_from_end": 4,
    },
    "KG_0024": {  # 대한해협(KHOA 심해부이, 국가해양관측망) — 파고 실측 1~2m대 → 3.6m 단발
        "metric": "wave", "value": 3.6, "offset_from_end": 4,
    },
}

# 스파이크/gap 주입 최소 표본 여유 — 이보다 짧은 시리즈(예: 파고부이 C타입 24h 일별 대체 경로처럼
# 표본이 극히 적은 경우)는 주입하지 않고 원본 그대로 반환한다(과탐/인덱스 오류 방지).
_MIN_POINTS_FOR_INJECTION = 8


def apply_timeseries_override(points: list[dict], station_id: str) -> list[dict]:
    """§A2 픽스 — `apply_status_override` 로 지연/미수신 처리되는 지점의 시계열도 같은 결정(상태·
    합성 경과시간)에 맞춰 잘라낸다. 대상 지점이 아니거나 게이트가 꺼져 있으면 그대로 반환한다.

    왜 필요한가: override 대상 지점은 라이브 배지가 "미수신 · 7시간 전" 처럼 보이는데, 이 지점의
    `/api/timeseries` 를 손대지 않으면 실측 그대로 "지금"까지 이어지는 선이 그려져 배지와 정면으로
    모순된다(§13-2 요구사항 — "관측시각은 방금인데 미수신" 류 불일치를 상세 패널에서도 반드시
    피해야 한다). 여기서는 관측시각이 `now - age_min`(= `apply_status_override` 가 쓴 것과 동일한
    합성 경과시간) 이후인 포인트를 전부 잘라내 실제 배지가 말하는 "마지막 수신 후 끊김"을 차트에도
    그대로 반영한다 — 값 자체는 바꾸지 않고 끝부분만 제거한다(원본 불변, 새 리스트 반환).

    `now` 기준: `apply_status_override` 와 동일하게 `kma_marine.now_kst()`(요청마다 재계산돼도
    "경과시간 자체는 고정"이라는 결정론이 깨지지 않는다 — 모듈 독스트링 "결정론" 항목 참고).
    """
    if not is_enabled():
        return points
    override = DEMO_STATUS_OVERRIDE.get(station_id)
    if override is None:
        return points

    _status_label, age_min = override
    now = kma_marine.now_kst()
    cutoff = (now - timedelta(minutes=age_min)).strftime("%Y-%m-%d %H:%M")
    return [p for p in points if p.get("t") and p["t"] <= cutoff]


def inject_qc_spikes(points: list[dict], metric: str, station_id: str) -> list[dict]:
    """큐레이션된 지점·metric 조합에 한해 `points`(timeseries.py 포인트 리스트)에 스파이크
    (+선택적 결측 구간)를 주입한다. 대상이 아니면(지점 불일치·metric 불일치·게이트 꺼짐·표본
    부족) `points` 를 그대로 반환한다 — 호출부가 이미 만든 리스트/원소는 변경하지 않고, 필요한
    자리만 얕은 복사로 교체한 새 리스트를 돌려준다(원본 불변).
    """
    if not is_enabled():
        return points
    cfg = DEMO_QC_SPIKES.get(station_id)
    if not cfg or cfg.get("metric") != metric:
        return points

    n = len(points)
    if n < _MIN_POINTS_FOR_INJECTION:
        return points

    offset = int(cfg.get("offset_from_end", 4))
    spike_idx = n - 1 - offset
    if not (0 <= spike_idx < n):
        return points

    out = list(points)
    p = dict(out[spike_idx])
    p[metric] = cfg["value"]
    out[spike_idx] = p

    gap_offset: Optional[int] = cfg.get("gap_offset_from_end")
    gap_len = int(cfg.get("gap_len", 0) or 0)
    if gap_offset is not None and gap_len > 0:
        gap_end = n - 1 - int(gap_offset)
        gap_start = gap_end - gap_len + 1
        # spike 자리와 겹치지 않고, 배열 안쪽(양 끝 최소 1개는 남김)인 경우에만 실제로 구간을 뺀다.
        if 0 < gap_start <= gap_end < n - 1 and not (gap_start <= spike_idx <= gap_end):
            out = out[:gap_start] + out[gap_end + 1:]

    return out
