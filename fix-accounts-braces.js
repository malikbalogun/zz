const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let content = fs.readFileSync(filePath, 'utf8');
// Replace triple braces with double braces
content = content.replace(/style=\{\{\{/g, 'style={{');
content = content.replace(/\}\}\}/g, '}}');
fs.writeFileSync(filePath, content, 'utf8');
console.log('Fixed triple braces in AccountsView');