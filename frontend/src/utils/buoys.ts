import type { BuoyStatus, LiveItem, StationMeta } from '../types'

/** 지도·좌측패널이 공유하는 단일 부이 표시 레코드 — /api/stations(제원) 과 /api/live(실시간 스냅샷)를 병합.
 *  live 에 없는 지점(이번 데모 범위상 KHOA 전 41개소 중 일부만 실시간 폴링)도 좌표는 stations 로 채워
 *  '미수신'으로 지도에 표시한다 — 전체 141개소 통합 레지스트리 스토리를 지도에서도 일관되게 유지. */
export interface MergedBuoy {
  id: string
  source: 'KMA' | 'KHOA'
  name: string
  name_en?: string
  tp: string
  tp_label?: string
  lon: number
  lat: number
  obs_time: string | null
  status: BuoyStatus
  minutes_since: number | null
  values: LiveItem['values']
  hasLive: boolean
}

export function mergeBuoys(stations: StationMeta[], live: LiveItem[]): MergedBuoy[] {
  const liveById = new Map(live.map(l => [l.id, l]))
  const seen = new Set<string>()
  const out: MergedBuoy[] = []

  for (const s of stations) {
    seen.add(s.id)
    const l = liveById.get(s.id)
    if (l) {
      out.push({
        id: s.id, source: s.source, name: l.name || s.name, name_en: s.name_en,
        tp: l.tp || s.tp, tp_label: l.tp_label || s.tp_label,
        lon: l.lon ?? s.lon, lat: l.lat ?? s.lat,
        obs_time: l.obs_time, status: l.status, minutes_since: l.minutes_since,
        values: l.values, hasLive: true,
      })
    } else {
      out.push({
        id: s.id, source: s.source, name: s.name, name_en: s.name_en,
        tp: s.tp, tp_label: s.tp_label,
        lon: s.lon, lat: s.lat,
        obs_time: null, status: '미수신', minutes_since: null,
        values: {}, hasLive: false,
      })
    }
  }

  // live 에는 있으나 stations 레지스트리에 없는 경우(방어적 — 정상 데이터에선 발생하지 않음)
  for (const l of live) {
    if (seen.has(l.id)) continue
    out.push({
      id: l.id, source: l.source, name: l.name, name_en: undefined,
      tp: l.tp, tp_label: l.tp_label, lon: l.lon, lat: l.lat,
      obs_time: l.obs_time, status: l.status, minutes_since: l.minutes_since,
      values: l.values, hasLive: true,
    })
  }

  return out
}
