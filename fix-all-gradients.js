const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
// Regex to match the whole style attribute with broken gradient
const regex = /style=\{\{\s*background:\s*''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\s*\}\}/g;
console.log('Replacing all broken gradient styles...');
let newContent = content.replace(regex, 'style={{ background: `linear-gradient(135deg, $1, $2)` }}');
if (newContent === content) {
    console.log('No matches found, trying alternative pattern...');
    // Maybe there is no space after colon
    const regex2 = /style=\{\{\s*background:\s*''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\s*\}\}/g;
    newContent = content.replace(regex2, 'style={{ background: `linear-gradient(135deg, $1, $2)` }}');
}
fs.writeFileSync(filePath, newContent, 'utf8');
console.log('Written.');
// Check for any remaining broken patterns
const lines = newContent.split('\n');
lines.forEach((line, idx) => {
    if (line.includes("''linear-gradient")) {
        console.log(`Line ${idx+1}: ${line}`);
    }
});