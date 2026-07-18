# Buoy Platform — API 자료조사 (실측)

> 조사일 2026-07-15. 모든 엔드포인트는 실제 키로 **curl 라이브 테스트**해 확정. 키는 [`../.env`](../.env)(`KMA_APIHUB_KEY`·`KHOA_DATA_KEY`)에서 참조. 지점 목록 원문은 [`reference/`](reference/).

> **⚠️ 스코프(2026-07-15): 부이 위주 — 조위관측소 제외.** 아래 KHOA `dtRecent`·`surveyTideLevel`·`surveyWaterTemp`·조위 60개소 목록은 **현 플랫폼 미사용(참고용 보존)**. 사용 대상은 KMA 해양기상/파고부이 + KHOA 해양관측부이 41 + 파랑(`noonWave`).

## 요약 — 기능별 권장 엔드포인트

| 기능 | 권장 API | 소스 |
|---|---|---|
| 지도 마커 시딩(좌표) | KMA `sea_obs.php`(stn=0) + 목록 3종 제원 | KMA |
| KHOA 지점 목록/좌표 | odcloud 조위 60·부이 41 운영현황 | KHOA |
| 전체 실시간 스냅샷(폴링) | KMA `sea_obs.php`(10분) | KMA |
| 부이 종합 실시간 | KHOA `twRecent` | KHOA |
| 조위관측소 종합 실시간 | KHOA `dtRecent` | KHOA |
| 파랑 특화(심해) | KHOA `noonWave`(KG_ 부이) | KHOA |
| 시계열+QC | KMA `kma_buoy2.php`(tm1~tm2, AQC/MQC) | KMA |
| 실측+예측 조위 | KHOA `surveyTideLevel`(bscTdlvHgt/tdlvHgt) | KHOA |
| 수온 | KHOA `surveyWaterTemp` | KHOA |
| 지도 바람장(2D 배경) | JMA MSM 5.5km `10u/10v` (RISH, Range) → GFS 0.25° 폴백 | JMA/NOAA (무키) |
| 지도 수온장(2D 배경) | NOAA RTOFS 1/12° `prog.nc`(netCDF Range) → GFS 표층 → OISST | NOAA (무키) |
| 지도 육지 마스크(정적) | GSHHG 풀해상도 해안선 → `landmask.png` | SOEST (무키) |

---

## 1. 기상청 API Hub (apihub.kma.go.kr)

- 인증: **`authKey`** 파라미터(평문, `KMA_APIHUB_KEY`). `serviceKey` 쓰면 401.
- 공통: 시각 **KST**, 결측 **`-99`/`-99.0`**, 응답 인코딩 **EUC-KR(CP949)** → UTF-8 변환 필수. `help=1` 로 스펙 덤프.
- Base: 실시간 `https://apihub.kma.go.kr/api/typ01/url/<name>.php` · 월보 `https://apihub.kma.go.kr/api/typ02/openApi/SeaMtlyInfoService/<op>`.

### 1-1. `sea_obs.php` — 해양 종합 관측자료 ★마스터/지도용
- `…/api/typ01/url/sea_obs.php?tm=YYYYMMDDHHMI&stn=0&authKey=KEY` (`tm` 10분 단위, `stn=0`=전체)
- **유일하게 위경도(LON/LAT)를 실시간값과 함께 제공** → 지도 배치 최적. 부이·파고부이·등표·표류·타워를 한 번에.
- 컬럼(12): `TP`(종류) · `STN_ID` · `STN_KO`(지점명) · `TM`(KST) · `WH`(유의파고 m) · `WD`(풍향°) · `WS`(풍속 m/s) · `WS_GST`(돌풍 m/s) · `TW`(수온℃) · `TA`(기온℃) · `PA`(해면기압 hPa) · `HM`(습도%) + QC 문자열.
- TP 코드: `B`=해양기상부이 · `C`=파고부이 · `D`=표류부이 · `L`=등표(AWS) · `N`=관측타워/파고AWS · `F`=해양관측장비 · `J`=서해종합기지(기상1호).
- 샘플: `B, 202507151000, 22101, 덕적도, 126.0188, 37.2361, 0.3, 234, 2.1, 2.7, 21.4, 21.1, 995.2, 88.0`

### 1-2. `kma_buoy.php` — 부이 실시간 상세
- `…/kma_buoy.php?tm=YYYYMMDDHHMI&stn=<id|0>&authKey=KEY` (요청시각 기준 -59~00분 자료, 공백구분)
- 컬럼(17): `TM`·`STN`·`WD1`·`WS1`·`WS1_GST`·`WD2`·`WS2`·`WS2_GST`·`PA`·`HM`·`TA`·`TW`·`WH_MAX`(최대파고 m)·`WH_SIG`(유의파고 m)·`WH_AVE`(평균파고 m)·`WP`(파주기 s)·`WO`(파향°). 풍센서 2조 운영.

### 1-3. `kma_buoy2.php` — QC/기간조회 ★시계열용
- `…/kma_buoy2.php?tm1=<시작>&tm2=<종료>&stn=<id>&authKey=KEY` (콤마 CSV, 행끝 `,=`)
- kma_buoy.php 17개 + **`AQC`**(자동 QC)·**`MQC`**(수동 QC). QC 는 자리별 플래그 문자열(`/`=미검사, 결측 `-99`). → 시계열 적재·QC 병합에 사용.

### 1-4. openApi 목록 테이블 (지점 제원)
- `…/api/typ02/openApi/SeaMtlyInfoService/<op>?authKey=KEY&pageNo=1&numOfRows=1&dataType=JSON&year=2024&month=12`
- **필수: `year`·`month`·`pageNo`·`numOfRows`**. 응답의 `…items.item[0].<key>.info[]` 배열에 전체 지점.

| op | key | 지점수 | 필드 |
|---|---|---|---|
| `getBuoyLstTbl` | `stn_buoy` | 31 | stn_id·stn_ko·stn_en·form(형식)·lon·lat·ht_wd·ht_ta·ht_pa·ht_tw·ht_wh |
| `getWaveBuoyLstTbl` | `stn_waveBuoy` | 75 | stn_id·stn_ko·stn_en·lon·lat·ht_tw·ht_wh |
| `getLhawsLstTbl` | `stn_lhaws` | 9 | stn_id·stn_ko·stn_en·lon·lat·ht_wd·ht_ta·ht_ps·ht_tw·ht_wh |

- 용도: 실시간 API 에 없는 **영문명·부이형식·센서고** 확보(툴팁/상세). 원문 [`reference/kma_lst_tables.txt`](reference/kma_lst_tables.txt).

### 1-5. 일 통계 (과거 이력 — 기존 authKey로 사용 가능)
- `getDailyBuoy`(해양기상부이)·`getDailyWaveBuoy`(파고부이)·`getDailyLhaws`(등표) → 기존 authKey로 **정상(resultCode 00)**. `station`+`year`+`month` 로 **일 통계**(유의파고·최대파고·파주기·수온 등) 반환. **2017년~현재**(발간지연 ~1.5개월 — 이번 달·전월 일부는 아직 미발간이라 그 월만 조회하면 "발간되지 않은 기간" 메시지). 신규 신청 불필요.
- **파고부이(C) 과거 이력의 정본**: kma_buoy.php/kma_buoy2.php 는 C형 미지원 → 과거는 `getDailyWaveBuoy`(일 해상도). 해양기상부이(B) 과거는 kma_buoy2.php(30분 고해상).
- (초기 조사에서 '전 기간 미발간'으로 기술했던 것은 너무 최근 월만 조회해 발간지연을 하드블록으로 오판한 것 — 2026-07-15 실측으로 정정.)

### 1-6. 실시간 관측망 현황 (sea_obs, 2026-07-15 10:00 기준) — 총 186지점
| TP | 종류 | 개수 |
|---|---|---|
| B | 해양기상부이 | 40 |
| C | 파고부이 | 64 |
| N | 관측타워/파고AWS | 49 |
| F | 해양관측장비 | 17 |
| L | 등표(AWS) | 9 |
| D | 표류부이 | 6 |
| J | 서해종합기지 | 1 |
- 좌표 범위 대략 위도 24.98~38.37 / 경도 121.96~131.87. 결측은 `-99`, QC 플래그 `1`=이상치. 전 지점 통합표 [`reference/kma_stations.txt`](reference/kma_stations.txt).

---

## 2. 국립해양조사원 KHOA (공공데이터포털)

- 인증: **`serviceKey`**(인코딩 형태 `KHOA_DATA_KEY` 그대로; 코드에서 `urllib.parse.unquote` 1회 후 requests `params=` 전달).
- 공통: **`type=json` 명시**(미지정 시 XML), **`obsCode` 필수**(전체 일괄 조회 불가 → 지점별 순회), 개발계정 **일 10,000건/서비스**.
- ⚠️ **`www.khoa.go.kr/api/oceangrid/*` 는 이 서버 IP 차단(307→/503.html).** 반드시 아래 `apis.data.go.kr`·`api.odcloud.kr` 사용.

### 2-1. 실시간 오픈API (`apis.data.go.kr`, org 1192136)
공통 파라미터: `serviceKey`(필수) · `obsCode`(필수) · `type=json` · `reqDate=yyyyMMdd`(옵션, 기본 오늘) · `min`(분간격, 기본1 최대60) · `numOfRows`(기본10 최대300) · `pageNo`.
> 조위(1분·1440건/일)는 `numOfRows` 300 한계로 하루 전체 못 받음 → `min` 상향 또는 페이징.

| 서비스 | 엔드포인트 | 주요 응답필드(단위) |
|---|---|---|
| 부이 최신 종합 ★ | `/1192136/twRecent/GetTWRecentApiService` | wndrct(풍향°)·wspd(풍속 m/s)·maxMmntWspd·artmp(기온℃)·atmpr(기압 hPa)·**wvhgt(파고 m)**·**wvpd(파주기 s)**·crdir(유향°)·**crsp(유속 cm/s)**·wtem(수온℃)·slnty(염분 psu) |
| 조위관측소 최신 종합 | `/1192136/dtRecent/GetDTRecentApiService` | wndrct·wspd·maxMmntWspd·artmp·atmpr·wtem·**bscTdlvHgt(조위 cm)**·slntQty(염분)·crdir·crsp(m/s) |
| 국가해양관측망 파랑 | `/1192136/noonWave/GetNoonWaveApiService` | wvhgt(파고 m)·wvpd(파주기 s)·wvdrct(파향°)·maxWvhgt·maxWvpd (30분 간격, KG_ 심해부이 품질 최적) |
| 실측·예측 조위 | `/1192136/surveyTideLevel/GetSurveyTideLevelApiService` | **bscTdlvHgt(실측 cm)**·**tdlvHgt(예측 cm)**·obsrvnDt (1440건/일) |
| 실측 수온 | `/1192136/surveyWaterTemp/GetSurveyWaterTempApiService` | **wtem(수온℃)**·obsrvnDt |

- 공통 부가필드: `obsvtrNm`(관측소명)·`lat`(위도)·`lot`(경도)·`obsrvnDt`(관측일시).
- ⚠️ **`crsp` 단위 불일치**: dtRecent=m/s, twRecent=cm/s → 표시 시 서비스별 변환. 센서 미탑재 항목은 `null`.
- 예: `curl "https://apis.data.go.kr/1192136/twRecent/GetTWRecentApiService?serviceKey=<ENCODED>&obsCode=TW_0095&type=json"` (**https** 정상 확인 2026-07-15). `twRecent`는 최신 1건이 아니라 **최근 롤링 시계열**(1분 간격 다수 레코드)을 반환.

### 2-2. 지점 목록 (`api.odcloud.kr`, 파일데이터 자동API)
`page`·`perPage` 파라미터 사용(`type` 대신), `serviceKey` 동일.

| 목록 | URL | 개수 | 필드 |
|---|---|---|---|
| 조위관측소 운영현황 | `https://api.odcloud.kr/api/15146602/v1/uddi:81b0665b-4f21-41e8-91f1-d3ecc4a7a3f1` | 60 | 고유번호(=obsCode)·명·영문명·유형·위도·경도 |
| 해양관측부이 운영현황 | `https://api.odcloud.kr/api/15146611/v1/uddi:8bd2eb44-1a6a-4089-9935-803551fa3322` | 41 | 고유번호(=obsCode)·명·영문명·유형·위도·경도 |

### 2-3. KHOA 관측망 (지도 배치용) — 원문 [`reference/khoa_stations.txt`](reference/khoa_stations.txt)
- **조위관측소 60** = 일반 조위(`DT_`) 57 + 종합해양과학기지(`IE_`) 3. 예: DT_0001 인천 · DT_0005 부산 · DT_0004 제주 · DT_0013 울릉도 · IE_0060 이어도.
- **해양관측부이 41**(유형 `TW`): `TW_` 26(연안·항만·해수욕장) · **`KG_` 6(국가해양관측망 심해부이 — KG_0024 대한해협 등, 파랑 품질 최적)** · `HB_` 6(한수원 원전인근) · `YS_` 3(여수해만).

---

## 3. 공개 오픈데이터 (무키·무신청) — 지도 2D 필드 오버레이 전용

> 실측일 2026-07-16~18. **관측(부이)과 별개 계통**이다 — 필드는 모델/위성 격자값이므로 지도 배경으로만 쓰고, 마커·팝업·시계열의 관측값과 혼동시키지 않는다(범례에 출처·기준시각 명시). 전부 무키·무신청. 소스는 **최근성(무발행지연) + 고해상도**를 기준으로 선정했고, 각 필드는 **3단 폴백**(주 소스 실패 시 하향)을 둔다.

### 3-1. 바람장 — JMA MSM 5.5km (주) → GFS 0.25° (폴백)

- **JMA MSM**(일본 기상청 메소모델, 지상 10m 바람): 교토대 RISH 학술 미러(무키).
  `http://database.rish.kyoto-u.ac.jp/arch/jmadata/data/gpv/original/{YYYY}/{MM}/{DD}/Z__C_RJTD_{YYYYMMDDHH}0000_MSM_GPV_Rjp_Lsurf_FH00-15_grib2.bin`
  - 격자(GRIB2 섹션3 실측): **481×505, 경도 120~150° / 위도 22.4~47.6°, di=0.0625°·dj=0.05° ≈ 5.5km**. 사이클 00/03/06/09/12/15/18/21Z, `Lsurf_FH00-15`=+0~15h. RISH 발행 지연 **약 5~8h** → 사이클+예보시간(FH)으로 목표 시각을 맞춘다(GFS 도 예보시간을 쓰므로 성격 동일).
  - 파일이 **69MB 단일 GRIB2 멀티필드 메시지**(section0/1/3 공유 + section4~7 이 190회 반복)다. ⚠️ `eccodes.codes_new_from_message` 로 열면 **첫 필드(prmsl)만 조용히 반환**하고 나머지(10u/10v 포함)를 버린다 — `codes_grib_multi_support_on()` + 파일 이터레이션 필수.
  - 필드 순서는 매시 고정(`[prmsl, sp, 10u, 10v, t2m, r2m, lcc, mcc, hcc, tcc]` + 1h부터 누적 2필드), 바이트 길이도 사이클 불변 → 10u/10v 바이트 오프셋을 헤더 1회 읽기로 **산식 계산**. `Accept-Ranges: bytes` 지원 → 실측 **Range 요청 2회·0.57s·729KB**(전체 69MB 미다운로드).
  - **영역**: MSM 교집합 `[120,24,142,46]` 로 자른다. 서쪽 115~120°E 는 바람장이 없다(사용자 확정 — GFS 이어붙이기 안 함). MSM 은 **첫 행이 북쪽**(lat 47.6→22.4)이라 우리 규약(row0=남단)에 맞춰 **뒤집는다**.
- **폴백 GFS 0.25°**: `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{YYYYMMDD}/{CC}/atmos/gfs.t{CC}z.pgrb2.0p25.f{FFF}` — `.idx` 사이드카로 `UGRD/VGRD:10 m above ground` 레코드 바이트범위만 Range. 폴백 시 bounds 는 `[115,24,142,46]`·89×109 로 복귀. NOMADS filter CGI(`nomads.ncep.noaa.gov`)는 최후 폴백.

### 3-2. 수온장 — NOAA RTOFS 1/12° (주) → GFS 표층 (폴백) → OISST (최후)

- **RTOFS**(NCEP 전지구 해양모델, HYCOM 기반): 위성·부이·Argo 동화라 쿠로시오·전선·소용돌이 등 실제 해양 구조가 보인다(GFS 표층 대비 수온 기울기 **1.8~2배**, 기울기 편차 **2.7배**).
  - ⚠️ SST 는 AWS `noaa-nws-rtofs-pds` 의 `diag.nc`/`ice.nc` 엔 **없다**. `prog.nc` 에만 있고 이건 **NOMADS HTTPS 만** 배포:
    `https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod/rtofs.{YYYYMMDD}/rtofs_glo_2ds_f{FFF}_prog.nc`
  - NOMADS **OpenDAP 은 2026-02-23 공식 폐지**(SCN 25-81) → 서버측 서브셋 불가. 대신 `prog.nc`(~150~195MB)가 HDF5 청크 `(1,825,1125)` 라 **한반도 박스가 청크 1개 안에** 들어가, netCDF4 `#mode=bytes` HTTP Range 로 그 청크만 읽는다(실측 open+read **1.5~2s**). fsspec/s3fs 불필요.
  - 전지구 curvilinear 격자지만 24~46N/115~142E 구간은 **rectilinear**(47°N tripolar cap 이남) — 축 재구성 후 **1/12° 정규격자 265×325** 로 분리형 선형 리샘플(NaN-safe, 육지 미번짐). 사이클 1일 1회(00Z), f000~f072 시간별, 발행 지연 실측 **~12.5h** → `fhr = 목표시 − 사이클시`. **row0=남단** 규약 준수.
- **폴백 GFS 표층**: `TMP:surface` 를 `LAND:surface`(1=육지)로 마스킹(K→℃). ⚠️ **idx 매칭은 `VAR:LEVEL:` 완전일치** — 부분문자열이면 `ICETMP:surface:` 에 걸려 바다 격자가 전부 `9999` 센티널이 된다(실측·수정 버그).
- **최후 OISST v2.1**: `https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{YYYYMM}/oisst-avhrr-v02r01.{YYYYMMDD}{suffix}.nc`(`_preliminary`→최종). **발행 지연 D-2**(2026-07-16 09 UTC 실측: 당일·전일 404, `20260714_preliminary` 만 200. CRW 5km `coraltemp` 도 D-2) — 최근성 부적합이라 최후 폴백만. D-1→D-5 역탐색.

### 3-3. 해안선 마스크 — GSHHG 풀해상도 (정적)

- SST 값 격자(9km)로는 작은 섬·복잡 해안선을 못 그려 섬 안쪽까지 색이 번진다 → **값 해상도와 경계 해상도를 분리**. 정밀 해안선으로 정적 육지 마스크를 구워 표출을 실제 해안선에서 잘라낸다(해안선은 불변 → 시간별 갱신과 무관, 1회 빌드).
- 소스: `https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip`(149MB, `GSHHS_f_L1.shp` = 풀해상도 육지). NGDC `/latest/` 경로는 404 — SOEST 미러 사용. 처리는 `pyshp`+`Pillow` 만(무 GDAL): 도메인 내 7,533 폴리곤을 4배 슈퍼샘플 래스터화→다운샘플해 **4829×3935(≈510×620m) 그레이스케일 커버리지 마스크** 생성. 산출물 `frontend/public/landmask.png`(**184KB**, 브라우저 1회 로드·캐시) + `landmask.json`(bounds/치수/행방향). 빌드 스크립트 `scripts/build_landmask.py`.
- 프론트 셰이더는 이 마스크를 **주 게이트**(`smoothstep`)로, RTOFS 자체 nodata 를 보조로 써서 실제 해안선까지 바다색을 채우고(육지 셀은 nearest-sea-fill 로 색 연장) 섬을 정확히 뚫는다. 실측: 마라도·가거도·독도·울릉도 마스크(diff≈0), 바다 색 유지(diff 66~74).

### 3-4. 운영 (`backend/field_service.py`)

- 매시 새 프레임을 받아 인메모리 원자 교체 + `data/cache/field/` 의 이전 파일 삭제(**현재 1프레임만 유지**). 프론트는 `/api/field` 1회로 즉시 렌더(zero-loading). 수집 실패 시 직전 프레임 계속 서빙(stale)·재시도, 부팅 시 캐시 75분 이내만 채택.
- **페이로드는 이진**: `[uint32 헤더길이][JSON 헤더][Int16 스케일 본문]` 단일 응답 + `GZipMiddleware`. Int16(scale 0.01, 육지 nodata=-32768)이라 JSON 대비 값당 6→2B. 바람 5.5km(441×353) + 수온 9km(265×325) 네이티브를 담고 **원시 776KB / gzip 전송 470KB(47ms)** — 이전 GFS 28km JSON(181KB, 89×109)보다 격자를 8배 늘리고도 전송량은 유사, 표기 해상도(범례 "5km")와 실제가 일치.

---

## 4. 구현 유의사항 (파서/폴링)

1. KMA: EUC-KR 디코드 → `#`/`9999`/빈줄 스킵 → `-99` 결측 → KST 그대로. 10분 격자 반올림.
2. KHOA: `serviceKey` 1회 unquote, `type=json` 고정, 지점별 순회 → 캐시(변동 적은 목록은 장기, 실시간은 폴링주기), 일 10,000건 한도 관리.
3. 좌표: KMA 는 `sea_obs.php` 고정밀 LON/LAT, KHOA 는 운영현황 위경도. 소스 태그 유지(병합 안 함).
4. 단위 정규화 계층 필요(`crsp` m/s↔cm/s, 파고/조위 등).

## 출처
- 기상청 API허브 해양관측: https://apihub.kma.go.kr/apiList.do?seqApi=3
- 공공데이터포털 해양기상월보: https://www.data.go.kr/data/15059094/openapi.do
- KHOA 서비스: data.go.kr 15142507(조위)·15142506(수온)·15155508(dtRecent)·15155516(twRecent)·15155994(noonWave)·15146602/15146611(운영현황)
- JMA MSM (교토대 RISH 미러): http://database.rish.kyoto-u.ac.jp/arch/jmadata/
- NOAA GFS (AWS Open Data): https://registry.opendata.aws/noaa-gfs-bdp-pds/ · NOMADS: https://nomads.ncep.noaa.gov/
- NOAA RTOFS (NOMADS): https://nomads.ncep.noaa.gov/pub/data/nccf/com/rtofs/prod/
- NOAA OISST v2.1 (AWS Open Data): https://registry.opendata.aws/noaa-cdr-oceanic/
- GSHHG 해안선 (SOEST Hawaii): https://www.soest.hawaii.edu/pwessel/gshhg/
