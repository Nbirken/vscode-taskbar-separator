import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';
import type { IconConfig } from './types';

const execFile = promisify(cp.execFile);

let sharpLoader: any | null = null;

async function getSharp(): Promise<any> {
    if (sharpLoader) {
        return sharpLoader;
    }

    try {
        const mod = await import('sharp');
        sharpLoader = (mod as any).default ?? mod;
        return sharpLoader;
    } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
            `The native dependency "sharp" could not be loaded (${errMsg}). ` +
            'Reinstall the extension and verify your VS Code architecture matches the packaged native module.'
        );
    }
}

/**
 * Get the path to the C++ wrapper executable.
 * Looks in the extension's bin/ directory, then falls back to AppData.
 */
function getWrapperExePath(): string {
    // Check extension's bin/ directory first
    const extensionBin = path.join(__dirname, '..', 'bin', 'code.exe');
    if (fs.existsSync(extensionBin)) {
        return extensionBin;
    }

    // Fall back to AppData location
    const appData = process.env.APPDATA;
    if (appData) {
        const appDataBin = path.join(appData, 'VSCode-TaskbarSeparator', 'code.exe');
        if (fs.existsSync(appDataBin)) {
            return appDataBin;
        }
    }

    // Fall back to build output (development)
    const devBuild = path.join(__dirname, '..', 'cpp', 'build', 'Release', 'code.exe');
    if (fs.existsSync(devBuild)) {
        return devBuild;
    }

    throw new Error('Wrapper executable not found. Place code.exe in bin/ or %APPDATA%\\VSCode-TaskbarSeparator\\');
}

/**
 * Get the PID of the main VSCode process that owns the window.
 * The extension host is a child process of the main Electron process.
 */
export function getMainVSCodePid(): number {
    return process.ppid;
}

/**
 * Get the window handle of the active VSCode window.
 * With the C++ wrapper, we use the PID directly — no need for PowerShell window searching.
 */
export async function getActiveWindowHandle(outputChannel?: any): Promise<string | null> {
    const pid = getMainVSCodePid();
    if (outputChannel) {
        outputChannel.appendLine(`Main VSCode PID: ${pid}`);
    }
    return pid.toString();
}

/**
 * Parse a hex color string (#RGB, #RRGGBB, or #RRGGBBAA) into an rgba() CSS value.
 */
function hexToRgba(hex: string): string {
    let r = 0, g = 0, b = 0, a = 1;
    const h = hex.replace('#', '');
    if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
    } else if (h.length === 6) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
    } else if (h.length === 8) {
        r = parseInt(h.substring(0, 2), 16);
        g = parseInt(h.substring(2, 4), 16);
        b = parseInt(h.substring(4, 6), 16);
        a = parseInt(h.substring(6, 8), 16) / 255;
    }
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/**
 * Build a palette of N vivid, maximally-spaced colors using golden-angle hue
 * stepping.  The golden angle (~137.5°) guarantees that consecutive indices are
 * never close in hue, so even hash-adjacent values look distinct.
 */
function buildPalette(n: number): string[] {
    const goldenAngle = 137.508;
    const palette: string[] = [];
    for (let i = 0; i < n; i++) {
        const hue = (i * goldenAngle) % 360;
        // Vary saturation/lightness slightly to avoid same-hue lookalikes
        const sat = 65 + (i % 3) * 10;          // 65 / 75 / 85
        const lit = 45 + ((i >> 2) % 3) * 10;   // 45 / 55 / 65
        const rgb = hslToRgb(hue, sat, lit);
        palette.push(`#${rgb}CC`);               // CC = 80% alpha
    }
    return palette;
}

/** HSL → 6-char hex RGB (e.g. "E02020") */
function hslToRgb(h: number, s: number, l: number): string {
    s /= 100; l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r: number, g: number, b: number;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
    return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** 64-entry palette — golden-angle spacing keeps neighbours visually distinct. */
const COLOR_PALETTE = buildPalette(64);

/**
 * Generate a deterministic color from a workspace path.
 * Uses FNV-1a hash for excellent distribution, then picks from a 64-color
 * golden-angle palette so parallel instances are almost always visually distinct.
 */
export function generateDeterministicColor(workspacePath: string): string {
    // FNV-1a 32-bit hash — much better avalanche than djb2 / hash*31
    let hash = 0x811c9dc5;
    for (let i = 0; i < workspacePath.length; i++) {
        hash ^= workspacePath.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return COLOR_PALETTE[(hash >>> 0) % COLOR_PALETTE.length];
}

/**
 * Generate a badge icon with the specified color and style
 */
export async function generateBadgeIcon(config: IconConfig): Promise<string> {
    console.log('generateBadgeIcon() - Starting with style:', config.badgeStyle, 'color:', config.badgeColor);

    const outputDir = path.join(os.tmpdir(), 'vscode-taskbar-badges');
    if (!fs.existsSync(outputDir)) {
        console.log('generateBadgeIcon() - Creating output directory:', outputDir);
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Name the file after its visual parameters so identical badges are reused
    const colorSlug = config.badgeColor.replace('#', '');
    const textSlug = config.badgeText || '_';
    const filename = `badge_${colorSlug}_${config.badgeStyle}_${textSlug}.png`;
    const outputPath = path.join(outputDir, filename);
    console.log('generateBadgeIcon() - Output path:', outputPath);

    try {
        // Create badge based on style
        switch (config.badgeStyle) {
            case 'circle':
                console.log('generateBadgeIcon() - Generating circle badge');
                await generateCircleBadge(outputPath, config);
                break;
            case 'square':
                console.log('generateBadgeIcon() - Generating square badge');
                await generateSquareBadge(outputPath, config);
                break;
            case 'rounded-square':
                console.log('generateBadgeIcon() - Generating rounded-square badge');
                await generateRoundedSquareBadge(outputPath, config);
                break;
        }

        console.log('generateBadgeIcon() - Badge generated successfully:', outputPath);
        return outputPath;
    } catch (error) {
        console.error('generateBadgeIcon() - Failed:', error);
        throw new Error(`Failed to generate badge icon: ${error}`);
    }
}

/**
 * Generate a circular badge
 */
async function generateCircleBadge(outputPath: string, config: IconConfig): Promise<void> {
    const size = 256;
    const fill = hexToRgba(config.badgeColor);
    const svgBadge = `
		<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<style>
					.badge-circle { fill: ${fill}; }
					.badge-text { fill: white; font-family: Arial, sans-serif; font-size: 120px; font-weight: bold; text-anchor: middle; dominant-baseline: middle; }
				</style>
			</defs>
			<circle class="badge-circle" cx="${size / 2}" cy="${size / 2}" r="${size / 2}" />
			${config.badgeText ? `<text class="badge-text" x="${size / 2}" y="${size / 2}">${config.badgeText}</text>` : ''}
		</svg>
	`;

    const sharp = await getSharp();
    await sharp(Buffer.from(svgBadge))
        .png()
        .toFile(outputPath);
}

/**
 * Generate a square badge
 */
async function generateSquareBadge(outputPath: string, config: IconConfig): Promise<void> {
    const size = 256;
    const fill = hexToRgba(config.badgeColor);
    const svgBadge = `
		<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<style>
					.badge-square { fill: ${fill}; }
					.badge-text { fill: white; font-family: Arial, sans-serif; font-size: 120px; font-weight: bold; text-anchor: middle; dominant-baseline: middle; }
				</style>
			</defs>
			<rect class="badge-square" x="0" y="0" width="${size}" height="${size}" />
			${config.badgeText ? `<text class="badge-text" x="${size / 2}" y="${size / 2}">${config.badgeText}</text>` : ''}
		</svg>
	`;

    const sharp = await getSharp();
    await sharp(Buffer.from(svgBadge))
        .png()
        .toFile(outputPath);
}

/**
 * Generate a rounded square badge
 */
async function generateRoundedSquareBadge(outputPath: string, config: IconConfig): Promise<void> {
    const size = 256;
    const radius = 32;
    const fill = hexToRgba(config.badgeColor);
    const svgBadge = `
		<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
			<defs>
				<style>
					.badge-rounded { fill: ${fill}; }
					.badge-text { fill: white; font-family: Arial, sans-serif; font-size: 120px; font-weight: bold; text-anchor: middle; dominant-baseline: middle; }
				</style>
			</defs>
			<rect class="badge-rounded" x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" />
			${config.badgeText ? `<text class="badge-text" x="${size / 2}" y="${size / 2}">${config.badgeText}</text>` : ''}
		</svg>
	`;

    const sharp = await getSharp();
    await sharp(Buffer.from(svgBadge))
        .png()
        .toFile(outputPath);
}

/**
 * Apply overlay badge to window using the C++ wrapper.
 * The wrapper finds the window by PID and sets the overlay via ITaskbarList3.
 */
export async function applyBadgeToWindow(config: IconConfig): Promise<void> {
    const wrapperExe = getWrapperExePath();
    const pid = config.hwnd; // Now contains PID string from getActiveWindowHandle()

    // Apply overlay badge
    if (config.badgeIconPath && fs.existsSync(config.badgeIconPath)) {
        try {
            await execFile(wrapperExe, ['--set-overlay', pid, config.badgeIconPath]);
        } catch (error: any) {
            throw new Error(`Failed to set overlay badge: ${error.message}`);
        }
    }

}

/**
 * Remove overlay badge from window using the C++ wrapper.
 */
export async function removeBadgeFromWindow(hwnd: string): Promise<void> {
    const wrapperExe = getWrapperExePath();
    try {
        await execFile(wrapperExe, ['--remove-overlay', hwnd]);
    } catch (error: any) {
        throw new Error(`Failed to remove overlay: ${error.message}`);
    }
}


