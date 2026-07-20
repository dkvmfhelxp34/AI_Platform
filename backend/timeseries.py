"""통합 시계열 API 로직 — `GET /api/timeseries` (Phase 3 → Wave 3a Fix 2: 연구용 과거 이력 확장).

- KMA B(해양기상부이): `kma_marine.fetch_buoy_series(stn, tm1, tm2)`(kma_buoy2.php 기간조회, 30분 해상도)
  → AQC/MQC 관측기관 QC 병합. 354일 초과 구간은 자동으로 ≤354일 단위 분할호출 후 병합
  (`kma_buoy2.php` 단일요청 상한 실측, docs/historical_data_probe.md §1-2).
- KMA C(파고부이): `kma_buoy2.php` 가 C타입을 지원하지 않는다(실측 0건) → 그 경우
  `kma_marine.fetch_daily_wave_buoy(station, year, month)`(getDailyWaveBuoy, 일별 유의파고/최대파고/
  파주기/평균수온)로 해당 개월들을 순회해 대체한다(docs/apihub_catalog_probe.md §B — 신규 신청 불필요).
- KHOA: 단기(≤2일)는 `khoa_api.fetch_tw_recent_series(obsCode)`(twRecent 최근 롤링) 그대로. 그 이상은
  `khoa_api.fetch_oceangrid_range(...)`(oceangrid 비공식 GIS day-loop, docs/oceangrid_probe.md)로
  과거 이력을 채우고 twRecent 롤링을 최신 꼬리로 병합한다. 응답성 확보를 위해 ~30일로 캡핑
  (그 이상은 배치 사전적재가 필요 — 이번 패스 범위 밖).
- 두 소스 모두 마지막에 "지금"에 가장 가까운 실시간 포인트(KMA sea_obs / KHOA twRecent)를 병합해
  시계열이 항상 현재 시각 근처까지 이어지게 한다.

정규화 스키마:
  { id, source, name, range, resolution, unit_notes,
    points: [{t, wave, wave_period, wind_speed, wind_dir, water_temp, air_temp, pressure,
              qc: {flagged, checked, note?}, ai_qc: {spike, missing}}],
    qc_summary: {flagged_count, checked, ai_spike_count, ai_gap_count},
    stats: {<metric>: {min, max, mean, count, unit}, ...},
    cadence_min: float|None }
"""
from __future__ import annotations

import re
import threading
import time
from datetime import datetime, timedelta
from typing import Optional

import demo_scenario
import kma_marine
import khoa_api
import qc as qc_mod

_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_TTL_RECENT = 120       # 2분 — 최근/실시간성 조회(레거시 hours 파라미터 경로)
_TTL_HISTORICAL = 600   # 10분 — 과거 구간(range=7d/30d/1y)은 자주 안 바뀌어 더 오래 캐시해도 안전

# 사용자 노출용 범위 프리셋 → 일수(days). `days=N` 파라미터가 있으면 이 표보다 우선한다.
_RANGE_PRESETS_DAYS = {"24h": 1.0, "7d": 7.0, "30d": 30.0, "1y": 365.0}

_KMA_BUOY2_MAX_DAYS = 354.0   # kma_buoy2.php 단일요청 상한(실측) — 넘으면 분할호출
_KHOA_HIST_CAP_DAYS = 30.0    # oceangrid day-loop(1일당 1회 호출 다항목) 응답성 확보용 상한

# §A3 픽스 — getDailyWaveBuoy(파고부이 C타입 이력 대체경로) 발간지연 대응 lookback 반경.
# 실측(2026-07-16, KMA_22457 제주항): 최근 발간월이 2025-12 이고 그 이후(2026-01~07, 7개월)는
# 전부 미발간(resultCode!=00) — 모듈독스트링에 적힌 "발간지연 ~1.5개월" 가정보다 실제 지연이 훨씬
# 길게 나타나는 지점이 있다. 그 결과 range=7d/30d 처럼 "지금" 기준 근접 창을 그대로 쓰면(tm1~tm2
# 가 전부 미발간 구간에 들어가) 이력이 0건이 되고, `_merge_latest_kma_point` 가 더하는 실시간
# sea_obs 값 1건만 남아 "7일/30일 조회인데 포인트 1개"가 된다.
_KMA_DAILY_FALLBACK_LOOKBACK_DAYS = 365.0  # range=1y 프리셋과 동일 반경 재사용(이미 검증된 조회량)

_METRIC_UNITS = {
    "wave": "m", "wave_period": "s", "wind_speed": "m/s", "wind_dir": "deg",
    "water_temp": "℃", "air_temp": "℃", "pressure": "hPa",
}

# 유의파고 실측 상한(main.py api_status() KPI 필터와 동일 근거 — 국내외 실측 유의파고가 20m 를 넘는
# 사례는 없다) — 장기 이력(1y)엔 드물게 센서 오류로 수백~수천 m 값이 섞여 나와(실측 확인) 그대로
# stats 에 반영하면 min/max/mean 이 통째로 무의미해진다. 원본 `points` 값 자체는 건드리지 않는다
# (AI-QC 스파이크 판정용 원자료 보존), stats 요약 계산에서만 걸러낸다.
_PLAUSIBLE_WAVE_MAX_M = 20.0


# ── 공통 헬퍼 ────────────────────────────────────────────────────────────────

def _strip_kma_prefix(id_: str) -> str:
    return id_[4:] if id_.startswith("KMA_") else id_


def _fmt_kma_tm(tm: Optional[str]) -> Optional[str]:
    """'YYYYMMDDHHMI' → 'YYYY-MM-DD HH:MM' (KHOA obsrvnDt 와 표시 포맷 통일)."""
    if not tm or len(tm) != 12:
        return tm
    return f"{tm[0:4]}-{tm[4:6]}-{tm[6:8]} {tm[8:10]}:{tm[10:12]}"


def _num(v):
    """문자열/숫자 혼재 방어적 파싱. KMA 결측(-99 이하)은 None."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
    else:
        s = str(v).strip()
        if not s:
            return None
        try:
            f = float(s)
        except ValueError:
            return None
    if f <= -99.0:
        return None
    return f


_DAILY_NUM_RE = re.compile(r"[-+]?\d+(?:\.\d+)?")


def _daily_num(v):
    """getDailyWaveBuoy 값 전용 파서 — 품질주석 접미사(예: '1.3>', '16.9)')가 붙은 경우가 실측되어
    앞쪽 숫자만 추출한다(지어낸 값 아님, 원자료의 접미 기호만 제거). 결측(-99 이하)은 None."""
    if v is None:
        return None
    m = _DAILY_NUM_RE.search(str(v))
    if not m:
        return None
    try:
        f = float(m.group(0))
    except ValueError:
        return None
    if f <= -99.0:
        return None
    return f


def _parse_ts(t) -> Optional[datetime]:
    if not t:
        return None
    s = str(t).strip()
    for fmt in ("%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            continue
    return None


def _resolve_window(hours: int, range_: Optional[str], days: Optional[int]) -> tuple[float, str]:
    """(days_float, range_label) 결정. 우선순위: `days` > `range` 프리셋 > 레거시 `hours`(48h 캡 유지)."""
    if days:
        d = max(1, int(days))
        return float(d), f"{d}d"
    if range_:
        r = str(range_).strip().lower()
        if r in _RANGE_PRESETS_DAYS:
            return _RANGE_PRESETS_DAYS[r], r
    h = max(1, min(int(hours or 24), 48))
    return h / 24.0, f"{h}h"


def _parse_kma_qc(aqc: Optional[str], mqc: Optional[str]) -> dict:
    """KMA AQC(자동)/MQC(수동) 자리별 플래그 문자열 파싱.

    실측 확인(2026-07-15): `/`(미검사) 뿐 아니라 `-`(미검사/해당없음)도 쓰이며, 자리 수·의미는 지점마다
    다르게 관측됨(예: MQC 가 전부 '1'인 지점도 존재) — 자리→관측변수 매핑은 비공개(undocumented).
    따라서 "숫자이면서 0이 아닌 문자가 하나라도 있으면 그 관측 레코드(포인트) 전체를 flagged" 로
    보수적으로 처리한다(포인트 단위 플래그, 변수별 세분화는 하지 않음).
    """
    flagged = False
    checked = False
    for s in (aqc, mqc):
        if not s:
            continue
        for ch in s:
            if not ch.isdigit():
                continue  # '/', '-' 등은 미검사/해당없음 — 검사여부 판단에서 제외
            checked = True
            if ch != "0":
                flagged = True
    out = {"flagged": flagged, "checked": checked}
    if flagged:
        out["note"] = "관측기관 QC 이상치 플래그(AQC/MQC) — 자리별→변수 매핑 비공개, 레코드 단위 표시"
    return out


# ── stats / cadence(관측주기 실측) ────────────────────────────────────────────

def _compute_stats(points: list[dict]) -> dict:
    """헤드라인 변수별 min/max/mean/count(+unit) — 연구용 요약 통계(Fix 2)."""
    stats: dict = {}
    for metric, unit in _METRIC_UNITS.items():
        vals = [p[metric] for p in points if p.get(metric) is not None]
        if metric == "wave":
            vals = [v for v in vals if 0 <= v <= _PLAUSIBLE_WAVE_MAX_M]
        if not vals:
            stats[metric] = {"min": None, "max": None, "mean": None, "count": 0, "unit": unit}
            continue
        stats[metric] = {
            "min": round(min(vals), 3),
            "max": round(max(vals), 3),
            "mean": round(sum(vals) / len(vals), 3),
            "count": len(vals),
            "unit": unit,
        }
    return stats


def _median_cadence_minutes(points: list[dict]) -> Optional[float]:
    """포인트 시각 간격의 중앙값(분) — 실측 관측주기(표본 2개 미만이면 None)."""
    dts = sorted(d for d in (_parse_ts(p.get("t")) for p in points) if d is not None)
    gaps = sorted((b - a).total_seconds() / 60.0 for a, b in zip(dts, dts[1:]))
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return None
    n = len(gaps)
    mid = n // 2
    gap = gaps[mid] if n % 2 else (gaps[mid - 1] + gaps[mid]) / 2.0
    return round(gap, 1)


# ── KMA ──────────────────────────────────────────────────────────────────────

def _fetch_kma_buoy2_span(stn_id: str, tm1_dt: datetime, tm2_dt: datetime) -> list[dict]:
    """kma_buoy2.php 기간조회 — 단일요청 상한(≈354일, 실측)을 넘으면 자동 분할호출 후 병합."""
    records: list[dict] = []
    max_chunk = timedelta(days=_KMA_BUOY2_MAX_DAYS)
    chunk_start = tm1_dt
    while chunk_start < tm2_dt:
        chunk_end = min(chunk_start + max_chunk, tm2_dt)
        records.extend(kma_marine.fetch_buoy_series(
            stn_id, chunk_start.strftime("%Y%m%d%H%M"), chunk_end.strftime("%Y%m%d%H%M"),
        ))
        chunk_start = chunk_end
    return records


def _daily_wave_buoy_span_points(stn_id: str, start_date, end_date) -> list[dict]:
    """C타입(파고부이) 과거 이력 — getDailyWaveBuoy 월별 조회를 범위만큼 순회(일별행만 사용,
    상순/중순/하순/월 요약행은 제외). 일 통계라 정밀 시각이 없어 대표시각을 정오로 둔다."""
    points: list[dict] = []
    y, m = start_date.year, start_date.month
    while (y, m) <= (end_date.year, end_date.month):
        for r in kma_marine.fetch_daily_wave_buoy(stn_id, y, m):
            tm = str(r.get("tm", "")).strip()
            if not tm.isdigit():
                continue  # 상순/중순/하순/월 요약행 제외
            try:
                d = datetime(y, m, int(tm))
            except ValueError:
                continue
            if d.date() < start_date or d.date() > end_date:
                continue
            points.append({
                "t": d.strftime("%Y-%m-%d") + " 12:00",
                "wave": _daily_num(r.get("wh_sig")),
                "wave_period": _daily_num(r.get("wp")),
                "wind_speed": None,
                "wind_dir": None,
                "water_temp": _daily_num(r.get("tw")),
                "air_temp": None,
                "pressure": None,
                "qc": {"flagged": False, "checked": False},
            })
        y, m = (y, m + 1) if m < 12 else (y + 1, 1)
    points.sort(key=lambda p: p["t"])
    return points


def _daily_wave_buoy_recent_points(
    stn_id: str, days_float: float, tm1_dt: datetime, tm2_dt: datetime,
) -> list[dict]:
    """§A3 픽스 — 파고부이(C) 일별 이력을, 요청 창(`tm1_dt`~`tm2_dt`, 벽시계 "지금" 기준)이
    발간지연으로 텅 비면 "지금"이 아니라 **실제 가장 최근 발간된 데이터** 기준으로 재윈도잉해
    재조회한다.

    range=24h/7d/30d 는 전부 `tm2_dt`(≈지금) 를 창 끝으로 잡는데, getDailyWaveBuoy 는 발간지연이
    있어(위 `_KMA_DAILY_FALLBACK_LOOKBACK_DAYS` 정의부 실측 참고) 이 창이 통째로 미발간 구간에
    들어가면 0건이 된다. 이 경우 1y 프리셋과 같은 반경(`_KMA_DAILY_FALLBACK_LOOKBACK_DAYS`)으로
    한 번 더 조회해(1y 조회로 이미 검증된 반경 — 실측상 최근 발간월까지는 반드시 잡힌다) 그 안에서
    "가장 최근 발간 시각"을 새 기준점 삼아 `days_float`(7일/30일) 만큼 되짚어 슬라이스한다.

    range=24h(하루) 처럼 원래도 daily 해상도 소스에서 표본이 1개 안팎인 경우는 이 폴백을 거쳐도
    여전히 1~2개일 수 있다 — 그 자체는 정상(요청 사양에서도 허용). 폴백을 거쳐도 발간분이 아예
    없으면(관측 시작월 이전 등) 빈 리스트를 그대로 반환한다(지어낸 값 없음)."""
    points = _daily_wave_buoy_span_points(stn_id, tm1_dt.date(), tm2_dt.date())
    if points or days_float >= _KMA_DAILY_FALLBACK_LOOKBACK_DAYS:
        return points

    broad_start = (tm2_dt - timedelta(days=_KMA_DAILY_FALLBACK_LOOKBACK_DAYS)).date()
    broad_points = _daily_wave_buoy_span_points(stn_id, broad_start, tm2_dt.date())
    if not broad_points:
        return broad_points  # 폴백 반경 안에도 발간분 전혀 없음 — 정직하게 빈 리스트

    latest_dt = _parse_ts(broad_points[-1]["t"])
    if latest_dt is None:
        return broad_points
    window_start = latest_dt - timedelta(days=days_float)
    out: list[dict] = []
    for p in broad_points:
        pt = _parse_ts(p.get("t"))
        if pt is not None and pt >= window_start:
            out.append(p)
    return out


def _merge_latest_kma_point(points: list[dict], stn_id: str) -> None:
    """sea_obs 최신 스냅샷을 마지막 포인트로 병합해 시계열이 "지금"까지 이어지게 한다."""
    try:
        obs = kma_marine.fetch_sea_obs()
    except Exception:
        return
    match = next((o for o in obs if o.get("stn_id") == stn_id), None)
    if not match:
        return
    t = _fmt_kma_tm(match.get("tm"))
    if not t:
        return
    if points and points[-1].get("t") and t <= points[-1]["t"]:
        return  # 이미 이력에 포함(또는 더 과거) — 중복 방지
    points.append({
        "t": t,
        "wave": match.get("wh"),
        "wave_period": None,
        "wind_speed": match.get("ws"),
        "wind_dir": match.get("wd"),
        "water_temp": match.get("tw"),
        "air_temp": match.get("ta"),
        "pressure": match.get("pa"),
        "qc": {"flagged": False, "checked": False},
    })


def _kma_timeseries(stn_id: str, days_float: float, label: str) -> dict:
    now = kma_marine.now_kst()
    tm2_dt = now.replace(minute=(now.minute // 10) * 10, second=0, microsecond=0)
    tm1_dt = tm2_dt - timedelta(days=days_float)

    records = _fetch_kma_buoy2_span(stn_id, tm1_dt, tm2_dt)

    resolution = "30min"
    points: list[dict] = []
    flagged_count = 0
    any_checked = False
    if records:
        for r in records:
            wave = r.get("wh_sig")
            if wave is None:
                wave = r.get("wh_ave")
            qc = _parse_kma_qc(r.get("aqc"), r.get("mqc"))
            if qc["checked"]:
                any_checked = True
            if qc["flagged"]:
                flagged_count += 1
            points.append({
                "t": _fmt_kma_tm(r.get("tm")),
                "wave": wave,
                "wave_period": r.get("wp"),
                "wind_speed": r.get("ws1"),
                "wind_dir": r.get("wd1"),
                "water_temp": r.get("tw"),
                "air_temp": r.get("ta"),
                "pressure": r.get("pa"),
                "qc": qc,
            })
    else:
        # kma_buoy2.php 는 파고부이(C타입) 미지원(0건 응답) → getDailyWaveBuoy 일별 이력으로 대체.
        # §A3: 요청 창(tm1~tm2, "지금" 기준)이 발간지연으로 텅 비면 실제 최근 발간분 기준으로
        # 재윈도잉하는 폴백을 거친다(_daily_wave_buoy_recent_points 독스트링 참고). 그래도 없으면
        # (관측 시작월 이전 등) 빈 리스트 — 아래 _merge_latest_kma_point 가 최신 sea_obs 값을 더해
        # 최소 1개는 보장한다.
        resolution = "daily"
        points = _daily_wave_buoy_recent_points(stn_id, days_float, tm1_dt, tm2_dt)

    _merge_latest_kma_point(points, stn_id)

    unit_notes = (
        "파고 m(WH_SIG, 미관측시 WH_AVE) · 파주기 s · 풍속 m/s · 풍향 deg · 수온/기온 ℃ · 기압 hPa"
        " — KMA kma_buoy2.php 기간조회(tm1~tm2, 30분), AQC/MQC 관측기관 QC 포함"
        + ("" if days_float <= _KMA_BUOY2_MAX_DAYS else f" (단일요청 상한 {_KMA_BUOY2_MAX_DAYS:.0f}일 → 자동 분할호출 병합)")
    ) if resolution == "30min" else (
        "파고 m(유의파고 일평균) · 파주기 s(일평균) · 수온 ℃(일평균) — KMA getDailyWaveBuoy 일별 통계"
        "(파고부이 C타입, kma_buoy2.php 미지원 대체경로 — docs/apihub_catalog_probe.md §B)."
        " 풍속/풍향/기압/기온은 파고부이 센서 미탑재로 상시 결측."
    )

    return {
        "id": f"KMA_{stn_id}",
        "source": "KMA",
        "name": None,
        "range": label,
        "resolution": resolution,
        "unit_notes": unit_notes,
        "points": points,
        "qc_summary": {"flagged_count": flagged_count, "checked": any_checked},
    }


# ── KHOA ─────────────────────────────────────────────────────────────────────

def _khoa_timeseries(obs_code: str, days_float: float, label: str) -> dict:
    now = kma_marine.now_kst()
    days_capped = min(days_float, _KHOA_HIST_CAP_DAYS)

    # §버그픽스(2026-07-20) — 예전엔 `days_capped > 2.0` 인 범위(7d 이상)만 oceangrid 누적 이력을
    # 조회하고, 그보다 짧은(24h 포함!) 범위는 twRecent "최근 롤링"(관측 실측상 최대 10건)만으로
    # 채웠다. twRecent 롤링은 "지금 시점 기준 최근 N건"일 뿐 실제 하루 창이 아니라서:
    #   (a) 정상 수신 지점도 24h 가 10점 안팎으로 빈약했고(10분 주기면 하루 ~144점이어야 함),
    #   (b) 관측 지연 지점(twRecent 자체가 갱신을 못 받아 비어 있음)은 24h 가 통째로 0점("데이터
    #       없음")이 됐다 — 실측: 완도항 TW_0078(지연 ~3.3h) 24h=0점, 대한해협 KG_0024(정상) 24h=10점.
    # 반면 range=7d/30d 는 이미 oceangrid day-loop 누적 이력을 썼고(완도항 7d=1226점, 최신 12:10
    # 까지 포함) 문제가 없었다 — 즉 "누적 이력 저장소"는 이미 있었고 24h 경로만 안 썼다.
    # 고침: 1일(24h) 이상 범위는 전부 이 누적 이력(oceangrid day-loop)에서 만들고 요청 창으로 클립한다
    # (7d 와 동일 소스). twRecent 보다 짧은 레거시 `hours`(<24h, range 미지정) 만 예전처럼 롤링 전용
    # 으로 남겨(호출량 관리, 이 범위는 애초에 버그 재현 대상이 아니었다).
    points: list[dict] = []
    if days_capped >= 1.0:
        start_date = (now - timedelta(days=days_capped)).date()
        end_date = now.date()
        window_start = now - timedelta(days=days_float)
        for r in khoa_api.fetch_oceangrid_range(obs_code, start_date, end_date):
            t_parsed = _parse_ts(r.get("t"))
            if t_parsed is not None and t_parsed < window_start:
                continue  # 캘린더-일 단위 조회라 창 시작 이전 일부가 섞여 들어옴 — 요청 창으로 클립
            points.append({
                "t": r.get("t"),
                "wave": r.get("wave"),
                "wave_period": r.get("wave_period"),
                "wind_speed": r.get("wind_speed"),
                "wind_dir": r.get("wind_dir"),
                "water_temp": r.get("water_temp"),
                "air_temp": r.get("air_temp"),
                "pressure": r.get("pressure"),
                "qc": {"flagged": False, "checked": False},
            })

    recent = khoa_api.fetch_tw_recent_series(obs_code)
    last_t = points[-1]["t"] if points else None
    for r in recent:
        t = r.get("obsrvnDt")
        if not t or (last_t is not None and t <= last_t):
            continue  # 이미 이력에 포함(또는 더 과거) — 중복 방지
        points.append({
            "t": t,
            "wave": _num(r.get("wvhgt")),
            "wave_period": _num(r.get("wvpd")),
            "wind_speed": _num(r.get("wspd")),
            "wind_dir": _num(r.get("wndrct")),
            "water_temp": _num(r.get("wtem")),
            "air_temp": _num(r.get("artmp")),
            "pressure": _num(r.get("atmpr")),
            "qc": {"flagged": False, "checked": False},
        })
    points.sort(key=lambda p: p.get("t") or "")

    cap_note = ""
    if days_float > _KHOA_HIST_CAP_DAYS:
        cap_note = (
            f" — 요청 범위({label}) 중 최근 {_KHOA_HIST_CAP_DAYS:.0f}일만 반환(oceangrid 일자별 반복호출"
            " 한계, 그 이상 장기 이력은 배치 사전적재가 필요해 이번 온디맨드 경로 범위 밖)"
        )

    return {
        "id": obs_code,
        "source": "KHOA",
        "name": None,
        "range": label,
        "resolution": "15~30min",
        "unit_notes": (
            "파고 m · 파주기 s · 풍속 m/s · 풍향 deg · 수온/기온 ℃ · 기압 hPa"
            " — KHOA oceangrid 비공식 일자별 이력(docs/oceangrid_probe.md) + twRecent 최근 롤링으로"
            " 현재까지 보강, 기관 QC 미제공" + cap_note
        ),
        "points": points,
        "qc_summary": {"flagged_count": 0, "checked": False},
    }


# ── 알고리즘 AI-QC 병합(Phase 4) ────────────────────────────────────────────

def _apply_ai_qc(result: dict, metric: str = "wave") -> None:
    """`qc.py`(robust z-score 스파이크 + 결측/간격 탐지)를 points 에 병합한다.

    관측기관 QC(각 포인트의 `qc` 필드, AQC/MQC 기반)는 그대로 두고 `ai_qc` 필드를 추가한다 —
    두 QC 는 서로 다른 근거(기관 검증 vs 통계적 이상치)이므로 프론트에서 구분 표시할 수 있게 병합하지
    않는다. 헤드라인 변수인 파고(wave)를 기준으로 판정한다(KMA/KHOA 공통 필드).
    """
    qc_out = qc_mod.run_qc(result["points"], metric)
    result["points"] = qc_out["points"]
    result["qc_summary"]["ai_spike_count"] = qc_out["summary"]["spike_count"]
    result["qc_summary"]["ai_gap_count"] = qc_out["summary"]["gap_count"]


# ── 공개 진입점 + 캐시 ─────────────────────────────────────────────────────────

def get_timeseries(
    source: str,
    id_: str,
    hours: int = 24,
    range_: Optional[str] = None,
    days: Optional[int] = None,
    metric: str = "wave",
) -> Optional[dict]:
    """시계열 조회. `range_`(24h|7d|30d|1y) 또는 `days`(N) 가 있으면 과거 이력 경로(Fix 2), 둘 다
    없으면 레거시 `hours` 파라미터(≤48h, 기존 동작 그대로 — forecast.py 등 내부호출 호환).

    `metric` 은 AI-QC(`qc.run_qc`)가 어느 지표를 대상으로 스파이크/결측을 판정할지 결정한다
    (기본 "wave", 기존 동작과 동일). 시연 시나리오(`demo_scenario.inject_qc_spikes`)도 이 지표
    기준으로만 큐레이션 지점에 스파이크를 주입한다 — 요청한 metric 이 그 지점의 큐레이션
    metric 과 다르면 아무 일도 일어나지 않는다(원본 그대로).
    """
    days_float, label = _resolve_window(hours, range_, days)
    cache_key = (source, id_, label, metric)
    ttl = _TTL_RECENT if label.endswith("h") else _TTL_HISTORICAL
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get(cache_key)
        if hit and now - hit[0] < ttl:
            return hit[1]

    if source == "KMA":
        result = _kma_timeseries(_strip_kma_prefix(id_), days_float, label)
    elif source == "KHOA":
        result = _khoa_timeseries(id_, days_float, label)
    else:
        return None

    # 시연 시나리오(§13-2) — 큐레이션 지점·metric 한정 스파이크(+선택적 결측 구간) 주입.
    # 게이트 꺼짐/대상 아님이면 무해(원본 그대로). result["id"] 는 소스별 정규화된 station id
    # (KMA_xxx 또는 KHOA obsCode 그대로)라 demo_scenario 의 큐레이션 표 키와 그대로 맞는다.
    result["points"] = demo_scenario.inject_qc_spikes(result["points"], metric, result["id"])

    # §A2 픽스 — 상태 override(지연/미수신) 대상 지점은 시계열도 합성 경과시간만큼 끝을 잘라
    # "지금까지 이어지는 선" ↔ "미수신 배지" 모순을 없앤다(demo_scenario.apply_timeseries_override
    # 독스트링 참고). inject_qc_spikes(스파이크 큐레이션)와 이 override(상태 큐레이션)는 서로 다른
    # 지점 집합이라 겹치지 않는다.
    result["points"] = demo_scenario.apply_timeseries_override(result["points"], result["id"])

    # 위 두 단계(스파이크 주입·시계열 절단)로 points 가 바뀌었을 수 있으므로, 그 전에 원본
    # records 기준으로 미리 집계돼 있던 관측기관 QC 카운트(qc_summary.flagged_count/checked)를
    # 최종 points 기준으로 다시 세어 stale 값이 남지 않게 한다(요청사항: "잘려나간 포인트가
    # stats/qc_summary 에 남지 않게").
    result["qc_summary"]["flagged_count"] = sum(
        1 for p in result["points"] if p.get("qc", {}).get("flagged")
    )
    result["qc_summary"]["checked"] = any(
        p.get("qc", {}).get("checked") for p in result["points"]
    )

    _apply_ai_qc(result, metric=metric)
    result["stats"] = _compute_stats(result["points"])
    result["cadence_min"] = _median_cadence_minutes(result["points"])

    with _CACHE_LOCK:
        _CACHE[cache_key] = (time.time(), result)
    return result
