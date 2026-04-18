const fs = require('fs');
const path = require('path');
const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  // Replace onClick="..." with onClick={() => {}}
  content = content.replace(/onClick="[^"]*"/g, 'onClick={() => {}}');
  // Replace onClick='...' with onClick={() => {}}
  content = content.replace(/onClick='[^']*'/g, 'onClick={() => {}}');
  // Also replace onclick (lowercase) already done but do again
  content = content.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
  content = content.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed onClick in ${file}`);
}

console.log('Done.');