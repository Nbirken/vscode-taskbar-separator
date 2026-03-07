export interface IconConfig {
    hwnd: string;
    badgeId: string;
    badgeColor: string;
    badgeStyle: 'circle' | 'square' | 'rounded-square';
    badgeText: string;
    badgeIconPath: string;
    workspaceFolder?: string;
}
