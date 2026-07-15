import React from 'react'
import ReactDOM from 'react-dom/client'
// 폰트 로컬 번들 — CDN 의존 제거(외부망 불안정한 시연 환경 대비)
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
// 데이터/수치 전용 mono — IBM Plex Mono(자체 호스팅, --font-mono 로 매핑). 라틴 서브셋만 필요한 굵기로 로드.
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/ibm-plex-mono/600.css'
import './index.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
