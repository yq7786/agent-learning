import { defineConfig } from 'vitepress'
import path from 'node:path'
import { listSourceFiles, sourceRoute } from '../../scripts/source-files.mjs'

const [owner, repository] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
const isUserOrOrganizationSite = repository === `${owner}.github.io`
const base = process.env.GITHUB_ACTIONS && repository && !isUserOrOrganizationSite
  ? `/${repository}/`
  : '/'
const sourceFiles = listSourceFiles(path.resolve(process.cwd(), 'src'))

export default defineConfig({
  lang: 'zh-CN',
  title: '代码与注释',
  description: '随时在手机上阅读代码和注释',
  base,
  cleanUrls: true,
  markdown: {
    lineNumbers: true,
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: 'src 源码', link: '/code/' },
    ],
    sidebar: {
      '/code/': [
        {
          text: '源码',
          items: [
            { text: '全部文件', link: '/code/' },
            ...sourceFiles.map((file) => ({
              text: `src/${file}`,
              link: `${base}code/${sourceRoute(file)}`,
            })),
          ],
        },
      ],
    },
    search: {
      provider: 'local',
    },
    outline: {
      label: '本页目录',
    },
    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
    returnToTopLabel: '回到顶部',
    sidebarMenuLabel: '目录',
    darkModeSwitchLabel: '外观',
  },
})
