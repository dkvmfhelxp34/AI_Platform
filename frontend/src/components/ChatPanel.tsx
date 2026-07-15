// ChatPanel — Phase 5(claude -p 챗봇)에서 구현 예정. 지금은 레이아웃 자리표시 스텁.
export default function ChatPanel() {
  return (
    <aside style={{ width: 'clamp(300px, 20vw, 380px)', flexShrink: 0, background: 'var(--bg-base)',
      borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
        padding: '14px 16px', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--t-500)',
          textTransform: 'uppercase', letterSpacing: '0.06em' }}>AI 어시스턴트</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t-400)', background: 'var(--bg-subtle)',
          border: '1px solid var(--border)', borderRadius: 4, padding: '1px 6px' }}>준비 중</span>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 12, padding: 24, textAlign: 'center' }}>
        <div style={{ fontSize: 34, opacity: 0.7 }}>💬</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-700)' }}>
          부이 챗봇은 다음 단계에서 제공됩니다
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--t-400)', lineHeight: 1.6, maxWidth: 260 }}>
          "○○ 부이 지금 파고 얼마야?" 같은 질문에 실시간 조회 기반으로 답하는
          claude -p 챗봇이 Phase 5 에서 연결될 예정입니다.
        </div>
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '12px 14px', flexShrink: 0 }}>
        <input disabled placeholder="곧 제공됩니다…"
          style={{ width: '100%', padding: '9px 12px', border: '1px solid var(--border)',
            borderRadius: 8, background: 'var(--bg-subtle)', color: 'var(--t-400)',
            fontSize: 13.5, outline: 'none', fontFamily: 'inherit', cursor: 'not-allowed' }} />
      </div>
    </aside>
  )
}
