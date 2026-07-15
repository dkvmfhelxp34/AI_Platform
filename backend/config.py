"""Buoy Platform — 환경설정 로더.

`.env` 를 python-dotenv 로 로드하고, 백엔드 전역에서 쓰는 설정값을 노출한다.
키는 절대 소스에 하드코딩하지 않는다(폴백 기본키 하드코딩 금지) — `.env` 미설정 시
명확히 실패하거나 빈 문자열을 반환해 즉시 원인을 알 수 있게 한다.
"""
from __future__ import annotations

import os
import urllib.parse
from pathlib import Path

from dotenv import load_dotenv

# backend/config.py 기준 프로젝트 루트의 .env 를 로드 (cwd 무관하게 항상 같은 파일)
_ROOT = Path(__file__).resolve().parent.parent
_ENV_PATH = _ROOT / ".env"
load_dotenv(dotenv_path=_ENV_PATH)

PORT: int = int(os.environ.get("PORT", "8506"))
LLM_BACKEND: str = os.environ.get("LLM_BACKEND", "claude")

KMA_APIHUB_KEY: str = os.environ.get("KMA_APIHUB_KEY", "")

# KHOA "Encoding" 형태 키(%2B·%2F·%3D 등 이미 URL 인코딩됨). requests 의 params= 에는
# "디코딩된" 문자열을 넘겨야 requests 가 정확히 1회만 재인코딩한다. 그대로 넘기면
# %가 다시 인코딩(%25)되어 키가 깨지고 401 이 난다.
KHOA_DATA_KEY: str = os.environ.get("KHOA_DATA_KEY", "")
KHOA_DATA_KEY_DECODED: str = urllib.parse.unquote(KHOA_DATA_KEY) if KHOA_DATA_KEY else ""


def require_kma_key() -> str:
    if not KMA_APIHUB_KEY:
        raise RuntimeError("KMA_APIHUB_KEY not set in .env")
    return KMA_APIHUB_KEY


def require_khoa_key() -> str:
    if not KHOA_DATA_KEY_DECODED:
        raise RuntimeError("KHOA_DATA_KEY not set in .env")
    return KHOA_DATA_KEY_DECODED
