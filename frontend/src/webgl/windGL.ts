/**
 * WindGL — GPU particle wind field (webgl-wind / mapbox-style architecture).
 * 이식: Storm_Platform frontend/src/webgl/windGL.ts. Storm 은 매시 프레임을 갈아타는
 * 타임라인(과거~예측 재생)이라 두 프레임(prev/next) 을 크로스페이드했지만, 이 플랫폼은
 * `/api/field` 가 **현재 KST 1프레임만** 서빙한다(CLAUDE.md §26 — 타임라인·아카이브 없음).
 * 그래서 크로스페이드 관련 코드(fieldPrev/fieldNext 핑퐁·fieldMix 유니폼)는 전부 제거하고
 * 단일 필드 텍스처로 단순화했다. row 방향 등 지리좌표 변환은 fieldCommon.ts 로 일원화.
 *
 * Per animation frame (single shared rAF):
 *   1. UPDATE — ping-pong float (or RGBA8-encoded) state texture; a fragment
 *               shader advects every particle through the u/v field and respawns
 *               dead / out-of-domain / stalled ones via an in-shader hash. The
 *               per-particle speed is cached in the state so the draw pass needs
 *               no field sampling.
 *   2. TRAIL  — the visible canvas is its own persistent accumulator
 *               (preserveDrawingBuffer): a single full-screen pass multiplies the
 *               previous frame down by fadeOpacity (heavier while the map moves),
 *               then the particles are rendered as 1px GL_LINES (prev→cur) on top
 *               → dense, silky, speed-tinted streamlines. No extra blit pass.
 *
 * Particle positions live in the domain normalised to Web-Mercator (latitude via
 * mercator Y), so a map move only refreshes the 9-float domain→clip matrix — zero
 * per-particle CPU work.
 */
import type maplibregl from 'maplibre-gl'
import {
  type AnyGL, type Caps,
  createProgram, getLocations, createBuffer, createTexture, updateTexture,
  createFramebuffer, computeDomainMatrix,
} from './glUtils'
import { buildWindTrailLUT, mercatorY } from './colorRamps'
import { GLSL_FIELD_COMMON, boundsFromArray } from './fieldCommon'

export interface WindFieldData {
  bounds: readonly [number, number, number, number] // [west, south, east, north]
  rows: number
  cols: number
  u: number[][]
  v: number[][]
}

const GLSL_PACK = `
#if FLOAT_STATE
vec2 getPos(vec4 s){ return s.xy; }
#else
vec2 getPos(vec4 s){
  return vec2(
    (s.r*255.0*256.0 + s.g*255.0) / 65535.0,
    (s.b*255.0*256.0 + s.a*255.0) / 65535.0);
}
vec4 packPos(vec2 p){
  vec2 e = clamp(p, 0.0, 1.0) * 65535.0;
  float r = floor(e.x/256.0), g = e.x - r*256.0;
  float b = floor(e.y/256.0), a = e.y - b*256.0;
  return vec4(r, g, b, a) / 255.0;
}
#endif
`

const FS_QUAD_VERT = `
precision highp float;
attribute vec2 a_pos;
void main(){ gl_Position = vec4(a_pos, 0.0, 1.0); }
`
// fade pass: output is ignored (blend srcFactor = ZERO); the constant-color blend
// factor multiplies the destination (canvas) down by fadeOpacity.
const FADE_FRAG = `
precision highp float;
void main(){ gl_FragColor = vec4(1.0); }
`

// 단일 필드 텍스처 샘플 — u_fieldLinear==0 이면(FLOAT 텍스처의 하드웨어 LINEAR 미지원 환경)
// 4-tap 수동 바이리니어로 대체.
const SAMPLE_FIELD = `
uniform sampler2D u_field;
uniform float u_fieldLinear;
vec2 sampleField(vec2 g){
  if (u_fieldLinear > 0.5) {
    return texture2D(u_field, (g + 0.5) / u_gridSize).xy;
  }
  vec2 f  = fract(g);
  vec2 g0 = floor(g);
  vec2 t00 = (g0 + 0.5) / u_gridSize;
  vec2 t10 = (g0 + vec2(1.0,0.0) + 0.5) / u_gridSize;
  vec2 t01 = (g0 + vec2(0.0,1.0) + 0.5) / u_gridSize;
  vec2 t11 = (g0 + vec2(1.0,1.0) + 0.5) / u_gridSize;
  vec2 a = mix(texture2D(u_field,t00).xy, texture2D(u_field,t10).xy, f.x);
  vec2 b = mix(texture2D(u_field,t01).xy, texture2D(u_field,t11).xy, f.x);
  return mix(a, b, f.y);
}
`

function updateFrag(floatState: boolean) {
  return `#define FLOAT_STATE ${floatState ? 1 : 0}
${GLSL_FIELD_COMMON}
${GLSL_PACK}
${SAMPLE_FIELD}
varying vec2 v_uv;
uniform sampler2D u_state;
uniform vec2 u_seed;
uniform vec2 u_lifeRange;   // (minLife, maxLife) frames
uniform float u_dropRate;   // encoded-state random churn
uniform float u_speed;      // global advection-speed scale (graceful flow)
uniform float u_zoomScale;  // 확대 시 보폭 축소(화면상 세그먼트 길이 유지) — 각진 회전 방지
void main(){
  vec4 s = texture2D(u_state, v_uv);
  vec2 pos = getPos(s);
  vec2 ll = posToLonLat(pos);
  vec2 uv = sampleField(posToGrid(pos, ll.y));
  float spd = length(uv);

  // 입자별 고유 보속 편차(±12%) — 균일한 기계적 움직임 대신 유기적인 흐름
  float pace = 0.88 + 0.24 * hash(v_uv * 7.77 + 3.31);
  // 상수항(floor)이 풍속항을 압도하면 잔잔/강풍이 똑같이 빨라 보인다. floor 를 낮추고
  // 풍속항을 키워 실제 풍속에 비례하게 — 잔잔한 곳은 느리게, 강풍은 뚜렷이 빠르게.
  float dt = u_speed * (0.0010 + spd*0.00017) * u_zoomScale * pace;
  float cosLat = cos(radians(ll.y));
  // 중점(RK2) 적분: 반걸음 지점의 바람을 다시 샘플링해 곡률을 따라 휘게 함.
  float midLat = ll.y + uv.y*dt*0.5;
  float midLon = ll.x + (uv.x*dt*0.5)/cosLat;
  vec2 midPos = vec2((midLon - u_lonlat.x) / (u_lonlat.y - u_lonlat.x),
                     (mercLat(midLat) - u_merc.x) / (u_merc.y - u_merc.x));
  vec2 uvm = sampleField(posToGrid(midPos, midLat));
  float newLat = ll.y + uvm.y*dt;
  float newLon = ll.x + (uvm.x*dt)/cosLat;
  float newPx = (newLon - u_lonlat.x) / (u_lonlat.y - u_lonlat.x);
  float newPy = (mercLat(newLat) - u_merc.x) / (u_merc.y - u_merc.x);
  vec2 newPos = vec2(newPx, newPy);
  bool outside = newPx < 0.0 || newPx > 1.0 || newPy < 0.0 || newPy > 1.0;

#if FLOAT_STATE
  float life = mix(u_lifeRange.x, u_lifeRange.y, hash(v_uv * 3.71 + 0.123));
  // 약풍 입자는 수명을 줄여 잔상 실이 길게 늘어지지 않게 (12 m/s 미만에서 최대 55% 단축)
  life *= mix(0.45, 1.0, clamp(spd / 12.0, 0.0, 1.0));
  float newAge = s.z + 1.0/life;
  bool die = spd < 0.5 || newAge >= 1.0 || outside;
  if (die) {
    newPos = vec2(hash(v_uv + u_seed), hash(v_uv + u_seed + 19.19));
    newAge = 0.0;
  }
  float tStore = clamp(spd / 32.0, 0.0, 1.0);       // speed→LUT index, cached in .w
  gl_FragColor = vec4(newPos, newAge, tStore);
#else
  float drop = step(1.0 - u_dropRate, hash(v_uv + u_seed + 7.3));
  bool die = spd < 0.5 || outside || drop > 0.5;
  if (die) newPos = vec2(hash(v_uv + u_seed), hash(v_uv + u_seed + 19.19));
  gl_FragColor = packPos(newPos);
#endif
}
`
}
const UPDATE_VERT = `
precision highp float;
attribute vec2 a_pos;
varying vec2 v_uv;
void main(){ v_uv = a_pos*0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`

function drawVert(floatState: boolean) {
  return `#define FLOAT_STATE ${floatState ? 1 : 0}
${GLSL_FIELD_COMMON}
${GLSL_PACK}
${SAMPLE_FIELD}
attribute vec2 a_pv;          // (particleIndex, t∈{0, 0.5, 1.0} — 이 프레임 곡선 세그먼트 위 위치)
uniform sampler2D u_state0;
uniform sampler2D u_state1;
uniform sampler2D u_lut;
uniform mat3 u_matrix;
uniform vec2 u_stateRes;
uniform float u_jumpMax;
uniform float u_baseAlpha;
varying vec4 v_color;
vec2 slot(float idx){
  float x = mod(idx, u_stateRes.x);
  float y = floor(idx / u_stateRes.x);
  return (vec2(x,y) + 0.5) / u_stateRes;
}
// uv가 0에 가까우면(정지/특이점) 방향 대신 chord(직선) 방향으로 안전하게 대체.
vec2 safeDir(vec2 uv, vec2 fallbackDir){
  float l = length(uv);
  return l > 1e-5 ? uv / l : fallbackDir;
}
void main(){
  vec2 tc = slot(a_pv.x);
  vec4 s0 = texture2D(u_state0, tc);
  vec4 s1 = texture2D(u_state1, tc);
  vec2 p0 = getPos(s0);
  vec2 p1 = getPos(s1);
  if (distance(p0, p1) > u_jumpMax) p0 = p1;   // collapse respawn / wrap streak

  // 각짐(다각형) 완화: p0→p1 이동거리·dt는 update 패스가 이미 확정한 값이므로 절대
  // 바꾸지 않는다(=속도·꼬리 길이 불변). 대신 이 "같은 두 점" 사이를 곧은 현(chord) 1개
  // 대신, 양끝에서의 실제 바람 방향을 접선으로 쓰는 3차 Hermite 곡선의 t=0.5 지점을
  // 추가해 2개의 짧은 세그먼트로 그린다.
  vec2 chord = p1 - p0;
  float chordLen = length(chord);
  vec2 chordDir = chordLen > 1e-8 ? chord / chordLen : vec2(0.0);
  vec2 pos;
  if (a_pv.y < 0.25) {
    pos = p0;
  } else if (a_pv.y > 0.75) {
    pos = p1;
  } else {
    vec2 ll0 = posToLonLat(p0);
    vec2 uv0 = sampleField(posToGrid(p0, ll0.y));
    vec2 ll1 = posToLonLat(p1);
    vec2 uv1 = sampleField(posToGrid(p1, ll1.y));
    vec2 m0 = safeDir(uv0, chordDir) * chordLen;
    vec2 m1 = safeDir(uv1, chordDir) * chordLen;
    // Hermite basis @ t=0.5 : h00=0.5, h10=0.125, h01=0.5, h11=-0.125
    pos = 0.5 * p0 + 0.125 * m0 + 0.5 * p1 - 0.125 * m1;
  }
#if FLOAT_STATE
  float t = clamp(s1.w, 0.0, 1.0);             // speed cached by update pass
  float lifeFade = sin(clamp(s1.z, 0.0, 1.0) * PI);
#else
  vec2 ll = posToLonLat(p1);
  float spd = length(sampleField(posToGrid(p1, ll.y)));
  float t = clamp(spd/32.0, 0.0, 1.0);
  float lifeFade = 1.0;
#endif
  vec3 rgb = texture2D(u_lut, vec2(t, 0.5)).rgb;
  // §26 후속지시 #2(2026-07-16) — 수온장 위에서 파티클이 묻히지 않도록 알파 바닥을 크게 올렸다
  // (이전 0.30→0.30+0.5 대비 0.58→0.58+0.42 — 약풍도 배경과 대비되게 항상 밝게 보이도록).
  float speedAlpha = 0.58 + min(0.42, (t*32.0)/22.0);
  float alpha = clamp(speedAlpha * lifeFade * u_baseAlpha, 0.0, 1.0);
  v_color = vec4(rgb * alpha, alpha);          // premultiplied
  vec3 clip = u_matrix * vec3(pos, 1.0);
  gl_Position = vec4(clip.xy, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`
}
const DRAW_FRAG = `
precision highp float;
varying vec4 v_color;
void main(){ gl_FragColor = v_color; }
`

export class WindGL {
  private _map: maplibregl.Map
  private _gl: AnyGL
  private _caps: Caps
  private _canvas: HTMLCanvasElement
  private _floatState: boolean

  private _updateProg: WebGLProgram
  private _drawProg: WebGLProgram
  private _fadeProg: WebGLProgram
  private _updLoc: Record<string, any>
  private _drawLoc: Record<string, any>
  private _fadeLoc: Record<string, any>

  private _quadBuf: WebGLBuffer
  private _pvBuf: WebGLBuffer

  private _fieldTex!: WebGLTexture
  private _lutTex: WebGLTexture
  private _state0!: WebGLTexture
  private _state1!: WebGLTexture
  private _stateFbo0!: WebGLFramebuffer
  private _stateFbo1!: WebGLFramebuffer

  private _lonlat = new Float32Array(4)
  private _merc = new Float32Array(2)
  private _gridSize = new Float32Array(2)
  private _matrix = new Float32Array(9)

  private _numParticles = 0
  private _stateRes = 0
  private _W = 0
  private _H = 0
  private _dpr = 1
  private _moving = false
  private _needClear = true
  private _raf = 0
  private _fieldLinear = 0
  // WebGL context-loss bookkeeping — a lost context (GPU driver reset, laptop
  // GPU switch, sleep/resume) must not spin the rAF loop against a dead
  // context; the owner (MapViewGL) is notified so it can tear down and
  // recreate this layer from scratch.
  private _contextLost = false
  private _onContextLostCb?: () => void

  constructor(map: maplibregl.Map, data: WindFieldData, caps: Caps, onContextLost?: () => void) {
    this._map = map
    this._caps = caps
    this._floatState = caps.floatRender
    this._onContextLostCb = onContextLost

    const canvas = document.createElement('canvas')
    // z-index: 베이스 지도 위 · 부이 마커(z-index 20+) 아래(§26 최우선 요구사항).
    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:6;'
    map.getCanvasContainer().appendChild(canvas)
    this._canvas = canvas
    canvas.addEventListener('webglcontextlost', this._onGLContextLost, false)
    canvas.addEventListener('webglcontextrestored', this._onGLContextRestored, false)

    const glOpts: WebGLContextAttributes = {
      alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: true, // canvas is its own trail accumulator
    }
    const gl = (caps.isWebGL2
      ? canvas.getContext('webgl2', glOpts)
      : (canvas.getContext('webgl', glOpts) || canvas.getContext('experimental-webgl', glOpts))) as AnyGL
    this._gl = gl
    // Extensions must be enabled per-context (detectCaps probed a throwaway one).
    if (caps.isWebGL2) {
      if (this._floatState) gl.getExtension('EXT_color_buffer_float')
    } else {
      gl.getExtension('OES_texture_float')
    }
    // LINEAR filtering of the float u/v field needs this on the ACTUAL context;
    // without it the LINEAR-filtered float texture is incomplete → samples as 0.
    const linOk = caps.floatLinear && !!gl.getExtension('OES_texture_float_linear')
    this._fieldLinear = linOk ? 1 : 0

    this._updateProg = createProgram(gl, UPDATE_VERT, updateFrag(this._floatState))
    this._drawProg = createProgram(gl, drawVert(this._floatState), DRAW_FRAG)
    this._fadeProg = createProgram(gl, FS_QUAD_VERT, FADE_FRAG)
    this._updLoc = getLocations(gl, this._updateProg,
      ['a_pos', 'u_state', 'u_field', 'u_fieldLinear', 'u_gridSize', 'u_lonlat', 'u_merc',
        'u_seed', 'u_lifeRange', 'u_dropRate', 'u_speed', 'u_zoomScale'])
    this._drawLoc = getLocations(gl, this._drawProg,
      ['a_pv', 'u_state0', 'u_state1', 'u_field', 'u_fieldLinear', 'u_lut', 'u_matrix', 'u_stateRes',
        'u_jumpMax', 'u_baseAlpha', 'u_gridSize', 'u_lonlat', 'u_merc'])
    this._fadeLoc = getLocations(gl, this._fadeProg, ['a_pos'])

    this._quadBuf = createBuffer(gl, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]))
    this._pvBuf = gl.createBuffer()!

    this._lutTex = createTexture(gl, {
      width: 256, height: 1, data: buildWindTrailLUT(), filter: gl.LINEAR,
      internalFormat: caps.isWebGL2 ? (gl as WebGL2RenderingContext).RGBA8 : gl.RGBA,
    })

    // Placeholder 1x1 texture — immediately re-specified to full size by the
    // setData() call below.
    const fieldPlaceholder = {
      width: 1, height: 1, data: null, type: gl.FLOAT, filter: this._fieldLinear ? gl.LINEAR : gl.NEAREST,
      internalFormat: this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA,
      format: gl.RGBA,
    }
    this._fieldTex = createTexture(gl, fieldPlaceholder)
    this.setData(data)
    this._resize()
    map.on('resize', this._onResize)
    map.on('movestart', this._onMoveStart)
    map.on('moveend', this._onMoveEnd)
    document.addEventListener('visibilitychange', this._onVis)
    this._loop()
  }

  setData(data: WindFieldData) {
    const gl = this._gl
    const b = boundsFromArray(data.bounds)
    const rows = data.rows, cols = data.cols
    this._lonlat.set([b.lon_min, b.lon_max, b.lat_min, b.lat_max])
    this._merc.set([mercatorY(b.lat_max), mercatorY(b.lat_min)])
    this._gridSize.set([cols, rows])

    const buf = new Float32Array(rows * cols * 4)
    for (let i = 0; i < rows; i++) {
      const ur = data.u[i], vr = data.v[i]
      for (let j = 0; j < cols; j++) {
        const k = (i * cols + j) * 4
        buf[k] = ur[j]; buf[k + 1] = vr[j]
      }
    }
    const filter = this._fieldLinear ? gl.LINEAR : gl.NEAREST
    updateTexture(gl, this._fieldTex, {
      width: cols, height: rows, data: buf, type: gl.FLOAT, filter,
      internalFormat: this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA,
      format: gl.RGBA,
    })
  }

  /** MapLibre setStyle() 이후 안전망 — 이 캔버스는 style 이 아니라 canvasContainer 의 평범한
   *  DOM 자식이라 setStyle 로 지워지지 않지만(검증 완료), 만에 하나 컨테이너가 교체되는 경우를
   *  대비해 여전히 올바른 부모 아래 붙어있는지 재확인한다(비용 0에 가까운 멱등 연산). */
  reattach() {
    const container = this._map.getCanvasContainer()
    if (this._canvas.parentElement !== container) container.appendChild(this._canvas)
  }

  remove() {
    cancelAnimationFrame(this._raf); this._raf = 0
    this._map.off('resize', this._onResize)
    this._map.off('movestart', this._onMoveStart)
    this._map.off('moveend', this._onMoveEnd)
    document.removeEventListener('visibilitychange', this._onVis)
    this._canvas.removeEventListener('webglcontextlost', this._onGLContextLost)
    this._canvas.removeEventListener('webglcontextrestored', this._onGLContextRestored)
    this._gl.getExtension('WEBGL_lose_context')?.loseContext()
    this._canvas.remove()
  }

  private _initParticles() {
    const gl = this._gl
    // Adaptive to canvas area & DPR. Continuous prev→cur line segments read as
    // dense silky streamlines, so fewer particles are needed than a point cloud.
    // §26 후속지시 #2(2026-07-16) — 수온장 위에서 바람장이 또렷이 읽히도록 밀도를 한 단 올렸다
    // (이전 6000~12000 → 9000~16000). 마커 가독성엔 영향 없음(마커 z-index 는 항상 그 위).
    const area = this._W * this._H
    const n = Math.max(9000, Math.min(16000, Math.round((area / 190) * (0.75 + 0.35 * this._dpr))))
    const res = Math.ceil(Math.sqrt(n))
    this._stateRes = res
    this._numParticles = res * res

    let seed: ArrayBufferView
    if (this._floatState) {
      const f = new Float32Array(this._numParticles * 4)
      for (let i = 0; i < this._numParticles; i++) {
        f[i * 4] = Math.random()
        f[i * 4 + 1] = Math.random()
        f[i * 4 + 2] = Math.random()   // age (desynced)
        f[i * 4 + 3] = 0               // cached speed (filled on first update)
      }
      seed = f
    } else {
      const u8 = new Uint8Array(this._numParticles * 4)
      for (let i = 0; i < this._numParticles; i++) {
        const px = Math.round(Math.random() * 65535)
        const py = Math.round(Math.random() * 65535)
        u8[i * 4] = px >> 8; u8[i * 4 + 1] = px & 255
        u8[i * 4 + 2] = py >> 8; u8[i * 4 + 3] = py & 255
      }
      seed = u8
    }
    const type = this._floatState ? gl.FLOAT : gl.UNSIGNED_BYTE
    const internalFormat = this._floatState
      ? (this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).RGBA32F : gl.RGBA)
      : (this._caps.isWebGL2 ? (gl as WebGL2RenderingContext).RGBA8 : gl.RGBA)
    const mk = (d: ArrayBufferView) =>
      createTexture(gl, { width: res, height: res, data: d, type, filter: gl.NEAREST, internalFormat, format: gl.RGBA })
    if (this._state0) { gl.deleteTexture(this._state0); gl.deleteTexture(this._state1) }
    this._state0 = mk(seed)
    this._state1 = mk(seed)
    if (this._stateFbo0) { gl.deleteFramebuffer(this._stateFbo0); gl.deleteFramebuffer(this._stateFbo1) }
    this._stateFbo0 = createFramebuffer(gl, this._state0)
    this._stateFbo1 = createFramebuffer(gl, this._state1)

    // 4 verts/particle → 2 짧은 GL_LINES 세그먼트(p0→mid, mid→p1).
    const pv = new Float32Array(this._numParticles * 8)
    for (let i = 0; i < this._numParticles; i++) {
      const o = i * 8
      pv[o] = i;     pv[o + 1] = 0.0
      pv[o + 2] = i; pv[o + 3] = 0.5
      pv[o + 4] = i; pv[o + 5] = 0.5
      pv[o + 6] = i; pv[o + 7] = 1.0
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this._pvBuf)
    gl.bufferData(gl.ARRAY_BUFFER, pv, gl.STATIC_DRAW)
  }

  private _resize() {
    const c = this._map.getContainer()
    const W = c.offsetWidth, H = c.offsetHeight
    // 0.74x 내부 해상도 렌더 → CSS 업스케일로 GL_LINES(1 device px)가 ~1.35 css px로 보임.
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * 0.74
    if (W === this._W && H === this._H && dpr === this._dpr && this._state0) return
    this._W = W; this._H = H; this._dpr = dpr
    this._canvas.width = Math.round(W * dpr)
    this._canvas.height = Math.round(H * dpr)
    this._canvas.style.width = W + 'px'
    this._canvas.style.height = H + 'px'
    this._needClear = true
    this._initParticles()
  }

  private _onResize = () => { this._resize() }
  private _onMoveStart = () => { this._moving = true; this._needClear = true }
  private _onMoveEnd = () => { this._moving = false }
  private _onVis = () => {
    if (document.hidden) { cancelAnimationFrame(this._raf); this._raf = 0 }
    else if (this._raf === 0 && !this._contextLost) this._loop()
  }

  private _onGLContextLost = (e: Event) => {
    e.preventDefault()
    this._contextLost = true
    cancelAnimationFrame(this._raf); this._raf = 0
    this._onContextLostCb?.()
  }
  private _onGLContextRestored = () => {
    // Recovery is driven entirely by the owner discarding this instance and
    // constructing a brand-new WindGL (fresh canvas + GL context).
    this._contextLost = false
  }

  private _draw = () => {
    const gl = this._gl
    const w = this._canvas.width, h = this._canvas.height

    // 1. UPDATE particle state → state1
    gl.disable(gl.BLEND)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._stateFbo1)
    gl.viewport(0, 0, this._stateRes, this._stateRes)
    gl.useProgram(this._updateProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf)
    gl.enableVertexAttribArray(this._updLoc.a_pos)
    gl.vertexAttribPointer(this._updLoc.a_pos, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._state0)
    gl.uniform1i(this._updLoc.u_state, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._fieldTex)
    gl.uniform1i(this._updLoc.u_field, 1)
    gl.uniform1f(this._updLoc.u_fieldLinear, this._fieldLinear)
    gl.uniform2fv(this._updLoc.u_gridSize, this._gridSize)
    gl.uniform4fv(this._updLoc.u_lonlat, this._lonlat)
    gl.uniform2fv(this._updLoc.u_merc, this._merc)
    gl.uniform2f(this._updLoc.u_seed, Math.random(), Math.random())
    gl.uniform2f(this._updLoc.u_lifeRange, 60, 140)
    gl.uniform1f(this._updLoc.u_dropRate, 0.012)
    gl.uniform1f(this._updLoc.u_speed, 0.5)   // graceful pacing (실제 풍속이 약~보통이라 과속 인상 완화)
    // 줌 적응 보폭: 기본 줌(≈6) 초과 확대 시 걸음을 줄여 화면상 세그먼트 길이 유지 (하한 0.15)
    const zs = Math.max(0.15, Math.pow(0.62, Math.max(0, this._map.getZoom() - 6.0)))
    gl.uniform1f(this._updLoc.u_zoomScale, zs)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // 2. draw onto the visible canvas (its own persistent trail accumulator)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    if (this._needClear) {
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      this._needClear = false
    }
    // 2a. fade the accumulator in place: dest *= fadeOpacity  (single FS pass, no texfetch)
    const fade = this._moving ? 0.8 : 0.95
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ZERO, gl.CONSTANT_COLOR)
    gl.blendColor(fade, fade, fade, fade)
    gl.useProgram(this._fadeProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._quadBuf)
    gl.enableVertexAttribArray(this._fadeLoc.a_pos)
    gl.vertexAttribPointer(this._fadeLoc.a_pos, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // 2b. draw particle lines (premultiplied over the faded trail)
    computeDomainMatrix(this._map, {
      lon_min: this._lonlat[0], lon_max: this._lonlat[1], lat_min: this._lonlat[2], lat_max: this._lonlat[3],
    }, this._W, this._H, this._matrix)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this._drawProg)
    gl.bindBuffer(gl.ARRAY_BUFFER, this._pvBuf)
    gl.enableVertexAttribArray(this._drawLoc.a_pv)
    gl.vertexAttribPointer(this._drawLoc.a_pv, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this._state0)
    gl.uniform1i(this._drawLoc.u_state0, 0)
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this._state1)
    gl.uniform1i(this._drawLoc.u_state1, 1)
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this._fieldTex)
    gl.uniform1i(this._drawLoc.u_field, 2)
    gl.uniform1f(this._drawLoc.u_fieldLinear, this._fieldLinear)
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this._lutTex)
    gl.uniform1i(this._drawLoc.u_lut, 3)
    gl.uniformMatrix3fv(this._drawLoc.u_matrix, false, this._matrix)
    gl.uniform2f(this._drawLoc.u_stateRes, this._stateRes, this._stateRes)
    gl.uniform1f(this._drawLoc.u_jumpMax, 0.06)
    gl.uniform1f(this._drawLoc.u_baseAlpha, 1.0)   // §26 후속지시 #2 — 수온장 위 가독성 위해 완전 불투명 상한
    gl.uniform2fv(this._drawLoc.u_gridSize, this._gridSize)
    gl.uniform4fv(this._drawLoc.u_lonlat, this._lonlat)
    gl.uniform2fv(this._drawLoc.u_merc, this._merc)
    gl.drawArrays(gl.LINES, 0, this._numParticles * 4)

    // ping-pong particle state
    const ts = this._state0; this._state0 = this._state1; this._state1 = ts
    const tf = this._stateFbo0; this._stateFbo0 = this._stateFbo1; this._stateFbo1 = tf
  }

  private _loop = () => {
    if (this._contextLost) return
    this._draw()
    this._raf = requestAnimationFrame(this._loop)
  }
}
