const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

function fixStyleObject(objStr) {
  // Split by commas, but careful about commas inside nested functions (none)
  const parts = objStr.split(',').map(p => p.trim()).filter(p => p);
  const fixedParts = parts.map(part => {
    const colonIdx = part.indexOf(':');
    if (colonIdx === -1) return part;
    const key = part.substring(0, colonIdx).trim();
    let val = part.substring(colonIdx + 1).trim();
    // If value is already quoted, keep it
    if ((val.startsWith("'") && val.endsWith("'")) || (val.startsWith('"') && val.endsWith('"'))) {
      // good
    } else if (/^\d+(\.\d+)?(px|em|rem|%|s|ms)?$/.test(val)) {
      // numeric with optional unit
      val = `'${val}'`;
    } else if (val === 'true' || val === 'false' || val === 'null' || val === 'undefined') {
      // keep as is
    } else {
      // assume string
      val = `'${val}'`;
    }
    return `${key}: ${val}`;
  });
  return `{ ${fixedParts.join(', ')} }`;
}

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Find style={{ ... }} using a simple state machine to handle nested braces (unlikely)
  let newContent = '';
  let i = 0;
  while (i < content.length) {
    if (content.substr(i, 8) === 'style={{') {
      newContent += 'style={{';
      i += 8;
      let braceCount = 1;
      let start = i;
      while (i < content.length && braceCount > 0) {
        if (content[i] === '{') braceCount++;
        else if (content[i] === '}') braceCount--;
        i++;
      }
      // i now at position after closing brace
      let inner = content.substring(start, i - 1); // exclude the final }
      // Fix inner
      const fixed = fixStyleObject(inner);
      newContent += fixed;
      newContent += '}'; // add the final brace
    } else {
      newContent += content[i];
      i++;
    }
  }
  
  // Also replace onclick="..." with onClick={() => {}}
  newContent = newContent.replace(/onclick="[^"]*"/g, 'onClick={() => {}}');
  newContent = newContent.replace(/onclick='[^']*'/g, 'onClick={() => {}}');
  
  fs.writeFileSync(filePath, newContent, 'utf8');
  console.log(`Fixed ${file}`);
}

console.log('Done.');