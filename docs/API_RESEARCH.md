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
| 지도 바람장·수온장(2D 배경) | GFS 0.25° `UGRD/VGRD@10m` + `TMP:surface`×`LAND:surface` (AWS `.idx`+Range) | NOAA (무키) |

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

## 3. NOAA 공개 오픈데이터 (무키·무신청) — 지도 2D 필드 오버레이 전용

> 실측일 2026-07-16. **관측(부이)과 별개 계통**이다 — 필드는 모델/위성 격자값이므로 지도 배경으로만 쓰고, 마커·팝업·시계열의 관측값과 혼동시키지 않는다(범례에 출처·기준시각 명시). 인증키가 없어 신청 절차도 없다.

### 3-1. GFS 0.25° (바람장 + 표층수온) — 채택

- 버킷: `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.{YYYYMMDD}/{CC}/atmos/gfs.t{CC}z.pgrb2.0p25.f{FFF}`
- **전체 GRIB 를 받지 않는다.** 같은 이름 + `.idx` 사이드카(텍스트)를 먼저 받아 필요한 레코드의 바이트 오프셋을 구하고, 본 파일에는 `Range:` 헤더로 해당 구간만 요청한다. 한반도 영역 4개 레코드 합계가 수백 KB 수준.
- 사용 레코드: `UGRD:10 m above ground` · `VGRD:10 m above ground` · `TMP:surface` · `LAND:surface`
- **수온**: `pgrb2` 에 `WTMP` 는 **없다**. 대신 `TMP:surface` 를 `LAND:surface`(1=육지) 로 마스킹하면 해수면온도가 된다(K→℃). GFS 표층 분석은 위성 SST 를 동화한 값이며, **바람장과 같은 파일·같은 기준시각**이라 발행 지연이 0 이고 두 필드의 시각이 정확히 일치한다.
- ⚠️ **idx 매칭은 반드시 `VAR:LEVEL:` 완전일치**로 할 것. 부분문자열 포함(`"TMP:surface:" in line`)으로 찾으면 `ICETMP:surface:` 에 먼저 걸려 엉뚱한 바이트 범위를 잡고, 바다 격자가 전부 `9999` 센티널로 나온다(실제 발생·수정한 버그).
- 폴백: NOMADS filter CGI `https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25_1hr.pl`(한반도 서브셋 실측 27,694 B · 0.45 s). AWS 도달 불가 시에만.
- 최신 사이클 탐색: 발행 지연을 감안해 최신 사이클부터 시도하고 실패 시 이전 사이클로 내려간다.

### 3-2. OISST v2.1 (위성 수온) — 폴백만

- `https://noaa-cdr-sea-surface-temp-optimum-interpolation-pds.s3.amazonaws.com/data/v2.1/avhrr/{YYYYMM}/oisst-avhrr-v02r01.{YYYYMMDD}{suffix}.nc` (`suffix` = `_preliminary` 우선 → 최종본)
- **발행 지연 D-2.** 2026-07-16 09 UTC 실측: `20260716`·`20260715` 는 예비본/최종본 모두 404, `20260714_preliminary` 만 200. NOAA CRW 5km `coraltemp` 도 동일하게 D-2.
- 따라서 "현재 시점(KST)" 서사에는 부적합 → **GFS `TMP:surface` 를 1순위로, OISST 는 GFS 표층 수신 실패 시 폴백**으로만 쓴다. 폴백 시 D-1→D-5 역탐색.

### 3-3. 운영 (`backend/field_service.py`)

- 매시 +5분에 새 프레임을 받아 인메모리 원자 교체 + `data/cache/field/` 의 이전 시각 파일 삭제(**현재 1프레임만 유지**). 프론트는 `/api/field` 1회 호출로 즉시 렌더(zero-loading).
- 수집 실패 시 직전 프레임을 계속 서빙(stale)하고 10분 뒤 재시도. 부팅 시 캐시 파일은 75분 이내인 경우만 채택.
- 실측 페이로드: 89×109 격자(bounds 115~142E, 24~46N), 바람+수온 합계 **181 KB**.

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
- NOAA GFS (AWS Open Data): https://registry.opendata.aws/noaa-gfs-bdp-pds/ · NOMADS: https://nomads.ncep.noaa.gov/
- NOAA OISST v2.1 (AWS Open Data): https://registry.opendata.aws/noaa-cdr-oceanic/
