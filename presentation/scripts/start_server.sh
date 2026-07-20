#!/usr/bin/env bash
# 발표 대시보드 정적 서버 실행 (Linux)
# 사용법: ./start_server.sh [포트]   (기본 8787)
set -e

PORT="${1:-8787}"
BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WEB_DIR="$BASE_DIR/web"
LOG_DIR="$BASE_DIR/logs"
PID_FILE="$LOG_DIR/http_server_$PORT.pid"

mkdir -p "$LOG_DIR"

if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "이미 실행 중입니다 (PID $(cat "$PID_FILE"), 포트 $PORT)"
  exit 0
fi

cd "$WEB_DIR"
nohup python3 -m http.server "$PORT" --bind 0.0.0.0 \
  > "$LOG_DIR/http_server_$PORT.out.log" \
  2> "$LOG_DIR/http_server_$PORT.err.log" &
echo $! > "$PID_FILE"

sleep 1
if kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "시작됨: http://$(hostname -I | awk '{print $1}'):$PORT/  (PID $(cat "$PID_FILE"))"
else
  echo "시작 실패 — $LOG_DIR/http_server_$PORT.err.log 확인"
  exit 1
fi
