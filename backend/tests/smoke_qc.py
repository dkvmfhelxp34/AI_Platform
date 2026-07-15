"""Phase 4(알고리즘 AI-QC) + Phase 6(가상 24h 예측) 스모크.

qc.py/forecast.py 순수 함수 단위 테스트(합성 데이터, 네트워크 불필요) +
`/api/timeseries`(ai_qc 병합) · `/api/forecast` 실제 통합 검증(KMA 라이브 API 호출).

실행: ~/miniconda3/envs/buoy/bin/python backend/tests/smoke_qc.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import qc
import forecast


def _hr(title: str):
    print("\n" + "=" * 70)
    print(title)
    print("=" * 70)


# ── qc.py ────────────────────────────────────────────────────────────────────

def test_detect_spikes_synthetic():
    _hr("1) qc.detect_spikes() — 인위적 스파이크 주입 (현실적 노이즈 ±0.05 + index6=15.0)")
    values = [1.02, 0.98, 1.05, 1.01, 0.97, 1.03, 15.0, 1.00, 1.04, 0.99, 1.02, 0.96]
    flags = qc.detect_spikes(values)
    print(f"values: {values}")
    print(f"flags : {flags}")
    assert flags[6] is True, "injected spike at index 6 not flagged"
    assert sum(flags) == 1, f"expected exactly 1 flagged point, got {sum(flags)}"


def test_detect_spikes_constant_series_no_false_positive():
    _hr("1b) qc.detect_spikes() — 완전 상수 시리즈는 판단 보류(MAD=0 과탐 방지 가드)")
    values = [5.0] * 10
    flags = qc.detect_spikes(values)
    print(f"flags: {flags}")
    assert not any(flags), "constant series should not be flagged"


def test_detect_spikes_short_series():
    _hr("1c) qc.detect_spikes() — 표본 5개 미만은 판단 보류")
    flags = qc.detect_spikes([1.0, 2.0, 100.0])
    print(f"flags: {flags}")
    assert not any(flags)


def test_detect_gaps_missing_and_time_gap():
    _hr("2) qc.detect_gaps() — 결측값 + 시간 간격(gap) 탐지")
    times = [
        "2026-07-15 00:00", "2026-07-15 00:10", "2026-07-15 00:20", "2026-07-15 00:30",
        "2026-07-15 02:00",  # 90분 간격(중앙값 10분의 9배) → gap
        "2026-07-15 02:10", "2026-07-15 02:20",
    ]
    values = [1.0, 1.1, None, 1.2, 1.3, 1.25, 1.28]
    missing, gaps = qc.detect_gaps(times, values)
    print(f"missing: {missing}")
    print(f"gaps   : {gaps}")
    assert missing[2] is True and sum(missing) == 1
    assert len(gaps) == 1, f"expected 1 gap segment, got {len(gaps)}"
    assert gaps[0]["from"] == "2026-07-15 00:30" and gaps[0]["to"] == "2026-07-15 02:00"


def test_run_qc_combined():
    _hr("3) qc.run_qc() — 포인트별 ai_qc{spike,missing} + summary(spike_count/gap_count)")
    points = [
        {"t": "2026-07-15 00:00", "wave": 1.0},
        {"t": "2026-07-15 00:10", "wave": 1.05},
        {"t": "2026-07-15 00:20", "wave": None},
        {"t": "2026-07-15 00:30", "wave": 1.02},
        {"t": "2026-07-15 00:40", "wave": 0.98},
        {"t": "2026-07-15 00:50", "wave": 8.5},   # 스파이크
        {"t": "2026-07-15 01:00", "wave": 1.01},
        {"t": "2026-07-15 01:10", "wave": 0.99},
    ]
    out = qc.run_qc(points, "wave")
    print(json.dumps(out, ensure_ascii=False, indent=2))
    assert out["points"][5]["ai_qc"]["spike"] is True, "index 5 (8.5) should be flagged as spike"
    assert out["points"][2]["ai_qc"]["missing"] is True, "index 2 (None) should be flagged missing"
    assert out["summary"]["spike_count"] >= 1
    assert out["summary"]["missing_count"] == 1
    assert "ai_qc" in out["points"][0]


# ── forecast.py ──────────────────────────────────────────────────────────────

def test_forecast_synthetic_continuity_and_clamp():
    _hr("4) forecast.make_forecast() — 연속성 + 물리범위 clamp(wave>=0) + 결정론(재현성)")
    points = [
        {"t": "2026-07-14 12:00", "wave": 1.2},
        {"t": "2026-07-14 15:00", "wave": 1.4},
        {"t": "2026-07-14 18:00", "wave": 1.1},
        {"t": "2026-07-14 21:00", "wave": 0.9},
        {"t": "2026-07-15 00:00", "wave": 0.7},
        {"t": "2026-07-15 03:00", "wave": 0.5},  # 최근 하강 추세
    ]
    fc1 = forecast.make_forecast(points, "wave", hours=24, seed_key="TEST_STN_1")
    fc2 = forecast.make_forecast(points, "wave", hours=24, seed_key="TEST_STN_1")
    print(f"generated_from: {fc1['generated_from']}  note: {fc1['note']}")
    print("first 5 forecast points:", fc1["points"][:5])
    assert fc1 == fc2, "same input+seed_key must be deterministic (no wall-clock randomness)"
    assert len(fc1["points"]) == 24
    assert all(p["value"] >= 0.0 for p in fc1["points"]), "wave forecast must be clamped >=0"
    first_val = fc1["points"][0]["value"]
    assert abs(first_val - 0.5) < 1.0, f"forecast should continue plausibly from last obs(0.5), got {first_val}"


def test_forecast_different_seed_differs():
    _hr("4b) forecast.make_forecast() — seed_key(=station id) 다르면 노이즈 경로도 달라짐")
    points = [{"t": f"2026-07-15 0{h}:00", "wave": 1.0 + 0.01 * h} for h in range(6)]
    fc_a = forecast.make_forecast(points, "wave", hours=6, seed_key="STN_A")
    fc_b = forecast.make_forecast(points, "wave", hours=6, seed_key="STN_B")
    print("A:", fc_a["points"])
    print("B:", fc_b["points"])
    assert fc_a["points"] != fc_b["points"]


def test_forecast_pressure_clamp_and_no_data():
    _hr("4c) forecast.make_forecast() — pressure clamp(900~1080hPa) + 빈 입력 처리")
    points = [{"t": "2026-07-15 00:00", "pressure": 1013.0}, {"t": "2026-07-15 01:00", "pressure": 1012.5}]
    fc = forecast.make_forecast(points, "pressure", hours=12, seed_key="P1")
    print(fc["points"][:3])
    assert all(900.0 <= p["value"] <= 1080.0 for p in fc["points"])

    empty_fc = forecast.make_forecast([], "wave", hours=24, seed_key="EMPTY")
    print(empty_fc)
    assert empty_fc["points"] == [] and empty_fc["generated_from"] is None


# ── /api 통합(실제 KMA 라이브 API 호출) ────────────────────────────────────────

def test_api_timeseries_ai_qc_integration():
    _hr("5) GET /api/timeseries?source=KMA&id=22188&hours=48 — ai_qc 병합 + qc_summary 확장")
    import main
    from fastapi.testclient import TestClient
    client = TestClient(main.app)
    r = client.get("/api/timeseries", params={"source": "KMA", "id": "22188", "hours": 48})
    print(f"status: {r.status_code}")
    j = r.json()
    print(f"qc_summary: {j.get('qc_summary')}")
    assert r.status_code == 200 and "error" not in j
    pts = j.get("points", [])
    assert len(pts) > 0, "no points returned"
    assert "ai_qc" in pts[0], "points must carry ai_qc"
    assert set(pts[0]["ai_qc"].keys()) == {"spike", "missing"}
    assert "ai_spike_count" in j["qc_summary"] and "ai_gap_count" in j["qc_summary"]
    spikes = [p for p in pts if p["ai_qc"]["spike"]]
    print(f"ai spike count in payload: {len(spikes)} (qc_summary.ai_spike_count={j['qc_summary']['ai_spike_count']})")
    if spikes:
        print("  sample flagged point:", json.dumps(spikes[0], ensure_ascii=False))
    else:
        print("  (이 지점/구간엔 자연 스파이크 없음 — 위 3)에서 합성 스파이크로 detect_spikes 검증 완료)")


def test_api_forecast_integration():
    _hr("6) GET /api/forecast?source=KMA&id=22101&metric=wave — 관측 기반 예측 헤드")
    import main
    from fastapi.testclient import TestClient
    client = TestClient(main.app)
    r = client.get("/api/forecast", params={"source": "KMA", "id": "22101", "metric": "wave"})
    print(f"status: {r.status_code}")
    j = r.json()
    print(f"generated_from: {j.get('generated_from')}  note: {j.get('note')}")
    print("head:", j.get("points", [])[:5])
    assert r.status_code == 200 and "error" not in j
    assert len(j.get("points", [])) == 24
    assert j.get("note", "").startswith("모의/시연")


if __name__ == "__main__":
    test_detect_spikes_synthetic()
    test_detect_spikes_constant_series_no_false_positive()
    test_detect_spikes_short_series()
    test_detect_gaps_missing_and_time_gap()
    test_run_qc_combined()
    test_forecast_synthetic_continuity_and_clamp()
    test_forecast_different_seed_differs()
    test_forecast_pressure_clamp_and_no_data()
    test_api_timeseries_ai_qc_integration()
    test_api_forecast_integration()
    _hr("ALL QC/FORECAST SMOKE TESTS PASSED")
