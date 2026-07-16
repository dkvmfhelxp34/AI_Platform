// 부이 "기관·종류" 분류 — 마커 모양(형태) 축. 수신상태(색) 축과 완전히 분리된 별개 축이다.
// 지도 마커·좌패널 행 아이콘·범례가 전부 이 파일의 categoryOf()/buoyGlyphSvg() 를 공유해
// "같은 모양 = 같은 기관·종류" 라는 시각 언어가 화면 전체에서 어긋나지 않게 한다.
import type { LiveItem, StationMeta } from '../types'

export type BuoyCategory = 'kma-b' | 'kma-c' | 'khoa' | 'khoa-rip'

export function categoryOf(b: Pick<LiveItem | StationMeta, 'source' | 'tp' | 'name'>): BuoyCategory {
  if (b.source === 'KHOA') return (b.name ?? '').includes('해수욕장') ? 'khoa-rip' : 'khoa'
  return b.tp === 'C' ? 'kma-c' : 'kma-b'
}

export const CATEGORY_ORDER: BuoyCategory[] = ['kma-b', 'kma-c', 'khoa', 'khoa-rip']

export const CATEGORY_LABEL: Record<BuoyCategory, string> = {
  'kma-b': '해양기상부이',
  'kma-c': '파고부이',
  'khoa': '해양관측부이',
  'khoa-rip': '이안류부이',
}

export const CATEGORY_CODE: Record<BuoyCategory, string> = {
  'kma-b': 'KMA · B',
  'kma-c': 'KMA · C',
  'khoa': 'KHOA',
  'khoa-rip': 'KHOA · RIP',
}

export const CATEGORY_SHAPE_NAME: Record<BuoyCategory, string> = {
  'kma-b': '원형',
  'kma-c': '삼각형',
  'khoa': '라운드 사각형',
  'khoa-rip': '마름모',
}

/**
 * 부이 모양 SVG 마크업 문자열 — 지도(raw innerHTML)·React(dangerouslySetInnerHTML) 양쪽에서 재사용.
 * 모양 = 기관/종류(축1), 색(fill) = 수신상태(축2) — 두 축을 명확히 분리해 인코딩한다.
 * 네 실루엣(원/삼각/라운드사각/마름모)은 기본 줌에서도 한눈에 구분되도록 굵은 스트로크·꽉 찬 면적으로 그린다.
 */
export function buoyGlyphSvg(
  category: BuoyCategory,
  opts: { fill: string; stroke?: string; strokeWidth?: number; size?: number }
): string {
  // 기본 스트로크 = 다크 카드 위 아이콘 배지용 밝은 저채도 아웃라인(정의감 부여).
  // 지도 마커처럼 위성/벡터 지도 위에 직접 얹는 경우는 호출부에서 흰 보더로 명시 오버라이드한다.
  const { fill, stroke = 'rgba(241,245,250,0.26)', strokeWidth = 1.8, size = 20 } = opts
  const vb = 20
  if (category === 'kma-b') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
      `<circle cx="10" cy="10" r="8" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`
  }
  if (category === 'kma-c') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
      `<path d="M10 1.3 L18.7 17.6 L1.3 17.6 Z" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`
  }
  if (category === 'khoa-rip') {
    return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
      `<path d="M10 1.6 L18.4 10 L10 18.4 L1.6 10 Z" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linejoin="round"/></svg>`
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${vb} ${vb}" fill="none" aria-hidden="true">` +
    `<rect x="2.6" y="2.6" width="14.8" height="14.8" rx="4.2" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}"/></svg>`
}
