import { computed, onBeforeUnmount, ref, type ComputedRef, type Ref } from 'vue'

/** Fixed row height of the file-tree rows (`h-7`). */
export const VIRTUAL_ROW_HEIGHT = 28

/**
 * Window over a long list so the file tree only mounts the rows on screen.
 * Building every match into the DOM is what freezes the modal on large PAKs.
 */
export function useVirtualWindow(length: ComputedRef<number> | Ref<number>) {
  const scrollTop = ref(0)
  const viewport = ref(360)
  let observer: ResizeObserver | null = null

  const start = computed(() => Math.max(0, Math.floor(scrollTop.value / VIRTUAL_ROW_HEIGHT) - 8))
  const end = computed(() => {
    const visible = Math.ceil(viewport.value / VIRTUAL_ROW_HEIGHT) + 16
    return Math.min(length.value, start.value + visible)
  })
  const totalHeight = computed(() => length.value * VIRTUAL_ROW_HEIGHT)

  function onScroll(event: Event): void {
    const el = event.currentTarget as HTMLElement
    scrollTop.value = el.scrollTop
  }

  function bind(el: unknown): void {
    observer?.disconnect()
    observer = null
    if (!(el instanceof HTMLElement)) return
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
  })

  return { start, end, totalHeight, onScroll, bind }
}
