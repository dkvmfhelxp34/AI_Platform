"""Phase 3 스모크 — `/api/timeseries` 실제 KMA/KHOA 응답 검증.

실행: ~/miniconda3/envs/buoy/bin/python backend/tests/smoke_ts.py
"""
from __future__ import annotations

import json
import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient


def _hr(title: str):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


def _summary(j: dict):
    pts = j.get("points", [])
    print(f"  id={j.get('id')} source={j.get('source')} name={j.get('name')}")
    print(f"  unit_notes: {j.get('unit_notes')}")
    print(f"  point count: {len(pts)}")
    if pts:
        print(f"  first point: {json.dumps(pts[0], ensure_ascii=False)}")
        print(f"  last  point: {json.dumps(pts[-1], ensure_ascii=False)}")
        flagged = [p for p in pts if p.get("qc", {}).get("flagged")]
        print(f"  flagged points in payload: {len(flagged)}")
        if flagged:
            print(f"    sample flagged point: {json.dumps(flagged[0], ensure_ascii=False)}")
    print(f"  qc_summary: {j.get('qc_summary')}")


def test_kma_timeseries():
    _hr("1) GET /api/timeseries?source=KMA&id=KMA_22101&hours=24 (덕적도)")
    import main
    client = TestClient(main.app)
    r = client.get("/api/timeseries", params={"source": "KMA", "id": "KMA_22101", "hours": 24})
    print(f"status: {r.status_code}")
    j = r.json()
    _summary(j)
    assert r.status_code == 200 and "error" not in j
    assert len(j.get("points", [])) > 0, "no KMA points"


def test_kma_timeseries_flagged_station():
    _hr("1b) GET /api/timeseries?source=KMA&id=KMA_22188&hours=48 (통영 — 실측상 AQC 플래그 존재 지점)")
    import main
    client = TestClient(main.app)
    r = client.get("/api/timeseries", params={"source": "KMA", "id": "KMA_22188", "hours": 48})
    print(f"status: {r.status_code}")
    j = r.json()
    _summary(j)
    assert r.status_code == 200 and "error" not in j


def test_khoa_timeseries():
    _hr("2) GET /api/timeseries?source=KHOA&id=TW_0095&hours=24 (고래불해수욕장)")
    import main
    client = TestClient(main.app)
    r = client.get("/api/timeseries", params={"source": "KHOA", "id": "TW_0095", "hours": 24})
    print(f"status: {r.status_code}")
    j = r.json()
    _summary(j)
    assert r.status_code == 200 and "error" not in j
    assert len(j.get("points", [])) > 0, "no KHOA points"
    assert j.get("qc_summary", {}).get("checked") is False, "KHOA qc_summary.checked should be False (no institutional QC)"


def test_khoa_timeseries_deep_buoy():
    _hr("2b) GET /api/timeseries?source=KHOA&id=KG_0024&hours=24 (대한해협 심해부이)")
    import main
    client = TestClient(main.app)
    r = client.get("/api/timeseries", params={"source": "KHOA", "id": "KG_0024", "hours": 24})
    print(f"status: {r.status_code}")
    j = r.json()
    _summary(j)
    assert r.status_code == 200 and "error" not in j


if __name__ == "__main__":
    test_kma_timeseries()
    test_kma_timeseries_flagged_station()
    test_khoa_timeseries()
    test_khoa_timeseries_deep_buoy()
    _hr("ALL /api/timeseries SMOKE TESTS PASSED")
