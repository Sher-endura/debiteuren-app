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
    if (event === "SIGNED_IN" && document.getElementById("login-overlay").style.display !== "none") location.reload();
    if (event === "SIGNED_OUT") location.reload();
  });
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { document.getElementById("login-overlay").style.display = "flex"; return false; }

  gebruiker = session.user;
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

/* ------------------------------------------------------- aanroep versturen */

const STANDAARD_ENDPOINT = "https://secure.directlink.nu/api/v1/dataimport/upload";

/* Het endpointveld vergeeft slordigheden: leeg = standaard, alleen een domein
   krijgt het pad erbij, en https:// wordt aangevuld. Een kale domeinnaam gaf
   eerder HTTP 405 van de DirectLink-server (echt gebeurd, 23 aug 2026). */
function maakEndpoint(ingevoerd) {
  let e = (ingevoerd || "").trim();
  if (!e) return STANDAARD_ENDPOINT;
  if (!/^https?:\/\//i.test(e)) e = "https://" + e;
  const zonderSlash = e.replace(/\/+$/, "");
  // Alleen een domein (geen pad)? Dan het standaardpad erachter.
  if (/^https?:\/\/[^\/]+$/i.test(zonderSlash)) return zonderSlash + "/api/v1/dataimport/upload";
  return zonderSlash;
}

/* Twee routes:
   - "direct": rechtstreeks naar DirectLink met het token dat op het tabblad
     Instellingen is geplakt — zoals Template 1 uit het onboardingpakket.
   - "luik": via de Supabase-functie met het token in de kluis. Let op: de
     beschermlaag van Supabase houdt XML-berichten uit een browser tegen
     (vastgesteld 22 aug 2026 — lege HTTP 400 vóór de functiecode), dus deze
     route werkt pas weer als dat opgelost is. */
async function dlVerstuur(xml, watVoor) {
  const begin = performance.now();
  let resp, raw, bron;
  try {
    if (inst.verbinding !== "luik") {
      bron = "DirectLink";
      const token = (inst.dlToken || "").trim().replace(/^bearer\s+/i, "");
      if (!token) throw new Error("Plak eerst het DirectLink-token op het tabblad Instellingen (blok Verbinding).");
      resp = await fetch(maakEndpoint(inst.dlEndpoint), {
        method: "POST",
        headers: { "Authorization": "Bearer " + token, "Content-Type": "application/xml" },
        body: xml
      });
    } else {
      bron = "het doorgeefluik";
      if (!CLOUD) throw new Error("Geen verbinding ingesteld (config.js is leeg).");
      const { data: { session } } = await sb.auth.getSession();
      if (!session) throw new Error("Je bent niet meer ingelogd — ververs de pagina en log opnieuw in.");
      resp = await fetch(`${CFG.FUNCTIES_URL || CFG.SUPABASE_URL}/functions/v1/directlink`, {
        method: "POST",
        headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/xml" },
        body: xml
      });
    }
    raw = await resp.text();
  } catch (e) {
    logBij(watVoor, xml, "netwerkfout: " + e.message, false, performance.now() - begin);
    const cors = /failed to fetch|networkerror|load failed/i.test(e.message);
    throw new Error((bron || "De verbinding") + " was niet te bereiken: " + e.message +
      (cors && bron === "DirectLink"
        ? ` — dit is meestal CORS: vraag DirectLink om ${location.origin} te whitelisten (mail naar info@directlink.nu).`
        : ""));
  }
  logBij(watVoor, xml, raw, resp.ok, performance.now() - begin);
  if (!resp.ok) {
    const hint = resp.status === 405
      ? " — dit betekent meestal dat het DirectLink-endpoint op Instellingen niet klopt; maak dat veld leeg, dan gebruikt de app het juiste adres."
      : resp.status === 401
      ? " — het token wordt geweigerd; controleer of het volledig en zonder spaties geplakt is."
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

/* ------------------------------------------------------------- afletteren */

/* Match-bericht voor Twinfield. LET OP: dit onderdeel is nog niet één keer
   echt doorgevoerd. De opbouw volgt de Twinfield-documentatie voor MatchSet:
   één <set> met alle regels die samen op nul uitkomen, elk met boekstukcode,
   boekstuknummer, regelnummer en het bedrag dat afgeletterd wordt. Klopt het
   niet, dan hoeft alleen déze functie aangepast te worden. */
function bouwMatchXml(office, regels) {
  const lijnen = regels.map(r =>
    `    <line>\n` +
    `      <transcode>${xmlEsc(r.boekstukcode)}</transcode>\n` +
    `      <transnumber>${xmlEsc(r.boekstuknr)}</transnumber>\n` +
    `      <transline>${xmlEsc(r.regelnr || "1")}</transline>\n` +
    `      <matchvalue>${r.bedrag.toFixed(2)}</matchvalue>\n` +
    `    </line>`).join("\n");
  return `<match>\n  <set>\n    <office>${xmlEsc(office)}</office>\n` +
         `    <matchcode>DEB</matchcode>\n    <lines>\n${lijnen}\n    </lines>\n  </set>\n</match>`;
}

async function voerMatchUit(office, regels) {
  const xml = bouwMatchXml(office, regels);
  const doc = await dlLees(xml, "afletteren doorvoeren");
  const set = doc.getElementsByTagName("set")[0] || doc.documentElement;
  const resultaat = set ? set.getAttribute("result") : null;
  if (resultaat === "1") return { goed: true, xml };

  // Twinfield zet de reden op het element dat mis is; we rapen alles op wat er staat.
  const meldingen = [];
  for (const el of doc.getElementsByTagName("*")) {
    const msg = el.getAttribute("msg");
    if (msg) meldingen.push(`${el.nodeName}: ${msg}`);
  }
  return { goed: false, xml, fout: meldingen.join(" · ") || "Twinfield gaf geen bevestiging terug." };
}
