const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
console.log('Replacing broken gradient strings...');
const regex = /''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\)/g;
const matches = content.match(regex);
if (matches) {
    console.log('Found', matches.length, 'matches');
    matches.forEach(m => console.log(m));
}
content = content.replace(regex, '`linear-gradient(135deg, $1, $2)`');
// Write back
fs.writeFileSync(filePath, content, 'utf8');
console.log('Replaced gradients.');
// Check lines again
const lines = content.split('\n');
[150, 178, 205, 232].forEach(line => {
    console.log(`Line ${line}: ${lines[line-1]}`);
});
// Compile
const { execSync } = require('child_process');
try {
    execSync('npm run build:ts', { cwd: __dirname, stdio: 'pipe' });
    console.log('TypeScript compilation succeeded');
} catch (e) {
    console.error('TypeScript compilation failed');
    const output = e.stdout?.toString() || e.message;
    console.error(output);
}