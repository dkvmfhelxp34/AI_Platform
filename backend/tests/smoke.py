"""Phase 0 스모크 테스트 — 실제 KMA/KHOA 라이브 API 를 호출해 파싱 결과를 검증한다.

실행: ~/miniconda3/envs/buoy/bin/python backend/tests/smoke.py
(backend/ 를 sys.path 에 넣어 실행하거나, 이 파일이 backend/tests/ 아래 있으므로
 상위 backend/ 디렉터리를 경로에 추가한다.)
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import kma_marine
import khoa_api
import stations
from fastapi.testclient import TestClient


def _hr(title: str):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def test_kma_sea_obs():
    _hr("1) kma_marine.fetch_sea_obs()")
    data = kma_marine.fetch_sea_obs()
    print(f"total count: {len(data)}")
    tp_counts = Counter(d["tp"] for d in data)
    bc_count = tp_counts.get("B", 0) + tp_counts.get("C", 0)
    print(f"TP breakdown: {dict(tp_counts)}")
    print(f"B(해양기상부이)+C(파고부이) count: {bc_count}")
    bc = [d for d in data if d["tp"] in ("B", "C")]
    print("3 sample buoys (name, lon/lat, wave/wind/temp):")
    for d in bc[:3]:
        print(
            f"  [{d['tp']}] {d['name']:8s} lon={d['lon']:.4f} lat={d['lat']:.4f} "
            f"wave={d['wh']} wind={d['ws']}m/s({d['wd']}deg) watertemp={d['tw']} "
            f"airtemp={d['ta']} pressure={d['pa']} obs_time={d['tm']}"
        )
    assert bc_count > 0, "no B/C buoys parsed"
    assert any(d["wh"] is not None or d["ws"] is not None for d in bc), "all values None — parsing broken"


def test_kma_buoy_series():
    _hr("1b) kma_marine.fetch_buoy_series('22101', ...) — kma_buoy2.php QC 시계열")
    import datetime
    now = kma_marine.now_kst()
    tm2 = now.strftime("%Y%m%d%H%M")
    tm1 = (now - datetime.timedelta(hours=2)).strftime("%Y%m%d%H%M")
    series = kma_marine.fetch_buoy_series("22101", tm1, tm2)
    print(f"count: {len(series)} (tm1={tm1} tm2={tm2})")
    for r in series[:3]:
        print(f"  {r}")
    assert len(series) > 0, "no time series records parsed"


def test_khoa():
    _hr("2) khoa_api.fetch_buoy_list()")
    buoys = khoa_api.fetch_buoy_list()
    print(f"count: {len(buoys)} (expect ~41)")
    for b in buoys[:3]:
        print(f"  {b}")
    assert len(buoys) >= 30, f"expected ~41 KHOA buoys, got {len(buoys)}"

    _hr("2b) khoa_api.fetch_tw_recent('TW_0095') — 고래불해수욕장")
    tw = khoa_api.fetch_tw_recent("TW_0095")
    print(tw)
    assert tw is not None, "fetch_tw_recent returned None"
    assert tw.get("wvhgt") is not None or tw.get("wspd") is not None, "tw_recent values all None"

    _hr("2c) khoa_api.fetch_noon_wave('KG_0024') — 대한해협")
    nw = khoa_api.fetch_noon_wave("KG_0024")
    print(f"count: {len(nw)}")
    if nw:
        print("latest:", nw[-1])
    assert len(nw) > 0, "fetch_noon_wave returned empty list"


def test_stations():
    _hr("2d) stations.get_stations()")
    s = stations.get_stations()
    src_counts = Counter(d["source"] for d in s)
    print(f"total: {len(s)}  by source: {dict(src_counts)}")
    assert src_counts.get("KMA", 0) > 0 and src_counts.get("KHOA", 0) > 0


def test_api_endpoints():
    _hr("3) FastAPI TestClient — /api/health, /api/stations, /api/live, /api/status")
    import time
    import main
    import live_cache

    # live_cache 백그라운드 리프레셔(Phase 2)는 FastAPI lifespan(startup)에서 시작되므로,
    # `with TestClient(...) as client:` 컨텍스트로 실제 앱 기동과 동일하게 진입해야 한다
    # (컨텍스트 없이 만들면 startup 이 실행되지 않아 live_cache 가 계속 비어 있다).
    with TestClient(main.app) as client:
        r = client.get("/api/health")
        print(f"GET /api/health -> {r.status_code} {r.json()}")
        assert r.status_code == 200 and r.json().get("ok") is True

        r = client.get("/api/stations")
        j = r.json()
        print(f"GET /api/stations -> {r.status_code} count={j.get('count')}")
        print("  sample:", j["items"][0] if j.get("items") else None)
        assert r.status_code == 200 and j.get("count", 0) > 0

        # 백그라운드 첫 채움 대기(최대 20초 폴링) — KMA 는 거의 즉시, KHOA 는 41개소 burst(≈수 초~수십초).
        deadline = time.time() + 20
        while time.time() < deadline:
            kma_snap, _ = live_cache.get_kma_snapshot()
            khoa_snap, _ = live_cache.get_khoa_snapshot()
            if kma_snap and khoa_snap:
                break
            time.sleep(1)

        r = client.get("/api/live")
        j = r.json()
        print(f"GET /api/live -> {r.status_code} count={j.get('count')}")
        print("  sample:", j["items"][0] if j.get("items") else None)
        kma_sample = next((it for it in j["items"] if it["source"] == "KMA"), None)
        khoa_sample = next((it for it in j["items"] if it["source"] == "KHOA"), None)
        print("  KMA sample:", kma_sample)
        print("  KHOA sample:", khoa_sample)
        assert r.status_code == 200 and j.get("count", 0) > 0
        assert kma_sample is not None, "no KMA items in /api/live"
        assert khoa_sample is not None, "no KHOA items in /api/live"

        r = client.get("/api/status")
        j = r.json()
        print(f"GET /api/status -> {r.status_code} {j}")
        assert r.status_code == 200


if __name__ == "__main__":
    test_kma_sea_obs()
    test_kma_buoy_series()
    test_khoa()
    test_stations()
    test_api_endpoints()
    _hr("ALL SMOKE TESTS PASSED")
