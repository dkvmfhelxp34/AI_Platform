import { useEffect, useState } from 'react'
import { useStore } from './store'
import Header from './components/Header'
import KpiBar from './components/KpiBar'
import LeftPanel from './components/LeftPanel'
import MapView from './components/MapViewGL'
import ChatPanel from './components/ChatPanel'
import DetailDrawer from './components/DetailDrawer'

export default function App() {
  useEffect(() => {
    const stop = useStore.getState().startPolling()
    return stop
  }, [])

  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  const detailOpenId = useStore(s => s.detailOpenId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <Header />
      <KpiBar />
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* 접힘 = display:none (언마운트 아님) — 검색어 등 패널 로컬 상태 유지 */}
        <div style={{ display: leftOpen ? 'contents' : 'none' }}><LeftPanel /></div>
        <PanelToggle open={leftOpen} side="left" onClick={() => setLeftOpen(o => !o)} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MapView />
          </div>
        </div>
        {/* 우측 도크는 이제 상세 패널 전용 — AI 챗봇은 플로팅 위젯(ChatPanel, FAB+팝업)으로 분리되어
            지도 폭을 상시 차지하지 않는다(상세 미선택 시 지도가 우측 끝까지 확장). */}
        {detailOpenId && (
          <>
            <PanelToggle open={rightOpen} side="right" onClick={() => setRightOpen(o => !o)} />
            <div style={{ display: rightOpen ? 'contents' : 'none' }}>
              <DetailDrawer />
            </div>
          </>
        )}
      </div>
      {/* 플로팅 챗봇 위젯 — 레이아웃과 무관하게 항상 마운트(fixed 오버레이, App.tsx 폭 계산에 영향 없음) */}
      <ChatPanel />
    </div>
  )
}

function PanelToggle({ open, side, onClick }: { open: boolean; side: 'left' | 'right'; onClick: () => void }) {
  const icon = side === 'left' ? (open ? '‹' : '›') : (open ? '›' : '‹')
  return (
    <div style={{ width: 0, flexShrink: 0, position: 'relative', zIndex: 10 }}>
      <button onClick={onClick} className="panel-toggle"
        title={open ? '패널 접기' : '패널 펼치기'} aria-label={open ? '패널 접기' : '패널 펼치기'}
        style={{
          position: 'absolute', top: '50%', transform: 'translateY(-50%)',
          [side === 'left' ? 'left' : 'right']: 0,
          width: 28, height: 58, padding: 0, cursor: 'pointer',
          background: 'transparent', border: 'none',
          display: 'flex', alignItems: 'center',
          justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
        }}>
        <span className="panel-toggle-chip" style={{
          width: 17, height: 48,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-elev)', color: 'var(--t-mid)',
          border: '1px solid var(--line)',
          borderRadius: side === 'left' ? '0 8px 8px 0' : '8px 0 0 8px',
          boxShadow: 'var(--shadow-md)', transition: 'background 0.12s, color 0.12s',
          fontSize: 16, fontWeight: 700, lineHeight: 1,
        }}>{icon}</span>
      </button>
    </div>
  )
}
