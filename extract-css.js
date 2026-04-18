const fs = require('fs');
const path = require('path');

const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const cssPath = path.join(__dirname, 'src', 'renderer', 'mockup.css');

console.log('Reading HTML...');
const html = fs.readFileSync(htmlPath, 'utf8');

// Extract style content
const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
if (!styleMatch) {
    console.error('No style tag found');
    process.exit(1);
}

let css = styleMatch[1];
// Remove any CDATA or comment tags if present
css = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();

console.log(`CSS length: ${css.length} chars`);
fs.writeFileSync(cssPath, css, 'utf8');
console.log(`CSS written to ${cssPath}`);