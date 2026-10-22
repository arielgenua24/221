// Portado de jev-to-pix/lib/segmentation/slic.ts (solo se quitaron los tipos).
import { imageDataToLab } from "./color.js"

/**
 * SLIC (Achanta et al. 2012) in CIELAB space with a 2S x 2S local search window.
 * Post-processing enforces connectivity by merging fragments smaller than 1/4 of the expected
 * area into their most similar neighbor, which is what lets us print one stable ID per region.
 *
 * TODO(perf): for crops > 768px on slow hardware this can exceed 300ms; move to a Web Worker
 * if measured `elapsedMs` regularly exceeds the spec budget (out of scope for this iteration).
 */
export function computeSlic(
  imageData,
  opts,
) {
  const started = performance.now()
  const { width, height } = imageData
  const n = width * height
  const compactness = opts.compactness ?? 10
  const iterations = opts.iterations ?? 10

  const lab = imageDataToLab(imageData)

  const step = Math.max(2, Math.sqrt(n / opts.k))
  const gridW = Math.max(1, Math.floor(width / step))
  const gridH = Math.max(1, Math.floor(height / step))
  let k = gridW * gridH

  // centers: l, a, b, x, y
  const centers = new Float32Array(k * 5)
  const grad = computeGradientMagnitude(lab, width, height)

  let ci = 0
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let x = Math.floor((gx + 0.5) * (width / gridW))
      let y = Math.floor((gy + 0.5) * (height / gridH))
      // Perturb to lowest gradient in a 3x3 neighborhood so seeds avoid edges.
      let best = Number.POSITIVE_INFINITY
      let bx = x
      let by = y
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
          const g = grad[ny * width + nx]
          if (g < best) {
            best = g
            bx = nx
            by = ny
          }
        }
      }
      x = bx
      y = by
      const p = y * width + x
      centers[ci * 5] = lab[p * 3]
      centers[ci * 5 + 1] = lab[p * 3 + 1]
      centers[ci * 5 + 2] = lab[p * 3 + 2]
      centers[ci * 5 + 3] = x
      centers[ci * 5 + 4] = y
      ci++
    }
  }

  const labels = new Int32Array(n).fill(-1)
  const distances = new Float32Array(n)
  const invS2 = 1 / (step * step)
  const invM2 = 1 / (compactness * compactness)

  for (let it = 0; it < iterations; it++) {
    distances.fill(Number.POSITIVE_INFINITY)

    for (let c = 0; c < k; c++) {
      const cl = centers[c * 5]
      const ca = centers[c * 5 + 1]
      const cb = centers[c * 5 + 2]
      const cx = centers[c * 5 + 3]
      const cy = centers[c * 5 + 4]

      const x0 = Math.max(0, Math.floor(cx - step))
      const x1 = Math.min(width - 1, Math.ceil(cx + step))
      const y0 = Math.max(0, Math.floor(cy - step))
      const y1 = Math.min(height - 1, Math.ceil(cy + step))

      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const p = y * width + x
          const dl = lab[p * 3] - cl
          const da = lab[p * 3 + 1] - ca
          const db = lab[p * 3 + 2] - cb
          const dc2 = dl * dl + da * da + db * db
          const dx = x - cx
          const dy = y - cy
          const ds2 = dx * dx + dy * dy
          // Normalized SLIC distance: D^2 = dc^2 / m^2 + ds^2 / S^2
          const d = dc2 * invM2 + ds2 * invS2
          if (d < distances[p]) {
            distances[p] = d
            labels[p] = c
          }
        }
      }
    }

    // Update centers
    const acc = new Float64Array(k * 5)
    const counts = new Int32Array(k)
    for (let p = 0; p < n; p++) {
      const c = labels[p]
      if (c < 0) continue
      acc[c * 5] += lab[p * 3]
      acc[c * 5 + 1] += lab[p * 3 + 1]
      acc[c * 5 + 2] += lab[p * 3 + 2]
      acc[c * 5 + 3] += p % width
      acc[c * 5 + 4] += Math.floor(p / width)
      counts[c]++
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] === 0) continue
      const inv = 1 / counts[c]
      for (let j = 0; j < 5; j++) centers[c * 5 + j] = acc[c * 5 + j] * inv
    }
  }

  // Any pixel never reached by a window (rare at borders) gets nearest center by position.
  for (let p = 0; p < n; p++) {
    if (labels[p] >= 0) continue
    const x = p % width
    const y = Math.floor(p / width)
    let best = Number.POSITIVE_INFINITY
    let bc = 0
    for (let c = 0; c < k; c++) {
      const dx = x - centers[c * 5 + 3]
      const dy = y - centers[c * 5 + 4]
      const d = dx * dx + dy * dy
      if (d < best) {
        best = d
        bc = c
      }
    }
    labels[p] = bc
  }

  const connected = enforceConnectivity(labels, width, height, step * step)
  k = connected.k

  const centroids = new Float32Array(k * 2)
  const sizes = new Int32Array(k)
  for (let p = 0; p < n; p++) {
    const c = connected.labels[p]
    centroids[c * 2] += p % width
    centroids[c * 2 + 1] += Math.floor(p / width)
    sizes[c]++
  }
  for (let c = 0; c < k; c++) {
    if (sizes[c] > 0) {
      centroids[c * 2] /= sizes[c]
      centroids[c * 2 + 1] /= sizes[c]
    }
  }

  return {
    labels: connected.labels,
    k,
    centroids,
    sizes,
    elapsedMs: performance.now() - started,
  }
}

function computeGradientMagnitude(lab, width, height) {
  const grad = new Float32Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x
      const l = lab[(p - 1) * 3]
      const r = lab[(p + 1) * 3]
      const u = lab[(p - width) * 3]
      const d = lab[(p + width) * 3]
      grad[p] = (r - l) * (r - l) + (d - u) * (d - u)
    }
  }
  return grad
}

/**
 * Relabels connected components and merges fragments < expectedArea/4 into the
 * neighboring label they touch first. Returns a dense 0..k-1 labeling.
 */
function enforceConnectivity(
  labels,
  width,
  height,
  expectedArea,
) {
  const n = width * height
  const out = new Int32Array(n).fill(-1)
  const minSize = Math.max(4, Math.floor(expectedArea / 4))
  const stack = new Int32Array(n)
  let nextLabel = 0
  let adjacentLabel = 0

  for (let p0 = 0; p0 < n; p0++) {
    if (out[p0] >= 0) continue
    const original = labels[p0]

    // Find an already-labeled neighbor to absorb into if this component is too small.
    adjacentLabel = -1
    {
      const x = p0 % width
      const y = Math.floor(p0 / width)
      const cand = [
        x > 0 ? p0 - 1 : -1,
        y > 0 ? p0 - width : -1,
      ]
      for (const q of cand) {
        if (q >= 0 && out[q] >= 0) {
          adjacentLabel = out[q]
          break
        }
      }
    }

    let top = 0
    stack[top++] = p0
    out[p0] = nextLabel
    let count = 0
    const members = []

    while (top > 0) {
      const p = stack[--top]
      members.push(p)
      count++
      const x = p % width
      const y = Math.floor(p / width)
      const nbrs = [
        x > 0 ? p - 1 : -1,
        x < width - 1 ? p + 1 : -1,
        y > 0 ? p - width : -1,
        y < height - 1 ? p + width : -1,
      ]
      for (const q of nbrs) {
        if (q >= 0 && out[q] < 0 && labels[q] === original) {
          out[q] = nextLabel
          stack[top++] = q
        }
      }
    }

    if (count < minSize && adjacentLabel >= 0) {
      for (const p of members) out[p] = adjacentLabel
    } else {
      nextLabel++
    }
  }

  return { labels: out, k: nextLabel }
}
