const fs = require('fs');
const path = require('path');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
console.log('Total HTML length:', html.length);
// Find accounts view
const start = html.indexOf('<div id="accountsView"');
const end = html.indexOf('<div id="monitoringView"', start);
if (start === -1 || end === -1) {
    console.error('Could not locate accounts view');
    process.exit(1);
}
const accountsHtml = html.substring(start, end);
console.log('Accounts section length:', accountsHtml.length);
// Write to file
const outPath = path.join(__dirname, 'accounts-new.html');
fs.writeFileSync(outPath, accountsHtml, 'utf8');
console.log('Written to accounts-new.html');
// Compare with previous version (if exists)
const oldPath = path.join(__dirname, 'accounts-original.html');
if (fs.existsSync(oldPath)) {
    const old = fs.readFileSync(oldPath, 'utf8');
    if (old === accountsHtml) {
        console.log('Accounts section is UNCHANGED from previous mockup.');
    } else {
        console.log('Accounts section HAS CHANGED.');
        // Find first diff
        for (let i = 0; i < Math.min(old.length, accountsHtml.length); i++) {
            if (old[i] !== accountsHtml[i]) {
                console.log(`First diff at char ${i}: '${old[i]}' vs '${accountsHtml[i]}'`);
                break;
            }
        }
    }
}