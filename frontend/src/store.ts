import { create } from 'zustand'
import type { BaseLayer, LiveItem, StationMeta } from './types'

interface Store {
  stations: StationMeta[]
  stationsError: boolean
  live: LiveItem[]
  liveError: boolean
  liveLoadedOnce: boolean

  selectedStationId: string | null
  baseLayer: BaseLayer
  // LeftPanel 클릭 → 지도 이동 요청(마커 id). 지도가 처리 후 null로 되돌리지 않음(재클릭 시 재요청 위해 seq 사용).
  flyToRequest: { id: string; seq: number } | null

  // 상세 패널(우측 도크) — 열려있는 동안 AI 챗봇 자리표시를 대체(우선순위). 닫으면 챗봇으로 복귀.
  detailOpenId: string | null

  setStations: (s: StationMeta[]) => void
  setLive: (l: LiveItem[]) => void
  setSelectedStationId: (id: string | null) => void
  setBaseLayer: (v: BaseLayer) => void
  requestFlyTo: (id: string) => void
  openDetail: (id: string) => void
  closeDetail: () => void
  fetchStations: () => Promise<void>
  fetchLive: () => Promise<void>
  startPolling: () => () => void
}

let flySeq = 0

export const useStore = create<Store>((set, get) => ({
  stations: [],
  stationsError: false,
  live: [],
  liveError: false,
  liveLoadedOnce: false,

  selectedStationId: null,
  baseLayer: 'sat',
  flyToRequest: null,
  detailOpenId: null,

  setStations: (stations) => set({ stations, stationsError: false }),
  setLive: (live) => set({ live, liveError: false, liveLoadedOnce: true }),
  setSelectedStationId: (selectedStationId) => set({ selectedStationId }),
  setBaseLayer: (baseLayer) => set({ baseLayer }),
  requestFlyTo: (id) => set({ flyToRequest: { id, seq: ++flySeq }, selectedStationId: id }),
  openDetail: (id) => set({ detailOpenId: id, selectedStationId: id }),
  closeDetail: () => set({ detailOpenId: null }),

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
      set({ live: d.items ?? [], liveError: false, liveLoadedOnce: true })
    } catch {
      set({ liveError: true, liveLoadedOnce: true })
    }
  },

  startPolling: () => {
    get().fetchStations()
    get().fetchLive()
    const id = setInterval(() => get().fetchLive(), 60_000)
    return () => clearInterval(id)
  },
}))

// Dev helper — Playwright/콘솔에서 상태 점검용
if (import.meta.env.DEV) {
  ;(window as any).__buoyStore = useStore
}
