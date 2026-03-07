# Architecture

Technical architecture of the VSCode Taskbar Separator extension.

## Overview

The system has two main components that work together:

```
┌─────────────────────────────────────────┐
│      VS Code Extension (TypeScript)     │
│  - extension.ts (activation, commands)  │
│  - utils.ts (badge generation, wrapper) │
│  - types.ts (interfaces)                │
└──────────────┬──────────────────────────┘
               │ spawns process
               ▼
┌─────────────────────────────────────────┐
│      C++ Wrapper (code.exe)             │
│  Mode 1: Launcher                       │
│    - Find real Code.exe                 │
│    - Create isolated user-data-dir      │
│    - Generate AUMID, launch with flags  │
│    - Apply AUMID via IPropertyStore     │
│  Mode 2: Runtime commands               │
│    - --set-overlay (ITaskbarList3)      │
│    - --remove-overlay                   │
└──────────────┬──────────────────────────┘
               │ Win32 API calls
               ▼
┌─────────────────────────────────────────┐
│      Windows APIs                       │
│  - ITaskbarList3::SetOverlayIcon()      │
│  - IPropertyStore (AUMID)               │
│  - SHGetPropertyStoreForWindow()        │
│  - DeviceIoControl (junctions)          │
│  - GDI+ (PNG → HICON)                   │
└─────────────────────────────────────────┘
```

## C++ Wrapper (`cpp/src/main.cpp`)

The wrapper binary (`code.exe`) serves two purposes:

### Launcher Mode (default)

When invoked without `--set-overlay`/`--remove-overlay`, acts as a transparent VS Code launcher.

The launcher first checks whether a real VS Code `Code.exe` process is already running (by enumerating processes with `CreateToolhelp32Snapshot` and comparing full executable paths to avoid matching the wrapper itself).

**No VS Code running → Passthrough:**
1. Finds real VS Code via registry or common paths
2. Launches `Code.exe` with all original arguments (no extra flags)
3. Exits immediately — the main instance keeps the default AUMID and full jump list

**VS Code already running → Isolated:**
1. Finds real VS Code via registry or common paths
2. Parses command-line args, extracts workspace path
3. Creates isolated `--user-data-dir`:
   - `%APPDATA%\VSCode-TaskbarSeparator\workspaces\<hash>\`
   - Junctions `User/` and `extensions/` to real `%APPDATA%\Code\` (shared settings/extensions)
   - Symlinks or copies `Local State` (Chromium encryption key)
   - All other dirs (Cache, logs, etc.) are fresh per-instance
4. Generates AUMID: `VSCode.Workspace.<hash>` (from workspace path) or `VSCode.Instance.<hash>` (from instance dir)
5. Launches real `Code.exe` with `--new-window --user-data-dir "..." --app-user-model-id="..."`
6. Applies AUMID to window via `SHGetPropertyStoreForWindow` + `IPropertyStore` as fallback
7. Sets `System.AppUserModel.RelaunchCommand` on the window to point to the wrapper, so the taskbar context menu’s "Visual Studio Code" entry routes new launches through the wrapper
8. Waits for VS Code to exit, then cleans up non-persistent instance directories

### Command Mode

When invoked with `--set-overlay <pid> <icon-path>` or `--remove-overlay <pid>`:
- Finds the `Chrome_WidgetWin_1` window for the given PID
- Uses `ITaskbarList3::SetOverlayIcon()` to apply/remove the badge
- Loads PNG/ICO via GDI+ → HICON conversion

### Install/Uninstall Mode

`--install` patches all VS Code launch points to route through the wrapper:
- **Start Menu shortcut** — modifies `.lnk` Target via `IShellLink` COM, preserves VS Code icon
- **Desktop shortcut** — same approach (skipped if not present)
- **"Open with Code" context menu** — patches `HKCU\Software\Classes\*\shell\VSCode\command` (and `Directory\`, `Directory\Background\` variants) by replacing the exe path in the registry value

`--uninstall` reverses all changes using `FindVSCodePath()` to locate the real `Code.exe`.

Output goes to console via `AttachConsole(ATTACH_PARENT_PROCESS)`, or falls back to `MessageBoxW` when launched without a terminal.

## VS Code Extension

### `extension.ts`

- **`activate()`**: Registers commands, initializes wrapper config, applies badge after 100ms startup delay
- **`applyCustomBadge()`**: Reads configuration, auto-generates color if needed (FNV-1a → 64-color palette), generates badge PNG via `sharp`, calls wrapper `--set-overlay`
- **`removeCustomBadge()`**: Calls wrapper `--remove-overlay`
- **`initializeWrapperConfig()`**: Writes `manager.json` to `%APPDATA%\VSCode-TaskbarSeparator\`
- Watches `onDidChangeConfiguration` and `onDidChangeWorkspaceFolders` to re-apply

### `utils.ts`

- **`generateDeterministicColor()`**: FNV-1a 32-bit hash of workspace `fsPath` → index into 64-entry golden-angle HSL palette (80% alpha)
- **`generateBadgeIcon()`**: SVG → PNG via `sharp`. Badge filename: `badge_<color>_<style>_<text>.png` (cached in `%TEMP%\vscode-taskbar-badges\`)
- **`applyBadgeToWindow()`** / **`removeBadgeFromWindow()`**: Spawn wrapper `--set-overlay` / `--remove-overlay`
- **`getActiveWindowHandle()`**: Returns `process.ppid` (main Electron PID)
- Three SVG generators: `generateCircleBadge`, `generateSquareBadge`, `generateRoundedSquareBadge`

### `types.ts`

```typescript
interface IconConfig {
    hwnd: string;           // PID as string
    badgeId: string;        // workspace-based hash for identification
    badgeColor: string;     // hex color (#RRGGBB or #RRGGBBAA)
    badgeStyle: 'circle' | 'square' | 'rounded-square';
    badgeText: string;      // optional label
    badgeIconPath: string;  // generated or custom badge file
    workspaceFolder?: string;
}
```

## Instance Isolation

The wrapper creates per-workspace directories with selective junctions:

```
%APPDATA%\VSCode-TaskbarSeparator\workspaces\<hash>\
├── User/           → junction → %APPDATA%\Code\User         (shared)
├── extensions/     → junction → %APPDATA%\Code\extensions   (shared)
├── Local State     → symlink  → %APPDATA%\Code\Local State  (shared)
├── Cache/          (fresh per-instance)
├── Code Cache/     (fresh per-instance)
├── logs/           (fresh per-instance)
├── Session Storage/(fresh per-instance)
└── ...
```

Junctions use `DeviceIoControl(FSCTL_SET_REPARSE_POINT)` — no admin required. The separate UserDataDir is required to force VSCode/Electron to separate the instances. Otherwise, Electron will merge multiple instances with different AUMIDs into one main process.

## Color Generation

64-color golden-angle palette with FNV-1a hashing:

1. Build palette: for each index `i`, hue = `(i × 137.508°) % 360`, varying saturation (65/75/85%) and lightness (45/55/65%)
2. Hash workspace `fsPath` with FNV-1a 32-bit
3. Index = `(hash >>> 0) % 64`
4. Result: `#RRGGBBCC` (80% alpha)

Golden-angle spacing ensures neighboring indices are visually distinct.
