const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
console.log('Original length:', content.length);
// 1. Remove HTML comments (including weird -→ delimiter)
content = content.replace(/<!--[\s\S]*?-->/g, '');
content = content.replace(/<!--[\s\S]*?-→/g, '');
// 2. Fix broken style attributes: ''linear-gradient(135deg', #xxx, #yyy)' -> 'linear-gradient(135deg, #xxx, #yyy)'
content = content.replace(/style=\{\{ background: ''linear-gradient\(135deg', (#[a-fA-F0-9]{6}), (#[a-fA-F0-9]{6})' \}\}/g, 'style={{ background: `linear-gradient(135deg, $1, $2)` }}');
// Actually there are multiple occurrences with different colors. Let's do a more general replacement.
content = content.replace(/''linear-gradient\(135deg', (#[a-fA-F0-9]{6}), (#[a-fA-F0-9]{6})'\)/g, '`linear-gradient(135deg, $1, $2)`');
// Also for other patterns: ''linear-gradient(135deg', #xxx, #xxx)' 
content = content.replace(/''linear-gradient\(135deg', (#[a-fA-F0-9]{6}), (#[a-fA-F0-9]{6})'\)/g, '`linear-gradient(135deg, $1, $2)`');
// 3. Replace onclick="..." with onClick={() => {}}
content = content.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
content = content.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
// 4. Replace onClick="..." already present
content = content.replace(/onClick="[^"]*"/g, 'onClick={() => {}}');
// 5. Ensure self-closing tags
content = content.replace(/<input([^>]*[^/])>/g, '<input$1 />');
content = content.replace(/<img([^>]*[^/])>/g, '<img$1 />');
// 6. Remove everything after the closing div of accountsView (look for </div> that closes the outermost div)
// We'll find the last </div> that matches the opening <div id="accountsView"> depth.
// Simpler: remove everything after the comment that starts monitoring view.
const monitoringIndex = content.indexOf('<!-- MONITORING VIEW');
if (monitoringIndex !== -1) {
    content = content.substring(0, monitoringIndex);
}
// Ensure there are enough closing divs? Let's count opening and closing divs from the start.
let divCount = 0;
let i = 0;
while (i < content.length) {
    if (content.substr(i, 4) === '<div') {
        divCount++;
        i += 4;
    } else if (content.substr(i, 6) === '</div>') {
        divCount--;
        i += 6;
    } else {
        i++;
    }
}
console.log('Div imbalance:', divCount);
// If negative, need to add missing closing divs at end.
if (divCount > 0) {
    content += '</div>'.repeat(divCount);
} else if (divCount < 0) {
    // remove extra closing divs? but unlikely
    console.warn('Extra closing divs');
}
// 7. Fix any remaining style={{ ... }} with missing commas
// This is complex; we'll rely on the existing conversion.
// Write back
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed AccountsView.tsx');
// Now run tsc to see if errors persist
const { execSync } = require('child_process');
try {
    execSync('npm run build:ts', { cwd: __dirname, stdio: 'pipe' });
    console.log('TypeScript compilation succeeded');
} catch (e) {
    console.error('TypeScript compilation failed');
    console.error(e.stdout?.toString() || e.message);
}