require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;

async function exportLeads() {
  if (!MONGODB_URI) {
    console.error("MONGODB_URI is not set in .env file");
    return;
  }

  const client = new MongoClient(MONGODB_URI);

  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    console.log("Connected successfully.");

    const db = client.db(); 
    const crmCollection = db.collection('crm');

    const doc = await crmCollection.findOne({ _id: 'main' });

    if (!doc || !doc.leads || doc.leads.length === 0) {
      console.log("No leads found in the database.");
      return;
    }

    const leads = doc.leads;
    console.log(`Found ${leads.length} leads. Generating CSV...`);

    const headers = [
      'Name',
      'Company',
      'Mobile',
      'Email',
      'Requirement',
      'Location',
      'Date'
    ];

    let csvContent = headers.join(',') + '\n';

    leads.forEach(lead => {
      const clean = (str) => {
        if (!str) return '';
        let cleaned = String(str).replace(/"/g, '""').replace(/\r?\n|\r/g, ' ');
        if (cleaned.includes(',') || cleaned.includes('"')) {
          return `"${cleaned}"`;
        }
        return cleaned;
      };

      const row = [
        clean(lead.SENDER_NAME || lead.sender_name),
        clean(lead.SENDER_COMPANY || lead.sender_company),
        clean(lead.SENDER_MOBILE || lead.sender_mobile),
        clean(lead.SENDER_EMAIL || lead.sender_email),
        clean(lead.SUBJECT || lead.subject || lead.product || lead.message),
        clean(lead.SENDER_CITY || lead.sender_city || lead.SENDER_STATE),
        clean(lead.QUERY_TIME || lead.query_time)
      ];

      csvContent += row.join(',') + '\n';
    });

    const filePath = path.join(__dirname, 'leads_backup.csv');
    fs.writeFileSync(filePath, csvContent, 'utf8');

    console.log(`\nSUCCESS! 🎉`);
    console.log(`Your leads have been saved to: ${filePath}`);
    console.log(`You can now open 'leads_backup.csv' with Microsoft Excel.`);

  } catch (error) {
    console.error("Error exporting leads:", error);
  } finally {
    await client.close();
  }
}

exportLeads();
