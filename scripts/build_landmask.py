"""build_landmask.py — 정밀 해안선 육지 마스크 PNG 빌드 (§26 후속, SST 정밀 클리핑용, 2026-07-18).

## 배경
`/api/field` 의 수온(SST) 격자는 RTOFS 1/12°(≈9km, 265×325, backend/field_service.py 참고)로
성겨서 작은 섬·복잡한 해안선을 표현하지 못해 섬 안쪽까지 SST 색이 번진다(nearest-sea-fill 로
육지 셀까지 값을 연장해두기 때문 — frontend/src/webgl/sstGL.ts 참고). 이 스크립트는 **값과
무관한 정적 해안선 마스크**를 훨씬 높은 경계 해상도(≈500~650m)로 미리 구워, 프론트가 SST 색을
실제 해안선에서 정확히 잘라내게 한다(값 해상도 9km 와 경계 해상도 수백m 를 분리).

## 데이터 소스
GSHHG(Global Self-consistent Hierarchical High-resolution Geography) 2.3.7, full("f") 해상도:
    https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip  (149,157,845 bytes, 실측 확인)
압축 해제 후 `GSHHS_shp/f/GSHHS_f_L1.shp`(+ .shx) 만 사용한다 — L1 = 대륙+섬(육지), 'f' = full
해상도. 호수(L2) 등은 무시(내륙엔 SST 자체가 없으므로 무관). L1 폴리곤은 ESRI 셰이프파일
관례상 외곽 링=시계방향, 홀(호수) 링=반시계방향으로 저장되지만, 이 스크립트의 도메인
(115~142E, 24~46N)과 교차하는 shape 들은 실측 결과 전부 단일 파트(홀 없음)였다 — 그래도 다중
파트가 생기는 경우를 대비해 shoelace 부호로 외곽/홀을 구분해 처리한다(아래 `_rasterize_shape`).

## 환경
`buoy` conda env 에는 shapely/gdal/rasterio/geopandas 가 없다(무거운 GDAL 스택 설치 금지 —
CLAUDE.md 방침). 대신 가벼운 두 패키지만 설치해 쓴다:
    /home/syjin/miniconda3/envs/buoy/bin/pip install pyshp Pillow
- pyshp: 순수 파이썬 .shp 리더(셰이프 bbox 는 레코드 헤더에 이미 있어 194k 개 shape 전수
  bbox 스캔이 <2초 — 실측).
- Pillow: C 가속 폴리곤 래스터화(ImageDraw.polygon) + PNG 인코딩.

## 실행법
    /home/syjin/miniconda3/envs/buoy/bin/python scripts/build_landmask.py \
        --gshhg-shp /path/to/GSHHS_f_L1.shp
GSHHG 원본(149MB, .shp 만 161MB)은 저장소에 커밋하지 않는다 — 스크래치에 받아 쓴다. `--gshhg-shp`
생략 시 `$GSHHG_SHP` 환경변수 또는 스크립트 하단 기본 경로를 시도한다.

## 산출물
- `frontend/public/landmask.png` — 그레이스케일(mode 'L') 육지-비율(0~255, 0=완전 바다,
  255=완전 육지) 래스터. Vite 가 `dist/` 로 그대로 정적 번들 → 브라우저가 1회만 받고 캐시.
- `frontend/public/landmask.json` — 메타(bounds·width·height·rowDir 등). 프론트가 이 값을
  하드코딩하지 않고 읽어 쓴다(frontend/src/webgl/sstGL.ts 의 `loadLandMask()`).

## 행 방향 규약(★ 중요 — 프론트 샘플링과 반드시 일치해야 함)
PNG 는 **사람이 열어서 바로 확인 가능하게 북쪽-위(row 0 = lat_max)** 로 저장한다(일반적인
이미지 관례 — 표준 뷰어에서 한반도가 똑바로 보인다). 이는 `/api/field` 의 "행 0 = 최남단"
격자 규약(backend/field_service.py, frontend/src/webgl/fieldCommon.ts)과 **정반대**다 —
그쪽은 GPU 텍스처 업로드 버퍼 규약이라 사람이 볼 일이 없어 남쪽-위가 자연스럽지만, 이 마스크는
빌드 결과를 육안 검증(작은 섬이 실제로 뚫렸는지 등)하는 게 중요해 북쪽-위를 택했다. 프론트
(sstGL.ts)는 landmask.json 의 `"rowDir": "north-first"` 를 읽어 셰이더의 v 좌표를 뒤집어
샘플링한다(`v = 1 - (lat-lat_min)/(lat_max-lat_min)`) — SST 텍스처(행0=남쪽) 와는 별개의
독립적인 텍스처/좌표계이므로 이 반전이 다른 필드 렌더링에 영향을 주지 않는다.

## 재생성 조건
GSHHG 좌표계·도메인([115,24,142,46], backend/field_service.py LON_MIN/MAX·LAT_MIN/MAX)이 바뀌거나,
해상도(TARGET_PIXEL_BUDGET)를 조정하고 싶을 때만 재실행하면 된다 — 해안선은 정적이라 그 외에는
재실행 불필요.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

try:
    import shapefile  # pyshp
except ImportError:
    sys.exit("pyshp 가 없다: /home/syjin/miniconda3/envs/buoy/bin/pip install pyshp Pillow")
try:
    from PIL import Image, ImageDraw, ImageFilter
except ImportError:
    sys.exit("Pillow 가 없다: /home/syjin/miniconda3/envs/buoy/bin/pip install pyshp Pillow")

# ── 도메인(backend/field_service.py LON_MIN/LON_MAX/LAT_MIN/LAT_MAX 와 정확히 일치시킨다) ──────
LON_MIN, LON_MAX = 115.0, 142.0
LAT_MIN, LAT_MAX = 24.0, 46.0

# ── 해상도 예산 ────────────────────────────────────────────────────────────────────────────────
# 목표: GPU R8 텍스처 20MB 이하(폭*높이 바이트) + 물리 해상도 약 500~800m. 도메인 종횡비(27°:22°)를
# 유지한 채(경도·위도 스텝을 거의 동일하게) 픽셀 예산으로부터 폭·높이를 역산한다.
TARGET_PIXEL_BUDGET = 19_000_000  # width*height 상한(바이트=텍셀수, R8 1바이트/텍셀) — 20MB 여유
SUPERSAMPLE = 4  # 안티에일리어싱 — 이 배율로 그린 뒤 BOX 필터로 다운샘플(계단 방지)

# ── 소형 도서 안전 여유(dilation) ────────────────────────────────────────────────────────────
# 실측(2026-07-18): GSHHG 정밀 좌표 기준 독도(두 섬 중 서도, shape idx 97235)의 가장 가까운
# 정점이 통상 반올림 인용좌표 (37.24, 131.87) 로부터 726.5m 떨어져 있다(다른 소스는 37.2417/
# 37.239 등 조금씩 다른 값을 쓰고, GSHHG 실측 해안선은 그보다 더 북쪽) — 즉 좌표 인용 관례 차이가
# 우리 격자 한 칸(~510~623m)보다 크다. 이를 흡수하기 위해 슈퍼샘플 마스크에 작은 최대값(MaxFilter)
# 팽창을 적용한다 — 사용자 지시("육지 쪽으로 보수적 — 번짐보다 못 그리는 쪽이 안전")와 정확히
# 같은 방향(바다를 살짝 더 가려서라도 육지 인용좌표 오차를 흡수)이라 설계 원칙과 상충하지 않는다.
# 커널은 정사각형(체비셰프 거리)이라 대각선 방향은 더 멀리 닿는다(반경*√2) — 독도처럼 대각선
# 오프셋인 경우에 유리. 반경을 크게 잡으면 다도해의 좁은 수로가 막힐 위험이 커지므로, 남해
# 다도해 확대 스크린샷으로 반드시 육안 재확인한다(§26 후속 검증 항목).
DILATE_KERNEL_SS_PX = 13  # 슈퍼샘플 픽셀 기준 정사각커널 한변(반경 6px ≈ 846m — 위 726.5m + 여유)


def _load_domain_shapes(shp_path: Path) -> list[dict]:
    """GSHHS_f_L1.shp 전수 스캔(bbox 는 레코드 헤더에 있어 빠름, 실측 179,837 shape <2초) 후
    도메인 bbox 와 교차하는 shape 만 (points, parts) 그대로 반환한다. 교차 판정만으로 충분한
    이유: 부분적으로 걸치는 폴리곤이라도 원본 점을 그대로 전달하면 Pillow 가 캔버스 밖 좌표는
    자연히 그리지 않으므로(암묵적 클리핑) 별도 폴리곤 클리핑 알고리즘이 필요 없다."""
    sf = shapefile.Reader(shp=str(shp_path), shx=str(shp_path.with_suffix(".shx")))
    dom = (LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)

    def intersects(bbox) -> bool:
        return not (bbox[2] < dom[0] or bbox[0] > dom[2] or bbox[3] < dom[1] or bbox[1] > dom[3])

    hits = []
    n_scanned = 0
    for shaperec in sf.iterShapes():
        n_scanned += 1
        bbox = shaperec.bbox
        if bbox and intersects(bbox):
            hits.append({"points": shaperec.points, "parts": list(shaperec.parts)})
    print(f"[gshhg] scanned {n_scanned} shapes total, {len(hits)} intersect domain "
          f"{dom}, {sum(len(h['points']) for h in hits)} points total")
    return hits


def _ring_signed_area(ring: list[tuple[float, float]]) -> float:
    """Shoelace 부호 있는 면적(원본 lon/lat 공간에서 계산 — 픽셀 변환 후 y 축이 북=0 방향으로
    뒤집히면 부호가 반전되므로 반드시 지리좌표에서 계산). ESRI 폴리곤 관례: 외곽 링은 시계
    방향(부호<0, x 는 lon 증가=동쪽, y 는 lat 증가=북쪽인 표준 우수좌표계 기준), 홀(호수)은
    반시계 방향(부호>0)."""
    area = 0.0
    n = len(ring)
    for i in range(n):
        x0, y0 = ring[i]
        x1, y1 = ring[(i + 1) % n]
        area += x0 * y1 - x1 * y0
    return area * 0.5


def _rasterize_shapes(hits: list[dict], canvas_w: int, canvas_h: int) -> "Image.Image":
    """모든 도메인-교차 shape 를 슈퍼샘플 캔버스(canvas_w × canvas_h)에 그린다. 외곽 링=255(육지),
    홀 링=0(바다로 되돌림) — signed area 부호로 판정(위 _ring_signed_area). 좌표 변환은 북쪽-위
    이미지 관례(행 0 = lat_max)로 고정한다(모듈 독스트링 "행 방향 규약" 참고)."""
    img = Image.new("L", (canvas_w, canvas_h), 0)
    draw = ImageDraw.Draw(img)
    lon_span = LON_MAX - LON_MIN
    lat_span = LAT_MAX - LAT_MIN

    def to_px(pt: tuple[float, float]) -> tuple[float, float]:
        lon, lat = pt
        px = (lon - LON_MIN) / lon_span * canvas_w
        py = (LAT_MAX - lat) / lat_span * canvas_h  # 북쪽-위: lat=lat_max → py=0(캔버스 상단)
        return (px, py)

    n_outer = n_hole = 0
    for shp in hits:
        pts = shp["points"]
        parts = shp["parts"] + [len(pts)]
        for k in range(len(parts) - 1):
            ring = pts[parts[k]:parts[k + 1]]
            if len(ring) < 3:
                continue
            signed = _ring_signed_area(ring)
            fill = 255 if signed < 0 else 0
            if fill == 255:
                n_outer += 1
            else:
                n_hole += 1
            ring_px = [to_px(p) for p in ring]
            draw.polygon(ring_px, fill=fill)
    print(f"[raster] drew {n_outer} outer ring(s), {n_hole} hole ring(s) "
          f"onto {canvas_w}x{canvas_h} supersample canvas")
    return img


def _self_check(mask_arr: np.ndarray, out_w: int, out_h: int) -> None:
    """빌드 직후 자체 좌표 점검(육안·프론트 검증 전 1차 방어선) — row0=북쪽 규약으로 샘플링."""
    def sample(lat: float, lon: float) -> int:
        col = round((lon - LON_MIN) / (LON_MAX - LON_MIN) * (out_w - 1))
        row = round((LAT_MAX - lat) / (LAT_MAX - LAT_MIN) * (out_h - 1))  # north-first
        row = min(max(row, 0), out_h - 1)
        col = min(max(col, 0), out_w - 1)
        return int(mask_arr[row, col])

    land_pts = [("대전", 36.30, 127.40), ("서울", 37.55, 126.98), ("마라도", 33.12, 126.27),
                ("가거도", 34.07, 125.12), ("울릉도", 37.48, 130.90), ("독도", 37.24, 131.87),
                ("나고야", 35.18, 136.90)]
    sea_pts = [("황해", 35.0, 124.0), ("동해", 38.0, 132.0), ("제주남해", 33.0, 126.5),
               ("이어도부근", 32.0, 125.5)]
    print("\n[self-check] land-coverage 0~255 (land pts should be high, sea pts should be ~0)")
    for name, lat, lon in land_pts:
        print(f"  [육지] {name:6s} ({lat},{lon}) coverage={sample(lat, lon)}")
    for name, lat, lon in sea_pts:
        print(f"  [바다] {name:6s} ({lat},{lon}) coverage={sample(lat, lon)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--gshhg-shp", default=os.environ.get("GSHHG_SHP", ""),
                     help="GSHHS_f_L1.shp 경로(같은 폴더에 .shx 필요)")
    ap.add_argument("--out-dir", default=str(Path(__file__).resolve().parent.parent / "frontend" / "public"))
    args = ap.parse_args()

    shp_path = Path(args.gshhg_shp) if args.gshhg_shp else None
    if not shp_path or not shp_path.exists():
        sys.exit(f"--gshhg-shp 경로가 없다: {shp_path} (GSHHG_f_L1.shp 를 먼저 받아야 한다 — 모듈 독스트링 '실행법' 참고)")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── 출력 해상도 역산(도메인 종횡비 유지) ──────────────────────────────────────────────────
    aspect = (LON_MAX - LON_MIN) / (LAT_MAX - LAT_MIN)  # 27/22
    out_h = round((TARGET_PIXEL_BUDGET / aspect) ** 0.5)
    out_w = round(out_h * aspect)
    step_lon = (LON_MAX - LON_MIN) / (out_w - 1)
    step_lat = (LAT_MAX - LAT_MIN) / (out_h - 1)
    mid_lat = (LAT_MIN + LAT_MAX) / 2
    res_m_lat = step_lat * 111_320
    res_m_lon = step_lon * 111_320 * np.cos(np.radians(mid_lat))
    print(f"[dims] out={out_w}x{out_h}  step=({step_lon:.5f},{step_lat:.5f})deg  "
          f"~res=({res_m_lon:.0f}m lon, {res_m_lat:.0f}m lat) @ mid-lat {mid_lat}")
    print(f"[dims] R8 GPU budget = {out_w*out_h} bytes = {out_w*out_h/1024/1024:.2f} MB")

    t0 = time.time()
    hits = _load_domain_shapes(shp_path)
    print(f"[time] shape scan: {time.time()-t0:.1f}s")

    t0 = time.time()
    ss_img = _rasterize_shapes(hits, out_w * SUPERSAMPLE, out_h * SUPERSAMPLE)
    print(f"[time] rasterize: {time.time()-t0:.1f}s")

    t0 = time.time()
    ss_px_m = (res_m_lon + res_m_lat) / 2 / SUPERSAMPLE
    dilate_radius_m = (DILATE_KERNEL_SS_PX - 1) / 2 * ss_px_m
    ss_img = ss_img.filter(ImageFilter.MaxFilter(DILATE_KERNEL_SS_PX))
    print(f"[time] dilate (kernel={DILATE_KERNEL_SS_PX}ss-px, ~{dilate_radius_m:.0f}m radius): "
          f"{time.time()-t0:.1f}s")

    t0 = time.time()
    # BOX 필터 다운샘플 = 정확한 블록평균(계단 방지 안티에일리어싱) — Pillow C 구현.
    final_img = ss_img.resize((out_w, out_h), Image.BOX)
    print(f"[time] downsample: {time.time()-t0:.1f}s")

    mask_arr = np.asarray(final_img, dtype=np.uint8)
    assert mask_arr.shape == (out_h, out_w)
    land_frac = (mask_arr > 127).mean()
    print(f"[stats] land pixel fraction (>127) = {land_frac:.3%}")

    _self_check(mask_arr, out_w, out_h)

    png_path = out_dir / "landmask.png"
    t0 = time.time()
    final_img.save(png_path, optimize=True)
    print(f"[time] PNG encode: {time.time()-t0:.1f}s")
    png_bytes = png_path.stat().st_size
    print(f"[output] {png_path}  {png_bytes} bytes = {png_bytes/1024:.1f} KB")

    meta = {
        "bounds": [LON_MIN, LAT_MIN, LON_MAX, LAT_MAX],
        "width": out_w,
        "height": out_h,
        "rowDir": "north-first",  # row 0 = lat_max(북) — /api/field 격자(행0=남)와 반대. 모듈 독스트링 참고.
        "resolutionDeg": {"lon": round(step_lon, 6), "lat": round(step_lat, 6)},
        "resolutionMeters": {"lon": round(res_m_lon, 1), "lat": round(res_m_lat, 1)},
        "supersample": SUPERSAMPLE,
        "source": "GSHHG 2.3.7 GSHHS_f_L1 (full resolution land polygons, "
                   "https://www.soest.hawaii.edu/pwessel/gshhg/gshhg-shp-2.3.7.zip)",
        "valueUnit": "land coverage 0-255 (0=open sea, 255=fully land, antialiased via box-downsample)",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
    }
    json_path = out_dir / "landmask.json"
    json_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[output] {json_path}")
    print("\n[done]")


if __name__ == "__main__":
    main()
