import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'

/** Fixed row height of the file-tree rows (`h-7`). */
export const VIRTUAL_ROW_HEIGHT = 28

/** Chrome clips a scroll box past ~33.5M px. Stay under that so a huge result set still scrolls. */
const MAX_SCROLL_PX = 16_777_216

/**
 * Window over a long list so the file tree only mounts the rows on screen.
 * Building every match into the DOM is what freezes the modal on large PAKs.
 */
export function useVirtualWindow(length: ComputedRef<number> | Ref<number>) {
  const scrollTop = ref(0)
  const viewport = ref(360)
  let observer: ResizeObserver | null = null
  let bound: HTMLElement | null = null

  const fullHeight = computed(() => length.value * VIRTUAL_ROW_HEIGHT)
  const scaled = computed(() => fullHeight.value > MAX_SCROLL_PX)
  const totalHeight = computed(() => (scaled.value ? MAX_SCROLL_PX : fullHeight.value))

  const anchor = computed(() => {
    if (!scaled.value) return Math.floor(scrollTop.value / VIRTUAL_ROW_HEIGHT)
    const visibleRows = Math.max(1, Math.ceil(viewport.value / VIRTUAL_ROW_HEIGHT))
    const maxAnchor = Math.max(0, length.value - visibleRows)
    const maxScroll = Math.max(1, totalHeight.value - viewport.value)
    const progress = Math.min(1, Math.max(0, scrollTop.value / maxScroll))
    return Math.floor(progress * maxAnchor)
  })

  const start = computed(() => Math.max(0, anchor.value - 8))
  const end = computed(() => {
    const visible = Math.ceil(viewport.value / VIRTUAL_ROW_HEIGHT) + 16
    return Math.min(length.value, start.value + visible)
  })

  function rowTop(index: number): number {
    if (!scaled.value) return index * VIRTUAL_ROW_HEIGHT
    return scrollTop.value + (index - anchor.value) * VIRTUAL_ROW_HEIGHT
  }

  function onScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement
    scrollTop.value = el.scrollTop
  }

  function scrollToTop(): void {
    scrollTop.value = 0
    if (bound) bound.scrollTop = 0
  }

  function bind(el: unknown): void {
    observer?.disconnect()
    observer = null
    bound = null
    if (!(el instanceof HTMLElement)) return
    bound = el
    viewport.value = el.clientHeight || 360
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => {
        viewport.value = el.clientHeight || 360
      })
      observer.observe(el)
    }
  }

  onBeforeUnmount(() => {
    observer?.disconnect()
    bound = null
  })

  return { start, end, totalHeight, onScroll, bind, rowTop, scrollToTop }
}
