/**
 * KpiBar — 헤더 아래 전폭 KPI 밴드("운영센터" 시그니처 요소).
 * Wave 2: `/api/status`(SSOT) 를 그대로 소비 — 프론트에서 파생 지표를 재계산하지 않는다.
 * - 오해를 부르던 "평균 파고" 헤드라인 → **최대 파고 + 발생지점**(관측기록상 물리적으로 불가능한
 *   값은 백엔드가 이미 걸러낸 max_wave).
 * - **수신 이상 N건**(지연+미수신, 구 "활성 경보" — §12 전문가 패널: 기상특보 "경보"와 용어 충돌
 *   방지 위해 개명) 타일은 클릭 가능 — 좌패널/지도 필터를 "이상만"으로 좁힌다.
 * - 2026-07-15 사용자 확정: "관측 부이 N개소"(좌패널 상단 "총 N개소"와 중복)·"최근 갱신 N분 전"
 *   (헤더 신선도 배지와 중복) 타일 제거 — **수신 이상 / 정상 가동률 / 최대 파고** 3개만 유지.
 * - 결측은 항상 "—"(0 이나 지어낸 수치 금지) — benchmark 신뢰도 원칙.
 * - 타일은 한 줄 밴드로 컴팩트하게 유지하되, QHD(2560x1440) 100% 배율에서도 편히 읽히도록
 *   라벨/서브라인 ≥13px · 숫자 값은 크고 굵게(22px) 유지한다(가독성 우선). 3개 타일이 `flex:1`로
 *   바 전체 폭에 고르게 분산되어(§12) 우측에 빈 공간이 남지 않게 한다.
 * - "판정기준: 부이별 관측주기 이내 수신" 상시 문구는 제거하고 정상가동률 타일의 `title` 툴팁으로
 *   이동(§12) — 임계값이 고정 2h(§13-1)로 바뀌어 문구도 그에 맞게 갱신했다.
 */
import { useEffect, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { formatStationName } from '../utils/buoys'

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>()
  useEffect(() => { ref.current = value })
  return ref.current
}

function fmt1(v: number | null | undefined): string {
  return v == null || !isFinite(v) ? '—' : v.toFixed(1)
}

export default function KpiBar() {
  const { status, statusError, liveLoadedOnce, filterAlertsOnly } = useStore(
    useShallow(s => ({ status: s.status, statusError: s.statusError, liveLoadedOnce: s.liveLoadedOnce, filterAlertsOnly: s.filterAlertsOnly }))
  )

  const prevAlerts = usePrevious(status?.alerts)
  const prevMaxWave = usePrevious(status?.max_wave?.value)

  const loading = !liveLoadedOnce && !status
  const showError = statusError && !status

  const total = status?.count ?? null
  const okCount = status?.total['정상'] ?? 0
  const uptimePct = total ? Math.round((okCount / total) * 100) : null
  const uptimeColor = uptimePct == null ? 'var(--t-lo)'
    : uptimePct >= 90 ? 'var(--ok)' : uptimePct >= 70 ? 'var(--delay)' : 'var(--lost)'

  const alerts = status?.alerts ?? null
  const alertsColor = alerts == null ? 'var(--t-lo)' : alerts === 0 ? 'var(--ok)' : alerts <= 5 ? 'var(--delay)' : 'var(--lost)'
  const alertsDelta = prevAlerts != null && alerts != null ? alerts - prevAlerts : 0
  // 축5 — "수신 이상" > 0 이면 눈에 띄어야 한다: 은은한 앰버/적색 소프트틴트 배경 + 좌측 강조선.
  // 0 이면(계도적 침묵) 틴트 없이 차분하게 — 아래 KpiTile 의 accent(초록/앰버/적색)는 그대로 유지.
  const alertsTint = alerts == null || alerts === 0 ? undefined : alerts <= 5 ? 'var(--delay-soft)' : 'var(--lost-soft)'

  const maxWave = status?.max_wave ?? null
  const maxWaveDelta = prevMaxWave != null && maxWave != null ? maxWave.value - prevMaxWave : 0

  // 3타일만 남아 헐렁해 보이지 않도록(§12) 타일 자체가 flex:1 로 바 전체 폭에 고르게 분산된다
  // (KpiTile wide=true 케이스, 아래 참고) — 우측 빈 공간 제거.
  return (
    <div style={{
      display: 'flex', alignItems: 'stretch', flexShrink: 0,
      background: 'var(--bg-base)', borderBottom: '1px solid var(--line)',
      boxShadow: 'var(--edge-hi)', padding: '0 20px', overflowX: 'auto',
    }}>
      {loading ? (
        <div style={{ padding: '11px 0', fontSize: 13, color: 'var(--t-lo)', fontWeight: 500 }}>
          운영 현황 지표를 불러오는 중…
        </div>
      ) : showError ? (
        <div style={{ padding: '11px 0', fontSize: 13, color: 'var(--lost)', fontWeight: 500 }}>
          실시간 지표를 불러오지 못했습니다
        </div>
      ) : (
        <>
          <KpiTile label="수신 이상" value={alerts == null ? '—' : String(alerts)} unit="건" accent={alertsColor}
            delta={alertsDelta} clickable onClick={filterAlertsOnly} wide bgTint={alertsTint}
            title="지연·미수신 부이 수 — 클릭하면 이상 있는 부이만 필터링" />
          <KpiDivider />
          <KpiTile label="정상 가동률" value={uptimePct == null ? '—' : String(uptimePct)} unit="%" accent={uptimeColor}
            title="정상 판정기준: 최근 2시간 이내 수신" wide />
          <KpiDivider />
          <KpiTile label="최대 파고" value={maxWave ? fmt1(maxWave.value) : '—'} unit="m"
            sub={maxWave ? formatStationName(maxWave.station_name) : '관측값 없음'} delta={maxWaveDelta} wide />
        </>
      )}
    </div>
  )
}

function KpiDivider() {
  return <div style={{ width: 1, alignSelf: 'center', height: '42%', background: 'var(--line)', flexShrink: 0 }} />
}

function DeltaBadge({ delta, positiveIsBad = true }: { delta: number; positiveIsBad?: boolean }) {
  if (!delta || Math.abs(delta) < 0.05) return null
  const up = delta > 0
  const bad = positiveIsBad ? up : !up
  return (
    <span className="tnum" style={{
      fontSize: 13, fontWeight: 700, marginLeft: 5,
      color: bad ? 'var(--delay)' : 'var(--ok)',
    }}>
      {up ? '▲' : '▼'}{Math.abs(delta) < 1 ? Math.abs(delta).toFixed(1) : Math.round(Math.abs(delta))}
    </span>
  )
}

function KpiTile({ label, value, unit, sub, accent, delta, clickable, onClick, title, wide, bgTint }: {
  label: string; value: string; unit?: string; sub?: string; accent?: string
  delta?: number; clickable?: boolean; onClick?: () => void; title?: string; wide?: boolean; bgTint?: string
}) {
  const Comp = clickable ? 'button' : 'div'
  const restBg = bgTint ?? 'none'
  return (
    <Comp
      onClick={clickable ? onClick : undefined}
      title={title}
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3,
        // 축5 — 틴트가 있을 때(수신 이상 > 0) 좌측 강조선 3px 만큼 좌측 패딩을 줄여 시각적 폭을 맞춘다.
        padding: wide ? `10px 34px 10px ${bgTint ? 31 : 34}px` : '8px 16px', minWidth: wide ? 180 : 108, flexShrink: 0,
        // 3타일만 남은 뒤 우측이 헐렁해 보이지 않도록(§12) wide 타일은 flex:1 로 바 전체 폭을
        // 3등분해 균형 있게 채운다(우측 빈 공간 제거) — 상한 없이 바 폭에 맞춰 늘어난다.
        flex: wide ? '1 1 0' : '0 0 auto',
        background: restBg, border: 'none', borderTop: `2px solid ${accent ?? 'transparent'}`,
        borderLeft: bgTint ? `3px solid ${accent}` : 'none',
        cursor: clickable ? 'pointer' : 'default', textAlign: 'left', font: 'inherit',
        transition: 'background 0.12s',
      }}
      onMouseEnter={clickable ? (e => (e.currentTarget.style.background = 'var(--bg-hover)')) : undefined}
      onMouseLeave={clickable ? (e => (e.currentTarget.style.background = restBg)) : undefined}
    >
      <div className="eyebrow" style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4 }}>
        {label}
        {clickable && <span style={{ color: 'var(--accent-h)', fontWeight: 700 }}>›</span>}
      </div>
      <div className="tnum" style={{
        fontSize: wide ? 24 : 22, fontWeight: 700, lineHeight: 1.15, letterSpacing: '-0.01em',
        color: accent ?? 'var(--t-hi)', whiteSpace: 'nowrap',
        display: 'flex', alignItems: 'baseline',
      }}>
        {value}
        {unit && <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-lo)', marginLeft: 4 }}>{unit}</span>}
        {delta != null && <DeltaBadge delta={delta} />}
      </div>
      {sub && (
        <div style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600, whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>
          {sub}
        </div>
      )}
    </Comp>
  )
}
