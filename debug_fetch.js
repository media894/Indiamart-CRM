const apiKey = 'mRy7E79q4n3HT/et4n2J7lqPplTNmTBh';
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const fmt = d => {
  const dIST = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  const dd = String(dIST.getUTCDate()).padStart(2,'0');
  const mm = months[dIST.getUTCMonth()];
  const yyyy = dIST.getUTCFullYear();
  const hh = String(dIST.getUTCHours()).padStart(2,'0');
  const mi = String(dIST.getUTCMinutes()).padStart(2,'0');
  const ss = String(dIST.getUTCSeconds()).padStart(2,'0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
};

const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
const end = new Date();

const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${apiKey}&start_time=${encodeURIComponent(fmt(start))}&end_time=${encodeURIComponent(fmt(end))}`;
console.log('Fetching URL:', url);

fetch(url)
  .then(r => r.json())
  .then(data => {
    console.log('API RESPONSE CODE:', data.CODE);
    console.log('API RESPONSE STATUS:', data.STATUS);
    console.log('TOTAL RECORDS:', data.TOTAL_RECORDS);
    if (data.RESPONSE) {
      console.log('Total items in RESPONSE:', data.RESPONSE.length);
      data.RESPONSE.slice(0, 5).forEach((item, idx) => {
        console.log(`Record #${idx + 1}: Name=${item.SENDER_NAME}, Time=${item.QUERY_TIME}, Email=${item.SENDER_EMAIL}, Phone=${item.SENDER_MOBILE}, Product=${item.QUERY_PRODUCT_NAME}`);
      });
    } else {
      console.log('No RESPONSE key. Full raw response:', JSON.stringify(data, null, 2));
    }
  })
  .catch(console.error);
