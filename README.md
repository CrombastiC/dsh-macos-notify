# dsh-macos-notify

Native macOS notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with event-specific sounds, notification filtering, multi-task coalescing, and a settings card in the DSH Web UI.

![macOS notification sound settings](https://raw.githubusercontent.com/CrombastiC/dsh-macos-notify/main/docs/assets/settings-card.jpg)

## Features

- Notification Center alerts when a turn completes, fails, is blocked, or waits for approval.
- Separate sounds for completed, error, aborted, and approval events; any event can be muted.
- System sound picker plus custom sound import from the Web settings card.
- Custom imports are converted to AIFF, limited to 5 MB and 10 seconds, and stored in `~/Library/Sounds`.
- A 1.5-second coalescing window and optional digest mode prevent parallel tasks from flooding Notification Center.
- Minimum turn-duration filtering avoids notifications for near-instant replies.
- Optional Web-tab focus suppression and macOS HID idle-time gating.
- Dedicated wording for API rate limits, including provider retry timing when available.
- OSC 9 notifications for supported terminals, including tmux DCS passthrough.
- Live settings updates without restarting DSH.

## Requirements

- macOS
- Node.js 22 or newer
- DeepSeek Harness with the `web` profile

## Install

The first release is distributed from GitHub. npm publication is intentionally deferred.

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:CrombastiC/dsh-macos-notify
npx -y @deepseek-ai/dsh web
```

Then open **Settings → Plugins → Plugin configuration → macOS notifications**.

To remove the plugin:

```bash
npx -y @deepseek-ai/dsh plugin --profile web remove dsh-macos-notify
```

### Local development install

From this repository checkout:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add .
npx -y @deepseek-ai/dsh web
```

`dsh plugin` anchors relative paths to the invoking directory and forwards the install to pnpm in the selected profile. Avoid absolute-path bundle overlays in `cordis.dev.yml`; install the local package through `plugin add` instead.

## Configuration

The settings namespace is `macos-notify`. Values changed from the Web card apply live.

| Option | Default | Description |
| --- | --- | --- |
| `onCompleted` | `true` | Notify when a turn completes normally. |
| `onError` | `true` | Notify for errors and blocked turns. These alerts bypass completion gates and digesting. |
| `onAborted` | `false` | Notify when a user aborts a turn. |
| `onApproval` | `true` | Notify immediately when a tool waits for approval. |
| `minDurationSec` | `30` | Suppress completed-turn notifications shorter than this many seconds; `0` disables the threshold. |
| `onlyWhenIdleSec` | `0` | Require this many seconds of keyboard/mouse idle time for completed notifications; `0` disables idle gating. |
| `onlyWhenUnfocused` | `true` | Suppress completed notifications while any DSH Web tab is focused. |
| `digestMinutes` | `0` | Collect completed notifications into a periodic digest; `0` sends them immediately. |
| `includeSubagents` | `false` | Include subagent sessions instead of notifying only for top-level sessions. |
| `channel` | `auto` | `auto`, `osascript`, or `osc9`. |
| `sounds.completed` | `Glass` | Sound for completed turns. |
| `sounds.error` | `Basso` | Sound for errors, blocked turns, and rate limits. |
| `sounds.aborted` | empty | Sound for aborted turns; empty means silent. |
| `sounds.approval` | `Ping` | Sound for approval requests. |
| `coalesceMs` | `1500` | Window for merging simultaneous turn results; `0` disables merging. |
| `notifyOnLoad` | `true` | Send a test notification when the plugin loads. |

## Notification channels

`auto` uses OSC 9 when the terminal is recognized as supporting it, and falls back to `osascript` otherwise.

Recognized OSC 9 terminals include iTerm2, WezTerm, Kitty, Ghostty, and Warp. tmux sessions are wrapped in DCS passthrough automatically.

Sound selection applies to the `osascript` channel. With OSC 9, the terminal controls whether and how a notification sound is played.

## Custom sounds

In the settings card, select **Edit → Import sound**. Supported inputs include AAC, AIFF, CAF, FLAC, M4A, MP3, OGG, Opus, and WAV.

The host validates the extension, decoded size, and converted duration before writing anything to the user sound directory. Imports are converted to 44.1 kHz mono AIFF using macOS `afconvert`, with `ffmpeg` as a fallback for formats that `afconvert` cannot decode. Existing files are never overwritten; a numeric suffix is added instead.

Imported files remain in `~/Library/Sounds` if the plugin is removed. They can be deleted manually from that directory.

## Known limitations

- The plugin is macOS-only. Native notifications use `osascript`, and custom import uses macOS audio tooling.
- OSC 9 sound behavior belongs to the terminal and ignores the per-event sound selection.
- The Web settings card uses the trusted `/macos-notify` RPC channel because the current DSH Web settings proxy has a namespace allowlist for built-in settings.
- The card imports custom sounds but does not delete them; remove unwanted files from `~/Library/Sounds` manually.

## Development

The package is intentionally build-free:

- `index.js` — host plugin, event handling, notification delivery, settings RPC, and sound import.
- `client.js` — hand-written DSH client module for focus reporting and the Web settings card.
- `cordis.patch.yml` — profile bundle patch.

Run the release checks:

```bash
node --check index.js
node --check client.js
npm pack --dry-run
```

## 中文说明

这是一个仅支持 macOS 的 DeepSeek Harness 通知插件。它可以在任务完成、出错、等待审批时发送系统通知，并支持系统提示音、自定义声音导入、焦点抑制、空闲判断、合并通知和定时汇总。首个版本暂时通过 GitHub 安装，不发布到 npm。

## License

[MIT](LICENSE) © 2026 CrombastiC
