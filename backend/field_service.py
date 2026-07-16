"""2D 필드 오버레이(바람·표층수온) — **현재 KST 1시간 프레임만** 서빙한다.

## 설계 원칙(요구사항 그대로)

- **타임라인/애니메이션 없음**: 과거·미래 프레임을 쌓지 않는다. 항상 "지금 이 시각" 한 장뿐이다.
- **무키 공개 데이터**: NOAA AWS Open Data(바람=GFS 0.25°, 수온=OISST v2.1) — API 키 불필요.
  `khoa_api.py`/`kma_marine.py` 처럼 `.env` 시크릿에 의존하지 않는다.
- **사전 워밍으로 즉시 표출**: 백그라운드 스레드가 매시 정각+5분마다 새 프레임을 받아 인메모리
  페이로드를 통째로 스왑한다(`_swap_payload`) — `/api/field` 요청은 이미 채워진 메모리를 읽기만
  해서 응답하고, 그 순간 외부 API 를 부르거나 GRIB/NetCDF 를 파싱하지 않는다(요청측 계산 0).
- **이전 시점 삭제**: 디스크 캐시(`data/cache/field/field_{YYYYMMDDHH}.json`, KST 파일명)는
  항상 "현재 프레임 1개"만 남긴다 — 새 프레임을 쓰면 그 즉시 이전 파일을 지운다(`_prune_old_cache_files`).
  타임라인 기능이 없으므로 과거 프레임을 보존할 이유가 없다(Storm `gfs_wide.py` 의 영구보존
  `.npz` 아카이브와 정반대 방향 — 여긴 "최신 1장만" 이 계약이다).
- **부팅 즉시 서빙**: 재시작 직후에도 디스크에 신선한(75분 미만) 캐시가 있으면 그걸 그대로
  메모리에 올려 즉시 `ready:true` 로 응답한다. 없으면 배경 스레드가 첫 수집을 마칠 때까지
  `/api/field` 는 `{"ready": false}` 를 반환한다(프론트는 이 플래그로 로딩 상태를 표시).

## 데이터 소스 (기술은 Storm `gfs_wide.py` 의 .idx 사이드카 + HTTP Range + eccodes 인메모리 파싱을
그대로 이식하되, 이 플랫폼은 프레임이 1장뿐이라 LRU/디스크 영구아카이브 등은 전부 걷어냈다)

1. **바람(GFS 0.25°, UGRD/VGRD @10m)**: AWS Open Data 버킷의 `.idx` 로 바이트 범위를 찾아 딱
   그 두 메시지만 Range 요청 → eccodes 로 메모리에서 직접 디코드(임시파일 없음, ~0.1초/필드).
   최신 사이클부터 시도하고, 아직 안 올라온 사이클(404)은 자동으로 더 오래된 사이클로 폴백한다.
   AWS 버킷 자체가 안 되면(네트워크 장애) NOMADS filter CGI(같은 원본 파일을 다른 서버가
   한반도 창으로 미리 잘라 제공 — 응답이 이미 작아 임시파일 1개로 간단히 파싱)로 재시도한다.
2. **수온 — PRIMARY = GFS `TMP:surface` (LAND:surface 로 육지 마스킹)**: 바람과 **같은
   사이클/예보시간**(ctx 재사용)에서 표층기온 메시지를 추가로 Range 요청 → K→°C 변환,
   육지(LAND>=0.5)는 null. 위성(OISST)과 달리 **발행 지연이 0**이고 바람과 **valid 시각이
   정확히 같다** — "지금 이 순간" 일관성이 이 플랫폼의 핵심 요구라 실측 위성보다 이쪽을
   기본으로 삼는다(GFS NSST/RTG_SST_HR 해양표층 동화값이라 위성 관측을 이미 반영한 분석치).
   **FALLBACK = OISST v2.1 위성 일별 분석**(GFS 표층장 수집 자체가 실패했을 때만): AWS 버킷의
   넷CDF 전체(~1.5MB)를 메모리로 받아 한반도 창만 자른다. `_preliminary`(근실시간 잠정판)를
   먼저 시도한 뒤 확정판을 시도하고, 발행 지연(통상 D-2)을 감안해 D-1 부터 D-5 까지 순차
   후퇴한다. 폴백 모드에서는 하루 1회만 다시 받고(날짜가 바뀔 때·이전 시도 실패 시) 매시
   재다운로드하지 않는다(GFS 1차가 매시 정상 복구되면 이 캐시는 더 이상 쓰이지 않는다).

## 프레임 계약(EXACT — 프론트가 이 스키마에 맞춰 만들어짐)

    {"ready": true,
     "wind": {"valid_kst","source","bounds":[lon_min,lat_min,lon_max,lat_max],
              "rows","cols","u":[[...]],"v":[[...]]},
     "sst":  {"valid_kst","source","bounds":[...],"rows","cols","data":[[...null=육지...]]}}

행 0 = 최남단(24°N), 열 0 = 최서단(115°E), row-major, 값은 소수 2자리 반올림(°C, m/s).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import numpy as np

# ── 한반도 표출 창(요구사항 고정값) ────────────────────────────────────────────────
LON_MIN, LON_MAX = 115.0, 142.0
LAT_MIN, LAT_MAX = 24.0, 46.0

# data/cache/ 는 다른 캐시(chat_logs 등)와 같은 부모 아래 — 여긴 "최신 1장만" 보존(위 독스트링).
CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "cache" / "field"

_AWS_GFS_BASE = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"
_NOMADS_FILTER_URL = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
_AWS_OISST_BASE = "https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr"

# GRIB .idx 매칭 문자열 → 내부 라벨. AWS(.idx Range)·NOMADS(filter CGI) 양쪽 파서가 같은 라벨
# 체계를 쓰게 해서(U/V, TMP/LAND) 이후 조립 코드가 소스에 무관하게 동일해진다.
_WIND_VAR_MAP = {"UGRD:10 m above ground:": "U", "VGRD:10 m above ground:": "V"}
_WIND_NOMADS_QUERY = "var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on"
_WIND_NOMADS_SHORTNAME_MAP = {"10u": "U", "10v": "V"}

# 수온 PRIMARY(GFS TMP:surface + LAND:surface 마스크) — 바람과 같은 GRIB/사이클을 재사용해
# 표층기온·육지마스크만 추가로 받는다(발행지연 0, 바람과 valid 시각이 정확히 같다).
_SST_PRIMARY_VAR_MAP = {"TMP:surface:": "TMP", "LAND:surface:": "LAND"}
_SST_PRIMARY_NOMADS_QUERY = "var_TMP=on&var_LAND=on&lev_surface=on"
_SST_PRIMARY_NOMADS_SHORTNAME_MAP = {"t": "TMP", "lsm": "LAND"}

_CYCLE_HOURS = (18, 12, 6, 0)   # GFS 사이클(UTC), 최신 우선 탐색용


def _log(msg: str) -> None:
    print(f"[field] {msg}", file=sys.stderr)


# ─────────────────────────────────────────────────────────────────────────
# HTTP 헬퍼 (Storm gfs_wide.py 이식 — 4xx 는 즉시 전파, 네트워크/5xx 만 재시도)
# ─────────────────────────────────────────────────────────────────────────
def _http_get(req: "urllib.request.Request | str", timeout: float, attempts: int = 3) -> bytes:
    last: Optional[Exception] = None
    for i in range(attempts):
        try:
            return urllib.request.urlopen(req, timeout=timeout).read()
        except urllib.error.HTTPError as e:
            if e.code is not None and 400 <= e.code < 500:
                raise
            last = e
        except Exception as e:
            last = e
        if i < attempts - 1:
            time.sleep(0.5 * (2 ** i))
    raise last  # type: ignore[misc]


def _fetch_range(url: str, start: int, end: int, timeout: float = 30.0) -> bytes:
    req = urllib.request.Request(url, headers={"Range": f"bytes={start}-{end}"})
    return _http_get(req, timeout)


# ─────────────────────────────────────────────────────────────────────────
# GFS 사이클/예보시간 선택 — 목표=현재 UTC 정시. 최신 사이클부터 오름차순 fhr 로 시도.
# ─────────────────────────────────────────────────────────────────────────
def _pick_candidates(now_utc: datetime) -> list[tuple[datetime, int]]:
    """오늘 18/12/06/00Z → 어제 18/12/06/00Z 순으로 후보를 만들고, fhr(=목표-사이클, 시간)
    오름차순(가장 신선한 사이클 우선)으로 정렬해 반환한다. 0<=fhr<=16 만 채택 — 그보다 오래된
    사이클을 "현재" 프레임에 쓰면 최신성이 너무 떨어진다(발행 지연 ~4h 를 감안해도 16h 면
    이틀치 후보를 커버해 항상 하나는 걸린다)."""
    target = now_utc.replace(minute=0, second=0, microsecond=0)
    out: list[tuple[datetime, int]] = []
    for day_offset in (0, 1):
        day0 = (target - timedelta(days=day_offset)).replace(hour=0)
        for h in _CYCLE_HOURS:
            cycle_dt = day0.replace(hour=h)
            if cycle_dt > target:
                continue
            fhr = int((target - cycle_dt).total_seconds() // 3600)
            if 0 <= fhr <= 16:
                out.append((cycle_dt, fhr))
    out.sort(key=lambda c: c[1])
    return out


def _aws_grib_url(cycle_dt: datetime, fhr: int) -> str:
    cc = f"{cycle_dt.hour:02d}"
    return (f"{_AWS_GFS_BASE}/gfs.{cycle_dt:%Y%m%d}/{cc}/atmos/"
            f"gfs.t{cc}z.pgrb2.0p25.f{fhr:03d}")


# ─────────────────────────────────────────────────────────────────────────
# idx 파싱 + GRIB 메시지 디코드 (eccodes, 메모리 직접 파싱 — gfs_wide.py 와 동일 기법)
# ─────────────────────────────────────────────────────────────────────────
def _idx_ranges(idx_text: str, wanted: tuple[str, ...]) -> dict[str, tuple[int, int]]:
    """idx 라인 형식: `<n>:<offset>:d=<YYYYMMDDHH>:<VAR>:<LEVEL>:<fcst>:`.

    **부분열(substring) 매칭 금지**: 예를 들어 `"TMP:surface:"` 는 `"ICETMP:surface:"` 의 부분열이라,
    단순히 `v in l` 로 찾으면 idx 안에 두 변수가 모두 있을 때 나중에 순회되는 쪽(오프셋이 더 큰
    쪽)이 먼저 찾은 걸 덮어써 버린다(실측: ICETMP 오프셋으로 TMP:surface 를 읽어 표층수온이 전부
    9999K 상수로 나오는 조용한 오염 버그가 실제로 발생했다). `VAR:LEVEL:` 를 정확히 재구성해
    `wanted` 와 완전일치만 채택한다."""
    lines = [l for l in idx_text.split("\n") if l.strip()]
    parsed: list[tuple[int, str]] = []
    for l in lines:
        parts = l.split(":")
        if len(parts) < 5:
            continue
        try:
            off = int(parts[1])
        except ValueError:
            continue
        parsed.append((off, l))
    parsed.sort()
    wanted_set = set(wanted)
    ranges: dict[str, tuple[int, int]] = {}
    for i, (off, l) in enumerate(parsed):
        parts = l.split(":")
        key = f"{parts[3]}:{parts[4]}:"
        if key in wanted_set:
            end = parsed[i + 1][0] - 1 if i + 1 < len(parsed) else off + 5_000_000
            ranges[key] = (off, end)
    return ranges


def _parse_grib_message(data: bytes) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """단일 GRIB2 메시지 바이트를 eccodes 로 메모리에서 직접 디코드(임시파일 없음).
    반환 (values(nj,ni), lat1d, lon1d) — lat/lon 은 격자 첫/끝점에서 선형보간한 좌표축."""
    import eccodes
    gid = eccodes.codes_new_from_message(data)
    try:
        ni = eccodes.codes_get(gid, "Ni")
        nj = eccodes.codes_get(gid, "Nj")
        la1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
        la2 = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
        lo1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
        lo2 = eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees")
        flat = eccodes.codes_get_array(gid, "values")
        values = np.asarray(flat, dtype=np.float32).reshape(nj, ni)
    finally:
        eccodes.codes_release(gid)
    return values, np.linspace(la1, la2, nj), np.linspace(lo1, lo2, ni)


def _fetch_aws_vars(grib_url: str, var_map: dict[str, str]) -> dict[str, tuple]:
    """AWS `.idx` 사이드카로 바이트 범위를 찾아 원하는 GRIB 메시지만 병렬 Range 요청.
    반환 {label: (values, lat1d, lon1d)} — label 은 var_map 값(U/V 또는 TMP/LAND)."""
    idx_text = _http_get(urllib.request.Request(grib_url + ".idx"), timeout=10).decode()
    wanted = tuple(var_map)
    ranges = _idx_ranges(idx_text, wanted)
    missing = [v for v in wanted if v not in ranges]
    if missing:
        raise RuntimeError(f"idx 에 변수 없음: {missing}")

    def _one(v: str) -> tuple[str, bytes]:
        s, e = ranges[v]
        return v, _fetch_range(grib_url, s, e)

    with ThreadPoolExecutor(max_workers=len(wanted)) as pool:
        raw = dict(pool.map(_one, wanted))

    return {var_map[v]: _parse_grib_message(raw[v]) for v in wanted}


def _fetch_nomads_vars(cycle_dt: datetime, fhr: int, var_query: str,
                        shortname_map: dict[str, str]) -> dict[str, tuple]:
    """NOMADS filter CGI 폴백 — 서버가 이미 한반도 창으로 잘라 반환(수십 KB, ~0.5초).
    응답이 메시지 여러 개가 이어붙은 GRIB2 라 임시파일 1개 + eccodes 파일 이터레이터로 분리
    (AWS 경로처럼 바이트 오프셋을 미리 알 수 없어 Range 요청이 불가능 — 대신 응답 자체가
    작으므로 임시파일 비용이 무시할 만하다)."""
    import eccodes
    cc = f"{cycle_dt.hour:02d}"
    url = (f"{_NOMADS_FILTER_URL}?dir=%2Fgfs.{cycle_dt:%Y%m%d}%2F{cc}%2Fatmos"
           f"&file=gfs.t{cc}z.pgrb2.0p25.f{fhr:03d}&{var_query}"
           f"&subregion=&toplat={LAT_MAX:g}&leftlon={LON_MIN:g}"
           f"&rightlon={LON_MAX:g}&bottomlat={LAT_MIN:g}")
    data = _http_get(url, timeout=20)
    if len(data) < 200:   # 정상 GRIB2 는 수십 KB — 이보다 작으면 에러 페이지(HTML/텍스트) 응답
        raise RuntimeError(f"NOMADS 응답 비정상(size={len(data)}B)")

    fd, tmp = tempfile.mkstemp(suffix=".grib2")
    os.close(fd)
    out: dict[str, tuple] = {}
    try:
        with open(tmp, "wb") as f:
            f.write(data)
        with open(tmp, "rb") as f:
            while True:
                gid = eccodes.codes_grib_new_from_file(f)
                if gid is None:
                    break
                try:
                    label = shortname_map.get(eccodes.codes_get(gid, "shortName"))
                    if label is None:
                        continue
                    ni = eccodes.codes_get(gid, "Ni")
                    nj = eccodes.codes_get(gid, "Nj")
                    la1 = eccodes.codes_get(gid, "latitudeOfFirstGridPointInDegrees")
                    la2 = eccodes.codes_get(gid, "latitudeOfLastGridPointInDegrees")
                    lo1 = eccodes.codes_get(gid, "longitudeOfFirstGridPointInDegrees")
                    lo2 = eccodes.codes_get(gid, "longitudeOfLastGridPointInDegrees")
                    values = np.asarray(eccodes.codes_get_array(gid, "values"),
                                         dtype=np.float32).reshape(nj, ni)
                    out[label] = (values, np.linspace(la1, la2, nj), np.linspace(lo1, lo2, ni))
                finally:
                    eccodes.codes_release(gid)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    missing = [lbl for lbl in shortname_map.values() if lbl not in out]
    if missing:
        raise RuntimeError(f"NOMADS 응답에 변수 없음: {missing}")
    return out


# ─────────────────────────────────────────────────────────────────────────
# 격자 유틸 — 한반도 창 자르기 + JSON 안전 변환(육지/결측 → null). GRIB(AWS·NOMADS)·NetCDF(OISST)
# 세 경로 모두 이 두 함수로 수렴한다(소스 무관 공통 처리).
# ─────────────────────────────────────────────────────────────────────────
def _subset_window(values2d: np.ndarray, lat1d: np.ndarray, lon1d: np.ndarray) -> np.ndarray:
    """전역/광역 격자에서 한반도 창(LON_MIN..LON_MAX, LAT_MIN..LAT_MAX)만 잘라 행0=최남단이 되게
    정렬한다. AWS 전역격자(위→아래, 90..-90)는 위도가 내림차순이라 뒤집어야 하고, NOMADS·OISST 는
    이미 오름차순이라 그대로 통과(무연산) — 위도 방향을 매번 실측해 처리하므로 소스별 분기가 없다."""
    lat_mask = (lat1d >= LAT_MIN) & (lat1d <= LAT_MAX)
    lon_mask = (lon1d >= LON_MIN) & (lon1d <= LON_MAX)
    sub = values2d[np.ix_(lat_mask, lon_mask)]
    sub_lat = lat1d[lat_mask]
    if len(sub_lat) >= 2 and sub_lat[0] > sub_lat[-1]:
        sub = sub[::-1, :]
    return sub


def _grid_to_json(arr: np.ndarray) -> list:
    """육지/결측(마스크 또는 NaN) → None, 나머지는 소수 2자리 반올림한 중첩 리스트로 변환.
    numpy.float64 는 파이썬 float 의 서브클래스라 json.dumps 가 그대로 직렬화한다."""
    filled = arr.filled(np.nan) if np.ma.isMaskedArray(arr) else np.asarray(arr, dtype=np.float64)
    rounded = np.round(filled.astype(np.float64), 2)
    obj = rounded.astype(object)
    obj[np.isnan(rounded)] = None
    return obj.tolist()


# ─────────────────────────────────────────────────────────────────────────
# 바람(GFS UGRD/VGRD@10m) — AWS 우선, 전 후보 실패 시 NOMADS 로 재시도
# ─────────────────────────────────────────────────────────────────────────
def _build_wind_payload(grids: dict, cycle_dt: datetime, fhr: int, source: str,
                         now_utc: datetime) -> dict:
    u_vals, lat1d, lon1d = grids["U"]
    v_vals, _, _ = grids["V"]
    u_sub = _subset_window(u_vals, lat1d, lon1d)
    v_sub = _subset_window(v_vals, lat1d, lon1d)
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    label = f"GFS 0.25° t{cycle_dt.hour:02d}z+{fhr:03d}h"
    if source == "nomads":
        label += " (NOMADS 폴백)"
    return {
        "valid_kst": kst.strftime("%Y-%m-%d %H:00"),
        "source": label,
        "bounds": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "rows": int(u_sub.shape[0]),
        "cols": int(u_sub.shape[1]),
        "u": _grid_to_json(u_sub),
        "v": _grid_to_json(v_sub),
    }


def fetch_wind(now_utc: datetime) -> tuple[dict, tuple]:
    """현재 프레임 바람장 1장을 구해 (payload, ctx) 로 반환한다. ctx=(source, cycle_dt, fhr,
    grib_url_or_None) 는 수온 전멸 시 GFS 폴백이 같은 사이클/예보시간을 재사용하기 위한 것 —
    같은 GRIB 파일에서 이미 검증된 사이클을 또 골라 헤매지 않게 한다."""
    candidates = _pick_candidates(now_utc)
    if not candidates:
        raise RuntimeError("사용 가능한 GFS 사이클 후보 없음")

    errors: list[str] = []
    for cycle_dt, fhr in candidates:
        grib_url = _aws_grib_url(cycle_dt, fhr)
        try:
            grids = _fetch_aws_vars(grib_url, _WIND_VAR_MAP)
            return (_build_wind_payload(grids, cycle_dt, fhr, "aws", now_utc),
                    ("aws", cycle_dt, fhr, grib_url))
        except Exception as e:
            errors.append(f"aws t{cycle_dt.hour:02d}z+{fhr:03d}h: {e}")

    for cycle_dt, fhr in candidates:
        try:
            grids = _fetch_nomads_vars(cycle_dt, fhr, _WIND_NOMADS_QUERY, _WIND_NOMADS_SHORTNAME_MAP)
            return (_build_wind_payload(grids, cycle_dt, fhr, "nomads", now_utc),
                    ("nomads", cycle_dt, fhr, None))
        except Exception as e:
            errors.append(f"nomads t{cycle_dt.hour:02d}z+{fhr:03d}h: {e}")

    raise RuntimeError("GFS 바람장 수집 실패(AWS+NOMADS 전 후보): " + "; ".join(errors))


# ─────────────────────────────────────────────────────────────────────────
# 수온 PRIMARY = GFS TMP:surface(육지는 LAND:surface 로 마스킹) — 바람과 같은 사이클/예보시간을
# 재사용(ctx)해 추가 Range 요청 2개만 더 보낸다. 발행지연 0, 바람과 valid 시각이 정확히 같다.
# ─────────────────────────────────────────────────────────────────────────
def _fetch_gfs_sst_primary(ctx: tuple, now_utc: datetime) -> dict:
    """바람장과 같은 GFS 사이클/예보시간에서 표층기온(TMP:surface)을 추가로 받아 K→°C 변환하고
    LAND:surface(육지비율)로 마스킹한다. 실측 위성이 아니라 모델 분석치이므로 source 문자열에
    이를 명시한다(§CLAUDE.md 시연/모의 원칙) — 다만 위성보다 발행지연이 없고 바람과 시각이
    정확히 일치해 이 플랫폼에선 이쪽을 기본으로 삼는다(코디네이터 지시, 2026-07-16)."""
    source, cycle_dt, fhr, grib_url = ctx
    if source == "aws":
        grids = _fetch_aws_vars(grib_url, _SST_PRIMARY_VAR_MAP)
    else:
        grids = _fetch_nomads_vars(cycle_dt, fhr, _SST_PRIMARY_NOMADS_QUERY,
                                    _SST_PRIMARY_NOMADS_SHORTNAME_MAP)
    tmp_vals, lat1d, lon1d = grids["TMP"]
    land_vals, _, _ = grids["LAND"]
    tmp_sub = _subset_window(tmp_vals, lat1d, lon1d).astype(np.float64)
    land_sub = _subset_window(land_vals, lat1d, lon1d)
    sst_c = np.where(land_sub > 0.5, np.nan, tmp_sub - 273.15)   # K→°C, 육지(land>=0.5)는 결측
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    label = f"GFS 0.25° 표층수온 분석 t{cycle_dt.hour:02d}z+{fhr:03d}h"
    if source == "nomads":
        label += " (NOMADS 폴백)"
    return {
        "valid_kst": kst.strftime("%Y-%m-%d %H:00"),   # 바람 valid_kst 와 항상 동일 — 같은 GRIB 라운드
        "source": label,
        "bounds": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "rows": int(sst_c.shape[0]),
        "cols": int(sst_c.shape[1]),
        "data": _grid_to_json(sst_c),
    }


# ── 수온 FALLBACK = OISST v2.1 위성 일별 분석 — GFS 표층장 수집 자체가 실패했을 때만 쓴다.
def _oisst_candidate_urls(day: datetime) -> list[str]:
    """`_preliminary`(근실시간 잠정판)를 먼저, 확정판을 나중에 — 최근 날짜일수록 확정판은
    아직 없고 잠정판만 있는 경우가 실측상 흔하다(2026-07-16 프로브: D-1 은 둘 다 404, D-2 는
    `_preliminary` 만 200)."""
    base = f"{_AWS_OISST_BASE}/{day:%Y%m}/oisst-avhrr-v02r01.{day:%Y%m%d}"
    return [f"{base}_preliminary.nc", f"{base}.nc"]


def _fetch_oisst_fallback(now_utc: datetime) -> dict:
    import netCDF4
    errors: list[str] = []
    for offset in range(1, 6):   # D-1 ~ D-5(오늘 D-0 은 실측상 거의 항상 미발행이라 건너뜀)
        day = now_utc - timedelta(days=offset)
        for url in _oisst_candidate_urls(day):
            try:
                data = _http_get(url, timeout=20)
            except Exception as e:
                errors.append(f"{url.rsplit('/', 1)[-1]}: {e}")
                continue
            try:
                ds = netCDF4.Dataset(f"field_oisst_{day:%Y%m%d}", memory=data)
                try:
                    lat = np.asarray(ds.variables["lat"][:], dtype=np.float64)
                    lon = np.asarray(ds.variables["lon"][:], dtype=np.float64)
                    sst = ds.variables["sst"][0, 0, :, :]   # (time=1,zlev=1,lat,lon)→(lat,lon)
                finally:
                    ds.close()
            except Exception as e:
                errors.append(f"{url.rsplit('/', 1)[-1]} parse: {e}")
                continue
            sub = _subset_window(sst, lat, lon)
            date_str = day.strftime("%Y-%m-%d")
            return {
                "valid_kst": date_str,
                "source": f"NOAA OISST v2.1 위성 분석 ({date_str})",
                "bounds": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
                "rows": int(sub.shape[0]),
                "cols": int(sub.shape[1]),
                "data": _grid_to_json(sub),
            }
    raise RuntimeError("OISST D-1~D-5 전부 실패: " + "; ".join(errors))


def fetch_sst(now_utc: datetime, ctx: tuple) -> dict:
    """PRIMARY(GFS 표층수온, 바람과 동일 사이클) 먼저 시도하고, 그 수집 자체가 실패했을 때만
    FALLBACK(OISST 위성)으로 넘어간다."""
    try:
        return _fetch_gfs_sst_primary(ctx, now_utc)
    except Exception as e_gfs:
        _log(f"GFS 표층수온 수집 실패, OISST 폴백 시도: {e_gfs}")
        return _fetch_oisst_fallback(now_utc)


# ─────────────────────────────────────────────────────────────────────────
# 인메모리 페이로드 + 디스크 캐시(현재 프레임 1장만 보존)
# ─────────────────────────────────────────────────────────────────────────
_LOCK = threading.Lock()
_PAYLOAD: dict = {"ready": False}
_LAST_ERROR: Optional[str] = None

# 수온 PRIMARY(GFS)는 바람과 같은 라운드라 매시 다시 받는다 — 아래 캐시는 오직 FALLBACK(OISST)
# 모드일 때만 쓰인다(OISST 는 일 단위 자료라 폴백 중에도 매시 재다운로드할 필요가 없다:
# §요구사항 "SST only when the date rolls or the previous attempt failed").
_SST_FALLBACK_CACHE: Optional[dict] = None
_SST_FALLBACK_CACHE_UTC_DATE: Optional[str] = None

_started = False
_start_lock = threading.Lock()

_BOOT_FRESH_SEC = 75 * 60      # 부팅 시 재사용할 디스크 캐시 신선도 상한(75분)
_RETRY_AFTER_FAIL_SEC = 600    # 수집 실패 시 재시도 대기(10분)


def get_field_payload() -> dict:
    """`/api/field` 가 그대로 반환하는 값 — 요청 스레드는 락만 잡고 참조를 읽을 뿐 외부 호출・
    파싱・재계산이 전혀 없다(사전 워밍 계약)."""
    with _LOCK:
        if _PAYLOAD.get("ready"):
            return _PAYLOAD
        return {"ready": False, "error": _LAST_ERROR}


def _swap_payload(payload: dict) -> None:
    global _PAYLOAD, _LAST_ERROR
    with _LOCK:
        _PAYLOAD = payload
        _LAST_ERROR = None


def _set_error(msg: str) -> None:
    global _LAST_ERROR
    with _LOCK:
        _LAST_ERROR = msg
    _log(msg)


# ── 디스크 캐시: data/cache/field/field_{YYYYMMDDHH}.json (KST 프레임 시각) — 항상 1개만 보존
def _cache_path(now_utc: datetime) -> Path:
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    return CACHE_DIR / f"field_{kst:%Y%m%d%H}.json"


def _prune_old_cache_files(keep: Path) -> None:
    if not CACHE_DIR.exists():
        return
    for p in CACHE_DIR.glob("field_*.json"):
        if p != keep:
            try:
                p.unlink()
            except OSError:
                pass


def _write_disk_cache(payload: dict, now_utc: datetime) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(now_utc)
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        _prune_old_cache_files(path)
    except OSError as e:
        _log(f"디스크 캐시 쓰기 실패(무시하고 계속): {e}")


def _try_load_disk_cache() -> bool:
    """부팅 시 신선한(75분 미만) 캐시 파일이 있으면 즉시 메모리에 올려 ready=True 로 서빙을
    시작한다. 성공하면 True(배경 루프는 다음 정시+5분까지 대기만 하면 됨), 없거나 낡았으면
    False(호출측이 즉시 1회 수집을 수행)."""
    if not CACHE_DIR.exists():
        return False
    files = sorted(CACHE_DIR.glob("field_*.json"))
    if not files:
        return False
    path = files[-1]
    try:
        age_sec = time.time() - path.stat().st_mtime
    except OSError:
        return False
    if age_sec >= _BOOT_FRESH_SEC:
        return False
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        _log(f"디스크 캐시 읽기 실패: {e}")
        return False
    if not payload.get("ready"):
        return False

    # 로드한 프레임의 sst 가 OISST 폴백 산출물이면(정상은 GFS 1차라 매시 다시 받으므로 이 시딩이
    # 불필요) FALLBACK 캐시도 같이 씨딩해, 부팅 직후 GFS 가 계속 실패하는 상황에서도 불필요한
    # OISST 재다운로드 없이 이어서 폴백을 쓸 수 있게 한다.
    global _SST_FALLBACK_CACHE, _SST_FALLBACK_CACHE_UTC_DATE
    loaded_sst = payload.get("sst") or {}
    if "OISST" in str(loaded_sst.get("source", "")):
        _SST_FALLBACK_CACHE = loaded_sst
        try:
            _SST_FALLBACK_CACHE_UTC_DATE = datetime.strptime(
                loaded_sst["valid_kst"][:10], "%Y-%m-%d"
            ).strftime("%Y%m%d")
        except (KeyError, ValueError):
            _SST_FALLBACK_CACHE_UTC_DATE = None

    _swap_payload(payload)
    _log(f"부팅: 신선한 캐시 재사용(age={age_sec / 60:.1f}분, {path.name})")
    return True


# ── 갱신 루프 ─────────────────────────────────────────────────────────────────
def _do_refresh() -> bool:
    """바람 + 수온 PRIMARY(GFS, 바람과 같은 라운드)는 매번 새로 받는다. PRIMARY 수집 자체가
    실패했을 때만 FALLBACK(OISST)로 넘어가고, 그건 날짜가 바뀌었거나 이전 폴백 시도가
    실패했을 때만 다시 받는다(일 단위 자료라 폴백 중에도 매시 재다운로드할 필요가 없다).
    성공하면 페이로드를 통째로 스왑 + 디스크에 쓰고 True. 실패하면 이전 페이로드를 그대로
    유지(스왑하지 않음)하고 False(호출측이 10분 뒤 재시도)."""
    global _SST_FALLBACK_CACHE, _SST_FALLBACK_CACHE_UTC_DATE
    now_utc = datetime.now(timezone.utc)

    try:
        wind, ctx = fetch_wind(now_utc)
    except Exception as e:
        _set_error(f"바람장 수집 실패, 이전 프레임 유지: {e}")
        return False

    try:
        sst = _fetch_gfs_sst_primary(ctx, now_utc)   # 매시 갱신 — 바람과 valid 시각 항상 일치
    except Exception as e_gfs:
        _log(f"GFS 표층수온 수집 실패, OISST 폴백 확인: {e_gfs}")
        today = now_utc.strftime("%Y%m%d")
        if _SST_FALLBACK_CACHE is not None and _SST_FALLBACK_CACHE_UTC_DATE == today:
            sst = _SST_FALLBACK_CACHE   # 오늘자 폴백 캐시 재사용(매시 재다운로드 방지)
        else:
            try:
                sst = _fetch_oisst_fallback(now_utc)
                _SST_FALLBACK_CACHE = sst
                _SST_FALLBACK_CACHE_UTC_DATE = today
            except Exception as e_oisst:
                if _SST_FALLBACK_CACHE is None:
                    _set_error(f"수온 전체 실패(GFS+OISST), 바람장도 보류: {e_oisst}")
                    return False
                _log(f"OISST 폴백도 실패, 이전 수온 프레임 유지: {e_oisst}")
                sst = _SST_FALLBACK_CACHE

    payload = {"ready": True, "wind": wind, "sst": sst}
    _swap_payload(payload)
    _write_disk_cache(payload, now_utc)

    size_kb = len(json.dumps(payload, ensure_ascii=False).encode("utf-8")) / 1024
    _log(f"갱신 완료: wind={wind['source']} sst={sst['source']} ({size_kb:.0f}KB)")
    return True


def _seconds_until_next_run(prev_success: bool) -> float:
    if not prev_success:
        return float(_RETRY_AFTER_FAIL_SEC)
    now = datetime.now(timezone.utc)
    target = now.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1, minutes=5)
    return max((target - now).total_seconds(), 60.0)


def _refresh_loop() -> None:
    ok = _try_load_disk_cache()
    if not ok:
        ok = _do_refresh()   # 신선한 캐시가 없으면 즉시 1회 수집(부팅 워밍) — 실패해도 계속 진행
    while True:
        time.sleep(_seconds_until_next_run(ok))
        ok = _do_refresh()


def start_refresher() -> None:
    """FastAPI startup 시 1회 호출(`live_cache.start_refresher()` 와 동일 패턴 — main.py 의
    lifespan 이 부르는 진입점). 데몬 스레드 1개가 부팅 워밍(또는 신선한 디스크 캐시 재사용)과
    매시 정각+5분 갱신을 전담하고, 서버 기동 자체는 이 스레드를 기다리지 않는다."""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_refresh_loop, name="field-refresh", daemon=True).start()
