import { readFile, mkdir, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listSourceFiles, sourceRoute } from './source-files.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(projectRoot, 'src')
const outputRoot = path.join(projectRoot, 'website', 'code')
const manifestPath = path.join(outputRoot, '.generated-manifest.json')

const languageByExtension = new Map([
  ['.c', 'c'], ['.cc', 'cpp'], ['.cpp', 'cpp'], ['.cs', 'csharp'],
  ['.css', 'css'], ['.go', 'go'], ['.html', 'html'], ['.java', 'java'],
  ['.js', 'js'], ['.jsx', 'jsx'], ['.json', 'json'], ['.md', 'md'],
  ['.mjs', 'js'], ['.py', 'python'], ['.rb', 'ruby'], ['.rs', 'rust'],
  ['.sh', 'bash'], ['.sql', 'sql'], ['.svg', 'xml'], ['.ts', 'ts'],
  ['.tsx', 'tsx'], ['.vue', 'vue'], ['.xml', 'xml'], ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
])

function makeFence(source) {
  const runs = source.match(/`+/g) ?? []
  const longestRun = runs.reduce((longest, run) => Math.max(longest, run.length), 2)
  return '`'.repeat(longestRun + 1)
}

function makePage(relativeSourcePath, source) {
  const title = `src/${relativeSourcePath}`
  const extension = path.extname(relativeSourcePath).toLowerCase()
  const language = languageByExtension.get(extension) ?? 'text'
  const fence = makeFence(source)

  return `# \`${title}\`\n\n完整源码与注释：\n\n${fence}${language}\n${source}${source.endsWith('\n') ? '' : '\n'}${fence}\n`
}

await mkdir(outputRoot, { recursive: true })

let previousPages = []
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (Array.isArray(manifest.pages)) previousPages = manifest.pages
} catch (error) {
  if (error.code !== 'ENOENT') throw error
}

const sourceFiles = listSourceFiles(sourceRoot)
const generatedPages = []
const links = []

for (const relativeSourcePath of sourceFiles) {
  const absoluteSourcePath = path.join(sourceRoot, relativeSourcePath)
  const buffer = await readFile(absoluteSourcePath)
  const relativePagePath = `${relativeSourcePath}.md`
  const outputPath = path.join(outputRoot, relativePagePath)

  await mkdir(path.dirname(outputPath), { recursive: true })

  if (buffer.includes(0)) {
    await writeFile(outputPath, `# \`src/${relativeSourcePath}\`\n\n此文件是二进制内容，无法作为代码文本显示。\n`)
  } else {
    const source = buffer.toString('utf8')
    await writeFile(outputPath, makePage(relativeSourcePath, source))
  }

  generatedPages.push(relativePagePath)
  links.push(`- [\`src/${relativeSourcePath}\`](/code/${sourceRoute(relativeSourcePath)})`)
}

const indexPath = 'index.md'
const indexContents = [
  '# `src/` 文件目录',
  '',
  sourceFiles.length === 0 ? '目前 `src/` 下没有文件。' : '选择文件查看完整源码和行内注释。',
  '',
  ...links,
  '',
].join('\n')
await writeFile(path.join(outputRoot, indexPath), indexContents)
generatedPages.push(indexPath)

const currentPages = new Set(generatedPages)
for (const previousPage of previousPages) {
  const normalized = path.normalize(previousPage)
  if (normalized !== previousPage || normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error(`Invalid generated-page path in manifest: ${previousPage}`)
  }
  if (!currentPages.has(previousPage)) {
    await unlink(path.join(outputRoot, previousPage)).catch((error) => {
      if (error.code !== 'ENOENT') throw error
    })
  }
}

await writeFile(manifestPath, `${JSON.stringify({ pages: generatedPages }, null, 2)}\n`)
console.log(`Generated ${generatedPages.length - 1} source pages from src/.`)
