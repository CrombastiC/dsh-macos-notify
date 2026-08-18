# dsh-macos-notify

Native macOS notifications for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), with event-specific sounds, notification filtering, multi-task coalescing, and a first-level settings page in the DSH Web UI.

## Features

- Notification Center alerts when a turn completes, fails, is blocked, or waits for approval.
- Separate sounds for completed, error, aborted, and approval events; any event can be muted.
- System sound picker plus managed custom sound import and deletion from the Web settings page.
- Custom imports are converted to AIFF, limited to 5 MB and 10 seconds, capped at 20 managed files / 50 MB total, and stored in `~/Library/Sounds`.
- A 1.5-second coalescing window and optional digest mode prevent parallel tasks from flooding Notification Center.
- Recent notification diagnostics explain whether an event was sent, queued, suppressed, or failed.
- A six-event test matrix validates completed, error, approval, aborted, coalesced, and digest notifications.
- Daily quiet hours and temporary 30-minute, 1-hour, or 24-hour pauses.
- Duplicate error suppression with a configurable cooldown window.
- Project path rules for muting, error-only alerts, or important-project bypasses.
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

Install the published npm package:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add dsh-macos-notify
npx -y @deepseek-ai/dsh web
```

Alternatively, install the latest source directly from GitHub:

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:CrombastiC/dsh-macos-notify
```

Then open **Settings → macOS notifications** from the first-level settings navigation.

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
| `quietHoursEnabled` | `false` | Enable the daily local-time quiet period. |
| `quietStart` | `23:00` | Quiet-period start in local `HH:mm` time. |
| `quietEnd` | `08:00` | Quiet-period end in local `HH:mm` time. Overnight ranges are supported. |
| `quietAllowCritical` | `true` | Continue sending error, blocked, and approval alerts during quiet hours. |
| `pauseUntil` | `0` | Temporary pause deadline as Unix milliseconds; managed by quick actions in the Web card. |
| `duplicateWindowSec` | `300` | Suppress identical errors from the same session within this window; `0` disables it. |
| `projectRulesJson` | `[]` | Project rules managed by the Web card. More-specific descendant paths win. |

### Project rule modes

- `mute` — suppress every notification under the configured project path.
- `errors` — allow only errors, blocked events, and approval requests.
- `important` — bypass minimum-duration, focus, idle, quiet-hour, and temporary-pause filters.

The settings page keeps the last 50 decisions in process memory. Each row records whether an event was sent, queued, suppressed, or failed and includes the reason. This history resets when DSH restarts and does not contain message content.

## Notification channels

`auto` uses OSC 9 when the terminal is recognized as supporting it, and falls back to `osascript` otherwise.

Recognized OSC 9 terminals include iTerm2, WezTerm, Kitty, Ghostty, and Warp. tmux sessions are wrapped in DCS passthrough automatically.

Sound selection applies to the `osascript` channel. With OSC 9, the terminal controls whether and how a notification sound is played.

## Custom sounds

In the settings page, select **Edit → Import sound**. Supported inputs include AAC, AIFF, CAF, FLAC, M4A, MP3, OGG, Opus, and WAV.

The host validates the extension, decoded size, converted duration, managed-file count, and total managed size before writing anything to the user sound directory. Imports are converted to 44.1 kHz mono AIFF using macOS `afconvert`, with `ffmpeg` as a fallback for formats that `afconvert` cannot decode. Existing files are never overwritten; a numeric suffix is added instead.

New imports are recorded in `~/Library/Application Support/dsh-macos-notify/sounds.json` and can be deleted from the settings page. If a sound is currently selected, deletion asks for confirmation and changes affected events to silent. Files remain in `~/Library/Sounds` if the plugin is removed without deleting them first.

## Known limitations

- The plugin is macOS-only. Native notifications use `osascript`, and custom import uses macOS audio tooling.
- OSC 9 sound behavior belongs to the terminal and ignores the per-event sound selection.
- The Web settings page uses the trusted `/macos-notify` RPC channel because the current DSH Web settings proxy has a namespace allowlist for built-in settings.
- Only sounds imported by v0.2.0 or later are tracked as managed sounds. Earlier manually copied/imported files can still be selected, but must be removed from `~/Library/Sounds` manually.

## Development

The package is intentionally build-free:

- `index.js` — host plugin, event handling, notification delivery, settings RPC, and sound import.
- `client.js` — hand-written DSH client module for focus reporting and the first-level Web settings page.
- `cordis.patch.yml` — profile bundle patch.

Run the release checks:

```bash
node --check index.js
node --check client.js
npm test
npm pack --dry-run
```

## 中文说明

这是一个仅支持 macOS 的 DeepSeek Harness 通知插件。它可以在任务完成、出错、等待审批时发送系统通知，并支持通知诊断、测试矩阵、每日勿扰、临时暂停、自定义声音管理、重复错误抑制、项目规则、焦点抑制、合并通知和定时汇总。推荐从 npm 安装，也可以直接从 GitHub 安装最新版源码。

## License

[MIT](LICENSE) © 2026 CrombastiC
