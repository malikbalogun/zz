const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  // Fix repeat(2, gap: '20px' -> repeat(2, 1fr)', gap: '20px'
  content = content.replace(/repeat\((\d+),\s*gap:\s*'(\d+px)'/g, "repeat($1, 1fr)', gap: '$2");
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed repeat in ${file}`);
}

console.log('Done.');