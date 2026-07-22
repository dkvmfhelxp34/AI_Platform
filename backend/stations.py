"""통합 부이 지점 레지스트리.

KMA(sea_obs 좌표 + list-table 제원)와 KHOA(odcloud 부이 목록)를 병합해 표준 스키마로 반환한다.
**병합은 하지 않는다** — 소스별 태그를 유지한 채 별도 지점으로 나열(PLAN.md §1 지점 통합 전략).

스코프: 부이만(KMA TP B/C, KHOA 해양관측부이 41). 조위관측소·기타 TP(D/L/N/F/J)는 제외.
지점 메타(제원)는 변동이 거의 없으므로 프로세스 캐시(TTL 길게)로 재계산 비용을 줄인다.

**KHOA 41개소 중 실제 관측부이만 남긴다(Wave 3a Fix 1)** — 이름에 "등부표"가 들어간 항법보조시설
(유도등부표 등, 예: YS_0002/YS_0003)은 무조건 제외하고, 라이브 캐시(twRecent)와 관측개시일 메타
(pointDetail.do) **둘 다** 무데이터인 지점(무데이터/폐국)만 등록부에서 뺀다(둘 중 하나만 봐선 안
되는 이유는 `_khoa_stations()` 독스트링의 KG_0028 실측 사례 참고 — twRecent 일시 공백을 무데이터로
오판할 수 있다). 이전에 있던 `_khoa_missing_item()`(무데이터 지점을 "미수신"으로 명시 표출하던
main.py 헬퍼)은 이 등록부 필터링에 따라 폐기됐다 — 이제 **미수신**은 실제 관측부이가 자기 관측주기
대비 늦어진 것만 의미한다(항법보조시설 잡음 아님).

## 센서고(`specs`) 정규화 — 왜 필요한가

KMA list-table(`getBuoyLstTbl`/`getWaveBuoyLstTbl`) 이 주는 `ht_wd`/`ht_ta`/`ht_pa`/`ht_tw`/
`ht_wh` 는 원문이 그대로 쓰기엔 위험하다(실측, 2026-07-15 `getBuoyLstTbl`):

  - `ht_wd`(풍속·풍향계 설치고, m) 를 그대로 필드명 `wd` 로 노출하면 sea_obs 의 `wd`(풍향, °)와
    이름이 겹쳐 프론트가 "풍향 8.34 m" 처럼 오표시한다 — **이 자체가 5인 전문가 리뷰가 지적한
    신뢰도 파괴 사례**. → `wind_sensor_height_m` 처럼 "무엇의 높이인지" 이름에 명시한다.
  - 값이 `"a/b"` 쌍으로 오는데(예: 대형 Discus 10m 부이 `서해170`: `ht_wd="8.34/8.34"`,
    `ht_ta="8.64/8.64"`) 대부분은 이중 센서(1호기/2호기, `kma_buoy2.php` 의 WD1/WD2 와 대응)라
    값이 다를 수 있지만(`울릉도`: `ht_wd="4.4/3.9"`), 같은 부이 여러 곳에서 **완전히 동일한 값이
    중복**돼 그대로 노출하면 "8.34/8.34 m" 처럼 무의미하게 보인다 → 같으면 단일값으로 축약.
  - `ht_tw`(수온계)·`ht_wh`(파고계)는 음수로 온다(해수면 **아래** 설치를 의미) — 부호만 보고는
    "센서고 -1.2 m" 처럼 오해하기 쉽다 → 양수 "깊이"로 뒤집고 `below_surface` 플래그로 명시한다.
  - `-99`/빈값/파싱불가는 결측이지 값이 아니다 → `None`(지어낸 숫자 반환 금지, `kma_marine`
    전역 결측 규약과 동일하게 처리).
"""
from __future__ import annotations

import concurrent.futures
import threading
import time
from typing import Optional

import kma_marine
import khoa_api
import live_cache

_CACHE: dict = {}
_CACHE_LOCK = threading.Lock()
_TTL = 3600  # 1시간 — 지점 제원은 거의 불변, sea_obs 좌표만 갱신될 뿐

_KMA_BUOY_TP = ("B", "C")

# 제원 목록(형식·센서고·영문명) op → 대상 TP
_LIST_OPS_FOR_TP = {
    "B": "getBuoyLstTbl",
    "C": "getWaveBuoyLstTbl",
}


def _rows_for_latest_published_month(op: str, now, max_back: int = 12) -> list[dict]:
    """월보성 제원 API 는 발행 지연이 있어 당월·전월이 비어있을 수 있음 →
    가장 최근 발행된 달을 찾을 때까지 최대 max_back개월 소급."""
    year, month = now.year, now.month
    for _ in range(max_back):
        try:
            rows = kma_marine.fetch_list_table(op, year, month)
        except Exception:
            rows = []
        if rows:
            return rows
        year, month = (year, month - 1) if month > 1 else (year - 1, 12)
    return []


def _parse_dual(raw) -> tuple[Optional[float], Optional[float]]:
    """'a/b' 또는 단일값 문자열 → (대표값, 보조값|None).

    - 두 값이 같으면(부동소수 오차 감안) 이중센서 중복으로 보고 단일값으로 축약한다
      (예: `"8.34/8.34"` → `(8.34, None)` — "8.34/8.34 m" 처럼 중복 노출 금지).
    - 값이 다르면 이중센서(1호기/2호기)로 보고 둘 다 보존한다(예: `"4.4/3.9"` → `(4.4, 3.9)`).
    - `-99`(KMA 결측 센티널)·빈값·파싱불가는 결측으로 버린다(None) — 지어낸 값을 반환하지 않는다.
    """
    if raw is None:
        return None, None
    s = str(raw).strip()
    if not s or s.lower() == "null":
        return None, None
    vals: list[float] = []
    for part in s.split("/"):
        part = part.strip()
        if not part:
            continue
        try:
            v = float(part)
        except ValueError:
            continue
        if abs(v - kma_marine.MISSING) < 1e-6 or v <= -99.0:  # 결측 센티널(-99) — 실측 음수 수심과 구분
            continue
        vals.append(v)
    if not vals:
        return None, None
    if len(vals) == 1:
        return vals[0], None
    a, b = vals[0], vals[1]
    if abs(a - b) < 1e-6:
        return a, None
    return a, b


def _above_surface_spec(raw, label: str) -> dict:
    """해수면 **위** 설치고 필드(풍속·풍향계/기온계/기압계). 값은 부호 그대로(양수) 노출한다."""
    primary, secondary = _parse_dual(raw)
    return {"value_m": primary, "secondary_value_m": secondary, "unit": "m", "label": label}


def _below_surface_spec(raw, label: str) -> dict:
    """해수면 **기준** 설치 위치(수온계 수심·파고계). 원본 부호(-)=해수면 아래를 양수 '깊이' +
    `below_surface` 플래그로 변환한다 — "-1.2 m" 처럼 부호만으로 오해를 부르는 표기를 없앤다."""
    primary, secondary = _parse_dual(raw)
    if primary is None:
        return {"value_m": None, "secondary_value_m": None, "below_surface": None, "unit": "m", "label": label}
    return {
        "value_m": abs(primary),
        "secondary_value_m": abs(secondary) if secondary is not None else None,
        "below_surface": primary < 0,
        "unit": "m",
        "label": label,
    }


_SPEC_LABELS = {
    "wind": "풍속·풍향계 설치고(해수면 기준 높이 — 값은 풍향이 아니라 센서 부착 높이)",
    "air_temp": "기온계 설치고(해수면 기준 높이)",
    "pressure": "기압계 설치고(해수면 기준 높이)",
    "water_temp": "수온계 설치 수심(해수면 아래, below_surface=true 면 수중)",
    "wave": "파고계 설치 위치(해수면 기준, below_surface=true 면 수면 아래)",
}


def _station_specs(spec: dict) -> dict:
    """list-table 원문 `ht_*` → 프론트가 그대로 신뢰해 렌더할 수 있는 정규화 제원."""
    return {
        "wind_sensor_height_m": _above_surface_spec(spec.get("ht_wd"), _SPEC_LABELS["wind"]),
        "air_temp_sensor_height_m": _above_surface_spec(spec.get("ht_ta"), _SPEC_LABELS["air_temp"]),
        "pressure_sensor_height_m": _above_surface_spec(spec.get("ht_pa"), _SPEC_LABELS["pressure"]),
        "water_temp_sensor_depth_m": _below_surface_spec(spec.get("ht_tw"), _SPEC_LABELS["water_temp"]),
        "wave_sensor_height_m": _below_surface_spec(spec.get("ht_wh"), _SPEC_LABELS["wave"]),
    }


def _build_kma_spec_index() -> dict:
    """stn_id(str) → {form, stn_en, ht_*} 제원 인덱스. 실패해도 빈 dict(치명적이지 않음)."""
    now = kma_marine.now_kst()
    idx: dict[str, dict] = {}
    for op in set(_LIST_OPS_FOR_TP.values()):
        rows = _rows_for_latest_published_month(op, now)
        for row in rows:
            stn_id = str(row.get("stn_id"))
            if not stn_id:
                continue
            idx[stn_id] = {
                "form": row.get("form"),
                "name_en": row.get("stn_en"),
                "ht_wd": row.get("ht_wd"),
                "ht_ta": row.get("ht_ta"),
                "ht_pa": row.get("ht_pa"),
                "ht_tw": row.get("ht_tw"),
                "ht_wh": row.get("ht_wh"),
            }
    return idx


def _kma_stations() -> list[dict]:
    """sea_obs(B/C) 좌표 + list-table 제원(form/영문명/센서고) 병합.

    §D2 픽스: `sea_obs` 는 매 10분 슬롯의 단일 관측 스냅샷이라, 어느 한 순간의 `fetch_sea_obs()`
    직접호출만으로 등록부를 지으면 보고주기가 느리거나 간헐적인 지점(실측: 추자도 KMA_22184 등)이
    하필 그 슬롯엔 빠져 있어서 등록부에서 통째로 누락되는 사고가 난다(반대로 `/api/live` 는 그
    지점을 잡고 있는 불일치 — "라이브엔 있는데 상세 제원은 텅 빔"). `live_cache`(백그라운드로
    5분마다 갱신되는 KMA 스냅샷, 직접호출과 별개 타이밍)와 이번 직접호출을 stn_id 기준으로
    합쳐(합집합) 어느 한쪽 호출에만 잠깐 잡힌 지점도 놓치지 않는다(직접호출 값이 있으면 그쪽을
    최신으로 우선). 두 소스 다 sea_obs 원본과 동일 스키마라 병합에 추가 파싱이 필요 없다.
    """
    direct_obs = kma_marine.fetch_sea_obs()
    cached_obs, _cached_at = live_cache.get_kma_snapshot()
    obs_by_stn: dict[str, dict] = {o["stn_id"]: o for o in cached_obs}
    obs_by_stn.update({o["stn_id"]: o for o in direct_obs})  # 직접호출(방금 조회)이 최신이라 우선
    obs = list(obs_by_stn.values())
    spec_idx = _build_kma_spec_index()

    out: list[dict] = []
    seen: set[str] = set()
    for o in obs:
        if o["tp"] not in _KMA_BUOY_TP:
            continue
        stn_id = o["stn_id"]
        if stn_id in seen:
            continue
        seen.add(stn_id)
        spec = spec_idx.get(stn_id, {})
        out.append({
            "source": "KMA",
            "id": o["id"],
            "stn_id": stn_id,
            "tp": o["tp"],
            "tp_label": o["tp_label"],
            "name": o["name"],
            "name_en": spec.get("name_en"),
            "type": "해양기상부이" if o["tp"] == "B" else "파고부이",
            "lon": o["lon"],
            "lat": o["lat"],
            "form": spec.get("form"),
            "specs": _station_specs(spec),
        })
    return out


# 항법보조시설(유도등부표/등부표) — 관측부이가 아니라 위치표시용 등부표라 twRecent 가 관측값을
# 반환하지 않는다(사용자 실측 보고: "여수해만중앙A호유도등부표" 등이 미수신·수신이력없음으로 표출).
# 이름에 "등부표"가 들어가면 제외(예: YS_0002/YS_0003 "여수해만중앙A/C호유도등부표"). 같은 YS_ 접두사여도
# YS_0007 "여수기상관측부이"는 이름에 매칭되지 않아 정상 포함된다(실제 관측부이이므로 정당).
_NAV_AID_NAME_MARKER = "등부표"


def _khoa_stations() -> list[dict]:
    """KHOA 41개소 목록에서 **실제 관측부이만** 남긴다(Wave 3a Fix 1, 사용자 명시 요구사항).

    두 단계로 제외한다:
      1) 이름에 `_NAV_AID_NAME_MARKER`(등부표) 포함 — 항법보조시설(관측부이 아님). 무조건 제외.
      2) 아래 **두 독립 신호가 모두** 무데이터인 지점만 제외한다:
         a) 라이브 캐시(`live_cache`)가 최소 1회 이상 갱신된 뒤에도 그 지점이 한 번도 twRecent 응답에
            잡힌 적 없음 — `get_khoa_snapshot()` 은 한 번 성공하면 이후 실패해도 마지막 값을 계속
            보존하므로(live_cache.py 참고), "지금 스냅샷에 없다" ≈ "이번 프로세스 구동 이후 단 한 번도
            관측값을 반환한 적 없다".
         b) oceangrid `pointDetail.do`(관측개시일 등 정적 메타, twRecent 와 별개 채널)에서도
            관측개시일을 못 얻음.
         **실측 근거**: KG_0028(국가해양관측망 심해부이, 공식 "품질 최적" 6개소 중 하나)이 twRecent 만
         일시적으로 비어 있는 순간이 실측 확인됐다(twRecent 는 None, 그러나 pointDetail 은
         obs_start_date='2012-09-08' 정상 반환) — twRecent 신호 하나만 보면 14년 이력의 정상 관측소를
         일시적 API 공백 때문에 "무데이터"로 오판해 등록부에서 지워버리는 사고가 난다. 두 신호 모두
         무데이터일 때만 제외해 이런 오판을 피한다(그래도 실제 무데이터 항법보조/폐국 지점은 여전히
         걸러짐 — 예: YS_0002/YS_0003 은 이름으로 이미 제외, YS_0007 은 두 신호 다 없어 제외).
    서버 기동 직후(첫 KHOA burst 완료 전, `khoa_at is None`)에는 a)(twRecent 스냅샷)를 통째로 불신하되,
    b)(oceangrid pointDetail 관측개시일)는 twRecent burst 와 무관하게 이 함수 호출마다 동기 조회되므로
    부팅 시에도 그대로 신뢰해 단독 신호로 제외 판정에 쓴다 — 그래야 YS_0007(관측개시일 없음)처럼
    실제 무데이터인 지점이 부팅 후 최대 ~1시간(다음 캐시 갱신 전까지) 등록부·`/api/live`에 유령으로
    끼어드는 사고를 막는다. 다만 pointDetail 자체가 통째로 실패해(메타 0건) 판정 불가능해지면
    안전하게 전부 포함한다(빈 등록부 방지) — 다음 캐시 갱신 때 a)+b) 정상 판정으로 다시 걸러진다.
    """
    buoys = khoa_api.fetch_buoy_list()
    khoa_snap, khoa_at = live_cache.get_khoa_snapshot()
    named_candidates = [b for b in buoys if _NAV_AID_NAME_MARKER not in (b.get("name") or "")]

    # 관측개시일 등 정적 메타(Fix 4 + 위 무데이터 이중신호) — oceangrid pointDetail.do, 지점당 1회
    # POST(장기 캐시) 병렬 조회. twRecent 와 독립된 채널이라 무데이터 판정의 두 번째 신호로도 쓴다.
    details: dict[str, dict] = {}
    if named_candidates:
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as ex:
            futs = {ex.submit(khoa_api.fetch_station_detail, b["id"]): b["id"] for b in named_candidates}
            for fut in concurrent.futures.as_completed(futs):
                details[futs[fut]] = fut.result()

    boot_grace = khoa_at is None
    meta_available = any((details.get(b["id"]) or {}).get("obs_start_date") for b in named_candidates)

    candidates: list[dict] = []
    for b in named_candidates:
        obs_code = b["id"]
        has_live = obs_code in khoa_snap  # 실제 스냅샷 기준(부트 시엔 대체로 false)
        has_obs_start = bool((details.get(obs_code) or {}).get("obs_start_date"))
        if boot_grace:
            # burst 전이라 has_live 를 불신 — obs_start 단독 신호로 판정한다. 단 pointDetail 이
            # 통째로 실패(메타 0건)했으면 판정 불가이므로 전부 포함(빈 등록부 방지).
            if meta_available and not has_obs_start:
                continue
        else:
            if not has_live and not has_obs_start:
                continue  # 두 신호 모두 무데이터 — 실제 무데이터/폐국 지점
        candidates.append(b)

    out: list[dict] = []
    for b in candidates:
        detail = details.get(b["id"]) or {}
        out.append({
            "source": "KHOA",
            "id": b["id"],
            "stn_id": b["obsCode"],
            "tp": b.get("type") or "TW",
            "tp_label": "해양관측부이",
            "name": b.get("name"),
            "name_en": b.get("name_en"),
            "type": "해양관측부이",
            "lon": b.get("lon"),
            "lat": b.get("lat"),
            "form": None,
            "obs_start_date": detail.get("obs_start_date"),  # 관측개시일(비공식 경로 실측, 없으면 None)
            "address": detail.get("address"),  # 관측소 주소(비공식 경로 실측, 없으면 None)
            "obs_type": detail.get("obs_type"),  # 관측유형(비공식 경로 실측, 없으면 None)
            "specs": None,  # KHOA 는 센서고 제원 API 미제공(스코프 제외) — KMA 만 specs 채움
        })
    return out


def get_stations(force: bool = False) -> list[dict]:
    """통합 부이 지점 레지스트리(KMA B/C + KHOA 41). 소스 태그 유지, 병합 없음."""
    now = time.time()
    with _CACHE_LOCK:
        hit = _CACHE.get("stations")
        if not force and hit and now - hit[0] < _TTL:
            return hit[1]

    kma_list = _kma_stations()
    khoa_list = _khoa_stations()
    result = kma_list + khoa_list

    if result:
        with _CACHE_LOCK:
            _CACHE["stations"] = (time.time(), result)
    return result
