const { MongoClient } = require('mongodb');
const uri = "mongodb+srv://natasha_db_user:wuLgB3zfeobqQ8ni@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority";

async function run() {
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    
    console.log("Fetching from MongoDB...");
    const cloudDoc = await db.collection('crm').findOne({ _id: 'main' });
    
    if (cloudDoc && cloudDoc.leads) {
      console.log("Sorting leads...");
      cloudDoc.leads.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    }
    
    if (cloudDoc && cloudDoc.emails) {
      console.log("Sorting emails...");
      cloudDoc.emails.sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
    }

    console.log("Saving sorted data back to MongoDB...");
    await db.collection('crm').updateOne(
      { _id: 'main' }, 
      { $set: { leads: cloudDoc.leads, emails: cloudDoc.emails } }
    );
    
    console.log("Sort fixed!");
  } catch (err) {
    console.error("Failed:", err);
  } finally {
    await client.close();
  }
}

run();
