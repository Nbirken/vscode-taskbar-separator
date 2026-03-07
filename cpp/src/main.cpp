#include <windows.h>
#include <winioctl.h>
#include <shellapi.h>
#include <shlobj.h>
#include <shobjidl.h>
#include <propsys.h>
#include <gdiplus.h>
#include <tlhelp32.h>
#include <cstdio>
#include <string>
#include <filesystem>
#include <functional>

#pragma comment(lib, "gdiplus.lib")

// PKEY_AppUserModel_ID: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
static const PROPERTYKEY PKEY_AppUserModel_ID = {
    {0x9f4c2855, 0x9f79, 0x4b39, {0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3}}, 5};

// PKEY_AppUserModel_RelaunchCommand: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 2
static const PROPERTYKEY PKEY_AppUserModel_RelaunchCommand = {
    {0x9f4c2855, 0x9f79, 0x4b39, {0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3}}, 2};

// PKEY_AppUserModel_RelaunchDisplayNameResource: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 4
static const PROPERTYKEY PKEY_AppUserModel_RelaunchDisplayNameResource = {
    {0x9f4c2855, 0x9f79, 0x4b39, {0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3}}, 4};

// PKEY_AppUserModel_RelaunchIconResource: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 3
static const PROPERTYKEY PKEY_AppUserModel_RelaunchIconResource = {
    {0x9f4c2855, 0x9f79, 0x4b39, {0xa8, 0xd0, 0xe1, 0xd4, 0x2d, 0xe1, 0xd5, 0xf3}}, 3};

// Globals for AUMID application (fallback for per-window override)
static std::wstring g_targetAUMID;
static std::wstring g_targetRelaunchCommand;
static std::wstring g_targetRelaunchIcon;
static DWORD g_targetProcessId = 0;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

std::wstring FindVSCodePath()
{
    // Try registry (user + machine)
    const HKEY roots[] = {HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    for (HKEY root : roots)
    {
        HKEY hKey;
        if (RegOpenKeyExW(root,
                          L"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\VSCode",
                          0, KEY_READ, &hKey) == ERROR_SUCCESS)
        {
            wchar_t path[MAX_PATH];
            DWORD size = sizeof(path);
            LONG r = RegQueryValueExW(hKey, L"InstallLocation", NULL, NULL, (LPBYTE)path, &size);
            RegCloseKey(hKey);
            if (r == ERROR_SUCCESS)
            {
                std::wstring p(path);
                if (!p.empty() && p.back() == L'\\')
                    p.pop_back();
                return p;
            }
        }
    }

    // Fallback: common paths
    const wchar_t *paths[] = {
        L"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Microsoft VS Code",
        L"C:\\Program Files\\Microsoft VS Code",
        L"C:\\Program Files (x86)\\Microsoft VS Code",
        L"P:\\Program Files\\Microsoft VS Code",
        L"D:\\Program Files\\Microsoft VS Code"};
    for (const wchar_t *base : paths)
    {
        wchar_t expanded[MAX_PATH];
        ExpandEnvironmentStringsW(base, expanded, MAX_PATH);
        std::wstring test = std::wstring(expanded) + L"\\Code.exe";
        if (GetFileAttributesW(test.c_str()) != INVALID_FILE_ATTRIBUTES)
            return expanded;
    }
    return L"";
}

std::wstring GenerateAUMID(const std::wstring &folderPath, const std::wstring &instanceDir)
{
    wchar_t buf[256];
    if (!folderPath.empty())
    {
        size_t hash = std::hash<std::wstring>{}(folderPath);
        swprintf_s(buf, 256, L"VSCode.Workspace.%llx", hash);
    }
    else
    {
        size_t hash = std::hash<std::wstring>{}(instanceDir);
        swprintf_s(buf, 256, L"VSCode.Instance.%llx", hash);
    }
    return buf;
}

// ---------------------------------------------------------------------------
// Isolated user-data-dir with selective junctions
// ---------------------------------------------------------------------------

#ifndef SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
#define SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE 0x2
#endif

// Reparse data for directory junctions (works with all SDK versions).
#pragma pack(push, 1)
struct JunctionReparseData
{
    DWORD ReparseTag;
    WORD ReparseDataLength;
    WORD Reserved;
    WORD SubstituteNameOffset;
    WORD SubstituteNameLength;
    WORD PrintNameOffset;
    WORD PrintNameLength;
    WCHAR PathBuffer[MAX_PATH * 2];
};
#pragma pack(pop)

// Create a directory junction via Win32 API (no cmd.exe subprocess, instant).
bool CreateJunction(const std::wstring &target, const std::wstring &junction)
{
    DWORD attrs = GetFileAttributesW(junction.c_str());

    // Already a junction — reuse it
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT))
        return true;

    // Remove stale entry from a previous approach
    if (attrs != INVALID_FILE_ATTRIBUTES)
    {
        if (attrs & FILE_ATTRIBUTE_DIRECTORY)
            try
            {
                std::filesystem::remove_all(junction);
            }
            catch (...)
            {
            }
        else
            DeleteFileW(junction.c_str());
    }

    if (!CreateDirectoryW(junction.c_str(), NULL))
        return false;

    HANDLE hDir = CreateFileW(junction.c_str(), GENERIC_WRITE, 0, NULL,
                              OPEN_EXISTING,
                              FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                              NULL);
    if (hDir == INVALID_HANDLE_VALUE)
    {
        RemoveDirectoryW(junction.c_str());
        return false;
    }

    // NT-style target path required for mount points
    std::wstring ntPath = L"\\??\\" + target;
    WORD ntBytes = (WORD)(ntPath.size() * sizeof(WCHAR));
    WORD printBytes = (WORD)(target.size() * sizeof(WCHAR));

    JunctionReparseData rpd = {};
    rpd.ReparseTag = IO_REPARSE_TAG_MOUNT_POINT;
    rpd.SubstituteNameOffset = 0;
    rpd.SubstituteNameLength = ntBytes;
    rpd.PrintNameOffset = ntBytes + sizeof(WCHAR);
    rpd.PrintNameLength = printBytes;
    rpd.ReparseDataLength = (WORD)(sizeof(WORD) * 4 + ntBytes + sizeof(WCHAR) + printBytes + sizeof(WCHAR));

    memcpy(rpd.PathBuffer, ntPath.c_str(), ntBytes + sizeof(WCHAR));
    memcpy((BYTE *)rpd.PathBuffer + ntBytes + sizeof(WCHAR),
           target.c_str(), printBytes + sizeof(WCHAR));

    DWORD totalSize = (DWORD)(offsetof(JunctionReparseData, PathBuffer) + ntBytes + sizeof(WCHAR) + printBytes + sizeof(WCHAR));
    DWORD ret;
    BOOL ok = DeviceIoControl(hDir, FSCTL_SET_REPARSE_POINT,
                              &rpd, totalSize, NULL, 0, &ret, NULL);
    CloseHandle(hDir);

    if (!ok)
    {
        RemoveDirectoryW(junction.c_str());
        return false;
    }
    return true;
}

// Link a file via symlink (Developer Mode on Win10 1703+) or fall back to copy.
// Always refreshes stale copies so the encryption key stays current.
bool LinkOrCopyFile(const std::wstring &src, const std::wstring &dst)
{
    DWORD attrs = GetFileAttributesW(dst.c_str());

    // Existing symlink is always up-to-date (same physical file)
    if (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_REPARSE_POINT))
        return true;

    // Remove stale copy so we always get fresh data
    if (attrs != INVALID_FILE_ATTRIBUTES)
        DeleteFileW(dst.c_str());

    // Try file symlink first (no admin needed with Developer Mode)
    if (CreateSymbolicLinkW(dst.c_str(), src.c_str(),
                            SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE))
        return true;

    // Fall back to copy
    return CopyFileW(src.c_str(), dst.c_str(), FALSE) != 0;
}

// Create an isolated user-data-dir with selective junctions for shared data
// and fresh per-instance caches/locks.
//
// Shared via junctions:
//   User/        -> %APPDATA%\Code\User  (settings, secrets in state.vscdb, trust)
//   extensions/  -> %APPDATA%\Code\extensions
// Shared via symlink (or copy):
//   Local State  -> %APPDATA%\Code\Local State  (os_crypt AES encryption key)
// Fresh per-instance:
//   Cache/, Code Cache/, GPUCache/, Service Worker/, Session Storage/,
//   Local Storage/, logs/, Crashpad/, code.lock, etc.
//
std::wstring CreateIsolatedUserDataDir(const std::wstring &workspacePath)
{
    wchar_t appData[MAX_PATH];
    if (!GetEnvironmentVariableW(L"APPDATA", appData, MAX_PATH))
        return L"";

    std::wstring dirName;
    if (workspacePath.empty())
    {
        FILETIME ft;
        GetSystemTimeAsFileTime(&ft);
        ULARGE_INTEGER uli;
        uli.LowPart = ft.dwLowDateTime;
        uli.HighPart = ft.dwHighDateTime;
        wchar_t id[32];
        swprintf_s(id, 32, L"instance_%llx", uli.QuadPart);
        dirName = id;
    }
    else
    {
        size_t hash = std::hash<std::wstring>{}(workspacePath);
        wchar_t id[32];
        swprintf_s(id, 32, L"%llx", hash);
        dirName = id;
    }

    std::wstring instanceDir = std::wstring(appData) + L"\\VSCode-TaskbarSeparator\\workspaces\\" + dirName;
    std::wstring mainDir = std::wstring(appData) + L"\\Code";

    try
    {
        std::filesystem::create_directories(instanceDir);
    }
    catch (...)
    {
        return L"";
    }

    // Junction shared directories
    CreateJunction(mainDir + L"\\User", instanceDir + L"\\User");
    CreateJunction(mainDir + L"\\extensions", instanceDir + L"\\extensions");

    // Share encryption key (os_crypt.encrypted_key in Local State).
    // Symlink keeps it always in sync; copy fallback is refreshed each launch.
    LinkOrCopyFile(mainDir + L"\\Local State", instanceDir + L"\\Local State");

    return instanceDir;
}

// Clean up instance directory after VSCode exits.
// Removes junctions safely (reparse point only, not target contents),
// then removes remaining per-instance cache files.
void CleanupInstanceDir(const std::wstring &instanceDir, bool isPersistent)
{
    if (instanceDir.empty() || isPersistent)
        return;
    try
    {
        Sleep(500);
        // Remove junctions (RemoveDirectoryW on a junction = remove reparse point only)
        RemoveDirectoryW((instanceDir + L"\\User").c_str());
        RemoveDirectoryW((instanceDir + L"\\extensions").c_str());
        // Remove Local State symlink or copy
        DeleteFileW((instanceDir + L"\\Local State").c_str());
        // Now safe to remove_all — only per-instance cache files remain
        std::filesystem::remove_all(instanceDir);
    }
    catch (...)
    {
    }
}

// ---------------------------------------------------------------------------
// AUMID application
// ---------------------------------------------------------------------------

HRESULT ApplyAUMIDToWindow(HWND hwnd, const std::wstring &aumid,
                           const std::wstring &relaunchCmd = L"",
                           const std::wstring &relaunchIcon = L"")
{
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    IPropertyStore *pps = NULL;
    HRESULT hr = SHGetPropertyStoreForWindow(hwnd, IID_PPV_ARGS(&pps));
    if (FAILED(hr))
    {
        CoUninitialize();
        return hr;
    }

    PROPVARIANT pv;
    PropVariantInit(&pv);
    pv.vt = VT_LPWSTR;
    pv.pwszVal = const_cast<wchar_t *>(aumid.c_str());
    hr = pps->SetValue(PKEY_AppUserModel_ID, pv);

    // Set RelaunchCommand so the taskbar context menu "Visual Studio Code"
    // entry routes through the wrapper instead of the real Code.exe
    if (!relaunchCmd.empty())
    {
        pv.pwszVal = const_cast<wchar_t *>(relaunchCmd.c_str());
        pps->SetValue(PKEY_AppUserModel_RelaunchCommand, pv);

        std::wstring displayName = L"Visual Studio Code";
        pv.pwszVal = const_cast<wchar_t *>(displayName.c_str());
        pps->SetValue(PKEY_AppUserModel_RelaunchDisplayNameResource, pv);
    }

    // Set icon resource to the real Code.exe so the taskbar button keeps
    // the VS Code icon instead of falling back to the wrapper's default icon
    if (!relaunchIcon.empty())
    {
        pv.pwszVal = const_cast<wchar_t *>(relaunchIcon.c_str());
        pps->SetValue(PKEY_AppUserModel_RelaunchIconResource, pv);
    }

    pv.vt = VT_EMPTY;
    pps->Release();
    CoUninitialize();
    return hr;
}

BOOL CALLBACK ApplyAUMIDCallback(HWND hwnd, LPARAM)
{
    wchar_t className[256] = {};
    wchar_t title[512] = {};
    GetClassNameW(hwnd, className, 256);
    GetWindowTextW(hwnd, title, 512);

    if (wcscmp(className, L"Chrome_WidgetWin_1") == 0 &&
        wcsstr(title, L"Visual Studio Code") != NULL)
    {
        if (g_targetProcessId != 0)
        {
            DWORD pid;
            GetWindowThreadProcessId(hwnd, &pid);
            if (pid != g_targetProcessId)
                return TRUE; // Not our process
        }
        if (SUCCEEDED(ApplyAUMIDToWindow(hwnd, g_targetAUMID, g_targetRelaunchCommand, g_targetRelaunchIcon)))
            ; // Applied successfully
    }
    return TRUE;
}

// ---------------------------------------------------------------------------
// Overlay / Icon commands (called by the extension at runtime)
// ---------------------------------------------------------------------------

// Find the main Chrome_WidgetWin_1 window for a given PID.
static HWND g_foundHwnd = NULL;
static DWORD g_searchPid = 0;

BOOL CALLBACK FindWindowByPidCallback(HWND hwnd, LPARAM)
{
    wchar_t className[256] = {};
    GetClassNameW(hwnd, className, 256);
    if (wcscmp(className, L"Chrome_WidgetWin_1") != 0)
        return TRUE;

    DWORD pid;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == g_searchPid && IsWindowVisible(hwnd))
    {
        g_foundHwnd = hwnd;
        return FALSE; // Stop enumeration
    }
    return TRUE;
}

HWND FindVSCodeWindowByPid(DWORD pid)
{
    g_foundHwnd = NULL;
    g_searchPid = pid;
    EnumWindows(FindWindowByPidCallback, 0);
    return g_foundHwnd;
}

// Load a PNG (or ICO/BMP) file as HICON using GDI+.
HICON LoadImageAsIcon(const std::wstring &path)
{
    Gdiplus::GdiplusStartupInput gdipInput;
    ULONG_PTR gdipToken;
    if (Gdiplus::GdiplusStartup(&gdipToken, &gdipInput, NULL) != Gdiplus::Ok)
        return NULL;

    HICON hIcon = NULL;
    {
        Gdiplus::Bitmap bmp(path.c_str());
        if (bmp.GetLastStatus() == Gdiplus::Ok)
            bmp.GetHICON(&hIcon);
    }
    Gdiplus::GdiplusShutdown(gdipToken);
    return hIcon;
}

// Set overlay badge on a VSCode window identified by PID.
// Returns 0 on success.
int CmdSetOverlay(DWORD pid, const std::wstring &iconPath)
{
    HWND hwnd = FindVSCodeWindowByPid(pid);
    if (!hwnd)
        return 1;

    HICON hIcon = LoadImageAsIcon(iconPath);
    if (!hIcon)
        return 2;

    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    ITaskbarList3 *pTbl = NULL;
    HRESULT hr = CoCreateInstance(CLSID_TaskbarList, NULL, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&pTbl));
    int result = 1;
    if (SUCCEEDED(hr))
    {
        hr = pTbl->HrInit();
        if (SUCCEEDED(hr))
        {
            hr = pTbl->SetOverlayIcon(hwnd, hIcon, L"badge");
            if (SUCCEEDED(hr))
                result = 0;
        }
        pTbl->Release();
    }
    CoUninitialize();
    DestroyIcon(hIcon);
    return result;
}

// Remove overlay badge from a VSCode window identified by PID.
int CmdRemoveOverlay(DWORD pid)
{
    HWND hwnd = FindVSCodeWindowByPid(pid);
    if (!hwnd)
        return 1;

    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
    ITaskbarList3 *pTbl = NULL;
    HRESULT hr = CoCreateInstance(CLSID_TaskbarList, NULL, CLSCTX_INPROC_SERVER,
                                  IID_PPV_ARGS(&pTbl));
    int result = 1;
    if (SUCCEEDED(hr))
    {
        hr = pTbl->HrInit();
        if (SUCCEEDED(hr))
        {
            hr = pTbl->SetOverlayIcon(hwnd, NULL, NULL);
            if (SUCCEEDED(hr))
                result = 0;
        }
        pTbl->Release();
    }
    CoUninitialize();
    return result;
}

// ---------------------------------------------------------------------------
// Check whether any real VS Code (Code.exe) process is already running.
// We compare the full executable path so we never match our own wrapper.
// ---------------------------------------------------------------------------

bool IsVSCodeRunning(const std::wstring &realCodeExePath)
{
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE)
        return false;

    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    DWORD selfPid = GetCurrentProcessId();
    bool found = false;

    if (Process32FirstW(snap, &pe))
    {
        do
        {
            if (pe.th32ProcessID == selfPid)
                continue;
            if (_wcsicmp(pe.szExeFile, L"Code.exe") != 0)
                continue;

            // Confirm it's the real VS Code by checking its full path
            HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pe.th32ProcessID);
            if (hProc)
            {
                wchar_t exePath[MAX_PATH] = {};
                DWORD sz = MAX_PATH;
                if (QueryFullProcessImageNameW(hProc, 0, exePath, &sz))
                {
                    if (_wcsicmp(exePath, realCodeExePath.c_str()) == 0)
                        found = true;
                }
                CloseHandle(hProc);
            }
            if (found)
                break;
        } while (Process32NextW(snap, &pe));
    }

    CloseHandle(snap);
    return found;
}

// ---------------------------------------------------------------------------
// Installation: patch shortcuts and file associations to route through wrapper
// ---------------------------------------------------------------------------

// Attach to the calling terminal so wprintf output is visible.
static bool InitConsole()
{
    if (!AttachConsole(ATTACH_PARENT_PROCESS))
        return false;
    FILE *f = nullptr;
    _wfreopen_s(&f, L"CONOUT$", L"w", stdout);
    return f != nullptr;
}

static std::wstring GetOwnExePath()
{
    wchar_t buf[MAX_PATH];
    GetModuleFileNameW(NULL, buf, MAX_PATH);
    return buf;
}

// Modify a .lnk shortcut's Target and Icon.
static bool PatchShortcut(const std::wstring &lnkPath,
                          const std::wstring &newTarget,
                          const std::wstring &iconSource)
{
    if (GetFileAttributesW(lnkPath.c_str()) == INVALID_FILE_ATTRIBUTES)
        return false;

    IShellLinkW *psl = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                  IID_IShellLinkW, (void **)&psl);
    if (FAILED(hr))
        return false;

    IPersistFile *ppf = nullptr;
    hr = psl->QueryInterface(IID_IPersistFile, (void **)&ppf);
    if (FAILED(hr))
    {
        psl->Release();
        return false;
    }

    hr = ppf->Load(lnkPath.c_str(), STGM_READWRITE);
    if (SUCCEEDED(hr))
    {
        psl->SetPath(newTarget.c_str());
        psl->SetIconLocation(iconSource.c_str(), 0);
        hr = ppf->Save(lnkPath.c_str(), TRUE);
    }

    ppf->Release();
    psl->Release();
    return SUCCEEDED(hr);
}

// Replace the exe path inside a registry "command" value (HKCU).
// Values look like:  "C:\...\Code.exe" "%1"  — we swap only the quoted exe.
static bool PatchRegistryCommand(const wchar_t *subKey,
                                 const std::wstring &newExe)
{
    HKEY hKey;
    if (RegOpenKeyExW(HKEY_CURRENT_USER, subKey, 0,
                      KEY_READ | KEY_WRITE, &hKey) != ERROR_SUCCESS)
        return false;

    wchar_t val[1024] = {};
    DWORD sz = sizeof(val);
    if (RegQueryValueExW(hKey, NULL, NULL, NULL, (LPBYTE)val, &sz) != ERROR_SUCCESS)
    {
        RegCloseKey(hKey);
        return false;
    }

    std::wstring orig(val);
    if (orig.size() < 2 || orig[0] != L'"')
    {
        RegCloseKey(hKey);
        return false;
    }
    size_t closing = orig.find(L'"', 1);
    if (closing == std::wstring::npos)
    {
        RegCloseKey(hKey);
        return false;
    }

    std::wstring rest = orig.substr(closing + 1);
    std::wstring newVal = L"\"" + newExe + L"\"" + rest;
    RegSetValueExW(hKey, NULL, 0, REG_SZ,
                   (const BYTE *)newVal.c_str(),
                   (DWORD)((newVal.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);
    return true;
}

static int CmdInstall()
{
    bool hasConsole = InitConsole();
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    std::wstring wrapper = GetOwnExePath();
    std::wstring vscodePath = FindVSCodePath();
    if (vscodePath.empty())
    {
        if (hasConsole)
            wprintf(L"Error: could not find VS Code installation.\n");
        else
            MessageBoxW(NULL, L"Could not find VS Code installation.",
                        L"VSCode Taskbar Separator", MB_ICONERROR);
        CoUninitialize();
        return 1;
    }
    std::wstring realCodeExe = vscodePath + L"\\Code.exe";

    if (hasConsole)
    {
        wprintf(L"VSCode Taskbar Separator -- Install\n");
        wprintf(L"  Real Code.exe : %s\n", realCodeExe.c_str());
        wprintf(L"  Wrapper       : %s\n\n", wrapper.c_str());
    }

    int count = 0;
    wchar_t buf[MAX_PATH];

    // --- Shortcuts -----------------------------------------------------------
    if (SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, buf) == S_OK)
    {
        std::wstring lnk = std::wstring(buf) +
                           L"\\Visual Studio Code\\Visual Studio Code.lnk";
        if (PatchShortcut(lnk, wrapper, realCodeExe))
        {
            if (hasConsole)
                wprintf(L"  [OK] Start Menu shortcut\n");
            count++;
        }
    }

    if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, buf) == S_OK)
    {
        std::wstring lnk = std::wstring(buf) + L"\\Visual Studio Code.lnk";
        if (PatchShortcut(lnk, wrapper, realCodeExe))
        {
            if (hasConsole)
                wprintf(L"  [OK] Desktop shortcut\n");
            count++;
        }
    }

    // --- "Open with Code" context menu (HKCU) --------------------------------
    static const wchar_t *regKeys[] = {
        L"Software\\Classes\\*\\shell\\VSCode\\command",
        L"Software\\Classes\\Directory\\shell\\VSCode\\command",
        L"Software\\Classes\\Directory\\Background\\shell\\VSCode\\command",
    };
    static const wchar_t *regLabels[] = {
        L"\"Open with Code\" on files",
        L"\"Open with Code\" on folders",
        L"\"Open with Code\" on folder backgrounds",
    };
    for (int i = 0; i < 3; i++)
    {
        if (PatchRegistryCommand(regKeys[i], wrapper))
        {
            if (hasConsole)
                wprintf(L"  [OK] %s\n", regLabels[i]);
            count++;
        }
    }

    CoUninitialize();

    if (hasConsole)
    {
        wprintf(L"\nDone -- %d items patched.\n", count);
        if (count > 0)
            wprintf(L"Tip: if VS Code is pinned to the taskbar, unpin and re-pin it.\n");
    }
    else
    {
        wchar_t msg[256];
        swprintf_s(msg, 256, L"%d items patched.\nIf VS Code is pinned to the taskbar, unpin and re-pin it.", count);
        MessageBoxW(NULL, msg, L"VSCode Taskbar Separator", MB_ICONINFORMATION);
    }
    return 0;
}

static int CmdUninstall()
{
    bool hasConsole = InitConsole();
    CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

    std::wstring vscodePath = FindVSCodePath();
    if (vscodePath.empty())
    {
        if (hasConsole)
            wprintf(L"Error: could not find VS Code installation.\n");
        else
            MessageBoxW(NULL, L"Could not find VS Code installation.",
                        L"VSCode Taskbar Separator", MB_ICONERROR);
        CoUninitialize();
        return 1;
    }
    std::wstring realCodeExe = vscodePath + L"\\Code.exe";

    if (hasConsole)
    {
        wprintf(L"VSCode Taskbar Separator -- Uninstall\n");
        wprintf(L"  Restoring to: %s\n\n", realCodeExe.c_str());
    }

    int count = 0;
    wchar_t buf[MAX_PATH];

    // --- Shortcuts -----------------------------------------------------------
    if (SHGetFolderPathW(NULL, CSIDL_PROGRAMS, NULL, 0, buf) == S_OK)
    {
        std::wstring lnk = std::wstring(buf) +
                           L"\\Visual Studio Code\\Visual Studio Code.lnk";
        if (PatchShortcut(lnk, realCodeExe, realCodeExe))
        {
            if (hasConsole)
                wprintf(L"  [OK] Start Menu shortcut restored\n");
            count++;
        }
    }

    if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, buf) == S_OK)
    {
        std::wstring lnk = std::wstring(buf) + L"\\Visual Studio Code.lnk";
        if (PatchShortcut(lnk, realCodeExe, realCodeExe))
        {
            if (hasConsole)
                wprintf(L"  [OK] Desktop shortcut restored\n");
            count++;
        }
    }

    // --- Registry ------------------------------------------------------------
    static const wchar_t *regKeys[] = {
        L"Software\\Classes\\*\\shell\\VSCode\\command",
        L"Software\\Classes\\Directory\\shell\\VSCode\\command",
        L"Software\\Classes\\Directory\\Background\\shell\\VSCode\\command",
    };
    static const wchar_t *regLabels[] = {
        L"\"Open with Code\" on files",
        L"\"Open with Code\" on folders",
        L"\"Open with Code\" on folder backgrounds",
    };
    for (int i = 0; i < 3; i++)
    {
        if (PatchRegistryCommand(regKeys[i], realCodeExe))
        {
            if (hasConsole)
                wprintf(L"  [OK] %s restored\n", regLabels[i]);
            count++;
        }
    }

    CoUninitialize();

    if (hasConsole)
        wprintf(L"\nDone -- %d items restored.\n", count);
    else
    {
        wchar_t msg[256];
        swprintf_s(msg, 256, L"%d items restored.", count);
        MessageBoxW(NULL, msg, L"VSCode Taskbar Separator", MB_ICONINFORMATION);
    }
    return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, LPWSTR, int)
{
    // Signal to Windows that startup is complete so the busy cursor
    // clears immediately. Windows only clears it after GetMessage.
    PostThreadMessage(GetCurrentThreadId(), WM_NULL, 0, 0);
    MSG msg;
    GetMessage(&msg, NULL, 0, 0);

    // Parse command line into argc/argv style
    int argc = 0;
    LPWSTR *argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    if (!argv)
        return 1;

    int exitCode = 1;

    // Check for command modes (called by extension at runtime)
    if (argc >= 2)
    {
        std::wstring cmd(argv[1]);
        if (cmd == L"--install")
        {
            LocalFree(argv);
            return CmdInstall();
        }
        if (cmd == L"--uninstall")
        {
            LocalFree(argv);
            return CmdUninstall();
        }
    }
    if (argc >= 3)
    {
        std::wstring cmd(argv[1]);
        if (cmd == L"--set-overlay" && argc >= 4)
        {
            DWORD pid = (DWORD)wcstoul(argv[2], NULL, 10);
            exitCode = CmdSetOverlay(pid, argv[3]);
            LocalFree(argv);
            return exitCode;
        }
        if (cmd == L"--remove-overlay" && argc >= 3)
        {
            DWORD pid = (DWORD)wcstoul(argv[2], NULL, 10);
            exitCode = CmdRemoveOverlay(pid);
            LocalFree(argv);
            return exitCode;
        }
    }

    try
    {
        // 1. Find VSCode
        std::wstring vscodePath = FindVSCodePath();
        if (vscodePath.empty())
            return 1;

        std::wstring codeExe = vscodePath + L"\\Code.exe";
        if (GetFileAttributesW(codeExe.c_str()) == INVALID_FILE_ATTRIBUTES)
        {
            codeExe = vscodePath + L"\\bin\\code.cmd";
            if (GetFileAttributesW(codeExe.c_str()) == INVALID_FILE_ATTRIBUTES)
                return 1;
        }

        // 2. Check if a real VS Code process is already running.
        //    First launch  → passthrough (keeps default AUMID, full jump list)
        //    Subsequent    → isolated wrapper (custom AUMID, separate taskbar button)
        bool vsCodeAlreadyRunning = IsVSCodeRunning(vscodePath + L"\\Code.exe");

        // 3. Parse args, extract workspace path
        std::wstring workspacePath;
        bool hasArguments = argc > 1;

        std::wstring commandLine = L"\"" + codeExe + L"\"";

        for (int i = 1; i < argc; i++)
        {
            std::wstring arg(argv[i]);
            if (!arg.empty() && arg[0] != L'-' && workspacePath.empty())
                workspacePath = arg;
            commandLine += L" \"" + arg + L"\"";
        }

        if (!vsCodeAlreadyRunning)
        {
            // ── Passthrough: first instance ──────────────────────────────
            // Launch VS Code without isolation so it keeps the default
            // AUMID and its jump list (Recent, Tasks) works normally.
            STARTUPINFOW si = {};
            si.cb = sizeof(si);
            PROCESS_INFORMATION pi = {};

            if (!CreateProcessW(NULL, (wchar_t *)commandLine.c_str(),
                                NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi))
                return 1;

            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            exitCode = 0;
        }
        else
        {
            // ── Isolated: subsequent instances ───────────────────────────
            commandLine += L" --new-window";

            // 4. Create isolated user-data-dir
            std::wstring instanceDir = CreateIsolatedUserDataDir(workspacePath);
            bool isPersistent = !workspacePath.empty();
            if (!instanceDir.empty())
                commandLine += L" --user-data-dir \"" + instanceDir + L"\"";

            // 5. Generate AUMID and pass via Electron flag
            std::wstring aumid = GenerateAUMID(workspacePath, instanceDir);
            commandLine += L" --app-user-model-id=\"" + aumid + L"\"";

            // 6. Launch VSCode
            STARTUPINFOW si = {};
            si.cb = sizeof(si);
            PROCESS_INFORMATION pi = {};

            if (!CreateProcessW(NULL, (wchar_t *)commandLine.c_str(),
                                NULL, NULL, FALSE, 0, NULL, NULL, &si, &pi))
                return 1;

            // 7. Apply AUMID to window as fallback
            g_targetProcessId = pi.dwProcessId;
            g_targetAUMID = aumid;
            g_targetRelaunchCommand = L"\"" + GetOwnExePath() + L"\"";
            g_targetRelaunchIcon = codeExe + L",0";
            Sleep(500);
            EnumWindows(ApplyAUMIDCallback, 0);

            // 8. Wait for VSCode to exit, then clean up
            WaitForSingleObject(pi.hProcess, INFINITE);
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);

            CleanupInstanceDir(instanceDir, isPersistent);
        }
        exitCode = 0;
    }
    catch (...)
    {
    }

    LocalFree(argv);
    return exitCode;
}
