# Claude Code Statusline

A minimal VS Code extension that shows your **Claude Code session usage** and **peak hours** directly in the status bar.

![Status Bar Example](https://img.shields.io/badge/5h_|_47%_████░░░░-teal?style=flat-square) ![Off-Peak](https://img.shields.io/badge/✓_Off--Peak-green?style=flat-square)

## What it shows

| Item | When visible | Example |
|------|-------------|---------|
| **5h session usage** | Always (when logged in) | `5h \| 47% ████░░░░ ⟳2h 05m (17:35)` |
| **7d weekly usage** | Only when >= 50% | `7d \| 62% █████░░░` |
| **Peak / Off-Peak** | Always | `✓ Off-Peak` or `🔥 Peak — 2h 05m left` |

- Usage percentage comes from Anthropic's OAuth API (same token Claude Code already uses)
- Peak hours schedule is fetched from [Nadav-Fux/claude-2x-statusline](https://github.com/Nadav-Fux/claude-2x-statusline)
- Auto-refreshes every 30 seconds (configurable)
- 24H time format

## Install

### Quick install (copy-paste for Claude)

> Install the Claude Code Statusline VS Code extension from source:
>
> ```
> git clone https://github.com/arielmoatti/claude-code-vsc-statusline.git
> cd claude-code-vsc-statusline
> npm install
> npm run compile
> npx @vscode/vsce package
> code --install-extension claude-code-vsc-statusline-0.1.0.vsix
> ```

### Manual

1. Clone this repo
2. `npm install && npm run compile`
3. `npx @vscode/vsce package`
4. In VS Code: Extensions > `...` > Install from VSIX > select the `.vsix` file

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeStatusline.refreshInterval` | `30` | Refresh interval in seconds |
| `claudeStatusline.showRateLimits` | `true` | Show 5h / 7d usage bars |
| `claudeStatusline.showPeakHours` | `true` | Show peak/off-peak indicator |

## Requirements

- **Claude Code** must be installed and logged in (the extension reads the existing OAuth token)
- No additional API keys needed

## Credits

Based on [claude-2x-statusline](https://github.com/Nadav-Fux/claude-2x-statusline) by [Nadav Fux](https://github.com/Nadav-Fux). Stripped down and restyled for a cleaner status bar experience.

## License

AGPL-3.0 (same as the original)
