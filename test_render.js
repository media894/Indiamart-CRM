const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

// Extract renderLeads function
const match = html.match(/function renderLeads\(\) \{([\s\S]*?)\nfunction /);
if (!match) {
  console.log("Could not extract renderLeads");
  process.exit();
}

let code = match[0].replace('function ', ''); // removing the next function definition start
code = code.substring(0, code.lastIndexOf('}'));

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

try {
  eval(script);
  console.log("No syntax errors. renderLeads executed successfully.");
} catch(e) {
  console.log("Error during execution:", e);
}
