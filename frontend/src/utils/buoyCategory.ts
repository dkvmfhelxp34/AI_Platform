// 부이 "기관·종류" 분류 — 마커 모양(형태) 축. 수신상태(색) 축과 완전히 분리된 별개 축이다.
// 지도 마커·좌패널 행 아이콘·범례가 전부 이 파일의 categoryOf()/buoyGlyphSvg() 를 공유해
// "같은 모양 = 같은 기관·종류" 라는 시각 언어가 화면 전체에서 어긋나지 않게 한다.
import type { LiveItem, StationMeta } from '../types'

export type BuoyCategory = 'kma-b' | 'kma-c' | 'khoa'

export function categoryOf(b: Pick<LiveItem | StationMeta, 'source' | 'tp'>): BuoyCategory {
  if (b.source === 'KHOA') return 'khoa'
  return b.tp === 'C' ? 'kma-c' : 'kma-b'
}

export const CATEGORY_ORDER: BuoyCategory[] = ['kma-b', 'kma-c', 'khoa']

export const CATEGORY_LABEL: Record<BuoyCategory, string> = {
  'kma-b': '해양기상부이',
  'kma-c': '파고부이',
  'khoa': '해양관측부이',
}

export const CATEGORY_CODE: Record<BuoyCategory, string> = {
  'kma-b': 'KMA · B',
  'kma-c': 'KMA · C',
  'khoa': 'KHOA',
}

export const CATEGORY_SHAPE_NAME: Record<BuoyCategory, string> = {
  'kma-b': '원형',
  'kma-c': '삼각형',
  'khoa': '라운드 사각형',
}

/**
 * 부이 모양 SVG 마크업 문자열 — 지도(raw innerHTML)·React(dangerouslySetInnerHTML) 양쪽에서 재사용.
 * 모양 = 기관/종류(축1), 색(fill) = 수신상태(축2) — 두 축을 명확히 분리해 인코딩한다.
 * 세 실루엣(원/삼각/라운드사각)은 기본 줌에서도 한눈에 구분되도록 굵은 스트로크·꽉 찬 면적으로 그린다.
 */
export function buoyGlyphSvg(
  category: BuoyCategory,
  opts: { fill: string; stroke?: string; strokeWidth?: number; size?: number }
): string {
  const { fill, stroke = 'rgba(255,255,255,0.9)', strokeWidth = 1.8, size = 20 } = opts
  const vb = 20
  if (category === 'kma-b') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
      `<circle cx="10" cy="10" r="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`
  }
  if (category === 'kma-c') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
      `<path d="M10 1.3 L18.7 17.6 L1.3 17.6 Z" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
    `<rect x="2.6" y="2.6" width="14.8" height="14.8" rx="4.2" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`
}
