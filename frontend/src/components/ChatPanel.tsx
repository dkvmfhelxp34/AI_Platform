// ChatPanel — Phase 5: `claude -p` 기반 데이터 그라운디드 AI 챗봇.
// **플로팅 위젯**(FAB 런처 + 팝업)으로 제공한다 — 상시 우측 도크를 차지하지 않아 지도 폭을 그대로
// 유지한다(우측 도크는 DetailDrawer 전용으로 남는다, App.tsx 참고). 백엔드 `/api/chat`(SSE) 와
// 통신하며, 데이터 조회 결과만 근거로 답한다(백엔드 chat.py 시스템 프롬프트가 환각을 차단).
// §25-c(2026-07-16) 대화 기억(7일 보존): 세션 id 를 localStorage 에 고정해 새로고침에도 같은
// 세션을 이어 쓰고(과거엔 새로고침마다 새 id), 마운트 시 `/api/chat/history` 로 이전 대화를
// 복원해 화면에 먼저 그린다(백엔드에 아직 이 엔드포인트가 없거나 실패해도 조용히 빈 상태로
// 시작 — 콘솔 에러 없이 진행). 헤더의 "새 대화" 버튼은 세션 id 자체를 새로 발급해 이전 대화와
// 완전히 분리된 새 스레드를 시작한다.
import { useState, useRef, useEffect, useCallback, memo, type RefObject } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { useStore } from '../store'
import type { ChatMessage } from '../types'

const CHAT_SESSION_KEY = 'buoy-chat-session-id'

function genSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `s${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function loadOrCreateSessionId(): string {
  try {
    const existing = localStorage.getItem(CHAT_SESSION_KEY)
    if (existing) return existing
    const fresh = genSessionId()
    localStorage.setItem(CHAT_SESSION_KEY, fresh)
    return fresh
  } catch {
    // localStorage 접근 불가(사생활 모드 등) — 세션 고정은 못 하지만 페이지 내에서는 계속 동작.
    return genSessionId()
  }
}

// 세션 id — localStorage 에 고정되어 새로고침 후에도 같은 세션(따라서 같은 대화)을 이어간다.
// "새 대화" 클릭 시에만 새로 발급(startNewChat).
let chatSessionId: string = loadOrCreateSessionId()

const EXAMPLE_PROMPTS = [
  '덕적도 지금 파고 얼마야?',
  '지금 수신 지연인 부이 알려줘',
  '최대 파고 지점은?',
]

// 도구 실행 중 상태줄("🔧 …")과 실제 답변 텍스트를 구분(둘 다 loading=true 로 오므로 접두사로 판별).
const isStatusLine = (t: string) => t.startsWith('🔧')

export default function ChatPanel() {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  const stations = useStore(s => s.stations)
  const requestFlyTo = useStore(s => s.requestFlyTo)

  // 열려 있는 동안 새 메시지가 오면 바닥으로 스크롤
  useEffect(() => {
    if (!open) return
    endRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  // 팝업이 열리면 입력창 포커스
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => inputRef.current?.focus(), 60)
    return () => clearTimeout(t)
  }, [open])

  // Esc 로 닫기
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  // 마운트 시 1회 — 이전 대화 복원(§25-c). 백엔드가 아직 `/api/chat/history` 를 모르거나(404),
  // 네트워크 오류거나, 세션이 비어 있으면 전부 조용히 무시하고 빈 상태로 시작한다(콘솔에러 없음
  // — 구 백엔드 프로세스 대상 검증에서도 이 경로가 조용해야 한다).
  useEffect(() => {
    let cancelled = false
    fetch(`/api/chat/history?session_id=${encodeURIComponent(chatSessionId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (cancelled || !data) return
        const raw = Array.isArray(data.messages) ? data.messages : []
        if (raw.length === 0) return
        const restored: ChatMessage[] = raw
          .filter((m: any) => m && typeof m.content === 'string' && m.content
            && (m.role === 'user' || m.role === 'assistant'))
          .map((m: any, i: number) => ({ id: `h${i}-${m.role}`, role: m.role, content: m.content }))
        if (restored.length === 0) return
        // 그 사이 사용자가 이미 새 메시지를 보냈다면(드문 경쟁) 복원으로 덮어쓰지 않는다.
        setMessages(prev => (prev.length > 0 ? prev : restored))
      })
      .catch(() => { /* 조용히 무시 — 새 대화로 시작 */ })
    return () => { cancelled = true }
  }, [])

  const sendMessage = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || loading) return
    setInput('')
    if (inputRef.current) inputRef.current.style.height = 'auto'

    const uId = `u${Date.now()}`
    const aId = `a${Date.now() + 1}`
    setMessages(m => [...m,
      { id: uId, role: 'user', content: trimmed },
      { id: aId, role: 'assistant', content: '', loading: true },
    ])
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, session_id: chatSessionId }),
      })
      if (!res.ok || !res.body) {
        const msg = res.status >= 500
          ? '서버가 일시적으로 응답하지 못했습니다. 잠시 후 다시 시도해 주세요.'
          : '응답 생성에 실패했습니다. 잠시 후 다시 시도해 주세요.'
        setMessages(m => m.map(x => x.id === aId ? { ...x, content: msg, loading: false } : x))
        return
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let full = ''
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n')
        buf = parts.pop() ?? ''

        for (const line of parts) {
          if (!line.startsWith('data: ')) continue
          let p: any
          try { p = JSON.parse(line.slice(6)) } catch { continue }

          if (p.type === 'tool_start') {
            setMessages(m => m.map(x => x.id === aId ? { ...x, content: `🔧 ${p.msg}` } : x))
          } else if (p.done) {
            if (p.session_id) chatSessionId = p.session_id
            // ui_actions: select_buoy → 지도에서 그 부이로 flyTo(값이 id 든 이름이든 허용)
            for (const a of (p.ui_actions ?? [])) {
              if (a?.type === 'select_buoy' && a.value) {
                const byId = stations.find(s => s.id === a.value)
                const byName = byId ? null : stations.find(s => s.name === a.value)
                const resolvedId = byId?.id ?? byName?.id
                if (resolvedId) requestFlyTo(resolvedId)
              }
            }
            setMessages(m => m.map(x => x.id === aId
              ? { ...x, content: full || '응답을 생성하지 못했습니다. 다시 시도해 주세요.', loading: false }
              : x))
          } else if (p.text !== undefined) {
            full += p.text
            setMessages(m => m.map(x => x.id === aId ? { ...x, content: full } : x))
          }
        }
      }
    } catch {
      setMessages(m => m.map(x => x.id === aId
        ? { ...x, content: '응답 생성 중 오류가 발생했습니다. 다시 시도해 주세요.', loading: false }
        : x))
    } finally {
      setLoading(false)
      setMessages(m => m.map(x => x.loading ? { ...x, loading: false } : x))
    }
  }, [loading, stations, requestFlyTo])

  const hasMessages = messages.length > 0

  // "새 대화" — 세션 id 자체를 새로 발급해 localStorage 에 기록하고, 이전 대화(과거 세션 id 로
  // 남아 있는 jsonl 이력)와 완전히 분리된 새 스레드를 시작한다(§25-c).
  const startNewChat = () => {
    if (loading) return
    const fresh = genSessionId()
    chatSessionId = fresh
    try { localStorage.setItem(CHAT_SESSION_KEY, fresh) } catch { /* 사생활 모드 등 — 무시 */ }
    setMessages([])
  }

  return (
    <>
      {/* ── FAB 런처 — 우하단 고정(범례와 겹치지 않는 위치, 세부 배치는 추후 조정). §25: uiz 로
          QHD/UHD 에서 확대(fixed 오버레이라 지도 캔버스 스케일과 무관) ── */}
      <button
        className="uiz"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? 'AI 어시스턴트 닫기' : 'AI 어시스턴트 열기'}
        aria-expanded={open}
        title={open ? '닫기' : 'AI 어시스턴트'}
        style={{
          // F3 — 지도 부이 팝업(.buoy-ml-popup, index.css)이 z-index:1000 이라 챗 FAB/패널이 그
          // 아래(999/1000)에 있으면 열린 팝업에 챗 위젯이 가려진다. 챗은 항상 최상단 플로팅
          // 위젯이어야 하므로 팝업보다 위(1101/1100)로 올린다.
          position: 'fixed', right: 22, bottom: 22, zIndex: 1101,
          width: 54, height: 54, borderRadius: '50%', cursor: 'pointer',
          // §20 — FAB 는 float 엘리베이션(닫힘=중립 float 표면, 열림=primary accent — 핵심 인터랙션
          // 소량 사용은 유지). 상단 하이라이트로 표고를 보강.
          background: open ? 'var(--bg-float)' : 'var(--accent)',
          border: open ? '1px solid var(--line)' : '1px solid var(--accent-h)',
          color: open ? 'var(--t-mid)' : 'var(--bg-deep)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: 'var(--shadow-xl), var(--edge-hi)',
          transition: 'transform 0.15s ease, background 0.15s ease',
        }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.06)' }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
      >
        {open ? <CloseIcon /> : <ChatIcon />}
      </button>

      {/* ── 팝업 챗 창 — §25: uiz(fixed 오버레이이므로 지도 캔버스와 무관하게 확대 가능) ── */}
      {open && (
        <div
          className="uiz"
          role="dialog"
          aria-label="AI 어시스턴트"
          style={{
            // F3 — 지도 팝업(z-index:1000)보다 위(1100)로 — 챗 답변이 팝업에 가려지지 않게.
            position: 'fixed', right: 22, bottom: 86, zIndex: 1100,
            width: 'clamp(320px, 26vw, 400px)', height: 'clamp(440px, 64vh, 610px)',
            // §20 — 플로팅 위젯이므로 팝업·FAB 와 동일한 최고 엘리베이션(--bg-float) + 상단 하이라이트.
            background: 'var(--bg-float)', border: '1px solid var(--line)', borderRadius: 14,
            boxShadow: 'var(--shadow-xl), var(--edge-hi-strong)',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            animation: 'chat-pop-in 0.18s var(--ease-out) both',
          }}
        >
          {/* header */}
          <div style={{
            background: 'var(--bg-elev)', borderBottom: '1px solid var(--line)',
            padding: '13px 15px', flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span className="chat-live-dot" style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />
            <span style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t-hi)' }}>AI 어시스턴트</span>
            {/* §25-c — 항상 노출(현재 대화 유무와 무관): 이전 대화와 분리된 새 세션을 즉시 시작. */}
            <button
              onClick={startNewChat}
              disabled={loading}
              title={loading ? '응답 생성 중에는 새 대화를 시작할 수 없습니다' : '새 대화 시작 — 이전 대화 기록과 분리됩니다'}
              style={{
                marginLeft: 'auto', fontSize: 12, color: 'var(--t-lo)', fontFamily: 'inherit',
                background: 'none', border: 'none', padding: '3px 4px',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.5 : 1, transition: 'color 0.12s',
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.color = 'var(--t-hi)' }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--t-lo)' }}
            >새 대화</button>
          </div>

          {/* messages */}
          <div ref={listRef} style={{
            flex: 1, overflowY: 'auto',
            padding: hasMessages ? '14px 12px 6px' : '18px 14px',
            display: 'flex', flexDirection: 'column', gap: 10,
          }}>
            {!hasMessages && <EmptyState onSelect={sendMessage} />}
            {messages.map(m => <MessageBubble key={m.id} msg={m} />)}
            <div ref={endRef} style={{ height: 1 }} />
          </div>

          {/* input */}
          <InputBar
            value={input}
            onChange={setInput}
            onSend={() => sendMessage(input)}
            loading={loading}
            inputRef={inputRef}
          />
        </div>
      )}
    </>
  )
}

/* ── 빈 상태(예시 프롬프트 칩) ── */
function EmptyState({ onSelect }: { onSelect: (msg: string) => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '12px 2px 4px' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 30, marginBottom: 8, opacity: 0.85 }}>💬</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t-hi)', marginBottom: 4 }}>
          AI 어시스턴트
        </div>
        <div style={{ fontSize: 13, color: 'var(--t-lo)', lineHeight: 1.6, maxWidth: 280, margin: '0 auto' }}>
          실시간 부이 관측값·수신상태·통계를 조회해 답합니다. 예보는 모의/시연용입니다.
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{
          fontSize: 13, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
          color: 'var(--t-lo)', marginBottom: 2,
        }}>빠른 질문</div>
        {EXAMPLE_PROMPTS.map(p => (
          <button
            key={p}
            onClick={() => onSelect(p)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              textAlign: 'left', padding: '9px 12px', borderRadius: 9,
              border: '1px solid var(--accent-dim)', background: 'var(--bg-elev)',
              color: 'var(--t-mid)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
              transition: 'border-color 0.12s, background 0.12s',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'var(--accent-50)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)'; e.currentTarget.style.background = 'var(--bg-elev)' }}
          >
            <span>{p}</span>
            <span style={{ marginLeft: 'auto', color: 'var(--accent-h)', fontSize: 13 }}>▸</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* ── 메시지 버블 ── */
const MessageBubble = memo(function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === 'user'
  const isStatus = !!msg.loading && isStatusLine(msg.content)
  const isThinking = !!msg.loading && !isStatus && !msg.content

  return (
    <div style={{
      display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row',
      alignItems: 'flex-end', gap: 7,
    }}>
      <div style={{
        maxWidth: '86%',
        padding: (isStatus || isThinking) ? '8px 12px' : '9px 13px',
        borderRadius: isUser ? '12px 3px 12px 12px' : '3px 12px 12px 12px',
        // §20 — 유저 버블은 액센트를 "선택/핵심 인터랙션"으로 소량만 쓴다: 큰 면적 고채도 단색 채움
        // 대신 soft-tint(--accent-100) 배경 + 절제된 보더로 전환(다국행 메시지가 커도 채도 과다 방지).
        background: isUser ? 'var(--accent-100)' : 'var(--bg-elev)',
        color: isUser ? 'var(--t-hi)' : 'var(--t-mid)',
        border: isUser ? '1px solid var(--accent-dim)' : '1px solid var(--line)',
        boxShadow: 'var(--shadow-sm), var(--edge-hi)',
        fontSize: 13.5, lineHeight: 1.65, wordBreak: 'break-word',
      }}>
        {isUser ? (
          <span style={{ fontWeight: 450, whiteSpace: 'pre-wrap' }}>{msg.content}</span>
        ) : isStatus ? (
          <StatusLine content={msg.content} />
        ) : isThinking ? (
          <TypingDots />
        ) : msg.content ? (
          <div className="chat-md">
            <ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkBreaks]}>
              {msg.content}
            </ReactMarkdown>
          </div>
        ) : null}
      </div>
    </div>
  )
})

/* ── 도구 실행 상태줄 ── */
function StatusLine({ content }: { content: string }) {
  const text = content.replace(/^🔧\s*/u, '')
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
        background: 'var(--accent)', animation: 'chat-blink 1.4s ease-in-out infinite',
      }} />
      <span style={{ fontSize: 13, color: 'var(--t-lo)' }}>{text}</span>
    </div>
  )
}

/* ── 타이핑(대기) 애니메이션 — 점 3개 바운스 ── */
function TypingDots() {
  return (
    <span style={{ display: 'flex', gap: 4, padding: '3px 2px' }} aria-label="응답 생성 중">
      {[0, 0.15, 0.3].map((d, i) => (
        <span key={i} style={{
          width: 6, height: 6, borderRadius: '50%', display: 'inline-block',
          background: 'var(--accent)',
          animation: `chat-bounce 1.1s ${d}s ease-in-out infinite`,
        }} />
      ))}
    </span>
  )
}

/* ── 입력창 ── */
function InputBar({
  value, onChange, onSend, loading, inputRef,
}: {
  value: string
  onChange: (v: string) => void
  onSend: () => void
  loading: boolean
  inputRef: RefObject<HTMLTextAreaElement>
}) {
  const disabled = loading || !value.trim()
  return (
    <div style={{
      padding: '10px 12px 12px', borderTop: '1px solid var(--line)',
      background: 'var(--bg-panel)', flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', gap: 7, alignItems: 'flex-end',
        background: 'var(--bg-elev)', border: '1px solid var(--line)',
        borderRadius: 11, padding: '5px 5px 5px 12px',
        transition: 'border-color 0.12s, box-shadow 0.12s',
      }}
        onFocusCapture={e => { e.currentTarget.style.borderColor = 'var(--accent-dim)' }}
        onBlurCapture={e => { e.currentTarget.style.borderColor = 'var(--line)' }}
      >
        <textarea
          ref={inputRef}
          value={value}
          onChange={e => {
            onChange(e.target.value)
            const el = e.currentTarget
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 88)}px`
          }}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
          }}
          placeholder="부이에 대해 물어보세요…"
          rows={1}
          aria-label="AI 어시스턴트에게 질문"
          style={{
            flex: 1, background: 'transparent', border: 'none',
            padding: '5px 0', color: 'var(--t-hi)',
            fontSize: 13.5, resize: 'none', fontFamily: 'inherit',
            outline: 'none', lineHeight: 1.5, maxHeight: 88, overflowY: 'auto',
          }}
        />
        <button
          onClick={onSend}
          disabled={disabled}
          aria-label="전송"
          style={{
            width: 32, height: 32, borderRadius: 9, border: 'none', flexShrink: 0,
            background: disabled ? 'var(--line)' : 'var(--accent)',
            color: disabled ? 'var(--t-lo)' : 'var(--bg-deep)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background 0.12s',
          }}
          onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = 'var(--accent-h)' }}
          onMouseLeave={e => { if (!disabled) e.currentTarget.style.background = 'var(--accent)' }}
        >
          {loading ? (
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" aria-hidden
              style={{ animation: 'spin 0.9s linear infinite' }}>
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.4" opacity="0.25" />
              <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          ) : <SendIcon />}
        </button>
      </div>
    </div>
  )
}

/* ── 아이콘 ── */
function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width={23} height={23} fill="currentColor" aria-hidden>
      <path d="M12 3.5c-5 0-9 3.36-9 7.5 0 2.4 1.32 4.55 3.42 5.94.16.7-.24 1.83-1.12 3.15 1.62-.2 3.05-.77 3.98-1.4.86.2 1.76.31 2.72.31 5 0 9-3.36 9-7.5s-4-7.5-9-7.5Z" />
    </svg>
  )
}
function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" width={20} height={20} fill="none" aria-hidden>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  )
}
function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} fill="none" aria-hidden>
      <path d="M12 19V6M6.5 11.5 12 6l5.5 5.5" stroke="currentColor" strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
