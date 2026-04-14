const fs = require('fs');
const path = require('path');

const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const outputDir = path.join(__dirname, 'src', 'renderer', 'components', 'views');

// Ensure output directory exists
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

console.log('Reading HTML...');
const html = fs.readFileSync(htmlPath, 'utf8');

// Extract each view
const viewIds = ['dashboardView', 'panelsView', 'accountsView', 'monitoringView', 'searchView', 'settingsView'];
const viewMap = {};

for (let i = 0; i < viewIds.length; i++) {
  const viewId = viewIds[i];
  const startPattern = `<div id="${viewId}"`;
  const endPattern = i < viewIds.length - 1 ? `<div id="${viewIds[i + 1]}"` : '</div>\n</div>\n</div>\n</body>';
  
  const startIndex = html.indexOf(startPattern);
  let endIndex = html.indexOf(endPattern, startIndex);
  
  if (endIndex === -1) {
    // fallback: find next <div id="
    const nextDiv = html.indexOf('<div id="', startIndex + 1);
    if (nextDiv !== -1) {
      endIndex = nextDiv;
    } else {
      endIndex = html.length;
    }
  }
  
  let viewHtml = html.substring(startIndex, endIndex);
  
  // Clean up: remove class="hidden" from the opening div
  viewHtml = viewHtml.replace(`class="hidden"`, '');
  
  viewMap[viewId] = viewHtml;
  console.log(`Extracted ${viewId}: ${viewHtml.length} chars`);
}

// Convert to JSX components
for (const [viewId, html] of Object.entries(viewMap)) {
  // Simple conversion: replace class with className, remove inline style quotes issues
  let jsx = html
    .replace(/class=/g, 'className=')
    .replace(/<img (.*?)>/g, '<img $1 />')
    .replace(/<input (.*?)>/g, '<input $1 />')
    .replace(/<br>/g, '<br />')
    .replace(/<hr>/g, '<hr />')
    .replace(/\sonclick=/g, ' onClick=')
    .replace(/\sonchange=/g, ' onChange=')
    .replace(/\soninput=/g, ' onInput=')
    .replace(/style="(.*?)"/g, (match, p1) => {
      // Convert style string to object
      const styles = p1.split(';').filter(s => s.trim()).map(style => {
        const [key, val] = style.split(':').map(s => s.trim());
        const jsKey = key.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
        return `${jsKey}: '${val}'`;
      }).join(', ');
      return `style={{ ${styles} }}`;
    });
  
  // Wrap in React component
  const componentName = viewId.replace('View', '') + 'View';
  const componentNameCap = componentName.charAt(0).toUpperCase() + componentName.slice(1);
  
  const componentContent = `import React from 'react';

const ${componentNameCap} = () => {
  return (
    ${jsx}
  );
};

export default ${componentNameCap};`;
  
  const outputPath = path.join(outputDir, `${componentNameCap}.tsx`);
  fs.writeFileSync(outputPath, componentContent, 'utf8');
  console.log(`Written ${outputPath}`);
}

console.log('Done!');