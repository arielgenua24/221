// Portado de jev-to-pix/lib/segmentation/label-render.ts (solo se quitaron los tipos).

/**
 * Visual prompting: prints double-contrast contours and a numeric ID at each superpixel centroid
 * so the model can reference regions by what it sees rather than by blind float coordinates.
 * PNG export to avoid JPEG ringing around the printed digits.
 */
export async function renderLabeledCrop(
  source,
  slic,
) {
  const { width, height } = source
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("No se pudo crear el canvas etiquetado.")
  ctx.drawImage(source, 0, 0)

  // Boundary mask: pixel is a boundary if right or bottom neighbor has a different label.
  const boundary = ctx.createImageData(width, height)
  const bd = boundary.data
  const labels = slic.labels
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      const l = labels[p]
      const isEdge =
        (x + 1 < width && labels[p + 1] !== l) ||
        (y + 1 < height && labels[p + width] !== l)
      if (!isEdge) continue
      // Dark stroke on the pixel, light stroke on the next pixel: readable on any background.
      bd[p * 4] = 0
      bd[p * 4 + 1] = 0
      bd[p * 4 + 2] = 0
      bd[p * 4 + 3] = 178
      const q = x + 1 < width ? p + 1 : p
      bd[q * 4] = 255
      bd[q * 4 + 1] = 255
      bd[q * 4 + 2] = 255
      bd[q * 4 + 3] = Math.max(bd[q * 4 + 3], 150)
    }
  }
  const overlay = document.createElement("canvas")
  overlay.width = width
  overlay.height = height
  overlay.getContext("2d")?.putImageData(boundary, 0, 0)
  ctx.drawImage(overlay, 0, 0)

  // IDs: font size adapts to region size; halo for contrast.
  let unlabeledCount = 0
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  for (let c = 0; c < slic.k; c++) {
    const size = slic.sizes[c]
    const side = Math.sqrt(size)
    const fontPx = Math.max(9, Math.min(16, Math.floor(side * 0.42)))
    const digits = String(c).length
    if (side < fontPx * digits * 0.7) {
      unlabeledCount++
      continue
    }
    const cx = slic.centroids[c * 2]
    const cy = slic.centroids[c * 2 + 1]
    ctx.font = `700 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`
    ctx.lineWidth = Math.max(2, fontPx * 0.28)
    ctx.strokeStyle = "rgba(0,0,0,0.85)"
    ctx.strokeText(String(c), cx, cy)
    ctx.fillStyle = "rgba(255,255,255,0.98)"
    ctx.fillText(String(c), cx, cy)
  }

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  )
  if (!blob) throw new Error("No se pudo exportar el recorte etiquetado.")
  return { blob, previewUrl: URL.createObjectURL(blob), unlabeledCount }
}
