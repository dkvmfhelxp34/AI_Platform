import { create } from 'zustand'
import type { BaseLayer, BuoyStatus, LiveItem, StationMeta, StatusResponse } from './types'
import { CATEGORY_ORDER, type BuoyCategory } from './utils/buoyCategory'

const ALL_STATUSES: BuoyStatus[] = ['정상', '지연', '미수신']
const ANOMALY_STATUSES: BuoyStatus[] = ['지연', '미수신']

interface Store {
  stations: StationMeta[]
  stationsError: boolean
  live: LiveItem[]
  liveError: boolean
  liveLoadedOnce: boolean
  // 직전 폴링 스냅샷의 파고값(지점 id → wave_height) — 좌패널 컴팩트 행의 추세 화살표(▲/▼)를
  // 추가 API 호출 없이 계산하기 위한 가벼운 캐시(Wave 3b §8). 매 setLive 호출 시 "갱신 직전" 값으로 채운다.
  prevWaveById: Record<string, number | null>

  // /api/status — 헤더 배지·KpiBar·좌패널이 공유하는 운영 집계 SSOT(freshness/alerts/max_wave 등).
  status: StatusResponse | null
  statusError: boolean

  selectedStationId: string | null
  baseLayer: BaseLayer
  // LeftPanel 클릭 → 지도 이동 요청(마커 id). 지도가 처리 후 null로 되돌리지 않음(재클릭 시 재요청 위해 seq 사용).
  flyToRequest: { id: string; seq: number } | null

  // 상세 패널(우측 도크) — 열려있는 동안 AI 챗봇 자리표시를 대체(우선순위). 닫으면 챗봇으로 복귀.
  detailOpenId: string | null

  // ── 좌패널 체크박스 필터 — 상태·종류 2축을 함께 관리하는 단일 소스(single source of truth).
  //    좌패널 목록과 MapViewGL 마커가 이 값을 그대로 읽어 필터링하므로 항상 동기화된다.
  //    무데이터(수신 이력 없음) 지점은 데모 데이터셋에서 완전히 제외되므로 필터 축이 아니다
  //    (utils/buoys.ts liveBuoys() 참고).
  //    Set 은 매 토글마다 새 인스턴스로 교체(불변 갱신)해 zustand/React 리렌더를 정확히 트리거한다.
  visibleStatuses: Set<BuoyStatus>
  visibleCategories: Set<BuoyCategory>

  setStations: (s: StationMeta[]) => void
  setLive: (l: LiveItem[]) => void
  setSelectedStationId: (id: string | null) => void
  setBaseLayer: (v: BaseLayer) => void
  requestFlyTo: (id: string) => void
  openDetail: (id: string) => void
  closeDetail: () => void
  toggleStatus: (st: BuoyStatus) => void
  setAllStatuses: (on: boolean) => void
  toggleCategory: (cat: BuoyCategory) => void
  setAllCategories: (on: boolean) => void
  resetFilters: () => void
  /** KpiBar "활성 경보 N건" 클릭 → 좌패널/지도 필터를 지연·미수신만("이상만")으로 좁힌다. */
  filterAlertsOnly: () => void
  fetchStations: () => Promise<void>
  fetchLive: () => Promise<void>
  fetchStatus: () => Promise<void>
  startPolling: () => () => void
}

let flySeq = 0

export const useStore = create<Store>((set, get) => ({
  stations: [],
  stationsError: false,
  live: [],
  liveError: false,
  liveLoadedOnce: false,
  prevWaveById: {},
  status: null,
  statusError: false,

  selectedStationId: null,
  baseLayer: 'sat',
  flyToRequest: null,
  detailOpenId: null,
  visibleStatuses: new Set(ALL_STATUSES),
  visibleCategories: new Set(CATEGORY_ORDER),

  setStations: (stations) => set({ stations, stationsError: false }),
  setLive: (live) => set((s) => {
    const prevWaveById: Record<string, number | null> = {}
    for (const item of s.live) prevWaveById[item.id] = item.values.wave_height ?? null
    return { live, prevWaveById, liveError: false, liveLoadedOnce: true }
  }),
  setSelectedStationId: (selectedStationId) => set({ selectedStationId }),
  setBaseLayer: (baseLayer) => set({ baseLayer }),
  requestFlyTo: (id) => set({ flyToRequest: { id, seq: ++flySeq }, selectedStationId: id }),
  openDetail: (id) => set({ detailOpenId: id, selectedStationId: id }),
  closeDetail: () => set({ detailOpenId: null }),

  toggleStatus: (st) => set((s) => {
    const next = new Set(s.visibleStatuses)
    if (next.has(st)) next.delete(st); else next.add(st)
    return { visibleStatuses: next }
  }),
  setAllStatuses: (on) => set({ visibleStatuses: on ? new Set(ALL_STATUSES) : new Set() }),
  toggleCategory: (cat) => set((s) => {
    const next = new Set(s.visibleCategories)
    if (next.has(cat)) next.delete(cat); else next.add(cat)
    return { visibleCategories: next }
  }),
  setAllCategories: (on) => set({ visibleCategories: on ? new Set(CATEGORY_ORDER) : new Set() }),
  resetFilters: () => set({
    visibleStatuses: new Set(ALL_STATUSES), visibleCategories: new Set(CATEGORY_ORDER),
  }),
  filterAlertsOnly: () => set({ visibleStatuses: new Set(ANOMALY_STATUSES) }),

  fetchStations: async () => {
    try {
      const r = await fetch('/api/stations')
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      set({ stations: d.items ?? [], stationsError: false })
    } catch {
      set({ stationsError: true })
    }
  },

  fetchLive: async () => {
    try {
      const r = await fetch('/api/live')
      if (!r.ok) throw new Error(String(r.status))
      const d = await r.json()
      get().setLive(d.items ?? [])
    } catch {
      set({ liveError: true, liveLoadedOnce: true })
    }
  },

  fetchStatus: async () => {
    try {
      const r = await fetch('/api/status')
      if (!r.ok) throw new Error(String(r.status))
      const d: StatusResponse = await r.json()
      set({ status: d, statusError: false })
    } catch {
      set({ statusError: true })
    }
  },

  startPolling: () => {
    get().fetchStations()
    get().fetchLive()
    get().fetchStatus()
    const id = setInterval(() => { get().fetchLive(); get().fetchStatus() }, 60_000)
    return () => clearInterval(id)
  },
}))

// Dev helper — Playwright/콘솔에서 상태 점검용
if (import.meta.env.DEV) {
  ;(window as any).__buoyStore = useStore
}
