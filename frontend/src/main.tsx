import React from 'react'
import ReactDOM from 'react-dom/client'
// 폰트 로컬 번들 — CDN 의존 제거(외부망 불안정한 시연 환경 대비). 전부 Pretendard 통일(모노 서체 제거).
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css'
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
