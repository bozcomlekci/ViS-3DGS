import * as vscode from 'vscode';
import { SplatEditorProvider } from './splatEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    console.log('ViS-3DGS extension activating...');

    // Register the custom editor provider
    const provider = SplatEditorProvider.register(context);
    context.subscriptions.push(provider);

    // Status bar item
    const statusBarItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    statusBarItem.text = '$(eye) ViS-3DGS';
    statusBarItem.tooltip = '3D Gaussian Splatting Viewer';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    console.log('ViS-3DGS extension activated successfully');
}

export function deactivate() {
    console.log('ViS-3DGS extension deactivated');
}
