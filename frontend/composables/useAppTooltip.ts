import { ref } from 'vue'

const text = ref('')
const x = ref(0)
const y = ref(0)
const visible = ref(false)

export function showTooltip(nextText: string, clientX: number, clientY: number): void {
  if (!nextText) {
    hideTooltip()
    return
  }
  text.value = nextText
  x.value = clientX
  y.value = clientY
  visible.value = true
}

export function moveTooltip(clientX: number, clientY: number): void {
  x.value = clientX
  y.value = clientY
}

export function hideTooltip(): void {
  visible.value = false
}

export function useAppTooltip() {
  return { text, x, y, visible, showTooltip, moveTooltip, hideTooltip }
}
