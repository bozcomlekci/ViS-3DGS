import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { getNonce } from './utils';

/**
 * Minimal document model for Gaussian Splat files.
 * Read-only viewer — no edit/save needed.
 */
class SplatDocument implements vscode.CustomDocument {
    readonly uri: vscode.Uri;
    private readonly _onDidDispose = new vscode.EventEmitter<void>();
    public readonly onDidDispose = this._onDidDispose.event;

    constructor(uri: vscode.Uri) {
        this.uri = uri;
    }

    dispose(): void {
        this._onDidDispose.fire();
        this._onDidDispose.dispose();
    }
}

/**
 * Custom readonly editor provider for 3D Gaussian Splatting files.
 * Matches GaussianViewer architecture: minimal HTML shell + SuperSplat editor assets.
 */
export class SplatEditorProvider implements vscode.CustomReadonlyEditorProvider<SplatDocument> {
    public static readonly viewType = 'vis-3dgs.viewer';

    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        return vscode.window.registerCustomEditorProvider(
            SplatEditorProvider.viewType,
            new SplatEditorProvider(context),
            {
                webviewOptions: { retainContextWhenHidden: true },
                supportsMultipleEditorsPerDocument: false,
            }
        );
    }

    constructor(private readonly _context: vscode.ExtensionContext) {}

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        _token: vscode.CancellationToken
    ): Promise<SplatDocument> {
        return new SplatDocument(uri);
    }

    async resolveCustomEditor(
        document: SplatDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(this._context.extensionPath, 'media')),
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
            ],
        };

        webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview, document);

        webviewPanel.webview.onDidReceiveMessage((message) => {
            this.onMessage(document, webviewPanel, message);
        });
    }

    private onMessage(document: SplatDocument, webviewPanel: vscode.WebviewPanel, message: any): void {
        switch (message.type) {
            case 'ready':
                this.loadFile(document, webviewPanel);
                return;

            case 'requestStreamingFallback':
                this.handleStreamingFallback(document, webviewPanel);
                return;

            case 'requestChunk':
                this.handleChunkRequest(document, webviewPanel, message);
                return;
        }
    }

    private loadFile(document: SplatDocument, webviewPanel: vscode.WebviewPanel): void {
        const filePath = document.uri.fsPath;
        const stats = fs.statSync(filePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        const fileName = path.basename(filePath);

        console.log(`[ViS-3DGS] File ready: ${fileName} (${fileSizeMB.toFixed(2)}MB)`);

        webviewPanel.webview.postMessage({
            type: 'fileInfo',
            fileName,
            fileSize: stats.size,
            fileSizeMB,
        });

        // For files > 500MB, start streaming automatically. Otherwise, load direct.
        if (fileSizeMB > 500) {
            this.handleStreamingFallback(document, webviewPanel);
        } else {
            webviewPanel.webview.postMessage({
                type: 'requestDirectFile',
                fileUri: webviewPanel.webview.asWebviewUri(document.uri).toString(),
                filename: fileName
            });
        }
    }

    /**
     * Stream file to webview in binary chunks for large files.
     */
    private async handleStreamingFallback(document: SplatDocument, webviewPanel: vscode.WebviewPanel): Promise<void> {
        const filePath = document.uri.fsPath;
        const stats = fs.statSync(filePath);
        const fileSize = stats.size;
        const fileSizeMB = fileSize / (1024 * 1024);

        // Adaptive chunk size
        let chunkSize: number;
        if (fileSizeMB < 100) { chunkSize = 4 * 1024 * 1024; }
        else if (fileSizeMB < 500) { chunkSize = 8 * 1024 * 1024; }
        else if (fileSizeMB < 1500) { chunkSize = 16 * 1024 * 1024; }
        else { chunkSize = 32 * 1024 * 1024; }

        const totalChunks = Math.ceil(fileSize / chunkSize);

        webviewPanel.webview.postMessage({
            type: 'startStreaming',
            fileSize: fileSize,
            chunkSize,
            totalChunks,
            filename: path.basename(document.uri.fsPath),
        });

        const stream = fs.createReadStream(filePath, { highWaterMark: chunkSize });
        let chunkIndex = 0;

        for await (const chunk of stream) {
            const isLastChunk = chunkIndex === totalChunks - 1;
            webviewPanel.webview.postMessage({
                type: 'fileChunk',
                chunkIndex,
                totalChunks,
                data: new Uint8Array(chunk as Buffer),
                isLastChunk,
                encoding: 'binary',
            });
            chunkIndex++;
        }

        console.log(`[ViS-3DGS] Streaming complete: ${chunkIndex} chunks sent`);
    }

    /**
     * Handle on-demand chunk requests from the webview.
     */
    private handleChunkRequest(document: SplatDocument, webviewPanel: vscode.WebviewPanel, message: any): void {
        try {
            const { chunkIndex, chunkSize = 10 * 1024 * 1024 } = message;
            const filePath = document.uri.fsPath;
            const stats = fs.statSync(filePath);
            const fileSize = stats.size;
            const start = chunkIndex * chunkSize;
            const end = Math.min(start + chunkSize, fileSize);

            if (start >= fileSize) {
                webviewPanel.webview.postMessage({
                    type: 'chunkResponse',
                    chunkIndex,
                    data: null,
                    isLastChunk: true,
                });
                return;
            }

            const buffer = Buffer.alloc(end - start);
            const fd = fs.openSync(filePath, 'r');
            try {
                fs.readSync(fd, buffer, 0, end - start, start);
            } finally {
                fs.closeSync(fd);
            }

            webviewPanel.webview.postMessage({
                type: 'chunkResponse',
                chunkIndex,
                data: new Uint8Array(buffer),
                isLastChunk: end >= fileSize,
                totalSize: fileSize,
            });
        } catch (error) {
            webviewPanel.webview.postMessage({
                type: 'chunkError',
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private getMediaUri(webview: vscode.Webview, ...pathSegments: string[]): vscode.Uri {
        return webview.asWebviewUri(
            vscode.Uri.file(path.join(this._context.extensionPath, 'media', ...pathSegments))
        );
    }

    /**
     * Generate the HTML for the webview.
     * 
     * This follows GaussianViewer's architecture exactly:
     * - Minimal HTML shell with CSP, <base href> pointing at media/supersplat/
     * - Settings injected via data-settings meta tag (includes fileToLoad URI)
     * - SuperSplat's own index.js is loaded as a module in the body
     * - Our integration script handles VSCode communication
     */
    private getHtmlForWebview(webview: vscode.Webview, document: SplatDocument): string {
        const nonce = getNonce();

        const mediaUri = this.getMediaUri(webview, 'supersplat', '');
        const styleUri = this.getMediaUri(webview, 'supersplat', 'index.css');
        const integrationUri = this.getMediaUri(webview, 'vscode-supersplat.js');

        // Create a webview URI for the file itself so SuperSplat can fetch it
        const fileUri = webview.asWebviewUri(document.uri);
        const fileStat = fs.statSync(document.uri.fsPath);
        const fileSizeMB = fileStat.size / (1024 * 1024);
        const shouldUseStreaming = fileSizeMB > 500;

        const settings = {
            fileToLoad: shouldUseStreaming ? '' : fileUri.toString(),
            fileName: path.basename(document.uri.fsPath),
            backgroundColor: vscode.workspace.getConfiguration('vis-3dgs').get<string>('backgroundColor', '#000c18'),
            fileSizeMB,
            useStreaming: shouldUseStreaming,
        };

        const settingsMeta = `<meta id="vscode-supersplat-data" data-settings="${escapeAttr(JSON.stringify(settings))}">`;

        // Very permissive CSP to match GaussianViewer (SuperSplat needs lots of permissions)
        const csp = `default-src 'self' ${webview.cspSource} https: http: 'unsafe-eval' 'unsafe-inline' blob: data: *; img-src 'self' ${webview.cspSource} https: http: 'unsafe-eval' blob: data: *; style-src 'self' ${webview.cspSource} https: http: 'unsafe-inline' blob: data: *; script-src 'self' ${webview.cspSource} https: http: 'unsafe-inline' 'unsafe-eval' blob: data: *; connect-src 'self' ${webview.cspSource} https: http: blob: data: *; worker-src 'self' ${webview.cspSource} blob: data:; child-src 'self' ${webview.cspSource} blob: data:;`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="${csp}">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <base href="${mediaUri.toString()}">
    <link href="${styleUri.toString()}" rel="stylesheet" />
    ${settingsMeta}
    <title>ViS-3DGS Viewer</title>
</head>
<body>
    <script nonce="${nonce}" src="${integrationUri.toString()}"></script>
    <script type="module" src="${this.getMediaUri(webview, 'supersplat', 'index.js').toString()}"></script>
</body>
</html>`;
    }
}

function escapeAttr(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
