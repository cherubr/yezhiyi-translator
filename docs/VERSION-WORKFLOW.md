# 版本开发与发布操作手册

以 1.0.0 更新到 1.0.1 为例，命令适用于 Windows PowerShell。以后发布其他版本时，替换分支名、版本号、标签和文件名。

在项目根目录（包含 manifest.json、package.json 的文件夹）执行。每一步成功后再继续，不要整篇一次性粘贴执行。

## 1. 操作流程

~~~text
本地更新 main
→ 创建开发分支
→ 修改代码与版本
→ 测试
→ 提交并推送开发分支
→ GitHub 创建 PR 并合并到 main
→ 本地拉取 main
→ 打包并验证安装包
→ 给打包对应的提交创建标签
→ 更新现有 Chrome 商店扩展
~~~

| 名称 | 含义 |
|---|---|
| main | 已合并代码，不表示所有提交都已在商店上线 |
| fix/1.0.1 | 本次开发分支，名字可自行选择 |
| commit | 保存一次代码修改记录 |
| push | 上传本地提交，不会自动合并分支或更新商店 |
| Pull Request（PR） | 在 GitHub 检查分支改动并合并 |
| v1.0.1 标签 | 标记该版本安装包对应的源码提交 |
| 1.0.1.zip | 实际交给 Chrome 商店的安装包 |

## 2. 保存已有送审版本

单独保存已经上传审核的 ZIP，不覆盖。确认对应提交后再创建标签。

~~~powershell
git status
git log -5 --oneline
git tag --list
~~~

如果当前提交就是 1.0.0 送审包对应的代码，且没有同名标签：

~~~powershell
git tag -a v1.0.0 -m "1.0.0 Chrome 商店送审版本"
git push origin v1.0.0
~~~

如果已有后续提交，将“实际提交编号”替换为送审代码的编号：

~~~powershell
git tag -a v1.0.0 实际提交编号 -m "1.0.0 Chrome 商店送审版本"
git push origin v1.0.0
~~~

标签已经存在就不要重复创建，也不要移动送审标签。

## 3. 创建开发分支

确认工作区干净后：

~~~powershell
git switch main
git pull --ff-only origin main
git switch -c fix/1.0.1
~~~

如果分支已经存在，只需要：

~~~powershell
git switch fix/1.0.1
~~~

如果已经有未提交的修改，先确认这些修改属于哪个版本，不要为了切分支丢弃代码。尚未创建分支且当前提交就是合适起点时，可直接 git switch -c fix/1.0.1，把现有修改带到新分支。

## 4. 修改功能和版本信息

| 文件 | 修改内容 |
|---|---|
| manifest.json | 手动把 version 改为 1.0.1 |
| package.json、package-lock.json | 使用下面的 npm 命令同步版本 |
| README.md | 更新当前版本、ZIP 文件名及受影响的功能说明 |
| CHANGELOG.md | 新增 1.0.1，记录本次修复，保留旧版历史 |
| docs/RELEASE-CHECKLIST.md | 记录本次验证结果，不沿用旧包校验值 |
| 隐私说明及商店介绍 | 权限、数据处理或功能范围变化时同步更新 |

~~~powershell
npm version 1.0.1 --no-git-tag-version
~~~

这条命令不修改 manifest.json、README、CHANGELOG，也不创建 Git 标签。设置页从 Manifest 自动读取版本，无需另改版本文字。

修改隐私处理时，同步 PRIVACY.md 与 docs/privacy.html，并确认公开隐私网页也已更新。

目前 scripts/store-assets.cjs 中的截图等待条件写有 v1.0.0。升级版本后如需重生成图片，先同步该条件，否则脚本会等待超时。之后可再改进为从 Manifest 动态读取。

## 5. 安装依赖与检查

首次克隆项目或依赖锁文件更新后执行：

~~~powershell
npm ci
npx playwright install chromium
~~~

完成代码修改后：

~~~powershell
npm run check
npm test
npm run test:browser
~~~

失败时先修复再继续。浏览器自动测试使用独立资料与模拟接口，不代替真实服务账号、网络、额度和第三方网页的人工验收。

按本次修改验证相关场景：普通页面、侧栏、动态弹框、混合表单、取消还原、切换引擎、错误提示和刷新行为。

## 6. 提交并推送分支

~~~powershell
git status
git diff
git add .
git diff --cached --stat
git diff --cached
git commit -m "fix: 修复具体问题并准备 1.0.1"
git push -u origin fix/1.0.1
~~~

git add . 会暂存所有未被忽略的修改。先检查列表，不混入其他任务改动或敏感数据。

同一分支后续继续提交：

~~~powershell
git add .
git commit -m "fix: 补充修复具体问题"
git push
~~~

## 7. GitHub 合并 PR

打开仓库：https://github.com/cherubr/yezhiyi-translator

创建 Pull Request，选择：

~~~text
base: main  ←  compare: fix/1.0.1
~~~

检查代码及自动检查结果，再合并。若有冲突，先解决并重新验证。

推送开发分支不会自动更新 main。GitHub 合并后，本地执行：

~~~powershell
git switch main
git pull --ff-only origin main
git status
git log -3 --oneline
~~~

如果 pull 提示本地与远程分叉，先查看差异，不直接强制重置或强制推送。

## 8. 打包及验证交付文件

从合并后的 main 打包。如果合并引入新改动、解决过冲突或拉取了其他更新，先重新执行第 5 节检查。

~~~powershell
npm run package
~~~

输出：

~~~text
dist/yezhiyi-translator-1.0.1.zip
~~~

只包含运行必需文件和隐私说明，不包含依赖、测试、脚本、Git 元数据及商店图片。

同名 ZIP 已存在时脚本会停止。确认后另存旧包，不能覆盖已送审包。上架使用这里生成的 ZIP，不使用 GitHub 的 Download ZIP 源码包。

解压到一个不存在的新目录，避免混入旧文件：

~~~powershell
Expand-Archive -LiteralPath .\dist\yezhiyi-translator-1.0.1.zip -DestinationPath .\dist\verify-1.0.1
~~~

在 Chrome 中：

1. 打开 chrome://extensions/，开启开发者模式。
2. 点击“加载已解压的扩展程序”。
3. 选择直接包含 manifest.json 的 dist/verify-1.0.1。
4. 停用其他开发副本，再检查本次修复和主要功能。

也可以对解压包执行项目集成测试：

~~~powershell
$env:YEZHIYI_EXTENSION_DIR = (Resolve-Path .\dist\verify-1.0.1).Path
node tests/browser-extension.cjs
Remove-Item Env:\YEZHIYI_EXTENSION_DIR
~~~

最后一条只清理当前终端的测试环境变量，不删除文件。集成测试仍使用模拟服务。

验证后如果又改了代码，需要重新提交、测试、打包并验证。Chrome 正在加载某个解压目录时，不删除或移动它；不用后先卸载该开发副本再清理。

## 9. 计算和核对安装包指纹（可选）

目的：确认某个 ZIP 是否与保存的发布包一致。不会修改、解压或上传文件，也不能证明安装包没有漏洞。

~~~powershell
Get-FileHash -LiteralPath .\dist\yezhiyi-translator-1.0.1.zip -Algorithm SHA256
~~~

把结果记入发布清单，或在首次生成时保存：

~~~powershell
(Get-FileHash -LiteralPath .\dist\yezhiyi-translator-1.0.1.zip -Algorithm SHA256).Hash |
    Set-Content -LiteralPath .\dist\yezhiyi-translator-1.0.1.sha256 -Encoding ascii
~~~

以后核对：

~~~powershell
$expectedHash = (Get-Content -LiteralPath .\dist\yezhiyi-translator-1.0.1.sha256 -Raw).Trim()
$actualHash = (Get-FileHash -LiteralPath .\dist\yezhiyi-translator-1.0.1.zip -Algorithm SHA256).Hash
$actualHash -eq $expectedHash
~~~

True 表示一致，False 表示文件或记录不匹配。核对前不要覆盖之前的记录，否则失去比较意义。

上面的保存命令用于新版本，记录内容只有校验值。现有 1.0.0.sha256 是“校验值 + 文件名”的格式，核对它时取第一段：

~~~powershell
$expectedHash = ((Get-Content -LiteralPath .\dist\yezhiyi-translator-1.0.0.sha256 -Raw).Trim() -split '\s+')[0]
$actualHash = (Get-FileHash -LiteralPath .\dist\yezhiyi-translator-1.0.0.zip -Algorithm SHA256).Hash
$actualHash -eq $expectedHash
~~~

## 10. 保存记录及创建版本标签

若验证后只更新了发布清单，提交这份记录：

~~~powershell
git add docs/RELEASE-CHECKLIST.md
git diff --cached
git commit -m "docs: 记录 1.0.1 安装包验证结果"
git push origin main
~~~

仅有实际修改时才执行该提交。如果 main 有分支保护，则通过 PR 合并记录，再拉取 main。

确认工作区干净，源码与包一致后：

~~~powershell
git status
git log -1 --oneline
git tag --list
git tag -a v1.0.1 -m "1.0.1 发布版本"
git push origin v1.0.1
~~~

标签指向对应源码。只更新文档不会改变白名单包内容；运行代码变化后，应重新打包验证，不要给错误提交打标签。

可在 GitHub 的 Releases → Draft a new release 中选择 v1.0.1，写变更说明并附最终 ZIP。商店还未发布时据实注明“待商店审核”。GitHub Release 和商店发布是独立步骤。

## 11. 更新 Chrome 商店

1. 进入现有扩展条目，不创建新的扩展。
2. 上传最终 1.0.1 ZIP。
3. 按修改核对功能介绍、图片、权限理由、隐私声明和审核测试说明。
4. 确认版本和包内容后提交审核。
5. 留意审核邮件和后台状态。
6. 发布后从商店安装或更新，验证实际分发版本。

Git push、推送标签和创建 GitHub Release 都不会自动更新 Chrome 商店。如果上一版本仍在审核，先查看后台状态并按其提供的操作处理，不假设可同时提交多个待审版本。

## 12. 常用查看命令

~~~powershell
git status
git diff
git diff --cached
git log -5 --oneline
git branch
git tag --list
~~~

每次发布保留最终 ZIP、对应代码标签、变更记录和验证结果。验证目录只是测试副本，不是上传文件；旧版 ZIP 可以归档。
