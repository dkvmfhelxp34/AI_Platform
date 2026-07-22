// Buoy Platform — 공용 타입 정의. backend/main.py 응답 스키마와 1:1 대응.

/** 지점 제원 세부 항목(센서 설치고/수심 등) — Wave 2 백엔드가 `sensor_heights`(간단 map)를
 *  `specs`(단위·부가값 포함 구조체)로 대체했다. 전체 연구용 제원 표출 재설계는 Wave 3 범위이며,
 *  여기서는 DetailDrawer 가 크래시 없이 렌더되도록 최소 shim 타입만 둔다. */
export interface StationSpecField {
  value_m: number | null
  secondary_value_m?: number | null
  unit: string
  below_surface?: boolean
  label: string
}

/** GET /api/stations 항목 — 지점 제원(제원 시딩 + 좌표). */
export interface StationMeta {
  source: 'KMA' | 'KHOA'
  id: string
  stn_id?: string
  tp: string            // 'B'(해양기상부이) | 'C'(파고부이) | 'KG'(KHOA 심해부이) 등
  tp_label?: string
  name: string
  name_en?: string
  type?: string
  lon: number
  lat: number
  form?: string
  specs?: Record<string, StationSpecField> | null
  obs_code?: string
  /** 관측개시일(KHOA oceangrid pointDetail.do 실측, KMA 는 미보유 → undefined). 지어내지 말 것. */
  obs_start_date?: string | null
  /** 관측소 주소(KHOA 비공식 경로 실측, KMA 는 미보유 → undefined). 지어내지 말 것. */
  address?: string
  /** 관측유형(KHOA 비공식 경로 실측, KMA 는 미보유 → undefined). 지어내지 말 것. */
  obs_type?: string
}

/** 기관명 표기(Wave 3b, ui_revision_notes §8) — 부이가 식별되는 모든 곳에서 종류(B/C/TW..)뿐
 *  아니라 발행기관 정식명을 병기한다. 지도 팝업·상세·좌패널이 전부 이 하나를 공유한다. */
export const SOURCE_LABEL: Record<'KMA' | 'KHOA', string> = {
  KMA: '기상청',
  KHOA: '국립해양조사원',
}

/** 부이 수신상태 3단계. */
export type BuoyStatus = '정상' | '지연' | '미수신'

/** GET /api/live 항목 — 현재 관측 스냅샷. */
export interface LiveItem {
  source: 'KMA' | 'KHOA'
  id: string
  name: string
  lon: number
  lat: number
  tp: string
  tp_label?: string
  obs_time: string | null
  status: BuoyStatus
  minutes_since: number | null
  values: {
    wave_height?: number | null
    wave_period?: number | null
    wind_dir?: number | null
    wind_speed?: number | null
    wind_gust?: number | null
    water_temp?: number | null
    air_temp?: number | null
    pressure?: number | null
    humidity?: number | null
    current_dir?: number | null
    current_speed_cms?: number | null
    salinity?: number | null
  }
  /** 지표 탭 동적화(§14) — 이 지점이 실제 제공하는 charted 지표만(순서: wave,water_temp,wind_speed,
   *  pressure 부분집합). 백엔드 live_snapshot.available_metrics() 산정. 미도착(구버전 응답 등)이면
   *  undefined — 소비측에서 전체 지표로 폴백한다. */
  available_metrics?: string[]
}

export type BaseLayer = 'sat' | 'light' | 'dark'

// ── GET /api/field (§26 — 2D 필드 오버레이: JMA MSM/GFS 바람장·RTOFS/GFS/OISST 수온장, 현재
// 1프레임만) ─────────────────────────────────────────────────────────────────────────────────
// §27(2026-07-17, 이진화): 와이어 포맷은 JSON 숫자배열이 아니라 **이진**(`Content-Type:
// application/octet-stream`) — 바이트 레이아웃은 `[0:4) uint32 LE 헤더길이 N` +
// `[4:4+N) UTF-8 JSON 헤더(FieldWireHeader)` + `[4+N:) Int16(LE) 스케일 본문`. 헤더가 지정하는
// `scale`/`offset`/`nodata` 로 `실값 = raw_int16*scale+offset`, `raw_int16===nodata`(-32768,
// Int16 최솟값)면 육지/결측. 정확한 오프셋 규약은 backend/field_service.py 모듈 독스트링 "프레임
// 계약" 이 정본이고, 디코드는 MapViewGL.tsx 의 `decodeFieldFrame()`이 수행한다.
//
// 아래 FieldWind/FieldSst/FieldResponse 는 그 이진을 디코드한 **이후의 논리 형태**(webgl/windGL·
// sstGL 렌더러가 그대로 소비하는 모양 — 이진화 이전과 동일하게 유지해 렌더러 변경을 피했다).
// bounds = [west, south, east, north]. **row 0 = 최남단, col 0 = 최서단**(백엔드 규약 — 프론트
// webgl/fieldCommon.ts 의 격자 변환이 이 방향을 그대로 전제한다. 뒤집으면 지도와 어긋난다).
export interface FieldWind {
  valid_kst: string
  source: string
  bounds: [number, number, number, number]
  rows: number
  cols: number
  u: number[][]
  v: number[][]
}
export interface FieldSst {
  valid_kst: string
  source: string
  bounds: [number, number, number, number]
  rows: number
  cols: number
  /** 육지 격자는 null — 렌더러가 반드시 투명 처리해야 한다. */
  data: (number | null)[][]
}
export interface FieldResponse {
  ready: boolean
  error?: string | null
  wind?: FieldWind
  sst?: FieldSst
}

// ── `/api/field` 이진 헤더의 JSON 부분(디코드 전 와이어 스키마) — decodeFieldFrame() 전용 타입.
export interface FieldWireArrayMeta {
  valid_kst: string
  source: string
  bounds: [number, number, number, number]
  rows: number
  cols: number
  dtype: 'int16'
  scale: number
  offset: number
  nodata: number
}
export interface FieldWireWindMeta extends FieldWireArrayMeta {
  u_offset: number
  u_length: number
  v_offset: number
  v_length: number
}
export interface FieldWireSstMeta extends FieldWireArrayMeta {
  data_offset: number
  data_length: number
}
export interface FieldWireHeader {
  ready: boolean
  error?: string | null
  wind?: FieldWireWindMeta
  sst?: FieldWireSstMeta
}

// ── 상태 색상 (index.css 의 CSS 변수와 짝) ──────────────────────────────────
export const STATUS_COLOR: Record<BuoyStatus, string> = {
  '정상': 'var(--ok)',
  '지연': 'var(--delay)',
  '미수신': 'var(--lost)',
}
// hex 형(투명도 산술용, `${STATUS_HEX[st]}33` 처럼 알파 접미사 사용) — index.css 의 --ok/--delay/--lost 와 반드시 일치시킬 것
// "예외 우선(exception-first)" 색채 — 5인 전문가 P0 + NDBC 신선도 색 관행: 정상은 저채도로 지도에
// 녹아들게(스캔 부담↓), 지연/미수신은 채도를 계단식으로 끌어올려 예외만 튀게 한다.
export const STATUS_HEX: Record<BuoyStatus, string> = {
  '정상': '#4F9E7E',
  '지연': '#E8A33C',
  '미수신': '#F0575C',
}
export const STATUS_LABEL: Record<BuoyStatus, string> = {
  '정상': '정상 수신',
  '지연': '수신 지연',
  '미수신': '미수신',
}
// 저채도 chip 배경/테두리(인스트루먼트 미니멀 — 큰 글로우 대신 low-alpha soft 톤)
export const STATUS_SOFT: Record<BuoyStatus, string> = {
  '정상': 'var(--ok-soft)',
  '지연': 'var(--delay-soft)',
  '미수신': 'var(--lost-soft)',
}
export const STATUS_BORDER: Record<BuoyStatus, string> = {
  '정상': 'var(--ok-border)',
  '지연': 'var(--delay-border)',
  '미수신': 'var(--lost-border)',
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  loading?: boolean
}

// ── GET /api/timeseries (Wave 3b: range/stats/ai_qc 확장, backend timeseries.py 참고) ────────
// 관측기관 QC(AQC/MQC) 표시는 제거됨(2026-07-22) — 실측상 이상치 플래그가 아니라 기관 내부 상태
// 코드로 밝혀져(정상 데이터에도 붙음) 백엔드도 더 이상 파싱/응답에 포함하지 않는다. 이상 판정의
// 유일한 근거는 아래 AI QC(robust z-score 스파이크/결측, backend/qc.py)다.
export interface TimeseriesPointAiQC {
  spike: boolean
  missing: boolean
}

export interface TimeseriesPoint {
  t: string // "YYYY-MM-DD HH:MM" (KST)
  wave?: number | null
  wave_period?: number | null
  wind_speed?: number | null
  wind_dir?: number | null
  water_temp?: number | null
  air_temp?: number | null
  pressure?: number | null
  ai_qc?: TimeseriesPointAiQC
}

export interface TimeseriesStat {
  min: number | null
  max: number | null
  mean: number | null
  count: number
  unit: string
}

export interface TimeseriesResponse {
  id: string
  source: 'KMA' | 'KHOA'
  name: string | null
  range?: string
  resolution?: string
  unit_notes: string
  points: TimeseriesPoint[]
  qc_summary: { ai_spike_count?: number; ai_gap_count?: number }
  stats?: Partial<Record<TimeseriesMetric | 'wave_period' | 'wind_dir' | 'air_temp', TimeseriesStat>>
  cadence_min?: number | null
  error?: string
}

export type TimeseriesMetric = 'wave' | 'water_temp' | 'wind_speed' | 'pressure'
export type TimeseriesRange = '24h' | '7d' | '30d' | '1y'

// ── GET /api/forecast (Phase 6 모의 예측, forecast.py) ──────────────────────────────────────
/** `lower`/`upper` = 시간 경과에 따라 벌어지는 불확실성 밴드(MAD·sqrt(h) 기반, band_z 신뢰폭 —
 *  forecast.py make_forecast() 참고). 통계 보정 없는 시연용 참고치(note 필드 참고). */
export interface ForecastPoint { t: string; value: number; lower?: number | null; upper?: number | null }

export interface ForecastResponse {
  metric: string
  label: string
  unit: string
  generated_from: string | null
  points: ForecastPoint[]
  note: string
  band?: { method: string; z: number }
  source?: 'KMA' | 'KHOA'
  id?: string
  error?: string
}

// ── GET /api/status (Wave 2) — 헤더/KPI/좌패널이 공유하는 운영 집계 SSOT ──────────────────────
// `data_freshness.newest_obs_age_min` 이 헤더 배지·KPI "최근 갱신"의 단일 근거다(백엔드 주석 참고) —
// 이 값을 각 컴포넌트가 따로 재계산하지 않고 그대로 읽어야 "40분 전인데 정상" 류 모순이 안 생긴다.
export interface StatusResponse {
  count: number
  total: Partial<Record<BuoyStatus, number>>
  by_source: Record<string, Partial<Record<BuoyStatus, number>>>
  data_freshness: {
    newest_obs_age_min: number | null
    oldest_obs_age_min: number | null
    last_cache_refresh: string | null
    cache_age_sec: number | null
  }
  max_wave: { value: number; station_name: string; station_id: string; source: 'KMA' | 'KHOA' } | null
  mean_wave: number | null
  alerts: number
  cache: {
    kma_count: number; kma_age_sec: number | null
    khoa_count: number; khoa_age_sec: number | null
  }
}
