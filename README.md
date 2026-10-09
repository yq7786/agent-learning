# Super Agent

## 在手机上阅读源码

项目内置了一个 VitePress 阅读网站，会为 `src/` 下的每个文件生成页面。代码注释会跟源码一起显示，目录支持搜索。

本地预览：

```sh
pnpm docs:dev
```

生成静态网站：

```sh
pnpm docs:build
```

推送到 GitHub 后，Actions 会从默认分支部署网站。首次使用时，在仓库设置中将 **Pages → Build and deployment → Source** 设为 **GitHub Actions**。

发布后的网站是公开的，会包含 `src/` 下的所有文件和注释。构建只上传 `website/.vitepress/dist`，不会上传 `.env` 或仓库中的其他文件。
