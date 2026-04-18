const fs = require('fs');
const path = require('path');

// Fix SearchView line 39
let searchPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'SearchView.tsx');
let searchLines = fs.readFileSync(searchPath, 'utf8').split('\n');
if (searchLines.length >= 39) {
  // Replace the problematic line with corrected version
  searchLines[38] = `                            <div style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: '12px', padding: '14px 20px', marginBottom: '16px', fontSize: '14px', color: '#374151', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>Found <strong style={{ color: '#111827' }}>3 results</strong> across <strong style={{ color: '#111827' }}>2 accounts</strong> · <span style={{ color: '#9ca3af', fontSize: '13px' }}>Telegram sent if toggle is on</span></div>`;
}
fs.writeFileSync(searchPath, searchLines.join('\n'));

// Fix SettingsView line 78
let settingsPath = path.join(__dirname, 'src', 'renderer', 'components', 'views', 'SettingsView.tsx');
let settingsLines = fs.readFileSync(settingsPath, 'utf8').split('\n');
if (settingsLines.length >= 78) {
  // Replace line 78 (0-indexed 77)
  settingsLines[77] = `                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>`;
}
// Also fix line 110 (second grid)
if (settingsLines.length >= 110) {
  settingsLines[109] = `                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px' }}>`;
}
// Also fix line 232 (third grid)
if (settingsLines.length >= 232) {
  settingsLines[231] = `                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>`;
}
fs.writeFileSync(settingsPath, settingsLines.join('\n'));

console.log('Fixed remaining errors.');