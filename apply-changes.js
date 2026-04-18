const fs = require('fs');
const path = require('path');

// 1. Add missing system tags to AccountsView.tsx
const accountsPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let accounts = fs.readFileSync(accountsPath, 'utf8');

// Find the line after the autorefresh tag (closing div) and before "User Tags"
// We'll insert after the closing div of autorefresh (</div>)
const autorefreshEnd = accounts.indexOf('</div>\n                            </div>', accounts.indexOf('data-tag="autorefresh"'));
if (autorefreshEnd === -1) {
    console.error('Could not locate autorefresh tag');
    process.exit(1);
}
const insertPos = autorefreshEnd + '</div>\n                            </div>'.length;

// Define the three missing tags
const missingTags = [
    {
        tag: 'cookie-import',
        color: '#ea580c',
        icon: 'fa-cookie-bite',
        label: 'Cookie-Import'
    },
    {
        tag: 'credential',
        color: '#475569',
        icon: 'fa-key',
        label: 'Credential'
    },
    {
        tag: 'detached',
        color: '#9ca3af',
        icon: 'fa-unlink',
        label: 'Detached'
    }
];

const tagsHtml = missingTags.map(t => `
                            <div className="folder-item" data-tag="${t.tag}">
                                <div className="folder-name">
                                    <div className="folder-icon"><i className="fas ${t.icon}"></i></div>
                                    <span><span className="tag-circle" style={{ background: '${t.color}' }}></span> ${t.label}</span>
                                </div>
                                <div className="folder-count">0</div>
                            </div>`).join('');

// Insert after autorefresh, before any whitespace and next section
const before = accounts.substring(0, insertPos);
const after = accounts.substring(insertPos);
// Ensure there is a newline before the next section
const newContent = before + tagsHtml + after;
fs.writeFileSync(accountsPath, newContent, 'utf8');
console.log('Added missing system tags to AccountsView.tsx');

// 2. Modify CSS to keep sidebar as side card on all screen sizes
const cssPath = path.join(__dirname, 'src', 'renderer', 'index.css');
let css = fs.readFileSync(cssPath, 'utf8');

// Find the media query at max-width: 1200px
const startMedia = css.indexOf('@media (max-width: 1200px)');
if (startMedia === -1) {
    console.error('Could not find media query for max-width: 1200px');
    process.exit(1);
}
const endMedia = css.indexOf('@media', startMedia + 1);
const mediaBlock = css.substring(startMedia, endMedia !== -1 ? endMedia : css.length);

// Replace the problematic rules
let newMediaBlock = mediaBlock
    .replace('flex-direction: column;', '/* flex-direction: column; */')  // comment out
    .replace('width: 100% !important;', 'width: 200px !important;')
    .replace('.accounts-main {', '.accounts-main {')
    .replace('width: 100% !important;', 'width: calc(100% - 200px) !important; overflow-x: auto;');

// Ensure we only replace the first occurrence of width: 100% for folders-sidebar and accounts-main
// Let's do more precise replacement using regex
newMediaBlock = newMediaBlock.replace(/\.folders-sidebar\s*\{[^}]*width:\s*100% !important;[^}]*\}/, 
    `.folders-sidebar {
                width: 200px !important;
                margin-bottom: 20px;
            }`);
newMediaBlock = newMediaBlock.replace(/\.accounts-main\s*\{[^}]*width:\s*100% !important;[^}]*\}/,
    `.accounts-main {
                width: calc(100% - 200px) !important;
                overflow-x: auto;
            }`);

// Replace the block in the original CSS
const newCss = css.substring(0, startMedia) + newMediaBlock + (endMedia !== -1 ? css.substring(endMedia) : '');
fs.writeFileSync(cssPath, newCss, 'utf8');
console.log('Updated CSS to keep sidebar as side column.');

// Test TypeScript compilation
const { execSync } = require('child_process');
try {
    execSync('npm run build:ts', { cwd: __dirname, stdio: 'pipe' });
    console.log('✅ TypeScript compilation successful');
} catch (e) {
    console.error('❌ TypeScript compilation failed');
    console.error(e.stdout?.toString() || e.message);
}