The first public release of `dsh-macos-notify`, a native macOS notification plugin for DeepSeek Harness.

## Highlights

- Native notifications for completed, errored, blocked, aborted, and approval-waiting turns.
- Event-specific sounds with silent-event support.
- System sound discovery and custom sound import from the DSH Web settings card.
- Custom audio validation, AIFF conversion, 5 MB size limit, and 10-second duration limit.
- Completion filtering by minimum duration, focused Web tabs, and keyboard/mouse idle time.
- Multi-task coalescing and optional digest notifications.
- Dedicated rate-limit notifications with provider retry timing.
- OSC 9 support for iTerm2, WezTerm, Kitty, Ghostty, and Warp, including tmux passthrough.

## Install

```bash
npx -y @deepseek-ai/dsh plugin --profile web add github:CrombastiC/dsh-macos-notify
npx -y @deepseek-ai/dsh web
```

Open **Settings → Plugins → Plugin configuration → macOS notifications** to configure event sounds.

## Notes

- macOS only.
- npm publication is intentionally deferred; this release installs directly from GitHub.
- OSC 9 notification sounds are controlled by the terminal rather than the plugin's per-event sound selection.
