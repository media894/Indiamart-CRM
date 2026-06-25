require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const nodemailer = require('nodemailer');
const dns = require('dns').promises;
const imaps = require('imap-simple');
const simpleParser = require('mailparser').simpleParser;
const xlsx = require('xlsx');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/indiamart-crm';

let db = null;
let client = null;

async function connectToMongo() {
  try {
    client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db();
    console.log('✓ Connected to MongoDB');
  } catch (err) {
    console.error('❌ Failed to connect to MongoDB:', err);
    process.exit(1);
  }
}

const DATA_FILE = path.join(__dirname, 'data.json');
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
const UPLOADS_DIR = path.join(__dirname, '../public/assets');
let imapSyncInProgress = false;
let lastAutoEmailSentAt = 0; // timestamp to track rate limiting
const AUTO_EMAIL_DELAY_MS = 20000; // 20 seconds between emails = 3 emails per minute (safe Gmail rate limit)

// ─── Live Activity Stream (SSE) ───────────────────────────────────────────────
const activityLog = []; // in-memory activity history (last 200)
const sseClients = new Set(); // connected browser clients

function pushActivity(type, title, detail, extra = {}) {
  const event = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 4),
    type,      // 'new_lead' | 'email_sent' | 'email_failed' | 'sync' | 'info'
    title,
    detail,
    time: new Date().toISOString(),
    ...extra
  };
  activityLog.unshift(event);
  if (activityLog.length > 200) activityLog.length = 200;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
  return event;
}

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '../public')));

const upload = multer({ dest: UPLOADS_DIR });

async function loadData() {
  if (!db) {
    if (!fs.existsSync(DATA_FILE)) return { leads: [], emails: [], followups: [] };
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      let changed = false;
      if (data.emails) {
        const seen = new Set();
        const uniqueEmails = [];
        const leadMap = new Map((data.leads || []).map(l => [l.id, l.email]));
        for (const e of data.emails) {
          if (e.direction === 'received') {
            const leadEmail = leadMap.get(e.leadId) || '';
            const key = `${leadEmail.toLowerCase().trim()}_${(e.subject || '').trim()}_${e.receivedAt || ''}`;
            if (seen.has(key)) {
              continue;
            }
            seen.add(key);
          }
          uniqueEmails.push(e);
        }
        if (uniqueEmails.length !== data.emails.length) {
          data.emails = uniqueEmails;
          changed = true;
        }
      }
      if (reconcileEmailLeadLinks(data)) changed = true;
      if (changed) fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      return data;
    } catch {
      return { leads: [], emails: [], followups: [] };
    }
  }

  try {
    const doc = await db.collection('crm').findOne({ _id: 'main' });
    if (!doc) {
      const initial = { _id: 'main', leads: [], emails: [], followups: [] };
      await db.collection('crm').insertOne(initial);
      return initial;
    }
    let changed = false;
    if (doc.emails) {
      const seen = new Set();
      const uniqueEmails = [];
      const leadMap = new Map((doc.leads || []).map(l => [l.id, l.email]));
      for (const e of doc.emails) {
        if (e.direction === 'received') {
          const leadEmail = leadMap.get(e.leadId) || '';
          const key = `${leadEmail.toLowerCase().trim()}_${(e.subject || '').trim()}_${e.receivedAt || ''}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
        }
        uniqueEmails.push(e);
      }
      if (uniqueEmails.length !== doc.emails.length) {
        doc.emails = uniqueEmails;
        changed = true;
      }
    }
    if (reconcileEmailLeadLinks(doc)) changed = true;
    if (changed) {
      await db.collection('crm').updateOne(
        { _id: 'main' },
        { $set: { leads: doc.leads, emails: doc.emails } }
      );
    }
    return doc;
  } catch (err) {
    console.error('Error loading data from MongoDB:', err);
    return { leads: [], emails: [], followups: [] };
  }
}

async function saveData(data) {
  if (!db) {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Error writing local data file:', err);
    }
    return;
  }

  try {
    await db.collection('crm').updateOne(
      { _id: 'main' },
      { $set: { leads: data.leads, emails: data.emails, followups: data.followups, lastSyncTime: data.lastSyncTime } },
      { upsert: true }
    );
  } catch (err) {
    console.error('Error saving data to MongoDB:', err);
  }
}
function normalizeEmail(email) { return String(email || '').trim().toLowerCase(); }
function normalizePhone(phone) { return String(phone || '').replace(/[^\d]/g, ''); }

function getLikelyEmailTypo(domain) {
  const typoMap = {
    'gmai.com': 'gmail.com',
    'gmial.com': 'gmail.com',
    'gmal.com': 'gmail.com',
    'gmail.co': 'gmail.com',
    'gmail.con': 'gmail.com',
    'gmail.cm': 'gmail.com',
    'gmail.coom': 'gmail.com',
    'gnail.com': 'gmail.com',
    'yaho.com': 'yahoo.com',
    'yahoo.co': 'yahoo.com',
    'yahoo.con': 'yahoo.com',
    'hotmial.com': 'hotmail.com',
    'hotmai.com': 'hotmail.com',
    'outlok.com': 'outlook.com',
    'outlook.co': 'outlook.com'
  };
  return typoMap[String(domain || '').toLowerCase()] || '';
}

function getBouncedRecipient(mail) {
  const text = `${mail.subject || ''}\n${mail.text || ''}\n${mail.html || ''}`;
  const patterns = [
    /wasn'?t delivered to\s+([^\s<>"']+@[^\s<>"']+)/i,
    /couldn'?t be delivered to\s+([^\s<>"']+@[^\s<>"']+)/i,
    /delivery to the following recipient failed permanently:\s*([^\s<>"']+@[^\s<>"']+)/i,
    /final-recipient:\s*rfc822;\s*([^\s<>"']+@[^\s<>"']+)/i,
    /original-recipient:\s*rfc822;\s*([^\s<>"']+@[^\s<>"']+)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return normalizeEmail(match[1].replace(/[.,;:]+$/, ''));
  }
  return '';
}

function isHardBounce(mail) {
  const from = normalizeEmail(mail.from?.value?.[0]?.address);
  const subject = String(mail.subject || '');
  const text = `${subject}\n${mail.text || ''}\n${mail.html || ''}`;
  return (
    /mailer-daemon|postmaster|mail delivery subsystem/i.test(from) ||
    /delivery status notification|undeliver(?:ed|able)|delivery failure|address not found|mail delivery subsystem/i.test(subject) ||
    /\b5(?:50|51|53|54|5\d)\b|5\.1\.1|NoSuchUser|address couldn'?t be found|account .* does not exist/i.test(text)
  );
}

function parseLeadNameFromBody(body, to) {
  const match = String(body || '').match(/\b(?:Dear|Hi)\s+([^,\n]+)/i);
  if (match && match[1]) return match[1].trim();
  return getNameFromEmail(to);
}

function parseProductFromSubject(subject) {
  const match = String(subject || '').match(/^Proposal for\s+(.+?)\s+\|\s+ODD INFOTECH/i);
  return match && match[1] ? match[1].trim() : '';
}

function reconcileEmailLeadLinks(data) {
  if (!data.leads) data.leads = [];
  if (!data.emails) data.emails = [];

  let changed = false;
  const leadsById = new Map(data.leads.map(lead => [lead.id, lead]));
  const leadsByEmail = new Map(
    data.leads
      .filter(lead => lead.email)
      .map(lead => [normalizeEmail(lead.email), lead])
  );

  for (const email of data.emails) {
    if (email.leadId && leadsById.has(email.leadId)) continue;

    const emailKey = normalizeEmail(email.to);
    const matchingLead = emailKey ? leadsByEmail.get(emailKey) : null;
    if (matchingLead) {
      email.leadId = matchingLead.id;
      changed = true;
      continue;
    }

    if (email.direction !== 'sent' || !email.autoResponse || !email.to) continue;

    const snapshot = email.leadSnapshot || {};
    const restoredLead = {
      id: email.leadId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 5)),
      indiamartId: snapshot.indiamartId || '',
      source: snapshot.source || 'Email Log',
      name: snapshot.name || parseLeadNameFromBody(email.body, email.to),
      company: snapshot.company || '',
      email: email.to,
      phone: snapshot.phone || '',
      city: snapshot.city || '',
      state: snapshot.state || '',
      product: snapshot.product || parseProductFromSubject(email.subject),
      message: snapshot.message || 'Restored from auto email log',
      status: snapshot.status || 'New',
      clientStatus: snapshot.clientStatus || 'New',
      score: snapshot.score ?? null,
      aiSummary: snapshot.aiSummary || null,
      emailValid: true,
      emailReason: 'Restored from sent email log',
      phoneValid: snapshot.phoneValid ?? false,
      phoneLocation: snapshot.phoneLocation || '',
      phoneCarrier: snapshot.phoneCarrier || '',
      phoneLineType: snapshot.phoneLineType || '',
      phoneStatus: snapshot.phoneStatus || '',
      phoneOwner: snapshot.phoneOwner || null,
      createdAt: snapshot.createdAt || email.sentAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    data.leads.unshift(restoredLead);
    email.leadId = restoredLead.id;
    leadsById.set(restoredLead.id, restoredLead);
    leadsByEmail.set(normalizeEmail(restoredLead.email), restoredLead);
    changed = true;
  }

  return changed;
}

function hasExistingLead(data, { email, phone, indiamartId }) {
  const emailKey = normalizeEmail(email);
  const phoneKey = normalizePhone(phone);
  const imKey = String(indiamartId || '').trim();
  return (data.leads || []).some(lead => {
    if (imKey && String(lead.indiamartId || '').trim() === imKey) return true;
    if (emailKey && normalizeEmail(lead.email) === emailKey) return true;
    if (phoneKey && normalizePhone(lead.phone) === phoneKey) return true;
    return false;
  });
}
function hasAutoResponseForLead(data, lead) {
  const emailKey = normalizeEmail(lead.email);
  const serviceKey = getLeadServiceKey(lead);
  return (data.emails || []).some(email => {
    if (!email.autoResponse) return false;
    if (email.status === 'failed') return false;
    
    const isSameService = email.serviceKey === serviceKey;
    const isSameLead = (email.leadId === lead.id) || (emailKey && normalizeEmail(email.to) === emailKey);
    
    return isSameLead && isSameService;
  });
}
async function loadSettings() {
  let s = {};
  if (!db) {
    if (fs.existsSync(SETTINGS_FILE)) {
      try { s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch {}
    }
  } else {
    try {
      const doc = await db.collection('settings').findOne({ _id: 'main' });
      if (doc && doc.settings) s = doc.settings;
    } catch (err) {
      console.error('Error loading settings from MongoDB:', err);
    }
  }

  // .env values always override settings.json
  if (process.env.INDIAMART_API_KEY) s.indiamartApiKey = process.env.INDIAMART_API_KEY;
  if (process.env.GEMINI_API_KEY) s.geminiKey = process.env.GEMINI_API_KEY;
  if (process.env.NUMVERIFY_API_KEY) s.numverifyKey = process.env.NUMVERIFY_API_KEY;
  if (process.env.SMTP_HOST) s.smtpHost = process.env.SMTP_HOST;
  if (process.env.SMTP_PORT) s.smtpPort = process.env.SMTP_PORT;
  if (process.env.SMTP_USER) s.smtpUser = process.env.SMTP_USER;
  if (process.env.SMTP_PASS) s.smtpPass = process.env.SMTP_PASS;

  // Auto-response defaults if not defined
  if (s.autoResponseEnabled === undefined) s.autoResponseEnabled = true;
  if (s.indiamartSyncEnabled === undefined) s.indiamartSyncEnabled = true;
  if (!s.autoResponseSubject) s.autoResponseSubject = 'Thank you for your enquiry!';
  if (!s.autoResponseBody) s.autoResponseBody = 'Hi {{name}},\n\nThank you for your enquiry about {{product}}.\n\nWe will get back to you shortly.\n\nBest regards';

  // Persist merged settings
  if (!db) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
  } else {
    try {
      await db.collection('settings').updateOne(
        { _id: 'main' },
        { $set: { settings: s } },
        { upsert: true }
      );
    } catch (err) {
      console.error('Error saving settings to MongoDB:', err);
    }
  }

  return s;
}
async function saveSettings(s) {
  if (!db) {
    try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); } catch {}
    return;
  }
  try {
    await db.collection('settings').updateOne(
      { _id: 'main' },
      { $set: { settings: s } },
      { upsert: true }
    );
  } catch (err) {
    console.error('Error saving settings to MongoDB:', err);
  }
}
function isSmtpConfigured(settings) {
  return Boolean(settings.smtpHost && settings.smtpUser && settings.smtpPass);
}
function createSmtpTransport(settings) {
  const port = Number(settings.smtpPort) || 587;
  const isGmail = settings.smtpHost.includes('gmail.com');
  
  return nodemailer.createTransport({
    host: settings.smtpHost,
    port,
    secure: port === 465,
    auth: { user: settings.smtpUser, pass: settings.smtpPass },
    tls: { rejectUnauthorized: false, minVersion: 'TLSv1.2' },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
    debug: true,
    logger: true
  });
}
function isTransientEmailError(error) {
  const msg = String(error?.message || error || '');
  const code = String(error?.responseCode || '');
  return (
    code.startsWith('4') ||
    /Temporary|Try again later|timeout|ETIMEDOUT|ECONNRESET|ECONNECTION|ESOCKET|rate|throttle|421|450|451|452/i.test(msg)
  );
}
async function sendMailWithRetry(transporter, mailOpts, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await transporter.sendMail(mailOpts);
    } catch (error) {
      lastError = error;
      if (!isTransientEmailError(error) || attempt === attempts) throw error;
      const waitMs = attempt * 5000;
      console.warn(`[Email] Temporary SMTP error. Retry ${attempt + 1}/${attempts} in ${waitMs / 1000}s: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }
  throw lastError;
}
function getPublicAttachment(assetPath, filename, extra = {}) {
  const cleanPath = String(assetPath || '').replace(/^\/+/, '');
  const relativePath = cleanPath.startsWith('assets/') ? cleanPath : path.join('assets', cleanPath);
  const fullPath = path.join(__dirname, '../public', relativePath);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[Email] Attachment missing, skipping: ${fullPath}`);
    return null;
  }
  return { filename, path: fullPath, ...extra };
}
function getDefaultProposalAttachments() {
  return [
    getPublicAttachment('/assets/portfolio.pdf', 'Oddinfotech Portfolio 2025.pdf'),
    getPublicAttachment('/assets/signature.gif', 'Email signature - 3.gif', {
      cid: 'signature_gif',
      contentType: 'image/gif',
      contentDisposition: 'inline'
    })
  ].filter(Boolean);
}
function buildUploadedAttachments(attachments = []) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .map(a => {
      const extra = {};
      if (a.cid) extra.cid = a.cid;
      if (a.contentType) extra.contentType = a.contentType;
      if (a.contentDisposition) extra.contentDisposition = a.contentDisposition;
      return getPublicAttachment(a.path, a.filename || a.name || 'attachment', extra);
    })
    .filter(Boolean);
}
async function isAutomationEnabled(settings) {
  const s = settings || await loadSettings();
  return s.indiamartSyncEnabled !== false && s.autoResponseEnabled !== false;
}
async function requireAutomationOn(req, res, next) {
  const enabled = await isAutomationEnabled();
  if (!enabled) {
    return res.status(423).json({
      error: 'Webapp is OFF. Turn ON to fetch leads, send mail, sync replies, or manage followups.',
      automationOff: true
    });
  }
  next();
}

async function validateEmail(email) {
  if (!email) return { valid: false, reason: 'No email provided' };
  const rawEmail = String(email);
  const cleanedEmail = rawEmail.trim().toLowerCase();
  if (rawEmail !== rawEmail.trim()) {
    return { valid: false, reason: 'Email has leading/trailing spaces' };
  }
  if (/[,\s;<>()[\]"']/.test(cleanedEmail)) {
    return { valid: false, reason: 'Email contains invalid spaces or punctuation' };
  }
  const emailRegex = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
  if (!emailRegex.test(cleanedEmail)) {
    return { valid: false, reason: 'Invalid format' };
  }
  const [localPart, domain] = cleanedEmail.split('@');
  if (!localPart || !domain) {
    return { valid: false, reason: 'Invalid format' };
  }
  if (localPart.startsWith('.') || localPart.endsWith('.') || localPart.includes('..') || domain.includes('..')) {
    return { valid: false, reason: 'Invalid dot placement in email' };
  }
  const domainLabels = domain.split('.');
  if (domainLabels.some(label => !label || label.startsWith('-') || label.endsWith('-'))) {
    return { valid: false, reason: 'Invalid email domain format' };
  }
  const tld = domainLabels[domainLabels.length - 1];
  if (!/^[a-z]{2,24}$/i.test(tld)) {
    return { valid: false, reason: 'Invalid email domain extension' };
  }

  const suggestedDomain = getLikelyEmailTypo(domain);
  if (suggestedDomain) {
    return { valid: false, reason: `Likely email domain typo. Did you mean ${suggestedDomain}?` };
  }

  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const gmailBase = localPart.split('+')[0];
    const gmailUser = gmailBase.replace(/\./g, '');
    if (!/^[a-z0-9.]+$/i.test(gmailBase)) {
      return { valid: false, reason: 'Invalid Gmail username characters' };
    }
    if (gmailUser.length < 6 || gmailUser.length > 30) {
      return { valid: false, reason: 'Invalid Gmail username length' };
    }
  }
  
  // Checklist of common disposable/temporary email providers to prevent bounce backs
  const DISPOSABLE_DOMAINS = new Set([
    'yopmail.com', 'mailinator.com', 'tempmail.com', '10minutemail.com',
    'guerrillamail.com', 'throwawaymail.com', 'getairmail.com', 'dispostable.com',
    'temp-mail.org', 'tempmailo.com', 'emailondeck.com', 'sharklasers.com',
    'guerrillamailblock.com', 'guerrillamail.net', 'guerrillamail.org', 'guerrillamail.biz'
  ]);
  
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { valid: false, reason: 'Disposable email domain (leads to bounce back)' };
  }

  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length > 0) {
      return {
        valid: true,
        reason: 'Format & MX record valid. Mailbox existence is confirmed only after delivery.'
      };
    }
    return { valid: false, reason: 'No MX records found' };
  } catch (e) {
    return { valid: false, reason: 'Domain not resolved / No mail exchange (likely bounce back)' };
  }
}

async function lookupCallerName(phone, geminiKey) {
  if (!phone) return null;
  let cleanPhone = String(phone).replace(/[^\d]/g, '');
  if (!cleanPhone) return null;

  if (cleanPhone.length === 10 && /^[6789]/.test(cleanPhone)) {
    cleanPhone = '91' + cleanPhone;
  }

  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(cleanPhone)}`;
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
    
    if (snippets.length === 0) return null;

    if (geminiKey) {
      const prompt = `Based on the following web search snippets for the phone number "${phone}", extract the most likely registered owner's name, company name, or caller name associated with this number.
If the snippets contain spam reports or multiple conflictual names, return the most common/dominant name or "Spam Caller / Commercial".
If absolutely no name is associated, return "Unknown / Not Found".
Return ONLY the final extracted name, nothing else. No explanation, no markdown.

Web search snippets:
${snippets.slice(0, 8).join('\n\n')}`;

      const name = await callGemini(geminiKey, prompt);
      const cleanName = name.replace(/```|json/g, '').trim();
      if (cleanName && cleanName !== 'Unknown / Not Found') {
        return cleanName;
      }
    }
  } catch (err) {
    console.error('[Caller Name Lookup Error]', err);
  }
  return null;
}

async function validatePhone(phone, numverifyKey, fallbackCity, fallbackState) {
  if (!phone) return { valid: false, location: '', carrier: '', lineType: '', phoneStatus: 'No phone number', reason: 'No phone number', phoneOwner: null };
  let cleanPhone = String(phone).replace(/[^\d+]/g, '');
  if (!cleanPhone) return { valid: false, location: '', carrier: '', lineType: '', phoneStatus: 'Invalid format', reason: 'Invalid format', phoneOwner: null };

  if (cleanPhone.length === 10 && /^[6789]/.test(cleanPhone)) {
    cleanPhone = '91' + cleanPhone;
  }
  if (!cleanPhone.startsWith('+') && cleanPhone.length >= 10) {
    cleanPhone = '+' + cleanPhone;
  }

  const phoneRegex = /^\+?\d{8,15}$/;
  const formatValid = phoneRegex.test(cleanPhone.replace('+', ''));

  let phoneOwner = null;
  const settings = await loadSettings();

  if (numverifyKey) {
    try {
      const numForVerify = cleanPhone.replace('+', '');
      const url = `http://apilayer.net/api/validate?access_key=${numverifyKey}&number=${numForVerify}`;
      const response = await fetch(url);
      const data = await response.json();
      
      if (data && data.valid) {
        const parts = [];
        if (data.location) parts.push(data.location);
        if (data.country_name) parts.push(data.country_name);
        return {
          valid: true,
          location: parts.join(', ') || [fallbackCity, fallbackState, 'India'].filter(Boolean).join(', '),
          carrier: data.carrier || 'Unknown Operator',
          lineType: data.line_type || 'mobile',
          phoneStatus: 'Active / In Use (Carrier Verified)',
          reason: 'Numverify carrier verification successful',
          phoneOwner
        };
      }
    } catch (err) {
      console.error('[Phone Validation] Numverify API error:', err);
    }
  }

  // Secondary check: Veriphone (1,000 free/month, more reliable)
  try {
    const vpNum = cleanPhone.replace('+', '');
    const vpUrl = `https://api.veriphone.io/v2/verify?phone=${vpNum}&default_country=IN`;
    const vpRes = await fetch(vpUrl);
    const vpData = await vpRes.json();
    
    if (vpData && vpData.status === 'success' && vpData.phone_valid) {
      const vpLoc = [vpData.phone_region, vpData.country].filter(Boolean).join(', ') || [fallbackCity, fallbackState, 'India'].filter(Boolean).join(', ');
      return {
        valid: true,
        location: vpLoc,
        carrier: vpData.carrier || 'Unknown Operator',
        lineType: vpData.phone_type || 'mobile',
        phoneStatus: 'Active / In Use (Veriphone Verified)',
        reason: 'Veriphone carrier verification successful',
        phoneOwner
      };
    }
  } catch (err) {
    console.error('[Phone Validation] Veriphone API error:', err);
  }

  if (formatValid) {
    const loc = [fallbackCity, fallbackState, 'India'].filter(Boolean).join(', ');
    return {
      valid: true,
      location: loc,
      carrier: 'Unknown Operator',
      lineType: 'mobile',
      phoneStatus: 'Active / In Use (Format Check)',
      reason: 'Format check valid (API key missing or failed)',
      phoneOwner
    };
  }

  return {
    valid: false,
    location: '',
    carrier: '',
    lineType: '',
    phoneStatus: 'Not In Use / Disconnected',
    reason: 'Invalid format',
    phoneOwner
  };
}

function getNameFromEmail(email) {
  if (!email) return 'Sir/Madam';
  const parts = email.split('@');
  if (parts.length < 2) return 'Sir/Madam';
  let username = parts[0];
  
  // Replace symbols (dots, underscores, dashes) with spaces
  username = username.replace(/[._\-+]/g, ' ');
  // Remove numbers
  username = username.replace(/\d+/g, '').trim();
  
  if (!username) return 'Sir/Madam';
  
  // Capitalize each word
  return username.split(' ').map(word => {
    if (!word) return '';
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  }).join(' ').trim() || 'Sir/Madam';
}

function getGreetingName(lead) {
  // If we have a specific lead name (not unknown), use it, otherwise extract from email ID
  if (lead.name && lead.name.toLowerCase() !== 'unknown' && lead.name.toLowerCase().trim() !== '') {
    return lead.name;
  }
  return getNameFromEmail(lead.email);
}

function getLeadServiceKey(lead) {
  const haystack = `${lead.product || ''} ${lead.message || ''}`.toLowerCase();

  // --- Aircraft Cabin Mockup (maps to graphic design) ---
  if (/(aircraft\s*cabin\s*mockup|cabin\s*mockup)/i.test(haystack)) return 'graphic';

  // --- T-Shirt Embroidery (must check before generic embroidery) ---
  if (
    // T-shirt + embroidery combo
    /(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve).*(embroidery|embroidered|machine\s*embroidery|computerized\s*embroidery|logo\s*embroidery|uniform\s*embroidery|stitch(?:ing)?|thread\s*work)/i.test(haystack) ||
    /(embroidery|embroidered|machine\s*embroidery|computerized\s*embroidery|logo\s*embroidery|stitch(?:ing)?).*(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve)/i.test(haystack) ||
    // Garment/Uniform/Apparel embroidery
    /(uniform|garment|apparel|jacket|hoodie|cap|hat|jersey|sports\s*wear|sportswear|corporate\s*wear|work\s*wear|workwear).*(embroidery|embroidered|stitch(?:ing)?)/i.test(haystack) ||
    /(embroidery|embroidered|stitch(?:ing)?).*(uniform|garment|apparel|jacket|hoodie|cap|hat|jersey|sports\s*wear|sportswear)/i.test(haystack) ||
    // Polo / collar shirt embroidery
    /polo\s*(?:shirt|t-?shirt|tee).*(embroidery|embroidered|stitch)/i.test(haystack) ||
    // Standalone "t shirt embroidery" or "tshirt embroidery"
    /t[\s-]?shirt\s*embroidery|embroidery\s*t[\s-]?shirt/i.test(haystack)
  ) return 'tshirtembroidery';

  // --- T-Shirt Printing (must check before generic printing) ---
  if (
    // T-shirt + printing combo
    /(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve).*(printing|print(?:ed)?|dtf|screen\s*printing|sublimation|heat\s*transfer|logo\s*print(?:ing)?|custom\s*print(?:ing)?)/i.test(haystack) ||
    /(printing|print(?:ed)?|dtf|screen\s*printing|sublimation|heat\s*transfer|logo\s*print(?:ing)?).*(t[\s-]*shirt|tee\s*shirt|polo\s*(?:t[\s-]*shirt|shirt)|round\s*neck|v[\s-]*neck|u[\s-]*neck|half\s*sleeve|full\s*sleeve)/i.test(haystack) ||
    // Garment/Uniform/Apparel printing
    /(uniform|garment|apparel|jacket|hoodie|cap|hat|jersey|sports\s*wear|sportswear|corporate\s*wear|work\s*wear|workwear).*(printing|print(?:ed)?|dtf|sublimation|screen\s*print)/i.test(haystack) ||
    /(printing|print(?:ed)?|dtf|sublimation|screen\s*print(?:ing)?).*(uniform|garment|apparel|jacket|hoodie|cap|hat|jersey|sports\s*wear|sportswear)/i.test(haystack) ||
    // Standalone "t shirt printing" or "tshirt printing"
    /t[\s-]?shirt\s*print(?:ing)?|print(?:ing)?\s*t[\s-]?shirt/i.test(haystack)
  ) return 'tshirtprinting';

  // --- Graphic Design (all design sub-services) ---
  if (/(graphic\s*design(?:ing)?|brochure\s*design(?:ing)?|catalogue\s*design(?:ing)?|catalog\s*design(?:ing)?|flyer\s*design(?:ing)?|banner\s*design(?:ing)?|logo\s*design(?:ing)?|menu\s*card\s*design(?:ing)?|menu\s*design(?:ing)?|brand\s*identity\s*design(?:ing)?|branding\s*design(?:ing)?|poster\s*design(?:ing)?|business\s*card\s*design(?:ing)?|visiting\s*card\s*design(?:ing)?|package\s*design(?:ing)?|packaging\s*design(?:ing)?|label\s*design(?:ing)?|sticker\s*design(?:ing)?|letterhead\s*design(?:ing)?|invitation\s*design(?:ing)?|social\s*media\s*design(?:ing)?|creative\s*design(?:ing)?)/i.test(haystack)) return 'graphic';

  // --- Data Entry (includes PDF editing, form filling, typing) ---
  if (/(data\s*entry|online\s*data\s*entry|offline\s*data\s*entry|excel\s*data\s*entry|data\s*mining|data\s*collection|data\s*conversion|pdf\s*to\s*(excel|word|csv)|pdf\s*edit(?:ing)?|pdf\s*fill(?:ing)?|data\s*cleansing|data\s*validation|product\s*data\s*entry|e-?commerce\s*data\s*entry|crm\s*data\s*entry|form\s*fill(?:ing)?\s*(?:service)?|copy\s*paste|data\s*typing|document\s*typ(?:ing|e)|document\s*entry|web\s*research|data\s*extraction|ms\s*excel|spreadsheet\s*entry|invoice\s*entry|order\s*entry|data\s*process(?:ing)?)/i.test(haystack)) return 'dataentry';

  // --- Embroidery Digitizing (generic embroidery, after t-shirt check) ---
  if (/(embroidery\s*digit(?:iz|is)(?:ing|ation)|digit(?:iz|is)(?:ing|ation)\s*embroidery|embroidery\s*file|digit(?:iz|is)(?:ing|ation)|embroidery|\bpes\b|\bdst\b|\bjef\b|\bemb\b|embroidery\s*artwork|embroidery\s*logo|embroidery\s*patch|embroidery\s*conversion)/i.test(haystack)) return 'embroidery';

  // --- Live Chat / Customer Service ---
  if (/(live\s*chat|chat\s*support|web\s*chat|customer\s*service|customer\s*support|client\s*(?:customer|support|service)|help\s*desk|helpdesk|technical\s*support|tech\s*support|order\s*management|support\s*agent|chat\s*agent|call\s*cent(?:er|re)|inbound\s*support|outbound\s*support|customer\s*care|after\s*sales\s*support|virtual\s*assistant\s*support)/i.test(haystack)) return 'livechat';

  // --- Image Editing / Photo Retouching ---
  if (/(image\s*edit(?:ing)?|photo\s*edit(?:ing)?|product\s*photo\s*edit(?:ing)?|photo\s*retouch(?:ing)?|image\s*retouch(?:ing)?|retouching|clipping\s*path|background\s*remov(?:al|e)|image\s*background|e-?commerce\s*photo|jewellery\s*photo|jewelry\s*photo|ghost\s*mannequin|image\s*masking|shadow\s*creat(?:ion|e)|color\s*correct(?:ion)?|colour\s*correct(?:ion)?|photo\s*restor(?:ation|e)|product\s*image|amazon\s*image|flipkart\s*image|marketplace\s*image|bulk\s*image|photo\s*enhanc(?:ement|e)|image\s*enhanc(?:ement|e)|skin\s*retouch(?:ing)?|object\s*remov(?:al|e))/i.test(haystack)) return 'imageediting';

  // --- Email Marketing ---
  if (/(email\s*marketing|email\s*campaign|bulk\s*email|promotional\s*email|lead\s*nurturing|email\s*automation|email\s*template|mailchimp|klaviyo|newsletter|abandoned\s*cart|email\s*series|welcome\s*email|retention\s*(?:email|campaign)|product\s*launch\s*(?:email|campaign)|seasonal\s*(?:email|promotion)|festival\s*(?:email|promotion))/i.test(haystack)) return 'emailmarketing';

  // --- Vector / Redraw ---
  if (/(vector\s*(?:art(?:work)?|design|convert(?:ing|sion)?|redraw|illustration|file|graphic)|redraw|raster\s*to\s*vector|image\s*to\s*vector|logo\s*vector(?:iz(?:ation|e))?|vectoriz(?:ation|e)|line\s*art|artwork\s*clean(?:up|ing)|print[\s-]?ready\s*(?:vector|artwork|file)|screen\s*printing\s*artwork|embroidery\s*artwork\s*prep|sketch\s*to\s*vector|hand[\s-]?drawn\s*to\s*vector|svg\s*file|eps\s*file|ai\s*file\s*(?:convert|creat))/i.test(haystack)) return 'vector';

  // --- AI / ML ---
  if (/(\bai\b(?!\s*file)|ai\s*(?:solution|service|development|chatbot|application|integration|automation|consulting|strateg|model|powered|driven)|artificial\s*intelligence|machine\s*learning|\bml\b\s*(?:model|solution|service|development)|generative\s*ai|predictive\s*analytics|recommendation\s*system|sentiment\s*analysis|natural\s*language\s*processing|\bnlp\b|computer\s*vision|llm\b|large\s*language\s*model|chatbot\s*(?:develop|build|creat|design)|virtual\s*assistant\s*(?:develop|build|creat)|process\s*automation|ocr\b|intelligent\s*document|image\s*(?:recognition|classif)|video\s*analysis|data\s*(?:science|scientist)|deep\s*learning|neural\s*network|ai\s*\/?\s*ml)/i.test(haystack)) return 'aiml';

  // --- Default fallback: Graphic Design ---
  return 'graphic';
}

function getGraphicDesignServiceType(lead) {
  const haystack = `${lead.product || ''} ${lead.message || ''}`.toLowerCase();
  if (/brochure\s*design(?:ing)?/i.test(haystack)) return 'brochure';
  if (/(catalogue|catalog)\s*design(?:ing)?/i.test(haystack)) return 'catalogue';
  if (/flyer\s*design(?:ing)?/i.test(haystack)) return 'flyer';
  if (/banner\s*design(?:ing)?/i.test(haystack)) return 'banner';
  if (/logo\s*design(?:ing)?/i.test(haystack)) return 'logo';
  if (/(menu\s*card|menu)\s*design(?:ing)?/i.test(haystack)) return 'menu';
  if (/(brand\s*identity|branding)\s*design(?:ing)?/i.test(haystack)) return 'brandIdentity';
  if (/poster\s*design(?:ing)?/i.test(haystack)) return 'poster';
  if (/(business\s*card|visiting\s*card)\s*design(?:ing)?/i.test(haystack)) return 'businessCard';
  if (/(package|packaging|label|sticker)\s*design(?:ing)?/i.test(haystack)) return 'packaging';
  if (/(social\s*media|letterhead|invitation)\s*design(?:ing)?/i.test(haystack)) return 'graphic';
  return 'graphic';
}

function getGraphicDesignEmailBody(lead) {
  const serviceType = getGraphicDesignServiceType(lead);
  const productName = (lead.product && String(lead.product).trim() !== '') ? String(lead.product).trim() : 'Graphic Design Services';
  const graphicTemplates = {
    brochure: {
      title: 'Brochure Design Services',
      intro: `We understand that you are looking for ${productName}. Our brochure design service is focused on creating professional, informative, and visually appealing brochures that clearly present your company, products, services, and offers to your customers.`,
      included: 'Company Brochure Design, Product Brochure Design, Corporate Profile Brochure, Tri-fold and Bi-fold Brochure Design, Sales Brochure Design, Print-ready and Digital PDF Brochure Design.'
    },
    catalogue: {
      title: 'Catalogue Design Services',
      intro: `We understand that you are looking for ${productName}. Our catalogue design service helps you present your product range in a clean, organized, and attractive format so your customers can easily understand your offerings and make enquiries.`,
      included: 'Product Catalogue Design, Corporate Catalogue Design, E-commerce Catalogue Layout, Price Catalogue Design, Print-ready Catalogue Design, Digital PDF Catalogue Design.'
    },
    flyer: {
      title: 'Flyer Design Services',
      intro: `We understand that you are looking for ${productName}. Our flyer design service is ideal for promotions, events, product launches, offers, and local marketing campaigns where the design must quickly catch attention and communicate the message clearly.`,
      included: 'Promotional Flyer Design, Event Flyer Design, Product Flyer Design, Offer Flyer Design, Single-side and Double-side Flyer Design, Print-ready and Social Media Flyer Design.'
    },
    banner: {
      title: 'Banner Design Services',
      intro: `We understand that you are looking for ${productName}. Our banner design service helps your brand stand out across digital and print platforms with clear messaging, strong visual hierarchy, and professional artwork.`,
      included: 'Web Banner Design, Social Media Banner Design, Display Ad Banner Design, Flex Banner Design, Hoarding Banner Design, Roll-up Banner Design, Print-ready Banner Artwork.'
    },
    logo: {
      title: 'Logo Design Services',
      intro: `We understand that you are looking for ${productName}. Our logo design service is focused on creating a unique, memorable, and professional brand mark that represents your business identity clearly across print, digital, packaging, and marketing materials.`,
      included: 'Custom Logo Design, Brand Logo Concepts, Logo Redesign, Typography Logo, Icon-based Logo, Business Logo Design, Print-ready and Digital Logo Files.'
    },
    menu: {
      title: 'Menu Card Design Services',
      intro: `We understand that you are looking for ${productName}. Our menu card design service helps restaurants, cafes, hotels, bakeries, and food businesses present their items in an attractive, easy-to-read, and brand-matching layout.`,
      included: 'Restaurant Menu Card Design, Cafe Menu Design, Food Menu Layout, Digital Menu Design, Takeaway Menu Design, Table Menu Design, Print-ready Menu Artwork.'
    },
    brandIdentity: {
      title: 'Brand Identity Design Services',
      intro: `We understand that you are looking for ${productName}. Our brand identity design service helps you build a consistent and professional visual identity for your business across logo, colors, typography, stationery, marketing materials, and digital presence.`,
      included: 'Logo Usage, Color Palette, Typography Selection, Brand Guidelines, Stationery Design, Social Media Brand Assets, Business Card and Letterhead Design.'
    },
    poster: {
      title: 'Poster Design Services',
      intro: `We understand that you are looking for ${productName}. Our poster design service is created for promotions, events, announcements, product highlights, campaigns, and display requirements where the design should be attractive and message-driven.`,
      included: 'Event Poster Design, Promotional Poster Design, Product Poster Design, Campaign Poster Design, Social Media Poster Design, Print-ready Poster Artwork.'
    },
    businessCard: {
      title: 'Business Card Design Services',
      intro: `We understand that you are looking for ${productName}. Our business card design service helps you create a professional first impression with a clean, memorable, and brand-aligned visiting card layout.`,
      included: 'Business Card Design, Visiting Card Design, Corporate Card Design, Premium Card Layout, Front and Back Card Design, Print-ready Business Card Artwork.'
    },
    packaging: {
      title: 'Package Design Services',
      intro: `We understand that you are looking for ${productName}. Our package design service helps your product look professional, attractive, and market-ready with packaging artwork that reflects your brand and communicates product details clearly.`,
      included: 'Product Package Design, Label Design, Box Packaging Design, Pouch and Wrapper Design, Sticker Design, Retail Packaging Artwork, Print-ready Packaging Files.'
    },
    graphic: {
      title: 'Graphic Design Services',
      intro: `We understand that you are looking for ${productName}. Our graphic design service is focused on creating professional, high-quality visuals that strengthen your brand identity and communicate your message clearly across print and digital platforms.`,
      included: 'Brochure Designing services, Catalogue Designing services, Flyer Designing services, Banner Designing services, Logo Designing services, Menu card Designing services, Brand Identity Designing services, Poster Designing services, Business card Designing services, and Package Designing services.'
    }
  };
  const template = graphicTemplates[serviceType] || graphicTemplates.graphic;

  return `This is Sankar from ODD INFOTECH, and I'm pleased to introduce our professional ${template.title} crafted to match your requirement.

${template.intro}

At ODD INFOTECH, we take pride in delivering clean, creative, and customized design solutions. Our designers focus on brand consistency, attractive layout, proper typography, color balance, and print/digital-ready output so your business can present itself professionally.

Here are some key reasons to choose ODD INFOTECH for your ${template.title}:

* Flexible Pricing Plans: The price depends on the scope, design requirement, number of concepts/pages, and final output format. Once we understand your requirement, we will provide an affordable quotation.
* Services Related to Your Requirement: ${template.included}
* Information Security: We handle your brand data, artwork, and business information with confidentiality.
* Single Point of Contact (SPOC): A dedicated resource will coordinate with you for requirements, updates, and revisions.
* Skilled Designers: Our creative team can handle custom design requirements with professional quality.
* Scalable Services: Whether you need one design or regular design support, we can scale according to your business needs.
* Quick Turnaround Time: We provide fast delivery timelines based on the project scope without compromising quality.
* Round-the-Clock Support: Our team is available via email, phone, and chat for smooth communication.

If you are looking for accurate and reliable ${template.title}, ODD INFOTECH is here to help.

You can reach us at +91 98941 89152. We would be happy to discuss your requirement and provide a customized solution.

Kindly find the attached quote and portfolio for your reference. Please share your design requirement, content, size, preferred style, logo/brand files if available, and expected delivery timeline so we can proceed with the best approach.

Looking forward to the possibility of a successful collaboration and a prosperous business relationship in the coming years.`;
}

function getServiceEmailBody(lead) {
  const templates = {
    embroidery: `This is Sankar on behalf of ODD INFOTECH. Our embroidery digitizing services gives you access to a plethora of benefits along with the high-quality artwork that speaks for itself.  We offer aesthetic and flawless custom digitizing services and have the most talented resources at hand who ensure that you don't get anything less than perfection. We use the latest and greatest digitizing software to help produce high-quality products that will help bring your brand out into the spotlight. Some of the key factors for you to choose ODD INFOTECH as your custom embroidery digitizing company are listed here:

* Flexible Pricing Plans  (Quote and Portfolio attached for your reference)
* Information Security (Data is handled with utmost priority and confidentially)
* SPOC (Dedicated resource as the single point of contact for all your queries)
* Skilled Designers (to handle all the project requirements at ease)
* Easily scalable services (Bandwidth resources to increase its team if required as per client's business needs)
* Quick turnaround time (Despite operating from different locations globally, our turn around time is very short within 24 hrs)
* Round the Clock Support (24/7 support VIA email, phone and chat to answer our client queries)

Are you looking for an accurate and reliable embroidery digitizing company? Then, your search ends here. Get in touch with us today!

Please feel free to reach out to us at [+91 98941 89152].

Kindly find the attached quote and portfolio for your reference. Also kindly advise and clarify the below for better understanding for us :

Looking forward to a very successful business relationship in the coming years.`,

    tshirtprinting: `This is Sankar from ODD INFOTECH, and I am pleased to introduce our professional T Shirt Printing Services designed for corporate branding, promotional campaigns, events, and custom apparel requirements.

At ODD INFOTECH, we specialize in high-quality custom T-shirt printing solutions that help businesses create strong brand visibility. Our services include logo printing, text printing, and custom graphic printing on all types of T-shirts such as round neck, V-neck, U-neck, and polo T-shirts.

We use advanced printing technologies like DTF printing, screen printing, sublimation, and heat transfer printing to ensure vibrant colors, sharp detailing, and long-lasting durability.

Why Choose ODD INFOTECH:

* Flexible Pricing Plans

Pricing depends on design, quantity, and printing method. We offer customized and affordable quotations.

* Our T Shirt Printing Services Include:
Custom Logo T Shirt Printing
Corporate T Shirt Printing
Promotional T Shirt Printing
Event & Campaign T Shirts
Bulk T Shirt Printing Services
DTF Printing Services
Screen Printing Services
Sublimation Printing
Heat Transfer Printing
Personalized T Shirt Printing
* Key Advantages:
High-Quality Printing Output
Durable & Wash-Resistant Designs
Bulk Order Capability
Fast Turnaround Time
Consistent Quality Assurance
24/7 Customer Support
* Information Security

We ensure complete confidentiality of client designs and business data.

* Single Point of Contact (SPOC)

Dedicated coordinator for smooth communication and project handling.

If you are looking for a reliable T Shirt Printing Service provider, ODD INFOTECH is here to support your branding and business needs.

You can reach us at +91 98941 89152. We would be happy to discuss your requirements and provide a customized quotation.

Kindly find our company profile and service details attached for your reference.

We look forward to working with you.`,

    tshirtembroidery: `This is Sankar from ODD INFOTECH, and I am pleased to introduce our professional T Shirt Embroidery Services designed to deliver premium quality branding solutions for corporate, promotional, and industrial requirements.

At ODD INFOTECH, we specialize in high-quality computerized machine embroidery on all types of T-shirts including round neck, V-neck, U-neck, and polo T-shirts. Our embroidery services ensure clean stitching, precise detailing, and a long-lasting premium finish that enhances your brand identity.

We provide customized embroidery solutions for company logos, employee uniforms, promotional T-shirts, sports teams, schools, colleges, and events. Every design is carefully digitized to ensure accuracy and consistency across bulk production.

Why Choose ODD INFOTECH for T Shirt Embroidery Services:

* Flexible Pricing Plans

Pricing depends on design size, stitch count, and order quantity. We offer affordable and customized quotations based on your requirements.

* Our T Shirt Embroidery Services Include:
Corporate Logo Embroidery
Custom T Shirt Embroidery
Polo T Shirt Embroidery
Uniform Embroidery Services
Left Chest Logo Embroidery
Back & Sleeve Embroidery
Sports Team Embroidery
Promotional Apparel Embroidery
Bulk Order Embroidery Services
Custom Artwork Stitching
* Advanced Embroidery Technology

We use modern computerized embroidery machines along with professional digitizing techniques to ensure high precision, durability, and premium finishing.

* Information Security

We maintain strict confidentiality and ensure complete protection of your designs and business information.

* Single Point of Contact (SPOC)

A dedicated executive will handle your project for smooth communication and timely updates.

* Experienced Embroidery Team

Our skilled professionals ensure accurate stitching, proper thread selection, and consistent quality across all garments.

* Scalable Services

We efficiently handle both small orders and large-scale bulk embroidery requirements.

* Fast Turnaround Time

We ensure timely delivery without compromising on quality standards.

* 24/7 Support

Our team is available via email, phone, and chat for continuous assistance.

If you are looking for a reliable and professional T Shirt Embroidery Service provider, ODD INFOTECH is here to support your branding and uniform needs.

You can reach us at +91 98941 89152. We would be happy to discuss your requirements and provide a customized quotation.

Kindly find our company profile and service details attached for your reference. We would appreciate it if you could share your requirements for better understanding.

We look forward to the opportunity of working with you and building a long-term business relationship.`,

    livechat: `This is Sankar from ODD INFOTECH, and I'm thrilled to introduce our exceptional Client Customer Service, designed to elevate your customer interactions to new heights.

Our Live Chat Support goes beyond the ordinary, offering not only responsiveness but also a level of excellence that sets your customer service apart. At ODD INFOTECH, we take pride in our commitment to delivering outstanding customer experiences. Our skilled professionals utilize advanced chat support tools to ensure seamless and effective communication with your clients. Here are some compelling reasons to consider ODD INFOTECH for your Live Chat Support needs:

* Flexible Service Plans: (Attached a samples of our services for your reference)
* Information Security: Ensuring the confidentiality of your customer data is our top priority.
* Single Point of Contact (SPOC): Experience streamlined communication with a dedicated resource for all your queries.
* Skilled Support Agents: Our team of skilled support agents ensures professionalism and efficiency in every customer interaction.
* Scalable Services: Easily scale our services to match the evolving needs of your customer support requirements.
* Variety of customer needs, including: Customer Services, Technical Support, Information and Support on Product/Services, Order Management, Lead Generation, Help Desk, and much more.
* Quick Response Time: Despite the volume, we guarantee swift responses, typically within a few seconds.
* Round-the-Clock Support: Enjoy 24/7 support through our Live Chat platform for seamless communication.

Are you seeking responsive and reliable Live Chat Support services? Then, your search ends here. Get in touch with us today!

We eagerly await your feedback to better understand your specific needs and ensure a tailored approach to your customer support strategy.

Thank you for considering ODD INFOTECH. We look forward to the prospect of a successful collaboration.`,

    imageediting: `This is Sankar from ODD INFOTECH, and I'm delighted to introduce our professional Image Editing Services designed to enhance the visual appeal of your products and strengthen your brand presence across digital and print platforms.

At ODD INFOTECH, we specialize in delivering high-quality image editing solutions for jewellery, product, and e-commerce businesses. Our experienced team leverages advanced tools such as Adobe Photoshop and Adobe Lightroom to ensure every image meets the highest standards of quality, accuracy, and visual appeal. We focus on precision, consistency, and attention to detail to help your products stand out in a competitive marketplace.

Here are some key reasons to choose ODD INFOTECH as your trusted image editing partner:

* Flexible Pricing Plans: Pricing depends on the scope and complexity of the project. Once we understand your requirements, we will provide a competitive and affordable quote.
* Our Image Editing Services Include:
Jewellery Photo Retouching
Product Image Editing
E-commerce Product Photo Editing
Background Removal & Replacement
Clipping Path Services
Image Masking
Shadow Creation (Natural, Reflection & Drop Shadows)
Color Correction & Enhancement
Dust, Scratch & Blemish Removal
Ghost Mannequin Editing
Image Resizing & Cropping
Amazon, Flipkart & Marketplace Image Optimization
Bulk Image Processing
Photo Restoration Services
* Information Security: We handle all client images and data with complete confidentiality and security.
* Single Point of Contact (SPOC): A dedicated resource will be assigned to manage communication and project coordination.
* Experienced Editing Team: Our skilled image editors are trained to handle high-volume projects while maintaining exceptional quality standards.
* Scalable Services: Whether you need editing for a few images or thousands of product photos, we can easily scale our services to meet your requirements.
* Quick Turnaround Time: We ensure fast delivery without compromising on quality, helping you meet your business deadlines efficiently.
* Quality Assurance: Every image undergoes a thorough quality check before delivery to ensure accuracy and consistency.
* 24/7 Support: Our support team is available via email, phone, and chat to assist you whenever needed.

If you are looking for a reliable and professional image editing company for your jewellery, product, or e-commerce business, ODD INFOTECH is here to help.

You can reach us at +91 98941 89152. We would be happy to discuss your requirements and provide a customized solution.

Kindly find our company profile, portfolio, and quotation attached for your reference. We would also appreciate it if you could share your requirements and clarify the below points to help us better understand your project needs.

We look forward to the opportunity of working with you and building a long-term business relationship.`,

    emailmarketing: `This is Sankar from ODD INFOTECH, and I'm excited to introduce our professional Email Marketing Services designed to help businesses engage customers, generate quality leads, increase conversions, and build long-term customer relationships.

At ODD INFOTECH, we specialize in creating and managing result-oriented email marketing campaigns tailored to your business objectives. Our experienced team develops compelling email content, attractive designs, targeted campaigns, and automated workflows that help you reach the right audience at the right time. We focus on maximizing engagement, improving customer retention, and driving measurable business growth.

Here are some key reasons to choose ODD INFOTECH as your trusted Email Marketing partner:

* Flexible Pricing Plans: Pricing depends on your campaign requirements, audience size, and service scope. Once we understand your needs, we will provide an affordable and customized quote.
* Our Email Marketing Services Include:
Promotional Email Campaigns
Lead Nurturing Campaigns
Email Automation Setup
Welcome Email Series
Customer Retention Campaigns
Product Launch Campaigns
Seasonal & Festival Promotions
Abandoned Cart Recovery Emails
Email Template Design
* Advanced Email Marketing Tools: We utilize industry-leading email marketing platforms and analytics tools to create, manage, automate, and optimize campaigns for maximum effectiveness and ROI.
* Information Security: We maintain strict confidentiality and ensure the security of your customer data and marketing information.
* Single Point of Contact (SPOC): A dedicated resource will be assigned to handle all communication and project-related queries.
* Experienced Marketing Team: Our skilled professionals create engaging email campaigns that align with your brand identity and marketing goals.
* Scalable Services: Whether you're a startup, small business, or large enterprise, our services can scale according to your business requirements.
* Quick Turnaround Time: We ensure timely campaign setup, execution, and reporting to help you achieve your marketing objectives without delays.
* Performance-Driven Approach: We continuously monitor campaign performance and provide actionable insights to improve open rates, click-through rates, and conversions.
* 24/7 Support: Our support team is available through email, phone, and chat to assist you whenever required.

If you are looking for a reliable and professional Email Marketing company to strengthen customer engagement and drive business growth, ODD INFOTECH is here to help.

You can reach us at +91 98941 89152. We would be delighted to discuss your requirements and provide a tailored solution for your business.

Kindly find our company profile, portfolio, and quotation attached for your reference. We would also appreciate it if you could share your requirements and clarify the below points to help us better understand your project needs.

We look forward to the opportunity of working with you and building a long-term business relationship.`,

    vector: `This is Sankar from ODD INFOTECH, and I am pleased to introduce our professional Vector Artwork and Vector Redraw Services designed to deliver clean, scalable, and print-ready vector graphics for businesses across various industries.

At ODD INFOTECH, we specialize in manual vector conversion and vector redraw services using the Pen Tool, ensuring precise and high-quality results. Unlike automated image tracing methods, our skilled artists carefully recreate artwork by hand, preserving every detail, curve, and shape for superior accuracy and professional output.

Our team has extensive experience working with industry-leading illustration software, enabling us to produce flawless vector artwork suitable for printing, embroidery, engraving, signage, promotional products, apparel, and digital applications.

Here are some key reasons to choose ODD INFOTECH as your trusted Vector Artwork partner:

* Flexible Pricing Plans: The price depends on the complexity of the artwork and project requirements. Once we review your files, we will provide an affordable and customized quote.
* Our Vector Artwork Services Include:
Vector Redraw Services
Logo Vectorization
Raster to Vector Conversion
Image to Vector Conversion
Hand-Drawn Artwork Vectorization
Sketch to Vector Conversion
Low-Resolution Logo Recreation
Print-Ready Vector Artwork
Screen Printing Artwork Preparation
Embroidery Digitizing Artwork Preparation
Signage & Large Format Printing Artwork
Line Art & Technical Illustrations
Icon & Symbol Creation
Custom Vector Illustration Services
Artwork Cleanup & Enhancement
* Manual Pen Tool Redrawing: We do not rely on automatic image tracing or live trace methods. Every artwork is carefully recreated using the Pen Tool, ensuring smooth curves, sharp edges, accurate details, and professional-quality vector files.
* Advanced Illustration Software: Our experienced designers are highly proficient in professional illustration software, including:
Adobe Illustrator
CorelDRAW
Adobe Photoshop
* Information Security: We maintain strict confidentiality and ensure complete protection of your artwork and business information.
* Single Point of Contact (SPOC): A dedicated project coordinator will handle all communications and project updates for a seamless experience.
* Experienced Vector Artists: Our skilled vector artists have extensive experience in recreating complex logos, illustrations, mascots, artwork, and technical drawings with exceptional precision.
* Scalable Services: Whether you need a single logo converted or thousands of artwork files processed, we can efficiently scale our services to meet your requirements.
* Quick Turnaround Time: We offer fast turnaround times while maintaining the highest standards of quality and accuracy.
* Quality Assurance: Every vector file undergoes a thorough quality check to ensure clean paths, accurate shapes, proper layering, and print-ready output.
* 24/7 Support: Our team is available via email, phone, and chat to provide prompt assistance whenever needed.

If you are looking for a reliable and experienced company for high-quality manual vector redraw and vector artwork services, ODD INFOTECH is here to help.

You can reach us at +91 98941 89152. We would be happy to discuss your requirements and provide a customized solution.

Kindly find our company profile, portfolio, and quotation attached for your reference. We would also appreciate it if you could share your artwork requirements and clarify the below points to help us better understand your project needs.

We look forward to the opportunity of working with you and building a long-term business relationship.`,

    aiml: `This is Sankar from ODD INFOTECH, and I am pleased to introduce our cutting-edge Artificial Intelligence (AI) and Machine Learning (ML) services designed to help businesses automate processes, improve decision-making, enhance customer experiences, and drive innovation.

At ODD INFOTECH, we provide customized AI and ML solutions that help organizations unlock the power of their data and gain a competitive advantage. Our experienced team of AI engineers, data scientists, and developers builds intelligent solutions tailored to your specific business requirements, ensuring measurable results and long-term value.

Here are some key reasons to choose ODD INFOTECH as your trusted AI & ML technology partner:

* Flexible Pricing Plans: The pricing depends on the project scope, complexity, and business requirements. Once we understand your objectives, we will provide a customized and cost-effective quotation.
* Our AI & Machine Learning Services Include:
AI-Powered Chatbots & Virtual Assistants
Generative AI Solutions
Custom AI Application Development
Predictive Analytics Solutions
ML automation
Recommendation Systems
Image & Video Analysis
Sentiment Analysis
Data Mining & Pattern Recognition
AI Process Automation
AI Integration with Existing Systems
AI Consulting & Strategy Development
* Advanced Technologies & Tools: Our team leverages the latest AI and ML technologies, frameworks, and cloud platforms to develop scalable, secure, and high-performance solutions tailored to your business goals.
* Information Security: We prioritize data privacy, confidentiality, and security throughout the development and deployment process.
* Single Point of Contact (SPOC): A dedicated project coordinator will be assigned to ensure smooth communication and efficient project management.
* Experienced AI & ML Experts: Our skilled professionals have extensive experience in developing and deploying AI-driven solutions across various industries.
* Scalable Solutions: Our AI solutions are designed to grow with your business and adapt to evolving requirements.
* Faster Development & Deployment: We follow agile methodologies and best practices to ensure timely project delivery without compromising quality.
* Quality Assurance: Every solution undergoes rigorous testing and validation to ensure accuracy, reliability, and optimal performance.
* 24/7 Support: We provide continuous support and maintenance services to ensure your AI systems operate efficiently.

Whether you are looking to automate workflows, improve operational efficiency, gain valuable business insights, or build intelligent customer-facing applications, ODD INFOTECH can help you achieve your objectives with innovative AI and ML solutions.

You can reach us at +91 98941 89152. We would be happy to discuss your project requirements and provide a customized solution tailored to your business needs.

Kindly find our company profile, portfolio, and quotation attached for your reference. We would also appreciate it if you could share your requirements and clarify the below points to help us better understand your project goals.

We look forward to the opportunity of working with you and building a successful long-term business relationship.`,

    graphic: `This is Sankar from ODD INFOTECH, and I'm excited to introduce our top-notch graphic design services crafted to enhance your brand's visual identity. Our graphic design services offer a myriad of benefits, coupled with high-quality artwork that speaks volumes. At ODD INFOTECH, we take pride in delivering flawless custom design solutions, executed by our talented team to ensure nothing less than perfection. Utilizing the latest design software, we aim to produce high-quality visuals that will truly set your brand in the spotlight. Here are some key reasons to choose ODD INFOTECH as your preferred graphic design company:

* Flexible Pricing Plans: The price depends on the Services. Once we know about your project, then we will give you the price. We will provide you with an affordable price.
* The services included in graphic design are: Brochure Designing services, Catalogue Designing services, Flyer Designing services, Banner Designing services, Logo Designing services, Menu card Designing services, Brand Identity Designing services, Poster Designing services, Business card Designing services, and Package Designing services.
* Information Security: We handle your data with utmost priority and confidentiality.
* Single Point of Contact (SPOC): Enjoy streamlined communication with a dedicated resource for all your queries.
* Skilled Designers: Our team of skilled designers can handle all project requirements with ease.
* Scalable Services: Easily scale our services to match your business needs as it evolves.
* Quick Turnaround Time: Despite our global reach, we guarantee a swift turnaround, typically within 24 hours.
* Round-the-Clock Support: Benefit from 24/7 support via email, phone, and chat for seamless communication.

Are you in search of an accurate and reliable graphic design company? Then, your search ends here. Get in touch with us today!

You can reach us at [+91 98941 89152]. We look forward to hearing from you soon!

Kindly find the attached quote and portfolio for your reference. Also kindly advise and clarify the below for better understanding for us :

Looking forward to the possibility of a successful collaboration and a prosperous business relationship in the coming years.`,

    dataentry: `This is Sankar from ODD INFOTECH, and I am pleased to introduce our professional Data Entry Services designed to help businesses manage, organize, and maintain their data with accuracy, efficiency, and confidentiality.

At ODD INFOTECH, we provide high-quality data entry solutions that support businesses in improving productivity, reducing workload, and ensuring error-free data management. Our skilled team is trained to handle large volumes of data with speed and precision while maintaining strict quality standards.

We ensure that your business data is accurately captured, properly structured, and securely managed using industry best practices.

Why Choose ODD INFOTECH for Data Entry Services:

* Flexible Pricing Plans

Pricing depends on project volume and complexity. We offer customized and affordable pricing after understanding your requirements.

* Our Data Entry Services Include:
Online Data Entry Services
Offline Data Entry Services
Excel Data Entry & Formatting
Data Mining & Data Collection
Data Conversion Services (PDF to Excel / Word)
Data Cleansing & Validation
Product Data Entry for E-commerce Websites
CRM Data Entry
Form Filling Services
Copy Paste Data Entry Work
Typing & Document Entry Services
Web Research & Data Extraction
* Accuracy & Quality Assurance

We ensure 99%+ accuracy with proper quality checks at every stage of the project.

* Data Confidentiality

We maintain strict confidentiality and security of all client data and information.

* Skilled Data Entry Professionals

Our experienced team ensures fast turnaround time with error-free output.

* Scalable Services

We can handle both small and large-scale data entry projects efficiently.

* Fast Turnaround Time

We deliver projects within committed timelines without compromising quality.

* 24/7 Support

Our team is available via email, phone, and chat for continuous support.

If you are looking for a reliable and professional Data Entry Service provider, ODD INFOTECH is here to support your business operations with accuracy and efficiency.

You can reach us at +91 98941 89152. We would be happy to discuss your requirements and provide a customized quotation.

Kindly find our company profile and service details attached for your reference. We would appreciate it if you could share your requirements and clarify the project scope for better understanding.

We look forward to the opportunity of working with you and building a long-term business relationship.`
  };

  const serviceKey = getLeadServiceKey(lead);
  // For graphic design, use the more specific sub-service template
  if (serviceKey === 'graphic') {
    return getGraphicDesignEmailBody(lead);
  }
  return templates[serviceKey] || getGraphicDesignEmailBody(lead);
}

function getGreetingEmailText(lead) {
  const name = getGreetingName(lead);

  return `Dear ${name},

Good day!

${getServiceEmailBody(lead)}

--
Best Regards!
Sankar G
ODDINFOTECH Business Team
Contact : +91 98941 89152
Website: www.oddinfotech.com`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function textToEmailHtml(text) {
  const blocks = String(text || '').split(/\n{2,}/);
  return blocks.map(block => {
    const lines = block.split('\n').map(line => line.trim()).filter(Boolean);
    if (!lines.length) return '';
    if (lines.every(line => line.startsWith('* '))) {
      return `<ul style="margin: 0 0 18px 20px; padding: 0;">${lines.map(line => `<li style="margin: 0 0 10px 0;">${escapeHtml(line.slice(2))}</li>`).join('')}</ul>`;
    }
    return `<p style="margin: 0 0 18px 0;">${lines.map(escapeHtml).join('<br>')}</p>`;
  }).join('\n');
}

function getGreetingEmailHtml(lead) {
  const name = getGreetingName(lead);
  const serviceKey = getLeadServiceKey(lead);
  const serviceSubjectMap = {
    tshirtembroidery: 'T Shirt Embroidery Services',
    tshirtprinting: 'T Shirt Printing Services',
    embroidery: 'Embroidery Digitizing Services',
    dataentry: 'Data Entry Services',
    livechat: 'Live Chat Support Services',
    imageediting: 'Image Editing Services',
    emailmarketing: 'Email Marketing Services',
    vector: 'Vector Artwork Services',
    aiml: 'AI & Machine Learning Services',
    graphic: 'Graphic Design Services'
  };
  const leadService = (lead.product && lead.product.trim() !== '') ? lead.product.trim() : (serviceSubjectMap[serviceKey] || 'Graphic Design Services');
  const bodyHtml = textToEmailHtml(getServiceEmailBody(lead));

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proposal for ${escapeHtml(leadService)}</title>
</head>
<body style="margin: 0; padding: 0; background: #ffffff; font-family: Arial, Helvetica, sans-serif; color: #222222; line-height: 1.55;">
  <div style="font-family: Arial, Helvetica, sans-serif; color: #222222; line-height: 1.55; font-size: 14px;">
    <p style="margin: 0 0 18px 0;">Dear ${escapeHtml(name)},</p>
    <p style="margin: 0 0 18px 0;">Good day!</p>
    ${bodyHtml}
    <p style="margin: 0 0 12px 0;">
      --<br>
      Best Regards!<br>
      <strong>Sankar G</strong><br>
      ODDINFOTECH Business Team<br>
      Contact : +91 98941 89152<br>
      Website: <a href="https://www.oddinfotech.com" style="color: #1155cc;">www.oddinfotech.com</a>
    </p>
    <img src="cid:signature_gif" alt="Sankar G - MD" style="display: block; width: 600px; max-width: 100%; height: auto; border: 0; outline: none; text-decoration: none;">
  </div>
</body>
</html>`;
}

async function triggerAutoResponse(lead, settings, data) {
  const freshData = await loadData();
  if (!freshData.emails) freshData.emails = [];
  if (hasAutoResponseForLead(freshData, lead)) {
    console.log(`[AutoResponse] Skipped for ${lead.name} - autoresponse already exists.`);
    return { skipped: true, reason: 'already_sent' };
  }

  const emailValidation = await validateEmail(lead.email);
  if (!emailValidation.valid) {
    const leadIndex = freshData.leads.findIndex(l => l.id === lead.id || normalizeEmail(l.email) === normalizeEmail(lead.email));
    if (leadIndex >= 0) {
      freshData.leads[leadIndex].emailValid = false;
      freshData.leads[leadIndex].emailReason = emailValidation.reason;
      freshData.leads[leadIndex].updatedAt = new Date().toISOString();
      await saveData(freshData);
    }
    console.log(`[AutoResponse] Skipped for ${lead.name} - invalid email: ${emailValidation.reason}`);
    return { skipped: true, reason: 'invalid_email', emailReason: emailValidation.reason };
  }

  const serviceKey = getLeadServiceKey(lead);
  // Use service-specific subject titles for non-graphic services
  const serviceSubjectMap = {
    tshirtembroidery: 'T Shirt Embroidery Services',
    tshirtprinting: 'T Shirt Printing Services',
    embroidery: 'Embroidery Digitizing Services',
    dataentry: 'Data Entry Services',
    livechat: 'Live Chat Support Services',
    imageediting: 'Image Editing Services',
    emailmarketing: 'Email Marketing Services',
    vector: 'Vector Artwork Services',
    aiml: 'AI & Machine Learning Services',
    graphic: 'Graphic Design Services'
  };
  const leadService = (lead.product && lead.product.trim() !== '') ? lead.product.trim() : (serviceSubjectMap[serviceKey] || 'Graphic Design Services');
  const subject = `Proposal for ${leadService}`;
  
  const bodyHtml = getGreetingEmailHtml(lead);
  const bodyText = getGreetingEmailText(lead);

  // Instead of relying on the passed 'data' object which might be stale in background,
  // we will load a fresh copy to save the email record at the end.
  const emailRecord = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    leadId: lead.id,
    to: lead.email,
    subject,
    body: bodyText,
    direction: 'sent',
    sentAt: new Date().toISOString(),
    serviceKey,
    attachments: [
      { filename: 'Oddinfotech Portfolio 2025.pdf', path: '/assets/portfolio.pdf' },
      { filename: 'Email signature - 3.gif', path: '/assets/signature.gif' }
    ],
    autoResponse: true,
    leadSnapshot: {
      id: lead.id,
      indiamartId: lead.indiamartId || '',
      source: lead.source || '',
      name: lead.name || '',
      company: lead.company || '',
      email: lead.email || '',
      phone: lead.phone || '',
      city: lead.city || '',
      state: lead.state || '',
      product: lead.product || '',
      message: lead.message || '',
      status: lead.status || 'New',
      clientStatus: lead.clientStatus || 'Prospect',
      score: lead.score ?? null,
      aiSummary: lead.aiSummary || null,
      emailValid: lead.emailValid ?? null,
      emailReason: lead.emailReason || '',
      phoneValid: lead.phoneValid ?? null,
      phoneLocation: lead.phoneLocation || '',
      phoneCarrier: lead.phoneCarrier || '',
      phoneLineType: lead.phoneLineType || '',
      phoneStatus: lead.phoneStatus || '',
      phoneOwner: lead.phoneOwner || null,
      createdAt: lead.createdAt || ''
    }
  };
  
  if (isSmtpConfigured(settings)) {
    try {
      const transporter = createSmtpTransport(settings);
      const mailOpts = {
        from: settings.smtpUser,
        to: lead.email,
        subject,
        text: bodyText,
        html: bodyHtml,
        attachments: getDefaultProposalAttachments()
      };
      await sendMailWithRetry(transporter, mailOpts);
      console.log(`[AutoResponse] Sent to ${lead.email} successfully with attachments.`);
      emailRecord.status = 'sent';

      // ✅ Push live activity event
      pushActivity('email_sent',
        `✉️ Mail Sent — ${lead.name || lead.email}`,
        `Service: ${serviceKey} | To: ${lead.email}`,
        { leadId: lead.id, email: lead.email, service: serviceKey }
      );

      // ✅ Update lead record to reflect mail sent
      const leadIdx = freshData.leads.findIndex(l => l.id === lead.id || normalizeEmail(l.email) === normalizeEmail(lead.email));
      if (leadIdx >= 0) {
        freshData.leads[leadIdx].lastEmailSentAt = new Date().toISOString();
        freshData.leads[leadIdx].emailSent = true;
        freshData.leads[leadIdx].updatedAt = new Date().toISOString();
        if (!freshData.leads[leadIdx].status || freshData.leads[leadIdx].status === 'New') {
          freshData.leads[leadIdx].status = 'Contacted';
        }
      }
    } catch (e) {
      console.error(`[AutoResponse] Error sending to ${lead.email}:`, e.message);
      emailRecord.status = 'failed';
      emailRecord.error = e.message;
      pushActivity('email_failed',
        `❌ Mail Failed — ${lead.name || lead.email}`,
        `Error: ${e.message}`,
        { leadId: lead.id, email: lead.email }
      );
    }
  } else {
    console.log(`[AutoResponse] SMTP not configured. Logged autoresponse with attachments to ${lead.email}.`);
    emailRecord.status = 'logged';
    emailRecord.note = 'SMTP not configured — logged only';
  }

  freshData.emails.push(emailRecord);
  await saveData(freshData);
}

async function syncImapReplies() {
  if (imapSyncInProgress) {
    console.log('[IMAP Sync] Already running. Skipping overlapping sync.');
    return { ok: true, added: 0, skipped: true, reason: 'IMAP sync already running.' };
  }

  imapSyncInProgress = true;
  const settings = await loadSettings();
  if (!isSmtpConfigured(settings)) {
    imapSyncInProgress = false;
    console.log('[IMAP Sync] Credentials not configured.');
    return { ok: false, error: 'SMTP/IMAP credentials not configured.' };
  }

  let imapHost = 'imap.gmail.com';
  if (settings.smtpHost.includes('gmail.com')) {
    imapHost = 'imap.gmail.com';
  } else {
    imapHost = settings.smtpHost.replace('smtp', 'imap');
  }

  const config = {
    imap: {
      user: settings.smtpUser,
      password: settings.smtpPass,
      host: imapHost,
      port: 993,
      tls: true,
      authTimeout: 8000,
      tlsOptions: { rejectUnauthorized: false }
    }
  };

  let connection = null;
  try {
    connection = await imaps.connect(config);
    await connection.openBox('INBOX');

    const data = await loadData();
    const leadsEmails = data.leads.map(l => l.email).filter(Boolean);
    if (!leadsEmails.length) {
      return { ok: true, added: 0 };
    }

    const delay = 24 * 3600 * 1000 * 7; // check last 7 days
    const yesterday = new Date(Date.now() - delay).toISOString();
    
    const searchCriteria = [
      ['SINCE', yesterday]
    ];
    const fetchOptions = {
      bodies: ['HEADER', 'TEXT', ''],
      struct: true
    };

    const messages = await connection.search(searchCriteria, fetchOptions);
    let addedCount = 0;

    if (!data.emails) data.emails = [];
    const leadMap = new Map(data.leads.map(l => [l.id, l.email]));
    const existingReplyKeys = new Set(
      data.emails
        .filter(e => e.direction === 'received')
        .map(e => {
          const leadEmail = leadMap.get(e.leadId) || '';
          return `${leadEmail.toLowerCase().trim()}_${(e.subject || '').trim()}_${e.receivedAt || ''}`;
        })
    );

    for (const message of messages) {
      const all = message.parts.find(part => part.which === '');
      const id = message.attributes.uid;
      const mail = await simpleParser(all.body);

      const subject = mail.subject || '';
      const text = mail.text || '';
      const date = mail.date ? mail.date.toISOString() : new Date().toISOString();
      
      if (isHardBounce(mail)) {
        const bouncedEmail = getBouncedRecipient(mail);
        const bouncedLead = bouncedEmail ? data.leads.find(l => normalizeEmail(l.email) === bouncedEmail) : null;
        if (bouncedLead) {
          const key = `${bouncedEmail}_${subject.trim()}_${date}`;
          if (existingReplyKeys.has(key)) continue;

          const reply = {
            id: 'bounce_' + id + '_' + Math.random().toString(36).slice(2, 5),
            leadId: bouncedLead.id,
            to: settings.smtpUser,
            from: mail.from?.value?.[0]?.address || '',
            subject,
            body: text,
            direction: 'received',
            receivedAt: date,
            attachments: [],
            bounce: true,
            bouncedEmail
          };

          data.emails.push(reply);
          existingReplyKeys.add(key);
          addedCount++;

          bouncedLead.emailValid = false;
          bouncedLead.emailReason = `Hard bounce from mailbox provider: ${subject || 'delivery failed'}`;
          bouncedLead.clientStatus = 'Bounced';
          bouncedLead.updatedAt = new Date().toISOString();
          console.log(`[IMAP Sync] Marked bounced email invalid: ${bouncedEmail}`);
        }
        continue;
      }

      const fromAddress = mail.from?.value?.[0]?.address;
      if (!fromAddress) continue;

      const matchingLead = data.leads.find(l => l.email && l.email.toLowerCase().trim() === fromAddress.toLowerCase().trim());
      if (!matchingLead) continue;

      const key = `${fromAddress.toLowerCase().trim()}_${subject.trim()}_${date}`;
      if (existingReplyKeys.has(key)) continue;

      const reply = {
        id: 'imap_' + id + '_' + Math.random().toString(36).slice(2, 5),
        leadId: matchingLead.id,
        to: settings.smtpUser,
        subject,
        body: text,
        direction: 'received',
        receivedAt: date,
        attachments: []
      };

      data.emails.push(reply);
      existingReplyKeys.add(key);
      addedCount++;

      if (matchingLead.clientStatus === 'Prospect' || matchingLead.clientStatus === 'New' || matchingLead.clientStatus === 'Contacted') {
        matchingLead.clientStatus = 'Replied via Email';
        matchingLead.updatedAt = new Date().toISOString();
      }
    }

    if (addedCount > 0) {
      await saveData(data);
    }
    return { ok: true, added: addedCount };
  } catch (err) {
    console.error('[IMAP Sync Error]', err.message);
    return { ok: false, error: err.message };
  } finally {
    if (connection) {
      try { connection.end(); } catch (e) { console.warn('[IMAP Sync] Close failed:', e.message); }
    }
    imapSyncInProgress = false;
  }
}

app.get('/api/settings', async (req, res) => res.json(await loadSettings()));
app.post('/api/settings', async (req, res) => {
  const current = await loadSettings();
  const next = { ...current, ...req.body };
  await saveSettings(next);
  res.json({ ok: true, settings: next });
});

app.post('/api/automation/:mode', async (req, res) => {
  const current = await loadSettings();
  const mode = req.params.mode;
  if (!['on', 'off'].includes(mode)) return res.status(400).json({ error: 'Mode must be on or off' });
  const enabled = mode === 'on';
  const next = {
    ...current,
    indiamartSyncEnabled: enabled,
    autoResponseEnabled: enabled
  };
  await saveSettings(next);
  if (enabled) {
    setTimeout(async () => {
      try {
        console.log('[Automation] Turned ON - fetching pending IndiaMART leads now...');
        const r = await fetch(`http://localhost:${PORT}/api/indiamart/leads`);
        const result = await r.json();
        if (result.ok) {
          console.log(`[Automation] Pending lead sync complete. Added ${result.added} new leads.`);
        } else {
          console.log(`[Automation] Pending lead sync issue: ${result.error || 'unknown'}`);
        }
      } catch (e) {
        console.log(`[Automation] Pending lead sync failed: ${e.message}`);
      }
    }, 500);
  }
  res.json({ ok: true, enabled, settings: next });
});


app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const ext = path.extname(req.file.originalname).toLowerCase();
  const name = req.file.fieldname === 'signature' ? `signature${ext}` : `brochure${ext}`;
  const dest = path.join(UPLOADS_DIR, name);
  fs.renameSync(req.file.path, dest);
  res.json({ ok: true, path: `/assets/${name}`, name });
});

app.get('/api/indiamart/leads', async (req, res) => {
  const settings = await loadSettings();
  if (!await isAutomationEnabled(settings)) {
    return res.status(423).json({ error: 'Webapp is OFF. Turn ON to fetch IndiaMART leads.', automationOff: true });
  }
  const apiKey = settings.indiamartApiKey;
  if (!apiKey) return res.status(400).json({ error: 'IndiaMART API key not configured' });

  // IndiaMART CRM API v2 expects: DD-MMM-YYYY HH:MM:SS  e.g. 01-Jun-2026 00:00:00
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

  const data = await loadData();
  const end = new Date();
  let start;
  if (data.lastSyncTime) {
    start = new Date(new Date(data.lastSyncTime).getTime() - 30 * 60 * 1000); // overlap 30 mins
  } else {
    start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days fallback
  }

  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${apiKey}&start_time=${encodeURIComponent(fmt(start))}&end_time=${encodeURIComponent(fmt(end))}`;
  console.log('[IndiaMART] Fetching:', url);
  try {
    const imRes = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const text = await imRes.text();
    console.log('[IndiaMART] Raw response (first 500):', text.slice(0, 500));
    let json;
    try { json = JSON.parse(text); } catch { return res.status(502).json({ error: 'Bad response from IndiaMART', raw: text.slice(0, 500) }); }

    if (Number(json.CODE) === 429) {
      return res.status(429).json({
        error: json.MESSAGE || 'IndiaMART API limit reached. Please wait 5 minutes and try again.',
        raw: json
      });
    }

    if (json.STATUS === 'Error' || json.STATUS === 'FAILURE' || json.CODE === 'error') {
      return res.status(502).json({ error: json.MESSAGE || json.message || 'IndiaMART API error', raw: json });
    }

    const existing = new Set(data.leads.map(l => l.indiamartId).filter(Boolean));
    const queuedAutoResponses = [];
    let added = 0;

    const rawLeads = json.RESPONSE || json.response || json.DATA || json.data || json.leads || (Array.isArray(json) ? json : []);
    const fetchedIndiaMartIds = new Set();
    for (const l of rawLeads) {
      const imId = String(l.UNIQUE_QUERY_ID || l.unique_query_id || l.QUERY_ID || '');
      const leadEmail = l.SENDER_EMAIL || l.sender_email || '';
      const leadPhone = l.SENDER_MOBILE || l.sender_mobile || l.SENDER_PHONE || l.sender_phone || '';
      if (imId) fetchedIndiaMartIds.add(imId);
      const duplicateByIndiaMartId = imId && existing.has(imId);
      const duplicateByFallback = !imId && hasExistingLead(data, { email: leadEmail, phone: leadPhone });
      if (duplicateByIndiaMartId || duplicateByFallback) continue;

      const emailVal = await validateEmail(leadEmail);
      const phoneVal = await validatePhone(
        leadPhone,
        settings.numverifyKey,
        l.SENDER_CITY || l.sender_city || '',
        l.SENDER_STATE || l.sender_state || ''
      );

      const lead = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        indiamartId: imId,
        source: 'IndiaMART',
        name: l.SENDER_NAME || l.sender_name || 'Unknown',
        company: l.SENDER_COMPANY || l.sender_company || '',
        email: leadEmail,
        phone: leadPhone,
        city: l.SENDER_CITY || l.sender_city || '',
        state: l.SENDER_STATE || l.sender_state || '',
        product: l.QUERY_PRODUCT_NAME || l.query_product_name || '',
        message: l.QUERY_MESSAGE || l.query_message || '',
        status: 'New',
        clientStatus: 'New',
        score: null,
        aiSummary: null,
        emailValid: emailVal.valid,
        emailReason: emailVal.reason,
        phoneValid: phoneVal.valid,
        phoneLocation: phoneVal.location,
        phoneCarrier: phoneVal.carrier,
        phoneLineType: phoneVal.lineType,
        phoneStatus: phoneVal.phoneStatus,
        phoneOwner: phoneVal.phoneOwner || null,
        createdAt: l.QUERY_TIME || l.query_time || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      data.leads.unshift(lead);
      if (imId) existing.add(imId);
      added++;

      // 🔔 Push live activity event for new lead
      pushActivity('new_lead',
        `🆕 New Lead — ${lead.name || 'Unknown'}`,
        `${lead.product || 'No product'} | ${lead.email || ''} | ${lead.city || ''}`,
        { leadId: lead.id, email: lead.email, product: lead.product, city: lead.city }
      );

      // Trigger Auto-responder if email is valid. If phone is provided, it must be valid. If missing, still send.
      const phoneOk = !lead.phone || phoneVal.valid;
      if (settings.autoResponseEnabled && emailVal.valid && lead.email && phoneOk) {
        queuedAutoResponses.push(lead);
      } else if (settings.autoResponseEnabled) {
        console.log(`[AutoResponse] Skipped for ${lead.name} — phone valid: ${phoneVal.valid}, email valid: ${emailVal.valid}`);
      }
    }

    // ✅ Only newly added leads in THIS sync get auto-response (not old existing leads)
    data.lastSyncTime = new Date().toISOString();
    await saveData(data);

    // Send auto-responses sequentially with delay to avoid Gmail rate limit block
    if (queuedAutoResponses.length > 0) {
      console.log(`[AutoResponse] Queuing ${queuedAutoResponses.length} emails with ${AUTO_EMAIL_DELAY_MS / 1000}s delay between each...`);
      (async () => {
        for (let i = 0; i < queuedAutoResponses.length; i++) {
          const lead = queuedAutoResponses[i];
          const now = Date.now();
          const timeSinceLast = now - lastAutoEmailSentAt;
          if (lastAutoEmailSentAt > 0 && timeSinceLast < AUTO_EMAIL_DELAY_MS) {
            const waitMs = AUTO_EMAIL_DELAY_MS - timeSinceLast;
            console.log(`[AutoResponse] Waiting ${Math.round(waitMs / 1000)}s before sending to ${lead.email}...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
          }
          // Dynamic check to support immediate cutoff when OFF is clicked
          const currentSettings = await loadSettings();
          if (currentSettings.indiamartSyncEnabled === false || currentSettings.autoResponseEnabled === false || !await isAutomationEnabled(currentSettings)) {
            console.log(`[AutoResponse] Webapp is OFF. Aborting sending autoresponse to ${lead.email}.`);
            break;
          }
          try {
            await triggerAutoResponse(lead, settings, data);
            lastAutoEmailSentAt = Date.now();
            console.log(`[AutoResponse] ✅ Sent ${i + 1}/${queuedAutoResponses.length} to ${lead.email}`);
          } catch (e) {
            console.error(`[AutoResponse] ❌ Failed for ${lead.email}:`, e.message);
          }
        }
        console.log(`[AutoResponse] All ${queuedAutoResponses.length} emails processed.`);
      })().catch(e => console.error('[AutoResponse] Queue error:', e));
    }

    res.json({ ok: true, added, total: rawLeads.length, leads: data.leads });
  } catch (err) {
    console.error('[IndiaMART] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Debug: shows exact URL + raw IndiaMART response (open in browser to diagnose)
app.get('/api/indiamart/debug', async (req, res) => {
  const settings = await loadSettings();
  const apiKey = settings.indiamartApiKey;
  if (!apiKey) return res.json({ error: 'No API key set. Add INDIAMART_API_KEY in .env' });
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
  const end = new Date();
  const start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // last 7 days
  const url = `https://mapi.indiamart.com/wservce/crm/crmListing/v2/?glusr_crm_key=${apiKey}&start_time=${encodeURIComponent(fmt(start))}&end_time=${encodeURIComponent(fmt(end))}`;
  try {
    const imRes = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const text = await imRes.text();
    res.json({ url, httpStatus: imRes.status, raw: text.slice(0, 2000) });
  } catch(e) { res.json({ url, error: e.message }); }
});

app.get('/api/leads', async (req, res) => { const d = await loadData(); res.json(d.leads); });

app.post('/api/leads', async (req, res) => {
  const d = await loadData();
  const settings = await loadSettings();
  const alreadyExists = hasExistingLead(d, { email: req.body.email, phone: req.body.phone });
  
  // Run validations in parallel to speed up save
  const [emailVal, phoneVal] = await Promise.all([
    validateEmail(req.body.email || ''),
    validatePhone(
      req.body.phone || '',
      settings.numverifyKey,
      req.body.city || '',
      req.body.state || ''
    )
  ]);

  const lead = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    ...req.body,
    source: 'Manual',
    status: 'New',
    clientStatus: 'New',
    score: null,
    aiSummary: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...req.body,
    emailValid: emailVal.valid,
    emailReason: emailVal.reason,
    phoneValid: phoneVal.valid,
    phoneLocation: phoneVal.location,
    phoneCarrier: phoneVal.carrier,
    phoneLineType: phoneVal.lineType,
    phoneStatus: phoneVal.phoneStatus,
    phoneOwner: phoneVal.phoneOwner || null
  };
  d.leads.unshift(lead);
  await saveData(d);

  // Trigger Auto-responder for manual leads if email is valid. If phone is provided, it must be valid.
  const phoneOk = !lead.phone || phoneVal.valid;
  if (!alreadyExists && settings.autoResponseEnabled && emailVal.valid && lead.email && phoneOk) {
    console.log(`[AutoResponse] Triggering for manual lead ${lead.name} in background...`);
    triggerAutoResponse(lead, settings, d).catch(e => console.error('[AutoResponse] Failed:', e));
  } else if (alreadyExists && settings.autoResponseEnabled) {
    console.log(`[AutoResponse] Skipped for manual lead ${lead.name} - contact already exists.`);
  } else if (settings.autoResponseEnabled) {
    console.log(`[AutoResponse] Skipped for manual lead ${lead.name} — phone valid: ${phoneVal.valid}, email valid: ${emailVal.valid}`);
  }

  // Background Caller Name Lookup so it doesn't block UI
  if (settings.geminiKey && phoneVal.valid && lead.phone) {
    lookupCallerName(lead.phone, settings.geminiKey).then(async name => {
      if (name) {
        const freshData = await loadData();
        const idx = freshData.leads.findIndex(l => l.id === lead.id);
        if (idx !== -1) {
          freshData.leads[idx].phoneOwner = name;
          await saveData(freshData);
          console.log(`[Background] Caller Name found for ${lead.phone}: ${name}`);
        }
      }
    }).catch(e => console.error('[Background Lookup Error]:', e));
  }

  res.json(lead);
});

app.put('/api/leads/:id', async (req, res) => {
  const d = await loadData();
  const i = d.leads.findIndex(l => l.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Not found' });

  const settings = await loadSettings();
  let updatedFields = { ...req.body };

  const emailChanged = (req.body.email !== undefined && req.body.email !== d.leads[i].email) || d.leads[i].emailValid === undefined;
  const phoneChanged = (req.body.phone !== undefined && req.body.phone !== d.leads[i].phone) || d.leads[i].phoneValid === undefined;
  const locationChanged = (req.body.city !== undefined && req.body.city !== d.leads[i].city) || 
                          (req.body.state !== undefined && req.body.state !== d.leads[i].state);

  let emailValPromise = null;
  let phoneValPromise = null;

  if (emailChanged) {
    emailValPromise = validateEmail(req.body.email || '');
  }
  if (phoneChanged || locationChanged) {
    phoneValPromise = validatePhone(
      req.body.phone !== undefined ? req.body.phone : d.leads[i].phone,
      settings.numverifyKey,
      req.body.city !== undefined ? req.body.city : d.leads[i].city,
      req.body.state !== undefined ? req.body.state : d.leads[i].state
    );
  }

  const [emailVal, phoneVal] = await Promise.all([
    emailValPromise || Promise.resolve(null),
    phoneValPromise || Promise.resolve(null)
  ]);

  if (emailVal) {
    updatedFields.emailValid = emailVal.valid;
    updatedFields.emailReason = emailVal.reason;
  }
  
  if (phoneVal) {
    updatedFields.phoneValid = phoneVal.valid;
    updatedFields.phoneLocation = phoneVal.location;
    updatedFields.phoneCarrier = phoneVal.carrier;
    updatedFields.phoneLineType = phoneVal.lineType;
    updatedFields.phoneStatus = phoneVal.phoneStatus;
    updatedFields.phoneOwner = phoneVal.phoneOwner || null;
  }

  d.leads[i] = { ...d.leads[i], ...updatedFields, updatedAt: new Date().toISOString() };
  await saveData(d);
  
  // Existing leads should not receive automatic emails when edited.
  // Auto-response is reserved for newly-created leads only.

  // Background Caller Name Lookup if phone changed
  if (phoneChanged && settings.geminiKey && updatedFields.phoneValid && updatedFields.phone) {
    lookupCallerName(updatedFields.phone, settings.geminiKey).then(async name => {
      if (name) {
        const freshData = await loadData();
        const idx = freshData.leads.findIndex(l => l.id === req.params.id);
        if (idx !== -1) {
          freshData.leads[idx].phoneOwner = name;
          await saveData(freshData);
          console.log(`[Background] Caller Name found for ${updatedFields.phone}: ${name}`);
        }
      }
    }).catch(e => console.error('[Background Lookup Error]:', e));
  }

  res.json(d.leads[i]);
});

app.delete('/api/leads/:id', async (req, res) => {
  const d = await loadData();
  d.leads = d.leads.filter(l => l.id !== req.params.id);
  await saveData(d);
  res.json({ ok: true });
});

// ─── Background Sync Jobs ───────────────────────────────────────────────────────
// IndiaMART API limit is 1 hit per 5 minutes. Poll at that cadence so new leads
// are picked up quickly, and run once shortly after startup.
const AUTO_SYNC_INTERVAL_MS = 6 * 60 * 1000;

async function runBackgroundSync() {
  const settings = await loadSettings();
  if (settings.indiamartSyncEnabled === false || settings.autoResponseEnabled === false || !await isAutomationEnabled(settings)) {
    console.log('[AutoSync] Webapp is OFF. Skipping background sync (IndiaMART & Gmail).');
    return;
  }
  if (settings.indiamartApiKey) {
    console.log('[AutoSync] Running background IndiaMART sync...');
    try {
      const r = await fetch(`http://localhost:${PORT}/api/indiamart/leads`);
      const result = await r.json();
      if (result.ok) {
        console.log(`[AutoSync] IndiaMART sync successful. Added ${result.added} new leads.`);
      } else {
        console.log(`[AutoSync] IndiaMART sync issue: ${result.error || 'unknown'}`);
      }
    } catch (e) {
      console.log(`[AutoSync] IndiaMART sync failed: ${e.message}`);
    }
  }
  
  // Gmail reply sync — throttled to avoid "too many connections"
  if (isSmtpConfigured(settings)) {
    try {
      console.log('[AutoSync] Running background Gmail reply sync...');
      const gmailResult = await syncImapReplies();
      if (gmailResult.ok) {
        console.log(`[AutoSync] Gmail sync successful. Found ${gmailResult.added} new replies.`);
      }
    } catch (e) {
      console.log(`[AutoSync] Gmail sync failed: ${e.message}`);
    }
  }
}

setTimeout(runBackgroundSync, 10 * 1000);
setInterval(runBackgroundSync, AUTO_SYNC_INTERVAL_MS);

// ─── AI Qualify (Gemini) ──────────────────────────────────────────────────────
// Exact model IDs supported by v1beta API (verified June 2026)
const GEMINI_MODELS = [
  { id: 'gemini-2.0-flash-lite',      api: 'v1beta' }, // highest free RPM
  { id: 'gemini-2.0-flash',           api: 'v1beta' }, // standard
  { id: 'gemini-1.5-flash-latest',    api: 'v1beta' }, // fallback
  { id: 'gemini-1.5-flash-8b-latest', api: 'v1beta' }, // lightest
  { id: 'gemini-1.5-pro-latest',      api: 'v1beta' }, // last resort
];

async function callGemini(apiKey, prompt) {
  let lastQuotaMsg = null;
  for (const { id, api } of GEMINI_MODELS) {
    try {
      console.log(`[Gemini] Trying: ${id}`);
      const r = await fetch(
        `https://generativelanguage.googleapis.com/${api}/models/${id}:generateContent?key=${apiKey}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
      );
      const data = await r.json();

      if (data.error) {
        const code = data.error.code || 0;
        const msg  = data.error.message || '';
        console.warn(`[Gemini] ${id} → ${code}: ${msg.slice(0, 140)}`);
        // Model not available for this API version → skip
        if (code === 404 || msg.includes('not found') || msg.includes('not supported') || msg.includes('ModelService')) {
          continue;
        }
        // Quota / rate limit → try next model
        if (code === 429 || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate')) {
          lastQuotaMsg = msg; continue;
        }
        throw new Error(`Gemini: ${msg}`);
      }

      if (!data.candidates?.[0]) throw new Error(`No response from ${id}`);
      console.log(`[Gemini] ✓ ${id}`);
      return data.candidates[0].content.parts[0].text;
    } catch (e) {
      const em = e.message || '';
      if (em.includes('quota') || em.includes('RESOURCE_EXHAUSTED') || em.includes('rate')) {
        lastQuotaMsg = em; continue;
      }
      throw e;
    }
  }
  const err = new Error('All Gemini models exhausted. Wait ~60 sec and retry, or get a new key at https://aistudio.google.com/apikey');
  err.quota = true;
  throw err;
}

function buildFallbackQualification(lead, reason = 'Gemini unavailable') {
  const text = [
    lead.name,
    lead.company,
    lead.city,
    lead.state,
    lead.product,
    lead.message,
    lead.phone,
    lead.email,
    lead.source
  ].filter(Boolean).join(' ').toLowerCase();

  let score = 35;
  const strengths = [];
  const risks = [];

  if (lead.emailValid) { score += 12; strengths.push('Valid business email'); }
  else risks.push('Email validity is unknown or failed');

  if (lead.phoneValid) { score += 15; strengths.push('Reachable phone number'); }
  else if (lead.phone) { score += 5; risks.push('Phone number needs manual verification'); }
  else risks.push('Phone number is missing');

  if (lead.product || lead.message) { score += 12; strengths.push('Specific service requirement is present'); }
  else risks.push('Requirement details are limited');

  if (lead.company) { score += 8; strengths.push('Company name is available'); }
  if (lead.city || lead.state) { score += 5; strengths.push('Location is available'); }

  if (/(urgent|immediate|quotation|quote|price|cost|bulk|requirement|needed|design|package|vector|photo|editing|logo|brochure|catalogue)/i.test(text)) {
    score += 12;
    strengths.push('Enquiry language suggests active buying interest');
  }

  if (/(student|job|career|free|internship|spam|wrong number)/i.test(text)) {
    score -= 20;
    risks.push('Lead text contains low-fit keywords');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const status = score >= 70 ? 'Hot' : score >= 45 ? 'Warm' : 'Cold';
  const firstName = String(lead.name || 'there').split(' ')[0] || 'there';
  const product = lead.product || 'your enquiry';
  const contact = lead.phone ? 'call' : 'email';

  return {
    score,
    status,
    summary: `${lead.name || 'This lead'} looks ${status.toLowerCase()} based on contact quality, requirement detail, and buying signals.`,
    strengths: strengths.length ? strengths.slice(0, 4) : ['Basic lead details are available'],
    risks: risks.length ? risks.slice(0, 4) : ['No major risk signals found by the fallback scorer'],
    next_action: `Follow up by ${contact} and confirm scope, quantity, budget, and timeline.`,
    suggested_subject: `Regarding ${product} | ODD INFOTECH`,
    suggested_body: `Hi ${firstName},\n\nThank you for your enquiry about ${product}.\nCould you please share your requirement details, expected timeline, and budget range?\nWe can then suggest the best next step.\n\nBest regards`,
    fallback: true
  };
}

app.post('/api/qualify/:id', async (req, res) => {
  const d = await loadData();
  const lead = d.leads.find(l => l.id === req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const settings = await loadSettings();

  const prompt = `You are a B2B lead qualification expert for an Indian business. Analyse and return ONLY valid JSON, no markdown.

Lead:
Name: ${lead.name}
Company: ${lead.company}
City: ${lead.city}, ${lead.state}
Product enquired: ${lead.product}
Message: ${lead.message}
Phone: ${lead.phone}
Email: ${lead.email}
Source: ${lead.source}

Return:
{
  "score": <0-100>,
  "status": "<Hot|Warm|Cold>",
  "summary": "<2 sentence summary>",
  "strengths": ["...","..."],
  "risks": ["...","..."],
  "next_action": "<specific step>",
  "suggested_subject": "<email subject line>",
  "suggested_body": "<short professional email body in English, 4-5 lines>"
}`;

  try {
    let q;
    if (!settings.geminiKey) {
      q = buildFallbackQualification(lead, 'Gemini API key is not configured');
    } else {
      const text = await callGemini(settings.geminiKey, prompt);
      q = JSON.parse(text.replace(/```json|```/g, '').trim());
    }

    const i = d.leads.findIndex(l => l.id === req.params.id);
    d.leads[i].score = q.score;
    d.leads[i].status = q.status;
    d.leads[i].aiSummary = q.summary;
    d.leads[i].updatedAt = new Date().toISOString();
    await saveData(d);
    res.json({ lead: d.leads[i], qualify: q });
  } catch (e) {
    console.error('[Qualify]', e.message);
    const isQuota = e.quota || e.message.includes('quota') || e.message.includes('Quota') || e.message.includes('RESOURCE_EXHAUSTED') || e.message.includes('rate');
    if (isQuota) {
      const q = buildFallbackQualification(lead, 'Gemini quota is exhausted');
      const i = d.leads.findIndex(l => l.id === req.params.id);
      d.leads[i].score = q.score;
      d.leads[i].status = q.status;
      d.leads[i].aiSummary = q.summary;
      d.leads[i].updatedAt = new Date().toISOString();
      await saveData(d);
      return res.json({
        lead: d.leads[i],
        qualify: q,
        warning: 'Gemini quota is exhausted, so a local fallback score was used.'
      });
    }

    res.status(500).json({ error: e.message });
  }
});

app.get('/api/emails', async (req, res) => { const d = await loadData(); res.json(d.emails || []); });
app.get('/api/emails/:leadId', async (req, res) => { const d = await loadData(); res.json((d.emails || []).filter(e => e.leadId === req.params.leadId)); });

app.post('/api/emails', async (req, res) => {
  const d = await loadData();
  if (!d.emails) d.emails = [];
  const email = { id: Date.now().toString(36), sentAt: new Date().toISOString(), ...req.body };
  d.emails.push(email);
  const leadIdx = d.leads.findIndex(l => l.id === leadId);
  if (leadIdx !== -1) {
    d.leads[leadIdx].clientStatus = 'Contacted';
    d.leads[leadIdx].updatedAt = new Date().toISOString();
  }
  await saveData(d);
  res.json(email);
});

app.delete('/api/emails/:id', async (req, res) => {
  const d = await loadData();
  if (!d.emails) d.emails = [];
  d.emails = d.emails.filter(e => e.id !== req.params.id);
  await saveData(d);
  res.json({ ok: true });
});

app.post('/api/send-email', requireAutomationOn, async (req, res) => {
  const settings = await loadSettings();
  const { leadId, to, subject, body, attachments } = req.body;

  const d = await loadData();
  if (!d.emails) d.emails = [];
  const email = { id: Date.now().toString(36), leadId, to, subject, body, direction: 'sent', sentAt: new Date().toISOString(), attachments: attachments || [] };
  d.emails.push(email);
  await saveData(d);

  if (isSmtpConfigured(settings)) {
    try {
      const transporter = createSmtpTransport(settings);
      const mailOpts = {
        from: settings.smtpUser,
        to,
        subject,
        html: String(body || '').replace(/\n/g,'<br>'),
        attachments: buildUploadedAttachments(attachments)
      };
      await sendMailWithRetry(transporter, mailOpts);
      res.json({ ok: true, sent: true, emailId: email.id });
    } catch (e) { res.json({ ok: true, sent: false, logged: true, error: e.message, emailId: email.id }); }
  } else {
    res.json({ ok: true, sent: false, logged: true, note: 'SMTP not configured — email logged only', emailId: email.id });
  }
});

// ─── Bulk Email (by Hot / Warm / Cold / etc status group) ─────────────────────
app.post('/api/send-bulk-email', requireAutomationOn, async (req, res) => {
  const settings = await loadSettings();
  const { statuses, leadIds, subject, body, attachments } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'Subject and body are required' });

  const d = await loadData();
  if (!d.emails) d.emails = [];

  let targets;
  if (Array.isArray(leadIds) && leadIds.length) {
    const idSet = new Set(leadIds);
    targets = d.leads.filter(l => idSet.has(l.id) && l.email);
  } else if (Array.isArray(statuses) && statuses.length) {
    targets = d.leads.filter(l => statuses.includes(l.status) && l.email);
  } else {
    return res.status(400).json({ error: 'No lead group selected' });
  }
  if (!targets.length) return res.json({ ok: true, sent: 0, failed: 0, total: 0, results: [] });

  let transporter = null;
  if (isSmtpConfigured(settings)) {
    transporter = createSmtpTransport(settings);
  }

  const results = [];
  for (const lead of targets) {
    const personalizedSubject = subject.replace(/\{\{\s*name\s*\}\}/gi, lead.name || '').replace(/\{\{\s*company\s*\}\}/gi, lead.company || '').replace(/\{\{\s*product\s*\}\}/gi, lead.product || '');
    const personalizedBody = body.replace(/\{\{\s*name\s*\}\}/gi, lead.name || '').replace(/\{\{\s*company\s*\}\}/gi, lead.company || '').replace(/\{\{\s*product\s*\}\}/gi, lead.product || '');

    const email = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), leadId: lead.id, to: lead.email, subject: personalizedSubject, body: personalizedBody, direction: 'sent', sentAt: new Date().toISOString(), attachments: attachments || [], bulk: true };

    let sent = false, error = null;
    if (transporter) {
      try {
        const mailOpts = {
          from: settings.smtpUser,
          to: lead.email,
          subject: personalizedSubject,
          html: personalizedBody.replace(/\n/g, '<br>'),
          attachments: buildUploadedAttachments(attachments)
        };
        await sendMailWithRetry(transporter, mailOpts);
        sent = true;
      } catch (e) { error = e.message; }
    }
    d.emails.push(email);
    const leadIdx = d.leads.findIndex(l => l.id === lead.id);
    if (leadIdx !== -1) {
      d.leads[leadIdx].clientStatus = 'Contacted';
      d.leads[leadIdx].updatedAt = new Date().toISOString();
    }
    results.push({ leadId: lead.id, name: lead.name, email: lead.email, sent, error });
  }
  await saveData(d);

  const sentCount = results.filter(r => r.sent).length;
  res.json({ ok: true, sent: sentCount, failed: results.length - sentCount, total: results.length, smtpConfigured: !!transporter, results });
});

app.post('/api/reply', requireAutomationOn, async (req, res) => {
  const d = await loadData();
  if (!d.emails) d.emails = [];
  const reply = { id: Date.now().toString(36), direction: 'received', receivedAt: new Date().toISOString(), ...req.body };
  d.emails.push(reply);

  const lead = d.leads.find(l => l.id === req.body.leadId);
  if (lead && (lead.clientStatus === 'Prospect' || lead.clientStatus === 'New' || lead.clientStatus === 'Contacted')) {
    lead.clientStatus = 'Replied in IndiaMART';
    lead.updatedAt = new Date().toISOString();
  }
  await saveData(d);
  res.json(reply);
});

app.post('/api/emails/sync-replies', requireAutomationOn, async (req, res) => {
  const result = await syncImapReplies();
  res.json(result);
});

app.post('/api/leads/upload-excel', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(worksheet);

    const data = await loadData();
    const settings = await loadSettings();
    let addedCount = 0;

    for (const r of rows) {
      const name = r.Name || r.name || r['Lead Name'] || r['Contact Name'] || '';
      const email = r.Email || r.email || r['Email Address'] || '';
      const phone = r.Phone || r.phone || r['Phone Number'] || r['Mobile'] || '';
      
      if (!name || !email) continue;
      if (hasExistingLead(data, { email, phone })) continue;

      const company = r.Company || r.company || '';
      const city = r.City || r.city || '';
      const state = r.State || r.state || '';
      const product = r.Product || r.product || r['Product Name'] || '';
      const message = r.Message || r.message || r.Notes || r.notes || '';

      const emailVal = await validateEmail(email);
      const phoneVal = await validatePhone(phone, settings.numverifyKey, city, state);

      const lead = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
        source: 'Excel Import',
        name,
        company,
        email,
        phone,
        city,
        state,
        product,
        message,
        status: 'New',
        clientStatus: 'New',
        score: null,
        aiSummary: null,
        emailValid: emailVal.valid,
        emailReason: emailVal.reason,
        phoneValid: phoneVal.valid,
        phoneLocation: phoneVal.location,
        phoneCarrier: phoneVal.carrier,
        phoneLineType: phoneVal.lineType,
        phoneStatus: phoneVal.phoneStatus,
        phoneOwner: phoneVal.phoneOwner || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      data.leads.unshift(lead);
      addedCount++;
    }

    fs.unlinkSync(req.file.path);

    if (addedCount > 0) {
      await saveData(data);
    }

    res.json({ ok: true, added: addedCount, leads: data.leads });
  } catch (err) {
    console.error('[Excel Import Error]', err);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/followups', async (req, res) => { const d = await loadData(); res.json(d.followups || []); });
app.post('/api/followups', requireAutomationOn, async (req, res) => {
  const d = await loadData();
  if (!d.followups) d.followups = [];
  const existing = d.followups.findIndex(f => f.leadId === req.body.leadId);
  const item = { id: Date.now().toString(36), createdAt: new Date().toISOString(), ...req.body };
  if (existing >= 0) d.followups[existing] = { ...d.followups[existing], ...req.body };
  else d.followups.push(item);
  await saveData(d);
  res.json(existing >= 0 ? d.followups[existing] : item);
});
app.patch('/api/followups/:leadId/stop', async (req, res) => {
  const d = await loadData();
  if (!d.followups) d.followups = [];
  const existing = d.followups.findIndex(f => f.leadId === req.params.leadId || f.id === req.params.leadId);
  if (existing < 0) return res.status(404).json({ error: 'Followup not found' });
  d.followups[existing] = {
    ...d.followups[existing],
    date: '',
    time: '',
    datetime: '',
    stoppedAt: new Date().toISOString()
  };
  await saveData(d);
  res.json(d.followups[existing]);
});
app.delete('/api/followups/:leadId', async (req, res) => {
  const d = await loadData();
  const before = (d.followups || []).length;
  d.followups = (d.followups || []).filter(f => f.leadId !== req.params.leadId && f.id !== req.params.leadId);
  if (d.followups.length === before) return res.status(404).json({ error: 'Followup not found' });
  await saveData(d);
  res.json({ ok: true });
});

app.get('/api/export/csv', async (req, res) => {
  const d = await loadData();
  const headers = ['Name','Company','Email','Phone','City','State','Product','Message','Status','AI Score','Client Status','Source','Created','Followup Date','Emails Sent'];
  const rows = d.leads.map(l => {
    const fu = (d.followups || []).find(f => f.leadId === l.id);
    const emails = (d.emails || []).filter(e => e.leadId === l.id && e.direction === 'sent').length;
    return [l.name, l.company, l.email, l.phone, l.city, l.state, l.product, (l.message||'').replace(/,/g,';').replace(/\n/g,' '), l.status||'New', l.score||'', l.clientStatus||'Prospect', l.source||'', l.createdAt?.slice(0,10)||'', fu?.date||'', emails].map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads.csv"');
  res.send(csv);
});

// ─── SSE: Live Activity Stream endpoint ──────────────────────────────────────
app.get('/api/activity/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // Send last 50 events as history on connect
  const history = activityLog.slice(0, 50).reverse();
  res.write(`data: ${JSON.stringify({ type: 'history', events: history })}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Heartbeat every 25s to keep connection alive
  const hb = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); }
  }, 25000);
  req.on('close', () => clearInterval(hb));
});

// ─── REST: Get activity log ───────────────────────────────────────────────────
app.get('/api/activity', (req, res) => {
  res.json(activityLog.slice(0, 100));
});

// Connect to MongoDB (if URI is provided) and start the server
(async () => {
  if (process.env.MONGODB_URI) {
    await connectToMongo();
  } else {
    console.log('⚠️ MONGODB_URI not set. Running in local file fallback mode.');
  }
  app.listen(PORT, () => console.log(`\n🚀  IndiaMART CRM running at http://localhost:${PORT}\n`));
})();
