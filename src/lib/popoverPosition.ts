/** Keep an anchored panel inside the viewport, preferring space below. */
export function getPopoverPosition(
  anchor: { top: number; bottom: number; right: number },
  viewport: { width: number; height: number },
  panelHeight: number,
) {
  const margin = 8
  const gap = 4
  const width = Math.min(380, Math.max(0, viewport.width - margin * 2))
  const height = Math.min(panelHeight, Math.max(0, viewport.height - margin * 2))
  const below = viewport.height - margin - anchor.bottom - gap
  const above = anchor.top - gap - margin
  const preferredTop = below >= height || below >= above
    ? anchor.bottom + gap
    : anchor.top - gap - height
  return {
    width,
    maxHeight: Math.max(0, viewport.height - margin * 2),
    left: Math.max(margin, Math.min(anchor.right - width, viewport.width - width - margin)),
    top: Math.max(margin, Math.min(preferredTop, viewport.height - height - margin)),
  }
}
