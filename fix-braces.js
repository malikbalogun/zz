const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix style={ ... } where there's only single braces (should be double)
  // Match style={ ... } but not style={{ ... }}
  content = content.replace(/style=\{([^{][^}]*)\}/g, (match, inner) => {
    // Check if inner already has proper object syntax; if it's like "display: 'flex'", wrap in another braces
    return `style={{${inner}}}`;
  });
  
  // Also fix style={{ ... }} where inner might have missing quotes (but we already did)
  
  // Fix selected={true} on option tags (ensure boolean)
  content = content.replace(/<option([^>]*) selected>/g, '<option$1 selected={true}>');
  
  // Fix checked={true}
  content = content.replace(/<input([^>]*) checked>/g, '<input$1 checked={true} />');
  content = content.replace(/<input([^>]*) checked \/>/g, '<input$1 checked={true} />');
  
  // Ensure self-closing tags for img, input, br, hr
  content = content.replace(/<img([^>]*[^/])>/g, '<img$1 />');
  content = content.replace(/<input([^>]*[^/])>/g, '<input$1 />');
  content = content.replace(/<br>/g, '<br />');
  content = content.replace(/<hr>/g, '<hr />');
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed braces in ${file}`);
}

console.log('Done.');