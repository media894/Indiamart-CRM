const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const match = html.match(/function renderLeads\(\) \{([\s\S]*?)\nfunction /);
if (match) {
  let code = match[0].replace('function renderLeads() {', '');
  code = code.substring(0, code.lastIndexOf('}'));
  fs.writeFileSync('extracted_code.js', code);
}
