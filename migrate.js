const fs = require('fs');
const { MongoClient } = require('mongodb');
const path = require('path');

require('dotenv').config();
const uri = process.env.MONGODB_URI || "mongodb+srv://natasha_db_user:Socialmediaodd2026@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority";
const DATA_FILE = path.join(__dirname, 'server', 'data.json');
const SETTINGS_FILE = path.join(__dirname, 'server', 'settings.json');

async function run() {
  console.log("Connecting to MongoDB...");
  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    
    console.log("Reading local data...");
    let localData = { leads: [], emails: [], followups: [] };
    if (fs.existsSync(DATA_FILE)) {
      localData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      console.log("No local data.json found. Skipping data merge.");
    }

    const cloudDoc = await db.collection('crm').findOne({ _id: 'main' }) || { leads: [], emails: [], followups: [] };
    
    console.log("Merging leads...");
    const leadMap = new Map((cloudDoc.leads || []).map(l => [l.id, l]));
    for (const l of localData.leads) leadMap.set(l.id, l);
    const mergedLeads = Array.from(leadMap.values());
    
    console.log("Merging emails...");
    const emailMap = new Map((cloudDoc.emails || []).map(e => [e.id, e]));
    for (const e of localData.emails) emailMap.set(e.id, e);
    const mergedEmails = Array.from(emailMap.values());

    console.log("Merging followups...");
    const followupMap = new Map((cloudDoc.followups || []).map(f => [f.id, f]));
    for (const f of (localData.followups || [])) followupMap.set(f.id, f);
    const mergedFollowups = Array.from(followupMap.values());

    console.log("Saving merged data to MongoDB...");
    await db.collection('crm').updateOne(
      { _id: 'main' }, 
      { $set: { leads: mergedLeads, emails: mergedEmails, followups: mergedFollowups } }, 
      { upsert: true }
    );
    
    if (fs.existsSync(SETTINGS_FILE)) {
        console.log("Merging settings...");
        const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const cloudSettings = await db.collection('settings').findOne({ _id: 'main' });
        const mergedSettings = { ...(cloudSettings ? cloudSettings.settings : {}), ...s };
        await db.collection('settings').updateOne({ _id: 'main' }, { $set: { settings: mergedSettings } }, { upsert: true });
    }

    console.log("Migration complete! You can now use MongoDB.");
  } catch (err) {
    console.error("Migration failed:", err);
  } finally {
    await client.close();
  }
}

run();
