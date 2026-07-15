/**
 * MapViewGL — Native MapLibre GL 지도 (Phase 1 MVP, 관측 미니멀 리스타일).
 * - Base:     위성(Esri World Imagery raster, 무토큰) 기본 + 화이트(Carto Positron 벡터) 토글
 * - Buoys:    maplibregl.Marker HTML — 상태색 solid dot(KMA)/hollow diamond(KHOA) + 얇은 링,
 *             지연/미수신은 은은한 scale/opacity 브리딩, 선택 시 1.5px accent 링(정적)
 * - Popup:    React createRoot 마운트 — 이름/소스/타입/상태/관측시각/주요값(2열 mono 그리드)
 * - Overlay:  없음(2D 기상장 미표출) — 부이 아이콘 마커만 표시
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useShallow } from 'zustand/react/shallow'
import { useStore } from '../store'
import { mergeBuoys, type MergedBuoy } from '../utils/buoys'
import { STATUS_BORDER, STATUS_HEX, STATUS_LABEL, STATUS_SOFT, type BuoyStatus } from '../types'

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

const MARKER_BOX = 16   // 마커 히트박스/정렬 기준(px)
const CORE_D = 9        // 실제 도형(원/다이아) 크기(px)

// 부이 상태 심각도(라벨 배치 우선순위 — 미수신 > 지연 > 정상)
const STATUS_RANK: Record<BuoyStatus, number> = { '미수신': 0, '지연': 1, '정상': 2 }

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function degToCompass(deg: number | null | undefined): string {
  if (deg == null || !isFinite(deg)) return '-'
  const dirs = ['북', '북동', '동', '남동', '남', '남서', '서', '북서']
  return dirs[Math.round(deg / 45) % 8]
}

// ── 부이 마커 HTML ────────────────────────────────────────────────────────
// 모양: KMA=solid dot(상태색 채움) / KHOA=hollow diamond(상태색 테두리) — 무광, 큰 글로우 없음
// 선택: 1.5px accent 링(정적) / 지연·미수신: 은은한 scale·opacity 브리딩(prefers-reduced-motion 존중)
function buildMarkerInnerHTML(b: MergedBuoy, selected: boolean): string {
  const hex = STATUS_HEX[b.status]
  const isKMA = b.source === 'KMA'
  const pulseClass = b.status !== '정상' ? 'buoy-marker-pulse' : ''
  const ringColor = selected ? 'var(--accent)' : 'rgba(230,237,245,0.75)'
  const ringW = selected ? 1.6 : 1

  const core = isKMA
    ? `<div class="${pulseClass}" style="width:${CORE_D}px;height:${CORE_D}px;border-radius:50%;background:${hex};border:${ringW}px solid ${ringColor};box-shadow:0 1px 3px rgba(0,0,0,0.5);"></div>`
    : `<div style="width:${CORE_D}px;height:${CORE_D}px;display:flex;transform:rotate(45deg);">` +
        `<div class="${pulseClass}" style="width:100%;height:100%;border-radius:2px;background:rgba(10,15,26,0.55);border:${Math.max(ringW, 1.4)}px solid ${selected ? 'var(--accent)' : hex};box-shadow:0 1px 3px rgba(0,0,0,0.45);"></div>` +
      `</div>`

  const selRing = selected ? '<span class="buoy-marker-selected-ring"></span>' : ''

  const nameStyle = 'font-size:10.5px;font-weight:600;color:#fff;white-space:nowrap;' +
    'text-shadow:0 0 2px #000,0 1px 3px rgba(0,0,0,0.8);letter-spacing:0.003em;'

  return `
    <div style="display:flex;flex-direction:column;align-items:center;gap:3px;">
      <div style="position:relative;display:flex;align-items:center;justify-content:center;width:${MARKER_BOX}px;height:${MARKER_BOX}px;">
        ${selRing}${core}
      </div>
      <span data-role="name" style="${nameStyle}">${escapeHtml(b.name)}</span>
    </div>
  `
}

// ── 팝업 내용 (React) ────────────────────────────────────────────────────
function ValueCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--line)', borderRadius: 5, padding: '7px 9px' }}>
      <div className="eyebrow" style={{ fontSize: 9, marginBottom: 3 }}>{label}</div>
      <div className="mono" style={{ fontSize: 14, fontWeight: 600, color: 'var(--t-hi)' }}>
        {value}{unit && <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--t-lo)', marginLeft: 3 }}>{unit}</span>}
      </div>
    </div>
  )
}

function BuoyPopupContent({ b, onDetail }: { b: MergedBuoy; onDetail: (id: string) => void }) {
  const hex = STATUS_HEX[b.status]
  const v = b.values
  const cells: { label: string; value: string; unit?: string }[] = []
  if (v.wave_height != null) cells.push({ label: '파고', value: v.wave_height.toFixed(1), unit: 'm' })
  if (v.wind_speed != null) cells.push({ label: `풍속 (${degToCompass(v.wind_dir)}${v.wind_dir != null ? ` ${Math.round(v.wind_dir)}°` : ''})`, value: v.wind_speed.toFixed(1), unit: 'm/s' })
  if (v.water_temp != null) cells.push({ label: '수온', value: v.water_temp.toFixed(1), unit: '℃' })
  if (v.pressure != null) cells.push({ label: '기압', value: v.pressure.toFixed(1), unit: 'hPa' })

  return (
    <div style={{ padding: '14px 16px', fontFamily: 'var(--font-ui)', color: 'var(--t-mid)', fontSize: 13, width: 272 }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8, paddingRight: 18, marginBottom: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--t-hi)', lineHeight: 1.25, letterSpacing: '-0.01em' }}>{b.name}</div>
          {b.name_en && <div style={{ fontSize: 11, color: 'var(--t-lo)', marginTop: 1 }}>{b.name_en}</div>}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 600, color: hex,
          background: STATUS_SOFT[b.status], border: `1px solid ${STATUS_BORDER[b.status]}`,
          borderRadius: 20, padding: '3px 9px 3px 7px', flexShrink: 0, whiteSpace: 'nowrap' }}>
          <span style={{ width: 5, height: 5, borderRadius: '50%', background: hex, flexShrink: 0 }} />
          {STATUS_LABEL[b.status]}
        </span>
      </div>

      {/* 소스/타입/관측시각 */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 0', marginBottom: 10,
        borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)' }}>
        <Tag label={b.source} />
        <Tag label={b.tp_label ?? b.tp} />
        <span className="mono" style={{ color: 'var(--t-lo)', marginLeft: 'auto', fontSize: 11 }}>
          {b.obs_time ?? '관측 이력 없음'}
        </span>
      </div>

      {/* 값 그리드 */}
      {cells.length > 0 ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 12 }}>
          {cells.map(c => <ValueCell key={c.label} {...c} />)}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: 'var(--t-lo)', padding: '10px 0', textAlign: 'center' }}>
          {b.hasLive ? '표시할 관측값 없음' : '이 데모 범위에서는 실시간 값이 폴링되지 않는 지점입니다'}
        </div>
      )}

      {/* 좌표 + 상세 버튼 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--t-lo)' }}>
          {b.lat.toFixed(3)}°N, {b.lon.toFixed(3)}°E
        </span>
        <button onClick={() => onDetail(b.id)} style={{
          fontSize: 12, fontWeight: 600, color: 'var(--accent-h)', background: 'transparent',
          border: '1px solid var(--accent-dim)', borderRadius: 5, padding: '5px 13px', cursor: 'pointer',
          transition: 'border-color 0.12s, color 0.12s',
        }}>상세</button>
      </div>
    </div>
  )
}

function Tag({ label }: { label: string }) {
  return (
    <span className="mono" style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--t-mid)',
      border: '1px solid var(--line)', borderRadius: 4, padding: '2px 7px' }}>
      {label}
    </span>
  )
}

// ── Main component ──────────────────────────────────────────────────────
export default function MapViewGL() {
  const { stations, live, liveLoadedOnce, baseLayer, setBaseLayer, selectedStationId, setSelectedStationId, flyToRequest, openDetail } = useStore(
    useShallow(s => ({
      stations: s.stations, live: s.live, liveLoadedOnce: s.liveLoadedOnce,
      baseLayer: s.baseLayer, setBaseLayer: s.setBaseLayer,
      selectedStationId: s.selectedStationId, setSelectedStationId: s.setSelectedStationId, flyToRequest: s.flyToRequest,
      openDetail: s.openDetail,
    }))
  )

  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<maplibregl.Map | null>(null)
  const markersRef = useRef<Map<string, maplibregl.Marker>>(new Map())
  const popupRootRef = useRef<Root | null>(null)
  const mlPopupRef = useRef<maplibregl.Popup | null>(null)
  const popupBuoyIdRef = useRef<string | null>(null)
  const [mapReady, setMapReady] = useState(false)

  const buoys = useMemo(() => mergeBuoys(stations, live), [stations, live])
  const buoysRef = useRef(buoys)
  buoysRef.current = buoys

  const statusCounts = useMemo(() => {
    const c: Record<BuoyStatus, number> = { '정상': 0, '지연': 0, '미수신': 0 }
    for (const b of buoys) c[b.status]++
    return c
  }, [buoys])

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
    const popup = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', className: 'buoy-ml-popup' })
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

  // ── 라벨 declutter (겹치면 숨김, 심각도 우선순위로 자리 선점) ────────────
  const declutterLabels = useCallback(() => {
    const map = mapRef.current
    if (!map) return
    type Box = { left: number; right: number; top: number; bottom: number }
    const overlap = (a: Box, b: Box, pad: number) =>
      a.left <= b.right + pad && a.right >= b.left - pad && a.top <= b.bottom + pad && a.bottom >= b.top - pad

    const entries: { nameEl: HTMLElement; rank: number; rect: Box }[] = []
    markersRef.current.forEach((marker) => {
      const el = marker.getElement()
      const nameEl = el.querySelector<HTMLElement>('[data-role="name"]')
      if (!nameEl) return
      nameEl.style.visibility = ''
      entries.push({ nameEl, rank: parseInt(el.dataset.rank ?? '9'), rect: nameEl.getBoundingClientRect() })
    })

    // 심각도 높은(미수신>지연>정상) 라벨이 먼저 자리를 차지 → 낮은 것이 겹치면 양보
    entries.sort((a, b) => a.rank - b.rank)

    const z = map.getZoom()
    const showAll = z >= INIT_ZOOM + 2.2   // 충분히 줌인 → 전부 표시

    const placed: Box[] = []
    for (const e of entries) {
      const r = e.rect
      if (r.right <= r.left) continue
      if (showAll) { e.nameEl.style.visibility = ''; continue }
      if (placed.some(p => overlap(r, p, 1))) e.nameEl.style.visibility = 'hidden'
      else placed.push(r)
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return
    let raf = 0
    const schedule = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; declutterLabels() }) }
    map.on('move', schedule)
    schedule()
    return () => { map.off('move', schedule); if (raf) cancelAnimationFrame(raf) }
  }, [mapReady, declutterLabels])

  // ── 부이 HTML 마커 생성/갱신 (상태 또는 선택여부가 바뀐 마커만 innerHTML 재생성) ─
  useEffect(() => {
    const map = mapRef.current
    if (!map || !mapReady) return

    const existing = markersRef.current
    const validIds = new Set(buoys.filter(b => isFinite(b.lat) && isFinite(b.lon)).map(b => b.id))

    for (const [id, m] of existing) {
      if (!validIds.has(id)) { m.remove(); existing.delete(id) }
    }

    for (const b of buoys) {
      if (!isFinite(b.lat) || !isFinite(b.lon)) continue
      const isSel = b.id === selectedStationId

      if (existing.has(b.id)) {
        const marker = existing.get(b.id)!
        const el = marker.getElement()
        const prevStatus = el.dataset.status
        const prevSel = el.dataset.sel === '1'
        if (prevStatus !== b.status || prevSel !== isSel) {
          el.innerHTML = buildMarkerInnerHTML(b, isSel)
          el.dataset.status = b.status
          el.dataset.rank = String(STATUS_RANK[b.status])
          el.dataset.sel = isSel ? '1' : '0'
        }
      } else {
        const el = document.createElement('div')
        // position:absolute + top/left:0 필수 — MapLibre Marker 는 transform:translate 로 좌표를 설정하므로
        // position:relative 이면 inline 자연흐름 오프셋만큼 마커가 어긋난다.
        el.style.cssText = 'display:inline-flex;cursor:pointer;position:absolute;top:0;left:0;z-index:20;'
        el.dataset.status = b.status
        el.dataset.rank = String(STATUS_RANK[b.status])
        el.dataset.sel = isSel ? '1' : '0'
        el.innerHTML = buildMarkerInnerHTML(b, isSel)
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          const cur = useStore.getState().selectedStationId
          setSelectedStationId(b.id === cur ? null : b.id)
          const latest = buoysRef.current.find(x => x.id === b.id) ?? b
          openPopupFor(latest)
        })
        const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([b.lon, b.lat]).addTo(map)
        existing.set(b.id, marker)
      }
    }
    requestAnimationFrame(declutterLabels)
  }, [buoys, mapReady, selectedStationId, declutterLabels, setSelectedStationId, openPopupFor])

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

      {/* 로딩 오버레이 — 최초 실시간 자료 수신 전 */}
      {!liveLoadedOnce && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 950, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: 10, background: 'rgba(10,15,26,0.55)' }}>
          <div style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid var(--line)',
            borderTopColor: 'var(--accent)', animation: 'spin 0.9s linear infinite' }} />
          <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--t-hi)' }}>부이 실시간 자료를 불러오는 중…</div>
        </div>
      )}

      {/* 베이스 레이어 토글 */}
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 900, display: 'flex', gap: 6,
        animation: 'fade-in 0.4s ease both' }}>
        <LayerBtn label="위성" active={baseLayer === 'sat'} onClick={() => setBaseLayer('sat')} />
        <LayerBtn label="라이트" active={baseLayer === 'light'} onClick={() => setBaseLayer('light')} />
      </div>

      {/* 부이 수 칩 */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 900, animation: 'fade-in 0.4s ease both' }}>
        <div className="glass-chip mono" style={{ borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, color: 'var(--t-mid)' }}>
          부이 {buoys.length}개소 표출
        </div>
      </div>

      {/* 상태 범례 */}
      <div className="map-legend" style={{ position: 'absolute', right: 12, bottom: 30, zIndex: 900,
        borderRadius: 7, padding: '11px 14px', minWidth: 136, animation: 'fade-in 0.5s ease both', pointerEvents: 'none' }}>
        <div className="eyebrow" style={{ marginBottom: 8 }}>수신 상태</div>
        {(['정상', '지연', '미수신'] as BuoyStatus[]).map(st => (
          <div key={st} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2.5px 0' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: STATUS_HEX[st], flexShrink: 0 }} />
            <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--t-mid)', flex: 1 }}>{STATUS_LABEL[st]}</span>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600,
              color: statusCounts[st] > 0 ? STATUS_HEX[st] : 'var(--t-lo)', minWidth: 14, textAlign: 'right' }}>{statusCounts[st]}</span>
          </div>
        ))}
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--line)', display: 'flex', gap: 14 }}>
          <ShapeLegendItem shape="dot" label="KMA" />
          <ShapeLegendItem shape="diamond" label="KHOA" />
        </div>
      </div>

      {/* 저작권 표기 (attributionControl 대체 — 최소 표기) */}
      <div style={{ position: 'absolute', bottom: 4, left: 8, zIndex: 900, fontSize: 9.5, color: 'rgba(255,255,255,0.45)',
        textShadow: '0 1px 2px rgba(0,0,0,0.8)', pointerEvents: 'none' }}>
        {ATTRIBUTION[baseLayer]}
      </div>
    </div>
  )
}

function LayerBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-pressed={active} style={{
      padding: '6px 13px', borderRadius: 5, cursor: 'pointer', fontSize: 12, fontWeight: 500,
      background: 'var(--bg-elev)',
      border: active ? '1px solid var(--accent-dim)' : '1px solid var(--line)',
      color: active ? 'var(--accent-h)' : 'var(--t-mid)',
      boxShadow: 'var(--shadow-sm)',
      transition: 'border-color 0.12s, color 0.12s',
    }}>
      {label}
    </button>
  )
}

function ShapeLegendItem({ shape, label }: { shape: 'dot' | 'diamond'; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {shape === 'dot'
        ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--t-mid)', flexShrink: 0 }} />
        : <span style={{ width: 6, height: 6, border: '1.3px solid var(--t-mid)', borderRadius: 1, transform: 'rotate(45deg)', flexShrink: 0 }} />}
      <span className="mono" style={{ fontSize: 10, color: 'var(--t-lo)' }}>{label}</span>
    </div>
  )
}
