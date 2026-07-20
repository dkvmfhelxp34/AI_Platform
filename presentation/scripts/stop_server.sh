#!/usr/bin/env bash
# 발표 대시보드 정적 서버 중지 (Linux)
# 사용법: ./stop_server.sh [포트]   (기본 8787)
PORT="${1:-8787}"
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$BASE_DIR/logs/http_server_$PORT.pid"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  kill "$(cat "$PID_FILE")" && rm -f "$PID_FILE"
  echo "중지됨 (포트 $PORT)"
else
  echo "실행 중인 서버가 없습니다 (포트 $PORT)"
fi
