import type { Directive } from 'vue'
import { hideTooltip, moveTooltip, showTooltip } from '../composables/useAppTooltip'

function toText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return String(value)
}

function rectHasBox(r: DOMRect): boolean {
  return r.width > 0 || r.height > 0
}

function anchorFor(el: HTMLElement, evt?: PointerEvent | null): { x: number; y: number } | null {
  const r = el.getBoundingClientRect()
  if (rectHasBox(r)) {
    return { x: r.left + r.width / 2, y: r.bottom + 6 }
  }
  if (evt && typeof evt.clientX === 'number') {
    return { x: evt.clientX, y: evt.clientY + 16 }
  }
  return null
}

interface AppTitleRecord {
  text: string
  lastPointerX: number
  lastPointerY: number
  onEnter: (e: PointerEvent) => void
  onMove: (e: PointerEvent) => void
  onLeave: () => void
  onDown: () => void
  onScroll: () => void
}

const records = new WeakMap<HTMLElement, AppTitleRecord>()

function attach(el: HTMLElement, initialText: string): void {
  if (records.has(el)) return
  const rec: AppTitleRecord = {
    text: initialText,
    lastPointerX: 0,
    lastPointerY: 0,
    onEnter: (e: PointerEvent) => {
      if (!rec.text) {
        hideTooltip()
        return
      }
      rec.lastPointerX = e.clientX
      rec.lastPointerY = e.clientY
      const a = anchorFor(el, e)
      if (!a) {
        hideTooltip()
        return
      }
      showTooltip(rec.text, a.x, a.y)
      window.addEventListener('scroll', rec.onScroll, { capture: true, passive: true })
    },
    onMove: (e: PointerEvent) => {
      if (!rec.text) return
      rec.lastPointerX = e.clientX
      rec.lastPointerY = e.clientY
      const a = anchorFor(el, e)
      if (!a) {
        hideTooltip()
        return
      }
      moveTooltip(a.x, a.y)
    },
    onLeave: () => {
      window.removeEventListener('scroll', rec.onScroll, { capture: true })
      hideTooltip()
    },
    onDown: () => {
      window.removeEventListener('scroll', rec.onScroll, { capture: true })
      hideTooltip()
    },
    onScroll: () => {
      if (!rec.text) return
      const r = el.getBoundingClientRect()
      if (rectHasBox(r)) {
        moveTooltip(r.left + r.width / 2, r.bottom + 6)
      } else {
        moveTooltip(rec.lastPointerX, rec.lastPointerY + 16)
      }
    },
  }
  records.set(el, rec)
  el.addEventListener('pointerenter', rec.onEnter)
  el.addEventListener('pointermove', rec.onMove)
  el.addEventListener('pointerleave', rec.onLeave)
  el.addEventListener('pointerdown', rec.onDown)
}

function detach(el: HTMLElement): void {
  const rec = records.get(el)
  if (!rec) return
  el.removeEventListener('pointerenter', rec.onEnter)
  el.removeEventListener('pointermove', rec.onMove)
  el.removeEventListener('pointerleave', rec.onLeave)
  el.removeEventListener('pointerdown', rec.onDown)
  window.removeEventListener('scroll', rec.onScroll, { capture: true })
  records.delete(el)
}

export const appTitle: Directive<HTMLElement, unknown> = {
  mounted(el, binding) {
    el.removeAttribute('title')
    attach(el, toText(binding.value))
  },
  updated(el, binding) {
    el.removeAttribute('title')
    const rec = records.get(el)
    if (rec) {
      rec.text = toText(binding.value)
      if (!rec.text) hideTooltip()
    } else {
      attach(el, toText(binding.value))
    }
  },
  unmounted(el) {
    detach(el)
  },
}
