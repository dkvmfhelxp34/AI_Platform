/**
 * LeftPanel — §19(2026-07-16) "통합 리스트(깔끔)" 하단 재설계 + §25(2026-07-16) 디클러터 패스
 * + §25-b(2026-07-16) 카테고리 그룹 아코디언 + §25-c/d/e(2026-07-16) 상태 타일 위계 강화·
 * 용어 통일·리스트 구간 분리.
 * - 상단(유지): 상태 3타일(필터와 동일 소스로 클릭 토글).
 * - **필터 섹션 축소(§25)**: "상태" 체크박스 그룹 삭제(바로 위 3타일이 이미 같은 visibleStatuses
 *   를 토글해 완전 중복이었다) — 남은 건 "유형" 그룹 하나뿐이라 헤더 두 줄(필터→유형) 대신 한 줄
 *   (유형 라벨 + 전체/모두해제 + 필터초기화)로 접는다.
 * - **하이라이트 칩 제거(§25)**: 최대 풍속 칩은 헤더 KPI 클러스터로 이전 — 좌패널엔 더 이상 없다.
 * - 검색/정렬 툴바(유지, 리스트 바로 위).
 * - **단일 통합 리스트**: ① 예외 블록 — 지연·미수신만 심각도순, 행 배경에 은은한 상태 틴트로 표시
 *   (큰 카드·스파크라인 없이 한 줄), ② 카테고리 그룹(해양기상부이/파고부이/해양관측부이) — 얇은
 *   헤더(라벨+카운트) 뒤에 **정상 지점만**(중복 회피, 예외는 위 블록에만) 컴팩트 한 줄 행.
 * - 행은 34~40px 높이의 단일 라인(글리프+이름+(기관)+우측 값)으로 통일 — 전 UnifiedRow 하나가
 *   variant(exception|normal)로 두 톤을 렌더한다.
 * - 기관명: 모든 행에 "(기상청)"/"(국립해양조사원)" 병기(기존 방침 유지).
 * - **카테고리 그룹 아코디언(§25-b)**: 4개 그룹 헤더가 토글 버튼 — 기본 전부 접힘(슬림 헤더만
 *   노출, 행 없음) · 검색어가 있으면 collapsedGroups 무시하고 매치된 그룹은 강제 펼침(결과는
 *   항상 보임) · 지도 마커 클릭 등으로 selectedStationId 가 바뀌면 그 부이의 카테고리를
 *   collapsedGroups 에서 제거해 자동으로 펼친다. 패널 자체는 App 에서 display:none 으로만
 *   숨기므로(언마운트 아님) 이 접힘 상태는 별도 영속화 없이 그대로 유지된다.
 * - **상태 타일 위계 강화(§25-c)**: 상단 3타일 라벨을 14.5px/700·숫자를 28px 로 키우고, 비활성
 *   (필터 해제) 상태는 dot 을 솔리드 대신 1.5px 링(투명 채움+STATUS_HEX 테두리)으로 바꿔 on/off 를
 *   한눈에 구분한다(라벨/숫자 색만으로는 약했다).
 * - **용어 통일(§25-d)**: 예외 블록 라벨 "주의 필요"→"수신 이상"(헤더 KPI 클러스터 KpiBar.tsx 의
 *   동일 스탯과 어휘를 맞춘다).
 * - **리스트 구간 분리(§25-e)**: 예외 블록과 카테고리 그룹 리스트 사이에 풀블리드 헤어라인(스크롤
 *   컨테이너 좌우 패딩을 음수 마진으로 상쇄해 패널 가장자리까지 확장) + "부이 목록" 이월헤더를
 *   추가해 두 구획의 성격 차이(예외 vs 유형별 전체 열람)를 분명히 한다.
 * - 최종 세로 순서: 부이 수신 현황(타일) → 유형 필터 → 검색+정렬 → 통합 리스트(예외 → 구분선 →
 *   부이 목록 → 카테고리 그룹).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { liveBuoys, compactElapsed, type MergedBuoy } from '../utils/buoys'
import { STATUS_HEX, STATUS_LABEL, SOURCE_LABEL, type BuoyStatus } from '../types'
import { categoryOf, CATEGORY_LABEL, CATEGORY_ORDER, type BuoyCategory } from '../utils/buoyCategory'
import BuoyGlyph from './BuoyGlyph'

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
const EXCEPTION_CAP = 14 // 예외 블록 최대 표시 행 수(그 이상은 "외 N건 더")

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
    visibleStatuses, visibleCategories,
    toggleStatus, toggleCategory, setAllCategories, resetFilters,
  } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, stationsError: s.stationsError, liveError: s.liveError,
      liveLoadedOnce: s.liveLoadedOnce, selectedStationId: s.selectedStationId, requestFlyTo: s.requestFlyTo,
      visibleStatuses: s.visibleStatuses, visibleCategories: s.visibleCategories,
      toggleStatus: s.toggleStatus,
      toggleCategory: s.toggleCategory, setAllCategories: s.setAllCategories,
      resetFilters: s.resetFilters,
    }))
  )

  const [sortMode, setSortMode] = useState<SortMode>('severity')
  const [search, setSearch] = useState('')
  const [searchFocused, setSearchFocused] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // §25-b — 카테고리 그룹 아코디언 접힘 상태(기본 전부 접힘). 검색 중엔 무시(강제 펼침, 아래
  // isGroupExpanded 참고), 선택된 부이가 바뀌면 그 그룹만 자동 펼침(아래 useEffect).
  const [collapsedGroups, setCollapsedGroups] = useState<Set<BuoyCategory>>(new Set(CATEGORY_ORDER))
  const toggleGroup = (cat: BuoyCategory) => setCollapsedGroups(prev => {
    const next = new Set(prev)
    if (next.has(cat)) next.delete(cat); else next.add(cat)
    return next
  })

  // 무데이터(수신 이력 없음) 지점은 이미 여기서 제외된 데이터셋(정상/지연/미수신만)
  const buoys = useMemo(() => liveBuoys(stations, live), [stations, live])

  // §25-b — 지도 마커 클릭 등으로 선택된 부이가 바뀌면, 그 부이가 속한 카테고리 그룹이 접혀
  // 있을 때만 펼친다(이미 펼쳐져 있으면 상태 갱신 없음 — prev 그대로 반환해 리렌더 스킵).
  useEffect(() => {
    if (!selectedStationId) return
    const b = buoys.find(x => x.id === selectedStationId)
    if (!b) return
    const cat = categoryOf(b)
    setCollapsedGroups(prev => {
      if (!prev.has(cat)) return prev
      const next = new Set(prev)
      next.delete(cat)
      return next
    })
  }, [selectedStationId, buoys])

  const statusCounts = useMemo(() => {
    const c: Record<BuoyStatus, number> = { '정상': 0, '지연': 0, '미수신': 0 }
    for (const b of buoys) c[b.status]++
    return c
  }, [buoys])

  const categoryCounts = useMemo(() => {
    const c: Record<BuoyCategory, number> = { 'kma-b': 0, 'kma-c': 0, 'khoa': 0, 'khoa-rip': 0 }
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

  // §19 — 통합 리스트의 카테고리 그룹은 "정상"만 담는다(§18-3 그룹 구조 유지 + 예외 중복 회피 —
  // 지연/미수신은 아래 exceptions 블록에서만 보여준다). `filtered` 는 이미 정렬돼 있으므로
  // 카테고리별로 나눠도(stable partition) 그룹 내부 순서는 선택된 정렬 기준을 그대로 유지한다.
  const grouped = useMemo(() => {
    const map = new Map<BuoyCategory, MergedBuoy[]>()
    for (const cat of CATEGORY_ORDER) map.set(cat, [])
    for (const b of filtered) {
      if (b.status !== '정상') continue
      map.get(categoryOf(b))!.push(b)
    }
    return map
  }, [filtered])

  const groupedCount = useMemo(() => {
    let n = 0
    grouped.forEach(list => { n += list.length })
    return n
  }, [grouped])

  // 수신 이상(예외 블록, §25-d — 헤더 KPI 클러스터의 "수신 이상"과 용어 통일) — 상태·종류
  // 체크박스 필터와는 무관하게 항상 노출(필터로 지연/미수신을
  // 숨겨도 경보 자체는 계속 보이게), 단 검색어는 통합 리스트 전체(예외+그룹)에 공통 적용한다.
  const exceptions = useMemo(() => {
    let list = buoys.filter(b => b.status !== '정상')
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      list = list.filter(b =>
        b.name.toLowerCase().includes(q) ||
        b.id.toLowerCase().includes(q) ||
        (b.name_en ?? '').toLowerCase().includes(q)
      )
    }
    return list.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name, 'ko'))
  }, [buoys, search])

  const loading = !liveLoadedOnce && stations.length === 0

  return (
    <aside className="uiz" style={{ width: 'clamp(320px, 21vw, 420px)', flexShrink: 0, background: 'var(--bg-panel)',
      borderRight: '1px solid var(--line)', display: 'flex', flexDirection: 'column', overflow: 'hidden',
      boxShadow: '6px 0 24px rgba(0,0,0,0.35)', position: 'relative', zIndex: 1 }}>

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

      {/* ── 필터 섹션(§25) — "상태" 체크박스 그룹은 위 3타일과 완전 중복이라 삭제. 남은 "유형"
          그룹 하나뿐이라 헤더는 한 줄(유형 라벨 + 전체/모두해제 + 필터초기화)로 접는다. ── */}
      <div style={{ borderBottom: '1px solid var(--line)', padding: '11px 10px', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', padding: '2px 6px 6px' }}>
          <span className="eyebrow">유형</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <button className="filter-link" style={{ fontSize: 12 }} onClick={() => setAllCategories(true)}>전체</button>
            <span style={{ color: 'var(--line)', fontSize: 12 }}>·</span>
            <button className="filter-link" style={{ fontSize: 12 }} onClick={() => setAllCategories(false)}>모두 해제</button>
            {filtersNarrowed && (
              <>
                <span style={{ color: 'var(--line)', fontSize: 12 }}>·</span>
                <button className="filter-link" style={{ fontSize: 12 }} onClick={resetFilters}>필터 초기화</button>
              </>
            )}
          </div>
        </div>

        {CATEGORY_ORDER.map(cat => (
          <FilterCheckRow key={cat} checked={visibleCategories.has(cat)} onChange={() => toggleCategory(cat)}
            label={CATEGORY_LABEL[cat]} count={categoryCounts[cat]}
            icon={<BuoyGlyph category={cat} fill="var(--t-mid)" size={13} />} />
        ))}
      </div>

      {/* ── Toolbar — 검색 + 정렬(한 줄로 압축, §19 밀도 확보) ── */}
      <div style={{ borderBottom: '1px solid var(--line)', borderTop: '1px solid var(--line)',
        padding: '8px 12px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ position: 'relative' }}>
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none"
            style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="5.5" cy="5.5" r="3.8" stroke="var(--t-lo)" strokeWidth="1.4" />
            <line x1="8.4" y1="8.4" x2="11.5" y2="11.5" stroke="var(--t-lo)" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <input ref={searchInputRef} value={search} onChange={e => setSearch(e.target.value)}
            placeholder="부이 이름·코드 검색…"
            aria-label="부이 검색"
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            style={{ width: '100%', padding: search ? '8px 28px 8px 30px' : '8px 11px 8px 30px',
              border: '1px solid ' + (searchFocused ? 'var(--accent)' : 'var(--line)'),
              borderRadius: 7, background: 'var(--bg-elev)', color: 'var(--t-hi)',
              fontSize: 14, fontFamily: 'inherit',
              boxShadow: searchFocused ? '0 0 0 2px rgba(78,154,201,0.35)' : 'none',
              transition: 'border-color 0.12s, box-shadow 0.12s' }} />
          {search && (
            <button type="button" aria-label="검색어 지우기"
              onClick={() => { setSearch(''); searchInputRef.current?.focus() }}
              style={{ position: 'absolute', right: 7, top: '50%', transform: 'translateY(-50%)',
                width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center',
                border: 'none', background: 'none', padding: 0, cursor: 'pointer', borderRadius: 4,
                fontSize: 14, lineHeight: 1, color: 'var(--t-lo)' }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--t-hi)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--t-lo)' }}>×</button>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="eyebrow" style={{ flexShrink: 0 }}>정렬</span>
          <div className="segctl" role="group" aria-label="목록 정렬 기준" style={{ flex: 1 }}>
            {SORT_MODES.map(m => (
              <button key={m.key} className="segctl-btn" aria-pressed={sortMode === m.key}
                onClick={() => setSortMode(m.key)}>{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* ── 통합 리스트(§19) — 예외 블록(지연·미수신, 상단 고정·틴트 행) + 카테고리 그룹(정상만,
          얇은 헤더+카운트) 을 하나의 스크롤 영역에 담는다. 큰 카드·스파크라인 없이 34~40px 단일
          라인 행만 사용 — "한 화면에 더 많이·깔끔하게". ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '2px 6px 10px' }}>
        {exceptions.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: '6px 8px 3px' }}>
              <span className="eyebrow" style={{ color: 'var(--lost)' }}>수신 이상</span>
              <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: 'var(--lost)',
                background: 'var(--lost-soft)', border: '1px solid var(--lost-border)', borderRadius: 10, padding: '0 6px' }}>
                {exceptions.length}
              </span>
            </div>
            {exceptions.slice(0, EXCEPTION_CAP).map(b => (
              <UnifiedRow key={b.id} b={b} variant="exception" sortMode={sortMode}
                isSel={b.id === selectedStationId} onClick={() => requestFlyTo(b.id)} />
            ))}
            {exceptions.length > EXCEPTION_CAP && (
              <div style={{ fontSize: 13, color: 'var(--t-lo)', textAlign: 'center', padding: '4px 0 2px' }}>
                외 {exceptions.length - EXCEPTION_CAP}건 더
              </div>
            )}
          </>
        )}

        {/* §25-e — 예외 블록(수신 이상)과 유형별 브라우즈 리스트(부이 목록) 사이 시각
            분리. 헤어라인은 스크롤 컨테이너 자체 좌우 패딩(6px)을 음수 마진으로 상쇄해 패널
            가장자리까지 풀블리드로 확장한다(다른 섹션 구분선과 동일하게 "edge-to-edge"). 예외가
            0건이면 헤어라인은 생략한다 — 바로 위 툴바의 하단 보더와 거의 붙어 "고아 선"처럼 겹쳐
            보이는 걸 막기 위함이고, "부이 목록" 이월헤더는 그룹이 하나라도 있는 한 항상 남겨
            구획 이름을 유지한다(단, 전체가 빈 상태 — 아래 큰 empty-state 문구가 뜨는 경우 —
            에는 라벨만 덩그러니 뜨는 걸 막기 위해 함께 숨긴다). */}
        {!(exceptions.length === 0 && groupedCount === 0) && (
          <>
            {exceptions.length > 0 && (
              <div style={{ height: 1, background: 'var(--line)', margin: '12px -6px 0' }} />
            )}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, padding: exceptions.length > 0 ? '10px 8px 3px' : '6px 8px 3px' }}>
              <span className="eyebrow">부이 목록</span>
            </div>
          </>
        )}

        {CATEGORY_ORDER.map(cat => {
          const list = grouped.get(cat) ?? []
          if (list.length === 0) return null
          // §25-b — 검색 중엔 collapsedGroups 를 무시하고 항상 펼침(매치 결과가 숨겨지지 않게).
          const expanded = search.trim() ? true : !collapsedGroups.has(cat)
          return (
            <div key={cat}>
              <CategoryGroupHeader label={CATEGORY_LABEL[cat]} count={list.length} expanded={expanded}
                onToggle={() => toggleGroup(cat)} />
              {expanded && list.map(b => (
                <UnifiedRow key={b.id} b={b} variant="normal" sortMode={sortMode}
                  isSel={b.id === selectedStationId} onClick={() => requestFlyTo(b.id)} />
              ))}
            </div>
          )
        })}

        {exceptions.length === 0 && groupedCount === 0 && (
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

// ── 통합 리스트 행(§19) — variant='exception'(지연·미수신, 상태 틴트 배경 + "상태·경과") 과
// variant='normal'(카테고리 그룹 소속, 정상만 + "파고·수온·경과") 을 하나의 34~40px 단일 라인으로
// 렌더한다. 큰 카드·스파크라인 없이 스캔하기 쉬운 밀도 있는 테이블 행.
function UnifiedRow({ b, variant, sortMode, isSel, onClick }: {
  b: MergedBuoy; variant: 'exception' | 'normal'; sortMode: SortMode; isSel: boolean; onClick: () => void
}) {
  const color = STATUS_HEX[b.status]
  const category = categoryOf(b)
  const isException = variant === 'exception'

  return (
    <div onClick={onClick} role="button" tabIndex={0}
      title={b.obs_time ?? undefined}
      aria-label={`${b.name} ${STATUS_LABEL[b.status]}`}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick() } }}
      className="station-card"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '7px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 1, minHeight: 20,
        background: isSel ? 'var(--bg-selected)' : (isException ? (b.status === '미수신' ? 'var(--lost-soft)' : 'var(--delay-soft)') : 'transparent'),
        borderLeft: `2.5px solid ${isSel ? 'var(--accent)' : 'transparent'}`,
        transition: 'background 0.12s var(--ease-out), border-color 0.12s var(--ease-out)',
      }}>
      <BuoyGlyph category={category} fill={color} size={13} />

      <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{ flex: '1 1 auto', minWidth: 0, fontWeight: 700, fontSize: 14, color: 'var(--t-hi)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</span>
        <span style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>
          ({SOURCE_LABEL[b.source]})
        </span>
      </div>

      {isException ? (
        <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color, whiteSpace: 'nowrap', flexShrink: 0 }}>
          {/* 안전망 — minutes_since 가 없으면(백엔드 백필도 실패한 진짜 이력없음) "· —"(끊김처럼
              보이는 표기) 대신 상태 라벨만 보여준다. 정상 케이스는 백엔드가 마지막 수신 시각을
              백필해주므로 대개 실제 경과시간이 붙는다. */}
          {b.minutes_since == null ? STATUS_LABEL[b.status] : `${STATUS_LABEL[b.status]} · ${compactElapsed(b.minutes_since)}`}
        </span>
      ) : (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexShrink: 0 }}>
          <CompactVal value={b.values.wave_height} unit="m" />
          {/* F1 — 정렬 기준이 '풍속'일 때는 수온 대신 풍속을 보여줘 지금 정렬 중인 값이 행에서
              바로 보이게 한다(그 외 정렬 기준은 기존대로 파고·수온 유지). */}
          {sortMode === 'wind'
            ? <CompactVal value={b.values.wind_speed} unit="m/s" />
            : <CompactVal value={b.values.water_temp} unit="℃" />}
          <span className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 500, minWidth: 32, textAlign: 'right' }}>
            {compactElapsed(b.minutes_since)}
          </span>
        </div>
      )}
    </div>
  )
}

/** 파고/수온 등 수치 컬럼 — 결측은 '—'. 우측 정렬 고정폭이라 여러 행에 걸쳐 세로로 값이 정렬돼
 *  보인다(테이블 느낌). */
function CompactVal({ value, unit }: { value: number | null | undefined; unit: string }) {
  if (value == null) {
    return <span className="tnum" style={{ fontSize: 13, color: 'var(--t-lo)', minWidth: 38, textAlign: 'right' }}>—</span>
  }
  return (
    <span className="tnum" style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-hi)', minWidth: 38,
      display: 'inline-flex', justifyContent: 'flex-end', alignItems: 'baseline', gap: 1 }}>
      {value.toFixed(1)}<span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)' }}>{unit}</span>
    </span>
  )
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
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        {/* §25-c — active 는 solid dot(+glow), inactive 는 1.5px 링(투명 채움 + STATUS_HEX
            테두리)으로 한눈에 구분(라벨·숫자 색만으로는 약해서 dot 도 형태 자체를 바꾼다). */}
        <span style={active
          ? { width: 9, height: 9, borderRadius: '50%', background: color, flexShrink: 0,
              boxShadow: `0 0 0 3px ${color}2E`, transition: 'box-shadow 0.14s' }
          : { width: 9, height: 9, borderRadius: '50%', background: 'transparent', boxSizing: 'border-box',
              border: `1.5px solid ${color}`, flexShrink: 0 }} />
        {/* §20/§25-c — 라벨을 14.5px/700 으로 승격해 위계를 강화(기존 13px/600 은 숫자 대비 너무
            약했다). active 는 t-mid, inactive 는 t-lo — dot 의 solid/ring 전환과 함께 상태를 전달. */}
        <span style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: 'normal',
          color: active ? 'var(--t-mid)' : 'var(--t-lo)' }}>{status}</span>
      </div>
      <div className="tnum" style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.02em',
        color: active ? color : 'var(--t-lo)', opacity: active ? 1 : 0.45, transition: 'color 0.14s, opacity 0.14s' }}>
        {count}
      </div>
    </button>
  )
}

/** 전체 리스트 카테고리 그룹 헤더(§18-3, 바다누리식 → §25-b 아코디언 토글) — 셰브런 + 라벨 +
 *  카운트 + 얇은 구분선을 감싸는 전폭 클릭 가능 버튼. 필터 섹션 헤더(유형 그룹, §25 — 한 줄로
 *  접힘)와는 별개 — 이쪽은 본문 콘텐츠 섹션 헤더다. */
function CategoryGroupHeader({ label, count, expanded, onToggle }: {
  label: string; count: number; expanded: boolean; onToggle: () => void
}) {
  return (
    <button onClick={onToggle} aria-expanded={expanded} className="group-header-btn" style={{
      display: 'flex', width: '100%', alignItems: 'center', gap: 8, padding: '9px 8px 5px',
      background: 'none', border: 'none', cursor: 'pointer', borderRadius: 6, textAlign: 'left',
      transition: 'background 0.12s var(--ease-out)',
    }}>
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{
        transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s var(--ease-out)',
        flexShrink: 0 }}>
        <path d="M5.5 3 L10.5 8 L5.5 13" stroke="var(--t-mid)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-mid)', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: 'var(--t-lo)' }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line-soft)', marginLeft: 2 }} />
    </button>
  )
}

/** 실제 체크박스(native input) — 시각적으로 커스텀 스킨(opacity:0 + .chk-box 대체 UI, index.css
 *  참고). 접근성·키보드 조작을 그대로 유지한다. `count` 는 선택(옵션) — 유형 필터 행(현재 유일한
 *  그룹, §25)은 비중복이라 항상 넘긴다. */
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
      {/* §20 — 필터 라벨은 항상 중간 위계(mid). 체크됨/해제됨은 체크박스 채움색으로 이미 구분되므로
          라벨 텍스트를 t-hi 까지 승격하지 않는다(라벨은 라벨, 핵심 데이터가 아님). */}
      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: checked ? 'var(--t-mid)' : 'var(--t-lo)' }}>{label}</span>
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
