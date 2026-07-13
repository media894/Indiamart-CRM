const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let html = fs.readFileSync(filePath, 'utf8');

// 1. Remove Export CSV Nav Button
html = html.replace(/<button class="nav-item" onclick="nav\('export',this\)">[\s\S]*?<\/button>/, '');

// 2. Remove Export CSV View
html = html.replace(/<!-- ── Export view ── -->[\s\S]*?<div class="view" id="view-export">[\s\S]*?<\/div>\s*<\/div>/, '');

// 3. New Premium Dark Mode CSS
const newCss = `
:root {
  /* Core Dark Theme */
  --bg: #09090b;
  --surface: #18181b;
  --border: #27272a;
  --border2: #3f3f46;
  --text: #f4f4f5;
  --muted: #a1a1aa;
  --hint: #71717a;
  
  /* Accent Colors (Vibrant) */
  --purple: #818cf8;
  --purple-lt: rgba(129, 140, 248, 0.15);
  --purple-dk: #c7d2fe;
  
  --teal: #34d399;
  --teal-lt: rgba(52, 211, 153, 0.15);
  
  --amber: #fbbf24;
  --amber-lt: rgba(251, 191, 36, 0.15);
  
  --blue: #60a5fa;
  --blue-lt: rgba(96, 165, 250, 0.15);
  
  --red: #f87171;
  --red-lt: rgba(248, 113, 113, 0.15);
  
  --green: #a3e635;
  --green-lt: rgba(163, 230, 53, 0.15);
  
  --gray: #d4d4d8;
  --gray-lt: rgba(212, 212, 216, 0.15);
  
  --radius: 10px;
  --radius-lg: 16px;
  
  --shadow-sm: 0 4px 6px -1px rgba(0, 0, 0, 0.3), 0 2px 4px -1px rgba(0, 0, 0, 0.2);
  --shadow-md: 0 10px 15px -3px rgba(0, 0, 0, 0.4), 0 4px 6px -2px rgba(0, 0, 0, 0.2);
  --shadow-lg: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 10px 10px -5px rgba(0, 0, 0, 0.3);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
body { 
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
  background: var(--bg); 
  color: var(--text); 
  font-size: 14px; 
  line-height: 1.5; 
  -webkit-font-smoothing: antialiased;
}
a { color: var(--purple); text-decoration: none; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border2); border-radius: 8px; }
::-webkit-scrollbar-thumb:hover { background: var(--hint); }

/* Layout */
.shell { display: grid; grid-template-columns: 240px 1fr; min-height: 100vh; }
.sidebar { 
  background: rgba(24, 24, 27, 0.6); 
  backdrop-filter: blur(12px); 
  border-right: 1px solid var(--border); 
  display: flex; flex-direction: column; 
}
.sidebar-logo { padding: 24px 20px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; }
.sidebar-logo .logo-mark { 
  width: 36px; height: 36px; border-radius: 10px; 
  background: linear-gradient(135deg, #6366f1, #8b5cf6); 
  display: flex; align-items: center; justify-content: center; 
  box-shadow: 0 0 15px rgba(99, 102, 241, 0.5); 
}
.sidebar-logo .logo-mark svg { width: 20px; height: 20px; stroke: #fff; fill: none; stroke-width: 2.2; }
.sidebar-logo h1 { font-size: 16px; font-weight: 700; letter-spacing: -0.3px; color: #fff; }
.sidebar-logo p { font-size: 11px; color: var(--muted); margin-top: 2px; }
.sidebar-nav { padding: 16px 12px; flex: 1; }
.nav-item { 
  display: flex; align-items: center; gap: 12px; padding: 10px 12px; 
  border-radius: var(--radius); cursor: pointer; font-size: 13.5px; font-weight: 500;
  color: var(--muted); transition: all 0.2s ease; border: none; background: none; width: 100%; text-align: left; margin-bottom: 4px;
}
.nav-item:hover { background: rgba(255,255,255,0.05); color: var(--text); }
.nav-item.active { background: var(--purple-lt); color: var(--purple); box-shadow: inset 2px 0 0 var(--purple); }
.nav-item svg { width: 18px; height: 18px; stroke: currentColor; fill: none; stroke-width: 2; }
.nav-badge { margin-left: auto; background: var(--red); color: #fff; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 12px; box-shadow: 0 0 8px rgba(248,113,113,0.4); }
.sidebar-footer { padding: 16px 12px; border-top: 1px solid var(--border); }
.sync-btn { 
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px; 
  border: 1px solid var(--border); border-radius: var(--radius); cursor: pointer; 
  font-size: 13px; font-weight: 500; background: rgba(255,255,255,0.03); color: var(--text); transition: all 0.2s; 
}
.sync-btn:hover { background: rgba(255,255,255,0.08); border-color: var(--border2); }
.sync-btn svg { width: 16px; height: 16px; stroke: var(--purple); fill: none; stroke-width: 2; }
.off-btn { margin-top: 10px; border-color: rgba(248,113,113,0.3); color: var(--red); }
.off-btn.is-off { background: rgba(248,113,113,0.1); border-color: var(--red); }
.off-btn.is-on { background: rgba(52,211,153,0.1); color: var(--teal); border-color: rgba(52,211,153,0.3); }

.main { overflow: hidden; display: flex; flex-direction: column; background: var(--bg); }
.topbar { 
  padding: 20px 32px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; 
  background: rgba(24, 24, 27, 0.7); backdrop-filter: blur(12px); position: sticky; top: 0; z-index: 10;
}
.topbar h2 { font-size: 18px; font-weight: 600; flex: 1; letter-spacing: -0.3px; color: #fff; }
.view { display: none; flex: 1; overflow-y: auto; }
.view.active { display: block; animation: fadein 0.2s ease-out; }

/* Buttons */
.btn { 
  display: inline-flex; align-items: center; gap: 8px; padding: 8px 16px; 
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 13px; font-weight: 500;
  cursor: pointer; background: rgba(255,255,255,0.05); color: var(--text); transition: all 0.2s; 
}
.btn:hover { background: rgba(255,255,255,0.1); border-color: var(--border2); }
.btn:active { transform: translateY(1px); }
.btn.primary { background: linear-gradient(135deg, #6366f1, #8b5cf6); color: #fff; border: none; box-shadow: 0 4px 12px rgba(99,102,241,0.3); }
.btn.primary:hover { opacity: 0.9; box-shadow: 0 6px 16px rgba(99,102,241,0.5); }
.btn.sm { padding: 6px 12px; font-size: 12px; }
.btn.danger { color: var(--red); border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.05); }
.btn.danger:hover { background: rgba(248,113,113,0.15); border-color: var(--red); }
.btn svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

/* Stats */
.stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; padding: 24px 32px 0; }
.stat { 
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); 
  padding: 20px; transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1); position: relative; overflow: hidden;
}
.stat::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 3px; background: linear-gradient(90deg, #6366f1, #8b5cf6); opacity: 0; transition: opacity 0.3s; }
.stat:hover { transform: translateY(-3px); box-shadow: var(--shadow-lg); border-color: var(--border2); }
.stat:hover::before { opacity: 1; }
.stat-val { font-size: 28px; font-weight: 700; letter-spacing: -1px; color: #fff; }
.stat-lbl { font-size: 12px; color: var(--muted); margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }

/* Filters */
.filters { display: flex; align-items: center; gap: 10px; padding: 24px 32px 16px; flex-wrap: wrap; }
.pill { 
  padding: 6px 16px; border-radius: 24px; font-size: 13px; font-weight: 500; border: 1px solid var(--border); 
  cursor: pointer; background: rgba(255,255,255,0.03); color: var(--muted); transition: all 0.2s; 
}
.pill:hover { background: rgba(255,255,255,0.08); color: var(--text); }
.pill.active { background: var(--purple-lt); color: var(--purple); border-color: var(--purple); }
.search-box { 
  flex: 1; max-width: 320px; padding: 8px 16px; border: 1px solid var(--border); border-radius: 20px; 
  font-size: 13px; background: rgba(0,0,0,0.2); color: #fff; transition: all 0.2s; 
}
.search-box:focus { outline: none; border-color: var(--purple); box-shadow: 0 0 0 3px var(--purple-lt); background: var(--surface); }

/* Table */
.leads-table { margin: 0 32px 32px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); box-shadow: var(--shadow-md); overflow: hidden; }
table { width: 100%; border-collapse: collapse; text-align: left; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); padding: 14px 20px; background: rgba(0,0,0,0.2); border-bottom: 1px solid var(--border); font-weight: 600; }
td { padding: 16px 20px; border-bottom: 1px solid var(--border); vertical-align: middle; font-size: 13.5px; color: var(--gray); }
tr { transition: background 0.15s; }
tr:hover { background: rgba(255,255,255,0.02); }
tr:last-child td { border-bottom: none; }
.lead-name-cell { font-weight: 600; color: #fff; cursor: pointer; transition: color 0.15s; }
.lead-name-cell:hover { color: var(--purple); }
.lead-sub { font-size: 12px; color: var(--hint); margin-top: 4px; }

/* Badges */
.badge { display: inline-flex; align-items: center; padding: 4px 10px; border-radius: 12px; font-size: 11.5px; font-weight: 600; white-space: nowrap; }
.badge.hot { background: var(--amber-lt); color: var(--amber); border: 1px solid rgba(251,191,36,0.2); }
.badge.warm { background: var(--blue-lt); color: var(--blue); border: 1px solid rgba(96,165,250,0.2); }
.badge.cold { background: var(--gray-lt); color: var(--gray); border: 1px solid rgba(212,212,216,0.2); }
.badge.new { background: var(--green-lt); color: var(--green); border: 1px solid rgba(163,230,53,0.2); }
.badge.client { background: var(--teal-lt); color: var(--teal); border: 1px solid rgba(52,211,153,0.2); }
.badge.lost { background: var(--red-lt); color: var(--red); border: 1px solid rgba(248,113,113,0.2); }
.badge.prospect { background: var(--purple-lt); color: var(--purple); border: 1px solid rgba(129,140,248,0.2); }

/* Score */
.score-wrap { display: flex; align-items: center; gap: 8px; transition: all 0.2s; }
.score-bar { height: 6px; width: 64px; background: rgba(255,255,255,0.05); border-radius: 4px; overflow: hidden; box-shadow: inset 0 1px 2px rgba(0,0,0,0.5); }
.score-fill { height: 100%; border-radius: 4px; box-shadow: 0 0 10px currentColor; }
.score-num { font-size: 13px; font-weight: 600; text-shadow: 0 0 10px rgba(255,255,255,0.2); }

/* Modals & Overlays */
.overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 1000; align-items: center; justify-content: center; }
.overlay.open { display: flex; animation: fadein 0.2s ease-out; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 32px; width: min(600px, 95vw); max-height: 90vh; overflow-y: auto; box-shadow: var(--shadow-lg); animation: modalin 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
@keyframes modalin { from { opacity: 0; transform: translateY(20px) scale(0.95); } to { opacity: 1; transform: translateY(0) scale(1); } }
.modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; }
.modal-title { font-size: 18px; font-weight: 600; color: #fff; }
.modal-close { background: rgba(255,255,255,0.05); border: none; cursor: pointer; color: var(--muted); padding: 6px; border-radius: 8px; transition: all 0.2s; }
.modal-close:hover { color: #fff; background: rgba(255,255,255,0.1); }

/* Forms */
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
.field input, .field select, .field textarea { width: 100%; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius); font-size: 14px; background: rgba(0,0,0,0.2); color: #fff; transition: all 0.2s; }
.field input:focus, .field select:focus, .field textarea:focus { outline: none; border-color: var(--purple); box-shadow: 0 0 0 3px var(--purple-lt); background: var(--surface); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.row3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }

select { appearance: none; background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a1a1aa' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 32px !important; }
option { background: var(--surface); color: #fff; }

/* AI Card */
.ai-card { background: linear-gradient(145deg, rgba(129,140,248,0.1), rgba(129,140,248,0.02)); border: 1px solid rgba(129,140,248,0.2); border-radius: var(--radius-lg); padding: 20px; margin-bottom: 20px; }
.ai-summary { font-size: 14px; line-height: 1.6; color: var(--gray); border-left: 3px solid var(--purple); padding-left: 14px; margin: 12px 0; }

/* Utilities */
.toast { position: fixed; bottom: 30px; right: 30px; background: #fff; color: #000; font-weight: 600; padding: 12px 24px; border-radius: var(--radius); font-size: 14px; z-index: 9999; opacity: 0; transform: translateY(20px); transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275); box-shadow: var(--shadow-lg); }
.toast.show { opacity: 1; transform: translateY(0); }
.toast.success { background: var(--teal); color: #000; }
.toast.error { background: var(--red); color: #fff; }
.empty { text-align: center; padding: 64px; color: var(--hint); }
.empty svg { width: 48px; height: 48px; stroke: var(--border2); margin-bottom: 16px; }

@keyframes spin { to { transform: rotate(360deg); } }
@keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
`;

// Extract the existing style block and replace it
const styleStart = html.indexOf('<style>');
const styleEnd = html.indexOf('</style>');

if (styleStart !== -1 && styleEnd !== -1) {
  html = html.substring(0, styleStart + 7) + '\n' + newCss + '\n' + html.substring(styleEnd);
}

// Write the updated HTML back
fs.writeFileSync(filePath, html, 'utf8');
console.log('Successfully applied premium UI overhaul and removed Export CSV page.');
