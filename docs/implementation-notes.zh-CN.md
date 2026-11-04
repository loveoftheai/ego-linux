# ego-browser (Linux) — 原创复刻实现

目标：与 ego(lite) macOS 版 `ego-browser` CLI 功能与接口一比一的 Linux 版。
逆向依据：`~/workspace/ego-re/ANALYSIS.md`。只做静态分析获得的接口/行为复刻，
全部代码为原创实现；上层 agent 运行时直接复用公开 repo 的 MIT 源码构建产物。

## 路线决策（ANALYSIS.md §6 → 选 B）

**路线 B（外部驱动）**：普通 Chromium + Node 侧"虚拟 ego 绑定层"。
理由：
- 路线 A（Chromium fork 内实现原生绑定/snapshot/Space）需要维护 Chromium 大版本
  跟进，单人 15 分钟节拍不可持续；且跨域 OOPIF 的 AX 关联在 CDP 下基本可达
  （`Accessibility.getFullAXTree` 按 target 取，daemon 侧拼装）。
- 接口与输出格式可做到一致；与原生实现的差距（shadow DOM 穿透细节、subtree
  的 backendNodeId 语义）记录在"已知差异"节，逐步收敛。

## 组件

```
linux/
├── ego-browser            # CLI 启动器（本文件，Node 脚本，原创实现）
├── bin/ego-browser         # sh 包装，转调 ../ego-browser
├── sdk -> ../repo/package/ego-browser/dist/out/
│                          # MIT 上层运行时：index.js + ego-browser/SKILL.md
│                          # + agent-skills/ego-browser/（npm run build 产物）
├── vendor/ego-browser/     # SDK bundle 拷贝（1.6M；避免 repo 产物未构建时不可用）
├── src/
│   ├── chromium.js        # Chromium 进程管理（单共享实例，remote-debugging-port）
│   ├── cdp-transport.js   # CDP WebSocket 传输（运行时消息原样转发）
│   ├── ego-bindings.js    # globalThis.ego 虚拟绑定层（task space 状态机、
│   │                      #   profiles/tabs/snapshot/CDP 转发/error_code 全集）
│   └── snapshot.js        # snapshot 引擎（AX 树 → 原版同格式文本树）
├── VERSION                # Linux 版版本号
└── README.md              # 本文件
```

## 进程模型（实际实现，2026-10-21）

每次 `ego-browser nodejs` 调用是一个独立 Node 进程（与原版"每次调用是新
Node 进程"一致）：

1. `ensureChromium()`：复用已运行的共享 Chromium（`DevToolsActivePort`
   发现），不在则 headless 拉起。浏览器跨 CLI 调用常驻，类似原版 app。
2. `CdpTransport` 连浏览器级 WebSocket：运行时（SDK bundle）的 CDP 消息
   原样转发（flattened 协议）；绑定层自用 id 空间从 2^30 起，永不冲突。
3. `EgoBindings.create()`：读 `~/.local/share/ego-lite-linux/state.json`
   恢复 task space（跨轮持久），把 bindings 挂到 `globalThis.ego`。
4. SDK bundle `runMain({ stdinText })` 执行脚本：helper → `globalThis.ego`
   方法 → CDP。`ego.sendCDPMessage` 同步发到 socket，
   回包经 `ego.onCDPMessage` 事件循环投递——与原版语义一致。
5. snapshot：`snapshot.js` 对目标 session 取 `Accessibility.getFullAXTree`，
   按 backendNodeId 关联 DOM 信息，拼装原版同格式 `{content, refs}`。
   JS 层压缩/改写复用 repo 的 `snapshot-result.ts`（已构建在 bundle 内）。

已知架构差异（相对原版）：绑定层没有常驻 daemon 进程（是每次调用随用随建
的库对象）；每个 ego profile 跑独立 Chromium 实例（独立 user-data-dir），
同 profile 的 task space 是该浏览器内的目标分组、共享该 profile 的 cookie jar——
这正是原版 §1.9 的语义（同 profile 的 space 共享 cookie jar），不是差距。

## CLI 表面（与原版一致，见 ANALYSIS.md §1.3）

`help [topic]` / `import list` / `import --browser …` / `skill [--sdk-path]` /
`upgrade` / `nodejs [-e/--eval/--sdk-path/stdin/REPL]` / `--version` /
`--ego-server-name=<name>` / 未知命令 `Unknown command: X` + exit 2。

`skill` 的 SDK 解析顺序：`--sdk-path` → debug 覆盖
`~/.local/share/citro-labs/debug/index.js`（Linux 路径，原版 macOS 路径不可照搬）
→ 内置 bundle。找不到指南时 `ego-browser usage guide not found: <path>`。

## 状态

- [x] 2026-10-21：repo `package/ego-browser` 构建通过（`npm run build`），
      `npm test` 532/532 通过；产物 `dist/out/` 即 Linux 版 SDK bundle。
- [x] 2026-10-21：launcher 骨架（help/version/skill/未知命令），实测输出符合 §1.3。
- [x] 2026-10-21：`globalThis.ego` 虚拟绑定层（src/ego-bindings.js：task space
      状态机、profiles、tabs、snapshot、CDP 转发、error_code 全集）。
- [x] 2026-10-21：`nodejs` 子命令接通（-e/stdin/--sdk-path 走真实绑定层；
      双启动器合并为根目录唯一的 `ego-browser`）。
- [x] 2026-10-21：端到端实测通过——taskSpace → goto → snapshot → fill → click → evaluate 回读，
      E2E PASS（记录 `~/workspace/goals/ego-lite-linux/hidden_files/e2e-2026-10-21-final.log`）。
      file:// 与公网 HTTPS（经沙盒 egress 代理 + relay）均验证可用。
- [x] 2026-10-21：`import`（chrome/chromium/brave，Linux profile 路径）。
      `import list` 扫描 `~/.config/{google-chrome,chromium,BraveSoftware/Brave-Browser}`；
      `import --browser <b> [--profile <dir> ...] [--clear-existing-profiles] [--no-default]`
      把源 profile 拷贝为 ego profile（`~/.local/share/ego-lite-linux/profiles/<browser>-<dir>/`，
      其内 `Default/` 即 Chromium user-data-dir 布局）。`createTaskSpace(name, profileId)`
      为每个 profile 启动独立 Chromium 实例（独立 user-data-dir/DevTools 端口/instance id），
      同 profile 的 space 共享该 profile 的 cookie jar（与原版 §1.9 语义一致），
      未知 profileId 返回 `EGO_PROFILE_NOT_FOUND`。实测：导入的登录 cookie 在 space 内
      零动作可见、同 profile 双 space 共享、Default 隔离、落盘持久化（test-scripts/e2e-4.js，
      test-output/e2e-4-stdout.txt）。
- [x] 2026-10-21：`upgrade`（Linux 自有更新通道，替代原版 macOS Keystone）：
      `git fetch` 上游公开 repo（`../repo`，可用 `EGO_REPO_DIR` 覆盖）→ 有新提交则
      `pull --rebase`（本地 port commit 自动重排）→ `npm run build` 重建 SDK bundle
     （依赖 manifest 变化时先 `npm ci`；构建失败自动回滚旧 bundle）→ 重同步
      `vendor/ego-browser` → 只刷新本启动器安装的 entry skill
     （`~/.agents/skills/ego-browser`，凭 `.ego-linux-managed` 标记或旧版字节比对认领；
      用户自装的一律不动）→ VERSION 的 `-linux.N` 后缀 +1。无更新时打印
      `[ego-browser:upgrade] already up to date`。另 `ego.getBrowserVersion()` 的
      `updateAvailable` 接真实信号（FETCH_HEAD 是否严格领先于 HEAD，纯本地 git 读取），
      SDK 检测到后按原版格式打印 `[ego-browser:notice] … run \`ego-browser upgrade\``
     （launcher 侧补齐：SDK 自身的 notice 会被 runMain 的 resetSink 丢弃，
      见 ego-browser 注释）。Chromium 二进制保持 pin，不随 upgrade 更新。
- [x] 2026-10-21：Skill 分发（`src/first-run.js`，每次启动执行，契约见
      repo/docs/ego-browser-skill-command.md §2）：
      `~/.agents/skills/ego-browser` 缺失 → 从内置 SDK 的 `agent-skills/ego-browser/`
      拷贝为真实文件；旧浏览器符号链接（→ `~/.local/share/ego/ego-skills`）→
      替换为拷贝并删除旧目录；用户/包管理器自装的（真实目录、文件、指向别处的
      符号链接）一律不动，之后不再写入。onboarding 等价：首次启动在
      `~/.local/bin/ego-browser` 创建指向本启动器的符号链接（仅当缺失时创建、
      已有条目不动、stderr 提示一次），保证 skill 链 `ego-browser skill` 可调用。
      实测：假 HOME 沙盒覆盖 6 种情形全过（全新安装/幂等/旧链接迁移/用户目录不动/
      用户外链不动/已有 bin 条目不动），真实 HOME 首次运行安装成功，
      `skill` stdout 与内置指南字节一致（首尾标记行正确、stderr 干净），
      `command -v ego-browser` 可用，未知命令仍 exit 2。
- [x] Space 存储隔离：按原版 §1.9 语义——同 profile 的 space 共享 cookie jar，
      跨 profile 隔离（profile = 独立 Chromium 实例 + user-data-dir），已实测；
      不做 BrowserContext 级隔离（原版同 profile 本来就共享）。

## 已知差异（相对 macOS 原版，诚实记录）

- **沙盒网络四件套**（Hatch VM 特有，非产品缺陷）：① Chromium 直连 egress 代理的 CONNECT 被拒，
  经 `src/proxy-relay-daemon.js` loopback 中继（2026-10-21 修了 relay 的 socket 泄漏：
  以前只处理 error 不处理 close，挂起的上游连接永不释放）；② 代理 TLS MITM 而 `~/.pki/nssdb` 只读，
  沙盒内启动参数带 `--ignore-certificate-errors`（仅当代理环境变量 + CA 文件存在时）；
  ③ stock Chromium 152 的 Local Network Access 强制拦截 public→127.0.0.1 导航
  （`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`），实测 `--disable-features` 各变体、
  `Browser.setPermission(local-network-access)`、createTarget 初始 URL 均无效——
  localhost fixture 只能走 file:// 或等用户侧策略放行。repo 自带 e2e 的 localhost
  fixture 在此 Chrome 上同样会被拦。④ **egress 代理对带 `Cookie` 请求头的请求永久挂起**
  （curl 直连代理实测：plain/`X-Custom` 头 → 200，`Cookie` 头 → 无限挂起超时；
  Chromium netlog 证实请求已发出且 cookie 正常附带，是代理侧不回包）。
  因此沙盒内任何带 cookie 的网络导航都不可能成功——这是代理 bug，与本 port 无关；
  真实用户机器上无此代理，不受影响。cookie jar 相关验证改走 CDP Storage（e2e-4）。
- SDK 源码有一处为 Linux port 做的最小适配（MIT 许可内）：`src/page-ledger.ts` 的
  `runtimeInstanceId()` 优先读 `EGO_BROWSER_INSTANCE_ID` 环境变量（launcher 设置，
  随浏览器实例刷新），因为 port 的 nodejs 是每次调用的新进程、ppid 不稳定。

- snapshot 为 CDP 拼装而非引擎原生：跨域 OOPIF 的 AX 树按 target 分别获取后拼装
  （2026-10-21 已实现 graftOopifFrames：按 iframe src 匹配 target，拼 content，
  refs 带 frameId，anchor url 在 graft 时解析）；shadow DOM 穿透依赖 CDP 可达范围；
  subtree 的跨 frame backendNodeId 歧义报错语义在 daemon 侧模拟（subtree 暂不拼 OOPIF）。
- Chromium 启动带 `--site-per-process`（原版完整 Chromium 默认开站点隔离；
  headless-shell 默认关闭，导致 cross-site iframe 不产生独立 target、
  `iframeTarget()` 失效）。另 `--proxy-bypass-list=127.0.0.1,localhost,::1`
  （`< -loopback>` token 在此构建上实测不生效，回环请求会被发往代理）。
- `keyboard.paste` 的 macOS/Windows 原生粘贴路径在 Linux 用 CDP 输入模拟。
- `animationHighlightMouseToPosition` 用 overlay 窗口实现（待做）。
- 更新机制不用 Keystone，用自有通道（待定）。

## 2026-10-31：同步上游 v2.2.0-beta.5（93 commits，origin/main..v2.2.0-beta.5）

上游行为变化（只列影响本 port 的；其余为测试/文档/CI）：
- page-ledger：账本文件改为版本化（`space-<id>@<instance>.<n>.json`，最高可解析版
  本为准，不再 rename 覆盖；被占用的版本重试后报错、永不顶替）、锁定版本读重试
  （EPERM/EACCES/EBUSY，约 1.8s）、写冲突重试（上限 8 次）、旧版共享文件迁移、
  账本按浏览器实例隔离（实例 id 经 `scopeSuffix` 清洗，`:` → `-`）。
- 导航停止：goto/reload 超时未提交则停止导航、Page 保持在旧文档可用；其它调用
  在待定导航上等一 bounded 期后以 `EGO_PAGE_UNRESPONSIVE` 失败并停止该导航，
  错误说明当前文档与如何加载待定文档；会话建立等待有界且会点名无响应 Page。
- 点击快速路径：actionability 检查合并为一次注入调用，v1 click 探针失败时交给
  共享 resolver；强制点击跳过 hit test 但仍拒绝 disabled 元素。
- snapshot：默认 viewport 快照在文档超出视口时末尾追加
  `[more content above/below the viewport: ...]` 提示行（读不到度量时静默无提示）；
  跨文档提交的 snapshot 捕获重试；陈旧 subtree root 直接报错不再重试。
- 截图：默认截图路径按 run 隔离（tmpdir + 随机 6 位后缀，不再是 pid+序号）；
  `globalThis.EGO_BROWSER_OUTPUT_DIR` 必须为绝对路径，否则抛错。
- finish()：关闭最后一个 Page 时留下的空白 anchor tab 会被关闭，不再被当作
  用户 tab 阻断 `finish({ keep: [] })`。
- 下载：下载等待标记在等待中刷新、被拒绝的 arming 会话可恢复、进程重置期间
  arming 的下载设置会重应用；多 Page/进程共享一个 guid 命名的下载目录
  （`runtimeStateDir()/downloads`，CDP `Page.setDownloadBehavior`）。
- Worker：自动 attach 的非 frame target 全部 resume 后 detach（此前只有 iframe 与
  dedicated worker 被允许，AudioWorklet 会被挂起）；每 Page 会话启用 Ego automation hooks。
- Skill：指南升到 v2.2.0（2026-10-16），按平台分段渲染（`SKILL.md` 全量 +
  `SKILL.macos.md` / `SKILL.windows.md`），新增 install-macos/install-windows 指南；
  插件 npm 包改走 `@ego-lite` scope（本 port 不发 npm 包，只同步 skill 内容）。
- 公共 API 无新增方法（schema 只改了 goto/reload/actionTimeout 的说明文字）；
  上游原生绑定面（`ego.*`）与旧版集合完全一致。

本 port 的改动：
- `vendor/ego-browser/dist/`（out + src + scripts）与
  `vendor/ego-browser/skill-body/SKILL.md` 从 beta.5 源码重建并同步（相对旧 bundle：
  20 个文件变化 + 新增 install-macos.md、install-windows.md、SKILL.macos.md、
  SKILL.windows.md；SDK package 版本仍为 0.1.0）。
- Linux port patch 未被上游取代、已重打到 beta.5：上游实例隔离只决定账本文件
  按“给定的实例 id”分文件，`runtimeInstanceId()` 本身仍是 ppid 推导；port 的
  nodejs 每次调用是新进程、ppid 不稳定，故 `EGO_BROWSER_INSTANCE_ID` 优先分支
  仍需保留（与旧 patch 逐字相同，见 beta.5 工作树源码；构建产物已含该分支）。
- `~/.agents/skills/ego-browser` 已按 port 自有认领规则刷新（旧安装与旧 bundle
  字节一致 → adopted+refreshed，并写入 `.ego-linux-managed` 标记）。
- `src/*.js` 绑定层、launcher CLI 表面均无需改动：上游新增行为全部走 SDK bundle
  内 + CDP 转发；`claimTaskSpace(id)` 无名调用、实例 id 字符集、截图/下载路径等
  均已逐项核对兼容。
- VERSION：`0.6.0.16-linux.2`（package.json 同步）。

验证（2026-10-31，日志见 `/tmp/e2e-3r-beta5-stdout.txt`、
`/tmp/e2e-snapshot16-beta5.log`、`/tmp/e2e-obs-beta5.log`、
`/tmp/e2e-bonus-beta5.log`）：
- `--version` → `0.6.0.16-linux.2`；`skill --sdk-path vendor/...` → v2.2.0 指南。
- e2e-3r（goto→snapshot→fill→click→evaluate）PASS。
- 快照 16 case：首次运行 15/16，唯一失败 observation helpers 是选 case 时漏了
  前置 case environment initialization（空间未创建）；补跑含前置 case 后
  observation helpers 通过（51 assertions），实际 16/16。
- 追加行为 case 10 个全过：pending navigation ×2、默认截图路径 ×2、workers ×4、
  download lifecycle、actionability。
- 注意：默认路径 `skill` 仍打印旧 v2.1.0 指南，因为默认 `sdk/` 符号链接指向的
  旧 repo 产物未动；发布前须把 `sdk/` 物化为新 vendor bundle（见 README 布局节）。
- 另见：`[ego-browser:notice]` 更新提示在 e2e 输出中出现，属旧有行为（repo
  FETCH_HEAD 领先于本地 port 提交，updateAvailable 为真），与 beta.5 无关。

## 2026-11-01：同步上游 dev head 4471deb（beta.5 之后的 4 commits）

目标选取说明（重要，与 cron 体字面规则的偏差已如实记录）：
- 最新 beta tag 仍是 `v2.2.0-beta.5`（即基线本身），无新 tag。
- `origin/main` HEAD `1240716`（2026-10-30）按提交日期虽晚于 beta.5，但它**不是
  beta.5 的后代**（merge-base 为 2026-10-12 的 `cab9500`）：main 线仍停在
  v2.1.0 发布线，其 SDK 内容反而更旧（skill 指南 v2.1.0、page-model 等大段
  回退）。按字面“取 main 与 beta tag 中日期较新者”同步 main 会把 port 从
  beta.5 降级回 v2.1.0，故不采用。
- beta.5 所在的真正后继线是 `origin/dev`：`4471deb`（2026-10-30，Merge PR
  #612）是 beta.5 的直系后代（`ceeedd6..origin/dev` 共 4 commits），本次即以
  它为同步目标。dev head 尚未打新 tag，下次若出现 `v2.2.0-beta.6` 或更新 tag
  应以 tag 为准复核。

上游行为变化（只列影响本 port 的；其余为 CI/文档/lefthook）：
- pending navigation：`evaluate()` 与 `screenshot()` 在 Page 长时间无响应时也
  走与其它公开调用相同的处理——停止待定导航后以带 `stopped`/`currentUrl` 的
  错误报告（evaluate 为 `EGO_PAGE_EVALUATION_TIMED_OUT`，screenshot 等为
  `EGO_PAGE_UNRESPONSIVE`）；浏览器级方法（`Target.*`/`Browser.*`）超时不被
  误判为 Page 无响应。Skill 指南补了一句 evaluate 的对应说明。
- 响应超时：`browser-runtime.ts` 的 15s 固定超时改为 `responseTimeoutMs()`，
  默认仍 15s，仅测试可用 `EGO_BROWSER_RESPONSE_TIMEOUT_MS` 覆盖；evaluate
  的执行超时改为传输超时减 1s（原固定 14s/15s，行为等价）。
- 其余为 e2e 用例/指纹脚本与构建脚本的复用构建标志
  （`EGO_BROWSER_REUSE_BUILD`，本次构建未设置，走完整构建）。
- 公共 API 无新增方法；原生绑定面（`ego.*`）无变化。

本 port 的改动：
- `vendor/ego-browser/dist/`（out + src + scripts）与
  `vendor/ego-browser/skill-body/SKILL.md` 从 dev head 源码重建并同步；相对
  beta.5 bundle 仅 6 个文件变化（`dist/out/index.js`、
  `dist/src/browser-runtime.js`、`dist/src/page-model.js`、
  `dist/out/ego-browser/SKILL.md` 及 macos/windows 变体、
  `skill-body/SKILL.md`）；SDK package 版本仍为 `0.1.0`。
- Linux port patch 未被上游取代、已重打到 dev head：上游
  `runtimeInstanceId()` 仍是 ppid 推导，`EGO_BROWSER_INSTANCE_ID` 优先分支
  与旧 patch 逐字相同（构建产物已含该分支，bundle 与 transpiled src 均核对）。
- `src/*.js` 绑定层、launcher CLI 表面均无需改动：新行为全部走 SDK bundle
  内 + 已有 CDP 转发（`Page.stopLoading`/`Page.getFrameTree`/
  `Runtime.evaluate` 均为旧有转发方法）。
- VERSION：`0.6.0.16-linux.3`（package.json 同步）。

## 2026-11-01（补推）：linux.4——找回 Justin 的 CDP  masking 回退

事故经过（已如实记录，不遮掩）：
- linux.3 推送后读回核验发现：新提交的父提交不是 linux.2（`22f3e4dd`），
  而是 Justin 本人 2026-10-31 亲推的 `3d6f570`（“Mask CDP automation signals
  on stock Chromium builds”）。该提交只改了 `sdk/index.js` 一个文件：在
  `egoAutomated.enable` 失败时注入 `Page.addScriptToEvaluateOnNewDocument`
  脚本，掩盖 stock Chromium 下 CDP  attach 泄漏的自动化信号
 （`navigator.webdriver`、console.debug/clear 探针、缺失的 `window.chrome`），
  否则 Google 登录这类站点会直接拦截。
- linux.3 的 bundle 是从上游源码重建的，`sdk/index.js` 被全新上游 bundle
  覆盖，Justin 的手工补丁随之丢失（逐文件比对确认：除版本与本次同步文件外，
  唯一被“还原”的就是他的 masking 修改；其余文件无回退）。
- 教训（流程级）：**已发布树里的 `sdk/index.js` 不可只改发布物**——下次同步
  重建 bundle 必然覆盖。Port 侧补丁必须落在源码层（本次做法），且同步流程
  每次推前必须把远端 HEAD 与本地基线逐文件比对，不能只比对“基线 VERSION”。

本次修复：
- 把 Justin 的回退逻辑原文（注释 + 注入脚本逐字相同）打到上游源码层
  `browser-runtime.ts` 的 `enableEgoAutomation()` 里（`egoAutomated.enable`
  的 catch 分支内再发 `Page.addScriptToEvaluateOnNewDocument`），重建后
  bundle 与 transpiled src 均含该分支；`vendor/` 与 `sdk/` 双份一致。
- 同步流程新增一项固定动作：以后的每日同步在推前必须先取远端 HEAD 树，
  与本地基线逐文件比对，远端单方面新增的修改必须先合入本地再推，杜绝
  “整树覆盖式推送丢修改”重演。
- VERSION：`0.6.0.16-linux.4`（package.json 同步）；其余内容与 linux.3 相同。

## 2026-11-03（每日同步）：linux.5——上游 dev 头 b201124（SDK 侧纯文档变化）

判定（沿用 2026-11-01 的 dev 线先例，不照搬字面规则）：最新 beta tag 仍是
`v2.2.0-beta.5`（基线本身），`origin/main` HEAD 仍是 `1240716`（2026-10-30，
SDK 停在 v2.1.0 线，不是 beta.5 的后代，同步它等于降级，故不采用）。真正
的后继仍是 `origin/dev`，本次从 `4471deb` 前进到 `b201124`（2026-11-02，
Merge PR #638）。

上游变化（`4471deb..b201124`，共 41 文件）：大头是新增 `tools/linear-autofix`
（无人值守 Linear→PR→评审循环工具，不属于 port，不同步）；SDK 侧
`package/ego-browser` 只有文档与测试变化，无 `.ts` 行为改动、公共 API 无新增、
绑定层无需改动：
- `skill-body/SKILL.md`：新增 screenshot 约 15s 后 `EGO_PAGE_UNRESPONSIVE`
  的说明（至多重试一次；canvas 走 `toDataURL` 读像素）与 handOff 适用范围
  收紧（无用户给出的凭证的登录、CAPTCHA/人工验证、2FA 等手动步骤；不猜
  凭证、不静默绕过）；
- `skills/ego-browser/references/clearing-state.md`：登录墙本身不再是清
  除站点的理由，改为 handOff 让用户登录；
- 其余为 e2e runner 与 skill-package/page-model 测试。

Port 侧：
- 两处 Linux 补丁在新源码上逐字重打（`page-ledger.ts` 的
  `EGO_BROWSER_INSTANCE_ID` 优先分支；`browser-runtime.ts` 的
  `enableEgoAutomation()` masking 回退），打完后源码与 linux.4 的带补丁源码
  逐字节一致（上游这两处函数本身未变）；bundle 与 transpiled src 均核对含
  两处分支。
- `vendor/ego-browser/dist` 与 `skill-body/SKILL.md` 从新 worktree 全量同步；
  SDK package version 仍 `0.1.0`，port `package.json` 不变。
- 推前远端比对：远端 HEAD 仍是 linux.4（`c3512a1f`），除 `sdk/`（本地为指向
  clone 旧 dist 的符号链接，staging 物化时绕过）与排除目录外，本地树与远端
  逐文件一致，无远端单方面修改需要合入。注意：本地 `sdk` 符号链接目前指向
  `../repo/package/ego-browser/dist/out`（旧版 dist），不要直接用它验证，
  一律以 staging 物化产物为准。
- VERSION：`0.6.0.16-linux.5`。

## 2026-11-04（每日同步）：linux.6——上游 dev 头 bbd103c（权限提示命名 + waitForFunction 文档化）

判定（沿用 2026-11-01 的 dev 线先例）：最新 beta tag 仍是 `v2.2.0-beta.5`，
`origin/main` HEAD 仍是 `1240716`（2026-10-30，同步它等于降级，不采用）。
目标为 `origin/dev` HEAD `bbd103c`（2026-11-03，Merge PR #649）。

上游变化（`b201124..bbd103c`，共 13 文件）：`tools/linear-autofix` 的
dry-run 状态隔离（不属于 port，不同步）；SDK 侧 `package/ego-browser`：
- `ego-errors.ts`：user-control 原因新增 clipboard、local_network_access、
  storage_access、window_management、local_fonts、permission_prompt 六个命名
  （`permission_prompt` 兜底无专属键的提示/选择器；`manual_takeover` 明确不
  用于权限提示），附测试；
- `page-model.ts` / `public-api-schema.ts` / `skill-body/SKILL.md`：
  `waitForFunction` 文档化为 resolves to `true`（非谓词返回值）、超时抛错，
  读状态改用 `page.evaluate()`，附测试；实现本身无行为改动；
- `docs/native-bindings-api.md`：权限键表同步新增上述六项。
绑定层无需改动（无新 API、无行为改动）。

Port 侧：
- 两处 Linux 补丁在新源码上逐字重打（`page-ledger.ts` 的
  `EGO_BROWSER_INSTANCE_ID` 优先分支，上游仍从 ppid 派生，未变；
  `browser-runtime.ts` 的 `enableEgoAutomation()` masking 回退），打完后源码
  与 linux.5 的带补丁源码之差恰好等于上游改动；bundle 核对含两处分支。
- `vendor/ego-browser/dist` 与 `skill-body/SKILL.md` 从新 worktree 全量同步；
  SDK package version 仍 `0.1.0`，port `package.json` 不变。
- VERSION：`0.6.0.16-linux.6`。
