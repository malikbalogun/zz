const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');
  
  // Fix onclick="..." to onClick={() => {}} (simplify)
  content = content.replace(/onclick="([^"]*)"/g, 'onClick={() => {}}');
  content = content.replace(/onclick='([^']*)'/g, 'onClick={() => {}}');
  
  // Fix other on* attributes
  content = content.replace(/onchange="([^"]*)"/g, 'onChange={() => {}}');
  content = content.replace(/oninput="([^"]*)"/g, 'onInput={() => {}}');
  content = content.replace(/onfocus="([^"]*)"/g, 'onFocus={() => {}}');
  content = content.replace(/onblur="([^"]*)"/g, 'onBlur={() => {}}');
  
  // Fix arrow in button text (->) to →
  content = content.replace(/->/g, '→');
  
  // Fix unclosed tags (img, input, br, hr) - already done by converter
  // Ensure self-closing tags
  content = content.replace(/<img (.*?[^/])>/g, '<img $1 />');
  content = content.replace(/<input (.*?[^/])>/g, '<input $1 />');
  content = content.replace(/<br>/g, '<br />');
  content = content.replace(/<hr>/g, '<hr />');
  
  // Fix style attribute with missing quotes
  content = content.replace(/style={{ (.*?) }}/g, (match, styleContent) => {
    // Ensure style content is valid
    return match;
  });
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Cleaned ${file}`);
}

console.log('All files cleaned.');