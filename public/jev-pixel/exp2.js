// Portado de jev-to-pix/components/experiment-two.tsx (solo se quitaron los tipos y se exportaron las funciones).
// Experimento 2: preparar la imagen completa y recortar la caja de JEV.
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
    file: new File([blob], "source-full.jpg", { type: "image/jpeg" }),
    width,
    height,
  }
}

/**
 * Pad the detected box slightly so the edges of the subject (e.g. hat brim) are included,
 * then crop that region and upscale it to at least 640px so JEV inspects the subject up close.
 */
export async function cropBoxForJev(
  sourceFile,
  rawBox,
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

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.94),
  )
  if (!blob) throw new Error("No se pudo exportar el recorte.")

  const croppedFile = new File([blob], "crop-focus.jpg", { type: "image/jpeg" })
  const croppedPreviewUrl = URL.createObjectURL(croppedFile)

  return { croppedFile, croppedPreviewUrl, paddedBox }
}
