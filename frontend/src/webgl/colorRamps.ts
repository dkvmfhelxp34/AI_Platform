/**
 * colorRamps — single source of truth for the field-overlay color identity (§26 바람장·수온장).
 * 이식: Storm_Platform frontend/src/webgl/colorRamps.ts — windColor/mercatorY(invMercatorY)/
 * buildWindLUT 는 그대로 가져오되, 이 플랫폼엔 기압장이 없으므로 pressureColor 계통은 이식하지
 * 않는다(CLAUDE.md §26 — "기압장·타임라인·태풍눈·아카이브는 미이식"). 대신 수온장(SST) 램프를
 * 새로 추가한다 — GPU LUT 텍스처가 아니라 sstGL.ts 가 CPU 에서 셀별 RGBA 를 미리 구워 텍스처에
 * 올리므로(육지 셀은 알파 0), 여기서는 순수 색 계산 함수만 제공한다.
 */

// ── Wind color ramp: speed(m/s) → RGB, saturating at 32 m/s ──────────────────
export function windColor(spd: number): [number, number, number] {
  const t = Math.min(1, spd / 32)
  const stops: [number, number[]][] = [
    [0.0, [40, 80, 220]],
    [0.25, [30, 180, 230]],
    [0.5, [60, 220, 80]],
    [0.75, [250, 180, 20]],
    [1.0, [230, 40, 40]],
  ]
  for (let k = 0; k < stops.length - 1; k++) {
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1]
    if (t <= t1) {
      const a = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * a, c0[1] + (c1[1] - c0[1]) * a, c0[2] + (c1[2] - c0[2]) * a]
    }
  }
  return [220, 60, 60]
}

// LUT 도메인 — 셰이더는 물리값을 [0,1] 로 사상한 뒤 LUT 를 샘플한다.
export const WIND_SPEED_MAX = 32 // windColor 가 여기서 포화

/** 256×1 RGBA8 LUT of the wind ramp, indexed by t = spd/WIND_SPEED_MAX ∈ [0,1]. */
export function buildWindLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const spd = (i / 255) * WIND_SPEED_MAX
    const [r, g, b] = windColor(spd)
    lut[i * 4] = Math.round(r)
    lut[i * 4 + 1] = Math.round(g)
    lut[i * 4 + 2] = Math.round(b)
    lut[i * 4 + 3] = 255
  }
  return lut
}

// ── Wind TRAIL color (on-map particle draw only — §26 후속지시 #2, 2026-07-16) ──────────────────
// 문제: windColor() 램프(청→시안→녹→주황→적)가 sstColor() 램프(청→틸→녹→금→적)와 색상각이
// 거의 겹쳐, 수온장 위에서 파티클이 배경에 "카무플라주"됐다(사용자 피드백). 범례(FieldLegendRow)는
// 여전히 windColor() 원본(속도→색 의미)을 그대로 쓰되, 지도 위 실제 트레일만 이 함수로 흰색 쪽에
// 강하게 mix 해 배경 색상과 무관하게 루미넌스로 튀도록 만든다(윈디 등 실사례의 "흰 바람 실" 관례).
const WIND_TRAIL_WHITE_MIX = 0.62
export function windTrailColor(spd: number): [number, number, number] {
  const [r, g, b] = windColor(spd)
  return [
    r + (255 - r) * WIND_TRAIL_WHITE_MIX,
    g + (255 - g) * WIND_TRAIL_WHITE_MIX,
    b + (255 - b) * WIND_TRAIL_WHITE_MIX,
  ]
}

/** 256×1 RGBA8 LUT of the (whitened) wind TRAIL ramp — u_lut for the on-map particle draw pass. */
export function buildWindTrailLUT(): Uint8Array {
  const lut = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const spd = (i / 255) * WIND_SPEED_MAX
    const [r, g, b] = windTrailColor(spd)
    lut[i * 4] = Math.round(r)
    lut[i * 4 + 1] = Math.round(g)
    lut[i * 4 + 2] = Math.round(b)
    lut[i * 4 + 3] = 255
  }
  return lut
}

// ── SST color ramp: 표층수온(℃) → RGB — 한반도 주변 해역 실측 범위(대략 14~34℃, CLAUDE.md §26)를
// 커버하는 저채도 시퀀셜 스케일(한랭=청록 → 온난=주황/적색). 다크 UI 위에서 튀지 않도록 채도를
// windColor 대비 한 단 낮췄다(필드는 "배경"이어야 한다는 §26 원칙).
export function sstColor(tempC: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (tempC - SST_MIN) / (SST_MAX - SST_MIN)))
  const stops: [number, number[]][] = [
    [0.0, [40, 70, 150]],
    [0.25, [45, 130, 175]],
    [0.5, [80, 175, 130]],
    [0.75, [220, 175, 60]],
    [1.0, [205, 75, 55]],
  ]
  for (let k = 0; k < stops.length - 1; k++) {
    const [t0, c0] = stops[k], [t1, c1] = stops[k + 1]
    if (t <= t1) {
      const a = (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * a, c0[1] + (c1[1] - c0[1]) * a, c0[2] + (c1[2] - c0[2]) * a]
    }
  }
  return stops[stops.length - 1][1] as [number, number, number]
}

export const SST_MIN = 14
export const SST_MAX = 34

// ── Web-Mercator latitude helpers (shared JS ↔ GLSL) ─────────────────────────
// Raw mercator Y (natural-log form, range ±π at ±85°). Used to normalise the
// field domain so vertical spacing matches MapLibre's projection exactly.
export function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * Math.PI) / 360))
}
export function invMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI)
}
