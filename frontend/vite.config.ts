import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      // 백엔드(FastAPI/uvicorn)는 8506 고정 (PLAN.md 확정)
      '/api': { target: 'http://localhost:8506', changeOrigin: true },
    },
  },
})
