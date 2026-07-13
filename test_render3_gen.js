const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const match = html.match(/function renderLeads\(\) \{([\s\S]*?)\nfunction /);
let code = match[0].replace('function ', 'function test_');
code = code.substring(0, code.lastIndexOf('}')) + `
  console.log('Filtered length:', filtered.length);
  // console.log('tbody length:', tbody.innerHTML.length);
}
test_renderLeads();
`;

const mockLead = {
  id: "123",
  name: "Test Name",
  company: "Test Co",
  email: "test@example.com",
  createdAt: new Date().toISOString(),
  phone: "9999999999",
  score: null,
  clientStatus: "New",
  status: "New",
  queryType: "W"
};

const script = `
  const document = {
    querySelector: () => ({ value: '' }),
    getElementById: (id) => {
      return { innerHTML: '', textContent: '' };
    }
  };
  const filterStatus = 'All';
  const currentLeadType = 'W';
  const leads = [${JSON.stringify(mockLead)}];
  
  function formatLeadTime(value) { return value; }
  function emailValidationBadge(l) { return ''; }
  function scoreHtml(score, id) { return ''; }
  function updateClientStatus(id, val) {}
  
  ${code}
`;

fs.writeFileSync('test_render3.js', script);
