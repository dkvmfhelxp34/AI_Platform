import { Component, ErrorInfo, ReactNode } from 'react'

interface State { hasError: boolean; error?: Error }

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', gap: 16,
          background: 'var(--bg-deep)', fontFamily: 'var(--font-ui)',
        }}>
          <div style={{ fontSize: 48 }}>⚠️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--t-900)' }}>
            렌더링 오류가 발생했습니다
          </div>
          <div style={{ fontSize: 13, color: 'var(--t-500)', maxWidth: 400, textAlign: 'center', lineHeight: 1.6 }}>
            {this.state.error?.message ?? '알 수 없는 오류'}
          </div>
          <button
            onClick={() => { this.setState({ hasError: false }); window.location.reload() }}
            style={{
              padding: '9px 24px', borderRadius: 9, background: 'var(--accent)',
              color: 'var(--bg-deep)', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 600,
            }}
          >
            페이지 새로고침
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
