# wenren-site 双仓维护规范

## 固定仓库角色

每次修改前先执行 `git remote -v`、`git status --short --branch` 和 `git branch -vv`：

- 当前工程的 `origin` 必须是 `shaun17/wenren-site`，`upstream` 必须是 `shaun17/PageComet`。
- `wenren-site/main` 是包含个人内容、3D 空间肖像与生产配置的正式分支，不与 `PageComet/main` 保持相同文件树。
- PageComet 必须在独立工程中维护，其 `origin` 指向 `shaun17/PageComet`；不得用 linked worktree 混放两个仓库。
- 不再创建 `personal-main`：个人主线就是 `wenren-site/main`，模板主线就是 `PageComet/main`。

## 修改分类

提交前必须把改动归入以下一种类型：

1. 通用模板能力：不依赖姓名、域名、个人文案、Notion 私有数据、3D 模型或个人路由，使用示例配置和 fixture 可以完整工作。
2. 个人站能力：涉及 `/avatar/`、`public/3d/`、空间肖像、个人内容、个人生产配置或 `wenren.cc`。
3. 混合修改：同时包含通用实现和个人接入，必须拆成独立提交；通用部分先进入 PageComet，个人部分随后进入 wenren-site。

## 通用优化回流 PageComet

通用功能应优先在 PageComet 独立工程中开发：

1. 更新 PageComet 的 `origin/main`，创建 `contrib/<功能名>` 分支。
2. 只提交通用实现、示例配置和 fixture 测试，运行 PageComet 的完整测试。
3. 推送贡献分支并向 `shaun17/PageComet:main` 创建 PR，等待 `test` 检查成功后合并。
4. 回到本工程执行 `git fetch upstream --prune` 和 `git merge upstream/main`，解决冲突并运行个人站完整测试。
5. 最后才把合并结果推送到 `wenren-site/main`。

如果通用优化最初出现在个人功能分支中，必须先形成纯通用提交。在 PageComet 工程从本机 `personal` 远端获取该分支，再把纯通用提交 cherry-pick 到基于 `origin/main` 的 `contrib/<功能名>`；混合提交必须重新提炼，禁止整体 cherry-pick。PageComet 合并后，个人站以 `upstream/main` 中的通用实现为准，只把个人接入提交带回 `wenren-site/main`。不需要、也不得先把通用提交推到 `wenren-site/main` 作为中转。

## 个人站提交与发布

- 个人功能只提交到 `shaun17/wenren-site`，不得反向进入 PageComet。
- 合并 PageComet 更新使用 merge，不重写长期个人历史；冲突必须同时保留上游通用改进和个人接入。
- 提交前执行 `npm run check:repository-boundary` 和 `npm test`，逐项检查暂存区，不提交 `.env`、缓存或构建产物。
- 发布使用 `npm run deploy`，完成后独立核验正式域名、关键路由、3D 模型、两张降级海报与随机 404。

## 代码要求

- 使用 `ast-grep` 做代码结构搜索；只有在明确要求时才退回纯文本搜索。
- 需要库、API、安装或配置资料时先使用 Context7；不可用时只查官方文档。
- 所有函数和关键逻辑必须有清楚的中文注释。
- 未明确要求时不要新增 README、设计说明或其他文档。
- 修复根因并完成整个功能，不提交临时绕过方案或半成品。
