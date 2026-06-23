const fetch = require('node-fetch');

async function search(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
      }
    });
    const html = await res.text();
    const snippets = [];
    const regex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const text = match[1].replace(/<[^>]*>/g, '').trim();
      snippets.push(text);
    }
    console.log(`Query: "${query}" -> Found ${snippets.length} results.`);
    console.log('Results:', snippets.slice(0, 3));
    console.log('---');
  } catch (e) {
    console.error('Error for query:', query, e.message);
  }
}

async function runTests() {
  await search('7871928693 truecaller');
  await search('7871928693 facebook');
  await search('7871928693 linkedin');
  await search('7871928693 name');
}

runTests();
