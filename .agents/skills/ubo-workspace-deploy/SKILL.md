---
name: ubo-workspace-deploy
description: 使用部署者自己的 Google Workspace 和 Chrome Enterprise Core，为本仓库的 uBO Enterprise 构建签名 CRX、配置 HTTPS 更新托管、下发强制安装与扩展策略，并验收安装或升级。适用于首次部署、迁移和后续发布；不用于 Edge 云管理或普通商店安装。
---

# uBO Enterprise Workspace 部署

将这个仓库的非官方 MV3 企业版部署到用户自己的租户。交付可下载的签名扩展、更新清单、目标 OU 的安装策略和实际验收结果。按用户当前请求处理首次部署或升级，不把每次升级变成重新注册浏览器。

## 定位仓库与收集参数

本 skill 随仓库保存在 `.agents/skills/ubo-workspace-deploy/`。先定位包含 `tools/enterprise/crx3.mjs` 和 `platform/chromium-enterprise/manifest.json` 的本地仓库；所有下述路径相对仓库根目录。skill 被单独复制安装时，也需要完整仓库，不能仅凭 skill 构建扩展。

先读 `platform/chromium-enterprise/DEPLOYMENT.md`。需要理解兼容性、测试或脚本注入限制时，再读同目录的 `README.md` 和 `tools/enterprise/harness/README.md`。以实际 `dist/version`、构建脚本和线上版本为准，文档中的历史版本只是示例。

检查工作区和用户已提供的信息，只询问缺失且影响下一步的参数：

| 参数 | 说明 |
| --- | --- |
| Workspace 租户、管理账号、目标 OU | 核对控制台当前租户与目标设备所属 OU；根 OU 会扩大影响范围，不能默认选根 OU |
| 目标系统、Chrome 版本、浏览器注册状态 | 本流程针对桌面 Chrome；最低版本读取企业版 manifest |
| HTTPS 更新域名、部署路径、主机访问方式 | 用户自己的 DNS 和主机；可复用已有静态托管或反向代理 |
| 生产密钥和备份位置 | 位于仓库之外；升级必须沿用旧密钥 |
| 本次版本和代码基线 | 比已部署版本高，确认是否接受当前开发版基线 |
| 可选扩展策略或迁移来源 | 未要求覆盖用户过滤器时，不生成覆盖策略 |

不要把维护者的域名、SSH 别名、OU、扩展 ID、密钥路径或注册令牌当成用户的默认值。Google Workspace 登录本身不等于浏览器已注册到 Enterprise Core。已有租户应在其管理控制台启用 Core，不另建一个同域租户。

使用可用的管理连接器或浏览器工具操作控制台；没有可用工具时，提供准确的手动步骤并把该项标为待用户完成。不要虚构控制台保存或客户端验收成功。现有授权足够时继续执行；对尚未获授权的租户变更，先准备目标 OU、扩展 ID、更新 URL 和完整策略，再请求必要的授权。遇到登录、MFA 或管理员权限问题，交还用户完成该环节，同时继续独立的构建工作。

当前 Google 官方入口（执行时核对最新平台条件和界面）：

- [已有 Workspace 启用 Chrome Enterprise Core](https://support.google.com/chrome/a/answer/9301420)
- [注册受管理的浏览器，含 macOS / Windows / Linux](https://support.google.com/chrome/a/answer/9301891)
- [添加、允许或阻止扩展](https://support.google.com/chrome/a/answer/6177431)

注册令牌通过用户本机受限文件或管理工具传递，不写进 Git、日志、截图或发布清单。浏览器已属于另一租户时，先解决归属问题，不擅自清理设备令牌或原组织策略。

## 密钥、构建与版本

首次部署按 DEPLOYMENT 第 1 节生成 RSA 生产密钥，目录权限 700、文件权限 600。先确认目标文件不存在，避免覆盖已有密钥。把密钥备份到用户认可的安全位置，并核对备份能导出相同公钥；不要展示私钥。备份暂时无法完成时明确报告，不能把“已有一个本地副本”写成“已有离线备份”。

通过 `crx3.mjs id` 从密钥导出本组织的扩展 ID。升级时核对该 ID 与现有安装策略、线上更新清单一致，不重新生成密钥。

检查 `git status`、`dist/version` 和线上 `update.xml`。Chrome 按各段整数比较版本，重新发布必须递增，回滚也必须以更高版本重建旧代码。正式生产基线优先选择已验证的稳定版本；当前分支若为开发/候选版，说明其状态。不要直接切换到官方标签而丢失本分支的企业版适配。

复用仓库工具，不重新实现 CRX3 签名。下列变量由本次部署信息赋值，路径均需正确引用：

```bash
# 在仓库根目录运行；KEY_FILE、RELEASE_DIR、VERSION、UPDATE_URL、CRX_URL
# 均由用户的部署参数确定。RELEASE_DIR 位于仓库之外。
npm ci
export UBO_ENT_VERSION="$VERSION"
export UBO_ENT_UPDATE_URL="$UPDATE_URL"
UBO_ENT_PUBLIC_KEY=$(node tools/enterprise/crx3.mjs pubkey --key "$KEY_FILE")
export UBO_ENT_PUBLIC_KEY
bash tools/make-chromium-enterprise.sh

node tools/enterprise/crx3.mjs pack \
  --dir dist/build/uBlock0.chromium-enterprise \
  --key "$KEY_FILE" --out "$RELEASE_DIR/ubo-enterprise-$VERSION.crx"
node tools/enterprise/crx3.mjs verify \
  --crx "$RELEASE_DIR/ubo-enterprise-$VERSION.crx"
node tools/enterprise/update-xml.mjs \
  --id "$EXTENSION_ID" --version "$VERSION" \
  --codebase "$CRX_URL" --out "$RELEASE_DIR/update.xml"
```

先创建发布输出目录。构建后核对 manifest 的版本、公钥和 HTTPS `update_url`，签名校验返回的 ID 必须匹配。不要用 `make chromium-enterprise` 的时间戳缓存代替显式构建。检查 CRX 内的条目，不能混入私钥、VCS 文件或本机生成的 `_metadata`；合法 `_locales` 必须保留。

## HTTPS 托管和发布

先检查用户已有服务、DNS、证书和目录权限，复用可用配置。用户选择 Caddy 时，仅在需要时安装并增加目标虚拟主机，保留其他站点；配置校验成功再 reload。静态托管同样可用，不依赖某个 SSH 别名或云服务商。

Chrome 后台更新必须能匿名获取 HTTPS 清单和 CRX，不能依赖控制台登录、Cookie、Basic Auth 或会过期的下载链接。配置 `update.xml` 为 `application/xml` 和 `Cache-Control: no-cache`，CRX 为 `application/x-chrome-extension`。

先上传 CRX，核对服务器端哈希和公开下载可用性，再备份旧清单并原子替换 `update.xml`。保留旧 CRX。CDN 存在时检查实际缓存头和公开地址返回值，必要时刷新该路径缓存。从公网重新下载清单和 CRX，比较本地文件哈希并再次验证签名。任一步失败时停止发布后续步骤，报告已完成的状态，不不断重试或让清单指向未就绪文件。

## 租户策略与注册

浏览器未注册时，按 Google 当前官方文档用该租户的注册令牌注册，重启 Chrome 后在管理控制台核对设备及 OU，并检查 `chrome://management`。仅登录 Workspace 用户配置文件不等于机器级注册。

在管理控制台“Chrome 浏览器 → 应用和扩展程序 → 用户和浏览器”中选择目标 OU，按本组织的扩展 ID 添加，来源选择自定义网址，填写 `update.xml` 的 HTTPS 地址。安装政策使用真正的“强制安装”或“强制安装并固定”。不要选择“强制安装，但允许用户停用”：本项目实测该模式不能提供所需的阻塞权限。

配置效果应对应：

```json
{
  "ExtensionSettings": {
    "<本组织扩展ID>": {
      "installation_mode": "force_installed",
      "update_url": "https://<用户更新域名>/<发布路径>/update.xml",
      "override_update_url": true
    }
  }
}
```

这是浏览器策略示例，不是粘贴到“扩展程序政策”的内容。界面未提供 `override_update_url` 时依赖构建 manifest 中正确的 `update_url`。

可选的“扩展程序政策”对应 `storage.managed`：查看 `platform/common/managed_storage.json`，按 DEPLOYMENT 第 6 节对每个顶层键的值加 `{"Value": …}` 包装。本地平台策略不加这一层。明确告知 `toOverwrite.filters` / `filterLists` 会覆盖用户内容，先备份再迁移；“No policies set” 只说明没有扩展自身配置，不能据此判断浏览器级强制安装失效。

若客户端显示策略冲突，检查展开后的实际生效值、来源和被覆盖值，不仅看云控制台。Platform/Machine 的强制安装可能覆盖云端阻止；不要为解决一条扩展配置而删除全部本地策略或其他组织管理设置。

## 验收、升级与交付

逐项执行 DEPLOYMENT 第 8 节的 12 项验收，用“通过 / 失败 / 待验证”记录设备、版本和证据。没有目标设备、需日常观察或用户未启用隐身时，如实保留待验证。Linux 容器结果不能冒充 Workspace 下发到 Mac 的实测。

重点验证策略来源正确、扩展由组织安装、版本与 ID 正确、真实广告请求被阻止。`chrome.webRequest.onBeforeRequest.hasListeners()` 返回 true 只能证明存在监听器，仍需实际阻断请求的证据。覆盖 Worker 休眠唤醒、浏览器冷启动、过滤列表更新和升级后设置保留。

需要查看强制安装扩展的 Worker 时，仅为授权调试范围配置 `DeveloperToolsAvailability=1`，在 `chrome://policy` 确认生效。用户允许调试不等于允许改动整个租户的调试政策，调试结束后的恢复方式也应与用户意图一致。

升级沿用密钥、ID 和更新地址，发布更高版本。客户端可在 `chrome://extensions` 开启开发者模式并点击“更新”；本扩展通常在完全退出并重开 Chrome 后应用升级，先让用户保存工作，不擅自关闭其浏览器。

出现 `_metadata` 保留名称警告时，分别检查原始 CRX 与本机安装目录。Chrome 会在安装目录生成 `_metadata/computed_hashes.json`；确认包内无该目录后，不把这个警告误判成打包污染，也不通过删除完整性文件或卸载来“修复”。继续核对启用状态与实际过滤。

交付包含：代码提交、版本、扩展 ID、HTTPS 清单与 CRX 地址、目标租户/OU、密钥和备份位置（不含内容）、实际测试结果及待验收项。新增的部署记录不得包含注册令牌或私钥；没有执行过的浏览器升级不能声称已完成。
