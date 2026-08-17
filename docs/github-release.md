# GitHub 发布准备（仅 GitHub，npm 暂缓）

目标：把 `dsh-macos-notify` 推到 GitHub 公开仓库，并挂上 `dsh-plugin` topic，让社区插件列表（github.com/topics/dsh-plugin）能发现它。

## 1. 发布前检查清单

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| `package.json` name/version/description | ✅ | `dsh-macos-notify@0.1.0` |
| `keywords` 含 `dsh-plugin` | ✅ | npm 侧发现能力（GitHub 侧靠 topic，见第 3 步） |
| `license: MIT` 字段 | ✅ | 但还缺 LICENSE 文件，见下 |
| `files` 白名单 | ✅ | `index.js` / `client.js` / `cordis.patch.yml` |
| `exports["./package.json"]` | ✅ | dsh client 扫描器需要，别删 |
| LICENSE 文件 | ✅ | MIT，`Copyright (c) 2026 CrombastiC` |
| README.md | ✅ | 英文主文档 + 中文简介，含 GitHub 安装、配置表、限制与截图 |
| GitHub 包元数据 | ✅ | repository / homepage / bugs / author / Node 与 macOS 约束 |
| 设置页截图 | ✅ | `docs/assets/settings-card.jpg` |
| 通知横幅截图 | ⚠️ 待补 | 需要单独截取 macOS 通知横幅，避免整屏截图泄露桌面内容 |
| 未提交改动 | ⚠️ | 发布准备改动尚未 commit，需用户明确确认后提交 |

## 2. README.md 大纲

按这个结构写（英文为主，社区惯例；可附中文段）：

1. 标题 + 一句话简介：macOS 原生通知（通知中心横幅 + 提示音），覆盖 turn 结束 / 审批等待 / 出错限流。
2. 功能列表：
   - 分事件提示音（completed / error / aborted / approval，可留空静音）
   - 1.5s 合并窗口 + digest 汇总，多任务并行不刷屏
   - minDurationSec 门限，秒回的任务不打扰
   - 焦点抑制（web 标签页聚焦时不弹）+ HIDIdleTime 空闲判断
   - 429 / 限流专属文案
   - OSC 9 终端通知通道（iTerm2 / WezTerm / Kitty / Ghostty / Warp，tmux 自动 DCS 包裹）
   - 设置 → 插件 → 插件配置里的「macOS 通知」卡片，实时保存
3. 安装（首发仅 GitHub）：
   ```bash
   npx -y @deepseek-ai/dsh plugin --profile web add github:CrombastiC/dsh-macos-notify
   ```
   dsh CLI 会把 `github:` spec 原样转交给 pnpm；源码中也有 Git 托管包的安装错误提示分支。
4. 配置表：列出 `macos-notify.*` 所有配置项、默认值、含义（sounds.* / minDurationSec / channel / focusSuppression 等）。
5. 已知限制：
   - 仅 macOS（osascript / afplay / OSC 9）
   - 设置读写走自有 RPC 通道 `/macos-notify`（官方 web 设置命名空间有白名单）
   - 开发模式安装必须用 `plugin add <本地路径>`（pnpm link），cordis.dev.yml 绝对路径 overlay 不可靠
6. 截图：设置卡片已补；通知横幅仍需发布前单独补拍。

## 3. 建仓库 + 推送（需用户确认后执行）

```bash
cd /Users/ar1se/Desktop/dsh-macos-notify

# 提交剩余改动
git add -A && git commit -m "chore: prepare for release"

# 建远程仓库并推送（gh 已登录 CrombastiC）
gh repo create CrombastiC/dsh-macos-notify --public --source . --push

# 挂 topic（社区插件列表靠这个聚合）
gh repo edit CrombastiC/dsh-macos-notify --add-topic dsh-plugin --add-topic deepseek-harness --add-topic macos
```

## 4. 打 Release

```bash
git tag v0.1.0
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file docs/release-notes-v0.1.0.md
```

## 5. 发布后验证

- github.com/topics/dsh-plugin 列表里能搜到（topic 聚合有几分钟延迟）
- 另一台机器/干净 profile 下 `plugin add github:CrombastiC/dsh-macos-notify` 能装上

## 明确不做（本轮范围外）

- npm 发布（`npm publish`）——暂缓，之前讨论过先记住这件事
- 点击通知跳转（terminal-notifier + `?session=` 深链）——未拍板
- opencode 启发中的自定义音频文件已完成；声音解耦 / 子 agent 模式继续作为后续方向，不阻塞首发
