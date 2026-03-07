import * as vscode from 'vscode';
import * as fs from 'fs';
import { getActiveWindowHandle, generateBadgeIcon, applyBadgeToWindow, removeBadgeFromWindow, generateDeterministicColor } from './utils';
import { type IconConfig } from './types';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Taskbar Separator');
    outputChannel.appendLine('Taskbar Separator extension activated');

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
        })
    );

    // Apply badge on startup (short delay for window to become visible)
    setTimeout(() => {
        applyCustomBadge();
    }, 100);

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
