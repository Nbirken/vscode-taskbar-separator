# Development Guide

## Prerequisites

- Node.js 16+ and npm
- VS Code 1.85+
- MSVC 2022 (C++ build tools)
- CMake 3.10+
- Windows 10+

## Project Structure

```
vscode-taskbar-separator/
├── src/
│   ├── extension.ts       # Extension entry point, commands, config
│   ├── utils.ts           # Badge generation, wrapper invocation, color palette
│   └── types.ts           # IconConfig interface
├── cpp/
│   ├── src/main.cpp       # C++ wrapper (launcher + overlay commands)
│   └── CMakeLists.txt     # CMake build config
├── out/                   # Compiled JS (generated)
├── package.json           # Extension manifest
├── tsconfig.json          # TypeScript config
├── .eslintrc.json         # Linting
├── README.md              # User documentation
├── ARCHITECTURE.md        # Technical architecture
├── CHANGELOG.md           # Version history
└── LICENSE
```

## Building

### Extension (TypeScript)

```bash
npm install
npm run compile       # one-time
npm run watch         # auto-recompile on changes
```

### C++ Wrapper

```bash
cd cpp
cmake -B build -G "Visual Studio 17 2022"
cmake --build build --config Release
# Output: cpp/build/Release/code.exe
```

## Running / Debugging

### Via Launch Configurations

Two launch configs in `.vscode/launch.json`:

1. **"Launch via Wrapper"** — runs `cpp/build/Release/code.exe` to test wrappered launch
2. **"Debug Extension (separated)"** — runs the ExtensionHost for debugging the extension itself

Press F5 with the desired config selected.

### Manual Testing

1. Build the extension: `npm run compile`
2. Build the wrapper: `cmake --build cpp/build --config Release`
3. Run wrapper: `cpp\build\Release\code.exe d:\some\workspace`
4. Check the "Taskbar Separator" output channel in the launched VS Code

## Key Implementation Notes

### Badge Generation

- SVG created in TypeScript → converted to PNG via `sharp`
- Badge files cached in `%TEMP%\vscode-taskbar-badges\` with param-based filenames (`badge_<color>_<style>_<text>.png`)
- Three styles: circle, square, rounded-square

### Color Palette

- 64 colors via golden-angle (137.508°) hue stepping with varied saturation/lightness
- FNV-1a 32-bit hash of workspace `fsPath` → palette index
- All colors have 80% alpha (`CC` suffix)

### Wrapper Architecture

- **Launcher mode** (default): finds real `Code.exe`, creates isolated `--user-data-dir`, generates AUMID, launches with `--app-user-model-id`
- **Command mode**: `--set-overlay <pid> <icon>` and `--remove-overlay <pid>` for badge overlay via `ITaskbarList3`

### Instance Isolation

- Per-workspace dir under `%APPDATA%\VSCode-TaskbarSeparator\workspaces\<hash>\`
- Junctions share `User/` and `extensions/` from `%APPDATA%\Code\`
- `Local State` (encryption key) shared via symlink or copy
- All other dirs (Cache, logs, etc.) are fresh per-instance
