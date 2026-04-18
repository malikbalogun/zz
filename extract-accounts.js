const fs = require('fs');
const path = require('path');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('<div id="accountsView"');
const end = html.indexOf('<div id="monitoringView"');
const accountsHtml = html.substring(start, end);
console.log(accountsHtml.length);
// Write to file for comparison
fs.writeFileSync(path.join(__dirname, 'accounts-original.html'), accountsHtml, 'utf8');
console.log('Written to accounts-original.html');