/**
 * glUtils — minimal WebGL helpers shared by the field GPU renderers (wind
 * particles·수온장 raster). 이식: Storm_Platform frontend/src/webgl/glUtils.ts
 * (변경 없음 — 범용 헬퍼라 이 플랫폼 전용 수정이 필요 없다).
 * GLSL is authored in ES 1.00 (texture2D / gl_FragColor) so a single shader
 * source compiles on both WebGL2 and WebGL1 contexts.
 */
import type maplibregl from 'maplibre-gl'

export type AnyGL = WebGL2RenderingContext | WebGLRenderingContext

export interface Caps {
  /** 'webgl2-float' → float render targets (animated GPU wind, best path)
   *  'webgl2'       → WebGL2 without EXT_color_buffer_float (encoded wind state)
   *  'webgl1-float' → WebGL1 + OES_texture_float (encoded wind state, float fields)
   *  'none'         → no usable WebGL → toggle disabled */
  tier: 'webgl2-float' | 'webgl2' | 'webgl1-float' | 'none'
  isWebGL2: boolean
  /** float render targets available (ping-pong particle state in float) */
  floatRender: boolean
  /** hardware LINEAR filtering of float textures available */
  floatLinear: boolean
}

/** Probe a throwaway context to decide the rendering tier once at startup. */
export function detectCaps(): Caps {
  const probe = document.createElement('canvas')
  const attrs: WebGLContextAttributes = { antialias: false, depth: false, stencil: false, alpha: true }
  const gl2 = probe.getContext('webgl2', attrs) as WebGL2RenderingContext | null
  if (gl2) {
    const colorBufFloat = !!gl2.getExtension('EXT_color_buffer_float')
    const floatLinear = !!gl2.getExtension('OES_texture_float_linear')
    return {
      tier: colorBufFloat ? 'webgl2-float' : 'webgl2',
      isWebGL2: true,
      floatRender: colorBufFloat,
      floatLinear,
    }
  }
  const gl1 = (probe.getContext('webgl', attrs) ||
    probe.getContext('experimental-webgl', attrs)) as WebGLRenderingContext | null
  if (gl1) {
    const texFloat = !!gl1.getExtension('OES_texture_float')
    const floatLinear = !!gl1.getExtension('OES_texture_float_linear')
    // Rendering to a float texture in WebGL1 requires WEBGL_color_buffer_float
    // (or the implicit OES_texture_float RTT that many desktop drivers allow).
    const colorBufFloat = texFloat && !!gl1.getExtension('WEBGL_color_buffer_float')
    if (texFloat) {
      return { tier: 'webgl1-float', isWebGL2: false, floatRender: colorBufFloat, floatLinear }
    }
    return { tier: 'none', isWebGL2: false, floatRender: false, floatLinear: false }
  }
  return { tier: 'none', isWebGL2: false, floatRender: false, floatLinear: false }
}

export function createShader(gl: AnyGL, type: number, source: string): WebGLShader {
  const sh = gl.createShader(type)!
  gl.shaderSource(sh, source)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh)
    gl.deleteShader(sh)
    throw new Error('[webgl] shader compile failed: ' + log + '\n' + source)
  }
  return sh
}

export function createProgram(gl: AnyGL, vertSrc: string, fragSrc: string): WebGLProgram {
  const prog = gl.createProgram()!
  const vs = createShader(gl, gl.VERTEX_SHADER, vertSrc)
  const fs = createShader(gl, gl.FRAGMENT_SHADER, fragSrc)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error('[webgl] program link failed: ' + log)
  }
  return prog
}

/** Cache all attribute + uniform locations of a program up-front (no per-frame lookups). */
export function getLocations(gl: AnyGL, prog: WebGLProgram, names: string[]): Record<string, any> {
  const loc: Record<string, any> = {}
  for (const n of names) {
    loc[n] = n.startsWith('a_') ? gl.getAttribLocation(prog, n) : gl.getUniformLocation(prog, n)
  }
  return loc
}

export function createBuffer(gl: AnyGL, data: Float32Array): WebGLBuffer {
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
  return buf
}

export interface TexOpts {
  width: number
  height: number
  data: ArrayBufferView | null
  /** gl.UNSIGNED_BYTE | gl.FLOAT */
  type?: number
  filter?: number   // gl.NEAREST | gl.LINEAR
  /** internal format override (WebGL2 sized formats e.g. RGBA32F, R32F, RG32F) */
  internalFormat?: number
  /** pixel format e.g. gl.RGBA, gl.RED, gl.RG (RED/RG are WebGL2 only) */
  format?: number
}

export function createTexture(gl: AnyGL, opts: TexOpts): WebGLTexture {
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const filter = opts.filter ?? gl.NEAREST
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
  const type = opts.type ?? gl.UNSIGNED_BYTE
  const format = opts.format ?? gl.RGBA
  const internalFormat = opts.internalFormat ?? format
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, opts.width, opts.height, 0, format, type, opts.data as any)
  return tex
}

export function updateTexture(gl: AnyGL, tex: WebGLTexture, opts: TexOpts) {
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const type = opts.type ?? gl.UNSIGNED_BYTE
  const format = opts.format ?? gl.RGBA
  const internalFormat = opts.internalFormat ?? format
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, opts.width, opts.height, 0, format, type, opts.data as any)
}

export function createFramebuffer(gl: AnyGL, tex: WebGLTexture): WebGLFramebuffer {
  const fb = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  return fb
}

// ── Web-Mercator domain → clip-space affine matrix ───────────────────────────
// A rectangular lon/lat domain maps to the screen through MapLibre's Web-Mercator
// projection, which (for pitch 0) is a plain affine of the normalised domain
// coordinate (px,py) ∈ [0,1]². We recover that affine each frame from three
// projected corners, so a map pan/zoom/rotate only refreshes 9 uniform floats —
// no per-particle CPU work. Column-major mat3: clip = M · vec3(px, py, 1).
export function computeDomainMatrix(
  map: maplibregl.Map,
  domain: { lon_min: number; lon_max: number; lat_min: number; lat_max: number },
  cssW: number,
  cssH: number,
  out: Float32Array,
): Float32Array {
  // px=0,py=0 → (lon_min, lat_max) top-left ; px=1 → lon_max ; py=1 → lat_min
  const O = map.project([domain.lon_min, domain.lat_max]) // origin
  const X = map.project([domain.lon_max, domain.lat_max]) // +px basis end
  const Y = map.project([domain.lon_min, domain.lat_min]) // +py basis end
  // screen(px,py) = O + px*(X-O) + py*(Y-O), screen in CSS px.
  const bxx = X.x - O.x, bxy = X.y - O.y // ∂screen/∂px
  const byx = Y.x - O.x, byy = Y.y - O.y // ∂screen/∂py
  // screen → clip:  clipX = sx/W*2 - 1 ;  clipY = 1 - sy/H*2
  const sx = 2 / cssW, sy = 2 / cssH
  // column 0 (coeff of px)
  out[0] = bxx * sx
  out[1] = -bxy * sy
  out[2] = 0
  // column 1 (coeff of py)
  out[3] = byx * sx
  out[4] = -byy * sy
  out[5] = 0
  // column 2 (constant, from origin O)
  out[6] = O.x * sx - 1
  out[7] = 1 - O.y * sy
  out[8] = 1
  return out
}
