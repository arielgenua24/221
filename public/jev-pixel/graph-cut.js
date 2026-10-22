// Portado de jev-to-pix/lib/segmentation/graph-cut.ts (solo se quitaron los tipos).
import { imageDataToLab, labDistanceSq } from "./color.js"

/**
 * Dense label inference on the 4-connected pixel graph.
 *
 * Energy (spec §3.5):
 *   E(L) = Σ_i U_i(L_i) + λ Σ_(i,j) [L_i ≠ L_j] · exp(-‖I_i − I_j‖² / 2σ²)
 *   U_i(1) = −log(P_i + ε),  U_i(0) = −log(1 − P_i + ε)
 *
 * Solver choice: Random Walker (Grady 2006) rather than Boykov–Kolmogorov max-flow.
 * Why: RW is the exact minimizer of the quadratic relaxation of the same energy, yields a
 * continuous probability (needed for the uncertainty band view), is embarrassingly simple to
 * implement without a dynamic graph library, and converges in a few hundred Gauss–Seidel sweeps
 * on 768px crops in well under 200ms. Max-flow would give the exact binary MAP but no soft output.
 *
 * Unary terms enter as a per-pixel "prior edge" to a virtual foreground/background terminal with
 * weight proportional to |U_i(0) − U_i(1)|, so confident JEV answers anchor the solution and
 * uncertain ones defer to image structure. Hard seeds (P > 0.9 / P < 0.1) are clamped.
 */
export function solveGraphCut(
  imageData,
  unary,
  opts,
) {
  const started = performance.now()
  const { width, height } = imageData
  const n = width * height
  const eps = 1e-4
  const lambda = opts.lambda
  const threshold = opts.threshold ?? 0.5

  const lab = imageDataToLab(imageData)

  // Edge weights for right and down neighbors.
  const wRight = new Float32Array(n)
  const wDown = new Float32Array(n)

  let sigma = opts.sigma ?? 0
  if (!sigma) {
    // GrabCut heuristic: sigma = mean edge difference over all 4-connected edges.
    let sum = 0
    let count = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x
        if (x + 1 < width) {
          sum += Math.sqrt(labDistanceSq(lab, p, p + 1))
          count++
        }
        if (y + 1 < height) {
          sum += Math.sqrt(labDistanceSq(lab, p, p + width))
          count++
        }
      }
    }
    sigma = Math.max(1e-3, sum / Math.max(1, count))
  }
  const inv2s2 = 1 / (2 * sigma * sigma)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x
      if (x + 1 < width) wRight[p] = lambda * Math.exp(-labDistanceSq(lab, p, p + 1) * inv2s2)
      if (y + 1 < height) wDown[p] = lambda * Math.exp(-labDistanceSq(lab, p, p + width) * inv2s2)
    }
  }

  // Terminal weights derived from unary energies.
  const wFg = new Float32Array(n)
  const wBg = new Float32Array(n)
  const seed = new Int8Array(n) // 1 fg, -1 bg, 0 free
  const prob = new Float32Array(n)
  for (let p = 0; p < n; p++) {
    const P = Math.max(0, Math.min(1, unary[p]))
    const u1 = -Math.log(P + eps)
    const u0 = -Math.log(1 - P + eps)
    // Scale terminal pull so a decisive prior competes with λ-weighted smoothness.
    const strength = 0.35 * lambda
    wFg[p] = strength * Math.max(0, u0 - u1 > 0 ? Math.min(6, u0 - u1) : 0) / 6
    wBg[p] = strength * Math.max(0, u1 - u0 > 0 ? Math.min(6, u1 - u0) : 0) / 6
    prob[p] = P
    if (P > 0.9) seed[p] = 1
    else if (P < 0.1) seed[p] = -1
  }

  // Gauss–Seidel with red-black ordering on the harmonic system:
  //   x_i = (Σ_j w_ij x_j + wFg_i * 1 + wBg_i * 0) / (Σ_j w_ij + wFg_i + wBg_i)
  // 120 red-black sweeps with over-relaxation keep a 768px crop inside the ~200ms spec budget;
  // the residual at that point is well below the 0.5 decision threshold's sensitivity.
  const maxIter = opts.iterations ?? 120
  const tol = 5e-4
  const omega = 1.6
  let it = 0
  for (; it < maxIter; it++) {
    let maxDelta = 0
    for (let parity = 0; parity < 2; parity++) {
      for (let y = 0; y < height; y++) {
        for (let x = (y + parity) & 1; x < width; x += 2) {
          const p = y * width + x
          if (seed[p] !== 0) {
            prob[p] = seed[p] > 0 ? 1 : 0
            continue
          }
          let num = wFg[p]
          let den = wFg[p] + wBg[p]
          if (x > 0) {
            num += wRight[p - 1] * prob[p - 1]
            den += wRight[p - 1]
          }
          if (x + 1 < width) {
            num += wRight[p] * prob[p + 1]
            den += wRight[p]
          }
          if (y > 0) {
            num += wDown[p - width] * prob[p - width]
            den += wDown[p - width]
          }
          if (y + 1 < height) {
            num += wDown[p] * prob[p + width]
            den += wDown[p]
          }
          if (den <= 0) continue
          const gs = num / den
          const next = Math.max(0, Math.min(1, prob[p] + omega * (gs - prob[p])))
          const d = Math.abs(next - prob[p])
          if (d > maxDelta) maxDelta = d
          prob[p] = next
        }
      }
    }
    if (maxDelta < tol) {
      it++
      break
    }
  }

  const mask = new Uint8Array(n)
  for (let p = 0; p < n; p++) mask[p] = prob[p] >= threshold ? 1 : 0

  return {
    mask,
    probability: prob,
    sigma,
    iterations: it,
    elapsedMs: performance.now() - started,
  }
}
