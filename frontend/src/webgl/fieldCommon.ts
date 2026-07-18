/**
 * fieldCommon — 2D 필드 오버레이(바람장·수온장, §26)가 공유하는 지리좌표 변환 GLSL 조각과
 * `/api/field` bounds 어댑터. windGL.ts·sstGL.ts 양쪽에서 import 해 쓴다(중복 방지 —
 * row 방향 같은 미묘한 규약은 한 곳에서만 정의해야 어긋날 위험이 없다).
 *
 * ⚠️ row 방향 주의(이식 시 가장 중요한 차이점): Storm_Platform 원본 windGL.ts 의 GFS 격자는
 * row 0 = 최북단이었다(그쪽 백엔드 관례). 이 플랫폼의 `/api/field` 는 **row 0 = 최남단**
 * (backend/field_service.py 산출 규약, CLAUDE.md 명시) — 정반대다. 아래 posToGrid() 의
 * rowFrac 부호를 Storm 원본과 반대로 뒤집었다(주석 참고). 이 값이 틀리면 격자가 남북으로
 * 뒤집혀 지도와 어긋난다.
 */
export interface FieldBounds { lon_min: number; lon_max: number; lat_min: number; lat_max: number }

/** `/api/field` 의 bounds = `[west, south, east, north]` 배열 → glUtils.computeDomainMatrix 가
 *  기대하는 {lon_min,lon_max,lat_min,lat_max} 객체로 변환. */
export function boundsFromArray(b: readonly [number, number, number, number]): FieldBounds {
  return { lon_min: b[0], lat_min: b[1], lon_max: b[2], lat_max: b[3] }
}

// GLSL 공통 조각 — glUtils.computeDomainMatrix() 가 정의하는 도메인 정규화 좌표계
// (px,py)∈[0,1]² 를 그대로 물려받는다: px=0→lon_min, px=1→lon_max, py=0→lat_max(북),
// py=1→lat_min(남) — 이 (px,py) 파라미터화 자체는 Storm 원본과 동일(변경하면
// computeDomainMatrix 와 어긋난다). posToLonLat() 은 그 (px,py) 를 실제 경위도로 정확히
// 역변환한다(메르카토르 y 성분은 affine 이라 근사 없이 정확 — §26 z-index 조사 문서 참고).
// posToGrid() 만 "복원된 위도값 → 격자 row 분수" 변환에서 남북 방향을 뒤집었다(위 주석).
export const GLSL_FIELD_COMMON = `
precision highp float;
const float PI = 3.141592653589793;
uniform vec2 u_gridSize;     // (cols, rows)
uniform vec4 u_lonlat;       // (lon_min, lon_max, lat_min, lat_max)
uniform vec2 u_merc;         // (mercY(lat_max), mercY(lat_min))

float mercLat(float lat){ return log(tan(PI/4.0 + radians(lat)/2.0)); }
float invMercLat(float y){ return degrees(2.0*atan(exp(y)) - PI*0.5); }

vec2 posToLonLat(vec2 p){
  float lon = mix(u_lonlat.x, u_lonlat.y, p.x);
  float y   = mix(u_merc.x, u_merc.y, p.y);
  return vec2(lon, invMercLat(y));
}
// row 0 = 최남단(lat_min) — /api/field 규약(Storm 원본과 반대 방향, 위 파일 헤더 참고).
vec2 posToGrid(vec2 p, float lat){
  float col = p.x * (u_gridSize.x - 1.0);
  float rowFrac = (lat - u_lonlat.z) / (u_lonlat.w - u_lonlat.z);
  return vec2(col, rowFrac * (u_gridSize.y - 1.0));
}
float hash(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233))) * 43758.5453123); }
`
