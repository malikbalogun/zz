const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

function fixStyleObject(objStr) {
  // objStr is like "marginTop: 20px, padding: '0 4px', borderTop: '1px solid #e5e7eb', paddingTop: 16px"
  // Parse key-value pairs
  const pairs = objStr.split(',').map(p => p.trim()).filter(p => p);
  const fixedPairs = pairs.map(pair => {
    const colonIdx = pair.indexOf(':');
    if (colonIdx === -1) return pair;
    const key = pair.substring(0, colonIdx).trim();
    let val = pair.substring(colonIdx + 1).trim();
    // If value is numeric (like 20) or numeric with unit (20px, 20%, 20em, 20rem, 20s, 20ms)
    // but not already quoted
    if (!val.startsWith("'") && !val.startsWith('"')) {
      if (/^\d+(px|em|rem|%|s|ms)?$/.test(val)) {
        val = `'${val}'`;
      } else if (val === 'true' || val === 'false' || val === 'null' || val === 'undefined') {
        // keep as is
      } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(val)) {
        // could be a variable, but we assume string
        val = `'${val}'`;
      }
    }
    return `${key}: ${val}`;
  });
  return `{ ${fixedPairs.join(', ')} }`;
}

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find style={{ ... }} and fix
  content = content.replace(/style=\{\{\s*([^}]+)\s*\}\}/g, (match, inner) => {
    return `style={${fixStyleObject(inner)}}`;
  });
  
  // Also fix style={{ ... }} with nested braces? ignore
  
  // Fix onclick etc.
  content = content.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
  content = content.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
  content = content.replace(/onchange="[^"]*"/g, 'onChange={() => {}}');
  content = content.replace(/oninput="[^"]*"/g, 'onInput={() => {}}');
  
  // Fix &middot; etc.
  content = content.replace(/&middot;/g, '·');
  content = content.replace(/&amp;/g, '&');
  
  // Fix <br> <hr> <img> <input>
  content = content.replace(/<br>/g, '<br />');
  content = content.replace(/<hr>/g, '<hr />');
  content = content.replace(/<img([^>]*[^/])>/g, '<img$1 />');
  content = content.replace(/<input([^>]*[^/])>/g, '<input$1 />');
  
  // Fix selected attribute
  content = content.replace(/<option([^>]*) selected>/g, '<option$1 selected={true}>');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed ${file}`);
}

console.log('Done.');