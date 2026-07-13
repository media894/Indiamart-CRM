const { MongoClient } = require('mongodb');
const uri = 'mongodb+srv://natasha_db_user:wuLgB3zfeobqQ8ni@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority';

async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('indiamart_crm');
  const mainDoc = await db.collection('crm').findOne({ _id: 'main' });
  if (mainDoc) {
    let changed = false;
    
    // 1. Delete previous failed email log for Leelapathi Sagar
    const emailBefore = mainDoc.emails.length;
    mainDoc.emails = mainDoc.emails.filter(e => !(e.to === 'naidusagar0801@gmail.com' && e.subject.includes('Image Editing')));
    if (mainDoc.emails.length !== emailBefore) {
      console.log(`Deleted ${emailBefore - mainDoc.emails.length} failed email records.`);
      changed = true;
    }

    // 2. Find and reset Leelapathi Sagar lead properties
    
    const lead = mainDoc.leads.find(l => l.email === 'naidusagar0801@gmail.com');
    if (lead) {
      delete lead.emailSent;
      delete lead.lastEmailSentAt;
      lead.status = 'New';
      lead.clientStatus = 'New';
      changed = true;
      console.log('Reset Leelapathi Sagar lead properties successfully.');
    }

    // 3. Roll back the lastSyncTime by 2 hours
    if (mainDoc.lastSyncTime) {
      const rolledBackTime = new Date(new Date(mainDoc.lastSyncTime).getTime() - 2 * 60 * 60 * 1000).toISOString();
      mainDoc.lastSyncTime = rolledBackTime;
      changed = true;
      console.log('Rolled back lastSyncTime to:', rolledBackTime);
    }

    if (changed) {
      await db.collection('crm').updateOne(
        { _id: 'main' },
        { $set: { leads: mainDoc.leads, emails: mainDoc.emails, lastSyncTime: mainDoc.lastSyncTime } }
      );
      console.log('Database updated successfully.');
    } else {
      console.log('No changes made.');
    }
  }
  await client.close();
}

run().catch(console.error);
