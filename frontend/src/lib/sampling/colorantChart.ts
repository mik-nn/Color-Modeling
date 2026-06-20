// Pure function: generate colorant-derived RGB patch targets for a given k.
// Chart is derived solely from CMY colorant geometry (primaries, secondaries,
// neutrals, interior points) — requires zero measured profiles to construct.
// This is the "strategy under profile scarcity" for experiment H44.

export type RGB = [number, number, number]

// Colorant primaries in device RGB space (CMY model, K=0):
//   C primary: R=0,   G=255, B=255  (cyan absorbs red)
//   M primary: R=255, G=0,   B=255  (magenta absorbs green)
//   Y primary: R=255, G=255, B=0    (yellow absorbs blue)
//   White:     R=255, G=255, B=255
//   Black:     R=0,   G=0,   B=0    (all three primaries at max)
// Secondaries (two primaries combined):
//   R: R=255, G=0,   B=0    (M+Y)
//   G: R=0,   G=255, B=0    (C+Y)
//   B: R=0,   G=0,   B=255  (C+M)

const WHITE:  RGB = [255, 255, 255]
const BLACK:  RGB = [0,   0,   0]
const CYAN:   RGB = [0,   255, 255]
const MAGENTA:RGB = [255, 0,   255]
const YELLOW: RGB = [255, 255, 0]
const RED:    RGB = [255, 0,   0]
const GREEN:  RGB = [0,   255, 0]
const BLUE:   RGB = [0,   0,   255]

// Mid-coverage interior — center of CMY gamut body
const MID_NEUTRAL: RGB = [128, 128, 128]
const MID_WARM:    RGB = [255, 128, 0]   // M+Y half — warm mid-tone
const MID_COOL:    RGB = [0,   128, 255] // C+M half — cool mid-tone
const DARK_NEUTRAL:RGB = [64,  64,  64]

// 50%-coverage primaries (second level on the ramp)
const CYAN_50:   RGB = [128, 255, 255]
const MAGENTA_50:RGB = [255, 128, 255]
const YELLOW_50: RGB = [255, 255, 128]

// Extended-gamut probe points (12-ink Orange/Green/Violet directions)
const EXT_ORANGE:  RGB = [255, 64,  0]
const EXT_LT_GREEN:RGB = [64,  255, 0]
const EXT_VIOLET:  RGB = [128, 0,   255]
const EXT_MID_RED: RGB = [200, 0,   64]

/**
 * Return k colorant-derived RGB patch targets.
 *
 * k  | added points
 * ---|--------------------------------------------------------------
 *  5 | C, M, Y primaries + white + neutral
 *  6 | + black (full CMY)
 *  8 | + secondaries R, G, B
 * 12 | + 50%-primaries + mid-warm + mid-cool + 2nd dark neutral
 * 16 | + extended-gamut directions (for 12-ink probes)
 */
export function colorantChart(k: 5 | 6 | 8 | 12 | 16): RGB[] {
  // k=5: CMY primaries + white + neutral
  const k5: RGB[] = [WHITE, CYAN, MAGENTA, YELLOW, MID_NEUTRAL]
  if (k === 5) return k5

  // k=6: add black
  const k6: RGB[] = [...k5, BLACK]
  if (k === 6) return k6

  // k=8: white + black + CMY primaries + RGB secondaries (drops neutral —
  // the standard 8-colorant geometry covering all ink-limit extremes)
  const k8: RGB[] = [WHITE, BLACK, CYAN, MAGENTA, YELLOW, RED, GREEN, BLUE]
  if (k === 8) return k8

  // k=12: k=8 + neutral + 50%-ramp primaries + mid-warm interior
  const k12: RGB[] = [...k8, MID_NEUTRAL, CYAN_50, MAGENTA_50, YELLOW_50]
  if (k === 12) return k12

  // k=16: k=12 + mid-warm + mid-cool + dark-neutral + extended-gamut direction
  return [...k12, MID_WARM, MID_COOL, DARK_NEUTRAL, EXT_ORANGE]
}

// Exported for tests
export { WHITE, BLACK, CYAN, MAGENTA, YELLOW, RED, GREEN, BLUE, MID_NEUTRAL }
