// Portado de jev-to-pix/lib/segmentation/metrics.ts (solo se quitaron los tipos).
export function iou(a, b) {
  let inter = 0
  let union = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] > 0
    const y = b[i] > 0
    if (x && y) inter++
    if (x || y) union++
  }
  return union === 0 ? 1 : inter / union
}

function boundaryPixels(mask, width, height) {
  const out = new Uint8Array(mask.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (!mask[p]) continue
      if (
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        !mask[p - 1] ||
        !mask[p + 1] ||
        !mask[p - width] ||
        !mask[p + width]
      ) {
        out[p] = 1
      }
    }
  }
  return out
}

/** Boundary F1 (Perazzi et al. 2016 style) with a pixel tolerance via Chebyshev dilation. */
export function boundaryF1(
  a,
  b,
  width,
  height,
  tolerancePx,
) {
  const ba = boundaryPixels(a, width, height)
  const bb = boundaryPixels(b, width, height)
  const near = (src, x, y) => {
    for (let dy = -tolerancePx; dy <= tolerancePx; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= height) continue
      for (let dx = -tolerancePx; dx <= tolerancePx; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= width) continue
        if (src[yy * width + xx]) return true
      }
    }
    return false
  }
  let tpA = 0
  let totalA = 0
  let tpB = 0
  let totalB = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (ba[p]) {
        totalA++
        if (near(bb, x, y)) tpA++
      }
      if (bb[p]) {
        totalB++
        if (near(ba, x, y)) tpB++
      }
    }
  }
  const precision = totalA === 0 ? 1 : tpA / totalA
  const recall = totalB === 0 ? 1 : tpB / totalB
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}

/** Decodes an uploaded mask PNG into a binary Uint8Array at the given size (luminance > 127). */
export async function decodeMaskFile(file, width, height) {
  const bitmap = await createImageBitmap(file)
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("No se pudo leer la máscara.")
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const { data } = ctx.getImageData(0, 0, width, height)
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) {
    const lum = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
    out[i] = lum > 127 && data[i * 4 + 3] > 0 ? 1 : 0
  }
  return out
}
