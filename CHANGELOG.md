# Changelog

All notable changes to the VSCode Taskbar Separator extension will be documented in this file.

## [0.1.0] - 2024-01-XX

### Added
- C++ native wrapper for instance isolation and overlay commands
- Automatic per-workspace `AppUserModelId` generation (separate taskbar buttons)
- Isolated `--user-data-dir` with junctions (shared settings/extensions, per-instance cache)
- Colored badge overlays via `ITaskbarList3::SetOverlayIcon()`
- 64-color golden-angle palette with FNV-1a deterministic color assignment
- Badge styles: circle, square, rounded-square
- Optional badge text (single character recommended)
- Custom badge icon support (.ico files)
- Per-workspace configuration via VS Code settings (resource/window scopes)
- Auto-apply on startup (100ms delay)
- Configuration change detection and re-application
- `sharp` library for SVG → PNG badge generation
- Output channel for debugging

### Technical Details
- C++ wrapper uses Win32 APIs: `IPropertyStore` (AUMID), `ITaskbarList3` (overlay), `DeviceIoControl` (junctions), GDI+ (PNG → HICON)
- FNV-1a 32-bit hash of workspace `fsPath` for color palette indexing
- Badge files cached with param-based filenames: `badge_<color>_<style>_<text>.png`
- Wrapper finds real VS Code via registry or common install paths

### Known Limitations
- Windows only (Windows 10 and later)
- Recent files / tasks in taskbar context menu are per-instance (not shared)