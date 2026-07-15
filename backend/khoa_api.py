"""KHOA (국립해양조사원) 공공데이터포털 wrapper — **부이만** (조위관측소 서비스 미구현, 스코프 제외).

인증: `serviceKey`(인코딩 키를 코드에서 `urllib.parse.unquote` 1회 후 requests `params=` 전달).
공통: `type=json` 명시, `obsCode` 필수(지점별 순회), 개발계정 일 10,000건/서비스 한도.

⚠️ `www.khoa.go.kr/api/oceangrid/*` 는 이 서버 IP 차단(307→503) — 반드시 아래 호스트만 사용:
  - `apis.data.go.kr` (org 1192136): twRecent(부이 종합) · noonWave(심해부이 파랑)
  - `api.odcloud.kr` (파일데이터 자동API): 해양관측부이 41개소 운영현황 목록
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Optional

import requests

from config import require_khoa_key

TW_RECENT_URL = "https://apis.data.go.kr/1192136/twRecent/GetTWRecentApiService"
NOON_WAVE_URL = "https://apis.data.go.kr/1192136/noonWave/GetNoonWaveApiService"
BUOY_LIST_URL = (
    "https://api.odcloud.kr/api/15146611/v1/uddi:8bd2eb44-1a6a-4089-9935-803551fa3322"
)

_TIMEOUT = 15
_REF_FILE = Path(__file__).resolve().parent.parent / "docs" / "reference" / "khoa_stations.txt"

# ── 인메모리 캐시 + throttle ─────────────────────────────────────────────────
_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_LAST_CALL = [0.0]
_MIN_INTERVAL = 0.15  # 일 10,000건 한도 보호 — 버스트 호출 방지

_TTL_TW_RECENT = 60          # 1분 — twRecent 는 1~수분 간격 갱신
_TTL_NOON_WAVE = 300         # 5분 — noonWave 는 30분 간격 자료
_TTL_BUOY_LIST = 12 * 3600   # 지점 목록은 거의 불변


def _throttle():
    with _CACHE_LOCK:
        slot = max(_LAST_CALL[0] + _MIN_INTERVAL, time.time())
        _LAST_CALL[0] = slot
    wait = slot - time.time()
    if wait > 0:
        time.sleep(wait)


def _cached_get(cache_key: tuple, url: str, params: dict, ttl: int) -> Optional[dict]:
    """공통 GET+캐시. resultCode!=00 / JSON 파싱 실패 / 비정상 응답은 캐시하지 않음(자가복구)."""
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < ttl:
            return hit[1]

    try:
        _throttle()
        resp = requests.get(url, params=params, timeout=_TIMEOUT)
        if resp.status_code != 200:
            return None
        data = resp.json()  # KHOA 오류 시 XML 을 줄 수도 있음 → 예외로 방어
    except (requests.RequestException, ValueError):
        return None

    header = data.get("header") or data.get("response", {}).get("header", {})
    result_code = header.get("resultCode")
    if result_code not in ("00", None):  # dtRecent 류는 header 없이 바로 body 인 케이스 방어
        return None

    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.time(), data)
    return data


# ── 지점 목록 (api.odcloud.kr) ───────────────────────────────────────────────

_ODCLOUD_FIELD_MAP = {
    "고유번호": "obsCode",
    "명": "name",
    "영문명": "name_en",
    "유형": "type",
    "위도": "lat",
    "경도": "lon",
}


def _map_odcloud_row(row: dict) -> Optional[dict]:
    """odcloud 응답 키는 '해양관측부이 고유번호' 처럼 '<목록명> <필드>' 형태 — 마지막 공백 토큰(정확히
    일치)으로 매핑. '명'/'영문명' 처럼 한쪽이 다른쪽의 접미(suffix)인 경우가 있어 endswith 는 오매칭됨."""
    out: dict = {"source": "KHOA"}
    for k, v in row.items():
        token = k.rsplit(" ", 1)[-1]
        std_key = _ODCLOUD_FIELD_MAP.get(token)
        if std_key:
            out[std_key] = v
    if "obsCode" not in out:
        return None
    try:
        out["lat"] = float(out["lat"]) if out.get("lat") not in (None, "") else None
        out["lon"] = float(out["lon"]) if out.get("lon") not in (None, "") else None
    except (TypeError, ValueError):
        out["lat"] = out.get("lat")
        out["lon"] = out.get("lon")
    out["id"] = out["obsCode"]
    return out


def _fallback_buoy_list_from_reference() -> list[dict]:
    """odcloud 호출 실패 시 docs/reference/khoa_stations.txt 의 [해양관측부이 운영현황] 블록을 시딩."""
    if not _REF_FILE.exists():
        return []
    lines = _REF_FILE.read_text(encoding="utf-8").splitlines()
    out: list[dict] = []
    in_section = False
    for line in lines:
        if "[해양관측부이 운영현황]" in line:
            in_section = True
            continue
        if in_section and line.startswith("["):
            break
        if not in_section:
            continue
        parts = line.split("\t")
        if len(parts) != 6 or parts[0] == "코드":
            continue
        code, name, name_en, typ, lat, lon = parts
        try:
            out.append({
                "source": "KHOA",
                "id": code,
                "obsCode": code,
                "name": name,
                "name_en": name_en,
                "type": typ,
                "lat": float(lat),
                "lon": float(lon),
            })
        except ValueError:
            continue
    return out


def fetch_buoy_list() -> list[dict]:
    """해양관측부이 41개소 운영현황(고유번호·명·영문명·유형·위경도)."""
    cache_key = ("buoy_list",)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < _TTL_BUOY_LIST:
            return hit[1]

    try:
        _throttle()
        params = {"page": 1, "perPage": 100, "serviceKey": require_khoa_key()}
        resp = requests.get(BUOY_LIST_URL, params=params, timeout=_TIMEOUT)
        data = resp.json() if resp.status_code == 200 else None
    except (requests.RequestException, ValueError):
        data = None

    rows = (data or {}).get("data") if isinstance(data, dict) else None
    if not rows:
        result = _fallback_buoy_list_from_reference()
    else:
        result = [r for r in (_map_odcloud_row(row) for row in rows) if r]
        if not result:
            result = _fallback_buoy_list_from_reference()

    if result:
        with _CACHE_LOCK:
            _CACHE[cache_key] = (time.time(), result)
    return result


# ── twRecent (부이 최신 종합) ─────────────────────────────────────────────────

_TW_FIELD_KEYS = [
    "wndrct", "wspd", "maxMmntWspd", "artmp", "atmpr", "wvhgt", "wvpd",
    "crdir", "crsp", "wtem", "slnty", "obsrvnDt", "obsvtrNm", "lat", "lot",
]


def fetch_tw_recent(obs_code: str) -> Optional[dict]:
    """부이 최신 종합 관측 1건(가장 최근 obsrvnDt). 실패/결측 시 None."""
    params = {"serviceKey": require_khoa_key(), "obsCode": obs_code, "type": "json"}
    data = _cached_get(("tw_recent", obs_code), TW_RECENT_URL, params, _TTL_TW_RECENT)
    if not data:
        return None
    try:
        items = data["body"]["items"]["item"]
    except (KeyError, TypeError):
        return None
    if isinstance(items, dict):
        items = [items]
    if not items:
        return None
    latest = items[0]  # KHOA twRecent 는 최신순(obsrvnDt 내림차순) 정렬로 응답

    out: dict = {"source": "KHOA", "obsCode": obs_code, "id": obs_code}
    for key in _TW_FIELD_KEYS:
        val = latest.get(key)
        out[key] = val
    return out


def fetch_tw_recent_series(obs_code: str) -> list[dict]:
    """부이 최근 롤링 시계열(twRecent 응답 전체 — 관측 실측상 최대 10건).

    간격은 지점별로 다름(TW_* 연안부이 ~5분, KG_* 심해부이 ~30분 실측 확인) — 요청 파라미터로
    범위를 넓힐 수 없는 "최근 N건 롤링" 서비스이므로, 이 함수는 그 롤링 윈도우 전체를 오래된→최신
    순으로 반환한다. 과거 이력이 더 필요하면 docs/oceangrid_probe.md 의 비공식 백필 경로를 쓴다.
    실패/결측 시 빈 리스트.
    """
    params = {"serviceKey": require_khoa_key(), "obsCode": obs_code, "type": "json"}
    data = _cached_get(("tw_recent", obs_code), TW_RECENT_URL, params, _TTL_TW_RECENT)
    if not data:
        return []
    try:
        items = data["body"]["items"]["item"]
    except (KeyError, TypeError):
        return []
    if isinstance(items, dict):
        items = [items]

    out: list[dict] = []
    for item in items:
        rec: dict = {"source": "KHOA", "obsCode": obs_code, "id": obs_code}
        for key in _TW_FIELD_KEYS:
            rec[key] = item.get(key)
        out.append(rec)
    out.sort(key=lambda r: r.get("obsrvnDt") or "")
    return out


# ── noonWave (국가해양관측망 파랑, KG_ 심해부이 품질 최적) ────────────────────

_NOON_WAVE_FIELD_KEYS = ["wvhgt", "wvpd", "wvdrct", "maxWvhgt", "maxWvpd", "obsrvnDt", "obsvtrNm", "lat", "lot"]


def fetch_noon_wave(obs_code: str) -> list[dict]:
    """당일 30분 간격 파랑 관측 시계열(KG_ 심해부이). 실패 시 빈 리스트."""
    params = {"serviceKey": require_khoa_key(), "obsCode": obs_code, "type": "json"}
    data = _cached_get(("noon_wave", obs_code), NOON_WAVE_URL, params, _TTL_NOON_WAVE)
    if not data:
        return []
    try:
        items = data["body"]["items"]["item"]
    except (KeyError, TypeError):
        return []
    if isinstance(items, dict):
        items = [items]

    out: list[dict] = []
    for item in items:
        rec = {"source": "KHOA", "obsCode": obs_code, "id": obs_code}
        for key in _NOON_WAVE_FIELD_KEYS:
            rec[key] = item.get(key)
        out.append(rec)
    out.sort(key=lambda r: r.get("obsrvnDt") or "")
    return out


# ── 데모 초기 표출 대상: 국가해양관측망 심해부이 6개소(파랑 품질 최적) ────────
DEMO_KG_OBS_CODES = ["KG_0021", "KG_0024", "KG_0025", "KG_0028", "KG_0101", "KG_0102"]
