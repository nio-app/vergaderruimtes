/**
 * Vergaderruimtes – Gmail-koppeling
 *
 * Leest Outlook-uitnodigingen die naar de ruimte-adressen (basis+alias@gmail.com) worden gestuurd,
 * boekt ze in Supabase en stuurt een acceptatie of weigering terug naar de organisator.
 *
 * Installatie: zie README.md. Kort: plak dit in script.google.com (ingelogd als het ruimte-Gmailaccount),
 * zet appsscript.json erbij, voer één keer `installeer` uit en geef toestemming.
 */

const CONFIG = {
  SUPABASE_URL: 'https://usvpblwyejmewgnfhulb.supabase.co',
  SUPABASE_KEY: 'sb_publishable_oXM5qHIc0RGQw1lV3F7Frw_ZyTM_ySo',
  INGEST_SECRET: 'PLAK_HIER_DE_SLEUTEL',
  DEFAULT_TZ: 'Europe/Amsterdam',
  MAX_OCCURRENCES: 104,      // max. aantal herhalingen van een terugkerende vergadering
  HORIZON_DAYS: 366,         // herhalingen verder dan dit worden niet geboekt
  LABEL: 'Ruimte-verwerkt'
};

/** Eén keer uitvoeren: maakt de 5-minuten-trigger aan. */
function installeer() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verwerkUitnodigingen').timeBased().everyMinutes(1).create();
  ScriptApp.newTrigger('houdWakker').timeBased().everyDays(1).atHour(6).create();
  GmailApp.createLabel(CONFIG.LABEL);
  verwerkUitnodigingen();
  Logger.log('Klaar: de mailbox wordt nu elke minuut gecontroleerd.');
}

/** Hoofdfunctie, draait elke 5 minuten. */
function verwerkUitnodigingen() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const done = JSON.parse(props.getProperty('verwerkt') || '[]');
    const doneSet = new Set(done);
    const me = Session.getEffectiveUser().getEmail().toLowerCase();
    const label = GmailApp.getUserLabelByName(CONFIG.LABEL) || GmailApp.createLabel(CONFIG.LABEL);

    const threads = GmailApp.search('in:inbox newer_than:14d', 0, 50);
    for (const thread of threads) {
      for (const message of thread.getMessages()) {
        const id = message.getId();
        if (doneSet.has(id)) continue;
        doneSet.add(id); done.push(id);
        try {
          if (extractEmail(message.getFrom()) === me) continue;
          verwerkBericht(message, me);
        } catch (err) {
          console.error('Fout bij bericht ' + id + ': ' + err);
        }
      }
      thread.addLabel(label);
      thread.moveToArchive();
    }
    props.setProperty('verwerkt', JSON.stringify(done.slice(-400)));
  } finally {
    lock.releaseLock();
  }
}

function verwerkBericht(message, me) {
  const icsText = vindIcs(message);
  if (!icsText) return;
  const cal = parseIcs(icsText);
  if (!cal.event) return;
  const method = (cal.method || 'REQUEST').toUpperCase();
  if (method !== 'REQUEST' && method !== 'CANCEL') return;   // REPLY/COUNTER e.d. negeren

  const ev = cal.event;
  const [base, domain] = me.split('@');
  // Welke ruimtes zijn uitgenodigd? Kijk in ATTENDEE-regels én in de To/Cc-headers.
  const adressen = new Set();
  (ev.props.ATTENDEE || []).forEach(a => adressen.add(mailto(a.value)));
  [message.getTo(), message.getCc()].join(',').split(',').forEach(a => adressen.add(extractEmail(a)));
  const aliassen = new Set();
  adressen.forEach(a => {
    const m = a && a.match(new RegExp('^' + escapeRe(base) + '\\+([a-z0-9-]+)@' + escapeRe(domain) + '$'));
    if (m) aliassen.add(m[1]);
  });
  if (!aliassen.size) return;

  const org = first(ev.props.ORGANIZER);
  const organizerEmail = org ? mailto(org.value) : extractEmail(message.getFrom());
  const organizerName = (org && org.params.CN) || extractName(message.getFrom());
  const payloadBase = {
    method: method,
    uid: val(ev, 'UID'),
    sequence: parseInt(val(ev, 'SEQUENCE') || '0', 10),
    organizer_email: organizerEmail,
    organizer_name: organizerName,
    title: unescapeText(val(ev, 'SUMMARY') || 'Overleg')
  };
  const occurrences = method === 'REQUEST' ? berekenTijden(ev) : [];

  aliassen.forEach(alias => {
    const payload = Object.assign({}, payloadBase, { room_alias: alias, occurrences: occurrences });
    const res = callSupabase(payload);
    console.log(alias + ' → ' + JSON.stringify(res));
    const roomAddr = base + '+' + alias + '@' + domain;
    if (res.status === 'accepted') stuurAntwoord(ev, cal, 'ACCEPTED', res, roomAddr, organizerEmail, occurrences);
    if (res.status === 'declined') stuurAntwoord(ev, cal, 'DECLINED', res, roomAddr, organizerEmail, occurrences);
  });
}

// ---------- Supabase ----------
function callSupabase(payload) {
  const resp = UrlFetchApp.fetch(CONFIG.SUPABASE_URL + '/rest/v1/rpc/ingest_email_booking', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: CONFIG.SUPABASE_KEY },
    payload: JSON.stringify({ p_secret: CONFIG.INGEST_SECRET, p_payload: payload }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() >= 300) throw new Error('Supabase ' + resp.getResponseCode() + ': ' + resp.getContentText());
  return JSON.parse(resp.getContentText());
}

// ---------- Antwoord naar organisator ----------
function stuurAntwoord(ev, cal, partstat, res, roomAddr, organizerEmail, occurrences) {
  const roomName = res.room || 'Vergaderruimte';
  const titel = unescapeText(val(ev, 'SUMMARY') || 'Overleg');
  const stamp = Utilities.formatDate(new Date(), 'UTC', "yyyyMMdd'T'HHmmss'Z'");
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Vergaderruimtes//NL', 'VERSION:2.0', 'METHOD:REPLY', 'BEGIN:VEVENT',
    'UID:' + val(ev, 'UID'),
    'SEQUENCE:' + (val(ev, 'SEQUENCE') || '0'),
    'DTSTAMP:' + stamp
  ];
  ['DTSTART', 'DTEND', 'RRULE', 'RECURRENCE-ID'].forEach(k => { const p = first(ev.props[k]); if (p) lines.push(p.raw); });
  const org = first(ev.props.ORGANIZER); if (org) lines.push(org.raw);
  lines.push('ATTENDEE;PARTSTAT=' + partstat + ';CN="' + roomName.replace(/"/g, '') + '":mailto:' + roomAddr);
  lines.push('SUMMARY:' + (partstat === 'ACCEPTED' ? 'Geaccepteerd: ' : 'Geweigerd: ') + val(ev, 'SUMMARY'));
  lines.push('END:VEVENT', 'END:VCALENDAR');
  const ics = lines.join('\r\n');

  const wanneer = occurrences.length
    ? fmt(new Date(occurrences[0].start)) + (occurrences.length > 1 ? ' (+' + (occurrences.length - 1) + ' herhalingen)' : '')
    : '';
  let body;
  if (partstat === 'ACCEPTED') {
    body = roomName + ' is voor je gereserveerd.\n\n' + titel + '\n' + wanneer + '\n';
  } else {
    body = roomName + ' kan deze vergadering helaas niet accepteren.\n\n' + titel + '\n' + wanneer + '\n\nReden: ' + (res.reason || 'onbekend') + '\n';
    if (res.conflicts && res.conflicts.length) {
      body += '\nAl bezet op:\n' + res.conflicts.slice(0, 10).map(c =>
        '- ' + fmt(new Date(c.start)) + '–' + Utilities.formatDate(new Date(c.end), CONFIG.DEFAULT_TZ, 'HH:mm') + '  ' + c.title + ' (' + c.by + ')').join('\n') + '\n';
    }
    body += '\nKies een ander tijdstip of een andere ruimte. Bekijk de planning op de reserveringssite.';
  }
  GmailApp.sendEmail(organizerEmail, (partstat === 'ACCEPTED' ? 'Geaccepteerd: ' : 'Geweigerd: ') + titel, body, {
    name: roomName,
    replyTo: roomAddr,
    attachments: [Utilities.newBlob(ics, 'text/calendar; charset=UTF-8; method=REPLY', 'antwoord.ics')]
  });
}

// ---------- ICS vinden in de mail ----------
function vindIcs(message) {
  const atts = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  for (const a of atts) {
    const type = (a.getContentType() || '').toLowerCase();
    if (type.indexOf('calendar') >= 0 || /\.ics$/i.test(a.getName() || '')) {
      const txt = a.getDataAsString('UTF-8');
      if (txt.indexOf('BEGIN:VCALENDAR') >= 0) return txt;
    }
  }
  // Fallback: text/calendar-deel in de ruwe MIME-inhoud
  const raw = message.getRawContent();
  const re = /Content-Type:\s*text\/calendar[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--)/gi;
  let m;
  while ((m = re.exec(raw))) {
    const header = raw.substring(m.index, m.index + 400);
    let body = m[1];
    if (/Content-Transfer-Encoding:\s*base64/i.test(header)) {
      body = Utilities.newBlob(Utilities.base64Decode(body.replace(/\s/g, ''))).getDataAsString('UTF-8');
    } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(header)) {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    }
    if (body.indexOf('BEGIN:VCALENDAR') >= 0) return body;
  }
  return null;
}

// ---------- ICS parser ----------
function parseIcs(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
  const cal = { method: null, event: null };
  let cur = null, depth = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const p = parseLine(line);
    if (p.name === 'BEGIN') { depth.push(p.value.toUpperCase()); if (p.value.toUpperCase() === 'VEVENT') cur = { props: {} }; continue; }
    if (p.name === 'END') {
      const what = depth.pop();
      if (what === 'VEVENT' && cur) {
        // hoofd-afspraak (zonder RECURRENCE-ID) heeft voorrang
        if (!cal.event || (cal.event.props['RECURRENCE-ID'] && !cur.props['RECURRENCE-ID'])) cal.event = cur;
        cur = null;
      }
      continue;
    }
    if (depth.length === 1 && p.name === 'METHOD') cal.method = p.value.trim();
    if (cur && depth[depth.length - 1] === 'VEVENT') (cur.props[p.name] = cur.props[p.name] || []).push(p);
  }
  return cal;
}

function parseLine(line) {
  let i = 0, inQ = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQ = !inQ;
    else if (c === ':' && !inQ) break;
  }
  const head = line.substring(0, i), value = line.substring(i + 1);
  const parts = [];
  let buf = '', q = false;
  for (const c of head) {
    if (c === '"') { q = !q; continue; }
    if (c === ';' && !q) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  parts.push(buf);
  const params = {};
  parts.slice(1).forEach(s => { const k = s.indexOf('='); if (k > 0) params[s.substring(0, k).toUpperCase()] = s.substring(k + 1); });
  return { name: parts[0].toUpperCase(), params: params, value: value, raw: line };
}

// ---------- Tijden en herhalingen ----------
function berekenTijden(ev) {
  const ds = first(ev.props.DTSTART);
  if (!ds) return [];
  const start = parseIcsDate(ds);
  let end;
  const de = first(ev.props.DTEND);
  if (de) end = parseIcsDate(de);
  else if (val(ev, 'DURATION')) end = new Date(start.getTime() + parseDuration(val(ev, 'DURATION')));
  else end = new Date(start.getTime() + (ds.params.VALUE === 'DATE' ? 86400000 : 3600000));
  const dur = end.getTime() - start.getTime();
  if (dur <= 0) return [];

  const rrule = val(ev, 'RRULE');
  let starts = rrule ? expandRrule(start, rrule) : [start];

  const ex = new Set();
  (ev.props.EXDATE || []).forEach(p => p.value.split(',').forEach(v => {
    try { ex.add(parseIcsDate({ value: v, params: p.params }).getTime()); } catch (e) {}
  }));
  starts = starts.filter(s => !ex.has(s.getTime()));

  return starts.map(s => ({ start: s.toISOString(), end: new Date(s.getTime() + dur).toISOString() }));
}

function tzFor(params) {
  const t = (params && params.TZID || '').replace(/"/g, '');
  if (/^[A-Za-z]+\/[A-Za-z_]+/.test(t)) return t;            // IANA, bijv. Europe/Amsterdam
  if (/GMT Standard|Greenwich/i.test(t)) return 'Europe/London';
  if (/UTC|Coordinated Universal/i.test(t)) return 'UTC';
  return CONFIG.DEFAULT_TZ;                                    // W. Europe / Romance / onbekend
}

function parseIcsDate(p) {
  const v = p.value.trim();
  if (/^\d{8}$/.test(v)) return Utilities.parseDate(v + 'T000000', tzFor(p.params), "yyyyMMdd'T'HHmmss");
  if (/Z$/.test(v)) return Utilities.parseDate(v.replace('Z', ''), 'UTC', "yyyyMMdd'T'HHmmss");
  return Utilities.parseDate(v.substring(0, 15), tzFor(p.params), "yyyyMMdd'T'HHmmss");
}

function parseDuration(d) {
  const m = d.match(/P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/);
  if (!m) return 3600000;
  return ((+m[1] || 0) * 7 * 86400 + (+m[2] || 0) * 86400 + (+m[3] || 0) * 3600 + (+m[4] || 0) * 60 + (+m[5] || 0)) * 1000;
}

/** Ondersteunt DAILY, WEEKLY (met BYDAY), MONTHLY (dag van de maand of n-de weekdag). Rekent in Amsterdamse tijd. */
function expandRrule(start, rrule) {
  const r = {};
  rrule.split(';').forEach(kv => { const [k, v] = kv.split('='); r[k.toUpperCase()] = v; });
  const freq = r.FREQ, interval = parseInt(r.INTERVAL || '1', 10);
  const count = r.COUNT ? parseInt(r.COUNT, 10) : null;
  const horizon = new Date(Date.now() + CONFIG.HORIZON_DAYS * 86400000);
  let until = r.UNTIL ? parseIcsDate({ value: r.UNTIL, params: {} }) : null;
  if (until && r.UNTIL.length === 8) until = new Date(until.getTime() + 86399000);   // hele dag meetellen
  const limit = until && until < horizon ? until : horizon;
  const days = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
  // wandkloktijd van de start in Amsterdam (scripttijdzone = Europe/Amsterdam, zie appsscript.json)
  const parts = Utilities.formatDate(start, CONFIG.DEFAULT_TZ, 'yyyy-MM-dd-HH-mm').split('-').map(Number);
  const mk = (y, mo, d) => new Date(y, mo - 1, d, parts[3], parts[4], 0);
  const out = [];
  const push = (d) => { if (d >= start && d <= limit && out.length < CONFIG.MAX_OCCURRENCES && (!count || out.length < count)) out.push(d); };
  const full = () => out.length >= CONFIG.MAX_OCCURRENCES || (count && out.length >= count);

  if (freq === 'DAILY') {
    for (let i = 0; !full(); i += interval) {
      const d = mk(parts[0], parts[1], parts[2] + i); if (d > limit) break; push(d);
    }
  } else if (freq === 'WEEKLY') {
    const byday = (r.BYDAY ? r.BYDAY.split(',') : [days[new Date(parts[0], parts[1] - 1, parts[2]).getDay()]]).map(s => days.indexOf(s.slice(-2)));
    const startDow = (new Date(parts[0], parts[1] - 1, parts[2]).getDay() + 6) % 7;   // ma=0
    for (let w = 0; !full(); w += interval) {
      const weekStart = parts[2] - startDow + w * 7;
      if (mk(parts[0], parts[1], weekStart) > limit) break;
      byday.map(d => (d + 6) % 7).sort((a, b) => a - b).forEach(off => { if (!full()) push(mk(parts[0], parts[1], weekStart + off)); });
    }
  } else if (freq === 'MONTHLY') {
    for (let i = 0; !full() && i <= 240; i += interval) {
      const y = parts[0] + Math.floor((parts[1] - 1 + i) / 12), mo = ((parts[1] - 1 + i) % 12) + 1;
      let d;
      if (r.BYDAY) {
        const m = r.BYDAY.match(/^([+-]?\d)?([A-Z]{2})$/);
        const n = m && m[1] ? parseInt(m[1], 10) : parseInt(r.BYSETPOS || '1', 10);
        const dow = days.indexOf(m ? m[2] : 'MO');
        const firstOfMonth = new Date(y, mo - 1, 1), lastOfMonth = new Date(y, mo, 0);
        let day;
        if (n > 0) day = 1 + ((dow - firstOfMonth.getDay() + 7) % 7) + (n - 1) * 7;
        else day = lastOfMonth.getDate() - ((lastOfMonth.getDay() - dow + 7) % 7);
        if (day > lastOfMonth.getDate()) continue;
        d = mk(y, mo, day);
      } else {
        const dom = parseInt(r.BYMONTHDAY || parts[2], 10);
        if (dom > new Date(y, mo, 0).getDate()) continue;
        d = mk(y, mo, dom);
      }
      if (d > limit) break;
      push(d);
    }
  } else {
    push(start);   // YEARLY e.d.: alleen de eerste keer
  }
  return out;
}

// ---------- Hulpjes ----------
function first(arr) { return arr && arr.length ? arr[0] : null; }
function val(ev, k) { const p = first(ev.props[k]); return p ? p.value : null; }
function mailto(v) { return (v || '').replace(/^mailto:/i, '').trim().toLowerCase(); }
function extractEmail(s) { const m = (s || '').match(/<([^>]+)>/); return (m ? m[1] : (s || '')).trim().toLowerCase(); }
function extractName(s) { const m = (s || '').match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1] : ''; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function unescapeText(s) { return (s || '').replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1'); }
function fmt(d) { return Utilities.formatDate(d, CONFIG.DEFAULT_TZ, "EEE d MMM yyyy HH:mm"); }

/** Dagelijkse ping zodat het gratis Supabase-project niet automatisch pauzeert. */
function houdWakker() {
  callSupabase({ method: 'CANCEL', uid: 'keep-alive', room_alias: 'bestaat-niet' });
}

/** Handmatige test zonder mail: voer uit vanuit de editor. */
function testVerbinding() {
  Logger.log(JSON.stringify(callSupabase({ method: 'CANCEL', uid: 'test-verbinding', room_alias: 'bestaat-niet' })));
  // Verwacht: {"status":"unknown_room"} → de verbinding met Supabase werkt.
}
