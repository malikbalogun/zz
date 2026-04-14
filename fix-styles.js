const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

function convertStyleString(styleStr) {
  // styleStr is like "color: red; background: blue;"
  const styles = styleStr.split(';').filter(s => s.trim()).map(style => {
    let [key, val] = style.split(':').map(s => s.trim());
    if (!key || !val) return null;
    // Convert CSS property to React style key (camelCase)
    const jsKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
    // Ensure value is quoted if needed
    let jsVal = val;
    if (jsVal.includes(' ') && !jsVal.startsWith("'") && !jsVal.startsWith('"')) {
      jsVal = `'${jsVal}'`;
    }
    return `${jsKey}: ${jsVal}`;
  }).filter(Boolean).join(', ');
  return `{{ ${styles} }}`;
}

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Replace style="..." with style={{ ... }}
  content = content.replace(/style="([^"]*)"/g, (match, styleContent) => {
    return `style=${convertStyleString(styleContent)}`;
  });
  
  // Replace onclick="..." with onClick={() => {}}
  content = content.replace(/onclick="([^"]*)"/g, 'onClick={() => {}}');
  content = content.replace(/onclick='([^']*)'/g, 'onClick={() => {}}');
  // Replace onchange, oninput, etc.
  content = content.replace(/onchange="([^"]*)"/g, 'onChange={() => {}}');
  content = content.replace(/oninput="([^"]*)"/g, 'onInput={() => {}}');
  content = content.replace(/onfocus="([^"]*)"/g, 'onFocus={() => {}}');
  content = content.replace(/onblur="([^"]*)"/g, 'onBlur={() => {}}');
  
  // Replace selected attribute with defaultValue or selected={true}
  content = content.replace(/<option([^>]*) selected>/g, '<option$1 selected={true}>');
  content = content.replace(/<option([^>]*) selected>/g, '<option$1 selected={true}>');
  
  // Replace checked attribute
  content = content.replace(/<input([^>]*) checked>/g, '<input$1 checked={true} />');
  content = content.replace(/<input([^>]*) checked \/>/g, '<input$1 checked={true} />');
  
  // Replace &middot; with · (unicode middle dot)
  content = content.replace(/&middot;/g, '·');
  content = content.replace(/&amp;/g, '&');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed styles and events in ${file}`);
}

console.log('Done.');