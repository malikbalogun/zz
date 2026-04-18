const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const htmlPath = path.join('C:', 'Users', 'Administrator', 'Desktop', 'final_mockup_base_file.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const viewIds = ['dashboardView', 'panelsView', 'accountsView', 'monitoringView', 'searchView', 'settingsView'];
const results = [];
for (let i = 0; i < viewIds.length; i++) {
    const viewId = viewIds[i];
    const startPattern = `<div id="${viewId}"`;
    const endPattern = i < viewIds.length - 1 ? `<div id="${viewIds[i + 1]}"` : '</div>\n</div>\n</div>\n</body>';
    const start = html.indexOf(startPattern);
    let end = html.indexOf(endPattern, start);
    if (end === -1) {
        // fallback
        const nextDiv = html.indexOf('<div id="', start + 1);
        if (nextDiv !== -1) end = nextDiv;
        else end = html.length;
    }
    const viewHtml = html.substring(start, end);
    const hash = crypto.createHash('md5').update(viewHtml).digest('hex');
    results.push({ viewId, length: viewHtml.length, hash });
}
console.log('View lengths and hashes:');
results.forEach(r => console.log(`${r.viewId}: ${r.length} chars, hash ${r.hash}`));
// If we have previous hashes saved, compare; but for now just output.
// Save to file for later comparison
const outDir = path.join(__dirname, 'view-extracts');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);
results.forEach(r => {
    const viewHtml = html.substring(html.indexOf(`<div id="${r.viewId}"`), html.indexOf(`<div id="${viewIds[viewIds.indexOf(r.viewId) + 1]}"`, html.indexOf(`<div id="${r.viewId}"`)));
    fs.writeFileSync(path.join(outDir, `${r.viewId}.html`), viewHtml, 'utf8');
});
console.log('Extracts saved to', outDir);