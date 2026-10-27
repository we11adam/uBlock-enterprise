# uBO Enterprise：Chromium MV3 企业部署构建

这是 uBlock Origin 的非官方 MV3 构建，仅供通过企业策略强制安装到 Google Chrome。
它在 MV3 Service Worker 中运行 uBO **原有的**网络过滤引擎（`webRequest` +
`webRequestBlocking`），不是 uBO Lite，也不使用 declarativeNetRequest。

- 上游：uBlock Origin（Raymond Hill & contributors），GPLv3，见 `LICENSE.txt`。
- 扩展名称：“uBO Enterprise (unofficial build of uBlock Origin)”，与上游区分。
- 部署：见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 前提

Chrome 只对**通过策略安装**的扩展开放 MV3 下的 `webRequestBlocking`。普通安装
（开发者模式加载、拖放 CRX）时，扩展可以加载，但阻塞式 webRequest 不可用，
**过滤不会生效**。以下几点已经在 Chrome 156 上实测
（`tools/enterprise/probe`、`tools/enterprise/harness`）：

- 通过托管策略强制安装后，MV3 Service Worker 可以注册阻塞式 webRequest 监听器
  （cancel、redirect、修改请求头和响应头）；
- 监听器返回 Promise 时，请求会被挂起，直到 Promise 完成；
- 唤醒已停止的 Service Worker 的那个请求，同样会被挂起并正确过滤。

## 构建

```sh
npm ci                                  # 一次即可（eslint、espree）
tools/make-chromium-enterprise.sh       # 输出 dist/build/uBlock0.chromium-enterprise
```

环境变量（都是可选的）：

| 变量 | 作用 |
|---|---|
| `UBO_ENT_VERSION` | 清单 `version`，例如 `1.75.1.3`。每次发布都必须递增，见 DEPLOYMENT.md |
| `UBO_ENT_UPDATE_URL` | 清单 `update_url`，必须是 `https://` |
| `UBO_ENT_PUBLIC_KEY` | 清单 `key`（base64 SPKI），让解包构建的 ID 与 CRX 一致 |

`make chromium-enterprise` 也可以构建，但它按文件时间戳判断是否需要重建，
修改环境变量后不会触发重建。发布时请直接调用脚本。

构建过程中会：

1. 复制公共文件和 Chromium 平台文件，再用 `platform/chromium-enterprise/` 覆盖；
2. 生成 `js/scriptlet-lib.js`（`tools/enterprise/make-scriptlet-lib.mjs`），
   从 `src/js/resources` 中所有 scriptlet 自动生成；
3. 生成最终清单（`tools/enterprise/make-chromium-enterprise-meta.py`）；
4. 检查 Service Worker 模块图（`tools/enterprise/check-sw-graph.mjs`）。图中
   出现 top-level await、动态 `import()` 或只在 DOM 中存在的全局对象时，构建
   失败或给出警告。合并上游后，新引入的不兼容写法就是在这一步暴露出来的。

## 架构

```
sw.js                     Service Worker 入口（模块）
├─ js/sw-env.js           Service Worker 环境：browser/vAPI 全局、shim、事件桥接
├─ js/start.js …          uBO 原有后台代码（与 MV2 相同的引擎）
│   ├─ js/vapi-background-ext.js   请求挂起门（gate）、消息延迟处理
│   ├─ js/webext.js                chrome.action / chrome.scripting 映射
│   └─ js/vapi-scripting.js        scriptlet 注入（无代码字符串）
├─ js/sw-session.js       会话状态在 Service Worker 重启之间的保存与恢复
└─ js/sw-policy.js        管理员策略变更的应用
offscreen.html/.js        Offscreen Document，仅用来承载 Worker（WORKERS reason）
```

### Service Worker 生命周期

- **顶层同步注册监听器**：`sw-env.js` 在模块求值时，为 uBO 将来会注册的
  每个事件（webRequest 的各阶段、webNavigation、tabs、runtime、alarms、
  storage 等）先注册一个“桥接”监听器，过滤条件和选项与 uBO 相同。uBO
  异步启动完成后注册的监听器挂到桥上；在此之前到达的事件先排队，引擎就绪后
  按顺序分发。测试会断言不存在晚注册的监听器（`lateRegistrations`）。
- **冷启动和请求泄漏窗口**：Service Worker 被请求唤醒时，来自标签页的请求
  通过返回 Promise 被**挂起**，过滤引擎（selfie）加载完成后再由真实引擎做出
  判断。这与 uBO 在 Firefox 上的 `suspendUntilListsAreLoaded` 行为相同。
  - 不会“初始化期间一律拦截”：被挂起的请求最终按真实规则处理，测试分别
    验证了“被拦截”和“被放行”两种结果。
  - 每个请求最多挂起 30 秒，超时后放行（fail-open），并计入
    `uBOmv3.stats.heldRequestsFailOpen`。测试中该计数始终为 0。
  - 与标签页无关的请求（包括 uBO 自己下载过滤列表）不会被挂起，因此不会在
    初始化时死锁。
  - 实测：从 Service Worker 停止到第一个请求被判定，约 450–550 ms（容器内
    amd64 模拟环境）。
- **规则原子替换**：过滤引擎只在 selfie 或编译完成、`engineReadyHooks`
  （会话规则恢复）执行完后才开始处理请求；被挂起的请求在这之后统一放行。
  不存在“规则半加载”的窗口。
- **持久化**：永久设置、规则和过滤器沿用 uBO 原有的 storage.local 和
  cacheStorage（selfie）。Service Worker 重启时，过滤引擎从 selfie 加载（实测约
  0.1–0.5 秒）。selfie 在过滤列表编译完成后，由 uBO 的定时器或 alarm 延迟生成；
  在此之前重启，会重新编译过滤列表（实测 0.5–5 秒，期间请求同样被挂起）。只存在于内存中的会话状态（临时防火墙规则、临时开关、
  临时 URL 规则）由 `sw-session.js` 写入 `storage.session`，Service Worker
  重启后恢复；浏览器重启后清空，与 MV2 一致。
- **定时任务**：资产更新、selfie 生成、设置保存使用 uBO 原有的
  `vAPI.alarms`（chrome.alarms），Service Worker 停止后仍会触发。
- **每次浏览器会话只做一次的事情**：启动时的更新检查等，通过
  `storage.session` 标记区分“浏览器会话的首次唤醒”和“Service Worker 重启”
  （`vAPI.app.isFirstWakeOfSession`）。
- **不使用 keepalive**：没有任何保持 Service Worker 存活的机制。Service Worker
  按 Chrome 的空闲策略随时可能停止，所有路径都按“随时可能被停止”设计和测试。
- **Offscreen Document**：只用来承载 uBO 的 Worker（过滤器反查
  `reverselookup-worker.js`、`diff-updater.js`），因为 Service Worker 无法创建
  专用 Worker。用途符合 `WORKERS` reason；空闲 10 秒后关闭。
  - Offscreen Document **不监听** `runtime.onConnect`。原因：内容脚本和扩展页面
    用 `runtime.connect()` 打开的端口，会投递给所有监听 onConnect 的扩展上下文；
    只要还有一个接收方保持端口打开，端口就不会断开。这样一来，Service Worker
    停止后，这些端口不会收到 onDisconnect，后续消息会丢失，也不会唤醒 Service
    Worker（实测：控制台中的过滤器反查不再有响应）。而接收方调用
    `port.disconnect()` 又会关闭整个通道。
  - 因此改为：Service Worker 通过一次性消息（`runtime.sendMessage`）请求创建
    Worker，再由 Offscreen Document 主动连接回 Service Worker，只验证来自
    `offscreen.html` 的端口；uBO 的消息机制会忽略这些端口。

### scriptlet 注入

MV3 不允许执行代码字符串，而 uBO 在 Chromium 上一直是用代码字符串注入
scriptlet 的。本构建的做法：

- 构建时把所有 scriptlet 函数生成到静态模块 `js/scriptlet-lib.js`，分为
  MAIN 和 ISOLATED 两个世界；
- 运行时仍由 uBO 原有的 scriptlet 编译器按主机名计算数据（参数、依赖函数），
  在 `webNavigation.onCommitted` 时通过
  `scripting.executeScript({ func, args, injectImmediately: true })` 注入。
  时机与 MV2 版 uBO 在 Chromium 上使用 `tabs.executeScript` 时相同；
- MAIN 世界的函数直接执行，不受页面 CSP 限制（测试中，严格 CSP 页面上的
  scriptlet 同样生效）；
- 用户自定义资源（`userResourcesLocation`）中、不在库里的 scriptlet，回退到
  MV2 的 `<script>` 元素方式注入，会受页面 CSP 限制。

时机限制见下文“已知限制”。

### 管理员策略（managed storage）

uBO 在启动时应用管理员设置（`toOverwrite`、`userSettings` 等），读取的是
storage.managed 的缓存副本，并在每次启动后刷新这份副本。Chrome 在强制安装后
或策略变更后，才异步写入 storage.managed。`sw-policy.js` 在启动时和
`storage.onChanged` 时，把 storage.managed 与本实例实际应用的策略比较，不同就
更新缓存并重新加载扩展，因此策略变更无需重启浏览器即可生效（实测约 8 秒）。
重新加载做了限频（60 秒内最多 3 次，计数保存在 storage.local 中，因为
重新加载会清空 storage.session），避免策略不断变化时陷入循环。

## 功能对照表

“已验证”指在真实 Google Chrome 156（Linux 容器）中，经真实托管策略强制安装后，
由自动化测试断言通过（`tools/enterprise/harness/test-ubo.mjs`）。macOS 和
Chrome Enterprise Core 下发的验证仍需在企业环境中完成，见 DEPLOYMENT.md。

| 功能 | 状态 | 说明 |
|---|---|---|
| 策略强制安装，`installType: admin`，用户不可停用 | 已验证 | Linux 托管策略 |
| 网络拦截、`@@` 例外 | 已验证 | 以测试服务器命中记录为准 |
| `$redirect`（如 noop.js） | 已验证 | |
| `$removeparam` | 已验证 | |
| `$csp`（响应头修改） | 已验证 | |
| 严格拦截页（`$document`，document-blocked.html） | 已验证 | |
| `$domain` 与框架上下文（含 Service Worker 重启后） | 已验证 | |
| cosmetic 过滤（特定站点） | 已验证 | 同时验证了跨站 iframe |
| procedural cosmetic 过滤（`:has-text`） | 已验证 | |
| scriptlet：MAIN 世界（set-constant；nofab、noeval 来自 WAR 资源） | 已验证（有时机限制） | 新标签页和跨站导航中先于页面脚本执行；同站导航见“已知限制” |
| scriptlet：ISOLATED 世界（set-local-storage-item）、set-attr | 已验证 | |
| 严格 CSP 页面上的 scriptlet | 已验证 | |
| 管理员策略：`toOverwrite.filters`（安装时、运行中变更） | 已验证 | 运行中增加和删除过滤器均已验证 |
| Service Worker 被停止：请求挂起后由真实引擎判定，无放行泄漏 | 已验证 | 连续 3 次，fail-open 计数为 0 |
| 浏览器冷启动：启动页的子资源被拦截 | 已验证 | |
| 临时规则（弹出面板）在 Service Worker 重启后保留，浏览器重启后重置 | 已验证 | 与 MV2 语义相同 |
| 弹出面板数据、控制台页面、过滤器反查（Offscreen Worker） | 已验证 | 部分 UI 渲染验证 |
| alarms（资产更新、selfie） | 已验证 | |
| Service Worker 重启后从 selfie 加载引擎，WAR 资源中的 scriptlet 仍然生效 | 已验证 | 修复了上游的加载顺序问题，见“与上游合并” |
| 自托管更新：update.xml → CRX，浏览器重启后升级，设置、规则、过滤器保留 | 已验证 | 本地 HTTP 更新主机 |
| 过滤列表下载与更新、diff 更新 | 已实现，待企业环境验收 | 测试环境无外网，只用了管理员过滤器 |
| 元素拾取器、元素清除器、记录器（logger） | 已实现，待企业环境验收 | 未自动化测试 |
| 通用 cosmetic 过滤（generic）、DOM 变化后的增量处理 | 已实现，待企业环境验收 | 与 MV2 共用 contentscript.js |
| 每站点开关（no-scripting、no-large-media、no-remote-fonts、no-cosmetic-filtering、no-popups） | 已实现，待企业环境验收 | 基于 webRequest 和响应头，机制与 MV2 相同 |
| 动态过滤（防火墙）、URL 规则 | 已验证（临时规则） | 与上游相同，需要开启“高级用户”（`advancedUserEnabled`） |
| 设置备份和恢复（导出、导入） | 已实现，待企业环境验收 | 用于从现有 uBO 迁移 |
| 云存储（chrome.storage.sync） | 已实现，待企业环境验收 | |
| 右键菜单、快捷键 | 已实现，待企业环境验收 | |
| 隐身窗口（`incognito: split`） | 已实现，待企业环境验收 | 由策略或用户决定是否允许 |
| 每标签页拦截计数 | 有差异 | Service Worker 重启后从 0 开始计数 |
| WebRTC 本地 IP 防泄漏设置 | 与 MV2 Chromium 相同（不提供） | 上游在 Chromium 上本就禁用 |
| HTML 过滤（`##^`）、`$replace` | 不支持 | 需要 `filterResponseData`，只有 Firefox 提供，与 MV2 Chromium 相同 |
| 普通方式安装（非策略安装） | 不支持 | Chrome 只对策略安装开放 `webRequestBlocking` |
| `chrome.userScripts` | 不可用 | 见下文 |

## 已知限制

1. **同站导航时，MAIN 世界 scriptlet 可能晚于页面内联脚本。** 注入发生在导航
   提交时，与渲染器解析文档是并行的竞争。实测（每组 20 次）：
   - 新标签页：20/20 及时；
   - 同一标签页内的跨站导航（使用新的渲染进程）：20/20 及时；
   - 同站导航（渲染进程复用）：HTML 正文与响应头同时到达时 0–1/20 及时；
     正文晚 10 ms 时 3–7/20；晚 20 ms 及以上时 19–20/20。

   scriptlet 并没有缺失，只是生效晚了：页面脚本执行之后，它仍然会生效。
   这与 MV2 版 uBO 在 Chromium 上的注入机制相同（在 onCommitted 时调用
   `tabs.executeScript`），但当前版本的 Chrome 已无法运行 MV2，无法做对照实测。
   我们试过的改进方法：先注入 MAIN 再注入 ISOLATED，没有可测量的改善，已
   放弃；缩小注入的库体积，差异在 2 ms 以内。我们不采用的方法：通过
   Server-Timing 响应头、同步 XHR 等方式向页面同步传递数据，这些做法难以长期
   维护。
   Service Worker 繁忙时（例如安装后编译过滤列表期间），事件处理会推迟，第一次
   加载页面时也可能晚。
2. **`chrome.userScripts` 不可用**：对强制安装的扩展，即使清单中声明了
   `userScripts` 权限，该 API 仍为 `undefined`（Chrome 156 实测）。从 Chrome 138
   起需要用户在扩展详情页手动打开“允许用户脚本”，且没有对应的策略。因此不能
   靠它做 document_start 的同步注入。
3. **每标签页计数不持久**：Service Worker 重启后，弹出面板中的“本页已拦截”
   计数从 0 开始。
4. **首次安装后约 11 秒管理员策略才生效**：Chrome 在安装后才异步写入
   storage.managed，扩展随后重新加载一次。在此之前，使用的是默认过滤列表。
   另外，uBO 上游在 Chromium 首次安装时本身也会重新加载一次。
5. **管理员设置在每次 Service Worker 唤醒时都会重新应用**：例如
   `toOverwrite.filterLists` 会在每次唤醒时覆盖用户在控制台中所做的修改，比
   MV2（每次浏览器启动应用一次）更频繁。语义上都是“管理员设置优先”。
6. **扩展页面的消息竞争**：如果 Service Worker 恰好在控制台或弹出面板发出消息
   的那一刻停止，这条消息会得到空结果，下一条消息会自动重连。uBO 的消息端口
   空闲 10 秒后就会关闭，而 Chrome 在空闲 30 秒后才停止 Service Worker，所以
   正常情况下很少发生；强制停止 Service Worker 时可以复现。
7. **升级在浏览器重启后生效**：这是上游行为（uBlock-issues#717，避免会话中途
   重启）。如需立即生效，可设置高级设置 `extensionUpdateForceReload`。

## 测试

见 `tools/enterprise/harness/README.md`。

## 与上游合并

本分支对上游文件的改动刻意保持很小，且只有在 Service Worker 环境中才会改变
行为（MV2 的 Chromium 和 Firefox 构建行为不变）。

| 上游文件 | 改动 |
|---|---|
| `Makefile` | `chromium-enterprise` 目标 |
| `package.json`、`package-lock.json` | devDependency `espree`（构建工具使用） |
| `platform/common/vapi-background.js` | MV3 的 CSP 对象、`action`、无 `Image`、无 `window` |
| `platform/common/vapi-common.js` | 无 `window`、`CSS` |
| `src/js/i18n.js` | 无 `document`、`Element` |
| `src/js/publicsuffix.js`、`src/js/redirect-engine.js` | 动态 import 改为静态 import |
| `src/js/scriptlet-filtering.js` | 去掉 top-level await；`getScriptletData()`、`isScriptletBailout()` |
| `src/js/start.js` | 启动时的更新检查每个浏览器会话只做一次 |
| `src/js/storage.js` | 从 selfie 加载后，在资源加载完成时重置 scriptlet 编译器（修复：否则来自 WAR 资源的 scriptlet，如 nofab、noeval，不会被注入）。上游 MV2 从 selfie 启动时可能也有同样的问题，可以考虑向上游报告 |

合并方法：

```sh
git remote add upstream https://github.com/gorhill/uBlock.git   # 一次即可
git fetch upstream --tags
git switch enterprise-mv3
git merge <上游发布标签，例如 1.76.0>     # 用 merge，不要 rebase，以保留历史
# 解决上表所列文件中的冲突
tools/make-chromium-enterprise.sh          # check-sw-graph 会暴露新的不兼容写法
tools/enterprise/harness/run-ubo-tests.sh <测试密钥> <工作目录>   # 完整回归测试
```

需要重点注意的上游变化：

- 新增的 top-level await 或动态 import（构建会失败）；
- 后台代码新增对 DOM 的依赖（构建会给出警告）；
- `vapi-scripting.js`、`scriptlet-filtering.js`、`make-scriptlets.js` 中
  scriptlet 模板格式的变化（`make-scriptlet-lib.mjs` 和
  `platform/chromium-enterprise/vapi-scripting.js` 依赖这些格式；测试中的
  scriptlet 检查会失败）；
- `platform/chromium/*.js` 的变化：本构建会复制这些文件，并在其基础上扩展
  （`vapi-background-ext.js`）或替换（`webext.js`、`vapi-scripting.js`）。
  被替换的文件需要手工同步上游的改动。
