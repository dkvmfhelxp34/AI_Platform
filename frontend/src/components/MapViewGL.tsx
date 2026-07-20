/**
 * MapViewGL — Native MapLibre GL 지도 (균형 다크 재스킨 패스, ui_revision_notes §17).
 * - Base:     위성(Esri World Imagery raster, 무토큰) **기본**(§17 — §16 라이트 기본 폐기) +
 *             라이트(Carto Positron 벡터) 토글은 유지.
 *             위성 베이스에는 은은한 다크 스크림(map-sat-scrim)을 얹어 초록/갈색 텍스처와 마커 색이
 *             뒤엉키는 "카무플라주"를 완화한다(마커 DOM 자체엔 필터를 걸지 않음 — 색은 그대로).
 * - Buoys:    maplibregl.Marker HTML, anchor='center' — 글리프를 정확히 좌표 중심에 고정한다.
 *             el 자체를 고정 크기(MARKER_BOX) 박스로 두고 이름 라벨은 position:absolute 오프셋으로
 *             배치해 el 의 바운딩박스(=앵커 기준)에 전혀 영향을 주지 않는다 → 줌 드리프트 원천 차단.
 *             모양(원=KMA 해양기상부이 / 삼각=KMA 파고부이 / 라운드사각=KHOA 해양관측부이) = 기관·종류,
 *             색(fill) = 수신상태 — 정상은 저채도(지도에 녹아듦), 지연=앰버, 미수신=고채도 경고색+
 *             강한 펄스+최상단 z-index로 "예외만 튄다". **값 배지는 표시하지 않는다**(§17 — 지도는
 *             위치·상태 등 전체 상황 파악용, 수치는 팝업/상세에서 확인). 마커 = 형태+상태색+흰
 *             보더+소프트섀도+이름 라벨뿐.
 * - NoCluster: 부이 하나하나가 실제 관측소이므로 숫자 카운트 배지로 묶지 않는다(사용자 명시 요구) —
 *             저줌에서 마커가 몰리는 문제는 카운트 배지 대신 ①작은 코어 크기 ②예외 우선 저채도
 *             색(정상은 조용히 후퇴) ③라벨 기본 숨김 ④얇은 아웃라인+소프트 섀도 4가지로만 완화한다.
 *             항상 모든 부이가 개별 마커로 지도에 남는다.
 * - Label:    Wave 3b(ui_revision_notes §9) — 기본 **표시**(아이콘 아래)로 되돌리되 충돌기반
 *             declutter 적용: 라벨끼리 겹치면 우선순위 높은 쪽만 남기고 나머지는 숨긴다. 확대해
 *             공간이 생기면(겹침이 풀리면) 숨겨졌던 라벨도 그 시점부터 바로 드러난다(줌 진행형 —
 *             별도의 "고줌 전부 노출" 임계 이상에서는 겹침 검사 자체를 생략해 전부 노출).
 *             **우선순위(§18-2, 2026-07-16 갱신)**: 미수신(0) > 지연(1) > **해양기상부이 정상(2)**
 *             > 기타(파고부이·KHOA) 정상(3) — `labelRankOf()`. 저줌(NORMAL_LABEL_ZOOM 미만)에서는
 *             rank 3(기타 정상)만 후보에서 제외해 숨기고, rank 0~2(예외 전체 + 주요 부이인 해양기상
 *             부이 정상)는 겹침 기반 declutter 후보로 항상 올라간다 — 국가 줌에서도 주요 부이 이름이
 *             더 보이되 과밀은 declutter 로 방지한다. hover 중인 마커는 우선순위와 무관하게 항상
 *             노출. 선택된 마커는 라벨을 아예 렌더하지 않아(팝업이 이름을 표시) 팝업과 겹칠 가능성을
 *             원천 차단한다. 라벨 색 = 밝은 글씨(#F1F5FA) + 어두운 halo(text-shadow) — 위성·라이트
 *             베이스 양쪽에서 동일하게 읽힌다(§17, §16 라이트 기본의 "어두운 글씨"는 위성 위에서 안
 *             읽혀 폐기). 마커 좌표·앵커·declutter 좌표계산 자체는 미변경(가시성/후보 조건·rank만).
 * - Popup:    Wave 3b — 드로어와 구분되는 "가벼운 티저" 카드로 재설계. React createRoot 마운트.
 *             글리프/한글명/영문명/(기관명)/상태칩/관측시각(KST, 경과) + 핵심값 3종(파고·풍속+방위·
 *             수온, 임계값 색) + 최근 24h 파고 미니 스파크라인(가벼운 자체 fetch) + 큼직한 "상세" CTA.
 * - Legend:   항상 표시하는 작은 고정 패널 — 글리프·색 스와치가 스스로 설명되도록 설명 문구·형태명
 *             텍스트("원형/삼각형/..")·카운트를 모두 빼고 라벨만 남긴다(잔텍스트 최소화). SE 연안
 *             부이를 가리지 않도록 좌하단에 배치.
 * - Filter:   store.visibleStatuses/visibleCategories(좌패널 체크박스 필터)로 마커도 함께 필터링.
 * - NoData:   무데이터(수신 이력 없음) 지점은 utils/buoys.ts liveBuoys() 단계에서 이미 제외됨.
 * - §25 UHD:  지도 캔버스·마커는 CSS zoom(.uiz) 대상이 아니다(마커는 지도 좌표계 DOM이라 zoom을
 *             걸면 앵커가 어긋난다) — 대신 uiZoom() 로 glyph/라벨/halo px 를 JS 에서 직접 배율해
 *             buildMarkerInnerHTML 에 반영한다. 지도 위에 뜨는 React 오버레이(베이스토글·범례·
 *             필터칩·팝업 내용 wrapper)는 일반 UI 크롬이므로 className="uiz" 로 처리한다. 화면
 *             폭이 §25 브레이크포인트(3300px, UHD 만 — QHD 는 밀도 유지를 위해 배율 없이 1 그대로)를
 *             넘나들 때 마커를 새 배율로 다시 그려야 하므로 debounce 된 resize 리스너가 zoomGen 을
 *             올려 마커 생성 이펙트를 강제 재실행시킨다.
 * - Field:    §26 — 2D 필드 오버레이(바람장 GPU 파티클 WindGL·수온장 래스터 SstGL, `webgl/`).
 *             둘 다 `map.getCanvasContainer()` 의 평범한 DOM 캔버스 자식(마커와 동일 부모) —
 *             명시적 z-index(수온장 4 < 바람장 6 < 마커 20+)로 "마커가 항상 필드 위" 를 보장한다
 *             (형제 요소끼리의 z-index 비교라 canvasContainer/맵 컨테이너가 별도 스태킹 컨텍스트를
 *             만드는지 여부와 무관하게 성립 — 실측 확인 완료). setStyle() 로 베이스맵을 바꿔도 이
 *             캔버스들은 style 이 아니라 Map 소유 DOM 이라 지워지지 않지만, 만일을 대비해
 *             'styledata' 이벤트마다 reattach() 로 부모를 재확인한다(멱등). `/api/field` 는 현재
 *             1프레임만 서빙하므로(타임라인 없음) 5분 간격으로만 재폴링한다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { liveBuoys, relativeFromMinutes, type MergedBuoy } from '../utils/buoys'
import {
  STATUS_BORDER, STATUS_HEX, STATUS_LABEL, STATUS_SOFT, SOURCE_LABEL,
  type BaseLayer, type BuoyStatus, type FieldResponse, type FieldWind, type FieldSst,
  type FieldWireHeader,
} from '../types'
import { waveLevel, THRESHOLD_HEX } from '../utils/thresholds'
import { buoyGlyphSvg, categoryOf, CATEGORY_LABEL, CATEGORY_ORDER } from '../utils/buoyCategory'
import BuoyGlyph from './BuoyGlyph'
import WaveSparkline from './WaveSparkline'
import { detectCaps } from '../webgl/glUtils'
import { WindGL } from '../webgl/windGL'
import { SstGL } from '../webgl/sstGL'
import { windColor, sstColor, WIND_SPEED_MAX, SST_MIN, SST_MAX } from '../webgl/colorRamps'

// ── 지도 상수 ──────────────────────────────────────────────────────────────
const CENTER: [number, number] = [128, 36]
const INIT_ZOOM = 6
// 팬 경계 — 한반도 주변 해역 중심이되, 축소(줌아웃) 여유가 실제로 생기도록 여백을 넉넉히 둔다
// (maxBounds 가 좁으면 minZoom 을 낮춰도 경계 제약 때문에 더 못 빠진다).
const PAN_BOUNDS: maplibregl.LngLatBoundsLike = [[117, 26], [139.5, 44]]

const SAT_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    esri: {
      type: 'raster',
      tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Esri, Maxar, Earthstar Geographics',
    },
  },
  layers: [{ id: 'esri-imagery', type: 'raster', source: 'esri', minzoom: 0, maxzoom: 19 }],
}
const LIGHT_STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-nolabels-gl-style/style.json'
// §26 후속지시 #3(2026-07-16) — 다크 베이스 신규 추가. 무토큰 Carto dark-matter-nolabels,
// positron-nolabels 와 같은 계통(라벨 없는 벡터)이라 정합됨. 실사용 로드 확인 완료.
const DARK_STYLE_URL = 'https://basemaps.cartocdn.com/gl/dark-matter-nolabels-gl-style/style.json'

const ATTRIBUTION = {
  sat: 'Esri, Maxar, Earthstar Geographics',
  light: '© CARTO © OpenStreetMap contributors',
  dark: '© CARTO © OpenStreetMap contributors',
}

function styleForBase(bl: BaseLayer): maplibregl.StyleSpecification | string {
  if (bl === 'light') return LIGHT_STYLE_URL
  if (bl === 'dark') return DARK_STYLE_URL
  return SAT_STYLE
}

// §26 — 2D 필드 오버레이. GPU 지원 여부는 세션 내내 바뀌지 않으므로 모듈 스코프에서 1회만 탐지
// (컴포넌트 리마운트마다 다시 detectCaps() 하지 않는다 — Storm WindOverlayML 과 동일 패턴).
const GL_CAPS = detectCaps()
const USE_GL = GL_CAPS.tier !== 'none'
// `/api/field` 는 매시 +5분에만 새 프레임을 워밍하므로(CLAUDE.md §26) 5분 간격 재폴링으로 충분.
const FIELD_POLL_MS = 5 * 60_000

// §27(2026-07-17) — `/api/field` 이진 프레임 디코드. 와이어 레이아웃은 backend/field_service.py
// 모듈 독스트링 "프레임 계약"이 정본: [0:4) uint32 LE 헤더길이 N, [4:4+N) UTF-8 JSON 헤더
// (FieldWireHeader, types.ts), [4+N:) Int16(LE) 스케일 본문. `scale`/`offset`/`nodata` 는 헤더가
// 필드별로 명시하므로 여기서 하드코딩하지 않는다. 디코드 결과는 이진화 이전과 동일한 논리 모양
// (u/v/data 가 중첩 number 배열)으로 만들어 webgl/windGL·sstGL 렌더러를 전혀 건드리지 않는다.
function decodeInt16Grid(
  buf: ArrayBuffer, byteStart: number, rows: number, cols: number,
  scale: number, offset: number, nodata: number, nullForNodata: boolean,
): (number | null)[][] {
  const flat = new Int16Array(buf, byteStart, rows * cols)
  const out: (number | null)[][] = new Array(rows)
  for (let i = 0; i < rows; i++) {
    const row: (number | null)[] = new Array(cols)
    const base = i * cols
    for (let j = 0; j < cols; j++) {
      const raw = flat[base + j]
      // nodata(육지/결측) — 수온은 null(렌더러가 투명 처리), 바람은 0(예전 JSON 경로에서도
      // null→Float32Array 대입 시 ToNumber(null)===0 으로 사실상 0 이었던 것과 동일한 결과).
      row[j] = raw === nodata ? (nullForNodata ? null : 0) : raw * scale + offset
    }
    out[i] = row
  }
  return out
}

function decodeFieldFrame(buf: ArrayBuffer): FieldResponse {
  const dv = new DataView(buf)
  const headerLen = dv.getUint32(0, true)
  const headerJson = new TextDecoder('utf-8').decode(new Uint8Array(buf, 4, headerLen))
  const header: FieldWireHeader = JSON.parse(headerJson)
  if (!header.ready) return { ready: false, error: header.error }
  const payloadStart = 4 + headerLen

  let wind: FieldWind | undefined
  if (header.wind) {
    const w = header.wind
    wind = {
      valid_kst: w.valid_kst, source: w.source, bounds: w.bounds, rows: w.rows, cols: w.cols,
      u: decodeInt16Grid(buf, payloadStart + w.u_offset, w.rows, w.cols, w.scale, w.offset, w.nodata, false) as number[][],
      v: decodeInt16Grid(buf, payloadStart + w.v_offset, w.rows, w.cols, w.scale, w.offset, w.nodata, false) as number[][],
    }
  }
  let sst: FieldSst | undefined
  if (header.sst) {
    const s = header.sst
    sst = {
      valid_kst: s.valid_kst, source: s.source, bounds: s.bounds, rows: s.rows, cols: s.cols,
      data: decodeInt16Grid(buf, payloadStart + s.data_offset, s.rows, s.cols, s.scale, s.offset, s.nodata, true),
    }
  }
  return { ready: true, wind, sst }
}

// 마커 히트박스 = el 자체의 고정 크기(anchor 기준 박스, 절대 변하지 않음 — 드리프트 방지의 핵심).
// 사용자 피드백(밀도·크기) 반영해 이전 대비 축소 — 카운트 배지 클러스터링을 쓰지 않는 대신
// 저줌에서의 시각적 밀도는 이 작은 코어 크기 + 저채도 색 + 라벨 기본숨김으로만 완화한다.
// §25 — 아래 두 상수는 FHD 기준값. 실제 렌더 시에는 uiZoom() 를 곱해 UHD 에서도 물리적으로 읽히는
// 크기를 유지한다(QHD 는 배율 없이 1 — 밀도 유지. 지도 캔버스 자체는 비스케일이라 마커만 JS 로
// 별도 배율). CORE_D=17 은 UHD(zoom 1.5)에서 글리프가 ≥25px 로 남도록 잡은 하한(17*1.5=25.5) —
// 13이면 19.5px 로 확대 후에도 미니어처처럼 보였다.
const MARKER_BOX = 22
const CORE_D = 17

// §25 — 지도 캔버스·마커는 .uiz(CSS zoom) 대상이 아니므로(마커는 지도 좌표계 DOM), index.css 의
// --ui-zoom 값을 읽어와 marker glyph/라벨/halo px 를 JS 에서 직접 배율한다. 소수 1자리로 반올림.
const uiZoom = (): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom')) || 1
const scalePx = (v: number, z: number): number => Math.round(v * z * 10) / 10

// 고줌 진입 시 겹침 검사 없이 라벨을 전부 노출하는 기준(그 아래는 충돌기반 declutter 적용)
const HIGH_ZOOM_LABEL = INIT_ZOOM + 3.3

// §18-2(2026-07-16) — 저줌에서의 "지저분함"의 최대 원흉이던 정상 라벨 상시노출은 여전히 피하되,
// "기타(파고부이·KHOA) 정상"(labelRankOf 의 rank 3)만 이 임계 미만에서 후보 제외한다. 미수신·지연은
// 물론 **해양기상부이(주요 부이) 정상(rank 2)도 이 임계와 무관하게 항상 후보**로 올라간다 — 국가
// 줌에서 예외 + 주요 부이 이름이 더 보이게 하는 핵심 변경(사용자 지시 "지도에 주요 부이 이름 더
// 표기"). 이 임계 이상이면 기타 정상도 충돌기반 declutter 후보로 합류하고, HIGH_ZOOM_LABEL
// 이상에서는(기존 로직 그대로) 전부 무조건 노출된다.
const NORMAL_LABEL_ZOOM = INIT_ZOOM + 1.6

// declutter 배치 시 라벨 사이 최소 여백(px) — 너무 빡빡하게 붙어 보이지 않도록
const LABEL_DECLUTTER_PAD = 3

// 부이 상태 심각도(마커 z-index 스태킹 우선순위 — 미수신 > 지연 > 정상). 라벨 declutter 우선순위는
// 아래 labelRankOf() 가 별도로 산정한다(카테고리까지 반영하는 더 세분화된 축).
const STATUS_RANK: Record<BuoyStatus, number> = { '미수신': 0, '지연': 1, '정상': 2 }

// §18-2 — 라벨 declutter 우선순위: 미수신(0) > 지연(1) > 해양기상부이(주요 부이) 정상(2) >
// 기타(파고부이·KHOA 해양관측부이) 정상(3). 겹치면 낮은 rank 가 우선(자리를 선점).
function labelRankOf(b: MergedBuoy): number {
  if (b.status !== '정상') return STATUS_RANK[b.status]
  return categoryOf(b) === 'kma-b' ? 2 : 3
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function degToCompass(deg: number | null | undefined): string {
  if (deg == null || !isFinite(deg)) return '-'
  const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
  return dirs[Math.round(deg / 45) % 8]
}

// ── 부이 마커 HTML(el 의 내부 콘텐츠만 — el 자신의 크기/포지션은 생성부에서 고정) ────────────────
// §17 — 값 배지(파고/수온 등)는 완전히 제거했다: 지도는 위치·상태 등 전체 상황 파악용이고,
// 수치는 팝업/상세에서 확인한다. 마커 = 형태(종류)+상태색 채움+흰 보더+소프트섀도+이름 라벨뿐.
function buildMarkerInnerHTML(b: MergedBuoy, selected: boolean, baseLayer: BaseLayer): string {
  const hex = STATUS_HEX[b.status]
  const category = categoryOf(b)
  // §25 — 지도 캔버스·마커는 .uiz 대상이 아니므로 이 함수 안에서 직접 배율(z=1 이면 기존 FHD 값 그대로).
  const z = uiZoom()
  // "살아있는 신호" 브리딩 — 미수신은 더 뚜렷하게(경고), 지연은 은은하게, 정상은 정적(계도적 침묵).
  const pulseClass = b.status === '미수신' ? 'buoy-marker-pulse-alert' : b.status === '지연' ? 'buoy-marker-pulse' : ''
  // 흰 보더 + 소프트 섀도 — 라이트 벡터맵·위성 이미지 양쪽에서 마커가 배경에 묻히지 않도록.
  const strokeColor = selected ? '#ffffff' : 'rgba(255,255,255,0.92)'
  const strokeWidth = scalePx(selected ? 2 : 1.6, z)

  const glyph = buoyGlyphSvg(category, { fill: hex, stroke: strokeColor, strokeWidth, size: scalePx(CORE_D, z) })
  // 다크 소프트 섀도(순검정 저알파) — 위성 텍스처·라이트 벡터 양쪽에서 글리프 윤곽을 살린다.
  const core = `<div class="${pulseClass}" style="display:flex;filter:drop-shadow(0 ${scalePx(1, z)}px ${scalePx(3, z)}px rgba(0,0,0,0.55)) drop-shadow(0 0 ${scalePx(1.5, z)}px rgba(0,0,0,0.4));">${glyph}</div>`
  // §25 — 선택 링은 CSS 고정 px(index.css .buoy-marker-selected-ring) 라 인라인 --mz 변수로 배율 전달.
  const selRing = selected ? `<span class="buoy-marker-selected-ring" style="--mz:${z}"></span>` : ''

  // 라벨(§17 — 밝은 글씨 + 어두운 halo) — 흰/밝은 글자를 짙은 halo 로 감싸 위성 이미지 위에서도,
  // 라이트 벡터맵 위에서도 동일하게 읽히게 한다(배경색 반전 로직 불필요).
  // 선택된 마커는 라벨을 아예 그리지 않는다 — 팝업이 이름을 표시하므로 겹칠 가능성이 없다.
  if (selected) return `${selRing}${core}`

  // QHD 100% 배율에서도 편히 읽히도록 라벨 14px(§25: uiZoom() 로 추가 배율). 라벨 색·halo 는
  // base-aware(§17 재정정 2026-07-16):
  //  - 위성(다크 이미지): 밝은 글씨(#F1F5FA) + 어두운 halo(원래대로).
  //  - 라이트(밝은 벡터맵): 어두운 글씨(#12212E) + 흰 halo — 밝은 배경에서 밝은글씨+어두운halo 가
  //    뿌옇게 뭉개지던 문제 해소(베이스맵 자체 지명처럼 어두운 글씨로 선명하게 읽힘).
  const isLightBase = baseLayer === 'light'
  const nameColor = isLightBase ? '#12212E' : '#F1F5FA'
  const h1 = scalePx(1.4, z), h2 = scalePx(5, z), h3 = scalePx(3, z)
  const nameHalo = isLightBase
    ? `text-shadow:-${h1}px -${h1}px 0 rgba(255,255,255,0.95),${h1}px -${h1}px 0 rgba(255,255,255,0.95),` +
      `-${h1}px ${h1}px 0 rgba(255,255,255,0.95),${h1}px ${h1}px 0 rgba(255,255,255,0.95),` +
      `0 0 ${h2}px rgba(255,255,255,0.9),0 ${scalePx(1, z)}px ${h3}px rgba(255,255,255,0.85);`
    : `text-shadow:-${h1}px -${h1}px 0 rgba(6,10,15,0.9),${h1}px -${h1}px 0 rgba(6,10,15,0.9),` +
      `-${h1}px ${h1}px 0 rgba(6,10,15,0.9),${h1}px ${h1}px 0 rgba(6,10,15,0.9),` +
      `0 0 ${h2}px rgba(0,0,0,0.85), 0 ${scalePx(1, z)}px ${h3}px rgba(0,0,0,0.7);`
  const nameStyle = `font-size:${scalePx(14, z)}px;font-weight:700;color:${nameColor};white-space:nowrap;pointer-events:none;${nameHalo}`
  const label = `<span data-role="name" class="buoy-name-label" style="position:absolute;top:100%;left:50%;` +
    `transform:translateX(-50%);margin-top:${scalePx(4, z)}px;opacity:0;${nameStyle}">${escapeHtml(b.name)}</span>`

  return `${selRing}${core}${label}`
}

// ── 팝업 내용 (React) — Wave 3b "가벼운 티저" 재설계 ──────────────────────
function ValueCell({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    // §26 — flex: 1 1 auto + minWidth: max-content 로 컨텐츠 폭 아래로는 절대 눌리지 않는다(3열이
    // 들어와도 "풍속 · 남서 225°" 같은 긴 라벨이 줄바꿈되는 대신, 부모(팝업)가 옆으로 넓어진다).
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: '8px 9px',
      flex: '1 1 auto', minWidth: 'max-content' }}>
      <div className="eyebrow" style={{ marginBottom: 4, fontSize: 13, whiteSpace: 'nowrap' }}>{label}</div>
      <div className="tnum" style={{ fontSize: 18, fontWeight: 700, color: color ?? 'var(--t-hi)', whiteSpace: 'nowrap' }}>
        {value}{unit && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  )
}

function BuoyPopupContent({ b }: { b: MergedBuoy }) {
  const hex = STATUS_HEX[b.status]
  const category = categoryOf(b)
  const v = b.values
  const cells: { label: string; value: string; unit?: string; color?: string }[] = []
  if (v.wave_height != null) {
    cells.push({ label: '파고', value: v.wave_height.toFixed(1), unit: 'm', color: THRESHOLD_HEX[waveLevel(v.wave_height)] })
  }
  if (v.wind_speed != null) {
    cells.push({ label: `풍속 · ${degToCompass(v.wind_dir)}${v.wind_dir != null ? ` ${Math.round(v.wind_dir)}°` : ''}`, value: v.wind_speed.toFixed(1), unit: 'm/s' })
  }
  if (v.water_temp != null) cells.push({ label: '수온', value: v.water_temp.toFixed(1), unit: '℃' })

  return (
    // §25 — uiz 는 이 내부 콘텐츠 wrapper 에만 건다(popupEl 자체가 아니라) — MapLibre 는 팝업을
    // 감싸는 .maplibregl-popup-content 의 실측 크기로 앵커를 계산하는데, 이 div 가 zoom 으로
    // 커지면 그 실측 크기에 자연히 반영되어 앵커 계산이 어긋나지 않는다.
    <div className="uiz" style={{ padding: '16px 18px 18px', fontFamily: 'var(--font-ui)', color: 'var(--t-mid)', fontSize: 13.5,
      width: 'max-content', minWidth: 272, maxWidth: 420 }}>
      {/* 헤더 — 글리프 + 한글명(대) + 영문 + (기관명) + 상태칩 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, paddingRight: 18, marginBottom: 10 }}>
        <div style={{ minWidth: 0, display: 'flex', alignItems: 'flex-start', gap: 9 }}>
          <div style={{ marginTop: 2, background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: 5, flexShrink: 0 }}>
            <BuoyGlyph category={category} fill={hex} size={17} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 18, color: 'var(--t-hi)', lineHeight: 1.26, letterSpacing: '-0.01em' }}>{b.name}</div>
            <div style={{ fontSize: 13, color: 'var(--t-lo)', marginTop: 2, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {b.name_en && <span>{b.name_en}</span>}
              <span style={{ fontWeight: 600 }}>({SOURCE_LABEL[b.source]})</span>
            </div>
          </div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, color: hex,
          background: STATUS_SOFT[b.status], border: `1px solid ${STATUS_BORDER[b.status]}`,
          borderRadius: 6, padding: '4px 10px 4px 8px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: hex, flexShrink: 0 }} />
          {STATUS_LABEL[b.status]}
        </span>
      </div>

      {/* 관측시각(KST, 경과) — 종류 태그는 제거(§12, 글리프가 모양으로 이미 전달) */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 0', marginBottom: 10,
        borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <span className="tnum" style={{ color: 'var(--t-lo)', fontSize: 13, fontWeight: 500, textAlign: 'right' }}>
          {b.obs_time ? <>{b.obs_time} · {relativeFromMinutes(b.minutes_since)}</> : '관측 이력 없음'}
        </span>
      </div>

      {/* 핵심값 2~3종(임계값 색) — 스파크라인이 뒤따르면 여백 확보, 스파크라인이 없으면(마지막
          콘텐츠) 컨테이너 하단 패딩에만 기대 여백을 중복시키지 않는다. */}
      {cells.length > 0 ? (
        // §26 — 고정 1/3 그리드(gridTemplateColumns: 1fr×N) 대신 flex 행: 각 셀은 자기 컨텐츠
        // 폭만큼만 차지하고(minWidth: max-content, 위 ValueCell), 남는 여백만 균등 배분한다.
        <div style={{ display: 'flex', gap: 6, marginBottom: b.hasLive ? 10 : 0 }}>
          {cells.map(c => <ValueCell key={c.label} {...c} />)}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--t-lo)', padding: '10px 0', textAlign: 'center' }}>
          {b.hasLive ? '표시할 관측값 없음' : '이 데모 범위에서는 실시간 값이 폴링되지 않는 지점입니다'}
        </div>
      )}

      {/* 최근 24h 파고 미니 스파크라인 — 팝업의 마지막 콘텐츠(상세 CTA 제거 후 "작은 현황" 카드로
          축소, ui_revision_notes 신규 클릭 모델: 드로어가 항상 자동으로 열리므로 CTA 는 불필요해졌다).
          하단 여백은 컨테이너 padding(18px)에 맡긴다. */}
      {b.hasLive && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: '7px 9px 5px' }}>
          <div className="eyebrow" style={{ marginBottom: 3, fontSize: 13 }}>최근 1일 파고 추이</div>
          <WaveSparkline source={b.source} id={b.id} />
        </div>
      )}
    </div>
  )
}

function Tag({ label }: { label: string }) {
  // 팝업 카드 자체가 --bg-elev 이므로 칩은 한 단 더 밝은 --bg-hover 로 살짝 떠 보이게 한다.
  return (
    <span className="tnum" style={{ fontSize: 13, fontWeight: 600, color: 'var(--t-mid)',
      background: 'var(--bg-hover)', border: '1px solid var(--line)', borderRadius: 6, padding: '3px 9px' }}>
      {label}
    </span>
  )
}

// ── Main component ──────────────────────────────────────────────────────
export default function MapViewGL() {
  const { stations, live, liveLoadedOnce, baseLayer, setBaseLayer, showWind, showSst, toggleWind, toggleSst,
    selectedStationId, setSelectedStationId, flyToRequest, openDetail,
    closeDetail, detailOpenId, visibleStatuses, visibleCategories, resetFilters } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, liveLoadedOnce: s.liveLoadedOnce,
      baseLayer: s.baseLayer, setBaseLayer: s.setBaseLayer,
      showWind: s.showWind, showSst: s.showSst, toggleWind: s.toggleWind, toggleSst: s.toggleSst,
      selectedStationId: s.selectedStationId, setSelectedStationId: s.setSelectedStationId, flyToRequest: s.flyToRequest,
      openDetail: s.openDetail, closeDetail: s.closeDetail, detailOpenId: s.detailOpenId,
      visibleStatuses: s.visibleStatuses, visibleCategories: s.visibleCategories, resetFilters: s.resetFilters,
    }))
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const popupRootRef = useRef<Root | null>(null)
  const mlPopupRef = useRef<maplibregl.Popup | null>(null)
  const popupBuoyIdRef = useRef<string | null>(null)
  const [mapReady, setMapReady] = useState(false)

  // §26 — 2D 필드 오버레이 상태. `/api/field` 는 항상 "현재 1프레임"만 반환하므로(백엔드가 매시
  // 워밍) 토글 on/off 와 무관하게 백그라운드에서 가볍게 폴링해두고, 실제 GPU 레이어 생성/파괴만
  // 토글에 연동한다 — 켜는 순간 재요청 없이 바로 그려지는 "zero-loading" 체감을 프론트에서도 유지.
  const [fieldData, setFieldData] = useState<FieldResponse | null>(null)
  const windLayerRef = useRef<WindGL | null>(null)
  const sstLayerRef = useRef<SstGL | null>(null)
  // GL 컨텍스트 유실(GPU 드라이버 리셋 등) 복구용 — 레이어 인스턴스를 폐기 후 이 값을 올려
  // 생성 이펙트를 강제 재실행시키면 새 캔버스로 처음부터 다시 만든다.
  const [glReloadTick, setGlReloadTick] = useState(0)
  // §25 — 창 폭이 UHD 브레이크포인트(3300px)를 넘나들면 --ui-zoom 이 바뀌어(QHD 는 배율 없이 1
  // 유지) 마커를 새 배율로 다시 그려야 한다. debounce(200ms) 된 resize 리스너가 이 카운터를 올려 마커 생성
  // 이펙트(아래)를 강제 재실행시킨다 — 이펙트 안에서 zoomGen 변화를 감지하면 기존 마커를 전부
  // 지우고 새 크기로 재생성한다(단순 innerHTML 갱신은 el 자체의 MARKER_BOX 크기를 못 바꾸므로).
  const [zoomGen, setZoomGen] = useState(0)
  const lastZoomGenRef = useRef(0)
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    let lastZ = uiZoom()
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        // 같은 배율 구간 안에서의 resize(예: 창을 조금씩 늘리는 중)는 마커를 다시 그릴 필요가
        // 없다 — --ui-zoom 값 자체가 실제로 바뀐 경우(브레이크포인트를 넘은 경우)에만 재생성.
        const z = uiZoom()
        if (z !== lastZ) { lastZ = z; setZoomGen(g => g + 1) }
      }, 200)
    }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize); if (t) clearTimeout(t) }
  }, [])

  // §26 — `/api/field` 폴링(토글 상태와 무관 — 위 refs 주석 참고). WebGL 미지원 환경(USE_GL=false)
  // 이면 애초에 그릴 수 없으므로 요청 자체를 생략한다(불필요한 트래픽 방지).
  useEffect(() => {
    if (!USE_GL) return
    let cancelled = false
    const load = async () => {
      try {
        const r = await fetch('/api/field')
        if (!r.ok) return
        const buf = await r.arrayBuffer()
        const d = decodeFieldFrame(buf)
        if (!cancelled) setFieldData(d)
      } catch {
        // 조용히 재시도 — ready:false 취급과 동일하게 토글은 비활성 유지(§26 지시사항)
      }
    }
    load()
    const id = setInterval(load, FIELD_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  // 무데이터(수신 이력 없음) 지점은 이미 여기서 제외된 데이터셋 — 지도에는 정상/지연/미수신만 존재
  const buoys = useMemo(() => liveBuoys(stations, live), [stations, live])
  const buoysRef = useRef(buoys)
  buoysRef.current = buoys

  // 좌패널 체크박스 필터(상태·종류)와 동일 소스 — 지도 마커도 함께 좁혀진다
  const visibleBuoys = useMemo(() => buoys.filter(b =>
    visibleStatuses.has(b.status) &&
    visibleCategories.has(categoryOf(b))
  ), [buoys, visibleStatuses, visibleCategories])
  const filterActive = visibleStatuses.size < 3 || visibleCategories.size < CATEGORY_ORDER.length

  // ── 팝업 렌더 (마커 클릭 / flyTo 공용) ──────────────────────────────────
  const openPopupFor = useCallback((b: MergedBuoy) => {
    if (!popupRootRef.current || !mlPopupRef.current || !mapRef.current) return
    popupBuoyIdRef.current = b.id
    popupRootRef.current.render(<BuoyPopupContent b={b} />)
    mlPopupRef.current.setLngLat([b.lon, b.lat]).addTo(mapRef.current)
  }, [])

  // 실시간 폴링으로 값이 갱신되면 열려있는 팝업도 최신값으로 리렌더
  useEffect(() => {
    if (!popupBuoyIdRef.current || !mlPopupRef.current?.isOpen()) return
    const b = buoys.find(x => x.id === popupBuoyIdRef.current)
    if (b) popupRootRef.current?.render(<BuoyPopupContent b={b} />)
  }, [buoys])

  // F2 — 드로어 ‹ › 내비(openDetail(다른 id))는 selectedStationId 는 갱신하지만(store.openDetail
  // 참고) 지도 팝업은 별도 상태(popupBuoyIdRef)라 그대로 남아있었다 — 드로어는 부이 A→B 로
  // 넘어갔는데 지도 팝업은 여전히 A 를 보여주는 "동시에 다른 부이 두 개" 상태가 발생. 열린
  // 팝업의 부이가 지금 드로어가 보여주는 부이(detailOpenId)와 다르면 팝업을 닫아 불일치를 없앤다
  // (카메라를 이동시키는 flyTo 는 쓰지 않음 — 드로어 내비 순서가 이름순이라 지도가 매번 먼 곳으로
  // 튀는 게 더 산만하다).
  // 신규 클릭 모델(2026-07-16) — 드로어가 열려있는 동안 ‹ › 내비로 detailOpenId 가 바뀌면 지도의
  // 선택 링(selectedStationId)도 그 부이를 따라가야 팝업/선택/드로어 3자가 항상 같은 부이를
  // 가리킨다. 카메라 flyTo 는 의도적으로 하지 않는다(내비 순서가 이름순이라 지도가 매번 먼 곳으로
  // 튀는 게 더 산만함). 가드 `if (!detailOpenId) return` 이 먼저이므로 토글-오프 경로(마커 재클릭 →
  // setSelectedStationId(null)+closeDetail() 이 이미 둘 다 비움)와 절대 충돌하지 않는다 — 여기 도달할
  // 때는 항상 드로어가 열려있는 상태다.
  useEffect(() => {
    if (!detailOpenId) return
    if (popupBuoyIdRef.current && popupBuoyIdRef.current !== detailOpenId && mlPopupRef.current?.isOpen()) {
      mlPopupRef.current.remove()
    }
    setSelectedStationId(detailOpenId)
  }, [detailOpenId, setSelectedStationId])

  // ── 지도 초기화 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: styleForBase(useStore.getState().baseLayer),
      center: CENTER,
      zoom: INIT_ZOOM,
      minZoom: 3.6,
      maxZoom: 14,
      maxBounds: PAN_BOUNDS,
      attributionControl: false,
    })

    map.addControl(new maplibregl.NavigationControl({ showCompass: false, showZoom: true }), 'top-right')

    const popupEl = document.createElement('div')
    const popupRoot = createRoot(popupEl)
    popupRootRef.current = popupRoot
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '332px', className: 'buoy-ml-popup' })
      .setDOMContent(popupEl)
    mlPopupRef.current = popup
    popup.on('close', () => { popupBuoyIdRef.current = null })

    map.on('load', () => {
      setMapReady(true)
      if (import.meta.env.DEV) (window as any).__map = map
    })

    // 신규 클릭 모델(2026-07-16) — 빈 바다(마커 없는 지점) 클릭 시 팝업·선택·드로어를 전부 닫는다.
    // 마커 클릭 핸들러는 stopPropagation 을 걸어두므로, 여기까지 올라오는 'click' 은 항상 배경
    // 클릭이다. MapLibre 는 드래그(팬)로 끝난 제스처에는 'click' 을 발생시키지 않으므로 팬/줌은
    // 영향받지 않는다 — 실제 클릭(탭)에서만 닫힌다.
    map.on('click', () => {
      useStore.getState().setSelectedStationId(null)
      useStore.getState().closeDetail()
      popup.remove()
    })

    mapRef.current = map

    const ro = new ResizeObserver(() => map.resize())
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      popup.remove()
      setTimeout(() => popupRoot.unmount(), 0)
      map.remove()
      mapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 베이스 레이어 토글 ───────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    map.setStyle(styleForBase(baseLayer))
  }, [baseLayer, mapReady])

  // ── §26 setStyle() 안전망 — 필드 캔버스 재부착 ──────────────────────────
  // 이 캔버스들은 style 이 아니라 Map 소유 DOM(getCanvasContainer())의 평범한 자식이라
  // setStyle() 로 지워지지 않는다(실측 확인 완료 — 위 헤더 주석 참고)지만, 방어적으로
  // 'styledata' 마다 부모를 재확인한다(멱등 — parentElement 가 이미 맞으면 아무 일도 안 함).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const reattach = () => {
      windLayerRef.current?.reattach()
      sstLayerRef.current?.reattach()
    }
    map.on('styledata', reattach)
    return () => { map.off('styledata', reattach) }
  }, [mapReady])

  // ── §26 바람장(GPU 파티클) 레이어 ────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const wind = fieldData?.ready ? fieldData.wind : undefined
    if (!USE_GL || !showWind || !wind) {
      if (windLayerRef.current) { windLayerRef.current.remove(); windLayerRef.current = null }
      return
    }
    if (!windLayerRef.current) {
      windLayerRef.current = new WindGL(map, wind, GL_CAPS, () => {
        // GL 컨텍스트 유실 — 인스턴스를 폐기하고 다음 틱에 새 캔버스로 재생성(수동 토글
        // off→on 과 동일한 복구 경로).
        windLayerRef.current?.remove()
        windLayerRef.current = null
        setGlReloadTick(t => t + 1)
      })
    } else {
      windLayerRef.current.setData(wind)
    }
  }, [mapReady, showWind, fieldData, glReloadTick])

  // ── §26 수온장(래스터) 레이어 ────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    const sst = fieldData?.ready ? fieldData.sst : undefined
    if (!USE_GL || !showSst || !sst) {
      if (sstLayerRef.current) { sstLayerRef.current.remove(); sstLayerRef.current = null }
      return
    }
    if (!sstLayerRef.current) {
      sstLayerRef.current = new SstGL(map, sst, GL_CAPS, () => {
        sstLayerRef.current?.remove()
        sstLayerRef.current = null
        setGlReloadTick(t => t + 1)
      })
    } else {
      sstLayerRef.current.setData(sst)
    }
  }, [mapReady, showSst, fieldData, glReloadTick])

  // 언마운트 시 GL 리소스 확실히 정리(rAF·리스너·캔버스 — WindGL/SstGL.remove() 가 전담).
  useEffect(() => () => {
    windLayerRef.current?.remove(); windLayerRef.current = null
    sstLayerRef.current?.remove(); sstLayerRef.current = null
  }, [])

  // ── 라벨 가시성(§12 전문가 패널 재조정 — 정상 라벨 상시노출이 "지저분함"의 원흉이었다) ──────────
  //    저줌(NORMAL_LABEL_ZOOM 미만): 정상 라벨은 후보에서 아예 제외 — 지연·미수신·hover만 노출.
  //    NORMAL_LABEL_ZOOM 이상: 정상도 충돌기반 declutter 후보로 합류(심각도 우선순위로 자리 선점).
  //    HIGH_ZOOM_LABEL 이상: 겹침 검사 자체를 생략해 전부 노출(줌 진행형 — 확대할수록 더 드러남).
  //    hover 중인 마커는 항상 표시. 선택된 마커는 라벨 자체가 없다(팝업이 이름 표시).
  const updateLabelVisibility = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    type Box = { left: number; right: number; top: number; bottom: number }
    const overlap = (a: Box, b: Box, pad: number) =>
      a.left <= b.right + pad && a.right >= b.left - pad && a.top <= b.bottom + pad && a.bottom >= b.top - pad

    const zoom = map.getZoom()
    const highZoom = zoom >= HIGH_ZOOM_LABEL
    const showNormal = zoom >= NORMAL_LABEL_ZOOM
    const setVis = (nameEl: HTMLElement, v: string) => { nameEl.style.opacity = v }
    const hoverEntries: { nameEl: HTMLElement; rect: Box }[] = []
    const entries: { nameEl: HTMLElement; rank: number; rect: Box }[] = []

    markersRef.current.forEach((marker) => {
      const el = marker.getElement()
      const nameEl = el.querySelector<HTMLElement>('[data-role="name"]')
      if (!nameEl) return
      const isHover = el.dataset.hover === '1'
      if (isHover) {
        hoverEntries.push({ nameEl, rect: nameEl.getBoundingClientRect() })
        return
      }
      // 저줌에서는 "기타 정상"(rank 3 — 파고부이·KHOA)만 충돌 검사 후보에도 올리지 않고 즉시
      // 숨긴다(§18-2). rank 0~2(미수신·지연·해양기상부이 정상=주요 부이)는 이 임계와 무관하게
      // 항상 후보로 남아 겹침 기반 declutter 를 거친다.
      const rank = parseInt(el.dataset.rank ?? '9')
      if (rank >= 3 && !showNormal) {
        setVis(nameEl, '0')
        return
      }
      entries.push({ nameEl, rank, rect: nameEl.getBoundingClientRect() })
    })

    const placed: Box[] = []
    // hover 는 사용자가 지금 가리키는 마커 — 겹침 여부와 무관하게 항상 표시
    for (const e of hoverEntries) { setVis(e.nameEl, '1'); placed.push(e.rect) }
    // 나머지는 심각도(미수신>지연>정상) 우선순위로 자리 선점. 고줌에서는 겹침 검사를 생략(전부 노출).
    entries.sort((a, b) => a.rank - b.rank)
    for (const e of entries) {
      const r = e.rect
      if (r.right <= r.left) { setVis(e.nameEl, '0'); continue }
      if (!highZoom && placed.some(p => overlap(r, p, LABEL_DECLUTTER_PAD))) {
        setVis(e.nameEl, '0')
      } else {
        setVis(e.nameEl, '1')
        placed.push(r)
      }
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    let raf = 0
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; updateLabelVisibility() }) }
    map.on('move', schedule)
    schedule()
    return () => { map.off('move', schedule); if (raf) cancelAnimationFrame(raf) }
  }, [mapReady, updateLabelVisibility])

  // ── 부이 HTML 마커 생성/갱신(항상 모든 visibleBuoys 를 개별 마커로 — 카운트 배지로 묶지 않는다) ──
  //    el 자신은 항상 MARKER_BOX 고정 크기 + anchor='center' — 어떤 내부 콘텐츠 변화(라벨 유무 등)도
  //    el 의 바운딩박스에 영향을 주지 않으므로 글리프 중심이 좌표에서 절대 밀리지 않는다.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const existing = markersRef.current

    // §25 — zoomGen 이 바뀌었다(브레이크포인트를 넘는 resize) 는 것은 --ui-zoom 이 바뀌어 el 의
    // MARKER_BOX 고정 크기 자체를 다시 잡아야 한다는 뜻 — 단순 innerHTML 갱신으론 el 크기를 못
    // 바꾸므로 기존 마커를 전부 지워 아래 루프가 전부 새 배율로 재생성하게 한다.
    if (lastZoomGenRef.current !== zoomGen) {
      lastZoomGenRef.current = zoomGen
      for (const [, m] of existing) m.remove()
      existing.clear()
    }

    const z = uiZoom()
    const markerBox = scalePx(MARKER_BOX, z)
    const validIds = new Set(visibleBuoys.filter(b => isFinite(b.lat) && isFinite(b.lon)).map(b => b.id))

    for (const [id, m] of existing) {
      if (!validIds.has(id)) { m.remove(); existing.delete(id) }
    }

    for (const b of visibleBuoys) {
      if (!isFinite(b.lat) || !isFinite(b.lon)) continue
      const isSel = b.id === selectedStationId
      const zIndex = String(isSel ? 40 : 20 + (2 - STATUS_RANK[b.status]))

      if (existing.has(b.id)) {
        const marker = existing.get(b.id)!
        const el = marker.getElement()
        const prevStatus = el.dataset.status
        const prevSel = el.dataset.sel === '1'
        const prevBase = el.dataset.base
        if (prevStatus !== b.status || prevSel !== isSel || prevBase !== baseLayer) {
          el.innerHTML = buildMarkerInnerHTML(b, isSel, baseLayer)
          el.dataset.status = b.status
          el.dataset.rank = String(labelRankOf(b))
          el.dataset.sel = isSel ? '1' : '0'
          el.dataset.base = baseLayer
          el.style.zIndex = zIndex
        }
      } else {
        const el = document.createElement('div')
        // 고정 크기 박스(anchor='center' 기준) — 내부에 position:absolute 로 얹는 라벨/링은
        // 이 박스 크기에 전혀 영향을 주지 않는다(줌 드리프트 방지의 핵심 불변식). §25: markerBox 는
        // MARKER_BOX*uiZoom() — QHD/UHD 에서도 물리적으로 같은 크기로 읽히도록.
        el.style.cssText = `display:flex;align-items:center;justify-content:center;cursor:pointer;` +
          `position:absolute;top:0;left:0;width:${markerBox}px;height:${markerBox}px;overflow:visible;`
        el.style.zIndex = zIndex
        el.dataset.id = b.id
        el.dataset.status = b.status
        el.dataset.rank = String(labelRankOf(b))
        el.dataset.sel = isSel ? '1' : '0'
        el.dataset.base = baseLayer
        el.dataset.hover = '0'
        el.innerHTML = buildMarkerInnerHTML(b, isSel, baseLayer)
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          const cur = useStore.getState().selectedStationId
          if (b.id === cur) {
            // 토글-오프 — 이미 선택된 마커를 다시 클릭하면 팝업·선택·드로어를 전부 닫는다.
            setSelectedStationId(null)
            closeDetail()
            mlPopupRef.current?.remove()
            return
          }
          // 신규 클릭 모델 — 마커 클릭 시 팝업과 상세 드로어를 함께 연다(단일 클릭으로 둘 다).
          setSelectedStationId(b.id)
          openDetail(b.id)
          const latest = buoysRef.current.find(x => x.id === b.id) ?? b
          openPopupFor(latest)
        })
        el.addEventListener('mouseenter', () => { el.dataset.hover = '1'; updateLabelVisibility() })
        el.addEventListener('mouseleave', () => { el.dataset.hover = '0'; updateLabelVisibility() })
        const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([b.lon, b.lat]).addTo(map)
        existing.set(b.id, marker)
      }
    }
    requestAnimationFrame(updateLabelVisibility)
  }, [visibleBuoys, mapReady, selectedStationId, baseLayer, zoomGen, updateLabelVisibility, setSelectedStationId, openPopupFor, openDetail, closeDetail])

  // ── 좌측 패널에서 flyTo 요청 처리 ────────────────────────────────────
  // 기존: 카메라 flyTo → moveend 시 팝업만 열었다(선택은 store.requestFlyTo 자체가
  // selectedStationId 를 이미 세팅). 신규 클릭 모델(2026-07-16) — 여기서 openDetail(id) 도 함께
  // 호출해 좌패널 행 클릭 시 flyTo+팝업+드로어가 한 번에 모두 열리게 한다(카메라 이동을 기다릴
  // 필요 없는 드로어는 즉시 열고, 팝업만 지도 위치가 확정되는 moveend 까지 기다린다).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !flyToRequest) return
    const b = buoysRef.current.find(x => x.id === flyToRequest.id)
    if (!b || !isFinite(b.lat) || !isFinite(b.lon)) return
    openDetail(b.id)
    map.flyTo({ center: [b.lon, b.lat], zoom: Math.max(map.getZoom(), 8.5), speed: 1.1, curve: 1.3 })
    const onMoveEnd = () => { openPopupFor(b); map.off('moveend', onMoveEnd) }
    map.on('moveend', onMoveEnd)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyToRequest, mapReady])

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />

      {/* 위성 베이스 스크림 — 초록/갈색 텍스처를 살짝 죽여 마커 색이 도드라지게(마커 자체는 영향 없음) */}
      {baseLayer === 'sat' && (
        <div className="map-sat-scrim" style={{ position: 'absolute', inset: 0, zIndex: 3, pointerEvents: 'none' }} />
      )}

      {/* 로딩 오버레이 — 최초 실시간 자료 수신 전 */}
      {!liveLoadedOnce && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 950, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(15,20,27,0.86)' }}>
          <div style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid var(--line)',
            borderTopColor: 'var(--accent)', animation: 'spin 0.9s linear infinite' }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-hi)' }}>부이 실시간 자료를 불러오는 중…</div>
        </div>
      )}

      {/* 베이스 레이어 전환(위성|라이트|다크 세그먼트 컨트롤 — §26 후속지시 #3, 순환버튼 폐기) +
          그 아래 바람장/수온장 독립 on/off 토글(§26). §25: uiz(지도 위 React 오버레이는 일반
          UI 크롬이라 zoom 대상) */}
      <div className="uiz" style={{ position: 'absolute', top: 12, left: 12, zIndex: 900, display: 'flex',
        flexDirection: 'column', gap: 6, alignItems: 'flex-start', animation: 'fade-in 0.4s ease both' }}>
        <BaseLayerSegmented baseLayer={baseLayer} onSelect={setBaseLayer} />
        <div style={{ display: 'flex', gap: 6 }}>
          <FieldToggleBtn label="바람장" active={showWind} disabled={!USE_GL || !fieldData?.ready || !fieldData.wind} onClick={toggleWind} />
          <FieldToggleBtn label="수온장" active={showSst} disabled={!USE_GL || !fieldData?.ready || !fieldData.sst} onClick={toggleSst} />
        </div>
      </div>

      {/* 부이 수 칩 — 필터 미적용 시 숨김(§12: KPI·좌패널 '총 N개소'와 3중 중복). 필터가 좁혀졌을
          때만 "N/137 · 필터 적용중"으로 노출해 지금 화면이 전체가 아님을 알려준다. */}
      {filterActive && (
        <div className="uiz" style={{ position: 'absolute', top: 12, right: 12, zIndex: 900, animation: 'fade-in 0.4s ease both' }}>
          <button onClick={resetFilters} title="클릭하면 필터 해제" className="glass-chip tnum" style={{
            borderRadius: 6, padding: '5px 11px', fontSize: 13, fontWeight: 600, color: 'var(--t-hi)',
            cursor: 'pointer', font: 'inherit', margin: 0, transition: 'background 0.12s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-float)' }}>
            부이 {visibleBuoys.length}/{buoys.length}개소
            <span style={{ marginLeft: 7, color: 'var(--accent-h)', fontWeight: 700 }}>· 필터 적용중</span>
            <span style={{ marginLeft: 4, fontSize: 13, color: 'var(--accent-h)' }}>×</span>
          </button>
        </div>
      )}

      {/* 범례 — 부이 유형/수신상태(항상) + 그 우측에 필드(바람장/수온장) 범례.
          사용자 지시(2026-07-20): 필드 범례를 부이 범례 우측에 붙이고, 두 필드를 모두 끄면
          필드 범례는 사라진다(아래 조건부 렌더). 좌하단 한 컨테이너에 가로로 나란히 두되 하단
          정렬(flex-end)이라 높이가 달라도 바닥선이 맞고, 필드 범례가 빠지면 부이 범례만 홀로 남는다. */}
      <div className="uiz" style={{ position: 'absolute', left: 12, bottom: 34, zIndex: 900, display: 'flex', flexDirection: 'row', alignItems: 'stretch', gap: 10, animation: 'fade-in 0.5s ease both' }}>
        <div className="map-legend" style={{ borderRadius: 10, padding: '10px 13px 11px', display: 'flex', flexDirection: 'column', gap: 9, minWidth: 150 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--t-lo)' }}>부이 유형</span>
            {CATEGORY_ORDER.map(cat => (
              <span key={cat} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <BuoyGlyph category={cat} fill="var(--t-mid)" stroke="var(--line)" strokeWidth={1.1} size={13} />
                <span style={{ fontSize: 13, color: 'var(--t-hi)', fontWeight: 600, whiteSpace: 'nowrap' }}>{CATEGORY_LABEL[cat]}</span>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6,
            borderTop: '1px solid var(--line)', paddingTop: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--t-lo)' }}>수신 상태</span>
            {(['정상', '지연', '미수신'] as BuoyStatus[]).map(st => (
              <span key={st} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className={st === '미수신' ? 'buoy-marker-pulse-alert' : st === '지연' ? 'buoy-marker-pulse' : undefined}
                  style={{ width: 9, height: 9, borderRadius: '50%', background: STATUS_HEX[st], flexShrink: 0,
                    border: '1px solid rgba(255,255,255,0.9)', boxShadow: '0 0 0 1px ' + STATUS_HEX[st] + '55' }} />
                <span style={{ fontSize: 13, color: 'var(--t-hi)', fontWeight: 600, whiteSpace: 'nowrap' }}>{STATUS_LABEL[st]}</span>
              </span>
            ))}
          </div>
        </div>

        {/* 필드(바람장/수온장) 범례 — 부이 범례 우측. 두 필드 모두 OFF 면 렌더 안 됨. 켜진 필드만 행 표시. */}
        {(showWind || showSst) && fieldData?.ready && (fieldData.wind || fieldData.sst) && (
          <div className="map-legend" style={{ borderRadius: 10, padding: '9px 12px 10px', display: 'flex',
            flexDirection: 'column', justifyContent: 'center', gap: 7, minWidth: 148, maxWidth: 196 }}>
            <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--t-lo)' }}>
              필드(모델·위성 자료)
            </span>
            {showWind && fieldData.wind && <FieldLegendRow kind="wind" field={fieldData.wind} />}
            {showWind && fieldData.wind && showSst && fieldData.sst && (
              <div style={{ borderTop: '1px solid var(--line)' }} />
            )}
            {showSst && fieldData.sst && <FieldLegendRow kind="sst" field={fieldData.sst} />}
          </div>
        )}
      </div>

      {/* 저작권 표기 (attributionControl 대체 — 최소 표기, 지도 규약상 관례적으로 작게 유지).
          베이스 레이어별로 문자색을 뒤집는다 — 라이트 벡터맵 위엔 어두운 글자+밝은 헤일로,
          위성 이미지 위엔 흰 글자+어두운 헤일로. */}
      <div style={{ position: 'absolute', bottom: 4, left: 8, zIndex: 900, fontSize: 11,
        color: baseLayer === 'light' ? 'rgba(20,33,46,0.62)' : 'rgba(255,255,255,0.6)',
        textShadow: baseLayer === 'light' ? '0 1px 1px rgba(255,255,255,0.7)' : '0 1px 2px rgba(0,0,0,0.85)',
        pointerEvents: 'none' }}>
        {ATTRIBUTION[baseLayer]}
      </div>
    </div>
  )
}

// ── §26 후속지시 #3(2026-07-16) — 베이스맵 세그먼트 컨트롤: 위성|라이트|다크 3개가 가로로 붙은
// 하나의 컨트롤. 순환 버튼(이전 BaseLayerToggleBtn, 화살표 아이콘)을 폐기하고 명시적 선택 UI 로
// 교체 — 선택된 세그먼트만 진한 배경(--accent-100)으로 대비, 나머지는 투명. 세그먼트 사이 구분선.
const BASE_LAYER_SEGMENTS: { key: BaseLayer; label: string }[] = [
  { key: 'sat', label: '위성' },
  { key: 'light', label: '라이트' },
  { key: 'dark', label: '다크' },
]

function BaseLayerSegmented({ baseLayer, onSelect }: { baseLayer: BaseLayer; onSelect: (v: BaseLayer) => void }) {
  // §20 — 지도 위에 떠 있는 컨트롤이라 카드(--bg-elev)보다 밝은 --bg-float 로 표고(범례·줌컨트롤과 동일 톤).
  return (
    <div role="group" aria-label="지도 배경 선택" style={{
      display: 'inline-flex', borderRadius: 6, overflow: 'hidden',
      background: 'var(--bg-float)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-card)',
    }}>
      {BASE_LAYER_SEGMENTS.map((seg, i) => {
        const active = baseLayer === seg.key
        return (
          <button key={seg.key} onClick={() => onSelect(seg.key)} aria-pressed={active}
            title={`지도 배경: ${seg.label}`} style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '7px 13px', cursor: active ? 'default' : 'pointer', fontSize: 13,
              fontWeight: active ? 700 : 600, font: 'inherit',
              background: active ? 'var(--accent-100)' : 'transparent',
              color: active ? 'var(--accent-h)' : 'var(--t-mid)',
              border: 'none', borderLeft: i > 0 ? '1px solid var(--line)' : 'none',
              transition: 'background 0.12s, color 0.12s',
            }}
            onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--bg-hover)' }}
            onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent' }}>
            {seg.label}
          </button>
        )
      })}
    </div>
  )
}

// ── §26 필드(바람장/수온장) on/off 토글 — 서로 배타 아님, 자료 미준비 시(ready:false) 비활성 ──
function FieldToggleBtn({ label, active, disabled, onClick }: {
  label: string; active: boolean; disabled: boolean; onClick: () => void
}) {
  return (
    <button onClick={onClick} disabled={disabled} aria-pressed={active}
      title={disabled ? '자료 준비 중' : undefined} style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 12px', borderRadius: 6, fontSize: 12.5, fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
        background: active ? 'var(--accent-100)' : 'var(--bg-float)',
        border: `1px solid ${active ? 'var(--accent-dim)' : 'var(--line)'}`,
        color: disabled ? 'var(--t-lo)' : (active ? 'var(--accent-h)' : 'var(--t-mid)'),
        opacity: disabled ? 0.5 : 1,
        boxShadow: 'var(--shadow-card)',
        transition: 'background 0.12s, border-color 0.12s, color 0.12s, opacity 0.12s',
      }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: active ? 'var(--accent-h)' : 'var(--t-lo)', opacity: active ? 1 : 0.6 }} />
      {label}
    </button>
  )
}

// ── §26 필드 범례 — 색 그라디언트 바 + 최소/최대 값 + 출처/기준시각(모델·위성 자료임을 명시,
//    "KST" 문자열은 절대 쓰지 않는다 — 시각값(valid_kst)은 이미 "YYYY-MM-DD HH:MM" 그대로 표기) ──
function fieldGradientCss(colorFn: (v: number) => [number, number, number], min: number, max: number): string {
  const stops = [0, 0.25, 0.5, 0.75, 1].map(t => {
    const [r, g, b] = colorFn(min + t * (max - min))
    return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)}) ${Math.round(t * 100)}%`
  })
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

function FieldLegendRow({ kind, field }: { kind: 'wind' | 'sst'; field: FieldWind | FieldSst }) {
  const isWind = kind === 'wind'
  const gradient = isWind ? fieldGradientCss(windColor, 0, WIND_SPEED_MAX) : fieldGradientCss(sstColor, SST_MIN, SST_MAX)
  const unit = isWind ? ' m/s' : '℃'
  const lo = isWind ? '0' : `${SST_MIN}`
  const hi = isWind ? `${WIND_SPEED_MAX}+` : `${SST_MAX}+`
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t-hi)' }}>{isWind ? '바람장' : '수온장'}</span>
      <div style={{ height: 7, borderRadius: 4, background: gradient, border: '1px solid var(--line)' }} />
      <div className="tnum" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--t-lo)' }}>
        <span>{lo}{unit}</span>
        <span>{hi}{unit}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t-lo)', lineHeight: 1.4, wordBreak: 'keep-all' }}>
        {field.source} · {field.valid_kst}
      </div>
    </div>
  )
}
