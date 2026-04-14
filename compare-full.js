const fs = require('fs');
const path = require('path');

// --- MOCKUP ---
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
let start = html.indexOf('<div id="accountsView"');
let end = html.indexOf('<div id="monitoringView"', start);
let mockup = html.substring(start, end);
// Remove hidden class
mockup = mockup.replace(' class="hidden"', '');
// Remove HTML comments
mockup = mockup.replace(/<!--[\s\S]*?-->/g, '');
// Normalize whitespace (keep single spaces)
mockup = mockup.replace(/\s+/g, ' ').trim();

// --- REACT ---
const reactPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let react = fs.readFileSync(reactPath, 'utf8');
// Extract JSX between return ( ... );
const match = react.match(/return\s*\(\s*([\s\S]*?)\s*\)\s*;/);
if (!match) {
    console.error('Could not find return statement');
    process.exit(1);
}
let jsx = match[1].trim();

// Convert JSX to HTML-like
let htmlLike = jsx
    .replace(/className=/g, 'class=')
    .replace(/style=\{\{([^}]+)\}\}/g, (match, inner) => {
        // Parse style object
        const pairs = inner.split(',').map(p => p.trim()).filter(p => p);
        const cssPairs = pairs.map(pair => {
            const colonIdx = pair.indexOf(':');
            if (colonIdx === -1) return '';
            let key = pair.substring(0, colonIdx).trim();
            let val = pair.substring(colonIdx + 1).trim();
            // Remove surrounding quotes and backticks
            val = val.replace(/^['"`]|['"`]$/g, '');
            // Convert camelCase to kebab-case
            key = key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
            return `${key}:${val}`;
        }).filter(Boolean);
        return `style="${cssPairs.join(';')}"`;
    })
    .replace(/<img ([^>]*)\/>/g, '<img $1>')
    .replace(/<input ([^>]*)\/>/g, '<input $1>')
    .replace(/<br \/>/g, '<br>')
    .replace(/<hr \/>/g, '<hr>')
    .replace(/onClick=\{\(\) => \{\}\}/g, '')
    .replace(/checked=\{true\}/g, 'checked')
    .replace(/selected=\{true\}/g, 'selected')
    .replace(/\s+/g, ' ')
    .trim();

// Remove any empty style attributes
htmlLike = htmlLike.replace(/ style=""/g, '');

console.log('Mockup length:', mockup.length);
console.log('React‑converted length:', htmlLike.length);

// Compare character by character
let diffPos = -1;
for (let i = 0; i < Math.min(mockup.length, htmlLike.length); i++) {
    if (mockup[i] !== htmlLike[i]) {
        diffPos = i;
        break;
    }
}
if (diffPos === -1 && mockup.length === htmlLike.length) {
    console.log('✅ 100% identical after normalization.');
    process.exit(0);
}

console.log('❌ NOT identical.');
console.log('First difference at position', diffPos);
console.log('--- Mockup context ---');
console.log(mockup.substring(diffPos - 50, diffPos + 150));
console.log('--- React context ---');
console.log(htmlLike.substring(diffPos - 50, diffPos + 150));
console.log('---');

// Let's also compare specific sections: folders-sidebar and accounts-main
const getSection = (html, id) => {
    const start = html.indexOf(`<div class="${id}"`);
    if (start === -1) return null;
    let depth = 0;
    let i = start;
    while (i < html.length) {
        if (html.substr(i, 4) === '<div') depth++;
        else if (html.substr(i, 6) === '</div>') {
            depth--;
            if (depth === 0) return html.substring(start, i + 6);
        }
        i++;
    }
    return null;
};

const mockupSidebar = getSection(mockup, 'folders-sidebar');
const reactSidebar = getSection(htmlLike, 'folders-sidebar');
console.log('Sidebar comparison:', mockupSidebar && reactSidebar ? 'both found' : 'missing');
if (mockupSidebar && reactSidebar) {
    if (mockupSidebar === reactSidebar) {
        console.log('✅ Sidebar identical');
    } else {
        console.log('❌ Sidebar differs');
        // Find diff
        for (let i = 0; i < Math.min(mockupSidebar.length, reactSidebar.length); i++) {
            if (mockupSidebar[i] !== reactSidebar[i]) {
                console.log('Diff at', i);
                console.log('Mockup:', mockupSidebar.substring(i, i + 100));
                console.log('React:', reactSidebar.substring(i, i + 100));
                break;
            }
        }
    }
}