import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import dayjs from 'dayjs'

// 헤더 배지가 소켓/폴링 성공 여부가 아니라 "실제 관측 데이터의 신선도"를 반영하도록 하는 임계값
// (SSOT — 헤더·KpiBar·좌패널이 전부 같은 data_freshness 계산치를 읽는다).
// KMA sea_obs 는 자체 발표지연이 ~15~30분이라, 파이프라인이 건강해도 "가장 최신 관측"이 상시 15~30분
// 나이로 잡힌다. 임계값을 이 발표지연보다 넉넉히 잡아 정상 운영이 "실시간"으로 읽히게 한다(과거 15/40분은
// 발표지연만으로 상시 "데이터 지연"이 떠 오해를 유발했다).
const FRESH_MAX_MIN = 40   // 이 안이면 "실시간"(초록) — KMA 발표지연(~15~30분) 흡수
const STALE_MAX_MIN = 90   // 이 안이면 "데이터 지연"(호박), 넘으면 "데이터 심각 지연"(적색) — 실제 수집 정체

export default function Header() {
  const { liveLoadedOnce, liveError, status, statusError } = useStore(
    useShallow(s => ({ liveLoadedOnce: s.liveLoadedOnce, liveError: s.liveError, status: s.status, statusError: s.statusError }))
  )

  const [now, setNow] = useState(() => dayjs())
  useEffect(() => {
    const t = setInterval(() => setNow(dayjs()), 1000)
    return () => clearInterval(t)
  }, [])

  const connected = liveLoadedOnce && !liveError
  const age = status?.data_freshness.newest_obs_age_min ?? null

  // 배지 상태: 연결 자체가 안 됐으면 그게 최우선 신호, 연결됐으면 "데이터 나이"로 재판정한다.
  type Tone = 'muted' | 'ok' | 'delay' | 'lost'
  let tone: Tone = 'muted'
  let label = '연결 중…'
  if (!liveLoadedOnce) {
    tone = 'muted'; label = '연결 중…'
  } else if (liveError) {
    tone = 'lost'; label = '연결 실패'
  } else if (statusError || age == null) {
    // 소켓/폴링은 살아있으나 신선도 판정 근거(SSOT)를 아직 못 받은 과도 상태 — 낙관적으로 연결됨만 표기
    tone = connected ? 'ok' : 'lost'
    label = connected ? '실시간' : '연결 실패'
  } else if (age <= FRESH_MAX_MIN) {
    tone = 'ok'; label = '실시간'
  } else if (age <= STALE_MAX_MIN) {
    tone = 'delay'; label = `데이터 지연 ${Math.round(age)}분`
  } else {
    tone = 'lost'; label = `데이터 심각 지연 ${Math.round(age)}분`
  }
  const TONE_COLOR: Record<Tone, string> = { muted: 'var(--t-lo)', ok: 'var(--ok)', delay: 'var(--delay)', lost: 'var(--lost)' }
  const TONE_SOFT: Record<Tone, string> = { muted: 'transparent', ok: 'var(--ok-soft)', delay: 'var(--delay-soft)', lost: 'var(--lost-soft)' }
  const dotColor = TONE_COLOR[tone]
  const pulse = tone === 'ok'

  return (
    <header style={{
      background: 'var(--hdr-bg)',
      borderBottom: '1px solid var(--hdr-border)',
      height: 60,
      display: 'flex', alignItems: 'center',
      padding: '0 20px', gap: 20, flexShrink: 0,
      userSelect: 'none',
    }}>
      {/* Brand — 이모지 대신 시그니처 시안 마크(부이 + 발신 신호 실루엣) */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, flexShrink: 0 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8, flexShrink: 0,
          background: 'var(--bg-elev)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <BrandMark />
        </div>
        <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--t-hi)', lineHeight: 1.2, letterSpacing: '-0.01em' }}>
          부이 모니터링 플랫폼
        </div>
      </div>

      <div style={{ width: 1, height: 26, background: 'var(--line)', flexShrink: 0 }} />

      {/* 실데이터 신선도 배지 — 소켓 상태가 아니라 data_freshness(SSOT) 기반. 헤더·KpiBar·좌패널이
          전부 같은 계산치를 읽으므로 "실시간인데 40분 전" 같은 모순이 구조적으로 나지 않는다. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}
        title={age != null ? `최신 관측 ${age.toFixed(1)}분 전` : undefined}>
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: dotColor,
          boxShadow: `0 0 0 3px ${TONE_SOFT[tone]}`,
        }} className={pulse ? 'buoy-marker-pulse' : undefined} />
        <span className="tnum" style={{ fontSize: 13, fontWeight: 700, color: pulse ? 'var(--t-mid)' : dotColor }}>
          {label}
        </span>
      </div>

      <div style={{ flex: 1 }} />

      {/* Clock — 이 플랫폼은 국내 해역 전용이라 로컬시각=KST가 자명해 태그를 생략한다 */}
      <div className="tnum" style={{ flexShrink: 0 }}>
        <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--t-hi)' }}>
          {now.format('YYYY-MM-DD HH:mm:ss')}
        </span>
      </div>
    </header>
  )
}

/** 브랜드 마크 — 부이(원형 부표) + 발신되는 신호 파형(액센트 시안, 얇은 스트로크). 이모지 미사용. */
function BrandMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 28 28" fill="none" aria-hidden="true">
      {/* 부표 동체 + 수면선 */}
      <circle cx="9" cy="20" r="4.1" fill="rgba(78,154,201,0.18)" stroke="var(--accent)" strokeWidth="1.7" />
      <line x1="2.5" y1="24.6" x2="15.5" y2="24.6" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" opacity="0.4" />
      {/* 안테나 마스트 */}
      <line x1="9" y1="16.2" x2="9" y2="8.2" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="9" cy="7" r="1.3" fill="var(--accent)" />
      {/* 발신 신호(파형) — 우상단으로 두 겹 */}
      <path d="M13 9.2 Q16 7 13 4.8" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" fill="none" />
      <path d="M16.3 11.6 Q21.3 7 16.3 2.4" stroke="var(--accent)" strokeWidth="1.6" strokeLinecap="round" fill="none" opacity="0.5" />
    </svg>
  )
}
