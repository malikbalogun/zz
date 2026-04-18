const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

function fixStyleObject(styleStr) {
  // styleStr is like "display: flex, alignItems: center, gap: 6px"
  // Split by comma, but careful about commas inside nested structures (none)
  const parts = styleStr.split(',').map(p => p.trim()).filter(p => p);
  const fixedParts = parts.map(part => {
    const [key, ...valParts] = part.split(':').map(s => s.trim());
    if (!key || valParts.length === 0) return null;
    let val = valParts.join(':'); // in case value contains colon (like url)
    // Ensure value is quoted if it's not a number and not already quoted
    if (!/^\d+(px|em|rem|%|s|ms)?$/.test(val) && !val.startsWith("'") && !val.startsWith('"')) {
      val = `'${val}'`;
    }
    return `${key}: ${val}`;
  }).filter(Boolean);
  return `{ ${fixedParts.join(', ')} }`;
}

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix style={{ ... }} where values are unquoted
  content = content.replace(/style=\{\{([^}]+)\}\}/g, (match, inner) => {
    return `style=${fixStyleObject(inner)}`;
  });
  
  // Also fix style={{...}} with spaces
  content = content.replace(/style=\{\{\s*([^}]+)\s*\}\}/g, (match, inner) => {
    return `style=${fixStyleObject(inner)}`;
  });
  
  // Fix class= to className= (just in case)
  content = content.replace(/class=/g, 'className=');
  
  // Fix &middot; etc.
  content = content.replace(/&middot;/g, '·');
  content = content.replace(/&amp;/g, '&');
  content = content.replace(/&nbsp;/g, ' ');
  
  // Fix <br> to <br />
  content = content.replace(/<br>/g, '<br />');
  content = content.replace(/<hr>/g, '<hr />');
  
  // Fix <input ...> to <input ... />
  content = content.replace(/<input([^>]*[^/])>/g, '<input$1 />');
  
  // Fix <img ...> to <img ... />
  content = content.replace(/<img([^>]*[^/])>/g, '<img$1 />');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed ${file}`);
}

console.log('Done.');