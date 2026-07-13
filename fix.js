const { MongoClient } = require('mongodb');
const uri = 'mongodb+srv://natasha_db_user:wuLgB3zfeobqQ8ni@mediaodd.wwilbgn.mongodb.net/indiamart_crm?retryWrites=true&w=majority';
async function run() {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  await db.collection('settings').updateOne({ _id: 'main' }, { $set: { indiamartSyncEnabled: true } });
  console.log('Enabled IndiaMART sync');
  process.exit(0);
}
run();
