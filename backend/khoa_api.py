"""KHOA (국립해양조사원) 공공데이터포털 wrapper — **부이만** (조위관측소 서비스 미구현, 스코프 제외).

인증: `serviceKey`(인코딩 키를 코드에서 `urllib.parse.unquote` 1회 후 requests `params=` 전달).
공통: `type=json` 명시, `obsCode` 필수(지점별 순회), 개발계정 일 10,000건/서비스 한도.

⚠️ `www.khoa.go.kr/api/oceangrid/*` 는 이 서버 IP 차단(307→503) — 반드시 아래 호스트만 사용:
  - `apis.data.go.kr` (org 1192136): twRecent(부이 종합) · noonWave(심해부이 파랑)
  - `api.odcloud.kr` (파일데이터 자동API): 해양관측부이 41개소 운영현황 목록
"""
from __future__ import annotations

import re
import threading
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

import requests

from config import require_khoa_key

TW_RECENT_URL = "https://apis.data.go.kr/1192136/twRecent/GetTWRecentApiService"
NOON_WAVE_URL = "https://apis.data.go.kr/1192136/noonWave/GetNoonWaveApiService"
BUOY_LIST_URL = (
    "https://api.odcloud.kr/api/15146611/v1/uddi:8bd2eb44-1a6a-4089-9935-803551fa3322"
)

# ── oceangrid GIS 비공식 엔드포인트 (Wave 3a Fix 2/4) — 공식 오픈API(위 apis.data.go.kr)는 최신
# 롤링값만 주고 기간조회 파라미터가 없다. 과거 이력은 www.khoa.go.kr 의 GIS 웹 화면이 내부적으로
# 쓰는 이 비공식 AJAX/HTML 엔드포인트로 확보한다(인증 불요, `docs/oceangrid_probe.md` 실측 확인,
# 서버 IP 차단은 `/api/oceangrid/*` 공식 API 한정 — 이 `/oceangrid/gis|cmm/*` 경로는 정상 응답).
OCEANGRID_WAVE_URL = "https://www.khoa.go.kr/oceangrid/cmm/chart/tideObs/searchWaveHegiht.json"
OCEANGRID_AIR_URL = "https://www.khoa.go.kr/oceangrid/cmm/chart/tideObs/searchAirReal.json"
OCEANGRID_WTSL_URL = "https://www.khoa.go.kr/oceangrid/cmm/chart/tideObs/searchWtslReal.json"
OCEANGRID_WIND_URL = "https://www.khoa.go.kr/oceangrid/cmm/chart/tideObs/searchWindReal.json"
POINT_DETAIL_URL = "https://www.khoa.go.kr/oceangrid/gis/category/ob/pointDetail.do"
_OCEANGRID_UA = "Mozilla/5.0 (compatible; BuoyPlatform/1.0; +internal-research-demo)"

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
_TTL_OCEANGRID = 3600        # 1시간 — 비공식 day-loop, 과거 확정일자는 사실상 불변·당일도 30분 해상도라 충분
_TTL_POINT_DETAIL = 7 * 24 * 3600  # 7일 — 관측개시일 등 정적 메타(거의 불변)


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


# ── oceangrid GIS day-loop (부이 과거 시계열, 비공식) ────────────────────────────────────────
# 단일 호출은 `searchDate` 기준 전날~당일 약 2일 창(15~30분 간격)만 반환하고, `searchKey`/기간
# 파라미터로 창을 넓힐 수 없다(docs/oceangrid_probe.md §4.8 실측) — 장기 이력은 날짜를 이틀씩
# 건너뛰며 반복호출 후 obs_time 기준으로 병합하는 수밖에 없다.

def _ocean_num(v) -> Optional[float]:
    """oceangrid 응답값(문자열/숫자 혼재, 결측은 보통 빈 문자열/None) → float|None."""
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _oceangrid_post(url: str, obs_post_id: str, search_date: str) -> Optional[dict]:
    """oceangrid 비공식 GIS 차트 JSON POST(인증 불요, 세션/Referer 불필요 — docs/oceangrid_probe.md
    §6 실측 확인). HTTP!=200/JSON 파싱 실패는 캐시하지 않음(자가복구)."""
    cache_key = ("oceangrid", url, obs_post_id, search_date)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < _TTL_OCEANGRID:
            return hit[1]

    try:
        _throttle()
        resp = requests.post(
            url,
            data={
                "obs_post_id": obs_post_id,
                "searchDate": search_date,
                "searchKey": "day",
                "obsCheck": "TW",
            },
            headers={"User-Agent": _OCEANGRID_UA},
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
    except (requests.RequestException, ValueError):
        return None

    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.time(), data)
    return data


def _oceangrid_rows(data: Optional[dict], key: str) -> list[dict]:
    if not data:
        return []
    rows = data.get(key)
    return rows if isinstance(rows, list) else []


def fetch_oceangrid_day(obs_post_id: str, search_date: str) -> list[dict]:
    """관측소의 (전날~당일) 2일 창 병합 레코드: {t, wave, wave_period, wind_speed, wind_dir,
    water_temp, air_temp, pressure} — 파고/기온기압/수온/풍향풍속 4개 항목 엔드포인트를
    `obs_time` 기준으로 병합한다(조위/시정/염분은 부이엔 없어 미조회 — oceangrid_probe.md §4.6/4.7).
    search_date: "YYYYMMDD". 실패/데이터없음이면 빈 리스트."""
    merged: dict[str, dict] = {}

    def _put(t: Optional[str], **kv) -> None:
        if not t:
            return
        rec = merged.setdefault(t, {"t": t})
        for k, v in kv.items():
            if v is not None:
                rec[k] = v

    wave = _oceangrid_post(OCEANGRID_WAVE_URL, obs_post_id, search_date)
    for r in _oceangrid_rows(wave, "tideObsList_0"):
        _put(r.get("obs_time"), wave=_ocean_num(r.get("signifi_wave_height")))
    for r in _oceangrid_rows(wave, "tideObsList_1"):
        _put(r.get("obs_time"), wave_period=_ocean_num(r.get("signifi_wave_period")))

    air = _oceangrid_post(OCEANGRID_AIR_URL, obs_post_id, search_date)
    for r in _oceangrid_rows(air, "tideObsList_0"):
        _put(r.get("obs_time"), pressure=_ocean_num(r.get("obs_value")))
    for r in _oceangrid_rows(air, "tideObsList_1"):
        _put(r.get("obs_time"), air_temp=_ocean_num(r.get("obs_value")))

    wtsl = _oceangrid_post(OCEANGRID_WTSL_URL, obs_post_id, search_date)
    for r in _oceangrid_rows(wtsl, "tideObsList_0"):
        _put(r.get("obs_time"), water_temp=_ocean_num(r.get("obs_value")))

    wind = _oceangrid_post(OCEANGRID_WIND_URL, obs_post_id, search_date)
    wind_rows = (wind or {}).get("tideObsList")
    if isinstance(wind_rows, list):
        for r in wind_rows:
            _put(
                r.get("obs_time"),
                wind_speed=_ocean_num(r.get("obs_wspeed")),
                wind_dir=_ocean_num(r.get("obs_wdir")),
            )

    return sorted(merged.values(), key=lambda r: r["t"])


def fetch_oceangrid_range(obs_post_id: str, start_date: date, end_date: date) -> list[dict]:
    """start_date~end_date(KST 기준 날짜) 사이를 2일 간격 day-loop 로 순회해 조립한 병합 시계열.
    호출부(timeseries.py)가 범위를 ~30일로 캡핑해 호출량을 관리한다(응답성 확보, Fix 2)."""
    merged: dict[str, dict] = {}
    d = start_date
    step = timedelta(days=2)
    while d <= end_date:
        for rec in fetch_oceangrid_day(obs_post_id, d.strftime("%Y%m%d")):
            merged[rec["t"]] = rec
        d += step
    # 마지막 창이 end_date 를 건너뛸 수 있어(2일 스텝) 보정 호출로 확실히 포함시킴.
    if d - step < end_date:
        for rec in fetch_oceangrid_day(obs_post_id, end_date.strftime("%Y%m%d")):
            merged[rec["t"]] = rec
    return sorted(merged.values(), key=lambda r: r["t"])


# ── pointDetail.do (관측소 정적 메타 — 관측개시일 등, Wave 3a Fix 4) ─────────────────────────
_POINT_DETAIL_PATTERNS = {
    "obs_start_date": re.compile(r'id="obsStartDate"[^>]*>\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*<'),
    "address": re.compile(r'관측소\s*주소</span><span class="spst02">([^<]+)<'),
    "obs_type": re.compile(r'관측유형</span><span class="spst02">([^<]+)<'),
}


def fetch_station_detail(obs_code: str) -> dict:
    """oceangrid GIS 비공식 pointDetail.do HTML 프래그먼트에서 관측개시일 등 정적 메타 파싱
    (docs/oceangrid_probe.md §2, 2026-07-15 실측: KG_0024 obsStartDate='2012-09-06' 확인).
    실패(네트워크/파싱)는 캐시하지 않고 전부 None 반환(지어낸 값 없음) — 다음 호출에서 재시도."""
    cache_key = ("point_detail", obs_code)
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < _TTL_POINT_DETAIL:
            return hit[1]

    try:
        _throttle()
        resp = requests.post(
            POINT_DETAIL_URL,
            data={"obsCheck": "TW", "id": obs_code, "gridId": ""},
            headers={"User-Agent": _OCEANGRID_UA},
            timeout=_TIMEOUT,
        )
    except requests.RequestException:
        return {k: None for k in _POINT_DETAIL_PATTERNS}
    if resp.status_code != 200:
        return {k: None for k in _POINT_DETAIL_PATTERNS}

    html = resp.text
    result: dict = {}
    for key, pattern in _POINT_DETAIL_PATTERNS.items():
        m = pattern.search(html)
        result[key] = m.group(1).strip() if m else None

    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.time(), result)
    return result


# ── 데모 초기 표출 대상: 국가해양관측망 심해부이 6개소(파랑 품질 최적) ────────
DEMO_KG_OBS_CODES = ["KG_0021", "KG_0024", "KG_0025", "KG_0028", "KG_0101", "KG_0102"]
