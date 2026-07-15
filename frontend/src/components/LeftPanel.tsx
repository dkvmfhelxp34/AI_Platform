import { useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { mergeBuoys } from '../utils/buoys'
import { STATUS_COLOR, STATUS_HEX, STATUS_LABEL, type BuoyStatus } from '../types'

type StatusFilter = 'all' | BuoyStatus
type SourceFilter = 'all' | 'KMA' | 'KHOA'

export default function LeftPanel() {
  const { stations, live, stationsError, liveError, liveLoadedOnce, selectedStationId, requestFlyTo } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, stationsError: s.stationsError, liveError: s.liveError,
      liveLoadedOnce: s.liveLoadedOnce, selectedStationId: s.selectedStationId, requestFlyTo: s.requestFlyTo,
    }))
  )

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')
  const [search, setSearch] = useState('')

  const buoys = useMemo(() => mergeBuoys(stations, live), [stations, live])

  const counts = useMemo(() => {
    const c: Record<BuoyStatus, number> = { '정상': 0, '지연': 0, '미수신': 0 }
    for (const b of buoys) c[b.status]++
    return c
  }, [buoys])

  const filtered = useMemo(() => {
    let list = buoys
    if (statusFilter !== 'all') list = list.filter(b => b.status === statusFilter)
    if (sourceFilter !== 'all') list = list.filter(b => b.source === sourceFilter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(b =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.name_en ?? '').toLowerCase().includes(q)
      )
    }
    // 정렬: 미수신/지연 먼저 노출(주의 환기) → 이름순
    const rank: Record<BuoyStatus, number> = { '미수신': 0, '지연': 1, '정상': 2 }
    return [...list].sort((a, b) => rank[a.status] - rank[b.status] || a.name.localeCompare(b.name, 'ko'))
  }, [buoys, statusFilter, sourceFilter, search])

  const loading = !liveLoadedOnce && stations.length === 0

  return (
    <aside style={{ width: 'clamp(300px, 19vw, 400px)', flexShrink: 0, background: 'var(--bg-base)',
      borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Status summary — 하이라인 구분, mono 숫자, 버블 카드 지양 ── */}
      <div style={{ borderBottom: '1px solid var(--line)', padding: '14px 16px 12px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <span className="eyebrow">부이 수신 현황</span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--t-lo)' }}>총 {buoys.length}개소</span>
        </div>

        {stationsError && liveError ? (
          <InfoRow color="var(--lost)" title="데이터 로드 실패" sub="백엔드(8506) 연결을 확인해주세요" />
        ) : loading ? (
          <InfoRow color="var(--t-lo)" title="불러오는 중…" sub="관측소·실시간 자료 로딩" />
        ) : (
          <div style={{ display: 'flex' }}>
            {(['정상', '지연', '미수신'] as BuoyStatus[]).map((st, i) => (
              <StatReadout key={st} status={st} count={counts[st]}
                active={statusFilter === st}
                onClick={() => setStatusFilter(f => f === st ? 'all' : st)}
                divider={i > 0} />
            ))}
          </div>
        )}
      </div>

      {/* ── Toolbar ── */}
      <div style={{ borderBottom: '1px solid var(--line)',
        padding: '12px 16px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ position: 'relative' }}>
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none"
            style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="5.5" cy="5.5" r="3.8" stroke="var(--t-lo)" strokeWidth="1.4" />
            <line x1="8.4" y1="8.4" x2="11.5" y2="11.5" stroke="var(--t-lo)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="부이 이름·코드 검색…"
            aria-label="부이 검색"
            style={{ width: '100%', padding: '7px 10px 7px 28px', border: '1px solid var(--line)',
              borderRadius: 6, background: 'var(--bg-panel)', color: 'var(--t-mid)',
              fontSize: 13, outline: 'none', fontFamily: 'inherit' }} />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['all', 'KMA', 'KHOA'] as SourceFilter[]).map(src => (
            <button key={src} onClick={() => setSourceFilter(src)}
              style={{
                flex: 1, padding: '6px 0', borderRadius: 5, cursor: 'pointer',
                fontSize: 12, fontWeight: 500,
                border: `1px solid ${sourceFilter === src ? 'var(--accent-dim)' : 'var(--line)'}`,
                background: sourceFilter === src ? 'var(--accent-50)' : 'transparent',
                color: sourceFilter === src ? 'var(--accent-h)' : 'var(--t-mid)',
                transition: 'border-color 0.12s, color 0.12s',
              }}>
              {src === 'all' ? '전체 기관' : src}
            </button>
          ))}
          {statusFilter !== 'all' && (
            <button onClick={() => setStatusFilter('all')}
              title="상태 필터 해제"
              className="mono"
              style={{ padding: '6px 10px', borderRadius: 5, cursor: 'pointer', fontSize: 11.5,
                border: '1px solid var(--line)', background: 'transparent', color: 'var(--t-lo)' }}>
              × {statusFilter}
            </button>
          )}
        </div>
      </div>

      {/* ── Buoy list ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '4px 6px' }}>
        {filtered.map(b => {
          const isSel = b.id === selectedStationId
          const color = STATUS_COLOR[b.status]
          const primaryVal = primaryValueLabel(b)
          return (
            <div key={b.id} onClick={() => requestFlyTo(b.id)}
              role="button" tabIndex={0}
              aria-label={`${b.name} ${STATUS_LABEL[b.status]}`}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); requestFlyTo(b.id) } }}
              className="station-card"
              style={{
                display: 'flex', alignItems: 'center', gap: 9,
                padding: '8px 10px 8px 9px', borderRadius: 5, cursor: 'pointer',
                background: isSel ? 'var(--bg-selected)' : 'transparent',
                borderLeft: `2px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
              }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--t-hi)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
                  <CodeTag source={b.source} tp={b.tp} />
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--t-lo)', marginTop: 2 }}>
                  {b.obs_time ? b.obs_time : '수신 이력 없음'}
                </div>
              </div>
              {primaryVal && (
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-hi)' }}>
                    {primaryVal.value}
                  </div>
                  <div className="eyebrow" style={{ fontSize: 9, marginTop: 1 }}>{primaryVal.label}</div>
                </div>
              )}
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px', color: 'var(--t-lo)', fontSize: 13 }}>
            {stationsError && liveError ? '데이터를 불러오지 못했습니다 — 새로고침(F5) 해주세요'
              : loading ? '목록 로딩 중…'
              : '검색 결과 없음'}
          </div>
        )}
      </div>
    </aside>
  )
}

function StatReadout({ status, count, active, onClick, divider }: {
  status: BuoyStatus; count: number; active: boolean; onClick: () => void; divider: boolean
}) {
  const color = STATUS_HEX[status]
  return (
    <button onClick={onClick} style={{
      flex: 1, textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none', padding: '0 12px 0 0',
      borderLeft: divider ? '1px solid var(--line)' : 'none',
      marginLeft: divider ? 12 : 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0,
          boxShadow: active ? `0 0 0 3px ${color}2E` : 'none', transition: 'box-shadow 0.14s' }} />
        <span style={{ fontSize: 11, color: active ? 'var(--t-hi)' : 'var(--t-mid)', fontWeight: 500 }}>{status}</span>
      </div>
      <div className="mono" style={{ fontSize: 20, fontWeight: 600, lineHeight: 1,
        color: active ? color : 'var(--t-hi)', transition: 'color 0.14s' }}>
        {count}
      </div>
    </button>
  )
}

function CodeTag({ source, tp }: { source: 'KMA' | 'KHOA'; tp: string }) {
  return (
    <span className="mono" style={{
      fontSize: 9.5, fontWeight: 500, color: 'var(--t-lo)', border: '1px solid var(--line)',
      borderRadius: 3, padding: '1px 5px', flexShrink: 0, letterSpacing: '0.01em',
    }}>{source}·{tp}</span>
  )
}

function primaryValueLabel(b: { values: { wave_height?: number | null; water_temp?: number | null } }): { value: string; label: string } | null {
  if (b.values.wave_height != null) return { value: `${b.values.wave_height.toFixed(1)}m`, label: '파고' }
  if (b.values.water_temp != null) return { value: `${b.values.water_temp.toFixed(1)}℃`, label: '수온' }
  return null
}

function InfoRow({ color, title, sub }: { color: string; title: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9,
      background: 'var(--bg-panel)', border: '1px solid var(--line)',
      borderRadius: 5, padding: '8px 12px' }}>
      <div style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-mid)' }}>{title}</div>
        <div style={{ fontSize: 11, color: 'var(--t-lo)' }}>{sub}</div>
      </div>
    </div>
  )
}
