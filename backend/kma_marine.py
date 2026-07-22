"""KMA (기상청) API Hub 해양관측 wrapper.

Base: https://apihub.kma.go.kr/api/typ01/url (실시간) · .../api/typ02/openApi/SeaMtlyInfoService (지점 제원)
인증: `authKey` 파라미터(평문, .env KMA_APIHUB_KEY). 응답 인코딩 EUC-KR(CP949). 결측 `-99`/`-99.0`. 시각 KST.

Endpoints used:
  - sea_obs.php   : 해양 종합 관측(위경도+실시간값, 지도 시딩/스냅샷). TP=B(해양기상부이)/C(파고부이)/기타.
  - kma_buoy2.php : 부이 상세, 기간조회(tm1~tm2) → 시계열(응답의 AQC/MQC 컬럼은 기관 내부 상태코드일
    뿐 이상치 플래그가 아니라 파싱하지 않음 — timeseries.py 모듈독스트링 참고).
  - typ02 openApi SeaMtlyInfoService/{getBuoyLstTbl,getWaveBuoyLstTbl,getLhawsLstTbl} : 지점 제원(형식·센서고·영문명).
"""
from __future__ import annotations

import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from config import require_kma_key

KMA_BASE_URL = "https://apihub.kma.go.kr/api/typ01/url"
KMA_LIST_BASE = "https://apihub.kma.go.kr/api/typ02/openApi/SeaMtlyInfoService"
_TIMEOUT = 15

MISSING = -99  # KMA 결측 코드(정수/실수 공통, float 비교는 근사)

# TP 코드 → 한글 라벨 (전체 관측망; 이 플랫폼은 B/C만 표출하지만 sea_obs 는 전체를 반환)
TP_LABEL = {
    "B": "해양기상부이",
    "C": "파고부이",
    "D": "표류부이",
    "L": "등표(AWS)",
    "N": "관측타워/파고AWS",
    "F": "해양관측장비",
    "J": "서해종합기지",
}

# ── 지점 제원 목록 API: op → (nested key, 지점수) ──────────────────────────
LIST_OPS = {
    "getBuoyLstTbl": "stn_buoy",
    "getWaveBuoyLstTbl": "stn_waveBoy",  # KMA 응답 실제 키는 stn_waveBoy 로 나올 수 있어 파서에서 관대하게 탐색
    "getLhawsLstTbl": "stn_lhaws",
}

# ── 인메모리 캐시 + 호출 간격 throttle ─────────
_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_LAST_CALL = [0.0]
_MIN_INTERVAL = 0.34  # 초당 ~3회 이하로 실제 네트워크 호출 제한

_TTL_SEA_OBS = 240        # 4분 — 10분 격자 관측치, 폴링 주기보다 짧게
_TTL_BUOY_SERIES = 300    # 5분 — 기간조회(시계열)
_TTL_LIST_TABLE = 24 * 3600  # 지점 제원은 거의 불변


def _throttled_get(url: str, params: dict) -> requests.Response:
    now = time.time()
    with _CACHE_LOCK:
        slot = max(_LAST_CALL[0] + _MIN_INTERVAL, now)
        _LAST_CALL[0] = slot
    wait = slot - time.time()
    if wait > 0:
        time.sleep(wait)
    return requests.get(url, params=params, timeout=_TIMEOUT)


def _get_raw_cp949(endpoint: str, params: dict, ttl: int) -> str:
    """typ01/url/*.php 호출 → cp949 디코드된 텍스트. 유효 데이터 있을 때만 캐시."""
    key = (endpoint, tuple(sorted((k, str(v)) for k, v in params.items())))
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < ttl:
            return hit[1]

    full = {**params, "authKey": require_kma_key()}
    resp = _throttled_get(f"{KMA_BASE_URL}/{endpoint}", full)
    resp.encoding = "cp949"
    txt = resp.text

    has_data = any(
        l.strip() and not l.strip().startswith("#") and l.strip() not in ("9999", "9999END")
        for l in txt.splitlines()
    )
    if has_data:
        with _CACHE_LOCK:
            _CACHE[key] = (time.time(), txt)
    return txt


def _get_list_table_json(op: str, year: int, month: int) -> Optional[dict]:
    key = ("list", op, year, month)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _TTL_LIST_TABLE:
            return hit[1]

    params = {
        "authKey": require_kma_key(),
        "pageNo": 1,
        "numOfRows": 1,
        "dataType": "JSON",
        "year": year,
        "month": month,
    }
    try:
        resp = _throttled_get(f"{KMA_LIST_BASE}/{op}", params)
        data = resp.json()
    except Exception:
        return None

    result_code = data.get("response", {}).get("header", {}).get("resultCode")
    if result_code != "00":
        return None
    with _CACHE_LOCK:
        _CACHE[key] = (time.time(), data)
    return data


# ── KST 시각 헬퍼 ────────────────────────────────────────────────────────────

def now_kst() -> datetime:
    """서버 로컬 타임존에 의존하지 않고 UTC+9 로 KST naive datetime 계산."""
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=9)


def _floor_10min(dt: datetime) -> datetime:
    return dt.replace(minute=(dt.minute // 10) * 10, second=0, microsecond=0)


# ── 숫자 파싱 (-99 → None) ──────────────────────────────────────────────────

def _num(s: str):
    s = (s or "").strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    if abs(v - MISSING) < 1e-6 or v <= -99.0:
        return None
    return v


def _num_int(s: str):
    v = _num(s)
    return int(v) if v is not None else None


# ── sea_obs.php ──────────────────────────────────────────────────────────────

def _parse_sea_obs(raw: str) -> list[dict]:
    """sea_obs.php 콤마 CSV 파싱.

    실측 컬럼 순서(reference/sea_obs_full.txt 헤더 주석 기준):
      TP, TM, STN_ID, STN_KO, LON, LAT, WH, WD, WS, WS_GST, TW, TA, PA, HM, [QC], =
    """
    out: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 14:
            continue
        tp = parts[0]
        if tp not in TP_LABEL:
            continue
        try:
            tm = parts[1]
            stn_id = parts[2]
            stn_ko = parts[3].strip()
            lon = float(parts[4])
            lat = float(parts[5])
        except (ValueError, IndexError):
            continue

        qc = parts[14] if len(parts) > 14 else ""
        qc = qc.strip().rstrip("=").strip()

        out.append({
            "source": "KMA",
            "tp": tp,
            "tp_label": TP_LABEL.get(tp, tp),
            "stn_id": stn_id,
            "id": f"KMA_{stn_id}",
            "name": stn_ko,
            "tm": tm,  # YYYYMMDDHHMI (KST)
            "lon": lon,
            "lat": lat,
            "wh": _num(parts[6]),
            "wd": _num_int(parts[7]),
            "ws": _num(parts[8]),
            "ws_gst": _num(parts[9]),
            "tw": _num(parts[10]),
            "ta": _num(parts[11]),
            "pa": _num(parts[12]),
            "hm": _num(parts[13]),
            "qc": qc or None,
        })
    return out


def fetch_sea_obs(tm: Optional[str] = None) -> list[dict]:
    """해양 종합 관측(지도 시딩/스냅샷). tm=None 이면 최근 유효 10분 슬롯을 최대 ~6회 소급 탐색."""
    if tm is not None:
        raw = _get_raw_cp949("sea_obs.php", {"tm": tm, "stn": 0}, _TTL_SEA_OBS)
        return _parse_sea_obs(raw)

    base = _floor_10min(now_kst()) - timedelta(minutes=10)
    for step in range(0, 7):  # base, -10, -20, ... -60분 (최대 7슬롯)
        candidate = base - timedelta(minutes=10 * step)
        tm_str = candidate.strftime("%Y%m%d%H%M")
        raw = _get_raw_cp949("sea_obs.php", {"tm": tm_str, "stn": 0}, _TTL_SEA_OBS)
        parsed = _parse_sea_obs(raw)
        if parsed:
            return parsed
    return []


# ── kma_buoy2.php (기간조회 → 시계열) ─────────────────────────────────────────
# 컬럼(19): TM,STN,WD1,WS1,WS1_GST,WD2,WS2,WS2_GST,PA,HM,TA,TW,WH_MAX,WH_SIG,WH_AVE,WP,WO,AQC,MQC
# (AQC/MQC 는 파싱하지 않음 — 위 _parse_buoy2 주석 참고)

_BUOY2_FIELDS = [
    "tm", "stn", "wd1", "ws1", "ws1_gst", "wd2", "ws2", "ws2_gst",
    "pa", "hm", "ta", "tw", "wh_max", "wh_sig", "wh_ave", "wp", "wo",
]


def _parse_buoy2(raw: str) -> list[dict]:
    out: list[dict] = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        # 마지막 '=' 트레일러 제거
        if parts and parts[-1] == "=":
            parts = parts[:-1]
        if len(parts) < len(_BUOY2_FIELDS):
            continue
        rec: dict = {"source": "KMA"}
        for i, field in enumerate(_BUOY2_FIELDS):
            val = parts[i]
            if field in ("tm", "stn"):
                rec[field] = val
            elif field in ("wd1", "wd2", "wo"):
                rec[field] = _num_int(val)
            else:
                rec[field] = _num(val)
        # AQC/MQC(있으면, 컬럼 19 이후) — 기관 내부 검사 상태코드일 뿐 이상치 플래그가 아님이
        # 실측 확인되어(자리→변수 매핑도 비공개) 더 이상 파싱하지 않는다(2026-07-22 제거).
        out.append(rec)
    return out


def fetch_buoy_series(stn: str, tm1: str, tm2: str) -> list[dict]:
    """부이 상세 기간조회 → 시간순 레코드 리스트."""
    raw = _get_raw_cp949(
        "kma_buoy2.php", {"tm1": tm1, "tm2": tm2, "stn": stn}, _TTL_BUOY_SERIES
    )
    records = _parse_buoy2(raw)
    records.sort(key=lambda r: r.get("tm") or "")
    return records


# ── typ02 openApi 지점 제원(형식/센서고/영문명) ──────────────────────────────

def _find_info_list(data: dict) -> list[dict]:
    """item[0] 아래 정확한 nested key 를 몰라도(예: stn_waveBoy vs stn_waveBuoy) 관대하게 탐색."""
    try:
        items = data["response"]["body"]["items"]["item"]
    except (KeyError, TypeError):
        return []
    if isinstance(items, dict):
        items = [items]
    for item in items:
        if not isinstance(item, dict):
            continue
        for v in item.values():
            if isinstance(v, dict) and isinstance(v.get("info"), list):
                return v["info"]
    return []


def fetch_list_table(op: str, year: int, month: int) -> list[dict]:
    """지점 제원 목록(한/영명·형식·센서고). op ∈ getBuoyLstTbl/getWaveBuoyLstTbl/getLhawsLstTbl."""
    data = _get_list_table_json(op, year, month)
    if not data:
        return []
    return _find_info_list(data)


# ── typ02 openApi 일별 통계(getDailyWaveBuoy) — 파고부이(C) 과거 이력 대체경로 ──────────────
# (Wave 3a Fix 2) kma_buoy2.php 는 C타입(파고부이)을 지원하지 않는다(실측, docs/historical_data_probe.md
# §1-3 · docs/apihub_catalog_probe.md §B). 같은 authKey 로 이미 활성화된 getDailyWaveBuoy
# (station+year+month, 일별 유의파고/최대파고/파주기/평균수온)가 유일한 공식 대체경로 — 신규 신청 불필요.

def _get_daily_json(op: str, year: int, month: int, station: str) -> Optional[dict]:
    """일별 통계(getDailyBuoy/getDailyWaveBuoy 등) JSON 캐시 조회. station 파라미터 필수(전지점 일괄 불가).
    미발간 월(`resultCode != 00`, 예: "발간되지 않은 기간입니다")은 캐시하지 않고 None."""
    key = ("daily", op, year, month, station)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < _TTL_LIST_TABLE:
            return hit[1]

    params = {
        "authKey": require_kma_key(),
        "pageNo": 1,
        "numOfRows": 40,  # 한 달 최대 31일 + 상순/중순/하순/월 요약 4행 여유
        "dataType": "JSON",
        "year": year,
        "month": month,
        "station": station,
    }
    try:
        resp = _throttled_get(f"{KMA_LIST_BASE}/{op}", params)
        data = resp.json()
    except Exception:
        return None

    result_code = data.get("response", {}).get("header", {}).get("resultCode")
    if result_code != "00":
        return None
    with _CACHE_LOCK:
        _CACHE[key] = (time.time(), data)
    return data


def fetch_daily_wave_buoy(station: str, year: int, month: int) -> list[dict]:
    """파고부이(C) 일별 통계(getDailyWaveBuoy) — kma_buoy2.php 가 지원 안 하는 C타입 과거 이력의
    유일한 확인된 공식 경로(docs/apihub_catalog_probe.md §B, 2026-07-15 실측 확인).

    반환 행에는 일자별 실측(`tm`=일자 "01".."31") 뿐 아니라 상순/중순/하순/월 요약행도 섞여 있다 —
    호출부(timeseries.py)가 `tm.isdigit()` 로 일자별 행만 골라 쓴다. 미발간 월(발간지연 ~1.5개월,
    관측 시작월 이전)은 빈 리스트."""
    data = _get_daily_json("getDailyWaveBuoy", year, month, station)
    if not data:
        return []
    return _find_info_list(data)
