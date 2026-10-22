// Portado de jev-to-pix/lib/segmentation/color.ts (solo se quitaron los tipos).
/** sRGB (0-255, gamma encoded) -> CIELAB. Returns a Float32Array of length w*h*3. */
export function imageDataToLab(imageData) {
  const { data, width, height } = imageData
  const n = width * height
  const lab = new Float32Array(n * 3)

  const linear = new Float32Array(256)
  for (let i = 0; i < 256; i++) {
    const c = i / 255
    linear[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  }

  const f = (t) =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116

  for (let i = 0; i < n; i++) {
    const r = linear[data[i * 4]]
    const g = linear[data[i * 4 + 1]]
    const b = linear[data[i * 4 + 2]]

    // D65 reference white, normalized
    const x = (r * 0.4124564 + g * 0.3575761 + b * 0.1804375) / 0.95047
    const y = r * 0.2126729 + g * 0.7151522 + b * 0.072175
    const z = (r * 0.0193339 + g * 0.119192 + b * 0.9503041) / 1.08883

    const fx = f(x)
    const fy = f(y)
    const fz = f(z)

    lab[i * 3] = 116 * fy - 16
    lab[i * 3 + 1] = 500 * (fx - fy)
    lab[i * 3 + 2] = 200 * (fy - fz)
  }
  return lab
}

export function labDistanceSq(lab, i, j) {
  const dl = lab[i * 3] - lab[j * 3]
  const da = lab[i * 3 + 1] - lab[j * 3 + 1]
  const db = lab[i * 3 + 2] - lab[j * 3 + 2]
  return dl * dl + da * da + db * db
}
