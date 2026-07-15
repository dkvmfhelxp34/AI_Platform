// Buoy Platform — 공용 타입 정의. backend/main.py 응답 스키마와 1:1 대응.

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
  sensor_heights?: Record<string, string>
  obs_code?: string
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
}

export type BaseLayer = 'sat' | 'light'

// ── 상태 색상 (index.css 의 CSS 변수와 짝) ──────────────────────────────────
export const STATUS_COLOR: Record<BuoyStatus, string> = {
  '정상': 'var(--ok)',
  '지연': 'var(--delay)',
  '미수신': 'var(--lost)',
}
// hex 형(투명도 산술용, `${STATUS_HEX[st]}33` 처럼 알파 접미사 사용) — index.css 의 --ok/--delay/--lost 와 반드시 일치시킬 것
export const STATUS_HEX: Record<BuoyStatus, string> = {
  '정상': '#35C88A',
  '지연': '#E0A44A',
  '미수신': '#E06A78',
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

// ── GET /api/timeseries (Phase 3 상세 패널) ─────────────────────────────────
export interface TimeseriesPointQC {
  flagged: boolean
  checked?: boolean
  note?: string
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
  qc: TimeseriesPointQC
}

export interface TimeseriesResponse {
  id: string
  source: 'KMA' | 'KHOA'
  name: string | null
  unit_notes: string
  points: TimeseriesPoint[]
  qc_summary: { flagged_count: number; checked: boolean }
  error?: string
}

export type TimeseriesMetric = 'wave' | 'water_temp' | 'wind_speed' | 'pressure'
