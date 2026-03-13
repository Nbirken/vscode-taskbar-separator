import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import { getActiveWindowHandle, generateBadgeIcon, applyBadgeToWindow, removeBadgeFromWindow, generateDeterministicColor } from './utils';
import { type IconConfig } from './types';

const execFile = promisify(cp.execFile);
let outputChannel: vscode.OutputChannel;
const SHARP_WARNING_SHOWN_KEY = 'taskbarSeparator.sharpWarningShown';

/** Directory where the wrapper is installed for system-wide use. */
function getWrapperInstallDir(): string {
    return path.join(process.env.APPDATA || '', 'VSCode-TaskbarSeparator');
}

/** Path to the wrapper exe bundled inside the extension. */
function getBundledWrapperPath(): string {
    return path.join(__dirname, '..', 'bin', 'code.exe');
}

/** Check whether the wrapper has been installed to AppData. */
function isWrapperInstalled(): boolean {
    return fs.existsSync(path.join(getWrapperInstallDir(), 'code.exe'));
}

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Taskbar Separator');
    outputChannel.appendLine('Taskbar Separator extension activated');

    void verifySharpDependency(context);

    // Initialize wrapper configuration in AppData
    initializeWrapperConfig();

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('taskbarSeparator.applyBadge', () => {
            outputChannel.appendLine('Command: Apply Taskbar Badge triggered');
            applyCustomBadge();
        }),
        vscode.commands.registerCommand('taskbarSeparator.removeBadge', () => {
            outputChannel.appendLine('Command: Remove Taskbar Badge triggered');
            removeCustomBadge();
        }),
        vscode.commands.registerCommand('taskbarSeparator.showSettings', () => {
            openSettings();
        }),
        vscode.commands.registerCommand('taskbarSeparator.setupWrapper', () => {
            setupWrapper();
        }),
        vscode.commands.registerCommand('taskbarSeparator.removeWrapper', () => {
            removeWrapper();
        })
    );

    // Apply badge on startup (short delay for window to become visible)
    setTimeout(() => {
        applyCustomBadge();
    }, 100);

    // Prompt to install wrapper if not yet set up
    if (!isWrapperInstalled()) {
        promptWrapperSetup();
    }

    // Watch for configuration changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('taskbarSeparator')) {
                outputChannel.appendLine('Configuration changed, reapplying badge...');
                applyCustomBadge();
            }
        })
    );

    // Re-apply when workspace folders change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            outputChannel.appendLine('Workspace folders changed, reapplying badge...');
            applyCustomBadge();
        })
    );
}

async function verifySharpDependency(context: vscode.ExtensionContext): Promise<void> {
    try {
        const sharpModule: any = await import('sharp');
        const sharp = sharpModule?.default ?? sharpModule;
        const versions = sharp?.versions;
        outputChannel.appendLine(
            `✓ sharp loaded successfully (platform=${process.platform}, arch=${process.arch}, ` +
            `sharp=${versions?.sharp ?? 'unknown'}, vips=${versions?.vips ?? 'unknown'})`
        );
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);

        outputChannel.appendLine('❌ Failed to load native dependency "sharp".');
        outputChannel.appendLine(`   platform=${process.platform}, arch=${process.arch}`);
        outputChannel.appendLine(`   error=${errMsg}`);
        outputChannel.appendLine('   Badges are disabled until this is fixed.');
        outputChannel.appendLine('   Fix: reinstall/update extension and ensure packaged sharp binary matches your VS Code architecture.');

        if (!context.globalState.get<boolean>(SHARP_WARNING_SHOWN_KEY)) {
            const action = await vscode.window.showErrorMessage(
                'Taskbar Separator: Native dependency "sharp" failed to load. Badge rendering is disabled. Open output for details.',
                'Open Output'
            );
            if (action === 'Open Output') {
                outputChannel.show(true);
            }
            await context.globalState.update(SHARP_WARNING_SHOWN_KEY, true);
        }
    }
}

async function applyCustomBadge(): Promise<void> {
    try {
        outputChannel.show(true);
        outputChannel.appendLine('=== Apply Taskbar Badge ===');

        const config = vscode.workspace.getConfiguration('taskbarSeparator');
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        outputChannel.appendLine(`Workspace folder: ${workspaceFolder?.name || 'None'}`);

        // Get window handle (PID)
        outputChannel.appendLine('Getting window handle...');
        const hwnd = await getActiveWindowHandle(outputChannel);
        if (!hwnd) {
            outputChannel.appendLine('❌ Could not determine window handle');
            return;
        }
        outputChannel.appendLine(`✓ Window handle: ${hwnd}`);

        // Badge naming id based on workspace
        const badgeId = workspaceFolder
            ? `ws_${simpleHash(workspaceFolder.uri.fsPath)}`
            : `tmp_${Date.now().toString(36)}`;

        // Resolve badge color: use config or auto-generate deterministic color
        let badgeColor = config.get<string>('badgeColor', '');
        if (!badgeColor) {
            const colorInput = workspaceFolder?.uri.fsPath || `no-workspace-${Date.now()}`;
            outputChannel.appendLine(`Color hash input: "${colorInput}"`);
            badgeColor = generateDeterministicColor(colorInput);
            outputChannel.appendLine(`Auto-generated badge color: ${badgeColor}`);
        }

        const badgeStyle = config.get<string>('badgeStyle', 'circle') as 'circle' | 'square' | 'rounded-square';
        const badgeText = config.get<string>('badgeText', '');
        const badgeIconPath = config.get<string>('badgeBadgeIconPath', '');

        outputChannel.appendLine(`Badge config: color=${badgeColor}, style=${badgeStyle}, text=${badgeText}`);

        const iconConfig: IconConfig = {
            hwnd,
            badgeId,
            badgeColor,
            badgeStyle,
            badgeText,
            badgeIconPath,
            workspaceFolder: workspaceFolder?.uri.fsPath
        };

        // Generate badge icon if needed
        if (!iconConfig.badgeIconPath || !fs.existsSync(iconConfig.badgeIconPath)) {
            outputChannel.appendLine('Generating badge icon...');
            const badgeIconPathGenerated = await generateBadgeIcon(iconConfig);
            outputChannel.appendLine(`✓ Badge icon generated: ${badgeIconPathGenerated}`);
            iconConfig.badgeIconPath = badgeIconPathGenerated;
        }

        // Apply the badge
        outputChannel.appendLine('Applying badge to window...');
        await applyBadgeToWindow(iconConfig);
        outputChannel.appendLine('✓ Badge applied successfully');
        outputChannel.appendLine('=== Complete ===\n');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to apply taskbar badge: ${errorMessage}`);
    }
}

async function removeCustomBadge(): Promise<void> {
    try {
        outputChannel.show(true);
        outputChannel.appendLine('=== Remove Taskbar Badge ===');

        const hwnd = await getActiveWindowHandle();
        if (!hwnd) {
            outputChannel.appendLine('❌ Could not determine window handle');
            vscode.window.showErrorMessage('Could not determine window handle');
            return;
        }

        outputChannel.appendLine(`Window handle: ${hwnd}`);
        await removeBadgeFromWindow(hwnd);
        outputChannel.appendLine('✓ Badge removed successfully');
        vscode.window.showInformationMessage('Taskbar badge removed');
        outputChannel.appendLine('=== Complete ===\n');

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Error: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to remove taskbar badge: ${errorMessage}`);
    }
}

function openSettings(): void {
    vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'taskbarSeparator'
    );
}

async function promptWrapperSetup(): Promise<void> {
    const action = await vscode.window.showInformationMessage(
        'Taskbar Separator: Install the wrapper to get separate taskbar buttons for each VS Code instance?',
        'Install Wrapper',
        'Not Now'
    );
    if (action === 'Install Wrapper') {
        setupWrapper();
    }
}

async function setupWrapper(): Promise<void> {
    try {
        const bundled = getBundledWrapperPath();
        if (!fs.existsSync(bundled)) {
            vscode.window.showErrorMessage('Wrapper binary not found in extension. Please reinstall the extension.');
            return;
        }

        const installDir = getWrapperInstallDir();
        fs.mkdirSync(installDir, { recursive: true });

        // Copy wrapper to AppData
        const dest = path.join(installDir, 'code.exe');
        fs.copyFileSync(bundled, dest);
        outputChannel.appendLine(`✓ Copied wrapper to ${dest}`);

        // Add to user PATH if not already there
        await addToUserPath(installDir);

        // Run --install to patch shortcuts and registry
        try {
            const { stdout } = await execFile(dest, ['--install']);
            outputChannel.appendLine(`Wrapper --install output: ${stdout}`);
        } catch {
            // --install may use MessageBox in non-console mode, which is fine
        }

        vscode.window.showInformationMessage(
            'Taskbar Separator wrapper installed. Restart VS Code for full effect. ' +
            'If VS Code is pinned to the taskbar, unpin and re-pin it.'
        );
        outputChannel.appendLine('✓ Wrapper setup complete');
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Wrapper setup failed: ${msg}`);
        vscode.window.showErrorMessage(`Wrapper setup failed: ${msg}`);
    }
}

async function removeWrapper(): Promise<void> {
    try {
        const installDir = getWrapperInstallDir();
        const exe = path.join(installDir, 'code.exe');

        if (fs.existsSync(exe)) {
            // Run --uninstall to revert shortcuts and registry
            try {
                await execFile(exe, ['--uninstall']);
            } catch {
                // --uninstall may use MessageBox
            }

            fs.unlinkSync(exe);
            outputChannel.appendLine('✓ Removed wrapper executable');
        }

        // Remove from user PATH
        await removeFromUserPath(installDir);

        vscode.window.showInformationMessage(
            'Taskbar Separator wrapper uninstalled. Restart VS Code for full effect.'
        );
        outputChannel.appendLine('✓ Wrapper removal complete');
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`❌ Wrapper removal failed: ${msg}`);
        vscode.window.showErrorMessage(`Wrapper removal failed: ${msg}`);
    }
}

async function addToUserPath(dir: string): Promise<void> {
    try {
        const { stdout } = await execFile('reg', [
            'query', 'HKCU\\Environment', '/v', 'Path'
        ]);
        const match = stdout.match(/Path\s+REG_[A-Z_]+\s+(.*)/i);
        const currentPath = match ? match[1].trim() : '';

        // Check if already in PATH (case-insensitive)
        const entries = currentPath.split(';').map(e => e.trim().toLowerCase());
        if (entries.includes(dir.toLowerCase())) {
            outputChannel.appendLine('Wrapper directory already in user PATH');
            return;
        }

        // Prepend to PATH so it takes priority over the real Code.exe
        const newPath = dir + ';' + currentPath;
        await execFile('reg', [
            'add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'
        ]);

        // Broadcast WM_SETTINGCHANGE so new processes pick it up
        await execFile('powershell', ['-NoProfile', '-Command',
            '[Environment]::SetEnvironmentVariable("Path", $null, "User"); ' +
            'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \'[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'; ' +
            '$r = [UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r)'
        ]);

        outputChannel.appendLine(`✓ Added ${dir} to user PATH`);
    } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        outputChannel.appendLine(`⚠ Could not update PATH automatically: ${msg}`);
        outputChannel.appendLine(`Add "${dir}" to your PATH manually to enable instance separation from terminal.`);
    }
}

async function removeFromUserPath(dir: string): Promise<void> {
    try {
        const { stdout } = await execFile('reg', [
            'query', 'HKCU\\Environment', '/v', 'Path'
        ]);
        const match = stdout.match(/Path\s+REG_[A-Z_]+\s+(.*)/i);
        if (!match) { return; }

        const currentPath = match[1].trim();
        const entries = currentPath.split(';').filter(e =>
            e.trim().toLowerCase() !== dir.toLowerCase() && e.trim() !== ''
        );
        const newPath = entries.join(';');

        await execFile('reg', [
            'add', 'HKCU\\Environment', '/v', 'Path', '/t', 'REG_EXPAND_SZ', '/d', newPath, '/f'
        ]);

        // Broadcast WM_SETTINGCHANGE
        await execFile('powershell', ['-NoProfile', '-Command',
            'Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition \'[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'; ' +
            '$r = [UIntPtr]::Zero; [Win32.NativeMethods]::SendMessageTimeout([IntPtr]0xFFFF, 0x001A, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$r)'
        ]);

        outputChannel.appendLine(`✓ Removed ${dir} from user PATH`);
    } catch {
        outputChannel.appendLine(`⚠ Could not remove from PATH automatically. Remove "${dir}" from your user PATH manually.`);
    }
}

function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
}

/**
 * Initialize wrapper configuration in AppData
 * Creates manager.json with wrapper settings like workspace directory and main user-data-dir
 */
function initializeWrapperConfig(): void {
    try {
        const appData = process.env.APPDATA;
        if (!appData) {
            console.warn('APPDATA environment variable not found');
            return;
        }

        const wrapperDir = `${appData}\\VSCode-TaskbarSeparator`;
        const managerPath = `${wrapperDir}\\manager.json`;

        // Create wrapper directory if needed
        if (!fs.existsSync(wrapperDir)) {
            fs.mkdirSync(wrapperDir, { recursive: true });
            console.log('Created VSCode-TaskbarSeparator directory');
        }

        // Get current VSCode user-data-dir and workspace config
        const config = vscode.workspace.getConfiguration('taskbarSeparator');
        const workspacesDir = config.get<string>('workspacesDirectory', 'D:\\vscode.workspaces');

        // Get current VSCode user data dir (default location)
        const currentUserDataDir = `${appData}\\Code`;

        const managerConfig = {
            version: 1,
            workspacesDirectory: workspacesDir,
            mainUserDataDir: currentUserDataDir,
            sharedExtensionsDir: `${currentUserDataDir}\\extensions`,
            wrapperBaseDir: wrapperDir,
            lastUpdated: new Date().toISOString()
        };

        // Write config file
        if (!fs.existsSync(managerPath)) {
            fs.writeFileSync(managerPath, JSON.stringify(managerConfig, null, 2));
            console.log('Created wrapper manager.json configuration');
            outputChannel.appendLine('✓ Wrapper configuration initialized');
        } else {
            // Update existing config
            const existing = JSON.parse(fs.readFileSync(managerPath, 'utf-8'));
            const updated = { ...existing, ...managerConfig };
            fs.writeFileSync(managerPath, JSON.stringify(updated, null, 2));
            console.log('Updated wrapper manager.json configuration');
        }
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn('Failed to initialize wrapper config:', errMsg);
        outputChannel?.appendLine(`⚠ Warning: Could not initialize wrapper config: ${errMsg}`);
    }
}

export function deactivate(): void {
    outputChannel.dispose();
}
