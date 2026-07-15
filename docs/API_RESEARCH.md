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

### 1-5. 월보 일통계 (미사용)
- `getDailyBuoy`·`getDailyWaveBuoy`·`getDailyLhaws`·`getObsOpenYear` → apihub authKey 로는 **전 기간 "발간되지 않은 기간입니다"(resultCode 99)**. 실시간 모니터링엔 불필요. 필요 시 data.go.kr `apis.data.go.kr/1360000/SeaMtlyInfoService` + data.go.kr serviceKey 로 분리 접근.

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

## 3. 구현 유의사항 (파서/폴링)

1. KMA: EUC-KR 디코드 → `#`/`9999`/빈줄 스킵 → `-99` 결측 → KST 그대로. 10분 격자 반올림.
2. KHOA: `serviceKey` 1회 unquote, `type=json` 고정, 지점별 순회 → 캐시(변동 적은 목록은 장기, 실시간은 폴링주기), 일 10,000건 한도 관리.
3. 좌표: KMA 는 `sea_obs.php` 고정밀 LON/LAT, KHOA 는 운영현황 위경도. 소스 태그 유지(병합 안 함).
4. 단위 정규화 계층 필요(`crsp` m/s↔cm/s, 파고/조위 등).

## 출처
- 기상청 API허브 해양관측: https://apihub.kma.go.kr/apiList.do?seqApi=3
- 공공데이터포털 해양기상월보: https://www.data.go.kr/data/15059094/openapi.do
- KHOA 서비스: data.go.kr 15142507(조위)·15142506(수온)·15155508(dtRecent)·15155516(twRecent)·15155994(noonWave)·15146602/15146611(운영현황)
