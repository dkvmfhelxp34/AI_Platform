// BuoyGlyph — 공유 부이 모양 아이콘(원=KMA 해양기상부이 / 삼각=KMA 파고부이 / 라운드사각=KHOA 해양관측부이).
// utils/buoyCategory.ts 의 buoyGlyphSvg() 를 감싸는 얇은 래퍼. 좌패널 행·범례·팝업·상세 헤더에서 공용.
import { buoyGlyphSvg, type BuoyCategory } from '../utils/buoyCategory'

export default function BuoyGlyph({ category, fill, stroke, strokeWidth, size = 18 }: {
  category: BuoyCategory
  fill: string
  stroke?: string
  strokeWidth?: number
  size?: number
}) {
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: buoyGlyphSvg(category, { fill, stroke, strokeWidth, size }) }}
    />
  )
}
