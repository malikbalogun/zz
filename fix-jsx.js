const fs = require('fs');
const path = require('path');

const viewsDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');
const files = fs.readdirSync(viewsDir).filter(f => f.endsWith('.tsx'));

for (const file of files) {
  const filePath = path.join(viewsDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  // Fix: /> inside div (like </div />) -> </div>
  content = content.replace(/<\/div \/>/g, '</div>');
  content = content.replace(/<\/span \/>/g, '</span>');
  content = content.replace(/<\/button \/>/g, '</button>');
  content = content.replace(/<\/input \/>/g, '</input>');
  
  // Fix: <input ... /></div> -> <input ... /></div> (already correct)
  // Remove extra slash before > in closing tags
  content = content.replace(/(<\/[a-zA-Z]+) \/>/g, '$1>');
  
  // Fix: <div ... /></div> (self-closing div) -> <div ...></div>
  content = content.replace(/<div([^>]*)\/>/g, '<div$1></div>');
  content = content.replace(/<span([^>]*)\/>/g, '<span$1></span>');
  content = content.replace(/<button([^>]*)\/>/g, '<button$1></button>');
  
  // Fix unescaped > in text content (replace > with &gt;) but careful not to break tags
  // This is tricky; we'll do a simple regex that matches > not preceded by < or =
  content = content.replace(/([^<=\s])>/g, '$1&gt;');
  
  // Fix unescaped < in text content
  content = content.replace(/</g, '&lt;');
  // But need to restore tags: replace &lt;([a-zA-Z]) with <$1
  content = content.replace(/&lt;([a-zA-Z][a-zA-Z0-9]*)/g, '<$1');
  // Also restore closing tags: &lt;/([a-zA-Z]) with </$1
  content = content.replace(/&lt;\/([a-zA-Z][a-zA-Z0-9]*)/g, '</$1');
  
  // Fix style attributes with missing quotes (already done)
  
  // Write back
  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Fixed ${file}`);
}

console.log('All files fixed.');