// Portado de jev-to-pix/components/experiment-four.tsx (solo se quitaron los tipos y se exportaron las funciones).
// Experimento 4: recorte y campo unario (superpíxeles calibrados por color).
export const K_OPTIONS = [256, 400, 600]
export const PRESENT_THRESHOLD = 0.35
export const TILE_GRID = 16
export const UNCERTAINTY_BAND = [0.25, 0.75]
export const TILE_UPSCALE = 4
export const CROP_PADDING = 0.08
export const CROP_MAX_SIDE = 768

export function formatPercent(value) {
  return `${Math.round(value * 100)}%`
}

export function formatMs(value) {
  return `${Math.round(value)} ms`
}

export async function prepareFullImage(file) {
  const bitmap = await createImageBitmap(file)
  const maxSide = 1568
  const minSide = 280
  let width = bitmap.width
  let height = bitmap.height
  const longest = Math.max(width, height)
  if (longest > maxSide) {
    const s = maxSide / longest
    width = Math.round(width * s)
    height = Math.round(height * s)
  }
  const shortest = Math.min(width, height)
  if (shortest < minSide) {
    const s = minSide / shortest
    width = Math.min(maxSide, Math.round(width * s))
    height = Math.min(maxSide, Math.round(height * s))
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
  const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.92))
  if (!blob) throw new Error("No se pudo preparar la imagen.")
  return { file: new File([blob], "source-full-v4.jpg", { type: "image/jpeg" }), width, height }
}

export async function cropToCanvas(
  sourceFile,
  rawBox,
) {
  const bitmap = await createImageBitmap(sourceFile)
  const bw = rawBox.right - rawBox.left
  const bh = rawBox.bottom - rawBox.top
  const paddedBox = {
    left: Math.max(0, rawBox.left - bw * CROP_PADDING),
    top: Math.max(0, rawBox.top - bh * CROP_PADDING),
    right: Math.min(1, rawBox.right + bw * CROP_PADDING),
    bottom: Math.min(1, rawBox.bottom + bh * CROP_PADDING),
  }
  const sx = Math.floor(paddedBox.left * bitmap.width)
  const sy = Math.floor(paddedBox.top * bitmap.height)
  const sw = Math.max(16, Math.ceil((paddedBox.right - paddedBox.left) * bitmap.width))
  const sh = Math.max(16, Math.ceil((paddedBox.bottom - paddedBox.top) * bitmap.height))

  let outW = sw
  let outH = sh
  const scale = CROP_MAX_SIDE / Math.max(outW, outH)
  if (scale < 1) {
    outW = Math.round(outW * scale)
    outH = Math.round(outH * scale)
  }
  if (Math.min(outW, outH) < 320) {
    const up = 320 / Math.min(outW, outH)
    outW = Math.min(1568, Math.round(outW * up))
    outH = Math.min(1568, Math.round(outH * up))
  }

  const canvas = document.createElement("canvas")
  canvas.width = outW
  canvas.height = outH
  const ctx = canvas.getContext("2d")
  if (!ctx) {
    bitmap.close()
    throw new Error("No se pudo recortar la región.")
  }
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, outW, outH)
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, outW, outH)
  bitmap.close()
  const imageData = ctx.getImageData(0, 0, outW, outH)
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"))
  if (!blob) throw new Error("No se pudo exportar el recorte.")
  return { canvas, paddedBox, imageData, cleanUrl: URL.createObjectURL(blob) }
}

export function colorDist(a, b) {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  const dl = a.luma - b.luma
  return Math.sqrt(2.2 * dr * dr + 4.2 * dg * dg + 1.6 * db * db + 2.0 * dl * dl)
}

export function quantilePrototypes(samples, k = 4) {
  if (samples.length === 0) return [{ r: 128, g: 128, b: 128, luma: 128 }]
  const sorted = [...samples].sort((a, b) => a.luma - b.luma)
  const out = []
  for (let i = 0; i < k; i++) {
    const s = Math.floor((i / k) * sorted.length)
    const e = Math.max(s + 1, Math.floor(((i + 1) / k) * sorted.length))
    let r = 0
    let g = 0
    let b = 0
    let luma = 0
    for (let j = s; j < e; j++) {
      r += sorted[j].r
      g += sorted[j].g
      b += sorted[j].b
      luma += sorted[j].luma
    }
    const c = e - s
    out.push({ r: r / c, g: g / c, b: b / c, luma: luma / c })
  }
  return out
}

export function minProtoDist(sample, protos) {
  let best = Infinity
  for (let i = 0; i < protos.length; i++) {
    const d = colorDist(sample, protos[i])
    if (d < best) best = d
  }
  return best
}

/**
 * Projects JEV superpixel probabilities P_k onto pixels, calibrating each superpixel with
 * foreground/background color prototypes seeded from JEV's high-confidence regions and
 * attenuating outside the Cycle 1 / morphological core box.
 */
export function buildUnaryField(
  slic,
  probabilities,
  imageData,
  coreBox,
) {
  const { width, height, data } = imageData
  const unary = new Float32Array(width * height)
  const k = slic.k

  // Compute mean color per superpixel
  const sumR = new Float64Array(k)
  const sumG = new Float64Array(k)
  const sumB = new Float64Array(k)
  const counts = new Int32Array(k)
  for (let p = 0; p < width * height; p++) {
    const lbl = slic.labels[p]
    if (lbl < 0 || lbl >= k) continue
    sumR[lbl] += data[p * 4]
    sumG[lbl] += data[p * 4 + 1]
    sumB[lbl] += data[p * 4 + 2]
    counts[lbl]++
  }

  const spColors = new Array(k)
  const fgSeeds = []
  const bgSeeds = []

  for (let i = 0; i < k; i++) {
    const c = Math.max(1, counts[i])
    const r = sumR[i] / c
    const g = sumG[i] / c
    const b = sumB[i] / c
    const proto = { r, g, b, luma: 0.299 * r + 0.587 * g + 0.114 * b }
    spColors[i] = proto

    const cx = slic.centroids[i * 2] / Math.max(1, width)
    const cy = slic.centroids[i * 2 + 1] / Math.max(1, height)
    const insideCore = coreBox
      ? cx >= coreBox.left && cx <= coreBox.right && cy >= coreBox.top && cy <= coreBox.bottom
      : true
    const P = probabilities[i] ?? 0.5
    if (!insideCore || P <= 0.28) {
      bgSeeds.push(proto)
    } else if (insideCore && P >= 0.72) {
      fgSeeds.push(proto)
    }
  }

  const fgProtos = quantilePrototypes(fgSeeds, 4)
  const bgProtos = quantilePrototypes(bgSeeds, 4)
  const hasBothSeeds = fgSeeds.length >= 2 && bgSeeds.length >= 2

  const spCalibrated = new Float32Array(k)
  for (let i = 0; i < k; i++) {
    const rawP = probabilities[i] ?? 0.5
    if (!hasBothSeeds) {
      spCalibrated[i] = rawP
      continue
    }
    const dFg = minProtoDist(spColors[i], fgProtos)
    const dBg = minProtoDist(spColors[i], bgProtos)
    const ratio = dBg / Math.max(1e-4, dFg + dBg)
    const pChrom = 1 / (1 + Math.exp(-(ratio - 0.5) * 9))
    spCalibrated[i] = Math.max(0.01, Math.min(0.99, 0.45 * rawP + 0.55 * pChrom))
  }

  const expanded = coreBox
    ? {
        left: Math.max(0, coreBox.left - 0.03 * (coreBox.right - coreBox.left)),
        right: Math.min(1, coreBox.right + 0.03 * (coreBox.right - coreBox.left)),
        top: Math.max(0, coreBox.top - 0.03 * (coreBox.bottom - coreBox.top)),
        bottom: Math.min(1, coreBox.bottom + 0.03 * (coreBox.bottom - coreBox.top)),
      }
    : null

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      let P = spCalibrated[slic.labels[p]] ?? 0.5
      if (expanded) {
        const u = (x + 0.5) / width
        const inside = u >= expanded.left && u <= expanded.right && v >= expanded.top && v <= expanded.bottom
        if (!inside) P *= 0.25
      }
      unary[p] = P
    }
  }
  return unary
}
