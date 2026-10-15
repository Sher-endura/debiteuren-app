"use strict";
/* ============================================================================
   api.js — alles wat met inloggen en met Twinfield praten te maken heeft.

   De route: browser → doorgeefluik bij Supabase → DirectLink → Twinfield.
   Het DirectLink-token staat als geheim bij Supabase en komt nooit in de
   browser. Het doorgeefluik laat alleen ingelogde @endura-aruba.com-accounts
   erdoor; dat is dezelfde functie die de Bankboeker gebruikt.

   Drie lessen uit de proeven van augustus 2026 (staan ook in de IT-bijlage van
   het DirectLink-pakket) — hier hard ingebouwd:
   1. De administratie MOET als filterkolom mee met operator "equal". Een los
      <office>-label wordt stil genegeerd: je krijgt dan altijd de administratie
      die aan de DirectLink-definitie hangt.
   2. Géén filter op fin.trs.head.yearperiod: die vraag blijft hangen en geeft na
      twee minuten een lege 500. Wij halen alles op en selecteren in de app.
   3. Een filter moet de operator gebruiken die in de rapportdefinitie staat.
      Daarom vragen we die definitie eerst op en bouwen de vraag daarmee.
   ========================================================================== */

const CFG = window.DEBITEUREN_CONFIG || {};
const CLOUD = !!(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && window.supabase);
const BROWSE_CODE = "130_3";           // Debiteuren v3 — openstaande posten
const DEF_OPSLAG = "debiteuren.velddefinitie.v1";

let sb = null;
let gebruiker = null;
let velddefinitie = null;              // { velden: Set, operators: Map }

/* ---------------------------------------------------------------- inloggen */

async function initAuth() {
  if (!CLOUD) {
    toonMelding("melding-login", "fout",
      "config.js is niet ingevuld — zonder Supabase-gegevens kan de app niet bij Twinfield.");
    document.getElementById("login-overlay").style.display = "flex";
    return false;
  }
  sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY);
  sb.auth.onAuthStateChange((event) => {
    if (window.reserveInlogBezig) return;   // reserve-inlog: eerst de tweestapscode, dan pas herladen
    if (event === "SIGNED_IN" && document.getElementById("login-overlay").style.display !== "none") location.reload();
    if (event === "SIGNED_OUT") location.reload();
  });
  const doorgeefFout = await doorgeefbriefjeInwisselen();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    document.getElementById("login-overlay").style.display = "flex";
    if (doorgeefFout === "BEZIG") toonMelding("melding-login", "ok", "Bezig met inloggen via E-Board…");
    else if (doorgeefFout) toonMelding("melding-login", "fout", escapeHtml(doorgeefFout));
    return false;
  }

  gebruiker = session.user;
  if (!sessieViaEboard(session)) {
    document.getElementById("login-overlay").style.display = "flex";
    toonMelding("melding-login", "fout", "Open P.up via E-Board (menu links). Rechtstreeks inloggen met alleen een wachtwoord kan niet meer.");
    return false;
  }
  const mail = (gebruiker.email || "").toLowerCase();
  const domein = (CFG.TOEGESTAAN_DOMEIN || "").toLowerCase();
  const lijst = (CFG.TOEGESTANE_ACCOUNTS || []).map(a => a.toLowerCase());
  const toegestaan = lijst.length ? lijst.includes(mail) : (domein && mail.endsWith("@" + domein));
  if (!toegestaan) {
    document.getElementById("login-overlay").style.display = "flex";
    toonMelding("melding-login", "fout",
      `Dit programma is alleen toegankelijk voor de daarvoor aangewezen accounts. Je bent ingelogd als ${escapeHtml(gebruiker.email || "?")}.`);
    await sb.auth.signOut();
    return false;
  }
  return true;
}

/* Veiligheid 15 okt 2026 (optie 2): mensen alleen via E-Board. Zelfde regel als op de server:
   sessie via E-Board (inlogmanier 'otp'), met tweestaps (aal2). Anders tonen we
   het scherm "open via E-Board" (de server geeft zo'n sessie toch niets). */
function sessieViaEboard(session) {
  try {
    const p = JSON.parse(atob(session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    const amr = Array.isArray(p.amr) ? p.amr : [];
    if (amr.some(a => a && (a.method === "otp" || a.method === "magiclink"))) return true;
    if (p.aal === "aal2") return true;
    return false;
  } catch (e) { return false; }
}

/* Geopend vanuit E-Board (E-Board update 145): het adres eindigt op #doorgeven=<code>.
   Die eenmalige code (60 s) ruilen we bij edge function `doorgeven` in het E-Board-project
   in voor een inlog. Die functie laat ALLEEN Shereen en Antoine door; hierboven controleert
   de app dat daarna nog eens (TOEGESTANE_ACCOUNTS). De code gaat meteen uit de adresbalk. */
async function doorgeefbriefjeInwisselen() {
  const m = location.hash.match(/doorgeven=([^&]+)/);
  if (!m) return null;
  history.replaceState(null, "", location.pathname + location.search);
  const code = decodeURIComponent(m[1]);
  // E-Board meldt de code aan op het moment van klikken; dat kan een paar tellen duren.
  // 410 = (nog) onbekend → opnieuw proberen. Klaar = ingelogd of een echte weigering.
  const poging = async () => {
    try {
      const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/doorgeven`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actie: "inwisselen", code }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.status === 410) return { klaar: false };
      if (!r.ok || !j.token_hash) return { klaar: true, fout: j.fout || `Inloggen via E-Board lukte niet (HTTP ${r.status}).` };
      const { error } = await sb.auth.verifyOtp({ token_hash: j.token_hash, type: "magiclink" });
      return { klaar: true, fout: error ? "Inloggen via E-Board lukte niet: " + error.message : null };
    } catch (e) { return { klaar: false }; }
  };
  const eerste = await poging();
  if (eerste.klaar) return eerste.fout;
  // Nog niet binnen: inlogscherm tonen met "bezig", en op de achtergrond doorproberen (±12 s).
  // Lukt het, dan herlaadt de pagina vanzelf (SIGNED_IN terwijl het inlogscherm open staat).
  (async () => {
    for (let i = 0; i < 70; i++) {   // ±55 s (was ±12 s, 15 okt 2026): de code is 60 s geldig
      await new Promise(ok => setTimeout(ok, 750));
      const p = await poging();
      if (p.klaar) { if (p.fout) toonMelding("melding-login", "fout", escapeHtml(p.fout)); return; }
    }
    toonMelding("melding-login", "fout", "Automatisch inloggen via E-Board lukte niet. Ga terug naar E-Board en klik nog een keer op P.up (staat tweestapsverificatie aan in E-Board?).");
  })();
  return "BEZIG";
}

/* ------------------------------------------------------- aanroep versturen */

/* Eén vaste route (12 okt 2026, Shereen: "er moet een connectie zijn en die moet
   blijven"): browser → functie twinfield-proxy bij Supabase → DirectLink → Twinfield.
   Het DirectLink-token staat ALLEEN in de kluis van Supabase (DIRECTLINK_TOKEN);
   er gaat nooit een token uit de browser mee. Zo werkt het overal hetzelfde —
   online, op localhost, bij Shereen en bij Antoine — en kan een oud token dat
   nog in een browser staat de verbinding niet meer verstoren.
   (De vroegere "rechtstreekse" route met een geplakt token is weg.) */
async function dlVerstuur(xml, watVoor) {
  const begin = performance.now();
  const bron = "Het doorgeefluik";
  let resp, raw;
  try {
    if (!CLOUD) throw new Error("Geen verbinding ingesteld (config.js is leeg).");
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Je bent niet meer ingelogd — ververs de pagina en log opnieuw in.");
    // De XML gaat als base64 mee, zodat de inhoud onderweg nergens als opmaak
    // kan worden aangezien.
    resp = await fetch(`${CFG.FUNCTIES_URL || CFG.SUPABASE_URL}/functions/v1/twinfield-proxy`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ xml_b64: naarBase64(xml) })
    });
    raw = await resp.text();
  } catch (e) {
    logBij(watVoor, xml, "netwerkfout: " + e.message, false, performance.now() - begin);
    throw new Error(bron + " was niet te bereiken: " + e.message);
  }
  logBij(watVoor, xml, raw, resp.ok, performance.now() - begin);
  if (!resp.ok) {
    const hint = resp.status === 401
      ? " — de inlog is verlopen of de sleutel in de kluis wordt geweigerd. Ververs de pagina; helpt dat niet, dan moet het DirectLink-token in de kluis (Supabase → Edge Functions → Secrets → DIRECTLINK_TOKEN) vernieuwd worden."
      : "";
    throw new Error(`${bron} gaf HTTP ${resp.status}: ${raw.slice(0, 300)}${hint}`);
  }
  return raw;
}

/* DirectLink verpakt de Twinfield-XML standaard in JSON; hier weer uitpakken. */
async function dlLees(xml, watVoor) {
  const raw = await dlVerstuur(xml, watVoor);
  let xmlTekst = raw;
  try { const j = JSON.parse(raw); xmlTekst = j.response || j.result || j.data || j.xml || j.body || raw; } catch (e) { /* was al XML */ }
  const doc = new DOMParser().parseFromString(xmlTekst, "application/xml");
  if (doc.getElementsByTagName("parsererror").length)
    throw new Error("Het antwoord was geen geldige XML: " + xmlTekst.slice(0, 200));
  return doc;
}

/* Tekst naar base64, ook als er accenten of andere niet-ASCII in staan
   (btoa alleen zou daarop stukbreken). */
function naarBase64(tekst) {
  const bytes = new TextEncoder().encode(tekst);
  let ruw = "";
  for (const b of bytes) ruw += String.fromCharCode(b);
  return btoa(ruw);
}

function xmlEsc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/* --------------------------------------------------- velden van 130_3 lezen */

/* De rapportdefinitie vertelt welke velden bestaan en met welke operator ze
   gefilterd mogen worden. We vragen die één keer op en bewaren hem, zodat we
   nooit een veld versturen dat Twinfield niet kent (dat laat de hele vraag
   mislukken in plaats van alleen die kolom). */
async function haalVelddefinitie(opnieuw) {
  if (velddefinitie && !opnieuw) return velddefinitie;
  if (!opnieuw) {
    try {
      const bewaard = JSON.parse(localStorage.getItem(DEF_OPSLAG));
      if (bewaard && bewaard.velden && bewaard.velden.length) {
        velddefinitie = { velden: new Set(bewaard.velden), operators: new Map(bewaard.operators || []) };
        return velddefinitie;
      }
    } catch (e) { /* niets bewaard */ }
  }

  const doc = await dlLees(`<read><type>browse</type><code>${BROWSE_CODE}</code></read>`,
                           "velden van 130_3 opvragen");
  const velden = new Set(), operators = new Map();
  for (const kol of doc.getElementsByTagName("column")) {
    const veld = tekstVan(kol, "field");
    if (!veld) continue;
    velden.add(veld);
    const op = tekstVan(kol, "operator");
    if (op) operators.set(veld, op);
  }
  if (!velden.size) throw new Error("Twinfield gaf geen kolommen terug voor rapport " + BROWSE_CODE + ".");

  velddefinitie = { velden, operators };
  localStorage.setItem(DEF_OPSLAG, JSON.stringify({
    velden: [...velden], operators: [...operators]
  }));
  return velddefinitie;
}

function tekstVan(el, naam) {
  const k = el.getElementsByTagName(naam)[0];
  return k ? (k.textContent || "").trim() : "";
}

/* Welk veld hoort bij welke kolom in onze app. De eerste naam die Twinfield
   werkelijk kent wordt gebruikt; kent hij geen van de namen, dan blijft de
   kolom leeg in plaats van dat de hele vraag mislukt. */
const VELDKEUZE = {
  office:       ["fin.trs.head.office"],
  klant:        ["fin.trs.line.dim2"],
  klantnaam:    ["fin.trs.line.dim2name", "fin.trs.line.dim2.name"],
  factuur:      ["fin.trs.head.invoicenumber", "fin.trs.line.invoicenumber"],
  boekstukcode: ["fin.trs.head.code"],
  boekstuknr:   ["fin.trs.head.number"],
  regelnr:      ["fin.trs.line.number", "fin.trs.line.line"],
  datum:        ["fin.trs.head.date"],
  vervaldatum:  ["fin.trs.line.duedate", "fin.trs.head.duedate"],
  valuta:       ["fin.trs.head.curcode", "fin.trs.line.curcode", "fin.trs.head.currency"],
  open:         ["fin.trs.line.openvaluesigned", "fin.trs.line.openbasevaluesigned"],
  bedrag:       ["fin.trs.line.valuesigned"],
  matchstatus:  ["fin.trs.line.matchstatus"],
  status:       ["fin.trs.head.status"],
  omschrijving: ["fin.trs.line.description"]
};

function kiesVeld(soort, def) {
  const kandidaten = VELDKEUZE[soort] || [];
  if (!def) return kandidaten[0] || null;
  return kandidaten.find(v => def.velden.has(v)) || null;
}

/* ------------------------------------------------- openstaande posten halen */

async function haalOpenPosten(office) {
  const def = await haalVelddefinitie(false);

  const gekozen = {};                 // soort -> veldnaam
  for (const soort of Object.keys(VELDKEUZE)) {
    const v = kiesVeld(soort, def);
    if (v) gekozen[soort] = v;
  }
  if (!gekozen.office) throw new Error("Rapport 130_3 kent het administratieveld niet — zonder dat filter mag de vraag niet.");
  if (!gekozen.open && !gekozen.bedrag) throw new Error("Rapport 130_3 geeft geen bedragkolom terug; kijk op het tabblad Instellingen bij 'velden ontdekken' welke er wél zijn.");

  const kol = f => `<column><field>${f}</field><label>${f}</label><visible>true</visible></column>`;
  const filter = (f, op, van) =>
    `<column><field>${f}</field><label>${f}</label><visible>true</visible>` +
    `<ask>true</ask><operator>${op}</operator><from>${xmlEsc(van)}</from><to></to></column>`;

  const officeOperator = def.operators.get(gekozen.office) || "equal";
  const overige = Object.entries(gekozen)
    .filter(([soort]) => soort !== "office")
    .map(([, veld]) => veld);

  const xml = `<columns code="${BROWSE_CODE}">` +
    filter(gekozen.office, officeOperator, office) +
    [...new Set(overige)].map(kol).join("") +
    `</columns>`;

  const doc = await dlLees(xml, `openstaande posten van ${office}`);
  const b = doc.getElementsByTagName("browse")[0];
  if (b && b.getAttribute("msgtype") === "error") throw new Error("Twinfield: " + b.getAttribute("msg"));

  return { rijen: parseBrowse(doc), velden: gekozen };
}

function parseBrowse(doc) {
  const uit = [];
  for (const tr of doc.getElementsByTagName("tr")) {
    const rij = {};
    for (const td of tr.getElementsByTagName("td")) rij[td.getAttribute("field") || ""] = td.textContent;
    if (Object.keys(rij).length) uit.push(rij);
  }
  return uit;
}

/* Administraties ophalen — de eenvoudigste toets of de verbinding staat. */
async function haalAdministraties() {
  const doc = await dlLees("<list><type>offices</type></list>", "administraties ophalen");
  return [...doc.getElementsByTagName("office")].map(o => ({
    code: (o.textContent || "").trim(),
    naam: o.getAttribute("name") || "",
    korte: o.getAttribute("shortname") || ""
  })).filter(o => o.code);
}

/* E-mailadres van een debiteur uit Twinfield. De opbouw van het antwoord
   verschilt per inrichting, daarom zoeken we breed: elk veld dat op een
   e-mailadres lijkt. Het eerste treffer wint. */
async function haalDebiteurEmail(office, code) {
  const doc = await dlLees(
    `<read><type>dimensions</type><office>${xmlEsc(office)}</office>` +
    `<dimtype>DEB</dimtype><code>${xmlEsc(code)}</code></read>`,
    `e-mailadres van debiteur ${code}`);
  const alles = doc.documentElement ? doc.documentElement.textContent || "" : "";
  const treffer = alles.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return treffer ? treffer[0] : "";
}
