# VSCode Taskbar Separator - C++ Wrapper

Native Windows wrapper executable that launches VSCode with workspace-specific AppUserModelIDs (AUMID) to enable separate taskbar entries.

## Building

### Prerequisites
- Visual Studio 2019+ or Visual Studio Build Tools
- CMake 3.10+
- Windows 10 or later

### Build Instructions

#### Option 1: Using CMake (Recommended)
```powershell
cd cpp
mkdir build
cd build
cmake .. -G "Visual Studio 17 2022"
cmake --build . --config Release
```

Output: `cpp\build\Release\code.exe`

#### Option 2: Using Visual Studio
Open `cpp\CMakeLists.txt` directly with Visual Studio and build using the IDE.

## How It Works

1. Wrapper is placed early in system PATH (via extension installation)
2. When user runs `code folder`, they're actually calling this wrapper
3. Wrapper:
   - Locates real VSCode installation from registry
   - Spawns VSCode.exe with all original arguments
   - Waits for VSCode window to appear
   - Applies unique AUMID via COM (ITaskbarList3::SetAppID)
   - Exits while VSCode continues running

## Proof of Concept Status

Current implementation:
- ✅ Finds VSCode from registry
- ✅ Spawns VSCode process with inherited arguments
- ✅ Detects VSCode window creation
- ✅ Applies hardcoded AUMID via ITaskbarList3
- ⏳ Workspace path detection (TODO)
- ⏳ Dynamic AUMID generation per workspace (TODO)
- ⏳ Argument parsing optimization (TODO)

## Testing

Open a workspace:
```powershell
code C:\your\workspace
```

Then:
1. Open another workspace in a new VSCode window: `code C:\another\workspace`
2. Both should appear as separate entries in the taskbar (if AUMID application works)
3. Check debug output in console for:
   - "Found VSCode at: ..."
   - "Successfully set AppID to: ..."

## Key Files

- `src/main.cpp` - Main wrapper implementation
- `CMakeLists.txt` - Build configuration

## Architecture

```
User executes: code C:\workspace
        ↓
    [Wrapper found in PATH]
        ↓
    Wrapper reads registry → finds real VSCode
        ↓
    Wrapper spawns VSCode process
        ↓
    Wrapper waits for window creation
        ↓
    Wrapper applies AUMID via COM
        ↓
    VSCode continues running
    Wrapper exits
```
