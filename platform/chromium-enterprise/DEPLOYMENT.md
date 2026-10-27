# uBO Enterprise：部署指南（自托管 CRX3 + Chrome Enterprise Core）

本文中的占位符：

| 占位符 | 含义 |
|---|---|
| `<HOST>` | 托管更新清单和 CRX 的 HTTPS 主机，例如 `ext.example.com` |
| `<EXTENSION_ID>` | 由**生产签名密钥**计算出的扩展 ID（32 个 a–p 字母） |
| `<VERSION>` | 本次发布的扩展版本，例如 `1.75.1.101` |
| `<KEY_DIR>` | 仓库之外、只有发布者可读的目录，例如 `~/secure/ubo-enterprise` |

> 测试工具（`tools/enterprise/harness`）使用的测试密钥及其 ID 只用于测试，
> **不是**生产 ID。生产 ID 由下面第 1 步生成的密钥决定，一旦部署就不能再换。

## 0. 前提

- Google Chrome 154 或更高版本（清单 `minimum_chrome_version`）。
- 浏览器必须是受管理的，否则 Chrome 不允许强制安装 Chrome 应用商店之外的扩展。
  macOS 上的条件是：已注册到 Chrome Enterprise Core（浏览器注册令牌），
  或通过 MDM 管理，或通过 MCX 加入域
  （[ExtensionInstallForcelist 策略说明](https://chromeenterprise.google/policies/extension-install-forcelist/)）。
- 只有通过策略安装时，`webRequestBlocking` 才可用。手动加载或拖入 CRX 时扩展虽然
  能运行，但**不会过滤任何东西**。
- 构建环境：Node.js 22 或更高、Python 3、bash、`npm ci`。

## 1. 生成生产签名密钥（一次）

私钥必须放在仓库之外，不要提交、不要打印、不要放进扩展包里。`crx3.mjs` 会拒绝
位于仓库内的密钥路径。

```sh
mkdir -p <KEY_DIR> && chmod 700 <KEY_DIR>
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out <KEY_DIR>/ubo-enterprise.pem
chmod 600 <KEY_DIR>/ubo-enterprise.pem

node tools/enterprise/crx3.mjs id     --key <KEY_DIR>/ubo-enterprise.pem   # => <EXTENSION_ID>
node tools/enterprise/crx3.mjs pubkey --key <KEY_DIR>/ubo-enterprise.pem   # => 公钥（base64 SPKI，可以公开）
```

把私钥备份到安全的位置（例如密码管理器或离线介质）。**私钥丢失后无法再发布更新**：
只能换一个新 ID 重新部署，而且用户在旧 ID 下的设置不会自动迁移。

## 2. 版本号规则

- Chrome 只会升级到**更高**的版本，不会降级。
- 本构建的版本号为“上游版本 + 第 4 段”：上游发布 `1.75.1` 时，企业版依次为
  `1.75.1.1`、`1.75.1.2`……同一个上游版本重新构建时，也要递增第 4 段。
- 生产环境应基于上游的**正式发布标签**（三段版本号）。当前分支的基线是
  master（`dist/version` 为 `1.75.1.100`，属于开发版本）。基于它构建出的扩展
  名称带有 “development build”，uBO 也会按开发版运行，适合验收测试，但不适合
  长期生产使用。
- 如果验收时已经部署过 `1.75.1.100`，之后基于正式版 1.75.1 的构建，第 4 段
  必须继续增大（例如 `1.75.1.101`），否则 Chrome 不会升级。

## 3. 构建、打包、生成更新清单

```sh
npm ci   # 一次即可

UBO_ENT_VERSION=<VERSION> \
UBO_ENT_UPDATE_URL=https://<HOST>/ubo-enterprise/update.xml \
UBO_ENT_PUBLIC_KEY="$(node tools/enterprise/crx3.mjs pubkey --key <KEY_DIR>/ubo-enterprise.pem)" \
tools/make-chromium-enterprise.sh

node tools/enterprise/crx3.mjs pack \
    --dir dist/build/uBlock0.chromium-enterprise \
    --key <KEY_DIR>/ubo-enterprise.pem \
    --out /tmp/ubo-enterprise-<VERSION>.crx
node tools/enterprise/crx3.mjs verify --crx /tmp/ubo-enterprise-<VERSION>.crx   # 核对输出的 ID 是否为 <EXTENSION_ID>

node tools/enterprise/update-xml.mjs \
    --id <EXTENSION_ID> --version <VERSION> \
    --codebase https://<HOST>/ubo-enterprise/ubo-enterprise-<VERSION>.crx \
    --out /tmp/update.xml
```

说明：

- **`UBO_ENT_UPDATE_URL` 必须设置。** 策略中的更新地址只在首次安装时使用，此后
  Chrome 按扩展清单里的 `update_url` 检查更新。如果清单里没有 `update_url`，
  需要在 ExtensionSettings 中设置 `override_update_url`（见第 5 节）。
- 设置 `UBO_ENT_PUBLIC_KEY` 后，解包加载的构建与 CRX 的 ID 一致，便于调试。
  它只包含公钥。
- 请直接调用脚本，不要用 `make chromium-enterprise`：后者按文件时间判断是否需要
  重建，修改环境变量后不会触发重新构建。

## 4. 托管（HTTPS）

把两个文件上传到 `<HOST>`：

```
https://<HOST>/ubo-enterprise/update.xml                         更新清单（策略中引用的地址）
https://<HOST>/ubo-enterprise/ubo-enterprise-<VERSION>.crx       CRX（只在 update.xml 中引用）
```

- 使用有效证书的 HTTPS，不需要身份验证（Chrome 后台更新请求不会携带凭据）。
- CRX 建议使用 `Content-Type: application/x-chrome-extension`。
- `update.xml` 不要被长时间缓存（例如 `Cache-Control: no-cache` 或较短的 max-age），
  否则会推迟升级。
- 保留旧版本的 CRX 文件，以便必要时重新部署。
- 发布顺序：先上传新的 CRX，再替换 `update.xml`。

## 5. Chrome Enterprise Core：强制安装

在 Google 管理控制台中，打开“Chrome 浏览器”下的“应用和扩展程序”，选择
“用户和浏览器”，再选中目标组织部门：

1. 点击“+”，选择“按 ID 添加 Chrome 应用或扩展程序”；
2. 填入 `<EXTENSION_ID>`，选择“来自自定义网址”，网址填写
   `https://<HOST>/ubo-enterprise/update.xml`（更新清单，**不是** CRX 的地址）；
3. 安装政策选择“强制安装”（或“强制安装并固定到工具栏”）；
4. 保存。

对应的 Chrome 策略（chrome://policy 中显示的内容）大致如下：

```json
{
  "ExtensionSettings": {
    "<EXTENSION_ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://<HOST>/ubo-enterprise/update.xml",
      "override_update_url": true
    }
  }
}
```

只有在构建时没有设置 `UBO_ENT_UPDATE_URL`，或需要强制所有更新都走策略中的
地址时，才需要 `override_update_url`。管理控制台的界面可能没有提供这个选项，
那时就要依靠清单里的 `update_url`。

建议同时禁止安装其他 uBO 系列扩展，避免重复过滤：在同一组织部门中阻止
uBlock Origin（`cjpalhdlnbpafiamejdnhcphjbkeiagm`）和 uBlock Origin Lite
（`ddkjiahejlhfcafbddmgiahcphecmpfh`）。

## 6. 扩展策略（管理员设置）

在扩展的详情面板中，“扩展程序政策”（Policy for extensions）字段接收 JSON，
对应扩展的 `storage.managed`，字段定义见 `platform/common/managed_storage.json`。
**在管理控制台中，每个键的值都需要用 `{"Value": …}` 包起来**
（参见 [Ghostery 的说明](https://www.ghostery.com/enterprise-privacy-solutions/documentation/google-workspace)、
[Tampermonkey 的说明](https://www.tampermonkey.net/documentation.php?locale=en&q=deploying)、
[chromium-extensions 讨论](https://groups.google.com/a/chromium.org/g/chromium-extensions/c/CX60nkKLizo)）。
本地策略文件（Linux JSON、macOS 配置描述文件、Windows 注册表）不需要这一层包装。

示例（管理控制台格式）：

```json
{
  "toOverwrite": {
    "Value": {
      "filterLists": [
        "user-filters", "ublock-filters", "ublock-badware", "ublock-privacy",
        "ublock-unbreak", "ublock-quick-fixes", "easylist", "easyprivacy",
        "urlhaus-1", "plowe-0"
      ],
      "filters": [
        "||example-ads.test^"
      ],
      "trustedSiteDirectives": [
        "intranet.example.com"
      ]
    }
  },
  "disabledPopupPanelParts": {
    "Value": []
  }
}
```

- `toOverwrite.filters` 会**替换**用户的“我的过滤器”；`toOverwrite.filterLists`
  会**替换**已选用的过滤列表。本构建在每次 Service Worker 唤醒时都会重新应用这些
  设置（见 README“已知限制”第 5 条）。`toAdd` 只支持以追加方式设置
  `trustedSiteDirectives`。
- 策略变更无需重启浏览器：Chrome 更新 storage.managed 后，扩展会自动重新加载
  并应用新设置（实测约 8 秒，60 秒内最多重新加载 3 次）。

## 7. 升级、回滚、卸载、迁移

- **升级**：按第 2–4 节构建一个更高的版本，先上传 CRX，再替换 `update.xml`。
  Chrome 大约每 5 小时检查一次更新（也可以在 chrome://extensions 中开启开发者
  模式后点击“更新”）。新版本会在**浏览器下次启动时**生效，这是上游的行为；如需
  立即生效，可以设置高级设置 `extensionUpdateForceReload`。设置、规则和过滤器都会
  保留（已测试）。
- **回滚**：Chrome 不会降级。回滚的做法是：用旧版本的代码，以**更高**的版本号
  重新构建、签名并发布。
- **卸载**：在管理控制台中删除该扩展，或把安装政策改为“阻止”。扩展会被移除，
  它的本地数据也会一并删除。
- **从现有 uBO 迁移**：在原 uBO 的控制台“设置”页中“备份到文件”，然后在
  uBO Enterprise 中“从文件恢复”。如果规则需要统一管理，应改为放进扩展策略
  （第 6 节）。

## 8. 必须由你在企业环境中执行的验收

以下各项无法在本仓库的自动化测试中完成（测试使用 Linux 容器和本地策略文件），
交付状态为“待企业环境验收”：

1. [ ] 在 macOS 上，浏览器已注册到 Chrome Enterprise Core：chrome://management
       显示浏览器受管理。
2. [ ] chrome://policy 中显示 ExtensionSettings（或 ExtensionInstallForcelist），
       其中包含 `<EXTENSION_ID>` 和更新地址，状态为“正常”。
3. [ ] chrome://extensions 中出现 “uBO Enterprise”，ID 为 `<EXTENSION_ID>`，标有
       “由你的组织安装”，不能停用或移除。
4. [ ] 扩展详情 → 检查视图：Service Worker 控制台中没有报错；在控制台执行
       `chrome.webRequest.onBeforeRequest.hasListeners()`，结果为 `true`。
5. [ ] 访问 https://d3ward.github.io/toolz/adblock 或类似的测试页面，广告请求被拦截；
       弹出面板中有拦截计数。
6. [ ] 扩展策略生效：控制台“我的过滤器”中出现策略中的过滤器；修改策略后约
       10 秒内生效，无需重启浏览器。
7. [ ] 在 chrome://serviceworker-internals 中停止 uBO 的 Service Worker（或空闲
       超过 30 秒后），再打开一个新的网站：广告仍被拦截。
8. [ ] 完全退出 Chrome（Cmd+Q）后重新启动：启动页上的广告被拦截。
9. [ ] 升级：发布 `<VERSION>` + 1，等待更新（或手动点击“更新”）并重启浏览器：
       版本号更新，设置和过滤器保留。
10. [ ] 过滤列表能从网络正常下载和更新：控制台“过滤列表”页显示更新时间，可以
        手动“立即更新”。
11. [ ] 日常使用 1–2 天：常用站点没有异常，元素拾取器和记录器（logger）可用。
12. [ ] 如果用户需要在隐身窗口中使用：确认隐身模式的策略设置
        （“允许在隐身模式下运行”）。

如有失败，请提供：chrome://policy 的导出、chrome://extensions 中该扩展的错误信息、
Service Worker 控制台输出，以及控制台“支持”页面中的信息。
