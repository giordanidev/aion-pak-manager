<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useAppTooltip } from '../composables/useAppTooltip'

const { text, x, y, visible } = useAppTooltip()

const tipEl = ref<HTMLElement | null>(null)
const tipSize = ref({ w: 0, h: 0 })

function measure(): void {
  const el = tipEl.value
  if (el) tipSize.value = { w: el.offsetWidth, h: el.offsetHeight }
}

watch([visible, text, x, y], () => {
  if (!visible.value) return
  void nextTick(() => { measure() })
})

const posStyle = computed<Record<string, string>>(() => {
  if (typeof window === 'undefined') return { left: `${x.value}px`, top: `${y.value}px` }
  const margin = 8
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = tipSize.value.w || 240
  const h = tipSize.value.h || 32
  let left = x.value - w / 2
  left = Math.min(Math.max(left, margin), Math.max(margin, vw - w - margin))
  let top = y.value
  if (top + h > vh - margin) top = y.value - h - 12
  top = Math.min(Math.max(top, margin), Math.max(margin, vh - h - margin))
  return { left: `${Math.round(left)}px`, top: `${Math.round(top)}px` }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="tipEl"
      class="fixed z-[1300] pointer-events-none whitespace-normal break-words rounded-md border border-[rgba(200,205,216,0.35)] bg-card px-2.5 py-1.5 text-xs text-text shadow-[0_8px_24px_rgba(0,0,0,0.5)] max-w-80"
      :style="posStyle"
    >{{ text }}</div>
  </Teleport>
</template>
