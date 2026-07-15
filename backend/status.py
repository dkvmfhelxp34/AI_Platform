"""부이 수신상태 판정 — **고정 임계값** 3단계 freshness 판정(2026-07-15, 사용자 지시로 확정).

## 왜 cadence(관측주기) 기반(구버전)을 버렸는가

이전 버전은 부이별 "기대 관측주기"를 추정해 그 배수로 정상/지연/미수신 상한을 계산했다
(KMA cadence×1.5+lag, KHOA cadence×1.5+lag 등). 실측 검증 중 사용자가 더 단순하고 예측 가능한
기준을 요구했다 — 지점마다 다른 상한이 붙으면 "지연"·"미수신"이 정확히 몇 분부터인지 화면에서
직관적으로 설명하기 어렵고, cadence 추정치(실측 중앙값/정적 폴백) 자체의 오차가 판정 경계에
그대로 전이된다.

## 새 모델 — 고정 임계값(fixed threshold)

지점·소스·cadence 와 무관하게 전 지점 동일 기준을 적용한다:

  - **정상**: `minutes_since < 120`(2시간 미만)
  - **지연**: `120 <= minutes_since < 360`(2시간 이상 6시간 미만)
  - **미수신**: `minutes_since >= 360`(6시간 이상), 또는 관측시각을 아예 파싱할 수 없음(결측)

**근거**: 2시간은 이 플랫폼이 다루는 어떤 저빈도 부이(KHOA 심해부이 KG_ 30분 주기, 그 밖에도
1시간 주기로 보고하는 지점이 있어도 그 배수 안에 넉넉히 들어간다)의 정상 갱신 주기보다도
넉넉하다 — 그래서 "30분·1시간 주기로 정상 동작 중인 부이가 지연으로 오판되는" 사고가 나지
않는다(§7 요구사항과 일관). 6시간은 그보다 한 단계 더 넉넉한 여유를 둬 "미수신"이 실제로
장시간 응답이 끊긴 경우에만 붙게 한다.

## cadence_min 은 표시용으로만 계속 계산

`classify()` 는 여전히 `cadence_min` 을 반환한다 — 상태 판정에는 더 이상 쓰이지 않지만, 상세
패널의 "관측주기 ~N분" 같은 설명 문구에 컨텍스트를 제공하기 위해서다. 계산 자체(`cadence_for()`,
KHOA 실측 `observed_cadence_min` 우선 사용 등)는 구버전 로직을 그대로 재사용한다(동작 변경 없음
— 이 값은 더 이상 판정 임계값 계산에 들어가지 않을 뿐).

## SSOT(Single Source of Truth) 원칙

`classify()` 는 `status` 와 함께 그 판정에 실제로 쓰인 `minutes_since`, 그리고 위 컨텍스트용
`cadence_min` 을 **같은 호출에서 함께** 반환한다. 프론트(리스트의 "N분 전", 헤더 live 배지,
KPI "최근 갱신")는 전부 이 한 번의 계산 결과를 그대로 읽어야 한다 — 별도 계산식으로 "N분 전"을
다시 구하면 `status` 판정에 쓰인 것과 다른 값이 나올 수 있어 "40분 전인데 정상" 같은 모순이
생긴다. `minutes_since` 가 SSOT 이고, `cadence_min` 은 "이 부이 기준 정상 주기가 얼마인지"를
설명해주는 부가 컨텍스트일 뿐, 더 이상 판정에 관여하지 않는다.
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


# ── 고정 판정 임계값(분) — 소스/지점 무관 전역 동일 기준. ──────────────────────────────────
_OK_MAX_MIN = 120.0    # 이 미만이면 정상(2시간)
_LOST_MIN_MIN = 360.0  # 이 이상이면 미수신(6시간). [_OK_MAX_MIN, _LOST_MIN_MIN) 구간은 지연.


# ── cadence(관측주기) 추정 — 표시용("관측주기 ~N분")으로만 쓰임, 판정에는 관여하지 않음. ──────
# 구버전 cadence 기반 판정에서 쓰던 정적 기본값을 그대로 재사용(계산 로직 변경 없음).
_CADENCE_KMA = 10.0          # sea_obs 10분 격자
_CADENCE_KHOA_DEEP = 30.0    # KG_(심해부이) — twRecent 로도 실측 30분 간격
_CADENCE_KHOA_COASTAL = 5.0  # TW_/HB_/YS_ 등 연안부이 — twRecent 1~5분(대표값)

# 심해부이 접두사(twRecent 응답 자체가 30분 주기인 지점군). 새 접두사가 늘어도
# `observed_cadence_min`(실측 중앙값)이 있으면 이 표는 폴백으로만 쓰이므로 안전하다.
_KHOA_DEEP_PREFIXES = {"KG"}


def cadence_for(
    source: str,
    stn_id: Optional[str] = None,
    observed_cadence_min: Optional[float] = None,
) -> tuple[float, float]:
    """(cadence_min, lag_margin_min) 결정 — **표시용 컨텍스트 계산일 뿐, 상태 판정엔 더 이상
    쓰이지 않는다**(판정은 고정 임계값, 위 모듈독스트링 참고). `lag_margin_min` 은 구버전 판정
    로직의 잔재로, 현재는 호출부(`classify`)가 무시한다.

    우선순위: 1) `observed_cadence_min`(최근 관측 간격의 실측 중앙값, 있으면 최우선 — 호출부가
                 이미 보유한 이력에서 0회 추가 외부호출로 계산해 넘겨준다)
             2) source/접두사 기반 정적 기본값
    """
    lag = 0.0  # 구버전 배포지연 마진 — 판정에는 더 이상 쓰이지 않아 0으로 고정(반환 형식만 유지)

    if observed_cadence_min is not None and observed_cadence_min > 0:
        return float(observed_cadence_min), lag

    if source == "KMA":
        return _CADENCE_KMA, lag

    if source == "KHOA":
        prefix = (stn_id or "").split("_")[0].upper()
        if prefix in _KHOA_DEEP_PREFIXES:
            return _CADENCE_KHOA_DEEP, lag
        return _CADENCE_KHOA_COASTAL, lag

    return _CADENCE_KMA, lag  # 알 수 없는 소스는 보수적으로 KMA 급 기본값


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


def classify(
    obs_time_kst: DateLike,
    now_kst: Optional[datetime] = None,
    source: str = "KMA",
    stn_id: Optional[str] = None,
    observed_cadence_min: Optional[float] = None,
) -> dict:
    """관측시각·현재시각(둘 다 KST naive)으로 상태 판정(**고정 임계값** — 모듈독스트링 참고).

    판정 기준: `minutes_since < 120` → 정상, `120 <= minutes_since < 360` → 지연,
    `minutes_since >= 360` 또는 관측시각 파싱 불가 → 미수신. `minutes_since` 가 음수(시계
    오차/미래 타임스탬프)면 정상으로 간주한다.

    Args:
        source, stn_id, observed_cadence_min: 판정에는 더 이상 쓰이지 않지만, 반환하는
            `cadence_min`(표시용 "관측주기 ~N분" 컨텍스트) 계산을 위해 그대로 받는다
            (호출부 시그니처 호환 유지).

    Returns: {"status": Status, "minutes_since": float|None, "cadence_min": float}
    """
    if now_kst is None:
        now_kst = kma_marine.now_kst()

    cadence, _lag_margin = cadence_for(source, stn_id, observed_cadence_min)

    obs_dt = _parse_obs_time(obs_time_kst)
    if obs_dt is None:
        return {"status": Status.LOST, "minutes_since": None, "cadence_min": round(cadence, 1)}

    minutes = (now_kst - obs_dt).total_seconds() / 60.0

    if minutes < 0:
        # 시계 오차/미래 타임스탬프 — 정상으로 간주(음수를 지연/미수신으로 오판하지 않음)
        status = Status.OK
    elif minutes < _OK_MAX_MIN:
        status = Status.OK
    elif minutes < _LOST_MIN_MIN:
        status = Status.DELAYED
    else:
        status = Status.LOST

    return {"status": status, "minutes_since": round(minutes, 1), "cadence_min": round(cadence, 1)}
