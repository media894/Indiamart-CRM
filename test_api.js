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

const start = new Date(new Date('2026-06-24T07:11:39.186Z').getTime() - 30 * 60 * 1000);
const end = new Date();

console.log('UTC Start:', start.toISOString(), 'Formatted Start (IST):', fmt(start));
console.log('UTC End:', end.toISOString(), 'Formatted End (IST):', fmt(end));

const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${apiKey}&start_time=${encodeURIComponent(fmt(start))}&end_time=${encodeURIComponent(fmt(end))}`;
console.log('URL:', url);

fetch(url)
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);
