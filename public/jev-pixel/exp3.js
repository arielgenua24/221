// Portado de jev-to-pix/components/experiment-three.tsx (solo se quitaron los tipos y se exportaron las funciones).
// Experimento 3: recorte con retícula visual y súper-resolución guiada por Sobel.
export const SUPER_RES_OPTIONS = [
  { size: 48, label: "48×48 (2,304 · 9X)", factor: "9X vs Exp 2 · 36X vs Exp 1" },
  { size: 64, label: "64×64 (4,096 · 16X)", factor: "16X vs Exp 2 · 64X vs Exp 1" },
  { size: 80, label: "80×80 (6,400 · 25X)", factor: "25X vs Exp 2 · 100X vs Exp 1" },
]

export function formatPercent(value) {
  return `${Math.round(value * 100)}%`
}

/** Fit full image within JEV's 280–1568 px bounds while preserving its exact aspect ratio. */
export async function prepareFullImage(file)

   {
  const bitmap = await createImageBitmap(file)
  const maxSide = 1568
  const minSide = 280
  let width = bitmap.width
  let height = bitmap.height

  const longest = Math.max(width, height)
  if (longest > maxSide) {
    const scale = maxSide / longest
    width = Math.round(width * scale)
    height = Math.round(height * scale)
  }
  const shortest = Math.min(width, height)
  if (shortest < minSide) {
    const scale = minSide / shortest
    width = Math.min(maxSide, Math.round(width * scale))
    height = Math.min(maxSide, Math.round(height * scale))
  }

  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    bitmap.close()
    throw new Error("No se pudo preparar la imagen.")
  }
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.92),
  )
  if (!blob) throw new Error("No se pudo preparar la imagen.")
  return {
    file: new File([blob], "source-full-v3.jpg", { type: "image/jpeg" }),
    width,
    height,
  }
}

/**
 * Crops the detected bounding box with a slight margin, produces:
 * 1) A clean high-res pixel buffer (ImageData) for client-side chromatic/Sobel super-resolution
 * 2) Optionally overlays a subtle visual coordinate reticle onto the JPEG sent to JEV (Visual Prompting)
 */
export async function prepareCropWithVisualGrid(
  sourceFile,
  rawBox,
  baseGrid,
  useVisualPromptGrid,
  paddingRatio = 0.08,
)

   {
  const bitmap = await createImageBitmap(sourceFile)
  const boxWidth = rawBox.right - rawBox.left
  const boxHeight = rawBox.bottom - rawBox.top

  const padX = boxWidth * paddingRatio
  const padY = boxHeight * paddingRatio

  const paddedBox = {
    left: Math.max(0, rawBox.left - padX),
    top: Math.max(0, rawBox.top - padY),
    right: Math.min(1, rawBox.right + padX),
    bottom: Math.min(1, rawBox.bottom + padY),
  }

  const sx = Math.floor(paddedBox.left * bitmap.width)
  const sy = Math.floor(paddedBox.top * bitmap.height)
  const sw = Math.max(16, Math.ceil((paddedBox.right - paddedBox.left) * bitmap.width))
  const sh = Math.max(16, Math.ceil((paddedBox.bottom - paddedBox.top) * bitmap.height))

  const targetLongest = 768
  const minSide = 320
  let outW = sw
  let outH = sh

  const scaleToTarget = targetLongest / Math.max(outW, outH)
  outW = Math.round(outW * scaleToTarget)
  outH = Math.round(outH * scaleToTarget)

  if (Math.min(outW, outH) < minSide) {
    const up = minSide / Math.min(outW, outH)
    outW = Math.min(1568, Math.round(outW * up))
    outH = Math.min(1568, Math.round(outH * up))
  }

  const cleanCanvas = document.createElement("canvas")
  cleanCanvas.width = outW
  cleanCanvas.height = outH
  const cleanCtx = cleanCanvas.getContext("2d")
  if (!cleanCtx) {
    bitmap.close()
    throw new Error("No se pudo recortar la región.")
  }
  cleanCtx.fillStyle = "#ffffff"
  cleanCtx.fillRect(0, 0, outW, outH)
  cleanCtx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH)
  bitmap.close()

  const cleanImageData = cleanCtx.getImageData(0, 0, outW, outH)
  const cleanBlob = await new Promise((resolve) =>
    cleanCanvas.toBlob(resolve, "image/jpeg", 0.94),
  )
  if (!cleanBlob) throw new Error("No se pudo exportar el recorte limpio.")
  const cleanPreviewUrl = URL.createObjectURL(cleanBlob)

  const gridCanvas = document.createElement("canvas")
  gridCanvas.width = outW
  gridCanvas.height = outH
  const gridCtx = gridCanvas.getContext("2d")
  if (!gridCtx) throw new Error("No se pudo crear la retícula visual.")
  gridCtx.drawImage(cleanCanvas, 0, 0)

  gridCtx.save()
  for (let i = 1; i < baseGrid; i++) {
    const x = (i / baseGrid) * outW
    const y = (i / baseGrid) * outH
    const isMajor = i % 4 === 0

    gridCtx.strokeStyle = isMajor ? "rgba(255, 255, 255, 0.34)" : "rgba(255, 255, 255, 0.14)"
    gridCtx.lineWidth = isMajor ? 1.25 : 0.75
    gridCtx.beginPath()
    gridCtx.moveTo(x, 0)
    gridCtx.lineTo(x, outH)
    gridCtx.moveTo(0, y)
    gridCtx.lineTo(outW, y)
    gridCtx.stroke()

    gridCtx.strokeStyle = isMajor ? "rgba(0, 0, 0, 0.28)" : "rgba(0, 0, 0, 0.12)"
    gridCtx.beginPath()
    gridCtx.moveTo(x + 0.75, 0)
    gridCtx.lineTo(x + 0.75, outH)
    gridCtx.moveTo(0, y + 0.75)
    gridCtx.lineTo(outW, y + 0.75)
    gridCtx.stroke()
  }
  gridCtx.restore()

  const gridBlob = await new Promise((resolve) =>
    gridCanvas.toBlob(resolve, "image/jpeg", 0.94),
  )
  if (!gridBlob) throw new Error("No se pudo exportar la retícula visual.")
  const gridPreviewUrl = URL.createObjectURL(gridBlob)

  const chosenBlob = useVisualPromptGrid ? gridBlob : cleanBlob
  return {
    apiFile: new File([chosenBlob], "source-crop-v3.jpg", { type: "image/jpeg" }),
    cleanPreviewUrl,
    gridPreviewUrl,
    paddedBox,
    cleanImageData,
  }
}

export function sampleBilinearGrid(gridMap, baseGrid, u, v) {
  const gx = Math.max(0, Math.min(baseGrid - 1, u * baseGrid - 0.5))
  const gy = Math.max(0, Math.min(baseGrid - 1, v * baseGrid - 0.5))
  const x0 = Math.floor(gx)
  const y0 = Math.floor(gy)
  const x1 = Math.min(baseGrid - 1, x0 + 1)
  const y1 = Math.min(baseGrid - 1, y0 + 1)
  const tx = gx - x0
  const ty = gy - y0

  const p00 = gridMap[y0 * baseGrid + x0]
  const p10 = gridMap[y0 * baseGrid + x1]
  const p01 = gridMap[y1 * baseGrid + x0]
  const p11 = gridMap[y1 * baseGrid + x1]

  const top = p00 * (1 - tx) + p10 * tx
  const bot = p01 * (1 - tx) + p11 * tx
  return top * (1 - ty) + bot * ty
}

export function colorDistance(a, b) {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  const dl = a.luma - b.luma
  return Math.sqrt(2.2 * dr * dr + 4.2 * dg * dg + 1.6 * db * db + 2.0 * dl * dl)
}

export function extractQuantilePrototypes(samples, k = 4) {
  if (samples.length === 0) {
    return [{ r: 128, g: 128, b: 128, luma: 128 }]
  }
  const sorted = [...samples].sort((a, b) => a.luma - b.luma)
  const clusters = []
  for (let i = 0; i < k; i++) {
    const start = Math.floor((i / k) * sorted.length)
    const end = Math.max(start + 1, Math.floor(((i + 1) / k) * sorted.length))
    let r = 0
    let g = 0
    let b = 0
    let luma = 0
    const count = end - start
    for (let j = start; j < end; j++) {
      r += sorted[j].r
      g += sorted[j].g
      b += sorted[j].b
      luma += sorted[j].luma
    }
    clusters.push({
      r: r / count,
      g: g / count,
      b: b / count,
      luma: luma / count,
    })
  }
  return clusters
}

export function minClusterDistance(pixel, prototypes) {
  let best = Infinity
  for (let i = 0; i < prototypes.length; i++) {
    const d = colorDistance(pixel, prototypes[i])
    if (d < best) best = d
  }
  return best
}

export function synthesizeSuperResolution(params

 )

  {
  const { hybrid, imageData, superGrid, edgeAlpha, subBoxWeight } = params
  const { baseGrid, cells, subBoxes } = hybrid
  const { width, height, data } = imageData

  const gridMap = new Float32Array(baseGrid * baseGrid)
  for (const c of cells) {
    if (c.row >= 0 && c.row < baseGrid && c.col >= 0 && c.col < baseGrid) {
      gridMap[c.row * baseGrid + c.col] = c.probability
    }
  }

  const cellColors = new Array(superGrid * superGrid)
  for (let r = 0; r < superGrid; r++) {
    const y0 = Math.floor((r / superGrid) * height)
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) / superGrid) * height))
    for (let c = 0; c < superGrid; c++) {
      const x0 = Math.floor((c / superGrid) * width)
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) / superGrid) * width))
      let sr = 0
      let sg = 0
      let sb = 0
      let count = 0
      const stepY = Math.max(1, Math.floor((y1 - y0) / 3))
      const stepX = Math.max(1, Math.floor((x1 - x0) / 3))
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const idx = (y * width + x) * 4
          sr += data[idx]
          sg += data[idx + 1]
          sb += data[idx + 2]
          count++
        }
      }
      const mr = sr / Math.max(1, count)
      const mg = sg / Math.max(1, count)
      const mb = sb / Math.max(1, count)
      const luma = 0.299 * mr + 0.587 * mg + 0.114 * mb
      cellColors[r * superGrid + c] = { r: mr, g: mg, b: mb, luma }
    }
  }

  const sobelMag = new Float32Array(superGrid * superGrid)
  let maxSobel = 1
  for (let r = 1; r < superGrid - 1; r++) {
    for (let c = 1; c < superGrid - 1; c++) {
      const tl = cellColors[(r - 1) * superGrid + (c - 1)].luma
      const tc = cellColors[(r - 1) * superGrid + c].luma
      const tr = cellColors[(r - 1) * superGrid + (c + 1)].luma
      const ml = cellColors[r * superGrid + (c - 1)].luma
      const mr = cellColors[r * superGrid + (c + 1)].luma
      const bl = cellColors[(r + 1) * superGrid + (c - 1)].luma
      const bc = cellColors[(r + 1) * superGrid + c].luma
      const br = cellColors[(r + 1) * superGrid + (c + 1)].luma

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br
      const mag = Math.sqrt(gx * gx + gy * gy)
      sobelMag[r * superGrid + c] = mag
      if (mag > maxSobel) maxSobel = mag
    }
  }

  const fgSeeds = []
  const bgSeeds = []

  for (let r = 0; r < superGrid; r++) {
    const v = (r + 0.5) / superGrid
    for (let c = 0; c < superGrid; c++) {
      const u = (c + 0.5) / superGrid
      const pSem = sampleBilinearGrid(gridMap, baseGrid, u, v)
      const color = cellColors[r * superGrid + c]
      if (pSem >= 0.76) {
        fgSeeds.push(color)
      } else if (pSem <= 0.22) {
        bgSeeds.push(color)
      }
    }
  }

  const fgPrototypes = extractQuantilePrototypes(fgSeeds, 5)
  const bgPrototypes = extractQuantilePrototypes(bgSeeds, 5)

  const microCells = new Array(superGrid * superGrid)
  let refinedBandCount = 0

  for (let r = 0; r < superGrid; r++) {
    const v = (r + 0.5) / superGrid
    for (let c = 0; c < superGrid; c++) {
      const u = (c + 0.5) / superGrid
      const idx = r * superGrid + c

      const pNoul = sampleBilinearGrid(gridMap, baseGrid, u, v)

      let insideStructuralSubBox = 0
      for (const sb of subBoxes) {
        if (
          u >= sb.box.left &&
          u <= sb.box.right &&
          v >= sb.box.top &&
          v <= sb.box.bottom
        ) {
          const dx = Math.min(u - sb.box.left, sb.box.right - u) / Math.max(0.01, sb.box.right - sb.box.left)
          const dy = Math.min(v - sb.box.top, sb.box.bottom - v) / Math.max(0.01, sb.box.bottom - sb.box.top)
          const edgeFactor = Math.min(1, Math.min(dx, dy) * 6)
          insideStructuralSubBox = Math.max(
            insideStructuralSubBox,
            sb.id === "sub_core" ? 0.65 * edgeFactor : 0.85 * edgeFactor,
          )
        }
      }

      const semanticProb = Math.max(
        0,
        Math.min(
          1,
          pNoul * (1 - subBoxWeight * 0.35) +
            Math.min(pNoul * 1.35, insideStructuralSubBox) * (subBoxWeight * 0.35),
        ),
      )

      const color = cellColors[idx]
      const dFg = minClusterDistance(color, fgPrototypes)
      const dBg = minClusterDistance(color, bgPrototypes)
      const rawChromatic = dBg / Math.max(1e-4, dFg + dBg)

      const normSobel = sobelMag[idx] / maxSobel
      const steepness = 3.2 + normSobel * 3.5
      const chromaticProb = 1 / (1 + Math.exp(-steepness * (rawChromatic - 0.5)))

      const boundaryWeight =
        semanticProb <= 0.08 || semanticProb >= 0.94
          ? 0
          : Math.pow(4 * semanticProb * (1 - semanticProb), 0.75)

      if (boundaryWeight > 0.25) {
        refinedBandCount++
      }

      const effectiveAlpha = edgeAlpha * boundaryWeight
      const fused =
        (1 - effectiveAlpha) * semanticProb + effectiveAlpha * chromaticProb

      microCells[idx] = {
        row: r,
        col: c,
        probability: Math.max(0, Math.min(1, fused)),
        semanticProb,
        chromaticProb,
        boundaryWeight,
      }
    }
  }

  return {
    microCells,
    fgCount: fgSeeds.length,
    bgCount: bgSeeds.length,
    refinedBandCount,
  }
}
