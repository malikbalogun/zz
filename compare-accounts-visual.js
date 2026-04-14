const fs = require('fs');
const path = require('path');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('<div id="accountsView"');
const end = html.indexOf('<div id="monitoringView"', start);
let mockupHtml = html.substring(start, end);
// Remove class="hidden"
mockupHtml = mockupHtml.replace(' class="hidden"', '');
// Remove HTML comments
mockupHtml = mockupHtml.replace(/<!--[\s\S]*?-->/g, '');
// Normalize whitespace
mockupHtml = mockupHtml.replace(/\s+/g, ' ').trim();
// Read React component
const reactPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let reactContent = fs.readFileSync(reactPath, 'utf8');
// Extract JSX part between return ( ... );
const match = reactContent.match(/return\s*\(\s*([\s\S]*?)\s*\)\s*;/);
if (!match) {
    console.error('Could not find return statement');
    process.exit(1);
}
let jsx = match[1].trim();
// Remove leading <div id="accountsView"> and trailing </div>? Actually we need to compare whole structure.
// Let's convert JSX back to HTML-like for comparison.
let htmlLike = jsx
    .replace(/className=/g, 'class=')
    .replace(/style=\{\{([^}]+)\}\}/g, (match, inner) => {
        // Convert style object back to string
        const pairs = inner.split(',').map(p => p.trim()).filter(p => p);
        const cssPairs = pairs.map(pair => {
            const colonIdx = pair.indexOf(':');
            if (colonIdx === -1) return '';
            const key = pair.substring(0, colonIdx).trim();
            let val = pair.substring(colonIdx + 1).trim();
            // Remove quotes and backticks
            val = val.replace(/^['"`]|['"`]$/g, '');
            // Convert camelCase to kebab-case
            const cssKey = key.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`);
            return `${cssKey}:${val}`;
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
// Now compare lengths
console.log('Mockup HTML length:', mockupHtml.length);
console.log('React‑converted length:', htmlLike.length);
// Check if they are equal
if (mockupHtml === htmlLike) {
    console.log('✅ 100% identical');
} else {
    console.log('❌ NOT identical');
    // Find first differing character
    for (let i = 0; i < Math.min(mockupHtml.length, htmlLike.length); i++) {
        if (mockupHtml[i] !== htmlLike[i]) {
            console.log(`First diff at char ${i}:`);
            console.log('Mockup:', mockupHtml.substring(i, i + 100));
            console.log('React:', htmlLike.substring(i, i + 100));
            break;
        }
    }
    // Also compute similarity percentage
    let same = 0;
    const minLen = Math.min(mockupHtml.length, htmlLike.length);
    for (let i = 0; i < minLen; i++) {
        if (mockupHtml[i] === htmlLike[i]) same++;
    }
    console.log(`Similarity: ${((same / minLen) * 100).toFixed(2)}%`);
}