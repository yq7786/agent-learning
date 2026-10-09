import { readdirSync } from 'node:fs'
import path from 'node:path'

export function listSourceFiles(directory, prefix = '') {
  const entries = readdirSync(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(absolutePath, relativePath))
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files.sort((left, right) => left.localeCompare(right))
}

export function sourceRoute(relativePath) {
  return relativePath
    .replaceAll('\\', '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
}
