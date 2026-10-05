<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConflictChoice, ConflictRequest } from '../../shared/api-types'
import { useAppState } from '../composables/useAppState'

const props = defineProps<{ request: ConflictRequest | null }>()
const emit = defineEmits<{ (e: 'choose', choice: ConflictChoice): void }>()
const { t } = useI18n()
const { dirLabel } = useAppState()

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.request) {
    event.preventDefault()
    emit('choose', 'cancel')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    v-if="request"
    class="fixed inset-0 z-[1300] flex items-center justify-center bg-black/65 p-5"
    role="dialog"
    aria-modal="true"
  >
    <div
      class="w-full max-w-sm rounded-xl border border-border bg-card px-5 py-4 shadow-[0_8px_30px_rgba(0,0,0,0.45)]"
    >
      <div class="mb-3 flex items-start justify-between gap-3">
        <h3 class="m-0 text-bright">{{ request.summary ? t('pak.conflictSummaryTitle') : t('pak.conflictTitle') }}</h3>
        <span v-if="!request.summary" class="flex-none text-xs text-dim tabular-nums">
          {{ t('pak.conflictCounter', { i: request.conflictIndex, total: request.conflictTotal }) }}
        </span>
      </div>

      <div class="flex flex-col gap-3">
        <p class="m-0 break-words text-sm text-text">
          {{
            request.summary
              ? t('pak.conflictSummaryBody', { n: request.conflictTotal, dir: dirLabel('unpaked') })
              : t('pak.conflictBody', { name: request.packageName, dir: dirLabel('unpaked') })
          }}
        </p>
        <p v-if="!request.summary && request.fileCount != null" class="m-0 text-xs text-dim">
          {{ t('pak.conflictFiles', { n: request.fileCount }) }}
        </p>

        <div v-if="request.summary" class="flex flex-col gap-2">
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white cursor-pointer transition duration-150 enabled:hover:bg-accent-hover"
            @click="emit('choose', 'overwrite-all')"
          >
            {{ t('pak.conflictOverwriteAll') }}
          </button>
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-hover px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border"
            @click="emit('choose', 'skip-all')"
          >
            {{ t('pak.conflictSkipAll') }}
          </button>
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
            @click="emit('choose', 'review')"
          >
            {{ t('pak.conflictReview') }}
          </button>
        </div>
        <div v-else class="grid grid-cols-2 gap-2">
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white cursor-pointer transition duration-150 enabled:hover:bg-accent-hover"
            @click="emit('choose', 'overwrite')"
          >
            {{ t('pak.conflictOverwrite') }}
          </button>
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-hover px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-border"
            @click="emit('choose', 'skip')"
          >
            {{ t('pak.conflictSkip') }}
          </button>
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
            @click="emit('choose', 'overwrite-all')"
          >
            {{ t('pak.conflictOverwriteAll') }}
          </button>
          <button
            class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm text-text cursor-pointer transition duration-150 enabled:hover:bg-hover"
            @click="emit('choose', 'skip-all')"
          >
            {{ t('pak.conflictSkipAll') }}
          </button>
        </div>

        <button
          class="box-border inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-red bg-transparent px-4 text-sm font-semibold text-red cursor-pointer transition duration-150 enabled:hover:bg-red/15"
          @click="emit('choose', 'cancel')"
        >
          {{ t('pak.conflictCancel') }}
        </button>
      </div>
    </div>
  </div>
</template>
