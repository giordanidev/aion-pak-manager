import type { PakDatabaseInfo } from '../../shared/api-types'

export type DbNodeKind = 'dir' | 'file'

export interface DbTreeNode {
  name: string
  key: string
  children: Map<string, DbTreeNode>
  kind: DbNodeKind
  count: number
}

export function emptyDbRoot(): DbTreeNode {
  return { name: '', key: '', children: new Map(), kind: 'dir', count: 0 }
}

export function isDbSearchDir(node: DbTreeNode): boolean {
  return node.children.size > 0 || node.kind === 'dir'
}

function splitRel(value: string): string[] {
  return value.replace(/\\/g, '/').split('/').filter((part) => part.length > 0)
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function ensureNode(root: DbTreeNode, baseKey: string, parts: string[], leafKind: DbNodeKind): DbTreeNode {
  let node = root
  let currentKey = baseKey
  for (let j = 0; j < parts.length; j += 1) {
    const part = parts[j] as string
    const last = j === parts.length - 1
    currentKey = currentKey ? `${currentKey}/${part}` : part
    let child = node.children.get(part)
    if (!child) {
      child = { name: part, key: currentKey, children: new Map(), kind: last ? leafKind : 'dir', count: 0 }
      node.children.set(part, child)
    } else if (last) {
      child.kind = leafKind
    }
    node = child
  }
  return node
}

function computeCounts(node: DbTreeNode): number {
  if (node.children.size === 0) {
    node.count = node.kind === 'file' ? 1 : 0
    return node.count
  }
  let total = 0
  for (const child of node.children.values()) total += computeCounts(child)
  node.count = total
  return total
}

export async function buildDatabaseTree(info: PakDatabaseInfo): Promise<DbTreeNode> {
  const root = emptyDbRoot()
  let ops = 0
  const entries = info.paks && info.paks.length > 0
    ? info.paks
    : [{ relPakPath: info.relPakPath ?? '', files: info.files ?? [] }]
  for (const pak of entries) {
    const rel = (pak.relPakPath ?? '').trim().replace(/\\/g, '/')
    const relParts = splitRel(rel)
    if (relParts.length === 0) continue
    const pakNode = ensureNode(root, '', relParts, 'file')
    ops += 1
    if (ops % 500 === 0) await yieldToUi()
    for (const file of pak.files ?? []) {
      const fileParts = splitRel(file)
      if (fileParts.length === 0) continue
      ensureNode(pakNode, rel, fileParts, 'file')
      ops += 1
      if (ops % 500 === 0) await yieldToUi()
    }
  }
  computeCounts(root)
  return root
}

export function slimDatabaseInfo(info: PakDatabaseInfo): PakDatabaseInfo {
  const paks = info.paks?.map((pak) => ({
    relPakPath: pak.relPakPath,
    destDir: pak.destDir,
    files: [] as string[],
    fileCount: pak.fileCount ?? pak.files.length,
  }))
  return { ...info, files: [], paks }
}
