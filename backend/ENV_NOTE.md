# 백엔드 실행 환경

- conda env: `buoy` (python 3.11.15), 인터프리터 경로: `~/miniconda3/envs/buoy/bin/python`
- 생성: `conda create -n buoy python=3.11 -y`
- 패키지: `~/miniconda3/envs/buoy/bin/pip install fastapi uvicorn requests python-dotenv httpx`
- 실행: `cd backend && ~/miniconda3/envs/buoy/bin/python main.py` (포트는 `.env` PORT=8506)
- 스모크 테스트: `cd backend && ~/miniconda3/envs/buoy/bin/python tests/smoke.py`
