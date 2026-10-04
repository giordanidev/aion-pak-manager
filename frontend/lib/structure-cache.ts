import type { FileTreeIndex } from './file-tree-index'

export interface CachedStructure<T extends object, M> {
  root: T
  index: FileTreeIndex<T> | null
  meta: M
}

interface Slot<T extends object, M> {
  key: string
  stamp: string
  root: T
  index: FileTreeIndex<T> | null
  meta: M
}

/** A 1M-file tree is large. Keep a few recent ones so reopening does not rebuild them. */
const MAX_SLOTS = 3
const slots: Slot<object, unknown>[] = []

export function structureCacheKey(kind: string, target: string): string {
  return `${kind}:${target.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()}`
}

export function structureStamp(mtimeMs: number, size: number): string {
  return `${mtimeMs}:${size}`
}

export function readStructureCache<T extends object, M>(key: string, stamp: string): CachedStructure<T, M> | null {
  const index = slots.findIndex((slot) => slot.key === key && slot.stamp === stamp)
  if (index < 0) return null
  const [slot] = slots.splice(index, 1)
  if (!slot) return null
  slots.push(slot)
  return {
    root: slot.root as T,
    index: slot.index as FileTreeIndex<T>,
    meta: slot.meta as M,
  }
}

export function writeStructureCache<T extends object, M>(
  key: string,
  stamp: string,
  root: T,
  index: FileTreeIndex<T> | null,
  meta: M,
): void {
  if (!stamp) return
  const existing = slots.findIndex((slot) => slot.key === key)
  if (existing >= 0) slots.splice(existing, 1)
  slots.push({ key, stamp, root, index, meta })
  while (slots.length > MAX_SLOTS) slots.shift()
}
