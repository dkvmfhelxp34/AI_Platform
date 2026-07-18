/**
 * SstGL — 수온장(SST) 스칼라 래스터 오버레이(§26, 신규 — Storm_Platform 에는 없던 필드라
 * pressureGL.ts 를 베이스로 삼지 않고 새로 작성했다. windGL.ts 와 같은 glUtils/fieldCommon
 * 저수준 헬퍼를 공유해 일관된 렌더링 계약을 따른다).
 *
 * 렌더 방식: CPU 에서 셀별 색을 한 번만 구워(sstColor LUT) RGBA8 텍스처에 프리멀티플라이드
 * 알파로 올린 뒤(육지 셀 alpha=0), 도메인 사각형 4-corner 쿼드 하나를 그린다. 쿼드 내부의
 * 프래그먼트 셰이더가 화면좌표 → (px,py) → 정확한 경위도(posToLonLat, 메르카토르 역변환 포함)
 * → 격자 row/col(posToGrid) 순으로 **매 프래그먼트마다 정확히** 역투영하므로, 4-corner
 * bilinear 근사가 위도 방향으로 뒤틀리는 문제가 없다(§26 z-index/줌 정합 요구사항 — 자세한
 * 유도는 fieldCommon.ts 헤더 주석 참고). 정적 1프레임이라 애니메이션 rAF 루프는 두지 않고
 * 지도 'move' 이벤트에서만 재투영(rAF 코얼레싱)한다.
 *
 * ⚠️ 해안선 육지-비침 조사(2026-07-16) 결론: `posToLonLat`/`posToGrid`/`computeDomainMatrix` 좌표
 * 수학은 GPU 실측(진단 셰이더로 계산된 row/col을 map.unproject() analytic 값과 다수 지점·다수
 * 줌·DPR 1/2 에서 교차검증) 결과 **전 구간 정확**했다 — "화면 중앙에서 멀어질수록 어긋난다"는
 * 가설은 기각됨. 실제 결함은 해안선 근접 셀에서의 LINEAR 필터 대칭 블렌딩(육지 비침)뿐이었다.
 *
 * ⚠️ 육지-비침 1차 수정(같은 날) 후속 피드백: NEAREST "가장 가까운 셀" 이진 게이트는 비침을
 * 완전히 막았지만, 격자 셀(0.25°≈28km) 그대로 사각 계단 해안선을 만들었다(사용자: "계단식 너무
 * 심한데"). 2차 수정(아래 구현) — 하드 이진 NEAREST 게이트를 **연속값 게이트**로 교체:
 *   1) `computeSeaFrac()` — 원본 격자에서 텐트(선형감쇠) 커널로 "이 셀이 얼마나 바다에 둘러싸여
 *      있는지"를 [0,1] 연속값으로 계산. 커널 반경 내 전부 육지면 항상 정확히 0(깊은 내륙은 100%
 *      안전), 전부 바다면 항상 정확히 1.
 *   2) `upsampleBilinear()` — 이 연속장을 CPU 에서 MASK_UPSAMPLE 배 업샘플해 격자 눈금보다 훨씬
 *      촘촘한 텍스처로 굽는다(사각 계단이 아니라 곡선 경계를 얻기 위함 — GPU LINEAR 필터 자체는
 *      어디서든 연속이라 계단이 안 생기지만, 원본 해상도만으로는 셀당 "쌍선형 다이아몬드" 모양이라
 *      업샘플로 더 자연스러운 곡선을 만든다).
 *   3) 프래그먼트 셰이더에서 `smoothstep(SEA_GATE_LO, SEA_GATE_HI, seaFrac)` 로 게이트 — 임계
 *      구간을 중앙(0.5)이 아니라 바다 쪽으로 밀어(LO=0.5) "커널의 절반 이상이 육지"면 무조건 0 —
 *      매끈함보다 육지 비침 0 을 우선한다(사용자 명시 요구).
 *
 * ⚠️ 3차 수정(2026-07-18, §26 후속) — 정밀 해안선 마스크(landmask) 도입: RTOFS 자체는 9km 격자라
 * 값 해상도와 경계 해상도가 같이 성겨서 마라도·가거도·독도 같은 작은 섬을 표현하지 못한다(격자
 * 셀 하나가 섬보다 큼). `scripts/build_landmask.py` 가 GSHHG 2.3.7 정밀 해안선(수백m 해상도)으로
 * **정적** 육지-비율 PNG(`frontend/public/landmask.png` + 메타 `landmask.json`)를 한 번 빌드해두고,
 * 이 파일이 페이지 로드시 1회만 fetch·디코드된다(`loadLandMaskOnce()` — 모듈 스코프 캐시라
 * SstGL 인스턴스가 재생성돼도 재요청하지 않는다). 이제 **정밀 landmask 가 주(主) 게이트**이고,
 * 위 `computeSeaFrac`/`SEA_GATE_*`(RTOFS 자체 결측 기반)는 RTOFS 의 드문 "열린바다인데 결측"
 * 케이스만 잡아내는 **보조** 게이트로 완화했다(임계값을 낮춰 코스트라인 근처에서는 정밀 마스크가
 * 이미 처리하므로 개입하지 않게). 두 게이트는 곱으로 합성한다(`gl_FragColor = baseColor *
 * preciseGate * rtofsGate`). landmask 는 SST 와 동일 도메인([115,142]x[24,46])이라 별도 uniform
 * bounds 없이 기존 `u_lonlat`/`posToLonLat` 결과를 그대로 재사용해 샘플링한다.
 */
import type maplibregl from 'maplibre-gl'
import {
  type AnyGL, type Caps,
  createProgram, getLocations, createTexture, updateTexture, computeDomainMatrix,
} from './glUtils'
import { sstColor, mercatorY } from './colorRamps'
import { GLSL_FIELD_COMMON, boundsFromArray } from './fieldCommon'

export interface SstFieldData {
  bounds: readonly [number, number, number, number] // [west, south, east, north]
  rows: number
  cols: number
  data: (number | null)[][]
}

// §26 — 배경 필드 원칙: 완전 불투명이 아니라 기반 지도가 은은히 비치는 정도로(마커·지형 가독성 우선).
const CELL_ALPHA = 205

// ── 해안선 게이트 튜닝 상수(§26 2026-07-16 2차 수정) ──────────────────────────────────────────
// 텐트 커널 반경(격자 셀 단위, 0.25°≈28km). 반경 내 전부 육지 → seaFrac=0 정확(깊은 내륙 안전),
// 전부 바다 → seaFrac=1 정확. 2.0 이면 최대 ~56km 범위에서 "바다 비율"을 부드럽게 측정한다.
const SEA_KERNEL_RADIUS = 2.0
// CPU 업샘플 배율 — 89×109 원본 → (rows-1)*UP+1 × (cols-1)*UP+1 로 굽는다(6배 ≈ 62만 셀, 저비용).
const MASK_UPSAMPLE = 6
// smoothstep 임계 구간(2026-07-18 3차 수정으로 완화) — 정밀 landmask 가 주 게이트를 맡게 되면서
// 이 RTOFS 자체 게이트는 "해안선 모양"을 더 이상 책임지지 않는다(그건 이제 landmask 몫). 코스트라인
// 근처는 어차피 landmask 가 이미 가려주므로, 여기서는 RTOFS 의 드문 "열린바다인데 결측" 케이스만
// 보조로 잡아내도록 임계를 크게 낮췄다(LO=0.02 — 커널 반경 내 98%+ 가 결측일 때만 개입).
const SEA_GATE_LO = 0.02
const SEA_GATE_HI = 0.12

// ── 정밀 landmask 게이트(§26 2026-07-18 3차 수정, 주 게이트) ─────────────────────────────────
// landCoverage(0~255, scripts/build_landmask.py 산출) → seaCoverage=1-landCoverage/255 에 대한
// smoothstep 임계. 마스크 자체가 이미 안티에일리어싱(4배 슈퍼샘플+박스 다운샘플)된 연속값이라
// RTOFS 게이트만큼 넓은 구간이 필요 없지만, "육지 쪽으로 보수적"(사용자 지시) 편향을 유지하려고
// 중앙(0.5)보다 살짝 높게 잡았다 — LO=0.45 미만은 무조건 가리고(반반이면 육지 취급), HI=0.75 에서
// 완전히 열린다.
const PRECISE_GATE_LO = 0.45
const PRECISE_GATE_HI = 0.75

const VERT = `
precision highp float;
attribute vec2 a_pv;   // domain-normalised (px,py) at the 4 quad corners — computeDomainMatrix 의
                       // 파라미터화를 그대로 따른다(px=0→lon_min, py=0→lat_max).
varying vec2 v_pxpy;
uniform mat3 u_matrix;
void main(){
  v_pxpy = a_pv;
  vec3 clip = u_matrix * vec3(a_pv, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
}
`

const FRAG = `
${GLSL_FIELD_COMMON}
varying vec2 v_pxpy;
uniform sampler2D u_tex;      // LINEAR — 원본 해상도 색(alpha: 바다=CELL_ALPHA, 육지=0)
uniform sampler2D u_texMask;  // LINEAR — 업샘플된 연속 seaFrac 필드(RTOFS 자체 결측 기반, 보조 게이트)
uniform sampler2D u_texPrecise; // LINEAR — GSHHG 정밀 육지-비율(landmask.png, 주 게이트)
uniform float u_maskReady;    // landmask 비동기 로드 완료 전(0)에는 주 게이트를 우회(1이면 정상 적용)
void main(){
  vec2 ll = posToLonLat(v_pxpy);
  vec2 g = posToGrid(v_pxpy, ll.y);
  vec2 uv = (g + 0.5) / u_gridSize;
  vec4 baseColor = texture2D(u_tex, uv);
  // uvMask — 원본 격자의 "노드 대 노드" 정규화 좌표(0..1, 코너 정렬). 업샘플 텍스처가 동일 도메인을
  // 더 촘촘히 담고 있을 뿐이라 별도 유니폼(업샘플 해상도) 없이 그대로 재사용 가능.
  vec2 uvMask = g / max(u_gridSize - 1.0, vec2(1.0));
  float seaFrac = texture2D(u_texMask, uvMask).a;
  float rtofsGate = smoothstep(${SEA_GATE_LO.toFixed(3)}, ${SEA_GATE_HI.toFixed(3)}, seaFrac);
  // landmask 는 SST 와 동일 도메인(bounds)이라 u_lonlat 로 이미 복원한 ll 을 그대로 정규화해 쓴다.
  // v 축만 반전: landmask.png 는 사람이 보기 편하게 북쪽-위(row0=lat_max)로 저장했지만(빌드 스크립트
  // 주석 참고), 이 프로젝트의 텍스처 업로드 관례는 버퍼 row0=v0 이므로 남쪽-위인 SST/바람 텍스처와
  // v 방향이 반대다 — 여기서만 뒤집어 보정한다.
  float normLon = (ll.x - u_lonlat.x) / (u_lonlat.y - u_lonlat.x);
  float normLat = (ll.y - u_lonlat.z) / (u_lonlat.w - u_lonlat.z);
  vec2 uvPrecise = vec2(normLon, 1.0 - normLat);
  float landCoverage = texture2D(u_texPrecise, uvPrecise).r;
  float preciseGate = smoothstep(${PRECISE_GATE_LO.toFixed(3)}, ${PRECISE_GATE_HI.toFixed(3)}, 1.0 - landCoverage);
  preciseGate = mix(1.0, preciseGate, u_maskReady); // 로드 전에는 무영향(1.0) — RTOFS 게이트만 적용
  gl_FragColor = baseColor * preciseGate * rtofsGate;
}
`

/** 원본 격자에서 셀별 "바다 비율"(텐트 커널 가중 평균, [0,1])을 계산 — 반경 내 전부 육지/바다면
 *  각각 정확히 0/1(깊은 내륙·먼바다는 커널 반경과 무관하게 항상 안전). */
function computeSeaFrac(
  data: (number | null)[][], rows: number, cols: number, radius: number,
): Float32Array {
  const isLand = (i: number, j: number): boolean => {
    const v = data[i][j]
    return v == null || !isFinite(v)
  }
  const out = new Float32Array(rows * cols)
  const R = Math.ceil(radius)
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let wsum = 0, vsum = 0
      for (let di = -R; di <= R; di++) {
        const ii = i + di
        if (ii < 0 || ii >= rows) continue
        for (let dj = -R; dj <= R; dj++) {
          const jj = j + dj
          if (jj < 0 || jj >= cols) continue
          const d = Math.sqrt(di * di + dj * dj)
          if (d > radius) continue
          const w = 1 - d / radius // 텐트(선형감쇠) 커널 — 중심 가중치 최대
          if (w <= 0) continue
          wsum += w
          if (!isLand(ii, jj)) vsum += w
        }
      }
      out[i * cols + j] = wsum > 0 ? vsum / wsum : 0
    }
  }
  return out
}

// ── 정밀 landmask 로드(§26 2026-07-18 3차 수정) ───────────────────────────────────────────────
// scripts/build_landmask.py 산출물(frontend/public/landmask.{png,json}, Vite 가 dist 로 그대로
// 정적 번들)을 페이지 세션당 **1회만** fetch+디코드한다 — 모듈 스코프 프라미스 캐시라 SstGL
// 인스턴스가 토글 on/off·GL 컨텍스트 유실로 재생성돼도 재요청하지 않는다(각 인스턴스는 캐시된
// 픽셀 바이트를 자신의 GL 컨텍스트에 업로드만 새로 한다 — WebGL 텍스처는 컨텍스트별이라 이 업로드
// 자체는 피할 수 없지만 네트워크·PNG 디코드는 공유한다).
export interface LandMaskMeta {
  bounds: readonly [number, number, number, number] // [west, south, east, north] — SST 와 동일 도메인
  width: number
  height: number
  rowDir: string // "north-first" 기대(빌드 스크립트 규약) — 다르면 아래 로더가 uv 반전을 재검토해야 함
}
interface LandMaskData { meta: LandMaskMeta; gray: Uint8Array }

let _landMaskPromise: Promise<LandMaskData | null> | null = null

/** createImageBitmap 디코드 1회 시도 — 실패(예외) 또는 치수 0(디코드가 조용히 퇴화한 경우, 새
 *  WebGL 컨텍스트 생성과 동시에 디코드가 몰릴 때 관측됨)면 null 반환해 재시도 대상임을 알린다. */
async function decodeLandMaskOnce(pngBlob: Blob, meta: LandMaskMeta): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(pngBlob)
  const w = bitmap.width, h = bitmap.height
  if (w === 0 || h === 0) { bitmap.close?.(); return null }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  const { data } = ctx.getImageData(0, 0, w, h) // RGBA, row0=top(PNG row0)
  bitmap.close?.()
  if (w !== meta.width || h !== meta.height) {
    console.warn('[sstGL] landmask.png 실제 치수가 landmask.json 메타와 다름 — 재빌드 필요',
      { pngW: w, pngH: h, meta })
    return null // 치수가 안 맞는 채로 업로드하면 WebGL texImage2D 가 버퍼 크기 불일치로 실패한다
  }
  const gray = new Uint8Array(w * h)
  for (let i = 0; i < gray.length; i++) gray[i] = data[i * 4] // 그레이스케일이라 R=G=B, A=255
  return gray
}

function loadLandMaskOnce(): Promise<LandMaskData | null> {
  if (!_landMaskPromise) {
    _landMaskPromise = (async () => {
      try {
        const [meta, pngBlob] = await Promise.all([
          fetch('/landmask.json').then(r => {
            if (!r.ok) throw new Error(`landmask.json HTTP ${r.status}`)
            return r.json() as Promise<LandMaskMeta>
          }),
          fetch('/landmask.png').then(r => {
            if (!r.ok) throw new Error(`landmask.png HTTP ${r.status}`)
            return r.blob()
          }),
        ])
        // 최대 3회 재시도 — createImageBitmap 이 새 WebGL 컨텍스트 생성과 동시에 호출되면(SstGL
        // 생성자가 바로 이 패턴) 드물게 0x0 으로 조용히 퇴화하는 게 실측됐다(headless/소프트웨어
        // GL 환경에서 재현 — 실기기에서도 저사양 기기 방어 차원에서 재시도는 무해하다).
        let gray: Uint8Array | null = null
        for (let attempt = 0; attempt < 3 && !gray; attempt++) {
          if (attempt > 0) await new Promise(r => setTimeout(r, 250))
          gray = await decodeLandMaskOnce(pngBlob, meta)
        }
        if (!gray) throw new Error('landmask.png 디코드 결과 치수 불일치(0x0 등) — 3회 재시도 후에도 실패')
        return { meta, gray }
      } catch (e) {
        console.warn('[sstGL] landmask 로드 실패 — 정밀 해안선 클리핑 없이 RTOFS 자체 마스크로만 동작', e)
        return null
      }
    })()
  }
  return _landMaskPromise
}

/** 코너-정렬 bilinear 업샘플: (rows,cols) → ((rows-1)*up+1, (cols-1)*up+1). 노드 0..N-1 코너가
 *  정확히 일치해 fieldCommon 의 g(격자 분수 좌표) 정규화와 그대로 호환된다. */
function upsampleBilinear(
  src: Float32Array, rows: number, cols: number, up: number,
): { data: Float32Array; upRows: number; upCols: number } {
  const upRows = (rows - 1) * up + 1
  const upCols = (cols - 1) * up + 1
  const out = new Float32Array(upRows * upCols)
  for (let ui = 0; ui < upRows; ui++) {
    const fi = ui / up
    const i0 = Math.min(rows - 2, Math.floor(fi))
    const ti = fi - i0
    for (let uj = 0; uj < upCols; uj++) {
      const fj = uj / up
      const j0 = Math.min(cols - 2, Math.floor(fj))
      const tj = fj - j0
      const v00 = src[i0 * cols + j0]
      const v10 = src[i0 * cols + j0 + 1]
      const v01 = src[(i0 + 1) * cols + j0]
      const v11 = src[(i0 + 1) * cols + j0 + 1]
      const v0 = v00 + (v10 - v00) * tj
      const v1 = v01 + (v11 - v01) * tj
      out[ui * upCols + uj] = v0 + (v1 - v0) * ti
    }
  }
  return { data: out, upRows, upCols }
}

export class SstGL {
  private _map: maplibregl.Map
  private _gl: AnyGL
  private _canvas: HTMLCanvasElement
  private _prog: WebGLProgram
  private _loc: Record<string, any>
  private _quadBuf: WebGLBuffer
  private _tex: WebGLTexture | null = null
  private _texMask: WebGLTexture | null = null
  private _texPrecise: WebGLTexture | null = null // 정밀 landmask(§26 3차 수정) — 로드 전엔 1x1 placeholder
  private _maskReady = 0 // 0|1 — u_maskReady 유니폼 그대로(로드 완료 전엔 주 게이트 우회)
  private _caps: Caps
  private _sstBounds: readonly [number, number, number, number] = [115, 24, 142, 46]

  private _lonlat = new Float32Array(4)
  private _merc = new Float32Array(2)
  private _gridSize = new Float32Array(2)
  private _matrix = new Float32Array(9)

  private _W = 0
  private _H = 0
  private _dpr = 1
  private _raf = 0
  private _hasField = false
  private _contextLost = false
  private _onContextLostCb?: () => void

  constructor(map: maplibregl.Map, data: SstFieldData, caps: Caps, onContextLost?: () => void) {
    this._map = map
    this._onContextLostCb = onContextLost
    this._caps = caps

    const canvas = document.createElement('canvas')
    // z-index: 베이스 지도 위 · 바람장(6) 아래(래스터를 파티클보다 먼저 깔아 파티클이 그 위로
    // 보이게) · 부이 마커(20+) 훨씬 아래(§26 최우선 요구사항).
    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:4;'
    map.getCanvasContainer().appendChild(canvas)
    this._canvas = canvas
    canvas.addEventListener('webglcontextlost', this._onGLContextLost, false)
    canvas.addEventListener('webglcontextrestored', this._onGLContextRestored, false)

    const glOpts: WebGLContextAttributes = { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false }
    const gl = (caps.isWebGL2
      ? canvas.getContext('webgl2', glOpts)
      : (canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts))) as AnyGL
    this._gl = gl
    // 기본 UNPACK_ALIGNMENT=4 는 RGBA(4바이트/텍셀, 항상 정렬됨)엔 무해하지만, landmask 의 단일채널
    // (LUMINANCE/RED, 1바이트/텍셀) 업로드는 폭(4829)이 4의 배수가 아니라 정렬=4 그대로 두면 각
    // 행이 최대 3바이트 패딩된 것으로 오독되어 텍스처가 대각선으로 밀린다 — 1로 낮춰 전부 무패딩
    // 타이트팩 버퍼로 통일한다(RGBA 업로드엔 영향 없음 — width*4 는 항상 4의 배수).
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

    this._prog = createProgram(gl, VERT, FRAG)
    this._loc = getLocations(gl, this._prog,
      ['a_pv', 'u_matrix', 'u_tex', 'u_texMask', 'u_texPrecise', 'u_maskReady', 'u_gridSize', 'u_lonlat', 'u_merc'])

    // TRIANGLE_STRIP 순서: (0,0) (1,0) (0,1) (1,1) — px=경도분수, py=0→최북단(computeDomainMatrix 규약)
    const quad = new Float32Array([0, 0, 1, 0, 0, 1, 1, 1])
    this._quadBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)

    // 정밀 landmask 텍스처가 비동기 로드되기 전에도 샘플러 바인딩이 유효해야 하므로 1x1 placeholder
    // 먼저 올려둔다(u_maskReady=0 이라 셰이더에서 값 자체는 무시됨 — 순수 형식상 바인딩).
    this._texPrecise = createTexture(gl, { width: 1, height: 1, data: new Uint8Array([0]), filter: gl.LINEAR,
      format: this._maskGlFormat(), internalFormat: this._maskGlInternalFormat() })

    this.setData(data)
    this._resize()
    map.on('move', this._scheduleDraw)
    map.on('resize', this._onResize)
    document.addEventListener('visibilitychange', this._onVis)

    // 정밀 landmask — 모듈 스코프 캐시(loadLandMaskOnce)라 페이지 세션당 1회만 fetch+디코드된다.
    loadLandMaskOnce().then((res) => this._applyLandMask(res))
  }

  /** WebGL1 은 LUMINANCE, WebGL2 는 RED(+R8 sized internalFormat)로 단일채널 8bit 텍스처를 올린다
   *  (RGBA8 대비 1/4 메모리 — 마스크가 4829×3935 라 RGBA 였다면 66MB, R8/LUMINANCE 로 18MB 대). */
  private _maskGlFormat(): number {
    const gl = this._gl
    return this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).RED : gl.LUMINANCE
  }
  private _maskGlInternalFormat(): number {
    const gl = this._gl
    return this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).R8 : gl.LUMINANCE
  }

  /** loadLandMaskOnce() 완료 콜백 — 실패(null)면 그냥 폴백(RTOFS 게이트만 계속 적용, 조용히 무시).
   *  성공이면 이 인스턴스의 GL 컨텍스트에 텍스처를 올리고 u_maskReady=1 로 전환한다. bounds 가
   *  현재 SST 데이터와 어긋나면(빌드 스크립트 도메인과 backend LON/LAT_MIN/MAX 가 어떤 이유로
   *  달라진 경우) 안전하게 우회한다 — backend/*.py 는 이 작업 범위 밖이라 여기서 방어만 한다. */
  private _applyLandMask(res: LandMaskData | null) {
    if (this._contextLost) return
    if (!res) return // 이미 loadLandMaskOnce 내부에서 console.warn 됨
    const [w0, s0, e0, n0] = this._sstBounds
    const [w1, s1, e1, n1] = res.meta.bounds
    const EPS = 0.05
    if (Math.abs(w0 - w1) > EPS || Math.abs(s0 - s1) > EPS || Math.abs(e0 - e1) > EPS || Math.abs(n0 - n1) > EPS) {
      console.warn('[sstGL] landmask.json bounds 가 SST bounds 와 어긋남 — 정밀 클리핑 비활성화',
        { sst: this._sstBounds, mask: res.meta.bounds })
      return
    }
    const gl = this._gl
    const opts = { width: res.meta.width, height: res.meta.height, data: res.gray, filter: gl.LINEAR,
      format: this._maskGlFormat(), internalFormat: this._maskGlInternalFormat() }
    if (this._texPrecise) updateTexture(gl, this._texPrecise, opts)
    else this._texPrecise = createTexture(gl, opts)
    this._maskReady = 1
    this._scheduleDraw()
  }

  setData(data: SstFieldData) {
    const gl = this._gl
    const b = boundsFromArray(data.bounds)
    const rows = data.rows, cols = data.cols
    this._sstBounds = data.bounds // _applyLandMask() 의 bounds 일치 확인용(landmask 는 정적이라 setData 마다 다시 확인하지 않는다)
    this._lonlat.set([b.lon_min, b.lon_max, b.lat_min, b.lat_max])
    this._merc.set([mercatorY(b.lat_max), mercatorY(b.lat_min)])
    this._gridSize.set([cols, rows])

    const isLand = (i: number, j: number): boolean => {
      const v = data.data[i][j]
      return v == null || !isFinite(v)
    }

    // 1) 원본 해상도 색 텍스처 — 육지 alpha=0, 바다 alpha=CELL_ALPHA 그대로(페더링은 아래 seaGate
    //    하나가 전담 — 색 텍스처에서까지 이중으로 부드럽게 하면 해안이 과도하게 흐려진다).
    const buf = new Uint8Array(rows * cols * 4)
    const a01 = CELL_ALPHA / 255
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (isLand(i, j)) continue // alpha 0 그대로(육지 — 완전 투명)
        const v = data.data[i][j] as number
        const k = (i * cols + j) * 4
        const [r, g, bl] = sstColor(v)
        buf[k] = Math.round(r * a01)
        buf[k + 1] = Math.round(g * a01)
        buf[k + 2] = Math.round(bl * a01)
        buf[k + 3] = CELL_ALPHA
      }
    }

    // 2) 해안선 게이트 — 연속 seaFrac 필드를 업샘플해 매끈한 경계를 만든다(파일 헤더 주석 참고).
    const seaFrac = computeSeaFrac(data.data, rows, cols, SEA_KERNEL_RADIUS)
    const { data: seaFracUp, upRows, upCols } = upsampleBilinear(seaFrac, rows, cols, MASK_UPSAMPLE)
    const maskBuf = new Uint8Array(upRows * upCols * 4)
    for (let k = 0; k < upRows * upCols; k++) {
      maskBuf[k * 4 + 3] = Math.max(0, Math.min(255, Math.round(seaFracUp[k] * 255)))
    }

    const opts = { width: cols, height: rows, data: buf, filter: gl.LINEAR }
    const optsMask = { width: upCols, height: upRows, data: maskBuf, filter: gl.LINEAR }
    if (this._tex) updateTexture(gl, this._tex, opts)
    else this._tex = createTexture(gl, opts)
    if (this._texMask) updateTexture(gl, this._texMask, optsMask)
    else this._texMask = createTexture(gl, optsMask)
    this._hasField = true
    this._scheduleDraw()
  }

  /** setStyle() 안전망 — windGL.reattach() 와 동일한 취지. */
  reattach() {
    const container = this._map.getCanvasContainer()
    if (this._canvas.parentElement !== container) container.appendChild(this._canvas)
  }

  remove() {
    if (this._raf) cancelAnimationFrame(this._raf)
    this._map.off('move', this._scheduleDraw)
    this._map.off('resize', this._onResize)
    document.removeEventListener('visibilitychange', this._onVis)
    this._canvas.removeEventListener('webglcontextlost', this._onGLContextLost)
    this._canvas.removeEventListener('webglcontextrestored', this._onGLContextRestored)
    this._gl.getExtension('WEBGL_lose_context')?.loseContext()
    this._canvas.remove()
  }

  private _resize() {
    const c = this._map.getContainer()
    const W = c.offsetWidth, H = c.offsetHeight
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (W === this._W && H === this._H && dpr === this._dpr) return
    this._W = W; this._H = H; this._dpr = dpr
    this._canvas.width = Math.round(W * dpr)
    this._canvas.height = Math.round(H * dpr)
    this._canvas.style.width = W + 'px'
    this._canvas.style.height = H + 'px'
    this._draw()
  }

  private _onResize = () => { this._resize() }
  private _onVis = () => {
    // 정적 래스터라 rAF 루프가 없으므로 visibilitychange 에 특별히 대응할 상태가 없다 — 탭 복귀
    // 시 마지막 그린 내용이 그대로 유효(카메라가 안 움직였다면). 안전을 위해 한 번 재그린만.
    if (!document.hidden) this._scheduleDraw()
  }

  private _scheduleDraw = () => {
    if (this._raf) return
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw() })
  }

  private _onGLContextLost = (e: Event) => {
    e.preventDefault()
    this._contextLost = true
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0 }
    this._onContextLostCb?.()
  }
  private _onGLContextRestored = () => { this._contextLost = false }

  private _draw = () => {
    if (this._contextLost || !this._hasField || !this._tex || !this._texMask) return
    const gl = this._gl
    gl.viewport(0, 0, this._canvas.width, this._canvas.height)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA) // premultiplied

    computeDomainMatrix(this._map, {
      lon_min: this._lonlat[0], lon_max: this._lonlat[1], lat_min: this._lonlat[2], lat_max: this._lonlat[3],
    }, this._W, this._H, this._matrix)

    gl.useProgram(this._prog)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf)
    gl.enableVertexAttribArray(this._loc.a_pv)
    gl.vertexAttribPointer(this._loc.a_pv, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._tex)
    gl.uniform1i(this._loc.u_tex, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._texMask)
    gl.uniform1i(this._loc.u_texMask, 1)
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this._texPrecise)
    gl.uniform1i(this._loc.u_texPrecise, 2)
    gl.uniform1f(this._loc.u_maskReady, this._maskReady)
    gl.uniformMatrix3fv(this._loc.u_matrix, false, this._matrix)
    gl.uniform2fv(this._loc.u_gridSize, this._gridSize)
    gl.uniform4fv(this._loc.u_lonlat, this._lonlat)
    gl.uniform2fv(this._loc.u_merc, this._merc)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}
