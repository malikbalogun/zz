const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'SettingsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
// Fix gridTemplateColumns pattern
content = content.replace(/gridTemplateColumns:\s*'repeat\(2,\s*gap:\s*'20px'/g, "gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px'");
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed gridTemplateColumns');