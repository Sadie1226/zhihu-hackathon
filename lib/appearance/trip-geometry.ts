/** Background and actor share the same un-cropped coordinate space. */
export function actorPlacement(foot: { x: number; y: number; width: number }, anchor = { x: 522, y: 950 },
  canvas = { width: 750, height: 640 }) {
  const size = foot.width
  return { left: foot.x - size * anchor.x / 1024,
    top: foot.y - size * (canvas.width / canvas.height) * anchor.y / 1024, width: size }
}
