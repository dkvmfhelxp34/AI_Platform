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
  type BaseLayer, type BuoyStatus,
} from '../types'
import { waveLevel, THRESHOLD_HEX } from '../utils/thresholds'
import { buoyGlyphSvg, categoryOf, CATEGORY_LABEL, CATEGORY_ORDER } from '../utils/buoyCategory'
import BuoyGlyph from './BuoyGlyph'
import WaveSparkline from './WaveSparkline'

// ── 지도 상수 ──────────────────────────────────────────────────────────────
const CENTER: [number, number] = [128, 36]
const INIT_ZOOM = 6
const PAN_BOUNDS: maplibregl.LngLatBoundsLike = [[121, 28.5], [135.5, 41.5]]

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
const LIGHT_STYLE_URL = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'

const ATTRIBUTION = {
  sat: 'Esri, Maxar, Earthstar Geographics',
  light: '© CARTO © OpenStreetMap contributors',
}

// 마커 히트박스 = el 자체의 고정 크기(anchor 기준 박스, 절대 변하지 않음 — 드리프트 방지의 핵심).
// 사용자 피드백(밀도·크기) 반영해 이전 대비 축소 — 카운트 배지 클러스터링을 쓰지 않는 대신
// 저줌에서의 시각적 밀도는 이 작은 코어 크기 + 저채도 색 + 라벨 기본숨김으로만 완화한다.
const MARKER_BOX = 22
const CORE_D = 13

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
  // "살아있는 신호" 브리딩 — 미수신은 더 뚜렷하게(경고), 지연은 은은하게, 정상은 정적(계도적 침묵).
  const pulseClass = b.status === '미수신' ? 'buoy-marker-pulse-alert' : b.status === '지연' ? 'buoy-marker-pulse' : ''
  // 흰 보더 + 소프트 섀도 — 라이트 벡터맵·위성 이미지 양쪽에서 마커가 배경에 묻히지 않도록.
  const strokeColor = selected ? '#ffffff' : 'rgba(255,255,255,0.92)'
  const strokeWidth = selected ? 2 : 1.6

  const glyph = buoyGlyphSvg(category, { fill: hex, stroke: strokeColor, strokeWidth, size: CORE_D })
  // 다크 소프트 섀도(순검정 저알파) — 위성 텍스처·라이트 벡터 양쪽에서 글리프 윤곽을 살린다.
  const core = `<div class="${pulseClass}" style="display:flex;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.55)) drop-shadow(0 0 1.5px rgba(0,0,0,0.4));">${glyph}</div>`
  const selRing = selected ? '<span class="buoy-marker-selected-ring"></span>' : ''

  // 라벨(§17 — 밝은 글씨 + 어두운 halo) — 흰/밝은 글자를 짙은 halo 로 감싸 위성 이미지 위에서도,
  // 라이트 벡터맵 위에서도 동일하게 읽히게 한다(배경색 반전 로직 불필요).
  // 선택된 마커는 라벨을 아예 그리지 않는다 — 팝업이 이름을 표시하므로 겹칠 가능성이 없다.
  if (selected) return `${selRing}${core}`

  // QHD 100% 배율에서도 편히 읽히도록 라벨 14px. 라벨 색·halo 는 base-aware(§17 재정정 2026-07-16):
  //  - 위성(다크 이미지): 밝은 글씨(#F1F5FA) + 어두운 halo(원래대로).
  //  - 라이트(밝은 벡터맵): 어두운 글씨(#12212E) + 흰 halo — 밝은 배경에서 밝은글씨+어두운halo 가
  //    뿌옇게 뭉개지던 문제 해소(베이스맵 자체 지명처럼 어두운 글씨로 선명하게 읽힘).
  const isLightBase = baseLayer === 'light'
  const nameColor = isLightBase ? '#12212E' : '#F1F5FA'
  const nameHalo = isLightBase
    ? `text-shadow:-1.4px -1.4px 0 rgba(255,255,255,0.95),1.4px -1.4px 0 rgba(255,255,255,0.95),` +
      `-1.4px 1.4px 0 rgba(255,255,255,0.95),1.4px 1.4px 0 rgba(255,255,255,0.95),` +
      `0 0 5px rgba(255,255,255,0.9),0 1px 3px rgba(255,255,255,0.85);`
    : `text-shadow:-1.4px -1.4px 0 rgba(6,10,15,0.9),1.4px -1.4px 0 rgba(6,10,15,0.9),` +
      `-1.4px 1.4px 0 rgba(6,10,15,0.9),1.4px 1.4px 0 rgba(6,10,15,0.9),` +
      `0 0 5px rgba(0,0,0,0.85), 0 1px 3px rgba(0,0,0,0.7);`
  const nameStyle = `font-size:14px;font-weight:700;color:${nameColor};white-space:nowrap;pointer-events:none;${nameHalo}`
  const label = `<span data-role="name" class="buoy-name-label" style="position:absolute;top:100%;left:50%;` +
    `transform:translateX(-50%);margin-top:4px;opacity:0;${nameStyle}">${escapeHtml(b.name)}</span>`

  return `${selRing}${core}${label}`
}

// ── 팝업 내용 (React) — Wave 3b "가벼운 티저" 재설계 ──────────────────────
function ValueCell({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: '8px 9px' }}>
      <div className="eyebrow" style={{ marginBottom: 4, fontSize: 13 }}>{label}</div>
      <div className="tnum" style={{ fontSize: 18, fontWeight: 700, color: color ?? 'var(--t-hi)' }}>
        {value}{unit && <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 2 }}>{unit}</span>}
      </div>
    </div>
  )
}

function BuoyPopupContent({ b, onDetail }: { b: MergedBuoy; onDetail: (id: string) => void }) {
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
    <div style={{ padding: '16px 18px', fontFamily: 'var(--font-ui)', color: 'var(--t-mid)', fontSize: 13.5, width: 296 }}>
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
          {b.obs_time ? <>{b.obs_time} KST · {relativeFromMinutes(b.minutes_since)}</> : '관측 이력 없음'}
        </span>
      </div>

      {/* 핵심값 2~3종(임계값 색) */}
      {cells.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, 1fr)`, gap: 6, marginBottom: 10 }}>
          {cells.map(c => <ValueCell key={c.label} {...c} />)}
        </div>
      ) : (
        <div style={{ fontSize: 13, color: 'var(--t-lo)', padding: '10px 0', textAlign: 'center' }}>
          {b.hasLive ? '표시할 관측값 없음' : '이 데모 범위에서는 실시간 값이 폴링되지 않는 지점입니다'}
        </div>
      )}

      {/* 최근 24h 파고 미니 스파크라인 */}
      {b.hasLive && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 7, padding: '7px 9px 5px', marginBottom: 13 }}>
          <div className="eyebrow" style={{ marginBottom: 3, fontSize: 13 }}>최근 24h 파고 추이</div>
          <WaveSparkline source={b.source} id={b.id} />
        </div>
      )}

      {/* 상세 CTA(프라이머리 — 시안 채움 + 딥네이비 텍스트, hover 시 더 밝게) */}
      <button onClick={() => onDetail(b.id)}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent-h)' }}
        onMouseLeave={e => { e.currentTarget.style.background = 'var(--accent)' }}
        style={{
          width: '100%', fontSize: 14, fontWeight: 700, color: 'var(--bg-deep)', background: 'var(--accent)',
          border: 'none', borderRadius: 7, padding: '10px 14px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          transition: 'background 0.12s',
        }}>
        상세 보기 <span aria-hidden="true">›</span>
      </button>
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
  const { stations, live, liveLoadedOnce, baseLayer, setBaseLayer, selectedStationId, setSelectedStationId, flyToRequest, openDetail,
    visibleStatuses, visibleCategories } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, liveLoadedOnce: s.liveLoadedOnce,
      baseLayer: s.baseLayer, setBaseLayer: s.setBaseLayer,
      selectedStationId: s.selectedStationId, setSelectedStationId: s.setSelectedStationId, flyToRequest: s.flyToRequest,
      openDetail: s.openDetail,
      visibleStatuses: s.visibleStatuses, visibleCategories: s.visibleCategories,
    }))
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const popupRootRef = useRef<Root | null>(null)
  const mlPopupRef = useRef<maplibregl.Popup | null>(null)
  const popupBuoyIdRef = useRef<string | null>(null)
  const [mapReady, setMapReady] = useState(false)

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
    popupRootRef.current.render(<BuoyPopupContent b={b} onDetail={openDetail} />)
    mlPopupRef.current.setLngLat([b.lon, b.lat]).addTo(mapRef.current)
  }, [openDetail])

  // 실시간 폴링으로 값이 갱신되면 열려있는 팝업도 최신값으로 리렌더
  useEffect(() => {
    if (!popupBuoyIdRef.current || !mlPopupRef.current?.isOpen()) return
    const b = buoys.find(x => x.id === popupBuoyIdRef.current)
    if (b) popupRootRef.current?.render(<BuoyPopupContent b={b} onDetail={openDetail} />)
  }, [buoys, openDetail])

  // ── 지도 초기화 ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: useStore.getState().baseLayer === 'light' ? LIGHT_STYLE_URL : SAT_STYLE,
      center: CENTER,
      zoom: INIT_ZOOM,
      minZoom: 4.2,
      maxZoom: 14,
      maxBounds: PAN_BOUNDS,
      attributionControl: false,
    })

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
    map.setStyle(baseLayer === 'light' ? LIGHT_STYLE_URL : SAT_STYLE)
  }, [baseLayer, mapReady])

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
        // 이 박스 크기에 전혀 영향을 주지 않는다(줌 드리프트 방지의 핵심 불변식).
        el.style.cssText = `display:flex;align-items:center;justify-content:center;cursor:pointer;` +
          `position:absolute;top:0;left:0;width:${MARKER_BOX}px;height:${MARKER_BOX}px;overflow:visible;`
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
          setSelectedStationId(b.id === cur ? null : b.id)
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
  }, [visibleBuoys, mapReady, selectedStationId, baseLayer, updateLabelVisibility, setSelectedStationId, openPopupFor])

  // ── 좌측 패널에서 flyTo 요청 처리 ────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady || !flyToRequest) return
    const b = buoysRef.current.find(x => x.id === flyToRequest.id)
    if (!b || !isFinite(b.lat) || !isFinite(b.lon)) return
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

      {/* 베이스 레이어 토글 */}
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 900, display: 'flex', gap: 6,
        animation: 'fade-in 0.4s ease both' }}>
        <LayerBtn label="위성" active={baseLayer === 'sat'} onClick={() => setBaseLayer('sat')} />
        <LayerBtn label="라이트" active={baseLayer === 'light'} onClick={() => setBaseLayer('light')} />
      </div>

      {/* 부이 수 칩 — 필터 미적용 시 숨김(§12: KPI·좌패널 '총 N개소'와 3중 중복). 필터가 좁혀졌을
          때만 "N/137 · 필터 적용중"으로 노출해 지금 화면이 전체가 아님을 알려준다. */}
      {filterActive && (
        <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 900, animation: 'fade-in 0.4s ease both' }}>
          <div className="glass-chip tnum" style={{ borderRadius: 6, padding: '5px 11px', fontSize: 13, fontWeight: 600, color: 'var(--t-hi)' }}>
            부이 {visibleBuoys.length}/{buoys.length}개소
            <span style={{ marginLeft: 7, color: 'var(--accent-h)', fontWeight: 700 }}>· 필터 적용중</span>
          </div>
        </div>
      )}

      {/* 범례 — 바다누리식 정돈 박스(§16-추가): 형태=종류 / 색=상태, 색스와치+라벨 세로 스택.
          항상 표시하는 작은 고정 패널, 잔텍스트 최소화(설명 문구·카운트 없음). 좌하단 고정
          (2026-07-15 재지시 §11 — 챗 FAB 는 우하단이라 반대 코너로 겹침 없음). */}
      <div style={{ position: 'absolute', left: 12, bottom: 34, zIndex: 900, animation: 'fade-in 0.5s ease both' }}>
        <div className="map-legend" style={{ borderRadius: 10, padding: '10px 13px 11px', display: 'flex', flexDirection: 'column', gap: 9, minWidth: 150 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--t-lo)' }}>모양 = 부이 종류</span>
            {CATEGORY_ORDER.map(cat => (
              <span key={cat} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <BuoyGlyph category={cat} fill="var(--t-mid)" stroke="var(--line)" strokeWidth={1.1} size={13} />
                <span style={{ fontSize: 13, color: 'var(--t-hi)', fontWeight: 600, whiteSpace: 'nowrap' }}>{CATEGORY_LABEL[cat]}</span>
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6,
            borderTop: '1px solid var(--line)', paddingTop: 7 }}>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.02em', color: 'var(--t-lo)' }}>색 = 수신 상태</span>
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

function LayerBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  // §20 — 지도 위에 떠 있는 컨트롤이라 카드(--bg-elev)보다 밝은 --bg-float 로 표고(범례·줌컨트롤과 동일 톤).
  return (
    <button onClick={onClick} aria-pressed={active} style={{
      padding: '7px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
      background: active ? 'var(--accent-100)' : 'var(--bg-float)',
      border: active ? '1px solid var(--accent-dim)' : '1px solid var(--line)',
      color: active ? 'var(--accent-h)' : 'var(--t-mid)',
      boxShadow: 'var(--shadow-card)',
      transition: 'background 0.12s, border-color 0.12s, color 0.12s',
    }}>
      {label}
    </button>
  )
}
