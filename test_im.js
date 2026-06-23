const apiKey = 'mRy7E79q4n3HT/et4n2J7lqPplTNmTBh';
const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmt = d => {
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = months[d.getMonth()];
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2,'0');
  const mi = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
};
const end = new Date();
const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${apiKey}&start_time=${encodeURIComponent(fmt(start))}&end_time=${encodeURIComponent(fmt(end))}`;
console.log("Fetching URL:", url);

fetch(url)
  .then(r => r.text())
  .then(txt => {
    console.log("Response:", txt.slice(0, 1000));
  })
  .catch(console.error);
