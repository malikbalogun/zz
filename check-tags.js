const fs = require('fs');
const path = require('path');
const mockupPath = path.join(__dirname, 'accounts-new.html');
const mockup = fs.readFileSync(mockupPath, 'utf8');
console.log('Checking system tags in mockup:');
const tags = ['production', 'backup', 'admin', 'autorefresh', 'cookie-import', 'credential', 'detached'];
tags.forEach(tag => {
    const regex = new RegExp(`data-tag="${tag}"`, 'i');
    if (regex.test(mockup)) {
        console.log(`✅ ${tag} present`);
    } else {
        console.log(`❌ ${tag} MISSING`);
    }
});
// Also check user tags
const userTags = ['high-value', 'finance', 'legal'];
console.log('\nChecking user tags:');
userTags.forEach(tag => {
    const regex = new RegExp(`data-tag="${tag}"`, 'i');
    if (regex.test(mockup)) {
        console.log(`✅ ${tag} present`);
    } else {
        console.log(`❌ ${tag} MISSING`);
    }
});
// Check if Cookie‑Import, Credential, Detached are present in the React component
const reactPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
const react = fs.readFileSync(reactPath, 'utf8');
console.log('\nChecking React component for missing tags:');
tags.forEach(tag => {
    const regex = new RegExp(`data-tag="${tag}"`, 'i');
    if (regex.test(react)) {
        console.log(`✅ ${tag} present`);
    } else {
        console.log(`❌ ${tag} MISSING`);
    }
});