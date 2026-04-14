const fs = require('fs');
const path = require('path');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('<div id="settingsView"');
let depth = 0;
let i = start;
while (i < html.length) {
    if (html.substr(i, 4) === '<div') depth++;
    else if (html.substr(i, 6) === '</div>') {
        depth--;
        if (depth === 0) {
            const end = i + 6;
            const fragment = html.substring(start, end);
            console.log('Extracted fragment length:', fragment.length);
            fs.writeFileSync(path.join(__dirname, 'settings-fragment.html'), fragment, 'utf8');
            break;
        }
    }
    i++;
}
console.log('Done.');