# VSCode Taskbar Separator

A VS Code extension + native C++ wrapper that gives every VS Code instance its own **separate taskbar button** with a **colored badge overlay** — similar to how TortoiseGit marks Explorer windows.

Each workspace launched through the wrapper gets a unique Windows `AppUserModelId` (AUMID) and an isolated user-data directory, so Windows treats them as independent applications on the taskbar.

## Features

- **Colored Badge Overlays** — each workspace gets a deterministic color from a 64-color palette, or you can pick your own
- **Badge Styles** — circle, square, or rounded-square
- **Badge Text** — optional short label (e.g. `P` for production, `D` for dev)
- **Per-Workspace Settings** — configure `badgeColor`, `badgeText`, `badgeStyle` at the workspace or folder level
- **Instance Isolation** — the C++ wrapper creates a separate `--user-data-dir` with junctions so settings and extensions stay shared
- **Automatic AUMID** — each workspace hash gets `VSCode.Workspace.<hash>`, producing a separate taskbar button
- **Auto-apply on Startup** — badge is applied within 100 ms of activation

## How It Works

1. You place the compiled **C++ wrapper** (`code.exe`) in your PATH *instead of* the real VS Code `Code.exe`
2. The wrapper checks whether a real VS Code process is already running:
   - **No VS Code running** → launches VS Code directly (passthrough), preserving the default AUMID and full jump list (Recent, Tasks)
   - **VS Code already running** → launches an isolated instance with `--user-data-dir`, `--new-window`, and a workspace-specific `--app-user-model-id`
3. The **VS Code extension** activates in every instance, generates a colored badge PNG (via `sharp`), and calls the wrapper's `--set-overlay` command to apply the badge via `ITaskbarList3`

This means the **first window** you open behaves exactly like stock VS Code — full jump list, recent files, pinned tasks. Every **additional window** launched through the wrapper gets its own taskbar button with a colored badge.

When you open a folder from the terminal, Start Menu, or "Open with Code" context menu, the wrapper intercepts the call, detects a running VS Code, and applies isolation automatically.

```
| First launch (no Code.exe running) | Subsequent launches   |
| ---------------------------------- | --------------------- |
| Passthrough                        | Isolated launch       |
| No --user-data-dir                 | --user-data-dir       |
| No custom AUMID                    | --app-user-model-id   |
| Full jump list                     | Separate button       |
```

## Setup

### Prerequisites

- **Windows 10** or later
- **VS Code 1.85** or later
- **Node.js 16+** and npm (for building the extension)
- **MSVC 2022** and **CMake 3.10+** (for building the C++ wrapper)

### Building

```bash
# Build the extension
npm install
npm run compile

# Build the C++ wrapper
cd cpp
cmake -B build -G "Visual Studio 17 2022"
cmake --build build --config Release
# Output: cpp/build/Release/code.exe
```

### Installing the Wrapper

**Step 1 — PATH (for terminal `code` commands):**

1. Create a directory (e.g. `C:\tools\vscode-wrapper\`)
2. Copy `cpp/build/Release/code.exe` into it
3. Add that directory to your PATH **before** VS Code's directory

**Step 2 — Deep integration (for Start Menu, Desktop, "Open with Code"):**

```bash
# From the directory containing the wrapper:
code.exe --install
```

This patches VS Code's Start Menu shortcut, Desktop shortcut (if present), and the "Open with Code" right-click context menu entries to route through the wrapper. The original VS Code icon is preserved.

To reverse all changes:

```bash
code.exe --uninstall
```

> **Tip:** If VS Code is pinned to the taskbar, unpin and re-pin it after `--install` so the pin picks up the new shortcut target.

Both commands work from a terminal (output to console) or by double-clicking (MessageBox feedback).

When you run `code .` from a terminal, click VS Code in the Start Menu, or use "Open with Code" in Explorer, the wrapper intercepts the call, finds the real VS Code via the registry, and decides whether to pass through or isolate based on whether VS Code is already running.

> **Transparency**: The wrapper is designed to be fully transparent. It passes all arguments through to the real `Code.exe`. Isolation flags (`--user-data-dir`, `--new-window`, `--app-user-model-id`) are only added for secondary instances.

### What the Wrapper Does

- Creates a per-workspace directory under `%APPDATA%\VSCode-TaskbarSeparator\workspaces\<hash>\`
- Junctions `User/` → `%APPDATA%\Code\User` (shared settings, keybindings, snippets)
- Junctions `extensions/` → `%APPDATA%\Code\extensions` (shared extensions)
- Symlinks or copies `Local State` (Chromium encryption key)
- All other directories (Cache, logs, Session Storage, etc.) are fresh per-instance
- Cleans up non-persistent instance directories after VS Code exits

### Side Effects

- Secondary instances have their own recent files and session state (not shared with the main instance)
- The first instance retains the default AUMID with full jump list support
- The wrapper's passthrough path does not wait for VS Code — it exits immediately
- The wrapper's isolated path waits for VS Code to exit before cleaning up the instance directory

## Configuration

Configure per-workspace in `.vscode/settings.json` or VS Code settings UI.

### Settings

| Setting | Type | Default | Scope | Description |
|---------|------|---------|-------|-------------|
| `taskbarSeparator.badgeColor` | string | `""` (auto) | resource | Badge color in `#RRGGBB` or `#RRGGBBAA`. Empty = auto-generated from workspace path |
| `taskbarSeparator.badgeStyle` | string | `"circle"` | window | Badge shape: `circle`, `square`, `rounded-square` |
| `taskbarSeparator.badgeText` | string | `""` | resource | Optional text on badge (single character recommended) |
| `taskbarSeparator.badgeBadgeIconPath` | string | `""` | resource | Path to custom badge `.ico` file. Empty = generated badge |

**Scope notes:**
- `resource` settings can be set per-folder in a multi-root workspace
- `window` settings apply to the entire VS Code window

### Auto-Generated Colors

When `badgeColor` is empty (the default), the extension generates a deterministic color from the workspace path using FNV-1a hashing into a 64-color golden-angle palette. This means:
- The same workspace always gets the same color
- Different workspaces almost always get visibly distinct colors
- Colors include 80% alpha for a subtle overlay effect

### Example Configurations

**Minimal — auto color:**
```json
{}
```
No configuration needed. The extension auto-generates a deterministic color.

**Custom color and label:**
```json
{
  "taskbarSeparator.badgeColor": "#FF0000",
  "taskbarSeparator.badgeStyle": "circle",
  "taskbarSeparator.badgeText": "P"
}
```

**Rounded square with text:**
```json
{
  "taskbarSeparator.badgeColor": "#3178C6",
  "taskbarSeparator.badgeStyle": "rounded-square",
  "taskbarSeparator.badgeText": "TS"
}
```

## Commands

| Command | Title |
|---------|-------|
| `taskbarSeparator.applyBadge` | Apply Taskbar Badge |
| `taskbarSeparator.removeBadge` | Remove Taskbar Badge |
| `taskbarSeparator.showSettings` | Open Taskbar Separator Settings |

Access via Command Palette (Ctrl+Shift+P).

## Troubleshooting

### Badge Not Appearing

1. Check the **"Taskbar Separator"** output channel (View → Output → select "Taskbar Separator") for error messages
2. Ensure the C++ wrapper `code.exe` is found — it should be in `bin/`, `%APPDATA%\VSCode-TaskbarSeparator\`, or `cpp/build/Release/`
3. Verify the extension is active: Command Palette → "Apply Taskbar Badge"

### Separate Buttons Not Appearing

1. Ensure you launched VS Code through the wrapper, not directly

### Custom Icon Not Loading

1. Verify the `.ico` file path exists and is readable
2. Use an absolute path or workspace-relative path

## Known Limitations

- **Windows only** — relies on Win32 APIs (`ITaskbarList3`, `IPropertyStore`, junctions)
- **"New Window" not separated** — VS Code's built-in "New Window" command spawns a process directly from its own binary, bypassing the wrapper. These windows stack with the main instance. Use the wrapper (terminal `code`, Start Menu, or context menu) to open separate instances.
- **Jump list on secondary instances** — secondary (isolated) instances have their own AUMID, so their taskbar context menu won't show the main instance's recent files. The first instance has full jump list support.
- **Startup delay** — badge generation via `sharp` adds a brief delay (~100ms)

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

MIT - See [LICENSE](LICENSE) file for details

## Acknowledgments

- Inspired by **TortoiseGit** taskbar icon separation
- Uses [Sharp](https://github.com/lovell/sharp) for image processing

## Support

If you encounter issues:

1. Check the [troubleshooting](#troubleshooting) section
2. Open an issue on the [GitHub repository](https://github.com/username/vscode-taskbar-separator/issues)
3. Include your OS version, PowerShell version, and the output from the "Taskbar Separator" output channel
