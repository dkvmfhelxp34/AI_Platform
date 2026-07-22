# Buoy Platform — 다기관 해양부이 통합 모니터링 플랫폼

> 여러 기관(기상청·국립해양조사원)의 해상 부이를 지도 위에서 실시간 모니터링하고, 알고리즘/AI 기반 시계열 QC 와 24시간 예측을 함께 표출하는 **시연용** 플랫폼.

한반도 주변 해역의 해양기상부이·파고부이(기상청)와 해양관측부이(국립해양조사원)를 하나의 위성 지도에 모아, 수신 상태·실시간 관측값·시계열·이상치(QC)를 한눈에 확인할 수 있게 한다.

<p>
  <img src="docs/hero_overview.png" alt="지도 대시보드 — 위성 베이스 + 바람장·수온장 오버레이" width="49%"/>
  <img src="docs/hero_detail.png" alt="부이 상세 — 시계열·QC·가상 예측" width="49%"/>
</p>

## 주요 기능

- **지도 모니터링** — 위성 / 라이트 / 다크 3종 베이스맵 위에 기관/종류별 부이 마커. 수신 상태(정상 수신 / 수신 지연 / 미수신)를 색으로 표시.
- **2D 필드 오버레이** — 현재 시각 기준 바람장(JMA MSM 5.5km GPU 파티클) · 수온장(NOAA RTOFS 1/12° 스칼라 래스터)을 지도에 투영(마커 아래). GSHHG 풀해상도 해안선으로 육지·섬을 정밀 마스킹. *모델/위성 자료이며 부이 관측값과 출처가 다름을 범례에 명시.*
- **부이 팝업 & 상세** — 클릭 시 기본 관측값 팝업 → 상세 드로어(지점 제원 · 현재 관측 · 시계열).
- **시계열 & QC** — 파고/수온/풍속/기압 시계열(1일·7일·30일·1년). **알고리즘 AI-QC**(robust z-score 튐값·결측 자동 탐지) 플래그를 차트에 표시(표출되는 유일한 이상 신호). 관측기관 QC(기상청 AQC/MQC)는 이상치 플래그가 아니라 기관 내부 상태코드로 확인되어 표출하지 않는다. Y축은 지점·구간별 실측 변동폭에 맞춰 동적으로 잡힌다.
- **가상 24h 예측** — 관측 기반 합성 예측(추세+일주기)을 시계열에 오버레이. *시연용 모의 예측이며 실제 예보가 아님.*
- **AI 챗봇** — `claude -p`(Sonnet) 기반. 부이 조회·상태·시계열 요약·QC·예측 도구를 백엔드가 실행해 **조회된 값으로만** 답한다(환각 차단). 흔한 운영 질의는 LLM 없이 집계로 즉답(결정론 단락). 대화는 세션별로 7일 보존되어 새로고침·재시작 후에도 이어진다.
- **반응형** — FHD~UHD(3840×2160) 대응. 지도 캔버스는 원해상도를 유지하고 UI 크롬만 배율.

## 기술 스택

| 영역 | 스택 |
|---|---|
| 프론트엔드 | React 18 · Vite · TypeScript · Zustand · **MapLibre GL** · Recharts · Pretendard |
| 백엔드 | FastAPI · uvicorn (포트 `8506`) — React 정적 서빙 + `/api/*` |
| LLM | `claude -p` CLI (Sonnet) — GPU 서버 의존 없음 |
| 데이터 | 기상청 API Hub · 국립해양조사원 공공데이터포털 (부이 위주) |
| 필드 오버레이 | JMA MSM(바람) · NOAA RTOFS(수온) · GSHHG(해안선) — 무키 오픈데이터 |

## 데이터 소스 (부이 위주, 조위관측소 제외)

- **기상청 API Hub** (`apihub.kma.go.kr`) — `sea_obs.php`(전 지점 실시간+좌표), `kma_buoy2.php`(부이 상세·기간조회·QC 플래그), 지점 제원 목록.
- **국립해양조사원**(공공데이터포털 `apis.data.go.kr` / `api.odcloud.kr`) — 해양관측부이 `twRecent`(최신 롤링), `noonWave`(심해 부이 파랑), 부이 운영현황 41개소.
- 상세 엔드포인트·파라미터·필드·지점 목록은 `docs/API_RESEARCH.md` 참고.

> API 키는 저장소에 포함되지 않는다. `.env.example` 을 복사해 `.env` 에 각자 발급받은 키를 채운다.

## 프로젝트 구조

```
Buoy_platform/
├── backend/            FastAPI (:8506)
│   ├── main.py         앱·라우트 (/api/stations·live·status·timeseries·forecast·chat)
│   ├── kma_marine.py   기상청 sea_obs/kma_buoy2 래퍼 (EUC-KR·-99·KST)
│   ├── khoa_api.py     국립해양조사원 data.go.kr 래퍼 (부이)
│   ├── live_cache.py   백그라운드 스냅샷 리프레셔 (커버리지·프레시니스)
│   ├── live_snapshot.py 전 부이 라이브 스냅샷 + 상태 집계
│   ├── stations.py     지점 레지스트리 (제원·좌표 병합, 소스 태그)
│   ├── status.py       수신상태 판정 (freshness)
│   ├── qc.py           알고리즘 AI-QC (스파이크·결측)
│   ├── forecast.py     가상 24h 예측
│   ├── timeseries.py   시계열 정규화 (관측 + QC 병합)
│   ├── chat.py         AI 챗봇 (claude -p · 도구루프 · 세션기억)
│   └── tests/          스모크 테스트
├── frontend/           React + Vite + MapLibre
│   └── src/            App · store · index.css · components/{MapViewGL,DetailDrawer,LeftPanel,Header,ChatPanel}
├── docs/               API 자료조사·스크린샷
│   ├── API_RESEARCH.md  KMA·KHOA 엔드포인트 실측 정본
│   └── reference/      지점 목록 원문 (공개 데이터)
└── .env.example        환경변수 예시 (실제 .env 는 미포함)
```

## 실행

사전: Python 3.11 (conda env 권장), Node 18+, 발급받은 API 키.

```bash
# 1) 환경변수
cp .env.example .env          # .env 에 KMA/KHOA 키 입력
set -a; source ./.env; set +a

# 2) 백엔드 (conda env 예: buoy)
pip install fastapi uvicorn requests python-dotenv numpy httpx
python backend/main.py        # http://localhost:8506

# 3) 프론트 빌드 (백엔드가 dist 를 서빙)
npm --prefix frontend install
npm --prefix frontend run build
```

개발 모드는 Vite dev 서버(`npm --prefix frontend run dev`, `/api`→8506 프록시)를 병행한다.

## 진행 상태 (로드맵)

- [x] 데이터 계층 (기상청·국립해양조사원 부이 래퍼, 지점 레지스트리 — 약 140개소, 무데이터 지점 자동 제외로 총계 변동)
- [x] 지도 MVP (위성/라이트/다크 · 상태 마커 · 팝업)
- [x] 2D 필드 오버레이 (JMA MSM 바람 · NOAA RTOFS 수온 · GSHHG 해안선 마스크 · 현재 1프레임)
- [x] 상세 드로어 + 시계열 (관측기관 QC 플래그 · 적응형 축)
- [x] 알고리즘 AI-QC (스파이크·결측) · 라이브 커버리지/프레시니스
- [x] 프론트 UI 개편 (다크 엘리베이션 · 원클릭 인터랙션 · 좌패널 유형 토글 · AI-QC/예측 오버레이)
- [x] 가상 24h 예측 표출 ("모의/시연" 명시)
- [x] AI 챗봇 (`claude -p`) — 도구 기반 응답 · 대화기억 7일 · 인젝션 방어
- [x] FHD~UHD 반응형
- [ ] 배포(systemd 유닛) · 데모 게이트 e2e
- [ ] 국립해양조사원 라이브 커버리지 확대 · 번들 코드스플릿

API 엔드포인트·지점 목록 등 데이터 근거는 [`docs/`](docs/) 참고.
