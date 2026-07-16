import type { BuoyStatus, LiveItem, StationMeta } from '../types'

/** 일부 KHOA 지점명이 "한수원_온양"처럼 원본 코드성 언더스코어를 그대로 달고 온다 — 지도 라벨·
 *  팝업·리스트·KPI 등 화면에 이름이 노출되는 모든 지점에서 공백으로 치환해 표기한다. */
export function formatStationName(name: string | null | undefined): string {
  return name ? name.replace(/_/g, ' ') : (name ?? '')
}

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
  /** §14 — 이 지점이 실제 제공하는 charted 지표(라이브 스냅샷에서 그대로 전달). 없으면(hasLive=false
   *  등 방어적 케이스) undefined — 소비측(DetailDrawer)이 전체 지표로 폴백한다. */
  available_metrics?: string[]
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
        id: s.id, source: s.source, name: formatStationName(l.name || s.name), name_en: s.name_en,
        tp: l.tp || s.tp, tp_label: l.tp_label || s.tp_label,
        lon: l.lon ?? s.lon, lat: l.lat ?? s.lat,
        obs_time: l.obs_time, status: l.status, minutes_since: l.minutes_since,
        values: l.values, hasLive: true, available_metrics: l.available_metrics,
      })
    } else {
      out.push({
        id: s.id, source: s.source, name: formatStationName(s.name), name_en: s.name_en,
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
      id: l.id, source: l.source, name: formatStationName(l.name), name_en: undefined,
      tp: l.tp, tp_label: l.tp_label, lon: l.lon, lat: l.lat,
      obs_time: l.obs_time, status: l.status, minutes_since: l.minutes_since,
      values: l.values, hasLive: true, available_metrics: l.available_metrics,
    })
  }

  return out
}

/** "무데이터" 판정 — Wave 2 백엔드는 등록된 지점(KMA B/C + KHOA 41개소) 전부에 대해 `/api/live`
 *  항목을 보장한다(한 번도 응답한 적 없는 KHOA 지점도 명시적 미수신 레코드로 채운다 — backend
 *  `_khoa_missing_item` 참고). 즉 `hasLive=true` 면 그 자체가 이미 백엔드가 판정한 상태(정상/
 *  지연/미수신)를 갖고 있으므로, `obs_time`/`values` 가 비었다고 프론트가 별도로 "무데이터"라며
 *  다시 숨기면 안 된다 — 그러면 `/api/status`(KpiBar SSOT)가 정직하게 센 미수신 카운트와 지도·
 *  좌패널 표시 개수가 어긋난다(헤더/KPI/리스트 SSOT 불일치, 5인 전문가 P0). 진짜 "무데이터"는
 *  `hasLive=false`(이번 세션의 백엔드 응답에 아예 레코드가 없는 방어적 케이스)뿐이다. */
export function isNoData(b: MergedBuoy): boolean {
  return !b.hasLive
}

/** 화면에 표시할 부이 데이터셋 — 진짜 무데이터(백엔드 응답 자체가 없는 방어적 케이스)만 제외한다
 *  (정상/지연/미수신 3상태를 다룬다). 지도·좌패널·KPI 밴드 등 화면에 나타나는 모든 집계·목록이
 *  이 함수를 단일 소스로 공유해 `/api/status` 집계와 어긋나지 않게 한다. */
export function liveBuoys(stations: StationMeta[], live: LiveItem[]): MergedBuoy[] {
  return mergeBuoys(stations, live).filter(b => !isNoData(b))
}

/** minutes_since(백엔드 freshness 계산치) → 좌패널 리치 로우용 상대시각 라벨. */
export function relativeFromMinutes(minutesSince: number | null): string {
  if (minutesSince == null || !isFinite(minutesSince)) return '수신 이력 없음'
  if (minutesSince < 1) return '방금 전'
  if (minutesSince < 60) return `${Math.round(minutesSince)}분 전`
  const hours = Math.floor(minutesSince / 60)
  if (hours < 24) return `${hours}시간 전`
  return `${Math.floor(hours / 24)}일 전`
}

/** relativeFromMinutes 의 초압축판(§19 통합 리스트 행) — "전" 접미사 없이 값만
 *  (예 "42분"·"3시간"·"2일") → 우측 정렬 컬럼에서 폭을 아낀다. 의미는 동일, 표기만 더 조밀하다. */
export function compactElapsed(minutesSince: number | null): string {
  if (minutesSince == null || !isFinite(minutesSince)) return '—'
  if (minutesSince < 1) return '방금'
  if (minutesSince < 60) return `${Math.round(minutesSince)}분`
  const hours = Math.floor(minutesSince / 60)
  if (hours < 24) return `${hours}시간`
  return `${Math.floor(hours / 24)}일`
}
