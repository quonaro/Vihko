export function shouldClearHoverOnCanvasLeave(
  relatedTarget: EventTarget | null,
  stage: HTMLElement | null,
): boolean {
  return !(
    relatedTarget &&
    typeof Node !== 'undefined' &&
    relatedTarget instanceof Node &&
    stage?.contains(relatedTarget)
  )
}
