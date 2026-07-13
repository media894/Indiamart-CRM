const fetch = require('node-fetch');
const { MongoClient } = require('mongodb');

async function retry() {
  let client;
  try {
    client = new MongoClient('mongodb://localhost:27017/indiamart-crm');
    await client.connect();
    const db = client.db();
    const doc = await db.collection('crm').findOne({ _id: 'main' });
    
    if (doc && doc.emails && doc.leads) {
      const failedEmails = doc.emails.filter(e => e.status === 'failed');
      console.log('Found ' + failedEmails.length + ' failed emails.');
      
      for (let fe of failedEmails) {
        const lead = doc.leads.find(l => l.id === fe.leadId);
        if (lead) {
          console.log('Retrying for ' + lead.email + ' (' + lead.name + ')');
          const newEmails = doc.emails.filter(e => e.id !== fe.id);
          // Delete the failed email record first
          await db.collection('crm').updateOne({ _id: 'main' }, { $set: { emails: newEmails } });
          
          // Trigger the send-email API
          try {
            const res = await fetch('http://localhost:3000/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ leadId: lead.id, autoResponse: true })
            });
            const json = await res.json();
            console.log('Result for ' + lead.name + ':', json);
          } catch (e) {
            console.error('Failed to trigger API for ' + lead.name, e.message);
          }
        }
      }
    }
  } catch (e) {
    console.error(e);
  } finally {
    if (client) await client.close();
  }
}

retry();
