const fs = require('fs');
const { execSync } = require('child_process');

const readmePath = 'README.md';

if (fs.existsSync(readmePath)) {
    const originalContent = fs.readFileSync(readmePath, 'utf8');
    
    // Remove the HTML logo completely
    let strippedContent = originalContent.replace(/<div align="center">\s*<img src="media\/icon\.png" width="400" alt="ViS-3DGS Logo">\s*<\/div>\n*/, '');
    
    // Remove funko.ply mention
    strippedContent = strippedContent.replace(/- Includes an example `\.ply` file at `media\/funko\.ply`\.\n?/g, '');
    
    // Remove the Building, Packaging & Installation section entirely
    strippedContent = strippedContent.replace(/## Building, Packaging & Installation[\s\S]*?(?=## References & Attributions)/, '');
    
    fs.writeFileSync(readmePath, strippedContent);
    try {
        console.log('Building and packaging VSIX without logo in README...');
        execSync('mkdir -p builds && echo y | npx -y @vscode/vsce package --no-dependencies --out builds/vis-3dgs-viewer.vsix', { stdio: 'inherit' });
    } finally {
        // Restore original content
        fs.writeFileSync(readmePath, originalContent);
        console.log('Restored original README.md for GitHub with logo.');
    }
} else {
    // Fallback if README doesn't exist
    execSync('mkdir -p builds && echo y | npx -y @vscode/vsce package --no-dependencies --out builds/vis-3dgs-viewer.vsix', { stdio: 'inherit' });
}
