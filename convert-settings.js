const fs = require('fs');
const path = require('path');
const fragmentPath = path.join(__dirname, 'settings-fragment.html');
let html = fs.readFileSync(fragmentPath, 'utf8');
// Remove class="hidden"
html = html.replace(' class="hidden"', '');
// Convert to JSX
let jsx = html
    .replace(/class=/g, 'className=')
    .replace(/<img (.*?)>/g, '<img $1 />')
    .replace(/<input (.*?)>/g, '<input $1 />')
    .replace(/<br>/g, '<br />')
    .replace(/<hr>/g, '<hr />')
    .replace(/\sonclick=/g, ' onClick=')
    .replace(/\sonchange=/g, ' onChange=')
    .replace(/\soninput=/g, ' onInput=')
    .replace(/style="(.*?)"/g, (match, p1) => {
        const styles = p1.split(';').filter(s => s.trim()).map(style => {
            const [key, val] = style.split(':').map(s => s.trim());
            const jsKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
            let jsVal = val;
            if (!val.startsWith("'") && !val.startsWith('"') && !/^\d+(px|em|rem|%|s|ms)?$/.test(val)) {
                jsVal = `'${val}'`;
            }
            return `${jsKey}: ${jsVal}`;
        }).join(', ');
        return `style={{ ${styles} }}`;
    })
    .replace(/&middot;/g, '·')
    .replace(/&amp;/g, '&')
    .replace(/->/g, '→')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<option([^>]*) selected>/g, '<option$1 selected={true}>')
    .replace(/<input([^>]*) checked>/g, '<input$1 checked={true} />')
    .replace(/<input([^>]*) checked \/>/g, '<input$1 checked={true} />');
// Fix style={{ ... }} where values are numeric without quotes
jsx = jsx.replace(/style=\{\{([^}]+)\}\}/g, (match, inner) => {
    const parts = inner.split(',').map(p => p.trim()).filter(p => p);
    const fixedParts = parts.map(part => {
        const colonIdx = part.indexOf(':');
        if (colonIdx === -1) return part;
        const key = part.substring(0, colonIdx).trim();
        let val = part.substring(colonIdx + 1).trim();
        if (!val.startsWith("'") && !val.startsWith('"') && !/^\d+(\.\d+)?(px|em|rem|%|s|ms)?$/.test(val)) {
            val = `'${val}'`;
        }
        return `${key}: ${val}`;
    });
    return `style={{ ${fixedParts.join(', ')} }}`;
});
// Fix onclick
jsx = jsx.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
jsx = jsx.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
// Ensure self-closing tags
jsx = jsx.replace(/<img([^>]*[^/])>/g, '<img$1 />');
jsx = jsx.replace(/<input([^>]*[^/])>/g, '<input$1 />');
// Remove any <html>, <head>, <meta>, <title>, <link>, <script> tags and their content
jsx = jsx.replace(/<html[^>]*>[\s\S]*<\/html>/g, '');
jsx = jsx.replace(/<head[^>]*>[\s\S]*<\/head>/g, '');
jsx = jsx.replace(/<meta[^>]*>/g, '');
jsx = jsx.replace(/<title[^>]*>[\s\S]*<\/title>/g, '');
jsx = jsx.replace(/<link[^>]*>/g, '');
jsx = jsx.replace(/<script[^>]*>[\s\S]*<\/script>/g, '');
// Create component
const component = `const SettingsView = () => {
  return (
    ${jsx}
  );
};

export default SettingsView;`;
const outPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'SettingsView.tsx');
fs.writeFileSync(outPath, component, 'utf8');
console.log('SettingsView.tsx updated');