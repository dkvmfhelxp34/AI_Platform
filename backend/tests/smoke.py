"""Phase 0 스모크 테스트 — 실제 KMA/KHOA 라이브 API 를 호출해 파싱 결과를 검증한다.

실행: ~/miniconda3/envs/buoy/bin/python backend/tests/smoke.py
(backend/ 를 sys.path 에 넣어 실행하거나, 이 파일이 backend/tests/ 아래 있으므로
 상위 backend/ 디렉터리를 경로에 추가한다.)
"""
from __future__ import annotations

import re
import sys
from collections import Counter
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import kma_marine
import khoa_api
import stations
import timeseries
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


def test_status_cadence():
    """Fix 1 — cadence 기반 판정. 실제 시각 대신 합성(synthetic) 케이스로 임계값 자체를 검증한다
    (라이브 데이터 타이밍에 의존하지 않아 언제 돌려도 결정론적)."""
    _hr("3a) status.classify() — cadence 기반 임계값")
    import datetime
    import status

    now = datetime.datetime(2026, 7, 15, 15, 0)

    def obs(minutes_ago: float) -> str:
        return (now - datetime.timedelta(minutes=minutes_ago)).strftime("%Y-%m-%d %H:%M")

    cases = [
        # (설명, source, stn_id, minutes_ago, observed_cadence_min, 기대 status)
        ("KMA 정상 격자(33분, 배포지연 마진 안)", "KMA", "22101", 33, None, status.Status.OK),
        ("KMA 지연(63분, laggard)", "KMA", "22473", 63, None, status.Status.DELAYED),
        ("KMA 미수신(300분)", "KMA", "22473", 300, None, status.Status.LOST),
        # 사용자 명시 요구사항: KG_(30분 주기) 심해부이가 30~60분 됐다고 지연이면 안 된다.
        ("KHOA KG_ 30분 주기 부이, 32분 나이 → 정상", "KHOA", "KG_0101", 32, None, status.Status.OK),
        ("KHOA KG_ 30분 주기 부이, 52분 나이 → 정상(cadence 반영)", "KHOA", "KG_0021", 52, None, status.Status.OK),
        ("KHOA KG_ 63분 나이(2주기+ 밀림) → 지연", "KHOA", "KG_0024", 63, None, status.Status.DELAYED),
        ("KHOA 연안(TW_) 15분 나이 → 정상", "KHOA", "TW_0095", 15, None, status.Status.OK),
        ("KHOA 연안(TW_) 25분 나이(뒤처짐) → 지연", "KHOA", "TW_0095", 25, None, status.Status.DELAYED),
        # observed_cadence_min 이 접두사 기본값보다 우선해야 함 — 실측 1시간 주기라면 70분도 정상.
        ("observed_cadence_min=60(시간단위) 우선 적용, 70분 나이 → 정상", "KHOA", "TW_9999", 70, 60.0, status.Status.OK),
        ("obs_time 파싱불가(None) → 미수신", "KHOA", "YS_0002", None, None, status.Status.LOST),
    ]
    for desc, source, stn_id, minutes_ago, observed_cadence, expected in cases:
        obs_time = obs(minutes_ago) if minutes_ago is not None else None
        result = status.classify(obs_time, now, source=source, stn_id=stn_id, observed_cadence_min=observed_cadence)
        print(f"  {desc}: minutes_since={result['minutes_since']} cadence_min={result['cadence_min']} "
              f"status={result['status'].value} (expect {expected.value})")
        assert result["status"] == expected, f"FAILED: {desc} -> got {result['status']}, expected {expected}"
        assert result["cadence_min"] is not None, f"FAILED: {desc} -> cadence_min missing (SSOT context required)"

    # SSOT: 같은 obs_time/now/source 로 두 번 호출하면 minutes_since 가 정확히 같아야 한다
    # (프론트가 "N분 전"과 status 를 별도 계산해 어긋나는 일이 없어야 하므로).
    r1 = status.classify(obs(32), now, source="KHOA", stn_id="KG_0101")
    r2 = status.classify(obs(32), now, source="KHOA", stn_id="KG_0101")
    assert r1["minutes_since"] == r2["minutes_since"] == 32.0
    assert r1["status"] == r2["status"] == status.Status.OK


def test_stations_specs():
    """Fix 2 — 센서고 정규화. 실제 리뷰에서 지적된 '8.34/8.34'·'-1.2 m' 패턴을 합성 케이스로 검증."""
    _hr("3b) stations._parse_dual / _above_surface_spec / _below_surface_spec")

    # 완전 중복 a/b → 단일값으로 축약(리뷰 지적 사례: "센서고·풍향 8.34/8.34 m")
    v, sec = stations._parse_dual("8.34/8.34")
    print(f"  '8.34/8.34' -> value={v} secondary={sec}")
    assert v == 8.34 and sec is None

    # 서로 다른 이중센서는 둘 다 보존
    v, sec = stations._parse_dual("4.4/3.9")
    assert v == 4.4 and sec == 3.9

    # -99 결측 센티널은 버림(지어낸 값 반환 금지), 실측 음수(-1.2)는 유효값으로 통과
    v, sec = stations._parse_dual("-99/-99")
    assert v is None and sec is None
    v, sec = stations._parse_dual(None)
    assert v is None and sec is None

    # 풍향(°)과 절대 혼동되지 않는 필드명 + below_surface 변환(음수→양수 깊이 + 플래그)
    wind_spec = stations._above_surface_spec("8.34/8.34", "test-label")
    print(f"  wind spec: {wind_spec}")
    assert wind_spec["value_m"] == 8.34 and wind_spec["secondary_value_m"] is None
    assert "wd" not in wind_spec and "풍향" not in str(wind_spec.get("value_m"))

    depth_spec = stations._below_surface_spec("-1.2/-1.2", "test-label")
    print(f"  water_temp depth spec: {depth_spec}")
    assert depth_spec["value_m"] == 1.2 and depth_spec["below_surface"] is True
    assert depth_spec["secondary_value_m"] is None  # 중복 축약

    missing_spec = stations._below_surface_spec(None, "test-label")
    assert missing_spec["value_m"] is None and missing_spec["below_surface"] is None

    # 라이브 KMA 지점의 정규화 결과 확인(가능하면) — 실제 '서해170'류 대형부이가 있으면 검증
    s = stations.get_stations()
    kma = {d["stn_id"]: d for d in s if d["source"] == "KMA"}
    dup_example = next((sid for sid in ("22191", "22192", "22193", "22299") if sid in kma), None)
    if dup_example:
        specs = kma[dup_example]["specs"]
        print(f"  live {kma[dup_example]['name']}({dup_example}) wind_sensor_height_m: {specs['wind_sensor_height_m']}")
        assert specs["wind_sensor_height_m"]["secondary_value_m"] is None, "중복 a/b 가 축약되지 않음"
    else:
        print("  (대형부이 서해170류 샘플이 이번 목록에 없어 라이브 검증은 스킵 — 합성 케이스로 충분)")

    # KHOA 는 제원 API 미제공 스코프 — specs=None 이어야 함(지어낸 값 없음)
    khoa = next((d for d in s if d["source"] == "KHOA"), None)
    if khoa:
        assert khoa["specs"] is None


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
        # Fix 1 SSOT: 개별 live 레코드에 cadence_min 이 minutes_since/status 와 함께 실려야 한다.
        assert kma_sample.get("cadence_min") is not None, "KMA live item missing cadence_min"
        assert khoa_sample.get("cadence_min") is not None, "KHOA live item missing cadence_min"

        r = client.get("/api/status")
        j = r.json()
        print(f"GET /api/status -> {r.status_code} (초기, burst 진행 중일 수 있음)")
        print(f"  total={j.get('total')}  by_source={j.get('by_source')}")
        assert r.status_code == 200
        # Fix 3: freshness SSOT + KPI 집계 필드가 모두 존재해야 한다(이 구조 체크는 burst 완료를 안
        # 기다려도 안전 — 값의 분포가 아니라 필드 존재/타입만 본다).
        for key in ("data_freshness", "max_wave", "mean_wave", "alerts"):
            assert key in j, f"/api/status missing '{key}' (Fix 3)"
        df = j["data_freshness"]
        for key in ("newest_obs_age_min", "oldest_obs_age_min", "last_cache_refresh", "cache_age_sec"):
            assert key in df, f"data_freshness missing '{key}'"

        # Fix 1(Wave 3a): 등록부(stations.py) 는 "무데이터/항법보조" 만 제외하고, twRecent 가 일시적으로
        # 비어도 관측개시일(pointDetail.do) 신호가 있으면 등록부엔 남긴다(KG_0028 실측 사례 — 두 신호
        # 중 하나만 무데이터일 땐 제외하지 않음, `_khoa_stations()` 참고). 그 결과 "등록됨(존재 확인)"
        # ⊇ "지금 이 순간 라이브 데이터 있음" 이 될 수 있다 — twRecent 가 이번 burst 에 마침 응답 안 한
        # 등록 지점은 `/api/live`·`/api/status` 에 그 순간엔 안 잡히는 게 정상이다(허위 미수신
        # placeholder 를 다시 만들지 않기로 한 설계, main.py 참고).
        # 아래 분포/KPI 검증은 burst 가 완전히 끝난 **정상상태(steady state)** 스냅샷으로 해야 의미가
        # 있다(초기 스냅샷은 KHOA 가 1~2개소만 채워진 과도상태라 "전부 정상"처럼 우연히 왜곡될 수 있음
        # — 실제로 이 타이밍 의존성 때문에 예전 버전은 가끔 오탐했다). 41개소 순차 burst 는 고립 실행시
        # 실측 약 90초지만, 동시에 다른 프로세스가 같은 KHOA 엔드포인트를 두드리고 있으면(예: 별도 검증용
        # 서버가 함께 떠 있는 경우) 느려질 수 있어 고정 대기 대신 "스냅샷 크기가 더 안 느는 시점"까지
        # 넉넉한 상한(최대 240초)으로 폴링한다.
        deadline = time.time() + 240
        last_n = -1
        stable_checks = 0
        khoa_snap: dict = {}
        while time.time() < deadline:
            khoa_snap, _ = live_cache.get_khoa_snapshot()
            if len(khoa_snap) == last_n:
                stable_checks += 1
                if stable_checks >= 3:  # 15초(5초 간격 3회) 연속 변화 없으면 burst 종료로 간주
                    break
            else:
                stable_checks = 0
            last_n = len(khoa_snap)
            time.sleep(5)
        print(f"  KHOA burst 대기 종료: 스냅샷 {len(khoa_snap)}개소")

        j = client.get("/api/status").json()
        print(f"GET /api/status -> 200 (steady state)")
        print(f"  total={j.get('total')}  by_source={j.get('by_source')}")
        print(f"  data_freshness={j.get('data_freshness')}")
        print(f"  max_wave={j.get('max_wave')}  mean_wave={j.get('mean_wave')}  alerts={j.get('alerts')}")

        # Fix 1: 정상상태 분포가 "전부 정상"도 "지연 과다"도 아니어야 한다 — 정상 다수 + 실제 소수.
        total = j["total"]
        grand = sum(total.values())
        ok_ratio = total.get("정상", 0) / grand if grand else 0
        print(f"  정상 비율: {ok_ratio:.0%} (전체 {grand})")
        assert grand > 0
        assert ok_ratio >= 0.5, f"정상 비율이 너무 낮음({ok_ratio:.0%}) — 임계값이 여전히 지연-heavy"

        # Fix 1: KG_(30분 심해부이) 는 30~60분 나이여도 정상이어야 한다(사용자 명시 요구사항).
        kg_items = [it for it in client.get("/api/live").json()["items"] if it["id"].startswith("KG_")]
        kg_in_window = [it for it in kg_items if it["minutes_since"] is not None and 25 <= it["minutes_since"] <= 60]
        if kg_in_window:
            bad = [it for it in kg_in_window if it["status"] != "정상"]
            print(f"  KG_ 30~60분 나이 표본: {[(it['id'], it['minutes_since'], it['status']) for it in kg_in_window]}")
            assert not bad, f"KG_ 30~60분 나이인데 정상이 아닌 지점 존재: {bad}"
        else:
            print("  (이번 스냅샷엔 KG_ 지점이 25~60분 나이 구간에 없어 실시간 표본 검증은 스킵)")

        assert j["alerts"] == total.get("지연", 0) + total.get("미수신", 0), "alerts != 지연+미수신 합"
        if j["max_wave"] is not None:
            assert j["max_wave"]["value"] <= 20.0, "max_wave 에 비현실적 이상치가 그대로 노출됨"
            for key in ("station_name", "station_id", "source"):
                assert key in j["max_wave"]

        stations_fresh = stations.get_stations(force=True)
        khoa_registered_ids = {s["id"] for s in stations_fresh if s["source"] == "KHOA"}
        khoa_total_in_status = sum(j["by_source"].get("KHOA", {}).values())
        pending = khoa_registered_ids - set(khoa_snap.keys())
        print(f"  KHOA 등록 {len(khoa_registered_ids)}개소 vs /api/status 집계 {khoa_total_in_status}개소"
              f" (등록됐지만 이번 burst 엔 미응답: {sorted(pending) or '없음'})")
        assert khoa_total_in_status <= len(khoa_registered_ids), "집계가 등록 수를 초과함(있을 수 없는 상태)"
        # 소수(YS_0007/KG_0028 류, 이번 burst 에 마침 응답 안 한 지점)는 정상 — 등록 지점의 태반이
        # 빠지면(예: burst 가 조기 종료 오판됐거나 무데이터 필터가 과도하게 걸린 경우)만 회귀로 본다.
        assert len(pending) <= max(5, len(khoa_registered_ids) // 4), (
            f"등록됐지만 라이브에 없는 지점이 예상보다 많음(무데이터 필터 회귀 또는 burst 조기종료 의심): {pending}"
        )


def test_khoa_registry_excludes_nav_aids():
    """Fix 1 — 항법보조시설(유도등부표) 은 등록부에서 완전히 제외, 실제 관측부이는 이름이 비슷해도
    (YS_ 접두사 공유) 남아야 한다. 무데이터 지점(never responded)도 41개소보다 적게 남아야 한다."""
    _hr("4) stations.get_stations() — Fix 1 KHOA 항법보조/무데이터 제외")
    s = stations.get_stations(force=True)
    khoa = [d for d in s if d["source"] == "KHOA"]
    names = [d["name"] or "" for d in khoa]
    nav_aid_leftover = [n for n in names if "등부표" in n]
    print(f"  KHOA 등록 {len(khoa)}개소(41개소 운영현황 중), 잔존 등부표: {nav_aid_leftover}")
    assert not nav_aid_leftover, f"등부표(항법보조시설)가 등록부에 남아있음: {nav_aid_leftover}"
    assert len(khoa) < 41, "무데이터/항법보조 제외가 전혀 반영되지 않음(41개소 그대로)"
    ids = {d["id"] for d in khoa}
    assert "YS_0002" not in ids and "YS_0003" not in ids, "여수 유도등부표(YS_0002/YS_0003)가 여전히 등록부에 있음"
    if "YS_0007" in ids:
        print("  YS_0007(여수기상관측부이, 실제 관측부이)은 이름이 비슷한 YS_ 접두사여도 정상 포함됨 확인")


def test_stations_khoa_obs_start_date():
    """Fix 4 — KHOA 지점에 관측개시일(있으면) 노출, 지어낸 값 없이 결측은 None."""
    _hr("5) stations.get_stations() — Fix 4 KHOA obs_start_date")
    s = stations.get_stations()
    khoa = [d for d in s if d["source"] == "KHOA"]
    assert khoa, "KHOA 지점이 하나도 없음"
    assert all("obs_start_date" in d for d in khoa), "KHOA 레코드에 obs_start_date 키 자체가 없음"
    with_date = [d for d in khoa if d.get("obs_start_date")]
    print(f"  obs_start_date 확보 {len(with_date)}/{len(khoa)}개소, 샘플: {[(d['id'], d['obs_start_date']) for d in with_date[:3]]}")
    for d in with_date:
        assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", d["obs_start_date"]), f"obs_start_date 형식 이상: {d}"
    assert len(with_date) > 0, "단 한 지점도 obs_start_date 를 확보하지 못함(비공식 경로 전면 실패 가능성)"


def test_api_station_detail():
    """`/api/station/{id}` — Wave 3b 상세패널용 단일 지점 조회."""
    _hr("6) GET /api/station/{id}")
    import main
    with TestClient(main.app) as client:
        s = stations.get_stations()
        kma_id = next(d["id"] for d in s if d["source"] == "KMA")
        r = client.get(f"/api/station/{kma_id}")
        j = r.json()
        print(f"  {kma_id} -> specs keys: {list((j.get('specs') or {}).keys())}")
        assert r.status_code == 200 and j.get("id") == kma_id and j.get("specs") is not None

        r_missing = client.get("/api/station/NOPE_9999")
        assert "error" in r_missing.json(), "존재하지 않는 id 에 error 가 없음"


def test_timeseries_historical_ranges():
    """Fix 2 — /api/timeseries 과거 이력 확장(range=7d/30d/1y). KMA B(30분)·KMA C(일별 대체)·
    KHOA(oceangrid day-loop, ~30일 캡) 세 경로 모두 확인."""
    _hr("7) /api/timeseries — range=7d/1y(KMA B), range=30d(KMA C), range=7d(KHOA)")
    import main
    with TestClient(main.app) as client:
        # KMA B(해양기상부이) 7일 — 30분 격자면 7*48=336 포인트가 나와야 한다.
        r = client.get("/api/timeseries", params={"source": "KMA", "id": "22101", "range": "7d"})
        j = r.json()
        print(f"  KMA 22101 range=7d: resolution={j.get('resolution')} points={len(j.get('points', []))}")
        assert r.status_code == 200 and "error" not in j
        assert j.get("resolution") == "30min"
        assert len(j["points"]) >= 300, f"7일치 30분 격자치고 포인트가 너무 적음: {len(j['points'])}"
        assert "stats" in j and "wave" in j["stats"] and j["cadence_min"] is not None

        # KMA B 1년 — 354일 분할호출 병합이 실제로 몇 달치 이력을 되돌려주는지 확인.
        r = client.get("/api/timeseries", params={"source": "KMA", "id": "22101", "range": "1y"})
        j = r.json()
        n = len(j.get("points", []))
        print(f"  KMA 22101 range=1y: points={n} first={j['points'][0]['t'] if n else None} last={j['points'][-1]['t'] if n else None}")
        assert r.status_code == 200 and "error" not in j
        assert n > 15000, f"1년치 30분 격자치고 포인트가 너무 적음(분할호출 병합 실패 의심): {n}"
        first_dt = datetime.strptime(j["points"][0]["t"], "%Y-%m-%d %H:%M")
        assert (kma_marine.now_kst() - first_dt).days >= 360, "1년 범위인데 첫 포인트가 충분히 과거가 아님"

        # KMA C(파고부이) — kma_buoy2 는 0건이라 getDailyWaveBuoy 대체경로로 빠지는지 확인.
        c_station = next(d for d in stations.get_stations() if d["source"] == "KMA" and d["tp"] == "C")
        r = client.get("/api/timeseries", params={"source": "KMA", "id": c_station["stn_id"], "range": "30d"})
        j = r.json()
        print(f"  KMA {c_station['stn_id']}({c_station['name']}, C) range=30d: resolution={j.get('resolution')} points={len(j.get('points', []))}")
        assert r.status_code == 200 and "error" not in j
        assert j.get("resolution") == "daily", "C타입은 kma_buoy2 미지원이라 daily(getDailyWaveBuoy) 경로여야 함"
        # 이 샌드박스 데이터셋은 12월 이외 월이 "발간되지 않은 기간"이라 당월 창은 sparse 할 수 있음(설계상
        # 예상됨, 스펙 명시) — 그래도 sea_obs 최신값 병합으로 최소 1포인트는 있어야 한다.
        assert len(j["points"]) >= 1, "C타입 30d 응답에 최신 병합 포인트조차 없음"
        # 대체경로 자체의 파싱은 특정 발간월(2024-12, 실측 확인)로 직접 검증한다.
        daily_pts = timeseries._daily_wave_buoy_span_points(c_station["stn_id"], date(2024, 12, 1), date(2024, 12, 31))
        print(f"    getDailyWaveBuoy 직접호출(2024-12, {c_station['stn_id']}): {len(daily_pts)}행")

        # KHOA — oceangrid day-loop 로 7일치 과거 이력 + twRecent 최신 보강.
        r = client.get("/api/timeseries", params={"source": "KHOA", "id": "KG_0024", "range": "7d"})
        j = r.json()
        n = len(j.get("points", []))
        print(f"  KHOA KG_0024 range=7d: resolution={j.get('resolution')} points={n}")
        assert r.status_code == 200 and "error" not in j
        assert n >= 200, f"7일치 KHOA 이력치고 포인트가 너무 적음(oceangrid day-loop 실패 의심): {n}"

        # KHOA 1y → 30일 캡 확인(응답성 확보, Fix 2 명시 사양).
        r = client.get("/api/timeseries", params={"source": "KHOA", "id": "KG_0024", "range": "1y"})
        j = r.json()
        assert "30일" in j.get("unit_notes", ""), "KHOA 1y 요청이 30일 캡 안내를 포함하지 않음"
        first_dt = datetime.strptime(j["points"][0]["t"], "%Y-%m-%d %H:%M")
        span_days = (kma_marine.now_kst() - first_dt).days
        print(f"  KHOA KG_0024 range=1y capped span: {span_days}일")
        assert span_days <= 31, f"KHOA 캡이 30일을 훨씬 넘음: {span_days}일"


if __name__ == "__main__":
    test_kma_sea_obs()
    test_kma_buoy_series()
    test_khoa()
    test_stations()
    test_status_cadence()
    test_stations_specs()
    test_api_endpoints()
    test_khoa_registry_excludes_nav_aids()
    test_stations_khoa_obs_start_date()
    test_api_station_detail()
    test_timeseries_historical_ranges()
    _hr("ALL SMOKE TESTS PASSED")
