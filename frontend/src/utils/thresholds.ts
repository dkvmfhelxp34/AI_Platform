// 파랑/강풍 특보 임계값(연구 톤 — platform_benchmarks.md Q5/D1) — KMA 해상 특보 공개 정량기준의
// 대표값을 사용한다: 풍랑주의보 = 유의파고 3m 이상 또는 10분평균풍속 14m/s 이상(3시간+ 지속),
// 풍랑경보 = 유의파고 5m 이상 또는 풍속 21m/s 이상. 지속시간 조건은 시연 범위상 생략하고 순간값
// 임계선만 시각화한다(과장 신뢰 방지 — 실제 특보 발표는 기상청 공식 채널 기준).
export const WAVE_THRESHOLDS = { caution: 3, warning: 5 } as const
export const WIND_THRESHOLDS = { caution: 14, warning: 21 } as const

export type ThresholdLevel = 'normal' | 'caution' | 'warning'

export function waveLevel(v: number | null | undefined): ThresholdLevel {
  if (v == null || !isFinite(v)) return 'normal'
  if (v >= WAVE_THRESHOLDS.warning) return 'warning'
  if (v >= WAVE_THRESHOLDS.caution) return 'caution'
  return 'normal'
}

export function windLevel(v: number | null | undefined): ThresholdLevel {
  if (v == null || !isFinite(v)) return 'normal'
  if (v >= WIND_THRESHOLDS.warning) return 'warning'
  if (v >= WIND_THRESHOLDS.caution) return 'caution'
  return 'normal'
}

// 임계 색 — 상태색(정상/지연/미수신)과는 별개 축(값 기반)이라 이름을 분리한다.
// normal=본문색 그대로(과채도 금지), caution=amber, warning=lost-red 재사용(예외우선 팔레트와 정합).
// 탈-네온 패스(2026-07-15): index.css --delay/--lost 톤다운과 동기화.
export const THRESHOLD_HEX: Record<ThresholdLevel, string> = {
  normal: '#E9EEF3',
  caution: '#E0A24A',
  warning: '#E15A5F',
}
