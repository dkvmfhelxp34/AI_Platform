"""서버측 백그라운드 라이브 스냅샷 캐시 (Phase 2 — KHOA 커버리지 & KMA 신선도 픽스).

문제:
  - 기존 `/api/live` 는 매 HTTP 요청마다 외부 API 를 직접 불렀다. KHOA `twRecent` 는 `obsCode` 필수
    (전체 일괄 조회 불가 → 지점별 순회)라서, 요청마다 41개소를 다 부르면 트래픽이 급증 → 데모 6개소
    (`khoa_api.DEMO_KG_OBS_CODES`)만 불러왔고, 나머지 35개소는 시계열(`/api/timeseries`)은 되는데
    라이브 스냅샷(`/api/live`)엔 없어 지도에서 "미수신"으로 보이는 불일치가 있었다.
  - KMA `sea_obs` 도 `kma_marine.py` 내부 캐시(TTL 4분)에만 의존해, 캐시가 오래될수록(즉 그 사이
    아무도 `/api/live` 를 안 부르면) 관측시각이 굳어 있다가 다음 요청에서 `status.classify()` 가
    현재시각과 비교해 "지연"으로 판정하는 경우가 생겼다(요청 타이밍에 신선도가 좌우됨).

해결: 백그라운드 데몬 스레드 2개가 인메모리 스냅샷을 주기적으로 채우고, HTTP 요청(`/api/live`,
`/api/status`)은 이 스냅샷을 **0회 외부호출**로 읽어 상태만 "현재시각" 기준으로 매 요청 재계산한다
(freshness 판정은 항상 최신, 외부 API 호출량은 요청 빈도와 완전히 분리됨).

- KMA: `kma_marine.fetch_sea_obs()` 1회 호출 = 186개 지점(B/C 포함) 전체 → 5분마다 갱신.
- KHOA: 41개소를 `khoa_api.fetch_tw_recent_series()` 로 burst 순회(호출 간 간격은 khoa_api.py 자체
  throttle(`_MIN_INTERVAL=0.15초`)로 이미 제한됨 → burst 1회 ≈ 41*0.15s ≈ 6초) → burst 를 10분마다 반복.
  `_series()` 는 `fetch_tw_recent()` 와 **같은 네트워크 호출·캐시키**를 쓰므로(khoa_api.py 참고),
  호출 횟수를 늘리지 않고도 최신값 + 롤링 이력을 함께 얻어 지점별 실측 관측주기(cadence, 연속
  관측 간격의 중앙값)를 계산할 수 있다 — `status.py` 의 cadence 기반 판정(Fix 1)이 이 값을 쓴다
  (`cadence_min_observed`, 없으면 status.py 의 접두사 기본값으로 폴백).

Rate budget (일일 KHOA twRecent 호출량, 서비스 한도 10,000건/일):
  41개소 × (24h * 60min / 10min 주기) = 41 × 144 = 5,904 건/일  < 10,000/일  (여유 ≈ 41%)
  (실제로는 burst 자체가 몇 초 걸리므로 주기가 10분보다 살짝 길어 이보다 더 적게 소모된다.
   `fetch_tw_recent_series()` 로 바뀌어도 호출 1회당 응답은 동일 — 이 예산에 변화 없음.)
"""
from __future__ import annotations

import threading
import time
from datetime import datetime
from typing import Optional

import kma_marine
import khoa_api

_LOCK = threading.Lock()

_KMA_SNAPSHOT: list[dict] = []
_KMA_UPDATED_AT: Optional[float] = None

_KHOA_SNAPSHOT: dict[str, dict] = {}
_KHOA_UPDATED_AT: Optional[float] = None

_KMA_REFRESH_SEC = 300   # 5분
_KHOA_REFRESH_SEC = 600  # 10분(버스트 사이 대기 — 버스트 자체 소요시간은 별도)

_started = False
_start_lock = threading.Lock()


# ── 조회 ─────────────────────────────────────────────────────────────────────

def get_kma_snapshot() -> tuple[list[dict], Optional[float]]:
    """(KMA sea_obs 전체 레코드 리스트, 마지막 갱신 unix time) — 갱신 전이면 ([], None)."""
    with _LOCK:
        return list(_KMA_SNAPSHOT), _KMA_UPDATED_AT


def get_khoa_snapshot() -> tuple[dict[str, dict], Optional[float]]:
    """({obsCode: twRecent 최신레코드(+cadence_min_observed)}, 마지막 갱신 unix time) — 갱신 전이면 ({}, None)."""
    with _LOCK:
        return dict(_KHOA_SNAPSHOT), _KHOA_UPDATED_AT


# ── cadence(관측주기) 실측 — status.py 의 cadence 기반 판정에 쓰인다 ────────────────────────

def _median_gap_minutes(obs_times: list[str]) -> Optional[float]:
    """'YYYY-MM-DD HH:MM' 문자열 리스트(오래된→최신 무관)에서 연속 관측 간격의 중앙값(분).

    표본이 2개 미만이거나 전부 파싱 실패하면 None(호출부가 접두사 기본값으로 폴백)."""
    dts: list[datetime] = []
    for t in obs_times:
        try:
            dts.append(datetime.strptime(t, "%Y-%m-%d %H:%M"))
        except (TypeError, ValueError):
            continue
    dts.sort()
    gaps = [(b - a).total_seconds() / 60.0 for a, b in zip(dts, dts[1:])]
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return None
    gaps.sort()
    n = len(gaps)
    mid = n // 2
    return gaps[mid] if n % 2 else (gaps[mid - 1] + gaps[mid]) / 2.0


# ── 갱신 루프 ─────────────────────────────────────────────────────────────────

def _refresh_kma_once() -> None:
    global _KMA_UPDATED_AT
    try:
        obs = kma_marine.fetch_sea_obs()
    except Exception:
        obs = []
    if obs:
        with _LOCK:
            _KMA_SNAPSHOT[:] = obs
            _KMA_UPDATED_AT = time.time()


def _refresh_khoa_once(obs_codes: list[str]) -> None:
    """지점별 twRecent 를 burst 순회 — **롤링 시계열째로** 받아 최신레코드 + 실측 cadence 를
    동시에 얻는다(`fetch_tw_recent_series` 가 `fetch_tw_recent` 와 같은 네트워크 호출·캐시키를
    쓰므로 호출 1회로 둘 다 해결, 상태 판정용 별도 호출은 없다 — status.py §cadence 참고)."""
    global _KHOA_UPDATED_AT
    any_ok = False
    for code in obs_codes:
        try:
            series = khoa_api.fetch_tw_recent_series(code)
        except Exception:
            series = []
        if series:
            rec = dict(series[-1])  # 오래된→최신 정렬이므로 마지막이 최신(=fetch_tw_recent 와 동일)
            cadence = _median_gap_minutes([r.get("obsrvnDt") for r in series])
            if cadence is not None:
                rec["cadence_min_observed"] = round(cadence, 1)
            with _LOCK:
                _KHOA_SNAPSHOT[code] = rec
            any_ok = True
        # 실패한 지점은 이전 스냅샷 값을 유지(일시 오류로 마커가 갑자기 사라지지 않게).
    if any_ok:
        with _LOCK:
            _KHOA_UPDATED_AT = time.time()


def _kma_loop() -> None:
    while True:
        _refresh_kma_once()
        time.sleep(_KMA_REFRESH_SEC)


def _khoa_loop() -> None:
    while True:
        buoys = khoa_api.fetch_buoy_list()
        obs_codes = [b["id"] for b in buoys if b.get("id")]
        if not obs_codes:
            obs_codes = list(khoa_api.DEMO_KG_OBS_CODES)  # odcloud 목록 실패 시 최소한의 폴백
        _refresh_khoa_once(obs_codes)
        time.sleep(_KHOA_REFRESH_SEC)


def start_refresher() -> None:
    """FastAPI startup 시 1회 호출. 데몬 스레드 2개 시작(중복 시작 방지).

    각 루프는 시작 즉시 첫 갱신을 수행한 뒤 주기적으로 반복하므로, 첫 채움은 KMA 는 거의 즉시
    (API 1회 호출), KHOA 는 burst 소요시간(≈41 * 0.15s ≈ 6초) 후에 대부분 채워진다. 그 사이엔
    스냅샷이 비어 있을 수 있으나 `/api/health` 등은 스냅샷에 의존하지 않으므로 서버는 즉시 응답 가능.
    """
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_kma_loop, name="kma-live-refresh", daemon=True).start()
    threading.Thread(target=_khoa_loop, name="khoa-live-refresh", daemon=True).start()
