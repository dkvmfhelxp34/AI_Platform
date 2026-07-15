import { useEffect, useState } from 'react'
import { useStore } from './store'
import Header from './components/Header'
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
      <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* 접힘 = display:none (언마운트 아님) — 검색어 등 패널 로컬 상태 유지 */}
        <div style={{ display: leftOpen ? 'contents' : 'none' }}><LeftPanel /></div>
        <PanelToggle open={leftOpen} side="left" onClick={() => setLeftOpen(o => !o)} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <MapView />
          </div>
        </div>
        <PanelToggle open={rightOpen} side="right" onClick={() => setRightOpen(o => !o)} />
        {/* 상세 패널이 열려있는 동안은 챗봇 자리표시를 대체(우선순위) — 닫으면 챗봇으로 복귀 */}
        <div style={{ display: rightOpen ? 'contents' : 'none' }}>
          {detailOpenId ? <DetailDrawer /> : <ChatPanel />}
        </div>
      </div>
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
          width: 26, height: 54, padding: 0, cursor: 'pointer',
          background: 'transparent', border: 'none',
          display: 'flex', alignItems: 'center',
          justifyContent: side === 'left' ? 'flex-start' : 'flex-end',
        }}>
        <span className="panel-toggle-chip" style={{
          width: 16, height: 46,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--bg-panel)', color: 'var(--t-500)',
          border: '1px solid var(--border)',
          borderRadius: side === 'left' ? '0 7px 7px 0' : '7px 0 0 7px',
          boxShadow: 'var(--shadow-md)', transition: 'background 0.12s, color 0.12s',
          fontSize: 15, fontWeight: 700, lineHeight: 1,
        }}>{icon}</span>
      </button>
    </div>
  )
}
