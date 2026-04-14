const fs = require('fs');
const path = require('path');
const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  // Replace triple braces with double braces
  content = content.replace(/style=\{\{\{/g, 'style={{');
  content = content.replace(/\}\}\}/g, '}}');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed triple braces in ${file}`);
}

console.log('Done.');