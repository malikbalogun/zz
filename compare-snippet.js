const fs = require('fs');
const path = require('path');
// Mockup HTML
const mockupPath = path.join(__dirname, 'accounts-new.html');
let mockup = fs.readFileSync(mockupPath, 'utf8');
// Find the All Accounts folder item
const mockupAllAccounts = mockup.match(/<div class="folder-item active" data-tag="all"[^>]*>[\s\S]*?<\/div>/)[0];
console.log('=== MOCKUP All Accounts folder item ===');
console.log(mockupAllAccounts);
console.log('='.repeat(80));
// React component
const reactPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'AccountsView.tsx');
let react = fs.readFileSync(reactPath, 'utf8');
// Find same in React (look for className="folder-item active")
const reactAllAccounts = react.match(/<div className="folder-item active" data-tag="all"[^>]*>[\s\S]*?<\/div>/)[0];
console.log('=== REACT All Accounts folder item ===');
console.log(reactAllAccounts);
console.log('='.repeat(80));
// Compare style attributes
const mockupStyle = mockupAllAccounts.match(/style="([^"]*)"/);
const reactStyle = reactAllAccounts.match(/style=\{\{([^}]+)\}\}/);
console.log('Mockup style:', mockupStyle ? mockupStyle[1] : 'none');
console.log('React style:', reactStyle ? reactStyle[1] : 'none');
// Compare inner HTML
const mockupInner = mockupAllAccounts.replace(/<div[^>]*>/, '').replace(/<\/div>$/, '').replace(/\s+/g, ' ').trim();
const reactInner = reactAllAccounts.replace(/<div[^>]*>/, '').replace(/<\/div>$/, '').replace(/\s+/g, ' ').trim();
if (mockupInner === reactInner) {
    console.log('✅ Inner HTML identical');
} else {
    console.log('❌ Inner HTML differs');
    console.log('Mockup inner:', mockupInner);
    console.log('React inner:', reactInner);
}