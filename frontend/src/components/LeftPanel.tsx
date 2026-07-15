/**
 * LeftPanel — Wave 3b "이상 우선(exception-first)" 하단 재설계(ui_revision_notes §8).
 * - 상단(유지): 상태 3타일(필터와 동일 소스) + 상태·종류 체크박스 필터 — 사용자가 마음에 들어했던 부분.
 * - 하단(재설계): 키 큰 카드 리스트를 폐기하고
 *     ① 하이라이트 칩(최대 파고·최대 풍속 지점)
 *     ② "주의 필요" 섹션(지연·미수신을 심각도순으로 부각, 평시엔 "현재 이상 없음")
 *     ③ 전체 컴팩트 행 테이블(지점·(기관명)·상태·파고·수온·갱신, 정렬 토글 5종)
 *   순서로 배치한다.
 * - 스파크라인 비용 관리: 137개소 전체 행에 개별 시계열 fetch 를 붙이면 비용이 크므로, 실제 미니
 *   스파크라인(WaveSparkline, 자체 fetch)은 개수가 적은 "주의 필요" 행에만 붙이고, 전체 리스트의
 *   나머지 행은 **추가 API 호출 없이** store.prevWaveById(직전 폴링 스냅샷) 비교로 만든 가벼운
 *   추세 화살표(▲/▼)로 대체한다 — "가능하면 스파크라인"의 실용적 절충.
 * - 기관명: 모든 행에 "(기상청)"/"(국립해양조사원)" 병기(종류 코드만 표기하던 이전 방식 폐기).
 */
import { useMemo, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { liveBuoys, relativeFromMinutes, type MergedBuoy } from '../utils/buoys'
import { STATUS_HEX, STATUS_LABEL, SOURCE_LABEL, type BuoyStatus } from '../types'
import { categoryOf, CATEGORY_LABEL, CATEGORY_ORDER, type BuoyCategory } from '../utils/buoyCategory'
import BuoyGlyph from './BuoyGlyph'
import WaveSparkline from './WaveSparkline'

type SortMode = 'severity' | 'wave' | 'wind' | 'freshness' | 'name'

const SORT_MODES: { key: SortMode; label: string }[] = [
  { key: 'severity', label: '심각도' },
  { key: 'wave', label: '파고' },
  { key: 'wind', label: '풍속' },
  { key: 'freshness', label: '신선도' },
  { key: 'name', label: '이름' },
]
const STATUS_RANK: Record<BuoyStatus, number> = { '미수신': 0, '지연': 1, '정상': 2 }
const STATUS_ORDER: BuoyStatus[] = ['정상', '지연', '미수신']
const MAX_EXCEPTION_SPARKLINES = 6 // 예외 행 스파크라인 fetch 상한(비용 관리)

function sortBuoys(list: MergedBuoy[], mode: SortMode): MergedBuoy[] {
  const byName = (a: MergedBuoy, b: MergedBuoy) => a.name.localeCompare(b.name, 'ko')
  if (mode === 'name') return [...list].sort(byName)
  if (mode === 'severity') return [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || byName(a, b))
  if (mode === 'wind') return [...list].sort((a, b) => {
    const av = a.values.wind_speed, bv = b.values.wind_speed
    if (av == null && bv == null) return byName(a, b)
    if (av == null) return 1
    if (bv == null) return -1
    return bv - av || byName(a, b)
  })
  if (mode === 'freshness') return [...list].sort((a, b) => {
    const av = a.minutes_since, bv = b.minutes_since
    if (av == null && bv == null) return byName(a, b)
    if (av == null) return 1
    if (bv == null) return -1
    return av - bv || byName(a, b)
  })
  // wave: 값 큰 순, 결측은 뒤로
  return [...list].sort((a, b) => {
    const av = a.values.wave_height, bv = b.values.wave_height
    if (av == null && bv == null) return byName(a, b)
    if (av == null) return 1
    if (bv == null) return -1
    return bv - av || byName(a, b)
  })
}

export default function LeftPanel() {
  const {
    stations, live, stationsError, liveError, liveLoadedOnce, selectedStationId, requestFlyTo,
    visibleStatuses, visibleCategories, prevWaveById,
    toggleStatus, setAllStatuses, toggleCategory, setAllCategories, resetFilters,
  } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, stationsError: s.stationsError, liveError: s.liveError,
      liveLoadedOnce: s.liveLoadedOnce, selectedStationId: s.selectedStationId, requestFlyTo: s.requestFlyTo,
      visibleStatuses: s.visibleStatuses, visibleCategories: s.visibleCategories,
      prevWaveById: s.prevWaveById,
      toggleStatus: s.toggleStatus, setAllStatuses: s.setAllStatuses,
      toggleCategory: s.toggleCategory, setAllCategories: s.setAllCategories,
      resetFilters: s.resetFilters,
    }))
  )

  const [sortMode, setSortMode] = useState<SortMode>('severity')
  const [search, setSearch] = useState('')

  // 무데이터(수신 이력 없음) 지점은 이미 여기서 제외된 데이터셋(정상/지연/미수신만)
  const buoys = useMemo(() => liveBuoys(stations, live), [stations, live])

  const statusCounts = useMemo(() => {
    const c: Record<BuoyStatus, number> = { '정상': 0, '지연': 0, '미수신': 0 }
    for (const b of buoys) c[b.status]++
    return c
  }, [buoys])

  const categoryCounts = useMemo(() => {
    const c: Record<BuoyCategory, number> = { 'kma-b': 0, 'kma-c': 0, 'khoa': 0 }
    for (const b of buoys) c[categoryOf(b)]++
    return c
  }, [buoys])

  const filtersNarrowed = visibleStatuses.size < STATUS_ORDER.length
    || visibleCategories.size < CATEGORY_ORDER.length

  // 체크박스 필터(store 단일 소스) + 검색 → 정렬
  const filtered = useMemo(() => {
    let list = buoys.filter(b =>
      visibleStatuses.has(b.status) &&
      visibleCategories.has(categoryOf(b))
    )
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(b =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.name_en ?? '').toLowerCase().includes(q)
      )
    }
    return sortBuoys(list, sortMode)
  }, [buoys, visibleStatuses, visibleCategories, search, sortMode])

  // 주의 필요 — 필터·검색과 무관하게 전체 데이터셋 기준(필터로 지연/미수신을 숨겨도 경보 자체는 계속 보이게)
  const exceptions = useMemo(
    () => buoys.filter(b => b.status !== '정상').sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name, 'ko')),
    [buoys]
  )

  const maxWind = useMemo(() => {
    let best: { name: string; value: number; id: string; source: MergedBuoy['source'] } | null = null
    for (const b of buoys) {
      const w = b.values.wind_speed
      if (w == null || !isFinite(w) || w < 0 || w > 60) continue
      if (!best || w > best.value) best = { name: b.name, value: w, id: b.id, source: b.source }
    }
    return best
  }, [buoys])

  const loading = !liveLoadedOnce && stations.length === 0

  return (
    <aside style={{ width: 'clamp(320px, 21vw, 420px)', flexShrink: 0, background: 'var(--bg-panel)',
      borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      boxShadow: '6px 0 24px rgba(0,0,0,0.38)', position: 'relative', zIndex: 1 }}>

      {/* ── Status summary — 상태 3타일(필터와 동일 소스로 클릭 시 토글) ── */}
      <div style={{ background: 'var(--bg-base)', borderBottom: '1px solid var(--line)', padding: '15px 16px 13px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 13 }}>
          <span className="eyebrow">부이 수신 현황</span>
          <span className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600 }}>총 {buoys.length}개소</span>
        </div>

        {stationsError && liveError ? (
          <InfoRow color="var(--lost)" title="데이터 로드 실패" sub="백엔드(8506) 연결을 확인해주세요" />
        ) : loading ? (
          <InfoRow color="var(--t-lo)" title="불러오는 중…" sub="관측소·실시간 자료 로딩" />
        ) : (
          <div style={{ display: 'flex' }}>
            {STATUS_ORDER.map((st, i) => (
              <StatReadout key={st} status={st} count={statusCounts[st]}
                active={visibleStatuses.has(st)}
                onClick={() => toggleStatus(st)}
                divider={i > 0} />
            ))}
          </div>
        )}
      </div>

      {/* ── 필터 섹션 — 상태·종류 체크박스(목록+지도 공용 단일 소스) ── */}
      <div style={{ borderBottom: '1px solid var(--line)', padding: '11px 10px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '2px 6px 6px' }}>
          <span className="eyebrow">필터</span>
          {filtersNarrowed && (
            <button className="filter-link" onClick={resetFilters}>필터 초기화</button>
          )}
        </div>

        <FilterGroupHeader label="상태" onAll={() => setAllStatuses(true)} onNone={() => setAllStatuses(false)} />
        {/* 상태 필터 행 — 카운트 숫자 미표기(§12: 바로 위 3타일과 100% 중복이라 제거) */}
        {STATUS_ORDER.map(st => (
          <FilterCheckRow key={st} checked={visibleStatuses.has(st)} onChange={() => toggleStatus(st)}
            label={STATUS_LABEL[st]}
            icon={<span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_HEX[st], flexShrink: 0 }} />} />
        ))}

        <FilterGroupHeader label="종류" onAll={() => setAllCategories(true)} onNone={() => setAllCategories(false)} />
        {CATEGORY_ORDER.map(cat => (
          <FilterCheckRow key={cat} checked={visibleCategories.has(cat)} onChange={() => toggleCategory(cat)}
            label={CATEGORY_LABEL[cat]} count={categoryCounts[cat]}
            icon={<BuoyGlyph category={cat} fill="var(--t-mid)" stroke="rgba(255,255,255,0.25)" size={13} />} />
        ))}
      </div>

      {/* ── 하이라이트 칩 — '최대 파고'는 KpiBar 와 중복이라 제거(§12), '최대 풍속'만 유지(KPI에
          없어 비중복). 단일 칩이라 flex:1 로 폭 전체를 늘리지 않고 자연스러운 폭으로 좌측 정렬한다. ── */}
      {!loading && maxWind && (
        <div style={{ display: 'flex', padding: '11px 12px', borderBottom: '1px solid var(--line)', flexShrink: 0 }}>
          <HighlightChip label="최대 풍속" name={maxWind.name} value={maxWind.value.toFixed(1)} unit="m/s"
            onClick={() => requestFlyTo(maxWind.id)} />
        </div>
      )}

      {/* ── 주의 필요(exception-first) ── */}
      {!loading && (
        <div style={{ padding: '11px 12px 0', flexShrink: 0 }}>
          <div className="eyebrow" style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            주의 필요
            {exceptions.length > 0 && (
              <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: 'var(--lost)',
                background: 'var(--lost-soft)', border: '1px solid var(--lost-border)', borderRadius: 10, padding: '0 6px' }}>
                {exceptions.length}
              </span>
            )}
          </div>
          {exceptions.length === 0 ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--ok-soft)',
              border: '1px solid var(--ok-border)', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--ok)', flexShrink: 0 }} />
              <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--t-mid)' }}>현재 이상 없음 — 모든 부이 정상 수신</span>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 12 }}>
              {exceptions.slice(0, 10).map((b, i) => (
                <ExceptionRow key={b.id} b={b} withSparkline={i < MAX_EXCEPTION_SPARKLINES}
                  isSel={b.id === selectedStationId} onClick={() => requestFlyTo(b.id)} />
              ))}
              {exceptions.length > 10 && (
                <div style={{ fontSize: 13, color: 'var(--t-lo)', textAlign: 'center', padding: '2px 0' }}>외 {exceptions.length - 10}건 더</div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Toolbar — 검색 + 정렬 세그먼트 ── */}
      <div style={{ borderBottom: '1px solid var(--line)', borderTop: '1px solid var(--line)',
        padding: '11px 16px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 9 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="5.5" cy="5.5" r="3.8" stroke="var(--t-lo)" strokeWidth="1.4" />
            <line x1="8.4" y1="8.4" x2="11.5" y2="11.5" stroke="var(--t-lo)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="부이 이름·코드 검색…"
            aria-label="부이 검색"
            style={{ width: '100%', padding: '8px 11px 8px 30px', border: '1px solid var(--line)',
              borderRadius: 7, background: 'var(--bg-elev)', color: 'var(--t-hi)',
              fontSize: 14, outline: 'none', fontFamily: 'inherit' }} />
        </div>

        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-lo)', marginBottom: 5 }}>정렬</div>
          <div className="segctl" role="group" aria-label="목록 정렬 기준">
            {SORT_MODES.map(m => (
              <button key={m.key} className="segctl-btn" aria-pressed={sortMode === m.key}
                onClick={() => setSortMode(m.key)}>{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── 전체 컴팩트 리스트 ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '5px 6px 10px' }}>
        {filtered.map(b => (
          <BuoyRow key={b.id} b={b} isSel={b.id === selectedStationId} onClick={() => requestFlyTo(b.id)}
            prevWave={prevWaveById[b.id]} />
        ))}

        {filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '36px 16px', color: 'var(--t-lo)', fontSize: 14 }}>
            {stationsError && liveError ? '데이터를 불러오지 못했습니다 — 새로고침(F5) 해주세요'
              : loading ? '목록 로딩 중…'
              : search.trim() ? '검색 결과가 없습니다'
              : filtersNarrowed ? (
                <>
                  <div>선택한 필터에 해당하는 부이가 없습니다</div>
                  <button className="filter-link" style={{ marginTop: 8, fontSize: 13 }} onClick={resetFilters}>필터 초기화</button>
                </>
              ) : '조건에 맞는 부이가 없습니다'}
          </div>
        )}
      </div>
    </aside>
  )
}

// ── 하이라이트 칩 ────────────────────────────────────────────────────────
function HighlightChip({ label, name, value, unit, onClick }: {
  label: string; name: string; value: string; unit: string; onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} style={{
      // 단일 칩(§12 — '최대 파고' 제거 후 유일 칩)이라 컨테이너 폭까지 늘어지지 않도록 자연스러운
      // 폭으로 좌측 정렬(구 flex:1 폐기).
      flexShrink: 0, minWidth: 168, maxWidth: 240, textAlign: 'left', cursor: onClick ? 'pointer' : 'default',
      background: 'var(--bg-elev)', border: '1px solid var(--line)', borderRadius: 8, padding: '8px 11px',
      font: 'inherit', transition: 'border-color 0.12s',
    }}>
      <div className="eyebrow" style={{ marginBottom: 3, fontSize: 13 }}>{label}</div>
      <div className="tnum" style={{ fontSize: 17, fontWeight: 700, color: 'var(--t-hi)', display: 'flex', alignItems: 'baseline', gap: 3 }}>
        {value}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)' }}>{unit}</span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t-mid)', fontWeight: 600, marginTop: 1,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
    </Comp>
  )
}

// ── 주의 필요 행(예외 — 스파크라인 포함, 소수만 렌더) ───────────────────────
function ExceptionRow({ b, withSparkline, isSel, onClick }: {
  b: MergedBuoy; withSparkline: boolean; isSel: boolean; onClick: () => void
}) {
  const color = STATUS_HEX[b.status]
  const category = categoryOf(b)
  return (
    <div onClick={onClick} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="station-card" style={{
        display: 'flex', flexDirection: 'column', gap: 6, padding: '9px 11px', borderRadius: 8, cursor: 'pointer',
        background: isSel ? 'var(--bg-selected)' : (b.status === '미수신' ? 'var(--lost-soft)' : 'var(--delay-soft)'),
        border: `1px solid ${isSel ? 'var(--accent-dim)' : (b.status === '미수신' ? 'var(--lost-border)' : 'var(--delay-border)')}`,
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 26, height: 26, borderRadius: 7, flexShrink: 0, background: 'var(--bg-elev)',
          border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <BuoyGlyph category={category} fill={color} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} size={13} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
            <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--t-hi)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
            <span style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600, whiteSpace: 'nowrap' }}>({SOURCE_LABEL[b.source]})</span>
          </div>
          <div className="tnum" style={{ fontSize: 13, fontWeight: 700, color, marginTop: 1 }}>
            {STATUS_LABEL[b.status]} · {relativeFromMinutes(b.minutes_since)}
          </div>
        </div>
      </div>
      {withSparkline && <WaveSparkline source={b.source} id={b.id} width={272} height={26} />}
    </div>
  )
}

// ── 전체 리스트 컴팩트 행 ────────────────────────────────────────────────
function BuoyRow({ b, isSel, onClick, prevWave }: { b: MergedBuoy; isSel: boolean; onClick: () => void; prevWave?: number | null }) {
  const color = STATUS_HEX[b.status]
  const category = categoryOf(b)
  const wave = b.values.wave_height
  const temp = b.values.water_temp
  const trend: 'up' | 'down' | null = (wave == null || prevWave == null || wave === prevWave) ? null : (wave > prevWave ? 'up' : 'down')

  return (
    <div onClick={onClick}
      role="button" tabIndex={0}
      title={b.obs_time ?? undefined}
      aria-label={`${b.name} ${STATUS_LABEL[b.status]}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="station-card"
      style={{
        display: 'flex', alignItems: 'center', gap: 9,
        padding: '7px 10px', borderRadius: 7, cursor: 'pointer', marginBottom: 2,
        background: isSel ? 'var(--bg-selected)' : 'transparent',
        borderLeft: `2.5px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
        transition: 'background 0.12s var(--ease-out), border-color 0.12s var(--ease-out)',
      }}>
      <div style={{
        width: 27, height: 27, borderRadius: 7, flexShrink: 0,
        background: 'var(--bg-elev)', border: '1px solid var(--line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <BuoyGlyph category={category} fill={color} stroke="rgba(255,255,255,0.4)" strokeWidth={1.5} size={13.5} />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
          <span style={{ fontWeight: 700, fontSize: 14.5, color: 'var(--t-hi)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
          <span style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
            ({SOURCE_LABEL[b.source]})
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
          <span className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 500 }}>
            {relativeFromMinutes(b.minutes_since)}
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexShrink: 0 }}>
        {wave != null ? <StatPill value={wave.toFixed(1)} unit="m" trend={trend} /> : <EmptyPill />}
        {temp != null ? <StatPill value={temp.toFixed(1)} unit="℃" /> : <EmptyPill />}
      </div>
    </div>
  )
}

function StatPill({ value, unit, trend }: { value: string; unit: string; trend?: 'up' | 'down' | null }) {
  return (
    <div className="tnum" style={{ fontSize: 14.5, fontWeight: 700, color: 'var(--t-hi)',
      display: 'flex', alignItems: 'baseline', gap: 2, minWidth: 40, justifyContent: 'flex-end' }}>
      {value}
      <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)' }}>{unit}</span>
      {trend && <span style={{ fontSize: 13, color: trend === 'up' ? 'var(--delay)' : 'var(--accent-h)', marginLeft: 1 }}>
        {trend === 'up' ? '▲' : '▼'}
      </span>}
    </div>
  )
}

function EmptyPill() {
  return <div style={{ fontSize: 13, color: 'var(--t-lo)', minWidth: 40, textAlign: 'right' }}>—</div>
}

function StatReadout({ status, count, active, onClick, divider }: {
  status: BuoyStatus; count: number; active: boolean; onClick: () => void; divider: boolean
}) {
  const color = STATUS_HEX[status]
  return (
    <button onClick={onClick} aria-pressed={active} title={active ? `${status} 필터 해제` : `${status}만 보기 추가`} style={{
      flex: 1, textAlign: 'left', cursor: 'pointer', background: 'none', border: 'none', padding: '0 12px 0 0',
      borderLeft: divider ? '1px solid var(--line)' : 'none',
      marginLeft: divider ? 12 : 0,
      opacity: active ? 1 : 0.4,
      transition: 'opacity 0.14s var(--ease-out)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0,
          boxShadow: active ? `0 0 0 3px ${color}2E` : 'none', transition: 'box-shadow 0.14s' }} />
        <span style={{ fontSize: 13, color: active ? 'var(--t-hi)' : 'var(--t-mid)', fontWeight: 600 }}>{status}</span>
      </div>
      <div className="tnum" style={{ fontSize: 22, fontWeight: 700, lineHeight: 1,
        color: active ? color : 'var(--t-hi)', transition: 'color 0.14s' }}>
        {count}
      </div>
    </button>
  )
}

/** 필터 섹션 그룹 라벨 + (선택) "전체/해제" 미니 편의 링크. */
function FilterGroupHeader({ label, onAll, onNone }: { label: string; onAll?: () => void; onNone?: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '8px 6px 3px' }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-lo)' }}>{label}</span>
      {(onAll || onNone) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {onAll && <button className="filter-link" onClick={onAll}>전체</button>}
          {onAll && onNone && <span style={{ color: 'var(--line)', fontSize: 13 }}>·</span>}
          {onNone && <button className="filter-link" onClick={onNone}>모두 해제</button>}
        </div>
      )}
    </div>
  )
}

/** 실제 체크박스(native input) — 시각적으로 커스텀 스킨. 접근성·키보드 조작을 그대로 유지한다.
 *  `count` 는 선택(옵션) — 상태 필터 행은 바로 위 3타일과 중복이라 생략하고(§12), 종류 필터 행은
 *  비중복이라 계속 넘긴다. */
function FilterCheckRow({ checked, onChange, icon, label, count }: {
  checked: boolean; onChange: () => void; icon: ReactNode; label: string; count?: number
}) {
  return (
    <label className="filter-row">
      <span className="chk-wrap">
        <input type="checkbox" className="chk-native" checked={checked} onChange={onChange} aria-label={label} />
        <span className="chk-box" aria-hidden="true">
          <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
            <path d="M1 3.6L3.2 5.8L8 1" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </span>
      {icon}
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: checked ? 'var(--t-hi)' : 'var(--t-lo)' }}>{label}</span>
      {count != null && (
        <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: checked ? 'var(--t-mid)' : 'var(--t-lo)' }}>{count}</span>
      )}
    </label>
  )
}

function InfoRow({ color, title, sub }: { color: string; title: string; sub: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10,
      background: 'var(--bg-elev)', border: '1px solid var(--line)',
      borderRadius: 7, padding: '10px 13px', boxShadow: 'var(--shadow-card)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-mid)' }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--t-lo)' }}>{sub}</div>
      </div>
    </div>
  )
}
