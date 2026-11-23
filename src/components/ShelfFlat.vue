<script setup lang="ts">
import { covers } from '../store'
import { centeredRect, morphTo } from '../anim'
import { useLongPress } from '../longPress'
import type { Journal } from '../types'

// Flat shelf used by the 2D graphics mode: a responsive grid of DOM book
// cards instead of the WebGL shelf scene.
defineProps<{ journals: Journal[] }>()
const emit = defineEmits<{ open: [id: string]; menu: [id: string] }>()

// Long press mirrors the WebGL shelf (550 ms without travel) and opens the
// journal menu; the click that follows the release is swallowed. There is no
// visible menu button in the flat shelf.
const press = useLongPress((id) => emit('menu', id))

function coverColor(j: Journal) {
  return covers[j.cover % covers.length]
}

function open(id: string, ev: Event) {
  press.cancel()
  if (press.consumeClick()) return
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
        @pointerdown="press.press(j.id, $event)"
        @pointermove="press.move"
        @pointerup="press.cancel"
        @pointercancel="press.cancel"
        @pointerleave="press.cancel"
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
