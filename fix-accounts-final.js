const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
console.log('Fixing broken style attributes...');
// Fix style with broken linear-gradient
content = content.replace(/style=\{\{\s*background:\s*''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\s*\}\}/g,
    'style={{ background: `linear-gradient(135deg, $1, $2)` }}');
// Also fix if there are extra spaces
content = content.replace(/style=\{\{\s*background:\s*''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\s*\}\}/g,
    'style={{ background: `linear-gradient(135deg, $1, $2)` }}');
// Fix any remaining ''linear-gradient...' patterns not caught
content = content.replace(/''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\)/g,
    '`linear-gradient(135deg, $1, $2)`');
// Also fix style={{ background: ''linear-gradient(135deg', #xxx, #yyy)' }} pattern directly
content = content.replace(/background:\s*''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\)/g,
    'background: `linear-gradient(135deg, $1, $2)`');
// Remove any remaining HTML comments
content = content.replace(/<!--[\s\S]*?-->/g, '');
content = content.replace(/<!--[\s\S]*?-→/g, '');
// Replace any leftover onclick attributes
content = content.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
content = content.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
content = content.replace(/onClick="[^"]*"/g, 'onClick={() => {}}');
// Ensure self-closing tags
content = content.replace(/<input([^>]*[^/])>/g, '<input$1 />');
content = content.replace(/<img([^>]*[^/])>/g, '<img$1 />');
// Write back
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed style attributes.');
// Now compile to test
const { execSync } = require('child_process');
try {
    execSync('npm run build:ts', { cwd: __dirname, stdio: 'pipe' });
    console.log('TypeScript compilation succeeded');
} catch (e) {
    console.error('TypeScript compilation failed');
    const output = e.stdout?.toString() || e.message;
    console.error(output);
    // Extract line numbers of errors
    const lineMatches = output.match(/\((\d+),(\d+)\)/g);
    if (lineMatches) {
        const lines = [...new Set(lineMatches.map(m => m.match(/\d+/)[0]))];
        console.log('Error lines:', lines.join(', '));
        // Read those lines
        const linesArr = lines.map(l => parseInt(l));
        const fileLines = content.split('\n');
        linesArr.forEach(line => {
            console.log(`Line ${line}: ${fileLines[line - 1]}`);
        });
    }
}