<script setup lang="ts">
import { covers } from '../store'
import { centeredRect, morphTo } from '../anim'
import type { Journal } from '../types'

// Flat shelf used by the 2D graphics mode: a responsive grid of DOM book
// cards instead of the WebGL shelf scene.
defineProps<{ journals: Journal[] }>()
const emit = defineEmits<{ open: [id: string]; menu: [id: string] }>()

// Long press mirrors the WebGL shelf (550 ms without travel) and opens the
// journal menu; the click that follows the release is swallowed.
const HOLD_MS = 550
const HOLD_SLOP = 10
let holdTimer: ReturnType<typeof setTimeout> | undefined
let hold: { id: string; x: number; y: number } | null = null
let swallowClick = false

function cancelHold() {
  if (holdTimer !== undefined) clearTimeout(holdTimer)
  holdTimer = undefined
  hold = null
}

function press(id: string, ev: PointerEvent) {
  cancelHold()
  swallowClick = false
  hold = { id, x: ev.clientX, y: ev.clientY }
  holdTimer = setTimeout(() => {
    holdTimer = undefined
    if (!hold) return
    swallowClick = true
    emit('menu', hold.id)
  }, HOLD_MS)
}

function move(ev: PointerEvent) {
  if (!hold) return
  if (Math.hypot(ev.clientX - hold.x, ev.clientY - hold.y) > HOLD_SLOP) cancelHold()
}

function coverColor(j: Journal) {
  return covers[j.cover % covers.length]
}

function open(id: string, ev: Event) {
  cancelHold()
  if (swallowClick) {
    swallowClick = false
    return
  }
  const target = ev.currentTarget as HTMLElement | null
  const cover = target?.querySelector<HTMLElement>('.book-cover')
  if (!cover) {
    emit('open', id)
    return
  }
  morphTo(centeredRect(), cover)
  setTimeout(() => emit('open', id), 110)
}
</script>

<template>
  <div class="shelf2d">
    <div v-for="j in journals" :key="j.id" class="book2d">
      <button
        class="book-card"
        @click="open(j.id, $event)"
        @pointerdown="press(j.id, $event)"
        @pointermove="move"
        @pointerup="cancelHold"
        @pointercancel="cancelHold"
        @pointerleave="cancelHold"
      >
        <span
          class="book-cover"
          :class="[`cover-${j.coverTexture ?? 'paper'}`, { 'has-photo': !!j.coverImg }]"
          :style="{ backgroundColor: coverColor(j) }"
        >
          <span
            v-if="j.coverImg"
            class="book-photo"
            :style="{ backgroundImage: `url(${j.coverImg})` }"
          />
          <span class="book-spine" />
        </span>
      </button>
      <button
        class="book-menu"
        @click.stop="emit('menu', j.id)"
        :aria-label="$t('shelf.menu')"
        :title="$t('shelf.menu')"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <circle cx="6" cy="12" r="1.6" fill="currentColor" />
          <circle cx="12" cy="12" r="1.6" fill="currentColor" />
          <circle cx="18" cy="12" r="1.6" fill="currentColor" />
        </svg>
      </button>
      <span class="book-title2d">{{ j.title }}</span>
      <span class="pages-count">{{ $t('journal.count', j.pages.length) }}</span>
    </div>
  </div>
</template>

<style scoped>
.shelf2d {
  position: absolute;
  inset: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
  align-content: start;
  gap: 28px 22px;
  padding: 156px 26px 108px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.book2d {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 0;
}
.book-card {
  display: block;
  width: 100%;
  padding: 0;
}
.book-cover {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 0.735;
  border-radius: 4px 10px 10px 4px;
  overflow: hidden;
  background-image: linear-gradient(105deg, rgba(255,255,255,.18) 0%, rgba(255,255,255,.02) 45%, rgba(0,0,0,.18) 100%);
  box-shadow: 0 14px 32px rgba(32,33,31,.2), inset 0 0 0 1px rgba(255,255,255,.08);
  transition: transform .25s ease, box-shadow .25s ease;
}
@media (hover: hover) {
  .book2d:hover .book-cover {
    transform: translateY(-6px);
    box-shadow: 0 20px 40px rgba(32,33,31,.24), inset 0 0 0 1px rgba(255,255,255,.08);
  }
}
.book-photo {
  position: absolute;
  inset: 0;
  background-size: cover;
  background-position: center;
}
.book-spine {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 9%;
  background: rgba(0,0,0,.24);
  box-shadow: 2px 0 4px rgba(0,0,0,.08);
}
.cover-paper::after,
.cover-comic::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.cover-paper::after {
  opacity: .55;
  background-image:
    repeating-linear-gradient(0deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px),
    repeating-linear-gradient(90deg, rgba(0,0,0,.035) 0 1px, transparent 1px 3px);
}
.cover-comic::after {
  opacity: .45;
  background-image: radial-gradient(rgba(24,18,15,.55) .8px, transparent 1px);
  background-size: 7px 7px;
}
.book-cover.has-photo::after { display: none; }
.book-menu {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(27,28,25,.72);
  color: #fff;
  opacity: 1;
}
@media (hover: hover) {
  .book-menu { opacity: 0; transition: opacity .15s ease; }
  .book2d:hover .book-menu,
  .book-menu:focus-visible { opacity: 1; }
}
.book-title2d {
  margin-top: 10px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--paper-text);
  font-size: 13px;
  font-weight: 600;
}
.book2d .pages-count { margin-top: 4px; }
@media (max-width: 600px) {
  .shelf2d {
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 22px 16px;
    padding: 184px 16px 96px;
  }
}
</style>
