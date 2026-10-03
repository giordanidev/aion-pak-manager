/**
 * Índice plano da árvore de arquivos.
 * A procura deixa de caminhar Maps reativos e passa a varrer nomes já em minúsculas,
 * com trigramas para consultas de 3+ caracteres.
 */

export interface TreeBranch<T extends TreeBranch<T>> {
  name: string
  key: string
  children: { readonly size: number; values(): Iterable<T> }
}

export interface FileTreeIndex<T extends object> {
  names: string[]
  ends: Uint32Array
  nodes: T[]
  grams: Map<number, Uint32Array>
  saturated: Set<number>
  childrenOf: WeakMap<T, T[]>
}

const EMPTY_NODES: never[] = []
/** Trigrama comum demais para valer a lista: a consulta cai no filtro dos outros trigramas ou na varredura linear. */
const GRAM_CAP = 200_000

function gramKey(value: string, index: number): number {
  return value.charCodeAt(index) + value.charCodeAt(index + 1) * 65536 + value.charCodeAt(index + 2) * 4294967296
}

function uniqueGrams(value: string): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (let i = 0; i <= value.length - 3; i += 1) {
    const key = gramKey(value, i)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(key)
  }
  return out
}

function compareSiblings<T extends { name: string }>(isDir: (node: T) => boolean, a: T, b: T): number {
  const aDir = isDir(a)
  const bDir = isDir(b)
  if (aDir !== bDir) return aDir ? -1 : 1
  if (a.name < b.name) return -1
  if (a.name > b.name) return 1
  return 0
}

function compareHits<T extends { key: string }>(isDir: (node: T) => boolean, a: T, b: T): number {
  const aDir = isDir(a)
  const bDir = isDir(b)
  if (aDir !== bDir) return aDir ? -1 : 1
  if (a.key < b.key) return -1
  if (a.key > b.key) return 1
  return 0
}

export function orderedChildren<T extends object>(index: FileTreeIndex<T> | null, node: T): readonly T[] {
  if (!index) return EMPTY_NODES
  return index.childrenOf.get(node) ?? EMPTY_NODES
}

export async function buildFileTreeIndex<T extends TreeBranch<T>>(
  root: T,
  options: {
    isDir: (node: T) => boolean
    onYield?: () => Promise<void>
    isCancelled?: () => boolean
  },
): Promise<FileTreeIndex<T> | null> {
  const { isDir, onYield, isCancelled } = options
  const names: string[] = []
  const ends: number[] = []
  const nodes: T[] = []
  const gramsLive = new Map<number, number[]>()
  const saturated = new Set<number>()
  const childrenOf = new WeakMap<T, T[]>()

  const addGrams = (lower: string, idx: number): void => {
    const length = lower.length
    if (length < 3) return
    const seen: number[] = []
    for (let i = 0; i <= length - 3; i += 1) {
      const key = gramKey(lower, i)
      let duplicate = false
      for (let s = 0; s < seen.length; s += 1) {
        if (seen[s] === key) {
          duplicate = true
          break
        }
      }
      if (duplicate || saturated.has(key)) continue
      seen.push(key)
      let list = gramsLive.get(key)
      if (!list) {
        list = []
        gramsLive.set(key, list)
      }
      list.push(idx)
      if (list.length > GRAM_CAP) {
        saturated.add(key)
        gramsLive.delete(key)
      }
    }
  }

  interface Frame {
    node: T
    selfIdx: number
    kids: T[] | null
    next: number
  }

  const stack: Frame[] = [{ node: root, selfIdx: -1, kids: null, next: 0 }]
  let steps = 0
  while (stack.length > 0) {
    const top = stack[stack.length - 1] as Frame
    if (top.kids == null) {
      const kids = [...top.node.children.values()].sort((a, b) => compareSiblings(isDir, a, b))
      childrenOf.set(top.node, kids)
      top.kids = kids
    }
    const kids = top.kids
    if (top.next < kids.length) {
      const child = kids[top.next] as T
      top.next += 1
      const idx = names.length
      const lower = child.name.toLowerCase()
      names.push(lower)
      nodes.push(child)
      ends.push(0)
      addGrams(lower, idx)
      stack.push({ node: child, selfIdx: idx, kids: null, next: 0 })
    } else {
      stack.pop()
      if (top.selfIdx >= 0) ends[top.selfIdx] = names.length
    }
    steps += 1
    if (onYield && (steps & 32767) === 0) {
      await onYield()
      if (isCancelled?.()) return null
    }
  }

  const grams = new Map<number, Uint32Array>()
  for (const [key, list] of gramsLive) grams.set(key, Uint32Array.from(list))

  return {
    names,
    ends: Uint32Array.from(ends),
    nodes,
    grams,
    saturated,
    childrenOf,
  }
}

function intersect(left: Uint32Array, right: Uint32Array): Uint32Array {
  const out: number[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const a = left[i] as number
    const b = right[j] as number
    if (a === b) {
      out.push(a)
      i += 1
      j += 1
    } else if (a < b) {
      i += 1
    } else {
      j += 1
    }
  }
  return Uint32Array.from(out)
}

async function collectVerified<T extends object>(
  index: FileTreeIndex<T>,
  query: string,
  candidates: Uint32Array | null,
  isCancelled: () => boolean,
  onYield?: () => Promise<void>,
): Promise<T[] | null> {
  const hits: T[] = []
  const names = index.names
  const ends = index.ends
  const nodes = index.nodes
  if (candidates) {
    let skip = 0
    for (let k = 0; k < candidates.length; k += 1) {
      if ((k & 262143) === 262143) {
        await onYield?.()
        if (isCancelled()) return null
      }
      const i = candidates[k] as number
      if (i < skip) continue
      if ((names[i] as string).includes(query)) {
        hits.push(nodes[i] as T)
        skip = ends[i] as number
      }
    }
    return hits
  }
  let skip = 0
  for (let i = 0; i < names.length; i += 1) {
    if ((i & 262143) === 262143) {
      await onYield?.()
      if (isCancelled()) return null
    }
    if (i < skip) continue
    if ((names[i] as string).includes(query)) {
      hits.push(nodes[i] as T)
      skip = ends[i] as number
      i = skip - 1
    }
  }
  return hits
}

export async function searchFileTree<T extends { key: string }>(
  index: FileTreeIndex<T>,
  query: string,
  options: {
    isDir: (node: T) => boolean
    isCancelled: () => boolean
    onYield?: () => Promise<void>
  },
): Promise<T[] | null> {
  const { isDir, isCancelled, onYield } = options
  await onYield?.()
  if (isCancelled()) return null

  let candidates: Uint32Array | null = null
  if (query.length >= 3) {
    const usable: Uint32Array[] = []
    for (const key of uniqueGrams(query)) {
      if (index.saturated.has(key)) continue
      const list = index.grams.get(key)
      if (!list) return []
      usable.push(list)
    }
    if (usable.length > 0) {
      usable.sort((a, b) => a.length - b.length)
      let current = usable[0] as Uint32Array
      for (let i = 1; i < usable.length; i += 1) {
        current = intersect(current, usable[i] as Uint32Array)
        if (current.length === 0) return []
      }
      candidates = current
    }
  }

  if (isCancelled()) return null
  const hits = await collectVerified(index, query, candidates, isCancelled, onYield)
  if (hits == null || isCancelled()) return null
  // Acima disso a ordem da árvore (pastas agrupadas) basta: ordenar centenas de milhares de caminhos trava a tela.
  if (hits.length > 1 && hits.length <= 25000) {
    await onYield?.()
    if (isCancelled()) return null
    hits.sort((a, b) => compareHits(isDir, a, b))
  }
  return hits
}
