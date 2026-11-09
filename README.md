This branch contains the accompanying code for Elixir in Action, Third Edition.

## Elixir 实战手记

本仓库新增了一本用 Astro 构建的中文源码学习书。27 章导读分五个部分，沿着函数、Todo 数据结构、进程、OTP、监督树、分布式与发布展开，包含运行示例、边界分析、练习和仓库的源码对照页。正文位于 `src/content/chapters/`，原有 Elixir 示例保留在 `code_samples/`。

网站使用 Node.js 22.12 或更高版本，与下方 Elixir 示例的运行环境相互独立。

```sh
npm install
npm run dev
```

开发地址默认是 `http://localhost:4321/elixir-in-action/`（站点配置了 `base` 前缀）。静态构建和本地预览：

```sh
npm run build
npm run preview
```

`npm run build` 先执行 Astro 类型检查，再生成 `dist/` 静态站点，可部署到支持静态文件的网站服务。网站提供全文搜索、浅色/深色阅读、代码复制、章节导航及浏览器本地阅读进度。无需后端或账号；中文正文字体有系统字体回退。

网站通过 GitHub Actions（`.github/workflows/deploy.yml`）部署到 GitHub Pages：推送到 `3rd-edition` 分支会自动构建并发布到 `https://wsafight.github.io/elixir-in-action/`。首次启用需要在仓库 Settings → Pages 中将 Source 设为 **GitHub Actions**。内部链接统一走 `src/lib/book.ts` 里的 `withBase` 等助手，保证带 `/elixir-in-action` 前缀。

每个章节是一个 Markdown 文件，frontmatter 中的 `order`、`part`、`duration`、`topics` 与 `samples` 分别控制章节顺序、分部、预计阅读分钟数、主题和源码链接。新增章节会自动出现在目录和搜索中；`samples` 需要填写仓库内存在的文件路径，源码页会在构建时读取实际文件。源码 GitHub 链接的分支配置在 `src/lib/book.ts`。

本书是配套仓库的独立学习导读，不替代原书。示例针对仓库代码解释，不表示已经具备完整的生产级输入验证、持久化或分布式一致性保证。

## Original code samples

To compile and run the code, you'll need Elixir 1.20 and Erlang 29.x. If you're using the [asdf version manager](https://github.com/asdf-vm/asdf), keep in mind that this repository contains the `.tool-versions` file, specifying the Erlang and Elixir versions used to write this code. In this case you'll need to run `asdf install` in the root folder of this repository, to make sure the correct versions are installed. If you prefer to use different Elixir/Erlang versions, you can specify them in the `.tool-versions` file.

A `git` client should also be installed and available somewhere in the execution path.

The code for the second edition can be found [here](https://github.com/sasa1977/elixir-in-action/tree/2nd-edition).

The code for the first edition can be found [here](https://github.com/sasa1977/elixir-in-action/tree/1st-edition).
