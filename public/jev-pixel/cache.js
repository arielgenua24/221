// Portado de jev-to-pix/lib/segmentation/cache.ts (solo se quitaron los tipos).
/**
 * Module-scoped refinement cache keyed by a 64-bit average hash of the tile.
 * Survives between runs in the same tab session; cleared when the source image changes.
 * Not cryptographic: two tiles that look alike should share an answer.
 */
export const refinementCache = new Map()

export function tileHash(source, x, y, w, h) {
  const size = 8
  const canvas = document.createElement("canvas")
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext("2d")
  if (!ctx) return `${x}:${y}:${w}:${h}`
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(source, x, y, w, h, 0, 0, size, size)
  const { data } = ctx.getImageData(0, 0, size, size)
  const gray = new Float32Array(size * size)
  let mean = 0
  for (let i = 0; i < size * size; i++) {
    gray[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    mean += gray[i]
  }
  mean /= size * size
  let hi = 0
  let lo = 0
  for (let i = 0; i < 32; i++) {
    if (gray[i] > mean) hi |= 1 << i
    if (gray[i + 32] > mean) lo |= 1 << i
  }
  return `${(hi >>> 0).toString(16).padStart(8, "0")}${(lo >>> 0).toString(16).padStart(8, "0")}`
}
