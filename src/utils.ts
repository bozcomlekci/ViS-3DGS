import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Generate a random nonce string for CSP.
 */
export function getNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

