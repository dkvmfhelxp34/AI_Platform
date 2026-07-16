/**
 * KpiBar — §25(2026-07-16) 헤더 임베드 KPI 클러스터(KpiCluster)로 재설계.
 * 예전엔 헤더 아래 전폭 밴드(3타일 flex:1 스트레치)였다 — "수신 이상" 타일이 거대한 빈 슬랩처럼
 * 늘어지고, 헤더+KPI 2단 구성 자체가 산만하다는 피드백으로 폐기. 이제 Header.tsx 안에 우측 정렬된
 * 컨텐츠폭 4스탯 클러스터로 병합해 "커맨드바 한 줄"을 만든다(App.tsx 는 더 이상 이 컴포넌트를
 * 전폭으로 렌더하지 않는다).
 * - `/api/status`(SSOT) 그대로 소비 — 프론트에서 파생 지표를 재계산하지 않는다. 예외: **최대 풍속**
 *   은 `/api/status` 에 없는 파생값이라 구 좌패널 하이라이트 칩이 쓰던 것과 동일한 liveBuoys 기반
 *   클라이언트 계산을 그대로 이식(§25 — 좌패널에서 이전).
 * - 4스탯: 수신 이상(클릭형 필터, 0건이 아니면 소프트 필 배경) · 정상 가동률 · 최대 파고 · 최대 풍속.
 * - 결측은 항상 "—"(0 이나 지어낸 수치 금지) — benchmark 신뢰도 원칙.
 * - 로딩/에러는 클러스터 전체를 문구 한 줄로 대체(개별 스탯 스켈레톤 없음 — 헤더 한 줄 높이 유지).
 */
import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ANOMALY_STATUSES, useStore } from '../store'
import { formatStationName, liveBuoys } from '../utils/buoys'

function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T>()
  useEffect(() => { ref.current = value })
  return ref.current
}

function fmt1(v: number | null | undefined): string {
  return v == null || !isFinite(v) ? '—' : v.toFixed(1)
}

export default function KpiCluster() {
  const { status, statusError, liveLoadedOnce, filterAlertsOnly, stations, live } = useStore(
    useShallow(s => ({
      status: s.status, statusError: s.statusError, liveLoadedOnce: s.liveLoadedOnce,
      filterAlertsOnly: s.filterAlertsOnly, stations: s.stations, live: s.live,
    }))
  )
  const requestFlyTo = useStore(s => s.requestFlyTo)
  // "수신 이상" 필터가 현재 적용 중인지 — store.filterAlertsOnly() 의 토글 판정과 동일한 식.
  const alertsFilterActive = useStore(s => s.visibleStatuses.size === ANOMALY_STATUSES.length
    && ANOMALY_STATUSES.every(st => s.visibleStatuses.has(st)))

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
  // 축5 — "수신 이상" > 0 이면 눈에 띄어야 한다: 은은한 앰버/적색 소프트틴트 필 배경. 0 이면(계도적
  // 침묵) 틴트 없이 차분하게.
  const alertsTint = alerts == null || alerts === 0 ? undefined : alerts <= 5 ? 'var(--delay-soft)' : 'var(--lost-soft)'

  const maxWave = status?.max_wave ?? null
  const maxWaveDelta = prevMaxWave != null && maxWave != null ? maxWave.value - prevMaxWave : 0

  // §25 — 최대 풍속: liveBuoys() 는 이미 무데이터 지점을 제외한 데이터셋(구 LeftPanel 로직과 동일).
  const buoys = useMemo(() => liveBuoys(stations, live), [stations, live])
  const maxWind = useMemo(() => {
    let best: { name: string; value: number; id: string } | null = null
    for (const b of buoys) {
      const w = b.values.wind_speed
      if (w == null || !isFinite(w) || w < 0 || w > 60) continue
      if (!best || w > best.value) best = { name: b.name, value: w, id: b.id }
    }
    return best
  }, [buoys])

  if (loading) {
    return <div style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 500, whiteSpace: 'nowrap' }}>지표 로딩 중…</div>
  }
  if (showError) {
    return <div style={{ fontSize: 13, color: 'var(--lost)', fontWeight: 500, whiteSpace: 'nowrap' }}>실시간 지표 오류</div>
  }

  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 14, flexShrink: 0 }}>
      <AlertStat alerts={alerts} color={alertsColor} delta={alertsDelta} tint={alertsTint}
        active={alertsFilterActive} onClick={filterAlertsOnly} />
      <Divider />
      <StatTile label="정상 가동률" value={uptimePct == null ? '—' : String(uptimePct)} unit="%" color={uptimeColor}
        title="정상 판정기준: 최근 2시간 이내 수신" />
      <Divider />
      <StatTile label="최대 파고" value={maxWave ? fmt1(maxWave.value) : '—'} unit="m"
        sub={maxWave ? formatStationName(maxWave.station_name) : '관측값 없음'} delta={maxWaveDelta} />
      <Divider />
      <StatTile label="최대 풍속" value={maxWind ? maxWind.value.toFixed(1) : '—'} unit="m/s"
        sub={maxWind ? formatStationName(maxWind.name) : '관측값 없음'}
        onClick={maxWind ? () => requestFlyTo(maxWind.id) : undefined} />
    </div>
  )
}

function Divider() {
  return <div style={{ width: 1, height: '55%', alignSelf: 'center', background: 'var(--line)', flexShrink: 0 }} />
}

function DeltaBadge({ delta, positiveIsBad = true }: { delta: number; positiveIsBad?: boolean }) {
  if (!delta || Math.abs(delta) < 0.05) return null
  const up = delta > 0
  const bad = positiveIsBad ? up : !up
  return (
    <span className="tnum" style={{ fontSize: 12, fontWeight: 700, marginLeft: 4, color: bad ? 'var(--delay)' : 'var(--ok)' }}>
      {up ? '▲' : '▼'}{Math.abs(delta) < 1 ? Math.abs(delta).toFixed(1) : Math.round(Math.abs(delta))}
    </span>
  )
}

/** 수신 이상 — 클릭 가능한 필터 스탯. 0건이 아니면 소프트 필 배경으로 눈에 띄게(계도적 침묵 해제),
 *  단 KpiTile 처럼 flex:1 로 늘어나지 않고 컨텐츠폭 그대로 우측 클러스터에 자리한다.
 *  active(필터 적용 중)면 accent 테두리로 토글 상태를 표시 — 다시 클릭하면 해제된다. */
function AlertStat({ alerts, color, delta, tint, active, onClick }: {
  alerts: number | null; color: string; delta: number; tint?: string; active: boolean; onClick: () => void
}) {
  const restBg = tint ?? 'transparent'
  return (
    <button onClick={onClick} aria-pressed={active}
      title="지연·미수신 부이만 필터링 — 다시 클릭하면 해제" style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
      background: restBg, border: active ? '1px solid var(--accent)' : '1px solid transparent', borderRadius: 8,
      padding: tint ? '4px 12px' : '4px 8px', cursor: 'pointer', font: 'inherit', textAlign: 'left',
      transition: 'background 0.12s, border-color 0.12s',
    }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
      onMouseLeave={e => { e.currentTarget.style.background = restBg }}>
      <span className="eyebrow" style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 4, lineHeight: 1 }}>
        수신 이상
        <span style={{ color: 'var(--accent-h)', fontWeight: 700 }}>›</span>
      </span>
      <span className="tnum" style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.1,
        color, display: 'flex', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
        {alerts == null ? '—' : alerts}
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-lo)', marginLeft: 4 }}>건</span>
        <DeltaBadge delta={delta} />
      </span>
    </button>
  )
}

/** 정상 가동률·최대 파고·최대 풍속 공용 스탯 타일 — sub(지점명)·delta·onClick(클릭형)은 전부 선택. */
function StatTile({ label, value, unit, sub, color, delta, title, onClick }: {
  label: string; value: string; unit?: string; sub?: string; color?: string; delta?: number
  title?: string; onClick?: () => void
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp onClick={onClick} title={title} style={{
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 1,
      background: 'none', border: 'none', padding: '4px 8px', borderRadius: 8,
      cursor: onClick ? 'pointer' : 'default', font: 'inherit', textAlign: 'left',
      transition: 'background 0.12s',
    }}
      onMouseEnter={onClick ? (e => { e.currentTarget.style.background = 'var(--bg-hover)' }) : undefined}
      onMouseLeave={onClick ? (e => { e.currentTarget.style.background = 'none' }) : undefined}>
      <span className="eyebrow" style={{ whiteSpace: 'nowrap', lineHeight: 1 }}>{label}</span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, whiteSpace: 'nowrap' }}>
        <span className="tnum" style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em', lineHeight: 1.1,
          color: color ?? 'var(--t-hi)', display: 'flex', alignItems: 'baseline' }}>
          {value}
          {unit && <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--t-lo)', marginLeft: 4 }}>{unit}</span>}
          {delta != null && <DeltaBadge delta={delta} />}
        </span>
        {sub && (
          // §26 — whiteSpace:nowrap 없이는 overflow:hidden+textOverflow:ellipsis 가 아무 효과가
          // 없다(줄바꿈이 먼저 일어나 2줄로 꺾인다) — 긴 지점명(예: "경포대해수욕장")이 최대 파고/풍속
          // 값을 아래로 밀어내는 걸 막는다.
          <span style={{ fontSize: 13, color: 'var(--t-lo)', fontWeight: 600, maxWidth: 150,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sub}
          </span>
        )}
      </span>
    </Comp>
  )
}
