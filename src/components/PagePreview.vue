<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { initInk } from '../ink/engine'
import { paintLayers } from '../ink/layers'
import { pageSize } from '../pageSpace'
import type { InkEngine, Page } from '../types'

// Flat (2D mode) page preview: replays the page's layers onto a plain canvas,
// with the same paper underlay the 3D page textures use.
const props = withDefaults(defineProps<{ page: Page; width?: number }>(), { width: 600 })

const canvas = ref<HTMLCanvasElement>()
let ink: InkEngine | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let painting = false
let dirty = false

async function paint() {
  if (disposed) return
  if (painting) {
    dirty = true
    return
  }
  painting = true
  try {
    ink ??= await initInk()
    const c = canvas.value
    if (!c || disposed) return
    const size = pageSize(props.page)
    const w = Math.max(1, Math.round(props.width))
    const h = Math.max(1, Math.round((w * size.h) / size.w))
    if (c.width !== w) c.width = w
    if (c.height !== h) c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    if (!ctx) return
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)
    paintLayers(c, ctx, props.page, ink, w / size.w, 0, 0)
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalCompositeOperation = 'destination-over'
    const g = ctx.createLinearGradient(0, 0, w * 0.35, h)
    g.addColorStop(0, '#fffefa')
    g.addColorStop(1, '#f8f6f0')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, w, h)
    ctx.restore()
  } finally {
    painting = false
    if (dirty && !disposed) {
      dirty = false
      void paint()
    }
  }
}

function schedule() {
  clearTimeout(timer)
  timer = setTimeout(() => void paint(), 30)
}

onMounted(() => void paint())
watch(
  () => [
    props.page,
    props.page.strokes.length,
    props.page.ops?.length ?? 0,
    props.page.layers?.length ?? 0,
    props.width,
  ],
  schedule,
)
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer)
})
</script>

<template>
  <canvas ref="canvas" class="page-preview" />
</template>

<style scoped>
.page-preview {
  display: block;
  width: 100%;
  height: auto;
}
</style>
