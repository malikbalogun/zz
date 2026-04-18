const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let lines = fs.readFileSync(filePath, 'utf8').split('\n');
let changed = false;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("''linear-gradient(135deg', #")) {
        console.log(`Fixing line ${i+1}`);
        // Replace ''linear-gradient(135deg', #xxx, #yyy)' with `linear-gradient(135deg, #xxx, #yyy)`
        lines[i] = lines[i].replace(/''linear-gradient\(135deg',\s*(#[a-fA-F0-9]{6}),\s*(#[a-fA-F0-9]{6})'\)/, '`linear-gradient(135deg, $1, $2)`');
        changed = true;
    }
}
if (changed) {
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    console.log('Fixed lines');
    // Output fixed lines
    lines.forEach((line, idx) => {
        if (line.includes('linear-gradient')) {
            console.log(`Line ${idx+1}: ${line}`);
        }
    });
} else {
    console.log('No lines to fix');
}