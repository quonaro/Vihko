// The journal the shelf should pull back out of when it appears next. The
// journal view remembers it right before handing the screen back, so the
// shelf's arrival animation starts from that cover instead of the row centre.
// One-shot: taking the hint clears it, so a plain boot starts from the middle.
let pending: string | null = null

export function rememberShelfOrigin(id: string | null) {
  pending = id
}

export function takeShelfOrigin(): string | null {
  const id = pending
  pending = null
  return id
}
