<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps<{
  open: boolean
  title: string
  message: string
  confirmLabel?: string
}>()

const emit = defineEmits<{
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    emit('cancel')
  } else if (event.key === 'Enter') {
    event.preventDefault()
    emit('confirm')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})

watch(
  () => props.open,
  (open) => {
    if (open) document.body.style.overflow = 'hidden'
    else document.body.style.overflow = ''
  },
)
</script>

<template>
  <div
    v-if="open"
    class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/65 p-5"
    role="dialog"
    aria-modal="true"
    @click.self="emit('cancel')"
  >
    <div class="flex w-full max-w-md flex-col rounded-xl border border-border bg-card shadow-[0_8px_40px_rgba(0,0,0,0.5)]">
      <div class="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h3 class="m-0 text-base font-bold text-bright">{{ title }}</h3>
      </div>
      <div class="flex flex-col gap-4 px-5 py-4">
        <p class="m-0 break-words text-sm text-text">{{ message }}</p>
        <div class="flex items-center justify-end gap-2">
          <button
            type="button"
            class="box-border inline-flex h-9 items-center justify-center rounded-lg border border-border bg-hover px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border"
            @click="emit('cancel')"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="box-border inline-flex h-9 items-center justify-center rounded-lg bg-accent px-4 text-sm font-semibold text-white cursor-pointer transition duration-150 enabled:hover:bg-accent-hover"
            @click="emit('confirm')"
          >
            {{ confirmLabel || t('common.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
