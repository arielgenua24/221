// Portado de jev-to-pix/lib/segmentation/hierarchical.ts (solo se quitaron los tipos).

/**
 * Selects tiles whose mean unary probability lies in the uncertainty band.
 * The band forms a perimeter around the object, so it grows O(N) with grid side,
 * not O(N^2): refining it is what makes a 64x64 effective resolution affordable.
 */
export function selectUncertainTiles(
  unary,
  width,
  height,
  opts,
) {
  const { tileGrid, band, maxTiles } = opts
  const candidates = []
  for (let ty = 0; ty < tileGrid; ty++) {
    for (let tx = 0; tx < tileGrid; tx++) {
      const x0 = Math.floor((tx / tileGrid) * width)
      const x1 = Math.floor(((tx + 1) / tileGrid) * width)
      const y0 = Math.floor((ty / tileGrid) * height)
      const y1 = Math.floor(((ty + 1) / tileGrid) * height)
      let sum = 0
      let count = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += unary[y * width + x]
          count++
        }
      }
      if (count === 0) continue
      const meanP = sum / count
      if (meanP >= band[0] && meanP <= band[1]) {
        candidates.push({
          tileId: `t${ty}_${tx}`,
          x: x0,
          y: y0,
          w: x1 - x0,
          h: y1 - y0,
          meanP,
        })
      }
    }
  }
  // Most ambiguous first, then truncate to the hard cap.
  candidates.sort((a, b) => Math.abs(a.meanP - 0.5) - Math.abs(b.meanP - 0.5))
  return { tiles: candidates.slice(0, maxTiles), candidateCount: candidates.length }
}

/**
 * Crops a tile, upscales it x4 (bilinear) so the model sees it at native resolution,
 * and prints a 4x4 double-contrast reticle (visual prompting). PNG to keep the lines crisp.
 */
export async function renderTileForRefinement(
  source,
  tile,
  opts,
) {
  // JEV only accepts images with sides in [280, 1568] px. A 16x16 tile over a 768px crop is
  // ~48px, so x4 alone (192px) is rejected; raise the factor until the short side clears 288px.
  const minSide = 288
  const maxSide = 1568
  const shortest = Math.max(1, Math.min(tile.w, tile.h))
  let factor = Math.max(opts.upscale, Math.ceil(minSide / shortest))
  const longest = Math.max(tile.w, tile.h)
  if (longest * factor > maxSide) factor = Math.floor(maxSide / longest)
  const outW = Math.max(1, Math.round(tile.w * factor))
  const outH = Math.max(1, Math.round(tile.h * factor))
  const canvas = document.createElement("canvas")
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("No se pudo renderizar el tile.")
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = "high"
  ctx.drawImage(source, tile.x, tile.y, tile.w, tile.h, 0, 0, outW, outH)

  const n = opts.subGrid
  for (let i = 1; i < n; i++) {
    const x = (i / n) * outW
    const y = (i / n) * outH
    ctx.strokeStyle = "rgba(255,255,255,0.75)"
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, outH)
    ctx.moveTo(0, y)
    ctx.lineTo(outW, y)
    ctx.stroke()
    ctx.strokeStyle = "rgba(0,0,0,0.6)"
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x + 1.5, 0)
    ctx.lineTo(x + 1.5, outH)
    ctx.moveTo(0, y + 1.5)
    ctx.lineTo(outW, y + 1.5)
    ctx.stroke()
  }

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  )
  if (!blob) throw new Error("No se pudo exportar el tile.")
  return blob
}

/**
 * Replaces the unary field inside each refined tile with its 4x4 sub-grid,
 * bilinearly interpolated so there are no blocky seams between sub-cells.
 */
export function mergeRefinement(
  unary,
  width,
  tiles,
  refinement,
  subGrid,
) {
  const out = new Float32Array(unary)
  const byId = new Map(refinement.map((r) => [r.tileId, r.sub]))
  for (const tile of tiles) {
    const sub = byId.get(tile.tileId)
    if (!sub) continue
    for (let y = 0; y < tile.h; y++) {
      for (let x = 0; x < tile.w; x++) {
        const u = ((x + 0.5) / tile.w) * subGrid - 0.5
        const v = ((y + 0.5) / tile.h) * subGrid - 0.5
        const gx = Math.max(0, Math.min(subGrid - 1, u))
        const gy = Math.max(0, Math.min(subGrid - 1, v))
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const x1 = Math.min(subGrid - 1, x0 + 1)
        const y1 = Math.min(subGrid - 1, y0 + 1)
        const fx = gx - x0
        const fy = gy - y0
        const p00 = sub[y0 * subGrid + x0]
        const p10 = sub[y0 * subGrid + x1]
        const p01 = sub[y1 * subGrid + x0]
        const p11 = sub[y1 * subGrid + x1]
        const top = p00 * (1 - fx) + p10 * fx
        const bot = p01 * (1 - fx) + p11 * fx
        out[(tile.y + y) * width + (tile.x + x)] = top * (1 - fy) + bot * fy
      }
    }
  }
  return out
}

