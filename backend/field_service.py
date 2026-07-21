"""2D 필드 오버레이(바람·표층수온) — **현재 KST 1시간 프레임만** 서빙한다.

## 설계 원칙(요구사항 그대로)

- **타임라인/애니메이션 없음**: 과거·미래 프레임을 쌓지 않는다. 항상 "지금 이 시각" 한 장뿐이다.
- **무키 공개 데이터**: 바람=JMA MSM 5km(교토대 RISH 미러, 1순위)·GFS 0.25°(2순위 폴백),
  수온=NOAA RTOFS 1/12°(1순위)·OISST v2.1(폴백) — 전부 API 키 불필요. `khoa_api.py`/`kma_marine.py`
  처럼 `.env` 시크릿에 의존하지 않는다.
- **사전 워밍으로 즉시 표출**: 백그라운드 스레드가 매시 정각+5분마다 새 프레임을 받아 인메모리
  페이로드(이미 인코딩까지 끝난 완성 바이트열)를 통째로 스왑한다(`_swap_payload_bytes`) —
  `/api/field` 요청은 이미 채워진 메모리를 읽기만 해서 응답하고, 그 순간 외부 API 를 부르거나
  GRIB/NetCDF 파싱은 물론 인코딩조차 하지 않는다(요청측 계산 0).
- **이전 시점 삭제**: 디스크 캐시(`data/cache/field/field_{YYYYMMDDHH}.bin`, KST 파일명, 완성된
  이진 프레임 그대로)는 항상 "현재 프레임 1개"만 남긴다 — 새 프레임을 쓰면 그 즉시 이전 파일을
  지운다(`_prune_old_cache_files`). 타임라인 기능이 없으므로 과거 프레임을 보존할 이유가 없다
  (Storm `gfs_wide.py` 의 영구보존 `.npz` 아카이브와 정반대 방향 — 여긴 "최신 1장만" 이 계약이다).
- **부팅 즉시 서빙**: 재시작 직후에도 디스크에 신선한(75분 미만) 캐시가 있으면 그 바이트를 그대로
  메모리에 올려 즉시 `ready:true` 로 응답한다(재인코딩 없음). 없으면 배경 스레드가 첫 수집을
  마칠 때까지 `/api/field` 는 `ready:false` 이진 프레임을 반환한다(프론트는 이 플래그로 로딩
  상태를 표시).
- **이진 페이로드(§27, 2026-07-17)**: JSON 숫자배열 대신 Int16 스케일 이진으로 응답한다(프레임
  계약은 아래 §). 이 예산 여유로 바람장을 **JMA MSM 네이티브 해상도(0.0625°×0.05°≈5.5km,
  353×441)로 복원**했다 — 이전에 페이로드 예산 때문에 2배 솎아 11km 로 표출하면서 `source` 는
  "5km" 라고 잘못 표기했던 퇴행을 바로잡음(CLAUDE.md 출처 표기 원칙).

## 데이터 소스 (기술은 Storm `gfs_wide.py` 의 .idx 사이드카 + HTTP Range + eccodes 인메모리 파싱을
그대로 이식하되, 이 플랫폼은 프레임이 1장뿐이라 LRU/디스크 영구아카이브 등은 전부 걷어냈다)

1. **바람 — 1순위 = JMA MSM 5km(10u/10v)**: 교토대 RISH 무키 아카이브 미러(`.idx` 사이드카는
   없지만 GRIB2 내부 구조를 실측해 필드 바이트 오프셋을 산술로 계산 — 상세는 `_MSM_*` 상수
   블록 위 주석). 헤더 1회 + 데이터 1회, 총 2회 Range 요청(~0.6초)으로 목표 예보시간의 10u/10v
   만 받는다. 표출창은 GFS 와 블렌딩하지 않고 **MSM 원 격자와의 교집합 `[120,142]x[24,46]`**
   만 쓴다(사용자 확정, 2026-07-17) — 수온(RTOFS, `[115,142]x[24,46]`)과 서쪽 경계가 다르다.
   이진 인코딩(§27)으로 예산 여유가 생겨 원 해상도(5.5km, 353×441) 그대로 표출한다(예전엔
   JSON 페이로드 예산 때문에 2배 솎아 11km 로 냈었다 — 지금은 솎지 않는다).
   **2순위 = GFS 0.25°(UGRD/VGRD @10m)**: MSM 전 후보(3h 사이클 x FH0~15)가 모두 실패했을
   때만 — AWS Open Data 버킷의 `.idx` 로 바이트 범위를 찾아 딱 그 두 메시지만 Range 요청 →
   eccodes 로 메모리에서 직접 디코드(임시파일 없음, ~0.1초/필드). 최신 사이클부터 시도하고,
   아직 안 올라온 사이클(404)은 자동으로 더 오래된 사이클로 폴백한다. AWS 버킷 자체가 안 되면
   (네트워크 장애) NOMADS filter CGI(같은 원본 파일을 다른 서버가 한반도 창으로 미리 잘라 제공
   — 응답이 이미 작아 임시파일 1개로 간단히 파싱)로 재시도한다. 이때 표출창은 원래의
   `[115,142]x[24,46]`(전체 한반도 창)로 돌아간다.
2. **수온 — 1순위 = NOAA RTOFS 1/12° 해양모델 분석(HYCOM)**: `nomads.ncep.noaa.gov` 의
   `rtofs.{cycle}/rtofs_glo_2ds_f{fhr}_prog.nc`(전지구, HDF5/NetCDF4, ~150~195MB) 를
   `#mode=bytes` 원격 바이트범위 오픈(netCDF4 가 HTTP Range 로 필요한 HDF5 청크만 받는다)으로
   열어, 한반도 창에 해당하는 격자 인덱스만 슬라이스한다(실측: 청크 1개·수백KB 오더만 전송,
   전체 파일 다운로드 없음). `sst` 변수(단위 °C, 결측=마스크드어레이)를 분리형(rectilinear)
   원 격자에서 1/12°(265×325) 균등 lat/lon 격자로 축별 선형보간한다. 실측 확인: 24~46N·
   115~142E 구간에서는 위경도가 각각 Y축/X축에만 의존하는 사각격자다(전지구 격자가 47N 이북
   에서 삼중극 캡으로 휘는 것과 달리, 이 구간은 표준 메르카토르 패치라 위경도 2D 필드값이
   실제로는 분리 가능함을 실측으로 검증했다 — 아래 `_ensure_rtofs_grid`). RTOFS 는 00Z **1일
   1사이클**(GFS 처럼 하루 여러 번이 아니다), 예보시간 f000~f072(시간당)만 발행하며 발행
   지연이 실측 ~12.5시간이라 자정~정오 UTC 사이엔 전날 사이클(fhr 24~47)을 써야 한다 —
   "지금"(바람과 동일 target 시각)에 맞는 (사이클,fhr) 을 오늘→어제→그제 순으로 역산해 고른다.
   해양모델이라 GFS 표층장보다 쿠로시오·대마난류 등 실제 해양 전선/소용돌이 구조가 뚜렷하다
   (실측: 격자당 수온 기울기가 GFS 대비 약 1.8~2배, 아래 §검증). 격자 인덱스(위경도 축)는
   정적이라 프로세스 수명당 1회만 계산해 캐시하고, 이후 매시 갱신은 `sst` 슬라이스만 다시
   받는다.
   **2순위 = GFS `TMP:surface` (LAND:surface 로 육지 마스킹)**: RTOFS 수집 자체가 실패했을
   때만 — 바람과 **같은 사이클/예보시간**(ctx 재사용)에서 표층기온 메시지를 추가로 Range
   요청 → K→°C 변환, 육지(LAND>=0.5)는 null. 발행 지연이 0이고 바람과 valid 시각이 정확히
   같다(GFS NSST/RTG_SST_HR 해양표층 동화값이라 위성 관측을 이미 반영한 분석치).
   **3순위 = OISST v2.1 위성 일별 분석**(RTOFS·GFS 가 모두 실패했을 때만): AWS 버킷의
   넷CDF 전체(~1.5MB)를 메모리로 받아 한반도 창만 자른다. `_preliminary`(근실시간 잠정판)를
   먼저 시도한 뒤 확정판을 시도하고, 발행 지연(통상 D-2)을 감안해 D-1 부터 D-5 까지 순차
   후퇴한다. 폴백 모드에서는 하루 1회만 다시 받고(날짜가 바뀔 때·이전 시도 실패 시) 매시
   재다운로드하지 않는다(RTOFS·GFS 가 매시 정상 복구되면 이 캐시는 더 이상 쓰이지 않는다).

## 프레임 계약(EXACT — 프론트가 이 바이너리 포맷에 맞춰 만들어짐, §27 2026-07-17 이진화)

JSON 숫자배열은 값 하나에 ~6바이트를 써서 MSM 네이티브(353×441) 바람장만으로도 1,884KB 로
1MB 예산을 4배 초과했다(그래서 한때 2배 솎아 11km 로 표출하며 "5km" 라고 잘못 표기하는
퇴행이 있었다 — §27 에서 바로잡음). **Int16 스케일 이진**(값 하나 2바이트)으로 바꾸면 MSM
네이티브 + RTOFS 네이티브를 합쳐도 ~800KB 로 예산 안에 들어와 솎을 필요가 없다.

응답 `Content-Type: application/octet-stream`, 바이트 레이아웃(왕복 1회 유지):

    [0:4)   uint32 LE  = N (헤더 JSON 바이트 길이)
    [4:4+N) UTF-8 JSON 헤더 (N 이 홀수면 헤더 뒤에 공백 1바이트를 패딩해 4+N 을 항상 짝수로
            맞춘다 — 이후 배열 오프셋이 Int16Array 정렬(2바이트) 요건을 만족하게 하기 위함)
    [4+N:)  본문 — 헤더가 지정한 오프셋에 따라 이어붙인 Int16(LE) 배열들

헤더 JSON 스키마:

    {"ready": true,
     "wind": {"valid_kst","source","bounds":[lon_min,lat_min,lon_max,lat_max],"rows","cols",
              "dtype":"int16","scale","offset","nodata",
              "u_offset","u_length","v_offset","v_length"},   # 오프셋은 본문(4+N 이후) 기준
     "sst":  {"valid_kst","source","bounds":[...],"rows","cols",
              "dtype":"int16","scale","offset","nodata",
              "data_offset","data_length"}}
    // ready:false 면 "error" 만 있고 wind/sst 는 없음(본문 길이 0).

실값 = raw_int16 * scale + offset. 육지/결측은 **센티널 -32768**(Int16 최솟값, `nodata`) —
정상 데이터가 이 값에 부딪히지 않도록 인코딩 시 -32767 로 클리핑한다(`_encode_int16`).
행 0 = 최남단, 열 0 = 최서단(각 필드 `bounds` 기준 — **wind 와 sst 의 bounds 가 서로 다를 수
있다**: wind 1순위(MSM)는 `[120,24,142,46]`, sst 는 `[115,24,142,46]` — GFS 와 블렌딩하지
않기로 한 사용자 확정 사양. 프론트는 필드별 bounds 를 각각 읽어 그려야 한다), row-major.
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

# ── 이진 페이로드 인코딩 상수(§27) — Int16 + scale/offset, 육지/결측은 nodata 센티널.
# 바람 ±60m/s·0.01 해상도, 수온 -5~40℃·0.01 해상도 모두 int16(±32767) 범위에 여유있게 들어온다.
_INT16_NODATA = -32768        # Int16 최솟값 — 정상값은 절대 여기 닿지 않게 -32767 로 클리핑해 인코딩
_WIND_SCALE = 0.01
_WIND_OFFSET = 0.0
_SST_SCALE = 0.01
_SST_OFFSET = 0.0

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

_CYCLE_HOURS = (18, 12, 6, 0)   # GFS 사이클(UTC), 최신 우선 탐색용(바람 폴백용)

# ── 바람 1순위 = JMA MSM 5.5km(교토대 RISH 무키 미러). GFS 0.25°(28km) 보다 촘촘하다는
# 사용자 요청(2026-07-17)으로 primary 교체 — GFS 는 MSM 전 후보 실패 시에만 쓰는 폴백으로 격하.
# 무키·무신청, `.idx` 사이드카는 없지만 실측 확인한 GRIB2 내부구조(§아래)로 Range 요청 2회만으로
# 원하는 필드를 받는다(idx 파일 파싱과 동등한 효율).
#
# **실측 확정 사항(2026-07-16/17, msm_12z.bin·msm_09z.bin 교차검증)**:
#   - RISH 파일 하나(`Lsurf_FH00-15`)는 GRIB2 "멀티필드 메시지"(section0/1/3 을 공유하고
#     section4/5/6/7 만 190회 반복 — 표준이 허용하는 형태). eccodes 로 이걸 온전히 읽으려면
#     `codes_grib_multi_support_on()` 을 반드시 켜야 한다 — 안 켜면 **첫 필드(prmsl)만 읽고
#     나머지(10v 포함)는 조용히 버려진다**(에러 없이 침묵 손실 — 실제로 처음 겪은 함정).
#   - 필드 순서가 고정: 매 예보시간(0~15h)마다 [prmsl,sp,10u,10v,t2m,r2m,lcc,mcc,hcc,tcc] 10개
#     (인스턴트, PDT 길이 34) → h>=1 부터는 그 뒤에 [1시간 누적강수,단파복사] 2개(누적, PDT
#     길이 58) 가 덧붙는다. 매 필드의 (섹션4+5+6+7) 총 길이가 인스턴트=364424B·누적=364448B 로
#     **완전히 고정**(같은 압축 비트폭 템플릿을 매 사이클 동일하게 씀 — 09Z·12Z 두 사이클 실측
#     교차검증에서 바이트 단위로 일치, 전체 파일 크기도 69,241,393B 로 동일). 따라서 목표
#     예보시간의 10u/10v 바이트 오프셋을 **헤더만 한 번 읽으면(섹션1+3 길이) 산술로 정확히
#     계산**할 수 있다 — 190개 필드를 순회할 필요가 없다.
#   - 실측 수집 비용: 요청 1(헤더, 0~199바이트) + 요청 2(10u+10v 데이터, ~712KB) = **2회
#     Range 요청, 총 ~0.6초**(존재하지 않는 사이클 확인용 404 프로브 제외). idx 사이드카가
#     있는 GFS/AWS 경로와 동등한 효율.
#   - 격자: Ni=481·Nj=505, di=0.0625°(경도)·dj=0.05°(위도) ≈ 5.5~5.6km, la1=47.6(북)→
#     la2=22.4(남) — **첫 행이 북쪽**이라 우리 계약(행0=최남단)과 반대라 반드시 뒤집는다.
#     lo1=120.0→lo2=150.0(동쪽).
#   - **영역은 사용자 확정대로 GFS 와 블렌딩하지 않고 MSM 교집합만 표출**한다(`_MSM_LON_MIN`..
#     `_MSM_LAT_MAX` = [120,24,142,46]) — 수온(RTOFS, [115,24,142,46])과 bounds 가 달라지는
#     게 의도된 상태(서쪽 115~120°E 는 바람장이 원래 없다).
#   - **페이로드 예산(§27 이진화로 재계산)**: 원 해상도 그대로(353×441=155,673점) JSON 소수
#     2자리면 u+v 합 1,883KB 로 예산을 4배 초과해 한때 2배 솎음(11km)까지 갔었다. **Int16 이진
#     인코딩(2바이트/값)으로 바꾸면 155,673×2(u,v)×2바이트 = 622.7KB** — RTOFS 수온(86,125×
#     2바이트=168.2KB)을 더해도 총 ~791KB 로 1MB 예산 안에 원 해상도가 그대로 들어온다. 그래서
#     솎음(`_MSM_THIN`)·반올림 자리수 하향을 전부 제거하고 네이티브 353×441 을 다시 쓴다.
_RISH_BASE = "http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original"
_MSM_LON_MIN, _MSM_LON_MAX = 120.0, 142.0   # MSM 원 격자(120~150E)와 표출창(~142E)의 교집합
_MSM_LAT_MIN, _MSM_LAT_MAX = 24.0, 46.0     # MSM 원 격자(22.4~47.6N)가 표출창을 전부 덮음
_MSM_CYCLE_HOURS = (21, 18, 15, 12, 9, 6, 3, 0)   # MSM 은 3시간 간격 사이클
_MSM_MAX_FHR = 15                            # Lsurf_FH00-15 파일이 담는 예보시간 상한
_MSM_INSTANT_TUPLE_LEN = 364424              # 인스턴트 필드 1개(섹션4+5+6+7) 고정 길이(실측)
_MSM_ACCUM_TUPLE_LEN = 364448                # 누적(강수/복사) 필드 1개 고정 길이(실측)
_MSM_HEADER_PROBE_BYTES = 199                # 헤더(섹션0+1+3=16+21+72=109) 여유있게 담는 크기

# 수온 1순위 = NOAA RTOFS 1/12° 해양분석(HYCOM). AWS S3 미러(`noaa-nws-rtofs-pds`)에는
# ssh/유속/층두께 뿐인 `diag.nc`·`ice.nc`만 있고 SST 가 든 `prog.nc`는 없다(실측 확인) —
# NOMADS 의 HTTPS "fast download" 경로(OpenDAP 대체, 2026-02-23 폐지분 SCN 25-81)에만 있다.
_NOMADS_RTOFS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod"
_RTOFS_MAX_FHR = 72             # 2ds prog/diag/ice 가 실제 발행되는 예보시간 상한(실측)
_RTOFS_TIMEOUT_SEC = 25.0       # 원격 바이트범위 오픈 1회 시도당 상한(네트워크 정지 대비)
_RTOFS_GRID_PAD = 3             # 목표 격자 경계를 확실히 감싸도록 원 격자 인덱스에 주는 여유
_RTOFS_RES = 1.0 / 12.0
_RTOFS_ROWS = round((LAT_MAX - LAT_MIN) / _RTOFS_RES) + 1   # 265
_RTOFS_COLS = round((LON_MAX - LON_MIN) / _RTOFS_RES) + 1   # 325
_RTOFS_LAT_TARGET = np.linspace(LAT_MIN, LAT_MAX, _RTOFS_ROWS)
_RTOFS_LON_TARGET = np.linspace(LON_MIN, LON_MAX, _RTOFS_COLS)


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
def _subset_window(values2d: np.ndarray, lat1d: np.ndarray, lon1d: np.ndarray, *,
                    lon_min: float = LON_MIN, lon_max: float = LON_MAX,
                    lat_min: float = LAT_MIN, lat_max: float = LAT_MAX) -> np.ndarray:
    """전역/광역 격자에서 표출창(기본값=한반도 전체 창, 필드별로 다른 창을 넘길 수 있다 — MSM
    바람은 [120,142]x[24,46] 교집합 창을 쓴다)만 잘라 행0=최남단이 되게 정렬한다. AWS 전역격자
    (위→아래, 90..-90)는 위도가 내림차순이라 뒤집어야 하고, NOMADS·OISST·MSM 은 이미 오름차순
    이거나(뒤집어야 하는 경우 실측해 자동 처리) — 위도 방향을 매번 실측해 처리하므로 소스별
    분기가 없다."""
    lat_mask = (lat1d >= lat_min) & (lat1d <= lat_max)
    lon_mask = (lon1d >= lon_min) & (lon1d <= lon_max)
    sub = values2d[np.ix_(lat_mask, lon_mask)]
    sub_lat = lat1d[lat_mask]
    if len(sub_lat) >= 2 and sub_lat[0] > sub_lat[-1]:
        sub = sub[::-1, :]
    return sub


def _encode_int16(arr: np.ndarray, scale: float, offset: float = 0.0,
                   nodata: int = _INT16_NODATA) -> bytes:
    """육지/결측(마스크 또는 NaN) → `nodata` 센티널, 나머지는 `round((v-offset)/scale)` 로 양자화한
    Int16 리틀엔디안 바이트열(row-major, C 순서)로 인코딩한다(§27 이진 프레임 — 예전 `_grid_to_json`
    의 JSON 리스트 변환을 대체). 실측값이 우연히 `nodata`(-32768) 값에 부딪히지 않도록 실데이터는
    -32767 로 클리핑한다 — 이 플랫폼 범위(바람 ±수백m/s, 수온 ±수백℃ 스케일)에서는 절대 발생하지
    않는 극단치만 클리핑 대상이라 실질적 정보손실은 없다."""
    filled = arr.filled(np.nan) if np.ma.isMaskedArray(arr) else np.asarray(arr, dtype=np.float64)
    quant = np.rint((filled.astype(np.float64) - offset) / scale)
    valid = np.isfinite(quant)
    clipped = np.clip(np.where(valid, quant, 0.0), -32767, 32767)
    out = np.where(valid, clipped, nodata).astype("<i2")
    return out.tobytes()


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
        "u_bytes": _encode_int16(u_sub, _WIND_SCALE, _WIND_OFFSET),
        "v_bytes": _encode_int16(v_sub, _WIND_SCALE, _WIND_OFFSET),
    }


def _pick_msm_candidates(now_utc: datetime) -> list[tuple[datetime, int]]:
    """MSM 3시간 사이클(00/03/06/09/12/15/18/21Z) 후보를 오늘→어제 순으로 만들고, fhr(=목표
    -사이클, 시간) 오름차순(가장 신선한 사이클 우선)으로 정렬한다. `Lsurf_FH00-15` 파일이
    담는 범위(0<=fhr<=15)만 채택 — GFS `_pick_candidates` 와 동일한 패턴, 사이클 간격만 다르다."""
    target = now_utc.replace(minute=0, second=0, microsecond=0)
    out: list[tuple[datetime, int]] = []
    for day_offset in (0, 1):
        day0 = (target - timedelta(days=day_offset)).replace(hour=0)
        for h in _MSM_CYCLE_HOURS:
            cycle_dt = day0.replace(hour=h)
            if cycle_dt > target:
                continue
            fhr = int((target - cycle_dt).total_seconds() // 3600)
            if 0 <= fhr <= _MSM_MAX_FHR:
                out.append((cycle_dt, fhr))
    out.sort(key=lambda c: c[1])
    return out


def _msm_url(cycle_dt: datetime) -> str:
    return (f"{_RISH_BASE}/{cycle_dt:%Y/%m/%d}/"
            f"Z__C_RJTD_{cycle_dt:%Y%m%d%H}0000_MSM_GPV_Rjp_Lsurf_FH00-15_grib2.bin")


def _fetch_msm_wind_grib(cycle_dt: datetime, fhr: int) -> dict[str, tuple]:
    """MSM `Lsurf_FH00-15` 파일 하나에서 목표 예보시간의 10u/10v 만 딱 2회 Range 요청으로 받아
    디코드한다(모듈 상단 §실측 확정 사항 참고). 반환 {"U":(vals,lat1d,lon1d),"V":(...)} —
    `_fetch_aws_vars` 와 같은 반환 모양이라 이후 조립 코드가 소스에 무관하게 동일해진다."""
    import eccodes
    url = _msm_url(cycle_dt)

    # 요청 1 — 헤더(section0+1+3)만. RISH 는 `.idx` 사이드카가 없어 이 응답이 존재확인도 겸한다
    # (파일이 아직 안 올라왔으면 404 가 여기서 즉시 전파된다 — GFS AWS 404 프로브와 동격).
    hdr = _fetch_range(url, 0, _MSM_HEADER_PROBE_BYTES, timeout=15.0)
    if hdr[0:4] != b"GRIB" or hdr[7] != 2:
        raise RuntimeError("MSM 응답이 유효한 GRIB2 가 아님(포맷 변경 의심)")
    sec1_off = 16
    sec1_len = int.from_bytes(hdr[sec1_off:sec1_off + 4], "big")
    if len(hdr) < sec1_off + 5 or hdr[sec1_off + 4] != 1:
        raise RuntimeError("MSM section1 파싱 실패(포맷 변경 의심)")
    sec3_off = sec1_off + sec1_len
    sec3_len = int.from_bytes(hdr[sec3_off:sec3_off + 4], "big")
    if len(hdr) < sec3_off + 5 or hdr[sec3_off + 4] != 3:
        raise RuntimeError("MSM section3 파싱 실패(포맷 변경 의심)")
    base = sec3_off + sec3_len   # 필드(섹션4/5/6/7) 튜플이 시작되는 절대 오프셋

    # 목표 예보시간(fhr)의 10u/10v 바이트 범위 — 필드 순서·튜플 길이가 고정임을 실측으로
    # 검증했으므로(모듈 상단 주석) 190개 필드를 순회하지 않고 산술로 바로 구한다.
    preceding_hour_blocks = fhr
    preceding_accum_blocks = max(fhr - 1, 0)
    preceding_bytes = (preceding_hour_blocks * 10 * _MSM_INSTANT_TUPLE_LEN
                       + preceding_accum_blocks * 2 * _MSM_ACCUM_TUPLE_LEN)
    u_start = base + preceding_bytes + 2 * _MSM_INSTANT_TUPLE_LEN   # prmsl, sp 다음이 10u
    u_end = u_start + _MSM_INSTANT_TUPLE_LEN
    v_end = u_end + _MSM_INSTANT_TUPLE_LEN

    # 요청 2 — 10u+10v 데이터를 한 번에(인접해 있으므로 range 하나로 묶는다).
    uv_bytes = _fetch_range(url, u_start, v_end - 1, timeout=25.0)
    if len(uv_bytes) != v_end - u_start:
        raise RuntimeError(
            f"MSM Range 응답 길이 불일치(포맷 변경 의심): got={len(uv_bytes)} want={v_end - u_start}")

    # 표준 단일필드 메시지로 재구성(section0 재계산 + section1/3 재사용 + 10u/10v + 종료마커).
    body = hdr[sec1_off:sec1_off + sec1_len] + hdr[sec3_off:sec3_off + sec3_len] + uv_bytes
    total_len = 16 + len(body) + 4
    sec0 = b"GRIB" + b"\x00\x00" + bytes([0]) + bytes([2]) + total_len.to_bytes(8, "big")
    msg = sec0 + body + b"7777"

    # eccodes 는 메모리 메시지 1건짜리 API(`codes_new_from_message`)로는 멀티필드 메시지의
    # 첫 필드만 읽고 나머지를 조용히 버린다(실측으로 확인한 함정) — 파일 기반 반복자 +
    # `codes_grib_multi_support_on()` 조합이어야 10u·10v 둘 다 나온다. 그래서 임시파일을 쓴다
    # (NOMADS 폴백 경로와 동일한 이유·동일한 패턴).
    eccodes.codes_grib_multi_support_on()
    fd, tmp_path = tempfile.mkstemp(suffix=".grib2")
    os.close(fd)
    out: dict[str, tuple] = {}
    try:
        with open(tmp_path, "wb") as f:
            f.write(msg)
        with open(tmp_path, "rb") as f:
            while True:
                gid = eccodes.codes_grib_new_from_file(f)
                if gid is None:
                    break
                try:
                    label = {"10u": "U", "10v": "V"}.get(eccodes.codes_get(gid, "shortName"))
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
            os.remove(tmp_path)
        except OSError:
            pass

    missing = [k for k in ("U", "V") if k not in out]
    if missing:
        raise RuntimeError(f"MSM 메시지에 필드 없음(포맷 변경 의심): {missing}")
    return out


def _build_wind_payload_msm(grids: dict, cycle_dt: datetime, fhr: int, now_utc: datetime) -> dict:
    """MSM 전용 조립 — GFS 와 창(bounds)이 다르다(모듈 상단 §페이로드 예산). §27 이진화로 예산
    여유가 생겨 더 이상 솎지 않는다(네이티브 5.5km, 353×441 그대로). **주의**: 이 바람 창은
    `[120,142]x[24,46]`(MSM 원 격자와의 교집합)로 수온(RTOFS, `[115,142]x[24,46]`)과 서쪽
    경계가 다르다 — 사용자가 명시적으로 확정한 사양(GFS 와 이어붙이지 않는다)이며 프론트가
    필드별 bounds 를 각각 읽으므로 문제없다."""
    u_vals, lat1d, lon1d = grids["U"]
    v_vals, _, _ = grids["V"]
    u_sub = _subset_window(u_vals, lat1d, lon1d, lon_min=_MSM_LON_MIN, lon_max=_MSM_LON_MAX,
                            lat_min=_MSM_LAT_MIN, lat_max=_MSM_LAT_MAX)
    v_sub = _subset_window(v_vals, lat1d, lon1d, lon_min=_MSM_LON_MIN, lon_max=_MSM_LON_MAX,
                            lat_min=_MSM_LAT_MIN, lat_max=_MSM_LAT_MAX)
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    return {
        "valid_kst": kst.strftime("%Y-%m-%d %H:00"),
        "source": f"JMA MSM 5km {cycle_dt:%m/%d} {cycle_dt.hour:02d}z+{fhr:03d}h",
        "bounds": [_MSM_LON_MIN, _MSM_LAT_MIN, _MSM_LON_MAX, _MSM_LAT_MAX],
        "rows": int(u_sub.shape[0]),
        "cols": int(u_sub.shape[1]),
        "u_bytes": _encode_int16(u_sub, _WIND_SCALE, _WIND_OFFSET),
        "v_bytes": _encode_int16(v_sub, _WIND_SCALE, _WIND_OFFSET),
    }


def _fetch_wind_msm(now_utc: datetime) -> dict:
    """MSM 후보(3h 사이클 x 15 fhr)를 신선한 순으로 시도해 첫 성공 페이로드를 반환한다.
    전 후보 실패 시 예외를 던진다(호출측이 GFS 로 폴백)."""
    candidates = _pick_msm_candidates(now_utc)
    if not candidates:
        raise RuntimeError("사용 가능한 MSM 사이클 후보 없음")
    errors: list[str] = []
    for cycle_dt, fhr in candidates:
        try:
            grids = _fetch_msm_wind_grib(cycle_dt, fhr)
            return _build_wind_payload_msm(grids, cycle_dt, fhr, now_utc)
        except Exception as e:
            errors.append(f"msm t{cycle_dt.hour:02d}z+{fhr:03d}h: {e}")
    raise RuntimeError("MSM 바람장 수집 실패(전 후보): " + "; ".join(errors))


def fetch_wind(now_utc: datetime) -> tuple[dict, tuple]:
    """현재 프레임 바람장 1장을 구해 (payload, ctx) 로 반환한다. **1순위 = JMA MSM 5km**(RISH,
    한반도 해역만 GFS 보다 2.5배 촘촘 — 사용자 확정 primary), **2순위 = GFS 0.25°**(AWS→NOMADS,
    MSM 전 후보 실패 시만). ctx=(source, cycle_dt, fhr, grib_url_or_None) 는 수온 2순위(GFS
    표층수온) 폴백이 재사용할 GFS 사이클 정보 — **MSM 이 성공해도 ctx 는 항상 GFS 기준으로
    채운다**(MSM 에는 표층기온 필드가 없고, 수온 2순위는 GFS 전용 경로이기 때문). 이때 ctx 의
    GFS 후보는 실제로 검증하지 않고 최신 후보를 그대로 싣는다 — 수온 2순위가 실제로 필요해질
    때(RTOFS 실패 시)만 자체적으로 idx 존재를 확인하므로 안전하다(실패하면 그냥 OISST 3순위로
    넘어간다, 기존 동작 그대로)."""
    gfs_candidates = _pick_candidates(now_utc)

    try:
        wind = _fetch_wind_msm(now_utc)
        if gfs_candidates:
            cyc, fhr = gfs_candidates[0]
            ctx = ("aws", cyc, fhr, _aws_grib_url(cyc, fhr))
        else:
            ctx = ("aws", now_utc.replace(minute=0, second=0, microsecond=0), 0, "")
        return wind, ctx
    except Exception as e:
        _log(f"MSM 바람장 수집 실패, GFS 폴백 시도: {e}")

    if not gfs_candidates:
        raise RuntimeError("사용 가능한 GFS 사이클 후보 없음(MSM 도 실패)")

    errors: list[str] = []
    for cycle_dt, fhr in gfs_candidates:
        grib_url = _aws_grib_url(cycle_dt, fhr)
        try:
            grids = _fetch_aws_vars(grib_url, _WIND_VAR_MAP)
            return (_build_wind_payload(grids, cycle_dt, fhr, "aws", now_utc),
                    ("aws", cycle_dt, fhr, grib_url))
        except Exception as e:
            errors.append(f"aws t{cycle_dt.hour:02d}z+{fhr:03d}h: {e}")

    for cycle_dt, fhr in gfs_candidates:
        try:
            grids = _fetch_nomads_vars(cycle_dt, fhr, _WIND_NOMADS_QUERY, _WIND_NOMADS_SHORTNAME_MAP)
            return (_build_wind_payload(grids, cycle_dt, fhr, "nomads", now_utc),
                    ("nomads", cycle_dt, fhr, None))
        except Exception as e:
            errors.append(f"nomads t{cycle_dt.hour:02d}z+{fhr:03d}h: {e}")

    raise RuntimeError("GFS 바람장 수집 실패(MSM+AWS+NOMADS 전 후보): " + "; ".join(errors))


# ─────────────────────────────────────────────────────────────────────────
# 수온 1순위 = NOAA RTOFS 1/12° 해양분석(HYCOM, NOMADS `prog.nc` 원격 바이트범위 오픈)
# ─────────────────────────────────────────────────────────────────────────
_RTOFS_GRID_CACHE: Optional[dict] = None   # {"y_lo","y_hi","x_lo","x_hi","lat_native","lon_native"}
_RTOFS_GRID_LOCK = threading.Lock()


def _rtofs_prog_url(cycle_date: datetime, fhr: int) -> str:
    return (f"{_NOMADS_RTOFS_BASE}/rtofs.{cycle_date:%Y%m%d}/"
            f"rtofs_glo_2ds_f{fhr:03d}_prog.nc#mode=bytes")


def _pick_rtofs_candidates(now_utc: datetime) -> list[tuple[datetime, int]]:
    """RTOFS 는 00Z **1일 1사이클**만 돈다(GFS 처럼 하루 여러 사이클이 아니다) — 목표
    시각(=바람과 동일한 "지금 정시")과 그날 00Z 의 시간차를 fhr 로 써서 오늘→어제→그제 순으로
    후보를 만든다. 발행에 실측 ~12.5시간이 걸려(그날 00Z 사이클이 그날 12:2x~12:31 UTC 에
    전체 발행) 자정~정오 UTC 사이엔 오늘 사이클이 아직 없으므로 어제 사이클(fhr 24~47)로
    자동 후퇴한다. `_RTOFS_MAX_FHR`(72) 이내만 채택 — 그제 사이클까지 가면 fhr 48~71 로
    항상 범위 안에 들어와 이틀 발행 지연까지 커버한다."""
    target = now_utc.replace(minute=0, second=0, microsecond=0)
    out: list[tuple[datetime, int]] = []
    for day_offset in (0, 1, 2):
        cycle_date = (target - timedelta(days=day_offset)).replace(hour=0)
        fhr = int((target - cycle_date).total_seconds() // 3600)
        if 0 <= fhr <= _RTOFS_MAX_FHR:
            out.append((cycle_date, fhr))
    return out


def _ensure_rtofs_grid(ds) -> dict:
    """RTOFS 전지구 격자(Y=3298,X=4500)는 위경도가 2D 필드(Latitude/Longitude)로 저장돼
    있지만, 24~46N·115~142E 구간은 47N 이북 삼중극 캡과 달리 표준 메르카토르 패치라 **위도는
    Y 에만, 경도는 X 에만 의존**함을 실측으로 확인했다(같은 Y 의 서로 다른 X 컬럼 간 위도차
    0.0, 같은 X 의 서로 다른 Y 로우 간 경도차 0.0). 그래서 컬럼 0 하나·로우 0 하나만 읽으면
    전체 위경도축을 복원할 수 있다(2D 필드 전체를 받을 필요 없음). 격자 자체는 사이클마다
    바뀌지 않는 정적 모델 격자라 프로세스 수명당 1회만 계산해 캐시한다."""
    global _RTOFS_GRID_CACHE
    if _RTOFS_GRID_CACHE is not None:
        return _RTOFS_GRID_CACHE
    with _RTOFS_GRID_LOCK:
        if _RTOFS_GRID_CACHE is not None:
            return _RTOFS_GRID_CACHE
        lat_col0 = np.asarray(ds.variables["Latitude"][:, 0])
        lon_row0 = np.asarray(ds.variables["Longitude"][0, :])
        pad = _RTOFS_GRID_PAD
        y_lo = max(0, int(np.searchsorted(lat_col0, LAT_MIN)) - 1 - pad)
        y_hi = min(len(lat_col0) - 1, int(np.searchsorted(lat_col0, LAT_MAX)) + pad)
        x_lo = max(0, int(np.searchsorted(lon_row0, LON_MIN)) - 1 - pad)
        x_hi = min(len(lon_row0) - 1, int(np.searchsorted(lon_row0, LON_MAX)) + pad)
        _RTOFS_GRID_CACHE = {
            "y_lo": y_lo, "y_hi": y_hi, "x_lo": x_lo, "x_hi": x_hi,
            "lat_native": lat_col0[y_lo:y_hi + 1],
            "lon_native": lon_row0[x_lo:x_hi + 1],
        }
        return _RTOFS_GRID_CACHE


def _resample_rtofs_to_regular(native: np.ndarray, lat_native: np.ndarray,
                                lon_native: np.ndarray) -> np.ndarray:
    """분리형(rectilinear) 원 격자(위도 간격이 메르카토르라 미세하게 불균일, 경도는 거의
    균일 ~0.08°)를 축별(위도→경도 순) 선형보간으로 1/12° 균등 lat/lon 격자(`_RTOFS_LAT_TARGET`
    ×`_RTOFS_LON_TARGET`)에 옮긴다. `native` 는 육지/결측이 이미 NaN 로 채워진 배열 — NaN 산술은
    이웃 보간에 그대로 전파되므로(둘 중 하나라도 NaN 이면 결과도 NaN) 육지값이 해안 바다 픽셀로
    새어들지 않는다(추가 마스크 로직 불필요)."""
    idx0 = np.clip(np.searchsorted(lat_native, _RTOFS_LAT_TARGET) - 1, 0, len(lat_native) - 2)
    w0 = (_RTOFS_LAT_TARGET - lat_native[idx0]) / (lat_native[idx0 + 1] - lat_native[idx0])
    row_interp = native[idx0, :] * (1 - w0)[:, None] + native[idx0 + 1, :] * w0[:, None]

    idx1 = np.clip(np.searchsorted(lon_native, _RTOFS_LON_TARGET) - 1, 0, len(lon_native) - 2)
    w1 = (_RTOFS_LON_TARGET - lon_native[idx1]) / (lon_native[idx1 + 1] - lon_native[idx1])
    return row_interp[:, idx1] * (1 - w1)[None, :] + row_interp[:, idx1 + 1] * w1[None, :]


def _fetch_rtofs_one(cycle_date: datetime, fhr: int, now_utc: datetime) -> dict:
    """RTOFS 후보 하나(사이클+fhr)를 열어 SST 슬라이스를 받고 규칙 격자로 리샘플한 페이로드를
    만든다. 실패하면 예외를 그대로 던진다(호출측이 다음 후보로 넘어감)."""
    import netCDF4
    url = _rtofs_prog_url(cycle_date, fhr)
    ds = netCDF4.Dataset(url)
    try:
        grid = _ensure_rtofs_grid(ds)
        raw = ds.variables["sst"][0, grid["y_lo"]:grid["y_hi"] + 1, grid["x_lo"]:grid["x_hi"] + 1]
    finally:
        ds.close()
    native = (raw.filled(np.nan).astype(np.float64) if np.ma.isMaskedArray(raw)
              else np.asarray(raw, dtype=np.float64))
    regridded = _resample_rtofs_to_regular(native, grid["lat_native"], grid["lon_native"])
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    return {
        "valid_kst": kst.strftime("%Y-%m-%d %H:00"),   # 바람 valid_kst 와 항상 동일(같은 target 시각)
        "source": f"NOAA RTOFS 1/12° {cycle_date:%m/%d} 00z+{fhr:03d}h",
        "bounds": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "rows": _RTOFS_ROWS,
        "cols": _RTOFS_COLS,
        "data_bytes": _encode_int16(regridded, _SST_SCALE, _SST_OFFSET),
    }


def _run_with_timeout(fn, args: tuple, timeout: float):
    """`fn(*args)`를 데몬 스레드에서 실행하고 `timeout`초까지만 기다린다. **`ThreadPoolExecutor`
    는 쓰지 않는다** — 실측으로 확인한 함정: 풀의 워커 스레드는 데몬이 아니라서, `future.result
    (timeout=)`로 제때 포기해도 `concurrent.futures.thread` 의 `atexit` 훅이 그 스레드가 실제로
    끝날 때까지 **인터프리터 종료 자체를 막는다**(순수 `time.sleep(30)` 워커 하나로 재현: 호출
    측은 `timeout=2`로 정상 반환했는데도 프로세스가 30초간 안 죽었다). 이 백엔드는 무중단
    프로세스라 평상시엔 무해하지만, graceful shutdown(uvicorn SIGTERM)이 걸린 프레임 때문에
    멈춰버리면 운영 재기동 절차와 충돌한다 — 그래서 `daemon=True` 로 직접 스레드를 띄운다.
    데몬 스레드는 인터프리터 종료를 기다리게 하지 않으므로, 시간 초과로 포기해도 그 스레드는
    백그라운드에서 계속 블로킹되다 언젠가 끝나면 조용히 버려질 뿐이다."""
    box: dict = {}

    def _target() -> None:
        try:
            box["value"] = fn(*args)
        except Exception as e:  # noqa: BLE001 — 호출측에 그대로 재던지기 위해 저장
            box["error"] = e

    th = threading.Thread(target=_target, daemon=True)
    th.start()
    th.join(timeout)
    if th.is_alive():
        raise TimeoutError(f"{timeout:.0f}s 초과")
    if "error" in box:
        raise box["error"]
    return box.get("value")


def _fetch_rtofs_sst(now_utc: datetime) -> dict:
    """오늘→어제→그제 00Z 순으로 후보를 시도한다. 원격 바이트범위 오픈은 자체 타임아웃 제어가
    마땅치 않아(내부적으로 libcurl 을 쓰지만 파이썬 쪽에서 넘길 훅이 없다) 후보마다
    `_run_with_timeout` 으로 `_RTOFS_TIMEOUT_SEC` 상한을 강제한다."""
    candidates = _pick_rtofs_candidates(now_utc)
    if not candidates:
        raise RuntimeError("RTOFS 사이클 후보 없음(target 시각이 범위를 벗어남)")

    errors: list[str] = []
    for cycle_date, fhr in candidates:
        try:
            return _run_with_timeout(_fetch_rtofs_one, (cycle_date, fhr, now_utc),
                                      _RTOFS_TIMEOUT_SEC)
        except TimeoutError:
            errors.append(f"{cycle_date:%Y%m%d}+{fhr:03d}h: 타임아웃({_RTOFS_TIMEOUT_SEC:.0f}s)")
        except Exception as e:
            errors.append(f"{cycle_date:%Y%m%d}+{fhr:03d}h: {e}")

    raise RuntimeError("RTOFS 수온 수집 실패(전 후보): " + "; ".join(errors))


# ─────────────────────────────────────────────────────────────────────────
# 수온 2순위 = GFS TMP:surface(육지는 LAND:surface 로 마스킹) — RTOFS 수집 자체가 실패했을
# 때만 쓴다. 바람과 같은 사이클/예보시간을 재사용(ctx)해 추가 Range 요청 2개만 더 보낸다.
# 발행지연 0, 바람과 valid 시각이 정확히 같다.
# ─────────────────────────────────────────────────────────────────────────
def _fetch_gfs_sst_primary(ctx: tuple, now_utc: datetime) -> dict:
    """바람장과 같은 GFS 사이클/예보시간에서 표층기온(TMP:surface)을 추가로 받아 K→°C 변환하고
    LAND:surface(육지비율)로 마스킹한다. 실측 위성이 아니라 모델 분석치이므로 source 문자열에
    이를 명시한다(§CLAUDE.md 시연/모의 원칙) — RTOFS(해양모델 1순위)가 실패했을 때만 호출되는
    2순위: 위성(OISST)보다 발행지연이 없고 바람과 시각이 정확히 일치해 3순위 폴백보다 우선한다
    (RTOFS→GFS→OISST 3단, 코디네이터 지시, 2026-07-17)."""
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
        "data_bytes": _encode_int16(sst_c, _SST_SCALE, _SST_OFFSET),
    }


# ── 수온 3순위 = OISST v2.1 위성 일별 분석 — RTOFS·GFS 표층장 수집이 모두 실패했을 때만 쓴다.
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
                "data_bytes": _encode_int16(sub, _SST_SCALE, _SST_OFFSET),
            }
    raise RuntimeError("OISST D-1~D-5 전부 실패: " + "; ".join(errors))


def fetch_sst(now_utc: datetime, ctx: tuple) -> dict:
    """1순위(RTOFS 해양분석) 먼저 시도하고, 그 수집 자체가 실패했을 때만 2순위(GFS 표층수온,
    바람과 동일 사이클)로, 그마저 실패하면 3순위(OISST 위성)로 넘어간다."""
    try:
        return _fetch_rtofs_sst(now_utc)
    except Exception as e_rtofs:
        _log(f"RTOFS 수온 수집 실패, GFS 표층수온 폴백 시도: {e_rtofs}")
    try:
        return _fetch_gfs_sst_primary(ctx, now_utc)
    except Exception as e_gfs:
        _log(f"GFS 표층수온 수집 실패, OISST 폴백 시도: {e_gfs}")
        return _fetch_oisst_fallback(now_utc)


# ─────────────────────────────────────────────────────────────────────────
# 이진 프레임 조립(§27) — 4B length-prefix + 헤더 JSON + Int16 본문. `_do_refresh`/`_try_load_disk_cache`
# 가 만든 "논리 페이로드"(wind/sst 딕셔너리, 각 배열은 이미 `_encode_int16` 로 인코딩된 bytes)를 여기서
# 하나의 완성된 바이트열로 합친다 — 이후 `/api/field` 요청은 이 바이트열을 그대로 서빙하기만 한다.
# ─────────────────────────────────────────────────────────────────────────
def _field_header_meta(field: dict, scale: float, offset: float) -> dict:
    return {
        "valid_kst": field["valid_kst"],
        "source": field["source"],
        "bounds": field["bounds"],
        "rows": field["rows"],
        "cols": field["cols"],
        "dtype": "int16",
        "scale": scale,
        "offset": offset,
        "nodata": _INT16_NODATA,
    }


def _encode_frame(ready: bool, error: Optional[str], wind: Optional[dict], sst: Optional[dict]) -> bytes:
    """완성된 이진 프레임 1장을 만든다. `wind`/`sst` 는 각각 `u_bytes`/`v_bytes`, `data_bytes` 키에
    이미 인코딩된 Int16 바이트열을 담고 있어야 한다(모듈 상단 프레임 계약 참고). `ready=False` 면
    `wind`/`sst` 를 None 으로 넘겨 본문 없는(0바이트) 프레임을 만든다."""
    header: dict = {"ready": ready}
    if error is not None:
        header["error"] = error
    chunks: list[bytes] = []
    cursor = 0
    if wind is not None:
        u_b, v_b = wind["u_bytes"], wind["v_bytes"]
        header["wind"] = {
            **_field_header_meta(wind, _WIND_SCALE, _WIND_OFFSET),
            "u_offset": cursor, "u_length": len(u_b),
        }
        cursor += len(u_b)
        chunks.append(u_b)
        header["wind"]["v_offset"] = cursor
        header["wind"]["v_length"] = len(v_b)
        cursor += len(v_b)
        chunks.append(v_b)
    if sst is not None:
        d_b = sst["data_bytes"]
        header["sst"] = {
            **_field_header_meta(sst, _SST_SCALE, _SST_OFFSET),
            "data_offset": cursor, "data_length": len(d_b),
        }
        cursor += len(d_b)
        chunks.append(d_b)

    header_bytes = json.dumps(header, ensure_ascii=False).encode("utf-8")
    # 헤더 뒤(=본문 시작 오프셋 4+len) 를 짝수로 맞춰 이후 모든 배열이 Int16Array 2바이트 정렬을
    # 만족하게 한다(각 배열 길이 자체가 짝수이므로 시작점만 짝수면 연쇄적으로 전부 짝수 유지).
    if (4 + len(header_bytes)) % 2 != 0:
        header_bytes += b" "
    return len(header_bytes).to_bytes(4, "little") + header_bytes + b"".join(chunks)


def _peek_frame_header(payload_bytes: bytes) -> dict:
    """디스크에서 읽은 완성 프레임(bytes)에서 헤더 JSON 만 파싱한다(배열은 건드리지 않음) —
    부팅 시 OISST 폴백 캐시 시딩 여부 판단에만 쓴다."""
    if len(payload_bytes) < 4:
        return {}
    n = int.from_bytes(payload_bytes[:4], "little")
    try:
        return json.loads(payload_bytes[4:4 + n].decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {}


def _frame_payload_start(payload_bytes: bytes) -> int:
    n = int.from_bytes(payload_bytes[:4], "little")
    return 4 + n


# ─────────────────────────────────────────────────────────────────────────
# 인메모리 페이로드 + 디스크 캐시(현재 프레임 1장만 보존) — 서빙 단위는 이미 인코딩이 끝난 bytes
# 그 자체다(요청측 재인코딩 0, `_encode_frame` 은 갱신 시점에만 호출된다).
# ─────────────────────────────────────────────────────────────────────────
_LOCK = threading.Lock()
_PAYLOAD_BYTES: Optional[bytes] = None   # 최초 성공 전까지 None(= 아직 ready 프레임 없음)
_LAST_ERROR: Optional[str] = None

# 수온 1순위(RTOFS)·2순위(GFS)는 둘 다 매시 새로 받는다 — 아래 캐시는 오직 3순위 FALLBACK
# (OISST) 모드일 때만 쓰인다(OISST 는 일 단위 자료라 폴백 중에도 매시 재다운로드할 필요가 없다:
# §요구사항 "SST only when the date rolls or the previous attempt failed").
_SST_FALLBACK_CACHE: Optional[dict] = None
_SST_FALLBACK_CACHE_UTC_DATE: Optional[str] = None

_started = False
_start_lock = threading.Lock()

_BOOT_FRESH_SEC = 75 * 60      # 부팅 시 재사용할 디스크 캐시 신선도 상한(75분)
_RETRY_AFTER_FAIL_SEC = 600    # 수집 실패 시 재시도 대기(10분)


def get_field_payload_bytes() -> bytes:
    """`/api/field` 가 그대로 반환하는 완성된 이진 프레임 — 요청 스레드는 락만 잡고 참조를
    읽을 뿐 외부 호출·파싱·인코딩이 전혀 없다(사전 워밍 계약)."""
    with _LOCK:
        if _PAYLOAD_BYTES is not None:
            return _PAYLOAD_BYTES
        return _encode_frame(False, _LAST_ERROR, None, None)


def _swap_payload_bytes(payload_bytes: bytes) -> None:
    global _PAYLOAD_BYTES, _LAST_ERROR
    with _LOCK:
        _PAYLOAD_BYTES = payload_bytes
        _LAST_ERROR = None


def _set_error(msg: str) -> None:
    """수집 실패 기록 — **`_PAYLOAD_BYTES` 는 건드리지 않는다**(이전 성공 프레임을 그대로 stale
    서빙하는 게 요구사항). 아직 한 번도 성공한 적이 없을 때만(`_PAYLOAD_BYTES is None`)
    `get_field_payload_bytes()` 가 이 메시지를 담은 ready:false 프레임을 반환한다."""
    global _LAST_ERROR
    with _LOCK:
        _LAST_ERROR = msg
    _log(msg)


# ── 디스크 캐시: data/cache/field/field_{YYYYMMDDHH}.bin (KST 프레임 시각, 완성 이진 프레임 그대로)
# 항상 1개만 보존.
def _cache_path(now_utc: datetime) -> Path:
    kst = now_utc.replace(minute=0, second=0, microsecond=0) + timedelta(hours=9)
    return CACHE_DIR / f"field_{kst:%Y%m%d%H}.bin"


def _prune_old_cache_files(keep: Path) -> None:
    if not CACHE_DIR.exists():
        return
    for p in CACHE_DIR.glob("field_*.bin"):
        if p != keep:
            try:
                p.unlink()
            except OSError:
                pass


def _write_disk_cache(payload_bytes: bytes, now_utc: datetime) -> None:
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _cache_path(now_utc)
        path.write_bytes(payload_bytes)
        _prune_old_cache_files(path)
    except OSError as e:
        _log(f"디스크 캐시 쓰기 실패(무시하고 계속): {e}")


def _try_load_disk_cache() -> bool:
    """부팅 시 신선한(75분 미만) 캐시 파일이 있으면 그 바이트를 그대로 메모리에 올려 즉시
    ready=True 로 서빙을 시작한다(재인코딩 없음). 성공하면 True(배경 루프는 다음 정시+5분까지
    대기만 하면 됨), 없거나 낡았으면 False(호출측이 즉시 1회 수집을 수행)."""
    if not CACHE_DIR.exists():
        return False
    files = sorted(CACHE_DIR.glob("field_*.bin"))
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
        payload_bytes = path.read_bytes()
    except OSError as e:
        _log(f"디스크 캐시 읽기 실패: {e}")
        return False
    header = _peek_frame_header(payload_bytes)
    if not header.get("ready"):
        return False

    # 로드한 프레임의 sst 가 OISST 폴백 산출물이면(정상은 GFS 1차라 매시 다시 받으므로 이 시딩이
    # 불필요) FALLBACK 캐시도 같이 씨딩해, 부팅 직후 GFS 가 계속 실패하는 상황에서도 불필요한
    # OISST 재다운로드 없이 이어서 폴백을 쓸 수 있게 한다. 재인코딩 없이 이미 인코딩된 data_bytes
    # 세그먼트를 그대로 슬라이스해 재사용한다.
    global _SST_FALLBACK_CACHE, _SST_FALLBACK_CACHE_UTC_DATE
    sst_meta = header.get("sst") or {}
    if "OISST" in str(sst_meta.get("source", "")):
        start = _frame_payload_start(payload_bytes)
        d_off, d_len = sst_meta.get("data_offset"), sst_meta.get("data_length")
        if d_off is not None and d_len is not None:
            _SST_FALLBACK_CACHE = {
                "valid_kst": sst_meta["valid_kst"], "source": sst_meta["source"],
                "bounds": sst_meta["bounds"], "rows": sst_meta["rows"], "cols": sst_meta["cols"],
                "data_bytes": payload_bytes[start + d_off: start + d_off + d_len],
            }
            try:
                _SST_FALLBACK_CACHE_UTC_DATE = datetime.strptime(
                    sst_meta["valid_kst"][:10], "%Y-%m-%d"
                ).strftime("%Y%m%d")
            except (KeyError, ValueError):
                _SST_FALLBACK_CACHE_UTC_DATE = None

    _swap_payload_bytes(payload_bytes)
    _log(f"부팅: 신선한 캐시 재사용(age={age_sec / 60:.1f}분, {path.name})")
    return True


# ── 갱신 루프 ─────────────────────────────────────────────────────────────────
def _do_refresh() -> bool:
    """바람 + 수온 1순위(RTOFS 해양분석)는 매번 새로 받는다. RTOFS 수집 자체가 실패했을 때만
    2순위(GFS, 바람과 같은 라운드)로 넘어가고, 그마저 실패했을 때만 3순위(OISST)로 넘어간다.
    OISST 는 날짜가 바뀌었거나 이전 폴백 시도가 실패했을 때만 다시 받는다(일 단위 자료라 폴백
    중에도 매시 재다운로드할 필요가 없다). 성공하면 이진 프레임으로 인코딩해 통째로 스왑 +
    디스크에 쓰고 True. 실패하면 이전 페이로드를 그대로 유지(스왑하지 않음)하고 False(호출측이
    10분 뒤 재시도)."""
    global _SST_FALLBACK_CACHE, _SST_FALLBACK_CACHE_UTC_DATE
    now_utc = datetime.now(timezone.utc)

    try:
        wind, ctx = fetch_wind(now_utc)
    except Exception as e:
        _set_error(f"바람장 수집 실패, 이전 프레임 유지: {e}")
        return False

    try:
        sst = _fetch_rtofs_sst(now_utc)   # 1순위 — 해양모델 분석(전선·소용돌이 등 실제 구조)
    except Exception as e_rtofs:
        _log(f"RTOFS 수온 수집 실패, GFS 표층수온 폴백 시도: {e_rtofs}")
        try:
            sst = _fetch_gfs_sst_primary(ctx, now_utc)   # 2순위 — 바람과 valid 시각 항상 일치
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
                        _set_error(f"수온 전체 실패(RTOFS+GFS+OISST), 바람장도 보류: {e_oisst}")
                        return False
                    _log(f"OISST 폴백도 실패, 이전 수온 프레임 유지: {e_oisst}")
                    sst = _SST_FALLBACK_CACHE

    payload_bytes = _encode_frame(True, None, wind, sst)
    _swap_payload_bytes(payload_bytes)
    _write_disk_cache(payload_bytes, now_utc)

    size_kb = len(payload_bytes) / 1024
    _log(f"갱신 완료: wind={wind['source']} sst={sst['source']} ({size_kb:.1f}KB)")
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
