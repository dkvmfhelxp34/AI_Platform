/**
 * DetailDrawer — 상세 패널(Phase 3). 팝업 "상세" 버튼 → 우측 도크(챗봇 자리 대체)로 열림.
 * - 지점 제원(KMA 형식/센서고 · KHOA 코드/유형) + 현재 관측 mono 그리드 + Recharts 시계열.
 * - 시계열: `/api/timeseries?source=&id=&hours=` 조회, 메트릭/기간 칩, QC 플래그(관측기관) 점 오버레이.
 * - 알고리즘 기반 스파이크/결측 자동 QC 는 Phase 4 대상 — 여기서는 관측기관 QC(AQC/MQC)만 표시.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceDot,
} from 'recharts'
import { useStore } from '../store'
import { mergeBuoys, type MergedBuoy } from '../utils/buoys'
import {
  STATUS_HEX, STATUS_SOFT, STATUS_BORDER, STATUS_LABEL,
  type StationMeta, type TimeseriesMetric, type TimeseriesPoint, type TimeseriesResponse,
} from '../types'

// index.css 의 CSS 변수와 반드시 일치시킬 것(Recharts SVG 속성에는 hex 리터럴을 직접 넣는다 — types.ts STATUS_HEX 와 동일 패턴)
const ACCENT_HEX = '#4AA3FF'
const LOST_HEX = '#E06A78'
const LINE_HEX = '#223047'
const TLO_HEX = '#647688'
const BG_ELEV_HEX = '#16212F'

const METRICS: { key: TimeseriesMetric; label: string; unit: string }[] = [
  { key: 'wave', label: '파고', unit: 'm' },
  { key: 'water_temp', label: '수온', unit: '℃' },
  { key: 'wind_speed', label: '풍속', unit: 'm/s' },
  { key: 'pressure', label: '기압', unit: 'hPa' },
]

function degToCompass(deg: number | null | undefined): string {
  if (deg == null || !isFinite(deg)) return '-'
  const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
  return dirs[Math.round(deg / 45) % 8]
}

function hhmm(t: string): string {
  return t && t.length >= 16 ? t.slice(11, 16) : t
}

// ── Main ─────────────────────────────────────────────────────────────────
export default function DetailDrawer() {
  const { stations, live, detailOpenId, closeDetail } = useStore(
    useShallow(s => ({ stations: s.stations, live: s.live, detailOpenId: s.detailOpenId, closeDetail: s.closeDetail }))
  )

  const buoys = useMemo(() => mergeBuoys(stations, live), [stations, live])
  const buoy = useMemo(() => buoys.find(b => b.id === detailOpenId) ?? null, [buoys, detailOpenId])
  const station = useMemo(() => stations.find(s => s.id === detailOpenId) ?? null, [stations, detailOpenId])

  const [hours, setHours] = useState<24 | 48>(24)
  const [metric, setMetric] = useState<TimeseriesMetric>('wave')
  const [ts, setTs] = useState<TimeseriesResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!buoy) return
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`/api/timeseries?source=${buoy.source}&id=${encodeURIComponent(buoy.id)}&hours=${hours}`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d: TimeseriesResponse) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setTs(d)
      })
      .catch(() => { if (!cancelled) { setError('이 지점은 실시간 이력이 제공되지 않습니다'); setTs(null) } })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [buoy?.id, buoy?.source, hours])

  useEffect(() => {
    if (!detailOpenId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeDetail() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [detailOpenId, closeDetail])

  if (!detailOpenId) return null

  return (
    <aside className="detail-drawer" style={{
      width: 'clamp(460px, 32vw, 560px)', flexShrink: 0, background: 'var(--bg-base)',
      borderLeft: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {!buoy ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t-lo)', fontSize: 13 }}>
          지점 정보를 불러오는 중…
        </div>
      ) : (
        <>
          <DrawerHeader buoy={buoy} onClose={closeDetail} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '16px' }}>
            <SpecsBlock station={station} buoy={buoy} />
            <CurrentReadout buoy={buoy} />
            <TimeseriesSection
              buoy={buoy} hours={hours} setHours={setHours}
              metric={metric} setMetric={setMetric}
              ts={ts} loading={loading} error={error}
            />
          </div>
        </>
      )}
    </aside>
  )
}

// ── Header ───────────────────────────────────────────────────────────────
function DrawerHeader({ buoy, onClose }: { buoy: MergedBuoy; onClose: () => void }) {
  const hex = STATUS_HEX[buoy.status]
  return (
    <div style={{
      background: 'var(--bg-panel)', borderBottom: '1px solid var(--line)',
      padding: '14px 16px', flexShrink: 0, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10,
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t-hi)', letterSpacing: '-0.01em', lineHeight: 1.25 }}>
          {buoy.name}
        </div>
        {buoy.name_en && <div style={{ fontSize: 11.5, color: 'var(--t-lo)', marginTop: 2 }}>{buoy.name_en}</div>}
        <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap', alignItems: 'center' }}>
          <Tag label={buoy.source} />
          <Tag label={buoy.tp_label ?? buoy.tp} />
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: hex,
            background: STATUS_SOFT[buoy.status], border: `1px solid ${STATUS_BORDER[buoy.status]}`,
            borderRadius: 20, padding: '3px 9px 3px 7px',
          }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: hex, flexShrink: 0 }} />
            {STATUS_LABEL[buoy.status]}
          </span>
        </div>
      </div>
      <button onClick={onClose} aria-label="상세 패널 닫기" title="닫기" style={{
        width: 26, height: 26, borderRadius: 6, flexShrink: 0, cursor: 'pointer',
        background: 'var(--bg-elev)', border: '1px solid var(--line)', color: 'var(--t-mid)',
        fontSize: 15, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        transition: 'color 0.12s, border-color 0.12s',
      }}>×</button>
    </div>
  )
}

function Tag({ label }: { label: string }) {
  return (
    <span className="mono" style={{
      fontSize: 10.5, fontWeight: 500, color: 'var(--t-mid)',
      border: '1px solid var(--line)', borderRadius: 4, padding: '2px 7px',
    }}>{label}</span>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="eyebrow" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  )
}

// ── Specs ────────────────────────────────────────────────────────────────
function SpecsBlock({ station, buoy }: { station: StationMeta | null; buoy: MergedBuoy }) {
  if (!station) return null
  const isKMA = station.source === 'KMA'
  const sh = station.sensor_heights ?? {}
  return (
    <Section title="지점 제원">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {isKMA ? (
          <>
            <SpecCell label="부이형식" value={station.form ?? '-'} />
            <SpecCell label="지점코드" value={station.stn_id ?? station.id} />
            <SpecCell label="센서고 · 수온" value={sh.tw ? `${sh.tw} m` : '-'} />
            <SpecCell label="센서고 · 파고" value={sh.wh ? `${sh.wh} m` : '-'} />
            <SpecCell label="센서고 · 풍향" value={sh.wd ? `${sh.wd} m` : '-'} />
          </>
        ) : (
          <>
            <SpecCell label="코드" value={station.stn_id ?? station.id} />
            <SpecCell label="유형" value={buoy.tp ?? station.tp ?? '-'} />
          </>
        )}
      </div>
    </Section>
  )
}

function SpecCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 5, padding: '7px 9px' }}>
      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t-hi)' }}>{value}</div>
    </div>
  )
}

// ── Current readout ──────────────────────────────────────────────────────
function CurrentReadout({ buoy }: { buoy: MergedBuoy }) {
  const v = buoy.values
  const cells: { label: string; value: string; unit?: string }[] = []
  if (v.wave_height != null) cells.push({ label: '파고', value: v.wave_height.toFixed(1), unit: 'm' })
  if (v.wind_speed != null) cells.push({
    label: `풍속 (${degToCompass(v.wind_dir)}${v.wind_dir != null ? ` ${Math.round(v.wind_dir)}°` : ''})`,
    value: v.wind_speed.toFixed(1), unit: 'm/s',
  })
  if (v.water_temp != null) cells.push({ label: '수온', value: v.water_temp.toFixed(1), unit: '℃' })
  if (v.pressure != null) cells.push({ label: '기압', value: v.pressure.toFixed(1), unit: 'hPa' })

  return (
    <Section title="현재 관측">
      {cells.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {cells.map(c => (
            <div key={c.label} style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 5, padding: '9px 11px' }}>
              <div className="eyebrow" style={{ fontSize: 9, marginBottom: 4 }}>{c.label}</div>
              <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: 'var(--t-hi)' }}>
                {c.value}{c.unit && <span style={{ fontSize: 11, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 3 }}>{c.unit}</span>}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12.5, color: 'var(--t-lo)', padding: '10px 0' }}>표시할 관측값이 없습니다</div>
      )}
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--t-lo)', marginTop: 8 }}>
        {buoy.obs_time ?? '관측 이력 없음'} · {buoy.lat.toFixed(3)}°N, {buoy.lon.toFixed(3)}°E
      </div>
    </Section>
  )
}

// ── Timeseries ───────────────────────────────────────────────────────────
function TimeseriesSection({ buoy, hours, setHours, metric, setMetric, ts, loading, error }: {
  buoy: MergedBuoy
  hours: 24 | 48
  setHours: (h: 24 | 48) => void
  metric: TimeseriesMetric
  setMetric: (m: TimeseriesMetric) => void
  ts: TimeseriesResponse | null
  loading: boolean
  error: string | null
}) {
  const metricCfg = METRICS.find(m => m.key === metric)!
  const points = ts?.points ?? []
  const flaggedDots = useMemo(
    () => points.filter(p => p.qc.flagged && p[metric] != null),
    [points, metric]
  )

  return (
    <Section title="시계열">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {METRICS.map(m => (
            <Chip key={m.key} active={metric === m.key} onClick={() => setMetric(m.key)}>
              {m.label} <span style={{ opacity: 0.65 }}>{m.unit}</span>
            </Chip>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {([24, 48] as const).map(h => (
            <Chip key={h} active={hours === h} onClick={() => setHours(h)}>{h}h</Chip>
          ))}
        </div>
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: '12px 12px 6px' }}>
        {loading ? (
          <EmptyState text="관측 이력을 불러오는 중…" />
        ) : error ? (
          <EmptyState text={error} />
        ) : points.length === 0 ? (
          <EmptyState text="표시할 관측 이력이 없습니다" />
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ top: 6, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke={LINE_HEX} strokeDasharray="2 4" vertical={false} />
              <XAxis dataKey="t" tickFormatter={hhmm}
                tick={{ fontSize: 10, fill: TLO_HEX, fontFamily: 'var(--font-mono)' }}
                axisLine={{ stroke: LINE_HEX }} tickLine={false}
                interval={Math.max(0, Math.floor(points.length / 6) - 1)} minTickGap={20} />
              <YAxis tick={{ fontSize: 10, fill: TLO_HEX, fontFamily: 'var(--font-mono)' }}
                axisLine={false} tickLine={false} width={36} domain={['auto', 'auto']} />
              <Tooltip content={<ChartTooltip unit={metricCfg.unit} metricLabel={metricCfg.label} />}
                cursor={{ stroke: LINE_HEX }} />
              <Line type="monotone" dataKey={metric} stroke={ACCENT_HEX} strokeWidth={1.6}
                dot={false} isAnimationActive={false} connectNulls />
              {flaggedDots.map(p => (
                <ReferenceDot key={`qc-${p.t}`} x={p.t} y={p[metric] as number}
                  r={3.2} fill={LOST_HEX} stroke={BG_ELEV_HEX} strokeWidth={1} ifOverflow="extendDomain" />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {!loading && !error && points.length > 0 && (
        <div style={{ marginTop: 9, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: 'var(--t-lo)' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: LOST_HEX, flexShrink: 0 }} />
            <span>● QC 플래그(관측기관){ts && ts.qc_summary.flagged_count > 0 ? ` — ${ts.qc_summary.flagged_count}건` : ''}</span>
          </div>
          {ts && !ts.qc_summary.checked && (
            <div style={{ fontSize: 10.5, color: 'var(--t-lo)' }}>
              QC 미검사 — {buoy.source === 'KHOA' ? 'KHOA 실시간 자료는 기관 QC 플래그를 제공하지 않습니다' : '이 구간은 관측기관 QC 검사 이력이 없습니다'}
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--t-lo)' }}>
            알고리즘 기반 이상치·결측 자동 탐지(AI QC)는 다음 단계(Phase 4)에서 추가됩니다.
          </div>
        </div>
      )}
      {ts?.unit_notes && (
        <div className="mono" style={{ fontSize: 9.5, color: 'var(--t-lo)', marginTop: 8, lineHeight: 1.5 }}>
          {ts.unit_notes}
        </div>
      )}
    </Section>
  )
}

function ChartTooltip({ active, payload, label, unit, metricLabel }: {
  active?: boolean
  payload?: { value?: number | null; payload: TimeseriesPoint }[]
  label?: string
  unit: string
  metricLabel: string
}) {
  if (!active || !payload || !payload.length) return null
  const entry = payload[0]
  const point = entry.payload
  return (
    <div style={{ background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 6,
      padding: '8px 10px', boxShadow: 'var(--shadow-md)' }}>
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--t-lo)', marginBottom: 4 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-hi)' }}>
        {metricLabel} {entry.value != null ? Number(entry.value).toFixed(1) : '-'}
        <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 3 }}>{unit}</span>
      </div>
      {point?.qc.flagged && (
        <div style={{ fontSize: 10, color: 'var(--lost)', marginTop: 4 }}>● QC 플래그(관측기관)</div>
      )}
    </div>
  )
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className="mono" style={{
      padding: '5px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11.5, fontWeight: 500,
      border: `1px solid ${active ? 'var(--accent-dim)' : 'var(--line)'}`,
      background: active ? 'var(--accent-50)' : 'transparent',
      color: active ? 'var(--accent-h)' : 'var(--t-mid)',
      transition: 'border-color 0.12s, color 0.12s',
    }}>{children}</button>
  )
}

function EmptyState({ text }: { text: string }) {
  return (
    <div style={{ height: 220, display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--t-lo)', fontSize: 12.5, textAlign: 'center', padding: '0 20px' }}>
      {text}
    </div>
  )
}
