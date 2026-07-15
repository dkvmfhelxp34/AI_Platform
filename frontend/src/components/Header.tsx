import { useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { mergeBuoys } from '../utils/buoys'
import { STATUS_HEX, type BuoyStatus } from '../types'
import dayjs from 'dayjs'

export default function Header() {
  const { live, liveLoadedOnce, liveError, stations } = useStore(
    useShallow(s => ({
      live: s.live, liveLoadedOnce: s.liveLoadedOnce, liveError: s.liveError, stations: s.stations,
    }))
  )

  const [now, setNow] = useState(() => dayjs())
  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 1000)
    return () => clearInterval(t)
  }, [])

  // 좌측패널/범례와 동일한 병합 집합(mergeBuoys) 기준으로 집계 — live 배열만으로 세면
  // stations 에는 있지만 live 폴링 대상이 아닌 지점(미수신)이 누락되어 수치가 어긋난다.
  const buoys = useMemo(() => mergeBuoys(stations, live), [stations, live])

  const counts = useMemo(() => {
    const c: Record<BuoyStatus, number> = { '정상': 0, '지연': 0, '미수신': 0 }
    for (const b of buoys) c[b.status]++
    return c
  }, [buoys])

  return (
    <header style={{
      background: 'var(--hdr-bg)',
      borderBottom: '1px solid var(--hdr-border)',
      height: 56,
      display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 20, flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Brand */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}>
        <div style={{
          width: 26, height: 26, borderRadius: 6, flexShrink: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--line)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
        }}>🛟</div>
        <div>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--t-hi)', lineHeight: 1.2, letterSpacing: '-0.01em' }}>
            Buoy Platform
          </div>
          <div className="eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.09em' }}>
            KMA · KHOA UNIFIED OCEAN BUOY MONITORING
          </div>
        </div>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--line)', flexShrink: 0 }} />

      {/* Status tally — 좌측패널/범례와 동일 소스(mergeBuoys) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexShrink: 0 }}>
        {!liveLoadedOnce ? (
          <span style={{ fontSize: 12.5, color: 'var(--t-lo)' }}>수신 현황 불러오는 중…</span>
        ) : liveError ? (
          <span style={{ fontSize: 12.5, color: 'var(--lost)' }}>실시간 데이터 로드 실패</span>
        ) : (
          <>
            <StatTally label="정상" color={STATUS_HEX['정상']} value={counts['정상']} />
            <StatTally label="지연" color={STATUS_HEX['지연']} value={counts['지연']} />
            <StatTally label="미수신" color={STATUS_HEX['미수신']} value={counts['미수신']} />
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--t-lo)' }}>
              / {buoys.length || stations.length}개소
            </span>
          </>
        )}
      </div>

      <div style={{ flex: 1 }} />

      {/* Clock */}
      <div className="mono" style={{
        flexShrink: 0, display: 'flex', alignItems: 'baseline', gap: 8,
      }}>
        <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--t-hi)' }}>
          {now.format('YYYY-MM-DD HH:mm:ss')}
        </span>
        <span className="eyebrow" style={{ fontSize: 9.5, letterSpacing: '0.08em' }}>LOCAL</span>
      </div>
    </header>
  )
}

function StatTally({ color, label, value }: { color: string; label: string; value: number }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-mid)' }}>{label}</span>
      <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-hi)' }}>{value}</span>
    </div>
  )
}
