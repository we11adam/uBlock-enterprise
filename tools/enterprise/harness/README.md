# uBO Enterprise：端到端测试

这些测试在容器中运行**真实的 Google Chrome**（Linux amd64 稳定版）。扩展通过
**真实的 Linux 托管策略**（`/etc/opt/chrome/policies/managed`）强制安装，从本地
更新主机（`http://update.test/update.xml`）下载 CRX3，再由测试脚本通过 Chrome
DevTools Protocol 驱动浏览器。只有经策略安装，`webRequestBlocking` 才可用，所以
这里不用 Puppeteer 的 `--load-extension`。

测试**不能**代替企业环境的验收：没有覆盖 macOS、Chrome Enterprise Core 下发的
策略、HTTPS 托管和外网过滤列表。见 `platform/chromium-enterprise/DEPLOYMENT.md`
第 8 节。

## 准备

```sh
docker build --platform linux/amd64 -t ubo-mv3-chrome:local tools/enterprise/harness
# 测试密钥：放在仓库之外。它对应的 ID 只是测试 ID，不是生产 ID
mkdir -p /tmp/ubo-ent-keys
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out /tmp/ubo-ent-keys/test.pem
```

在 Apple Silicon 上，容器通过 Rosetta / QEMU 运行 amd64 的 Chrome，速度较慢；
测试中的时间数据只用于相对比较。

## 运行

```sh
tools/enterprise/harness/run-ubo-tests.sh /tmp/ubo-ent-keys/test.pem /tmp/ubo-ent-test
```

脚本会：构建两个版本（`dist/version` 及其第 4 段加 1 的版本，用于测试升级），
分别打包成 CRX3，生成两份更新清单，然后在容器中运行 `test-ubo.mjs`。测试使用的
过滤器（`test-ubo-filters.json`）和管理员一样，通过扩展策略（storage.managed）
下发。全部通过时最后一行为 `N/N passed`，退出码为 0。

环境变量：

| 变量 | 作用 |
|---|---|
| `TEST_FILTER` | 只运行名称匹配该正则的测试阶段，例如 `'^(network\|sw-restart)$'`（`install` 总会运行） |
| `SKIP_BUILD=1` | 跳过构建和打包，复用工作目录中的 CRX |
| `TIMING_RUNS` | scriptlet-timing 阶段中，每种情况的导航次数（默认 10） |
| `LOOKUP_DELAY` | dashboard-offscreen 阶段中，停止 Service Worker 后等待的毫秒数 |
| `IMAGE` | 容器镜像（默认 `ubo-mv3-chrome:local`） |

## 测试阶段（`test-ubo.mjs`）

| 阶段 | 内容 |
|---|---|
| `install` | 策略安装（`installType: admin`）、管理员过滤器生效、无晚注册的监听器 |
| `network` | 拦截、例外、`$redirect`、`$removeparam`、`$csp`、严格拦截页、框架上下文 |
| `cosmetic-scriptlets` | cosmetic 和 procedural 过滤、两个世界的 scriptlet、严格 CSP、跨站 iframe |
| `scriptlet-timing` | MAIN 世界 scriptlet 相对于页面内联脚本的时机（新标签页、跨站导航为断言项；同站导航只报告） |
| `sw-restart` | 停止 Service Worker 后：请求被挂起再判定、框架请求、冷导航、从 selfie 加载、alarms |
| `session-rules` | 临时规则在 Service Worker 重启后保留 |
| `dashboard-offscreen` | 控制台、过滤器反查（Offscreen Worker），以及 Service Worker 停止后的端口行为 |
| `policy-change` | 运行时修改策略文件：新增和删除的过滤器无需重启浏览器即生效 |
| `browser-restart` | 浏览器冷启动：启动页被过滤，临时规则被重置 |
| `upgrade` | 更新清单指向新版本，浏览器重启后完成升级，设置保留 |

输出中：`PASS`/`FAIL` 为断言项；`INFO` 只报告、不断言，用于已知限制
（例如同站导航和冷启动时 scriptlet 的时机）。

## 其他文件

| 文件 | 用途 |
|---|---|
| `cdp.mjs` | 无依赖的最小 CDP 客户端（停止 Service Worker 时不会附加到它，避免把它重新唤醒） |
| `server.py` | 测试站点、更新主机、请求命中记录（`/__hits`），`bodydelay` 参数用于延迟响应正文 |
| `sites/` | 测试站点 `site-a.test`、`site-b.test`、`cdn.test`、`ads.test`、`tracker.test` |
| `test-probe.mjs`、`../probe/` | 可行性探针：策略安装的 MV3 扩展能否使用阻塞式 webRequest |
| `debug-ubo.mjs`、`debug-eval.mjs` | 调试辅助：记录每个 Service Worker 实例的控制台输出，执行表达式 |
| `run.sh` | 底层启动脚本：`run.sh <dist 目录> <sites 目录> <扩展 ID> <测试脚本>` |
