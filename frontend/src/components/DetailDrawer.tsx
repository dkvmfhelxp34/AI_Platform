/**
 * DetailDrawer — 상세 패널(Wave 3b "연구 그레이드" 재설계, ui_revision_notes §6/§7).
 * 팝업 "상세보기" 버튼 → 우측 도크(챗봇 자리 대체)로 열림.
 *
 * 정보 순서(§6 P0 재배치): 헤더 → **현재 관측**(임계값색+추세화살표) → **시계열 차트**(센터피스) →
 * **지점 제원**(연구용 계측기 메타, 맨 아래). 관제(overview)는 지도/좌패널 톤을 유지하고, 여기 상세는
 * "계측 분석" 톤(정밀 단위·통계·QC·예측 오버레이)으로 격상한다.
 *
 * 시계열 차트(핵심 산출물) — ComposedChart 로 관측/예측/임계선/QC 를 한 캔버스에:
 *  - 관측: 그라디언트 Area(부드러운 monotone).
 *  - 예측(24h, `/api/forecast`): 관측 끝점에서 **이어지는** 점선(경계 anchor 포인트를 공유해 시각적
 *    단절 없이 이어짐) + "지금" ReferenceLine + 예측구간 ReferenceArea 음영. range=24h/7d 에서만
 *    표시(30d/1y 에서는 24h 예측이 폭 대비 무의미하게 얇아져 표시하지 않는다).
 *  - 임계값(파고 주의보 3m/경보 5m, 풍속 주의보 14m/s/경보 21m/s — utils/thresholds.ts) ReferenceLine.
 *  - QC: 관측기관 플래그(`qc.flagged`) + 알고리즘 스파이크(`ai_qc.spike`) 를 서로 다른 색 점으로.
 *  - 장기 구간(30d/1y)은 포인트 수가 매우 많아(예: 1년 30분해상도 ≈17,000) 렌더 성능을 위해
 *    표시용으로만 다운샘플(통계·CSV 내보내기는 원본 전체 사용).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceDot, ReferenceLine, ReferenceArea,
} from 'recharts'
import { useStore } from '../store'
import { mergeBuoys, relativeFromMinutes, type MergedBuoy } from '../utils/buoys'
import { categoryOf } from '../utils/buoyCategory'
import { WAVE_THRESHOLDS, WIND_THRESHOLDS, THRESHOLD_HEX, waveLevel, windLevel } from '../utils/thresholds'
import BuoyGlyph from './BuoyGlyph'
import {
  STATUS_HEX, STATUS_SOFT, STATUS_BORDER, STATUS_LABEL, SOURCE_LABEL,
  type StationMeta, type TimeseriesMetric, type TimeseriesRange, type TimeseriesPoint,
  type TimeseriesResponse, type ForecastResponse,
} from '../types'

// index.css 의 CSS 변수와 반드시 일치시킬 것(Recharts SVG 속성에는 hex 리터럴을 직접 넣는다)
// 균형 다크 재스킨 패스(2026-07-16, §17) + 정통 다크 엘리베이션 정정(§20): RISA식 그리드·축·단위
// 구조는 유지하되, 플롯면은 카드(--bg-elev)보다 밝은 최고 엘리베이션 --bg-float 로 "떠 있는" 분석
// 표면을 살린다(팝업·툴팁과 동일 티어 — 아래 PLOT_BG_HEX 참고).
const ACCENT_HEX = '#4E9AC9'    // 관측 — 마린 블루 실선(index.css --accent)
const FORECAST_HEX = '#DDA53B'  // 예측(점선) — 앰버, 관측(블루)·지연상태색과 구분되는 난색
const QC_INST_HEX = '#E0699A'   // 관측기관 QC 플래그(로즈) — 다크 플롯 위 대비 확보를 위해 밝게
const QC_AI_HEX = '#9B84E8'     // 알고리즘(AI) 이상감지(바이올렛) — 기관 QC 와 다른 색으로 구분
const GRID_HEX = '#3A4756'      // 그리드라인(수평) — 다크 플롯면 위 옅지만 확실히 보이는 수평 그리드
const LINE_HEX = '#47576A'
const TLO_HEX = '#B7C4D1'
const AXIS_HEX = '#C2CEDA'      // 축 눈금(1단 시각) — §18-1 "축·눈금 밝게(--t-mid)", TLO_HEX보다 한 단 밝게
const CROSSHAIR_HEX = 'rgba(226,232,240,0.55)' // hover 크로스헤어 — 시리즈색과 겹치지 않는 중립 가이드선
// 플롯 영역 배경 — §20: 차트 플롯은 팝업/툴팁과 같은 최고 엘리베이션(--bg-float #2F3C4B) 티어.
// 카드(--bg-elev #26313E)보다 확실히 밝아 "떠 있는" 분석 표면으로 읽힌다 — dot cutout 스트로크와 동일 색.
const PLOT_BG_HEX = '#2F3C4B'

const METRICS: { key: TimeseriesMetric; label: string; unit: string }[] = [
  { key: 'wave', label: '파고', unit: 'm' },
  { key: 'water_temp', label: '수온', unit: '℃' },
  { key: 'wind_speed', label: '풍속', unit: 'm/s' },
  { key: 'pressure', label: '기압', unit: 'hPa' },
]
const RANGES: { key: TimeseriesRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7일' },
  { key: '30d', label: '30일' },
  { key: '1y', label: '1년' },
]
// §23(2026-07-16, "관측소마다 자료 범위가 다르니 Y축도 유동적으로") — 지표별 고정 스텝 대신 지점·구간마다
// 실측 변동폭(range)에서 "1-2-2.5-5" 래더로 4~6눈금이 되는 step 을 매번 계산한다(niceStepFor 참고,
// 아래 yMin/yMax useMemo 에서 호출). NICE_STEP 은 그 계산에 쓸 실측값이 전혀 없는(빈 vals) 방어적
// 폴백 전용으로만 남긴다.
const NICE_STEP: Record<TimeseriesMetric, number> = { wave: 1, wind_speed: 5, water_temp: 2, pressure: 5 }
// 파고 0 부터, 풍속도 0 부터 시작(둘 다 음수 없음) — 수온/기압은 관측 범위에 맞춰 자동
const ZERO_FLOOR: Record<TimeseriesMetric, boolean> = { wave: true, wind_speed: true, water_temp: false, pressure: false }
// 값 표시 소수 자릿수
const DECIMALS: Record<TimeseriesMetric, number> = { wave: 1, wind_speed: 1, water_temp: 1, pressure: 1 }

// 1-2-2.5-5 래더에서 자료 범위(rawRange)가 4~6눈금이 되는 step 을 산정한다.
function niceStepFor(rawRange: number): number {
  const target = Math.max(rawRange, 1e-6) / 4.5
  const pow = Math.pow(10, Math.floor(Math.log10(target)))
  for (const m of [1, 2, 2.5, 5, 10]) if (target <= m * pow) return m * pow
  return 10 * pow
}
// 단일값(구간 내 변동이 0) 퇴화 케이스에서 step 산정 전에 범위를 넓혀주는 지표별 typical epsilon
// (예: 파고부이 24h 관측 1건뿐인 경우에도 "0 폭" 축이 되지 않게).
const FLAT_PAD: Record<TimeseriesMetric, number> = { wave: 0.5, wind_speed: 2, water_temp: 1, pressure: 2 }

/** Y축 눈금 라벨 — DECIMALS 자릿수로 표시하되, step 이 1 이상의 정수면 ".0" 꼬리를 지운다
 * (step 이 작아(<1) 세밀한 변동을 보여줘야 할 때는 소수 1자리를 그대로 유지). */
function formatYTick(v: number, step: number, decimals: number): string {
  const s = v.toFixed(decimals)
  if (step >= 1 && Number.isInteger(step) && s.endsWith('.0')) return s.slice(0, -2)
  return s
}

const METRIC_THRESHOLDS: Partial<Record<TimeseriesMetric, { caution: number; warning: number }>> = {
  wave: WAVE_THRESHOLDS,
  wind_speed: WIND_THRESHOLDS,
}

const MAX_CHART_POINTS = 480 // 장기 구간(1y ≈17,000pt) 렌더 성능용 다운샘플 상한(통계/CSV 는 원본 사용)

function degToCompass(deg: number | null | undefined): string {
  if (deg == null || !isFinite(deg)) return '-'
  const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
  return dirs[Math.round(deg / 45) % 8]
}

function hhmm(t: string): string {
  return t && t.length >= 16 ? t.slice(11, 16) : t
}
function mmdd(t: string): string {
  return t && t.length >= 10 ? t.slice(5, 10).replace('-', '/') : t
}
function fullDt(t: string): string {
  return t && t.length >= 16 ? `${mmdd(t)} ${hhmm(t)}` : t
}

// ── X축 2단 눈금(§18-1) — 윗줄 시각(HH:MM) / 아랫줄 날짜(MM/DD). "진짜 계기 플롯"(NDBC/Grafana)
// 처럼 시간·날짜 경계를 한 눈금에서 동시에 읽게 한다. Recharts 커스텀 tick 렌더러.
function XAxisTwoLineTick(props: { x?: number; y?: number; payload?: { value: string } }) {
  const { x = 0, y = 0, payload } = props
  const t = payload?.value ?? ''
  if (!t) return null
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={13} textAnchor="middle" fontSize={13} fontWeight={600} fill={AXIS_HEX} fontFamily="var(--font-ui)">{hhmm(t)}</text>
      <text x={0} y={0} dy={27} textAnchor="middle" fontSize={12} fontWeight={500} fill={TLO_HEX} fontFamily="var(--font-ui)">{mmdd(t)}</text>
    </g>
  )
}

// ── 범례 색칩(§18-1) — 라인 스와치(실선/점선) + 라벨. 축 색상 의존 없이 관측/예측을 즉시 구분.
function LegendChip({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: 'var(--t-mid)', whiteSpace: 'nowrap' }}>
      <svg width="16" height="8" viewBox="0 0 16 8" aria-hidden="true" style={{ flexShrink: 0 }}>
        <line x1="1" y1="4" x2="15" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '4 2.4' : undefined} strokeLinecap="round" />
      </svg>
      {label}
    </span>
  )
}

function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  const stride = Math.ceil(arr.length / max)
  const out: T[] = []
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i])
  const last = arr[arr.length - 1]
  if (out[out.length - 1] !== last) out.push(last)
  return out
}

function fmtVal(v: number | null | undefined, decimals: number): string {
  return v == null || !isFinite(v) ? '—' : v.toFixed(decimals)
}

function exportCsv(buoy: MergedBuoy, range: TimeseriesRange, points: TimeseriesPoint[]) {
  const header = ['시각(KST)', '파고_m', '파주기_s', '풍속_ms', '풍향_deg', '수온_C', '기온_C', '기압_hPa', '기관QC', 'AI이상감지']
  const rows = points.map(p => [
    p.t, p.wave, p.wave_period, p.wind_speed, p.wind_dir, p.water_temp, p.air_temp, p.pressure,
    p.qc?.flagged ? '1' : '0', p.ai_qc?.spike ? '1' : '0',
  ].map(v => v == null ? '' : String(v)).join(','))
  const csv = [header.join(','), ...rows].join('\n')
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${buoy.id}_${buoy.name}_${range}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ── Main ─────────────────────────────────────────────────────────────────
export default function DetailDrawer() {
  const { stations, live, detailOpenId, closeDetail, openDetail } = useStore(
    useShallow(s => ({ stations: s.stations, live: s.live, detailOpenId: s.detailOpenId, closeDetail: s.closeDetail, openDetail: s.openDetail }))
  )

  const buoys = useMemo(() => mergeBuoys(stations, live), [stations, live])
  const buoy = useMemo(() => buoys.find(b => b.id === detailOpenId) ?? null, [buoys, detailOpenId])
  const station = useMemo(() => stations.find(s => s.id === detailOpenId) ?? null, [stations, detailOpenId])

  // 이전/다음 지점 내비(이름순 — 검색·필터와 무관하게 항상 안정적인 전체 순서)
  const orderedIds = useMemo(() => [...buoys].sort((a, b) => a.name.localeCompare(b.name, 'ko')).map(b => b.id), [buoys])

  const [range, setRange] = useState<TimeseriesRange>('24h')
  const [metric, setMetric] = useState<TimeseriesMetric>('wave')
  const [ts, setTs] = useState<TimeseriesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [forecast, setForecast] = useState<ForecastResponse | null>(null)
  // 현재관측 카드의 추세 화살표용 — 사용자가 고른 차트 range 와 무관하게 항상 최근 24h 기준(§6).
  const [recentTs, setRecentTs] = useState<TimeseriesResponse | null>(null)

  // §14 — 지표 탭 전환 시 반드시 `metric` 을 붙여 재조회한다(백엔드가 이 값으로 AI-QC/시연
  // 스파이크·QC 요약을 계산한다 — 이전엔 wave 고정 요청이라 다른 지표 탭에서 QC 가 어긋났었다).
  useEffect(() => {
    if (!buoy) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/timeseries?source=${buoy.source}&id=${encodeURIComponent(buoy.id)}&range=${range}&metric=${metric}`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d: TimeseriesResponse) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setTs(d)
      })
      .catch(() => { if (!cancelled) { setError('이 지점은 이력이 제공되지 않습니다'); setTs(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [buoy?.id, buoy?.source, range, metric])

  // §14 — 부이 전환 시 현재 선택 지표가 그 지점의 available_metrics 에 없으면 첫 available 로 폴백
  // (예: 파고 탭을 보다가 풍속·기압이 없는 KHOA 부이로 이동하면 자동으로 파고/수온 등으로 전환).
  useEffect(() => {
    if (!buoy) return
    const avail = (buoy.available_metrics?.length ? buoy.available_metrics : METRICS.map(m => m.key)) as TimeseriesMetric[]
    if (!avail.includes(metric)) setMetric(avail[0] ?? 'wave')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buoy?.id])

  // 24h/7d 예측 오버레이 — 30d/1y 에서는 폭 대비 24h 가 무의미해 요청하지 않는다.
  useEffect(() => {
    setForecast(null)
    if (!buoy || (range !== '24h' && range !== '7d')) return
    let cancelled = false
    fetch(`/api/forecast?source=${buoy.source}&id=${encodeURIComponent(buoy.id)}&metric=${metric}`)
      .then(r => r.ok ? r.json() : null)
      .then((d: ForecastResponse | null) => { if (!cancelled && d && !d.error) setForecast(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [buoy?.id, buoy?.source, metric, range])

  useEffect(() => {
    if (!buoy) return
    let cancelled = false
    fetch(`/api/timeseries?source=${buoy.source}&id=${encodeURIComponent(buoy.id)}&hours=24`)
      .then(r => r.ok ? r.json() : null)
      .then((d: TimeseriesResponse | null) => { if (!cancelled && d && !d.error) setRecentTs(d) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [buoy?.id, buoy?.source])

  useEffect(() => {
    if (!detailOpenId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailOpenId, closeDetail])

  if (!detailOpenId) return null

  const idx = orderedIds.indexOf(detailOpenId)
  const goPrev = () => { if (idx > 0) openDetail(orderedIds[idx - 1]); else if (orderedIds.length) openDetail(orderedIds[orderedIds.length - 1]) }
  const goNext = () => { if (idx >= 0 && idx < orderedIds.length - 1) openDetail(orderedIds[idx + 1]); else if (orderedIds.length) openDetail(orderedIds[0]) }

  return (
    <aside className="detail-drawer uiz" style={{
      width: 'clamp(490px, 34vw, 620px)', flexShrink: 0, background: 'var(--bg-panel)',
      borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      boxShadow: '-6px 0 24px rgba(0,0,0,0.35)',
    }}>
      {!buoy ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-lo)', fontSize: 14 }}>
          지점 정보를 불러오는 중…
        </div>
      ) : (
        <>
          <DrawerHeader buoy={buoy} onClose={closeDetail} onPrev={goPrev} onNext={goNext} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '17px' }}>
            {/* A5 — buoy.id 로 key 를 줘 부이 전환 시 CurrentReadout 을 완전히 새로 마운트한다
                (업데이트가 아니라 리마운트). 빠른 연속 전환 중 이전 부이의 부분 상태가 새 부이
                렌더에 잠깐 섞여 보이는 것을 방지하는 방어적 조치 — cells 자체는 buoy.values 에서
                매 렌더 새로 계산되지만, 리마운트를 보장해 두는 편이 더 안전하다. */}
            <CurrentReadout key={buoy.id} buoy={buoy} recentTs={recentTs} />
            <TimeseriesSection
              buoy={buoy} range={range} setRange={setRange}
              metric={metric} setMetric={setMetric}
              ts={ts} loading={loading} error={error} forecast={forecast}
            />
            <SpecsBlock station={station} buoy={buoy} />
          </div>
        </>
      )}
    </aside>
  )
}

// ── Header ───────────────────────────────────────────────────────────────
function DrawerHeader({ buoy, onClose, onPrev, onNext }: {
  buoy: MergedBuoy; onClose: () => void; onPrev: () => void; onNext: () => void
}) {
  const hex = STATUS_HEX[buoy.status]
  const category = categoryOf(buoy)
  return (
    <div style={{
      background: 'var(--bg-base)', borderBottom: '1px solid var(--line)',
      padding: '15px 15px 15px 17px', flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8,
      boxShadow: 'var(--edge-hi)',
    }}>
      <div style={{ minWidth: 0, display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <div style={{ marginTop: 2, background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 7, padding: 5, flexShrink: 0 }}>
          <BuoyGlyph category={category} fill={hex} size={18} />
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: 'var(--t-hi)', letterSpacing: '-0.01em', lineHeight: 1.28 }}>
            {buoy.name}
          </div>
          {buoy.name_en && <div style={{ fontSize: 13, color: 'var(--t-lo)', marginTop: 2 }}>{buoy.name_en}</div>}
          {/* 종류 태그(해양기상부이 등)는 제거(§12) — 옆 글리프가 모양으로 이미 전달한다.
              기관(Source) 태그만 유지. */}
          <div style={{ display: 'flex', gap: 6, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <Tag label={SOURCE_LABEL[buoy.source]} />
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, color: hex,
              background: STATUS_SOFT[buoy.status], border: `1px solid ${STATUS_BORDER[buoy.status]}`,
              borderRadius: 6, padding: '4px 10px 4px 8px',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: hex, flexShrink: 0 }} />
              {STATUS_LABEL[buoy.status]}
            </span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        <HeaderIconBtn label="이전 지점" onClick={onPrev}>‹</HeaderIconBtn>
        <HeaderIconBtn label="다음 지점" onClick={onNext}>›</HeaderIconBtn>
        <div style={{ width: 1, height: 18, background: 'var(--line)', margin: '0 3px' }} />
        <HeaderIconBtn label="상세 패널 닫기" onClick={onClose}>×</HeaderIconBtn>
      </div>
    </div>
  )
}

function HeaderIconBtn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} style={{
      width: 28, height: 28, borderRadius: 7, flexShrink: 0, cursor: 'pointer',
      background: 'var(--bg-elev)', border: '1px solid var(--line)', color: 'var(--t-mid)',
      fontSize: 16, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      transition: 'color 0.12s, border-color 0.12s',
    }}>{children}</button>
  )
}

function Tag({ label }: { label: string }) {
  return (
    <span className="tnum" style={{
      fontSize: 13, fontWeight: 600, color: 'var(--t-mid)',
      background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 9px',
    }}>{label}</span>
  )
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 11 }}>
        <div className="eyebrow">{title}</div>
        {right}
      </div>
      {children}
    </div>
  )
}

// ── 현재 관측 ────────────────────────────────────────────────────────────
type TrendDir = 'up' | 'down' | 'flat' | null

function trendFor(points: TimeseriesPoint[] | undefined, key: keyof TimeseriesPoint): TrendDir {
  if (!points || points.length < 2) return null
  const vals = points.filter(p => typeof p[key] === 'number') as (TimeseriesPoint & Record<string, number>)[]
  if (vals.length < 2) return null
  const last = vals[vals.length - 1][key] as unknown as number
  const prev = vals[vals.length - 2][key] as unknown as number
  if (last === prev) return 'flat'
  return last > prev ? 'up' : 'down'
}

function TrendArrow({ dir }: { dir: TrendDir }) {
  if (dir == null || dir === 'flat') return null
  return (
    <span style={{ fontSize: 13, marginLeft: 4, color: dir === 'up' ? 'var(--delay)' : 'var(--accent-h)', fontWeight: 700 }}>
      {dir === 'up' ? '▲' : '▼'}
    </span>
  )
}

function CurrentReadout({ buoy, recentTs }: { buoy: MergedBuoy; recentTs: TimeseriesResponse | null }) {
  const v = buoy.values
  type Cell = { label: string; value: string; unit?: string; color?: string; trend: TrendDir }
  const cells: Cell[] = []
  if (v.wave_height != null) cells.push({
    label: '파고', value: v.wave_height.toFixed(1), unit: 'm',
    color: THRESHOLD_HEX[waveLevel(v.wave_height)], trend: trendFor(recentTs?.points, 'wave'),
  })
  if (v.wind_speed != null) cells.push({
    label: `풍속 (${degToCompass(v.wind_dir)}${v.wind_dir != null ? ` ${Math.round(v.wind_dir)}°` : ''})`,
    value: v.wind_speed.toFixed(1), unit: 'm/s',
    color: THRESHOLD_HEX[windLevel(v.wind_speed)], trend: trendFor(recentTs?.points, 'wind_speed'),
  })
  if (v.water_temp != null) cells.push({
    label: '수온', value: v.water_temp.toFixed(1), unit: '℃', trend: trendFor(recentTs?.points, 'water_temp'),
  })
  if (v.pressure != null) cells.push({
    label: '기압', value: v.pressure.toFixed(1), unit: 'hPa', trend: trendFor(recentTs?.points, 'pressure'),
  })

  const cadence = recentTs?.cadence_min
  return (
    <Section title="현재 관측">
      {cells.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {cells.map(c => (
            <div key={c.label} style={{ background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 13px', boxShadow: 'var(--edge-hi)' }}>
              <div className="eyebrow" style={{ marginBottom: 5 }}>{c.label}</div>
              <div className="tnum" style={{ fontSize: 21, fontWeight: 700, color: c.color ?? 'var(--t-hi)', display: 'flex', alignItems: 'baseline' }}>
                {c.value}{c.unit && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 3 }}>{c.unit}</span>}
                <TrendArrow dir={c.trend} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--t-lo)', padding: '10px 0' }}>표시할 관측값이 없습니다</div>
      )}
      <div className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', marginTop: 10, fontWeight: 500 }}>
        {buoy.obs_time ? `${buoy.obs_time} KST` : '관측 이력 없음'} · {relativeFromMinutes(buoy.minutes_since)}
        {cadence != null && <> · 관측주기 ~{cadence >= 60 ? `${Math.round(cadence / 60)}시간` : `${Math.round(cadence)}분`}</>}
      </div>
    </Section>
  )
}

// ── 시계열 차트(센터피스) ───────────────────────────────────────────────
// fcLower/fcWidth — 예측 불확실성 밴드(신규): Recharts 스택 Area 2겹으로 그린다(투명 base=fcLower +
// 그 위에 쌓는 밴드 폭=fcWidth 만큼만 채색) → 화면엔 [fcLower, fcLower+fcWidth]=[lower, upper] 구간이
// 음영으로 보인다. 관측 구간 row 에는 두 필드 모두 없음(undefined) → 그 구간엔 밴드가 그려지지 않는다.
type ChartRow = {
  t: string; obs?: number | null; fc?: number | null
  fcLower?: number | null; fcWidth?: number | null
  qcFlag?: boolean; aiSpike?: boolean
}

function TimeseriesSection({ buoy, range, setRange, metric, setMetric, ts, loading, error, forecast }: {
  buoy: MergedBuoy
  range: TimeseriesRange
  setRange: (r: TimeseriesRange) => void
  metric: TimeseriesMetric
  setMetric: (m: TimeseriesMetric) => void
  ts: TimeseriesResponse | null
  loading: boolean
  error: string | null
  forecast: ForecastResponse | null
}) {
  const metricCfg = METRICS.find(m => m.key === metric)!
  const points = ts?.points ?? []
  const stats = ts?.stats?.[metric]
  const forecastActive = (range === '24h' || range === '7d') && !!forecast?.points.length && !!points.length
  const isDaily = ts?.resolution === 'daily'

  const displayPoints = useMemo(() => downsample(points, MAX_CHART_POINTS), [points])

  const chartData = useMemo<ChartRow[]>(() => {
    const rows = new Map<string, ChartRow>()
    for (const p of displayPoints) {
      rows.set(p.t, { t: p.t, obs: p[metric] ?? null, qcFlag: !!p.qc?.flagged, aiSpike: !!p.ai_qc?.spike })
    }
    if (forecastActive && points.length) {
      const lastObs = points[points.length - 1]
      const lastVal = lastObs[metric]
      if (lastVal != null) {
        // 앵커(관측 끝점) — 예측선과 이어지는 시작점이자 밴드의 폭 0 시작점(리드타임 0 → 불확실성 0).
        const anchor = rows.get(lastObs.t) ?? { t: lastObs.t }
        anchor.fc = lastVal
        anchor.fcLower = lastVal
        anchor.fcWidth = 0
        rows.set(lastObs.t, anchor)
      }
      for (const fp of forecast!.points) {
        const row = rows.get(fp.t) ?? { t: fp.t }
        row.fc = fp.value
        if (fp.lower != null && fp.upper != null) {
          row.fcLower = fp.lower
          row.fcWidth = Math.max(0, fp.upper - fp.lower)
        }
        rows.set(fp.t, row)
      }
    }
    return [...rows.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0))
  }, [displayPoints, forecastActive, forecast, points, metric])

  const nowT = forecastActive ? points[points.length - 1].t : null
  const forecastEndT = forecastActive ? forecast!.points[forecast!.points.length - 1].t : null

  const threshold = METRIC_THRESHOLDS[metric]
  // §23(2026-07-16, "관측소마다 자료 범위도 유동적으로") — 아래 domain=[yMin,yMax] 로 <YAxis> 에
  // 그대로 들어간다. 임계값(threshold.warning)을 더 이상 vals 에 강제 편입시키지 않는다(과거엔
  // 잔잔한 날에도 파고 3m/경보 5m 를 포함시켜 축이 항상 0~5m 로 눌려 실측(예: 0.3m)이 바닥
  // 슬리버에 짓눌렸다) — "예외 우선" 원칙: 축은 실측(obs/fc/band) 범위만 반영하고, 임계선은
  // 그 범위 안에 들 때만(아래 JSX 조건부 렌더) 화면에 나타난다.
  //
  // step 도 지표별 고정값(과거 NICE_STEP) 대신 niceStepFor() 로 매 지점·구간의 실측 변동폭에서
  // "1-2-2.5-5" 래더 4~6눈금을 계산한다(수온 0.8℃ 변동에도 0.2/0.25℃ 처럼 세밀한 눈금이 나오게).
  //
  // allowDataOverflow 관련 배경(§21, A1) — Recharts 는 allowDataOverflow=false 일 때 우리가 지정한
  // domain 을 "내부 계산 데이터 domain"과 Math.min/Math.max 로 합집합 처리한다(parseSpecifiedDomain).
  // 이 차트는 예측 불확실성 밴드를 스택 Area 2겹(fcLower+fcWidth, stackId="fcband")으로 그리는데,
  // Recharts 는 스택 시리즈의 내부 domain 을 항상 0 기준선 포함으로 계산한다(getDomainOfStackGroups)
  // — 그 결과 기압처럼 절대값이 큰(⁓1000) 비-zero-floor 지표에서 yMin 이 995 로 계산되더라도 최종
  // 렌더 domain 이 Math.min(995, 0)=0 으로 강제로 끌려 내려가 압착된 축이 나온다. <YAxis
  // allowDataOverflow> 로 우리 domain 을 그대로 신뢰하게 만드는 게 근본 수정이다.
  const { yMin, yMax, ticks, tickStep } = useMemo(() => {
    // yMin~yMax 를 step 간격으로 순회해 명시적 tick 배열을 만든다. 8개를 넘으면 step 을 두 배로
    // 늘려 재구성(눈금 과밀 방지) — domain([yMin,yMax]) 자체는 바꾸지 않는다.
    const buildTicks = (min: number, max: number, initialStep: number): { ticks: number[]; step: number } => {
      let s = initialStep
      for (let guard = 0; guard < 20; guard++) {
        const n = Math.max(0, Math.round((max - min) / s))
        if (n + 1 <= 8 || guard === 19) {
          const t: number[] = []
          for (let i = 0; i <= n; i++) t.push(Math.round((min + i * s) * 1e6) / 1e6)
          return { ticks: t, step: s }
        }
        s *= 2
      }
      return { ticks: [min, max], step: s }
    }

    const vals = chartData
      .flatMap(r => [r.obs, r.fc, r.fcLower != null && r.fcWidth != null ? r.fcLower + r.fcWidth : null])
      .filter((v): v is number => v != null)

    // §23 보강 — chartData 는 표시용 다운샘플(≤MAX_CHART_POINTS)이라 30d/1y 처럼 표본이 많은
    // 구간에서는 솎아지며 걸러진 극값이 축 밖으로 눌릴 수 있다(allowDataOverflow 로 조용히
    // 클리핑됨). 전체 해상도 `points` 에서 같은 지표의 min/max 를 별도로 스캔해 vals 에 합류시켜
    // 축 domain 이 항상 실측 전 구간의 진짜 최댓/최솟값을 덮게 한다.
    let fullMin: number | null = null
    let fullMax: number | null = null
    for (const p of points) {
      const v = p[metric]
      if (v == null) continue
      if (fullMin == null || v < fullMin) fullMin = v
      if (fullMax == null || v > fullMax) fullMax = v
    }
    if (fullMin != null && fullMax != null) vals.push(fullMin, fullMax)

    if (!vals.length) {
      // 실측이 전혀 없을 때(로딩/빈 구간 등, 실제로는 이 경우 차트 자체가 EmptyState 로 대체돼
      // 안 그려짐)의 방어적 폴백 — 지표별 고정 NICE_STEP 을 그대로 사용.
      const fallbackStep = NICE_STEP[metric]
      const fallbackMax = fallbackStep * 4
      const built = buildTicks(0, fallbackMax, fallbackStep)
      return { yMin: 0, yMax: fallbackMax, ticks: built.ticks, tickStep: built.step }
    }

    let rawMax = Math.max(...vals)
    let rawMin = Math.min(...vals)
    if (rawMax === rawMin) {
      // 단일값(변동 0) 퇴화 케이스 — step 산정 전에 지표별 typical epsilon 만큼 위로 넓힌다.
      rawMax = rawMin + FLAT_PAD[metric]
    }

    if (ZERO_FLOOR[metric]) {
      const step = niceStepFor(rawMax - 0)
      let max = Math.ceil((rawMax * 1.12) / step) * step
      if (max < step) max = step
      const built = buildTicks(0, max, step)
      return { yMin: 0, yMax: max, ticks: built.ticks, tickStep: built.step }
    }

    // 비-zero-floor(수온·기압) — 실측 변동폭(range) 기준 패딩(위아래 15%, 최소 0.3 step 보장)
    const range = rawMax - rawMin
    const step = niceStepFor(range)
    const pad = Math.max(range * 0.15, step * 0.3)
    const min = Math.floor((rawMin - pad) / step) * step
    const max = Math.ceil((rawMax + pad) / step) * step
    const built = buildTicks(min, max <= min ? min + step : max, step)
    return { yMin: min, yMax: max <= min ? min + step : max, ticks: built.ticks, tickStep: built.step }
  }, [chartData, metric, points])

  const qcDots = useMemo(() => chartData.filter(r => r.qcFlag && r.obs != null), [chartData])
  const aiDots = useMemo(() => chartData.filter(r => r.aiSpike && r.obs != null), [chartData])
  const gradId = `obs-grad-${metric}`

  const currentVal = points.length ? points[points.length - 1][metric] : null

  // §18-1 — 관측선에 "표본임을 보여주는" 작은 점 마커를 찍되, 장기 구간(30d/1y)처럼 표본이 많으면
  // 자동으로 솎아 과밀을 막는다(항상 최대 ~60개 점만 그림 + 마지막 관측점은 항상 표시).
  // A3 — 표본이 아주 적은 구간(예: 파고부이 일 단위 관측 24h≈3pt)은 점이 "지금" 라벨 등에 묻혀
  // 안 보일 수 있어 반경을 눈에 띄게 키운다(관측선 자체가 짧아 점이 곧 유일한 신호이기 때문).
  const obsCount = displayPoints.length
  const dotStride = Math.max(1, Math.ceil(obsCount / 60))
  const sparseObs = obsCount > 0 && obsCount <= 8
  const obsDotRadius = sparseObs ? 4 : 1.8
  const renderObsDot = useMemo(() => (
    (dotProps: { cx?: number; cy?: number; index?: number; payload?: ChartRow }) => {
      const { cx, cy, index = 0, payload } = dotProps
      if (payload?.obs == null) return <g key={`d-${index}`} />
      if (index % dotStride !== 0 && index !== obsCount - 1) return <g key={`d-${index}`} />
      return <circle key={`d-${index}`} cx={cx} cy={cy} r={obsDotRadius} fill={ACCENT_HEX} stroke={PLOT_BG_HEX} strokeWidth={sparseObs ? 1.5 : 1} />
    }
  ), [dotStride, obsCount, obsDotRadius, sparseObs])

  // §14 — 이 지점이 실제 제공하는 지표만 탭으로 노출(순서는 METRICS 고정 순서 유지).
  // available_metrics 가 아직 없으면(방어적 케이스) 전체 4종으로 폴백.
  const availMetrics = buoy.available_metrics?.length ? buoy.available_metrics : METRICS.map(m => m.key)
  const visibleMetrics = METRICS.filter(m => availMetrics.includes(m.key))

  return (
    <Section title="시계열"
      right={points.length > 0 && (
        <button onClick={() => exportCsv(buoy, range, points)} className="tnum" style={{
          fontSize: 13, fontWeight: 700, color: 'var(--t-lo)', background: 'transparent',
          border: '1px solid var(--line)', borderRadius: 5, padding: '3px 9px', cursor: 'pointer',
        }} title="현재 구간 관측 원자료를 CSV로 내보내기">⬇ CSV</button>
      )}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 11 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {visibleMetrics.length > 1 ? (
            visibleMetrics.map(m => (
              <Chip key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
                {m.label} <span style={{ opacity: 0.7 }}>{m.unit}</span>
              </Chip>
            ))
          ) : (
            // 지표가 하나뿐인 지점 — 전환할 게 없으므로 탭 UI 대신 라벨만 표시(§14)
            visibleMetrics[0] && (
              <span className="eyebrow" style={{ padding: '6px 2px 6px 0' }}>
                {visibleMetrics[0].label} <span style={{ opacity: 0.75 }}>{visibleMetrics[0].unit}</span>
              </span>
            )
          )}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {RANGES.map(r => (
            <Chip key={r.key} active={range === r.key} onClick={() => setRange(r.key)}>{r.label}</Chip>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 10, padding: '16px 16px 8px', position: 'relative', boxShadow: 'var(--edge-hi)' }}>
        {loading ? (
          <EmptyState title="불러오는 중…" sub="관측 이력을 불러오는 중…" />
        ) : error ? (
          <EmptyState title="이력 없음" sub={error} />
        ) : points.length === 0 ? (
          // A3 — 구간 자체는 유효하나(에러 아님) 그 구간에 수신된 관측이 0건인 경우(예: 미수신
          // 데모 부이 24h). "이력이 제공되지 않습니다"(영구적 불가처럼 읽힘) 대신 "이 구간에
          // 수신분이 없다"는 임시적 사실로 명확히 구분하고, 미수신 상태면 그 이유를 덧붙인다.
          <EmptyState
            title={`최근 ${RANGES.find(r => r.key === range)?.label ?? range} 수신된 관측이 없습니다`}
            sub={buoy.status !== '정상'
              ? `${STATUS_LABEL[buoy.status]} 상태 · ${relativeFromMinutes(buoy.minutes_since)}`
              : '다른 구간을 선택해 보세요'}
          />
        ) : (
          <>
            {/* 차트 제목 + 범례(색칩)(§18-1) — "지점명 · 지표(단위)" 제목 + 우상단 색칩 범례(관측/
                예측). 축 색상에 의존하지 않고 라인 스타일(실선/점선)로도 구분되는 진짜 계기 플롯
                범례(NDBC/Grafana 참고). '예측(모의 24h)' 고지 문구는 범례 라벨 안에 유지(신뢰 표기). */}
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--t-hi)', letterSpacing: '-0.005em' }}>
                {buoy.name} <span style={{ color: 'var(--t-lo)', fontWeight: 500 }}>·</span> {metricCfg.label} <span style={{ color: 'var(--t-mid)', fontWeight: 600 }}>({metricCfg.unit})</span>
              </div>
              <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
                <LegendChip color={ACCENT_HEX} label="관측" />
                {forecastActive && <LegendChip color={FORECAST_HEX} label="예측(모의 24h)" dashed />}
              </div>
            </div>

            {/* 플롯 면 — §20: 카드(--bg-elev)보다 밝은 --bg-float(팝업·툴팁과 동일 최고 엘리베이션)로
                "떠 있는" 분석 표면을 준다. 그리드·데이터 잉크가 이 면 위에서 대비를 갖는다. */}
            <div style={{ background: PLOT_BG_HEX, borderRadius: 8, padding: '20px 6px 2px', position: 'relative' }}>
            {/* 단위 태그 — Y축이 무엇을 나타내는지 플롯 좌상단에서 즉시 확인 가능(제목의 단위 표기와
                이중 확인). 플롯면보다 확실히 어둡게 대비를 줘 또렷이 읽힌다. */}
            <div className="tnum" style={{
              position: 'absolute', top: 12, left: 16, zIndex: 2, fontSize: 13, fontWeight: 700,
              color: 'var(--t-mid)', background: 'var(--bg-panel)', border: '1px solid var(--line)',
              borderRadius: 5, padding: '2px 7px', pointerEvents: 'none',
            }}>{metricCfg.unit}</div>
            <ResponsiveContainer width="100%" height={264}>
              <ComposedChart data={chartData} margin={{ top: 22, right: 10, left: 2, bottom: 2 }}>
                <defs>
                  <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={ACCENT_HEX} stopOpacity={0.32} />
                    <stop offset="100%" stopColor={ACCENT_HEX} stopOpacity={0} />
                  </linearGradient>
                </defs>
                {/* 그리드 = 수평(뚜렷) + 세로(옅게, 시간/일 경계 느낌) — §18-1 "진짜 계기 플롯" 체크리스트 */}
                <CartesianGrid horizontal={{ stroke: GRID_HEX }} vertical={{ stroke: GRID_HEX, strokeOpacity: 0.5 }} strokeDasharray="0" />
                {/* A4 — "preserveStartEnd": 항상 첫/마지막 데이터 시각을 눈금으로 남겨(그 사이는
                    minTickGap 여백에 맞춰 자동 솎음) 1년 등 장기 구간에서도 마지막 눈금이 실제
                    마지막 관측시각(오늘)과 어긋나지 않게 한다(기존 숫자 interval 근사치는 마지막
                    눈금이 실제 마지막 데이터 인덱스와 맞지 않을 수 있었다). */}
                <XAxis dataKey="t" tick={<XAxisTwoLineTick />} height={34}
                  axisLine={{ stroke: LINE_HEX }} tickLine={false}
                  interval="preserveStartEnd" minTickGap={34} />
                {/* A1 — allowDataOverflow: 예측 밴드용 스택 Area(fcLower+fcWidth)가 있으면 Recharts
                    가 내부적으로 0 기준선 포함 domain 을 계산해(getDomainOfStackGroups) 우리가
                    지정한 domain 을 Math.min/Math.max 로 합집합(parseSpecifiedDomain) 해버려 축이
                    0 까지 눌린다 — allowDataOverflow 로 우리 domain([yMin,yMax], 이미 실측 범위를
                    포함하도록 계산됨)을 그대로 신뢰하게 한다. */}
                <YAxis tick={{ fontSize: 13, fill: AXIS_HEX, fontFamily: 'var(--font-ui)' }}
                  axisLine={false} tickLine={false} width={40} domain={[yMin, yMax]}
                  ticks={ticks} tickFormatter={v => formatYTick(v, tickStep, DECIMALS[metric])}
                  allowDataOverflow />
                <Tooltip content={<ChartTooltip unit={metricCfg.unit} metricLabel={metricCfg.label} decimals={DECIMALS[metric]} />}
                  cursor={{ stroke: CROSSHAIR_HEX, strokeWidth: 1, strokeDasharray: '3 3' }} />

                {/* 정상범위/특보 임계선 — 파고·풍속만(공개된 KMA 특보 정량기준 근사치). 주의보 라벨은
                    "위" 정렬로, 경보 라벨은 "아래" 정렬로 서로 어긋나게 배치해 두 선이 가까워도
                    라벨끼리 겹치지 않는다.
                    §23 — 축 domain 을 임계값 포함하도록 늘리지 않으므로(위 useMemo), 임계선은 그
                    값이 실제로 [yMin,yMax] 범위 안에 들 때만 그린다("예외 우선" — 잔잔한 날엔 화면
                    밖에 있다가, 파고가 실제로 주의보에 다가가면 자연스럽게 시야에 들어온다). */}
                {threshold && threshold.caution >= yMin && threshold.caution <= yMax && (
                  <ReferenceLine y={threshold.caution} stroke={THRESHOLD_HEX.caution} strokeDasharray="4 3" strokeWidth={1.3}
                    label={{ value: `주의보 ${threshold.caution}${metricCfg.unit}`, position: 'insideBottomRight', fill: THRESHOLD_HEX.caution, fontSize: 13, fontWeight: 600 }} />
                )}
                {threshold && threshold.warning >= yMin && threshold.warning <= yMax && (
                  <ReferenceLine y={threshold.warning} stroke={THRESHOLD_HEX.warning} strokeDasharray="4 3" strokeWidth={1.3}
                    label={{ value: `경보 ${threshold.warning}${metricCfg.unit}`, position: 'insideTopRight', fill: THRESHOLD_HEX.warning, fontSize: 13, fontWeight: 600 }} />
                )}

                {/* 예측 구간 음영 + 관측/예측 경계선. nowT = 마지막 관측시각이라 정상 부이는 ≈현재라
                    별도 라벨 없이 예측 음영("예측(모의 24h)" 범례)만으로 경계를 알린다("지금" 문구는
                    싸구려로 보인다는 사용자 피드백으로 제거). 지연·미수신 부이는 그 시각이 실제로는
                    몇 시간 전 최종 수신 시점이므로 "최종 수신"으로 라벨을 남겨 배지(미수신·N시간 전)와
                    모순되지 않게 한다. */}
                {forecastActive && nowT && forecastEndT && (
                  <ReferenceArea x1={nowT} x2={forecastEndT} fill={FORECAST_HEX} fillOpacity={0.10} strokeOpacity={0} ifOverflow="extendDomain" />
                )}
                {forecastActive && nowT && (
                  <ReferenceLine x={nowT} stroke={TLO_HEX} strokeDasharray="2 2" strokeWidth={1.3}
                    label={{ value: buoy.status === '정상' ? '' : '최종 수신', position: 'insideBottomLeft', fill: 'var(--t-hi)', fontSize: 13, fontWeight: 700 }} />
                )}

                {/* 관측 — 부드러운 그라디언트 Area + 표본점 마커(§18-1, 많으면 자동 솎임 — renderObsDot) */}
                <Area type="monotone" dataKey="obs" stroke={ACCENT_HEX} strokeWidth={2}
                  fill={`url(#${gradId})`} dot={renderObsDot} activeDot={{ r: 4, fill: ACCENT_HEX, stroke: PLOT_BG_HEX, strokeWidth: 2 }}
                  isAnimationActive={false} connectNulls={false} />

                {/* 예측 불확실성 밴드 — 스택 Area 2겹(투명 base=fcLower + 채색 폭=fcWidth)으로
                    [lower, upper] 구간을 음영 처리한다. 점선 예측선보다 먼저(뒤에) 그린다.
                    관측 구간은 두 필드 모두 없어(undefined) 밴드가 그려지지 않는다. */}
                {forecastActive && (
                  <>
                    <Area type="monotone" dataKey="fcLower" stackId="fcband" stroke="none" fill="transparent"
                      isAnimationActive={false} connectNulls legendType="none" tooltipType="none" activeDot={false} />
                    <Area type="monotone" dataKey="fcWidth" stackId="fcband" stroke="none" fill={FORECAST_HEX} fillOpacity={0.22}
                      isAnimationActive={false} connectNulls legendType="none" tooltipType="none" activeDot={false} />
                  </>
                )}

                {/* 예측 — 관측 끝점에서 이어지는 점선(다른 색) */}
                {forecastActive && (
                  <Line type="monotone" dataKey="fc" stroke={FORECAST_HEX} strokeWidth={2} strokeDasharray="6 4"
                    dot={false} activeDot={{ r: 3.5, fill: FORECAST_HEX, stroke: PLOT_BG_HEX, strokeWidth: 1.5 }}
                    isAnimationActive={false} connectNulls />
                )}

                {qcDots.map(r => (
                  <ReferenceDot key={`qc-${r.t}`} x={r.t} y={r.obs as number}
                    r={4} fill={QC_INST_HEX} stroke={PLOT_BG_HEX} strokeWidth={1.5} ifOverflow="extendDomain" />
                ))}
                {aiDots.map(r => (
                  <ReferenceDot key={`ai-${r.t}`} x={r.t} y={r.obs as number}
                    r={2.2} fill={QC_AI_HEX} stroke="none" ifOverflow="extendDomain" />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
            {/* 축 아래 "KST" 표기(§18-1) — NDBC 계기 플롯의 시간대(PDT) 캡션 관행 */}
            <div className="tnum" style={{ textAlign: 'right', fontSize: 12, fontWeight: 600, color: TLO_HEX, padding: '0 10px 5px 0' }}>KST</div>
            </div>
          </>
        )}
      </div>

      {/* 통계 스트립 */}
      {!loading && !error && points.length > 0 && (
        <div className="tnum" style={{ display: 'flex', gap: 0, marginTop: 10, background: 'var(--bg-elev)',
          border: '1px solid var(--line)', borderRadius: 8, overflow: 'hidden', boxShadow: 'var(--edge-hi)' }}>
          <StatCell label="현재" value={fmtVal(currentVal, DECIMALS[metric])} unit={metricCfg.unit} />
          <StatCell label="평균" value={fmtVal(stats?.mean, DECIMALS[metric])} unit={metricCfg.unit} />
          <StatCell label="최고" value={fmtVal(stats?.max, DECIMALS[metric])} unit={metricCfg.unit} />
          <StatCell label="최저" value={fmtVal(stats?.min, DECIMALS[metric])} unit={metricCfg.unit} last />
        </div>
      )}

      {/* QC 범례 — 관측기관 + AI, 한 줄로 압축 표기(색 분리 유지 — 신뢰 표기) */}
      {!loading && !error && points.length > 0 && (
        <div style={{ marginTop: 9, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--t-lo)' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: QC_INST_HEX, flexShrink: 0 }} />
            관측기관 QC{ts?.qc_summary.checked ? ` · ${ts.qc_summary.flagged_count}건` : ''}
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: QC_AI_HEX, flexShrink: 0 }} />
            AI 이상감지{ts?.qc_summary.ai_spike_count != null ? ` · ${ts.qc_summary.ai_spike_count}건` : ''}
          </span>
        </div>
      )}

      {/* 데이터 성격 caveat — 신뢰 표기라 의미는 유지하되(§12) 내부 API명·경로 잔여어를 없애고
          짧게, 별도 줄·저채도로 분리한다. */}
      {!loading && !error && points.length > 0 && (isDaily || (ts && !ts.qc_summary.checked)) && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {isDaily && <div style={{ fontSize: 13, color: 'var(--t-lo)' }}>· 일 단위 관측(파고부이)</div>}
          {ts && !ts.qc_summary.checked && <div style={{ fontSize: 13, color: 'var(--t-lo)' }}>· 기관 QC 미제공 구간</div>}
        </div>
      )}
    </Section>
  )
}

function StatCell({ label, value, unit, last }: { label: string; value: string; unit: string; last?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '9px 6px', borderRight: last ? 'none' : '1px solid var(--line)' }}>
      <div className="eyebrow" style={{ marginBottom: 4, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t-hi)' }}>
        {value}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 2 }}>{unit}</span>
      </div>
    </div>
  )
}

function ChartTooltip({ active, payload, label, unit, metricLabel, decimals }: {
  active?: boolean
  payload?: { payload: ChartRow }[]
  label?: string
  unit: string
  metricLabel: string
  decimals: number
}) {
  if (!active || !payload || !payload.length) return null
  const row = payload[0].payload
  const val = row.obs ?? row.fc
  if (val == null) return null
  const isForecast = row.obs == null && row.fc != null
  // §20 — 툴팁은 float 엘리베이션(팝업/차트 플롯과 동일 최고 티어)
  return (
    <div style={{ background: 'var(--bg-float)', border: '1px solid var(--border-strong)', borderRadius: 7,
      padding: '8px 11px', boxShadow: 'var(--shadow-overlay)' }}>
      <div className="tnum" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-hi)', whiteSpace: 'nowrap' }}>
        {fullDt(label ?? row.t)}
        <span style={{ color: 'var(--t-lo)', fontWeight: 500 }}> · {metricLabel} </span>
        {val.toFixed(decimals)}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 2 }}>{unit}</span>
        {isForecast && <span style={{ color: FORECAST_HEX, fontWeight: 700, marginLeft: 4 }}>예측</span>}
      </div>
      {isForecast && row.fcLower != null && row.fcWidth != null && row.fcWidth > 0 && (
        <div className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', marginTop: 3 }}>
          불확실성 밴드 {row.fcLower.toFixed(decimals)}–{(row.fcLower + row.fcWidth).toFixed(decimals)}{unit}
        </div>
      )}
      {row.qcFlag && <div style={{ fontSize: 13, color: QC_INST_HEX, marginTop: 4, fontWeight: 600 }}>● 관측기관 QC 플래그</div>}
      {row.aiSpike && <div style={{ fontSize: 13, color: QC_AI_HEX, marginTop: 2, fontWeight: 600 }}>◆ AI 이상감지(스파이크)</div>}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="tnum" style={{
      padding: '6px 11px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
      border: `1px solid ${active ? 'var(--accent-dim)' : 'var(--line)'}`,
      background: active ? 'var(--accent-50)' : 'transparent',
      color: active ? 'var(--accent-h)' : 'var(--t-mid)',
      transition: 'border-color 0.12s, color 0.12s',
    }}>{children}</button>
  )
}

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ height: 260, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 5, textAlign: 'center', padding: '0 24px' }}>
      <div style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--t-mid)' }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--t-lo)', lineHeight: 1.5 }}>{sub}</div>
    </div>
  )
}

// ── 지점 제원(연구용 계측기 메타 — 맨 아래) ────────────────────────────────
const SPEC_SHORT_LABEL: Record<string, string> = {
  wind_sensor_height_m: '풍속·풍향계 설치고',
  air_temp_sensor_height_m: '기온계 설치고',
  pressure_sensor_height_m: '기압계 설치고',
  water_temp_sensor_depth_m: '수온계 설치 수심',
  wave_sensor_height_m: '파고계 설치 위치',
}
const SPEC_ORDER = ['wind_sensor_height_m', 'water_temp_sensor_depth_m', 'wave_sensor_height_m', 'air_temp_sensor_height_m', 'pressure_sensor_height_m']

function SpecsBlock({ station, buoy }: { station: StationMeta | null; buoy: MergedBuoy }) {
  const specs = station?.specs ?? null
  const specValue = (key: string): string | undefined => {
    const f = specs?.[key]
    if (!f || f.value_m == null) return undefined
    const secondary = f.secondary_value_m != null ? ` / ${f.secondary_value_m}` : ''
    const depth = f.below_surface ? ' (수면 아래)' : ''
    return `${f.value_m}${secondary} m${depth}`
  }

  const rows: { label: string; value?: string | null }[] = [
    { label: '부이형식', value: station?.form },
    { label: '지점코드', value: station?.stn_id ?? buoy.id },
    { label: '관측개시일', value: station?.obs_start_date },
    ...(specs
      ? SPEC_ORDER.filter(k => specs[k]).map(k => ({ label: SPEC_SHORT_LABEL[k], value: specValue(k) }))
      : [{ label: '센서 제원', value: undefined }]),
    { label: '정밀 좌표', value: `${buoy.lat.toFixed(4)}°N, ${buoy.lon.toFixed(4)}°E` },
  ]

  return (
    <Section title="지점 제원">
      {/* '발행기관' 셀 제거(§12) — 헤더 Source 태그와 중복.
          §22 — 카드 그리드 대신 헤어라인 기반 정의(definition) 테이블로 재설계(연구용 제원표 톤).
          색·배경 없이 borderTop 헤어라인만으로 행을 구분하고, 마지막 행 아래에 닫음선을 하나 더 둔다. */}
      <table style={{ width: '100%', borderCollapse: 'collapse', borderBottom: '1px solid var(--line-soft)' }}>
        <tbody>
          {rows.map((r, i) => <SpecRow key={`${r.label}-${i}`} label={r.label} value={r.value} />)}
        </tbody>
      </table>
    </Section>
  )
}

/** 값이 없으면 "—" 로 명시(지어낸 값 금지 — platform_benchmarks.md Q4/NDBC "MM" 관행). */
function SpecRow({ label, value }: { label: string; value?: string | null }) {
  const empty = !value || value === '-'
  return (
    <tr style={{ borderTop: '1px solid var(--line-soft)' }}>
      <th scope="row" style={{
        textAlign: 'left', width: '42%', fontSize: 13, fontWeight: 600, color: 'var(--t-lo)',
        padding: '9px 12px 9px 2px', verticalAlign: 'top', fontFamily: 'inherit',
      }}>{label}</th>
      <td className="tnum" style={{ fontSize: 14, fontWeight: 600, color: empty ? 'var(--t-lo)' : 'var(--t-hi)', padding: '9px 0' }}>
        {empty ? '—' : value}
      </td>
    </tr>
  )
}
