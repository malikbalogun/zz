const fs = require('fs');
const path = require('path');
const cssPath = path.join(__dirname, 'src', 'renderer', 'index.css');
const css = fs.readFileSync(cssPath, 'utf8');
const lines = css.split('\n');
let hasAnimations = false;
lines.forEach(line => {
    if (line.includes('animation') || line.includes('transition') || line.includes('@keyframes')) {
        console.log(line.trim());
        hasAnimations = true;
    }
});
if (!hasAnimations) {
    console.log('No animation/transition CSS found.');
}
// Also check for hover effects that might be missing
const hoverCount = css.match(/:hover/g)?.length || 0;
console.log(`Found ${hoverCount} hover selectors.`);