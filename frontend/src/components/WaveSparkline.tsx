/**
 * WaveSparkline — 최근 24h 파고 미니 추이(경량 SVG polyline, Recharts 미사용으로 가볍게 유지).
 * MapViewGL 팝업과 LeftPanel "주의 필요"/하이라이트 행이 공유한다 — **전체 부이 리스트(137개소)에
 * 개별 fetch 를 붙이면 비용이 크므로**, 이 컴포넌트는 항상 소수(팝업 1개, 예외/하이라이트 행 소수)
 * 에만 마운트해서 쓴다는 전제다(리스트 전체 행의 추세는 store.prevWaveById 기반 화살표로 대체).
 * source/id 가 바뀔 때만 재요청(부모의 60초 폴링 리렌더로는 재요청되지 않음).
 */
import { useEffect, useState } from 'react'
import type { TimeseriesResponse } from '../types'

export default function WaveSparkline({ source, id, width = 226, height = 30 }: {
  source: 'KMA' | 'KHOA'; id: string; width?: number; height?: number
}) {
  const [values, setValues] = useState<number[] | null | 'error'>(null)

  useEffect(() => {
    let cancelled = false
    setValues(null)
    fetch(`/api/timeseries?source=${source}&id=${encodeURIComponent(id)}&range=24h`)
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
      .then((d: TimeseriesResponse) => {
        if (cancelled) return
        const vs = (d.points ?? []).map(p => p.wave).filter((v): v is number => v != null)
        setValues(vs.length >= 2 ? vs : 'error')
      })
      .catch(() => { if (!cancelled) setValues('error') })
    return () => { cancelled = true }
  }, [source, id])

  if (values === 'error') return null
  if (!values) {
    return <div style={{ height, display: 'flex', alignItems: 'center', fontSize: 13, color: 'var(--t-lo)' }}>추이 불러오는 중…</div>
  }
  const pad = 3
  const min = Math.min(...values), max = Math.max(...values)
  const range = max - min || 1
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  const pts = values.map((v, i) => [pad + i * stepX, pad + (1 - (v - min) / range) * (height - pad * 2)] as const)
  const path = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const last = pts[pts.length - 1]
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0]} cy={last[1]} r={2.4} fill="var(--accent-h)" />
    </svg>
  )
}
