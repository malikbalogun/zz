const fs = require('fs');
const path = require('path');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
// Find accounts view
const start = html.indexOf('<div id="accountsView"');
const end = html.indexOf('<div id="monitoringView"', start);
if (start === -1 || end === -1) {
    console.error('Could not locate accounts view');
    process.exit(1);
}
let accountsHtml = html.substring(start, end);
console.log('Accounts HTML length:', accountsHtml.length);
// Remove class="hidden"
accountsHtml = accountsHtml.replace(' class="hidden"', '');
// Convert to JSX
let jsx = accountsHtml
    .replace(/class=/g, 'className=')
    .replace(/<img (.*?)>/g, '<img $1 />')
    .replace(/<input (.*?)>/g, '<input $1 />')
    .replace(/<br>/g, '<br />')
    .replace(/<hr>/g, '<hr />')
    .replace(/\sonclick=/g, ' onClick=')
    .replace(/\sonchange=/g, ' onChange=')
    .replace(/\soninput=/g, ' onInput=')
    .replace(/style="(.*?)"/g, (match, p1) => {
        // Convert style string to object
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
    .replace(/&nbsp;/g, ' ')
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
        // If already quoted, keep
        if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
            // good
        } else if (/^\d+(\.\d+)?(px|em|rem|%|s|ms)?$/.test(val)) {
            val = `'${val}'`;
        } else if (val === 'true' || val === 'false' || val === 'null' || val === 'undefined') {
            // keep as is
        } else {
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
// Create component
const component = `const AccountsView = () => {
  return (
    ${jsx}
  );
};

export default AccountsView;`;
const outputPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
fs.writeFileSync(outputPath, component, 'utf8');
console.log('Updated AccountsView.tsx');