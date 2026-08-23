"use strict";
/* ============================================================================
   app.js — wat je op het scherm ziet: overzicht, debiteurenlijst, aanmaningen,
   afletteren, instellingen en logboek.

   Opgehaalde posten en instellingen staan alleen in deze browser
   (localStorage). Er gaat niets naar een database.
   ========================================================================== */

const OPSLAG_INST   = "debiteuren.instellingen.v1";
const OPSLAG_POSTEN = "debiteuren.posten.v1";
const OPSLAG_EMAILS = "debiteuren.emails.v1";

let inst = { office: "ENDURA", dagen: 30, afzender: "Endura Accounting & Advisory", antwoord: "",
             verbinding: "direct", dlEndpoint: "", dlToken: "" };
let posten = [];            // genormaliseerde openstaande posten
let opgehaaldOp = null;     // wanneer voor het laatst opgehaald
let emails = {};            // debiteurnummer -> e-mailadres
let logregels = [];
let openGroepen = new Set();
let matchKeuze = { ontvangst: null, facturen: new Set() };

/* ================================ hulpjes ================================ */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toonMelding(id, soort, html) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<div class="melding ${soort}">${html}</div>`;
}
function wisMelding(id) { const el = document.getElementById(id); if (el) el.innerHTML = ""; }

/* Bedragen komen uit Twinfield als "1234.56", soms met komma of duizendtekens. */
function parseBedrag(s) {
  let t = String(s == null ? "" : s).replace(/\s| /g, "").replace(/[^0-9.,-]/g, "");
  if (!t) return 0;
  const laatsteKomma = t.lastIndexOf(","), laatstePunt = t.lastIndexOf(".");
  if (laatsteKomma > -1 && laatstePunt > -1) {
    if (laatsteKomma > laatstePunt) t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
  } else if (laatsteKomma > -1) {
    t = t.replace(/\./g, "").replace(",", ".");
  }
  const n = parseFloat(t);
  return isNaN(n) ? 0 : n;
}

function geld(n, valuta) {
  const tekst = (n < 0 ? "-" : "") + Math.abs(n).toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return valuta ? `${valuta} ${tekst}` : tekst;
}

/* Twinfield levert datums als 20260731; ook los ingevoerde vormen aanvaarden. */
function parseDatum(s) {
  const t = String(s == null ? "" : s).trim();
  let m = t.match(/^(\d{4})-?(\d{2})-?(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = t.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  return null;
}
function datumTekst(d) {
  if (!d) return "";
  const p = n => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}`;
}
function datumIso(d) {
  if (!d) return "";
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function vandaag() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function dagenTussen(a, b) { return Math.round((b - a) / 86400000); }

/* ================================ logboek ================================ */

/* api.js roept dit aan bij elke aanroep. */
function logBij(watVoor, xml, antwoord, gelukt, ms) {
  logregels.unshift({
    tijd: new Date().toLocaleTimeString("nl-NL"),
    watVoor: watVoor || "aanroep",
    xml, antwoord, gelukt,
    duur: Math.round(ms || 0)
  });
  if (logregels.length > 60) logregels.length = 60;
  if (document.getElementById("tab-logboek").classList.contains("actief")) toonLogboek();
}

function toonLogboek() {
  const doel = document.getElementById("logboek");
  if (!logregels.length) { doel.innerHTML = `<p class="zacht klein">Nog geen aanroepen.</p>`; return; }
  doel.innerHTML = logregels.map(r => `
    <details class="logregel">
      <summary>
        <span class="tijd">${escapeHtml(r.tijd)}</span>
        <span class="status ${r.gelukt ? "ok" : "fout"}">${r.gelukt ? "goed" : "mislukt"}</span>
        <span>${escapeHtml(r.watVoor)}</span>
        <span class="zacht">· ${r.duur} ms</span>
      </summary>
      <pre class="code">VERSTUURD:\n${escapeHtml(r.xml)}\n\nANTWOORD:\n${escapeHtml(String(r.antwoord).slice(0, 20000))}</pre>
    </details>`).join("");
}

/* ============================= posten opbouwen ============================ */

function normaliseer(rijen, velden) {
  const nu = vandaag();
  const uit = [];
  for (const r of rijen) {
    const waarde = soort => velden[soort] ? r[velden[soort]] : "";
    const open = parseBedrag(waarde("open") || waarde("bedrag"));
    if (Math.abs(open) < 0.005) continue;               // afgeletterd of nul: niet openstaand

    const datum = parseDatum(waarde("datum"));
    let vervalt = parseDatum(waarde("vervaldatum"));
    if (!vervalt && datum && inst.dagen) {
      vervalt = new Date(datum.getTime());
      vervalt.setDate(vervalt.getDate() + Number(inst.dagen));
    }
    uit.push({
      klant: (waarde("klant") || "").trim(),
      klantnaam: (waarde("klantnaam") || "").trim(),
      factuur: (waarde("factuur") || "").trim(),
      boekstukcode: (waarde("boekstukcode") || "").trim(),
      boekstuknr: (waarde("boekstuknr") || "").trim(),
      regelnr: (waarde("regelnr") || "").trim(),
      datum, vervalt,
      valuta: (waarde("valuta") || "").trim(),
      open,
      matchstatus: (waarde("matchstatus") || "").trim(),
      status: (waarde("status") || "").trim(),
      omschrijving: (waarde("omschrijving") || "").trim(),
      dagen: vervalt ? dagenTussen(vervalt, nu) : null
    });
  }
  return uit;
}

function groepeer(lijst) {
  const map = new Map();
  for (const p of lijst) {
    const sleutel = p.klant || "(zonder debiteurnummer)";
    if (!map.has(sleutel)) map.set(sleutel, { klant: sleutel, naam: p.klantnaam || "", posten: [], open: 0, vervallen: 0, oudste: null, valutas: new Set() });
    const g = map.get(sleutel);
    if (!g.naam && p.klantnaam) g.naam = p.klantnaam;
    g.posten.push(p);
    g.open += p.open;
    if (p.dagen != null && p.dagen > 0 && p.open > 0) g.vervallen += p.open;
    if (p.dagen != null && (g.oudste == null || p.dagen > g.oudste)) g.oudste = p.dagen;
    if (p.valuta) g.valutas.add(p.valuta);
  }
  return [...map.values()];
}

const TERMIJNEN = [
  { naam: "Niet vervallen",    laat: false, test: d => d != null && d <= 0 },
  { naam: "1 – 30 dagen",      laat: true,  test: d => d != null && d >= 1 && d <= 30 },
  { naam: "31 – 60 dagen",     laat: true,  test: d => d != null && d >= 31 && d <= 60 },
  { naam: "61 – 90 dagen",     laat: true,  test: d => d != null && d >= 61 && d <= 90 },
  { naam: "Meer dan 90 dagen", laat: true,  test: d => d != null && d > 90 },
  { naam: "Geen vervaldatum",  laat: false, test: d => d == null }
];

function valutaOverzicht(lijst) {
  const per = new Map();
  for (const p of lijst) {
    const v = p.valuta || "";
    per.set(v, (per.get(v) || 0) + p.open);
  }
  return per;
}

/* ============================== overzicht ================================ */

function vernieuwAlles() {
  vernieuwStand();
  vernieuwOverzicht();
  vernieuwDebiteuren();
  vernieuwAanmaningKeuze();
  vernieuwAfletteren();
}

function vernieuwStand() {
  const el = document.getElementById("stand");
  if (!posten.length) { el.textContent = opgehaaldOp ? "Geen openstaande posten gevonden" : "Nog niets opgehaald"; return; }
  el.innerHTML = `${posten.length} posten · opgehaald ${escapeHtml(opgehaaldOp || "")}`;
  const vervallenKlanten = groepeer(posten).filter(g => g.vervallen > 0).length;
  const knop = document.querySelector('.nav-knop[data-tab="aanmaningen"]');
  knop.querySelector(".telbol")?.remove();
  if (vervallenKlanten) {
    const bol = document.createElement("span");
    bol.className = "telbol"; bol.textContent = vervallenKlanten;
    knop.appendChild(bol);
  }
}

function vernieuwOverzicht() {
  const perValuta = valutaOverzicht(posten);
  const valutas = [...perValuta.keys()].filter(v => v);
  const hoofdvaluta = valutas.length === 1 ? valutas[0] : "";
  const totaal = posten.reduce((s, p) => s + p.open, 0);
  const vervallenLijst = posten.filter(p => p.dagen != null && p.dagen > 0 && p.open > 0);
  const vervallen = vervallenLijst.reduce((s, p) => s + p.open, 0);
  const vervallenPerValuta = valutaOverzicht(vervallenLijst);
  const groepen = groepeer(posten);

  const zet = (id, cijfer, voet) => {
    document.getElementById(id).textContent = cijfer;
    document.getElementById(id + "-voet").innerHTML = voet || "&nbsp;";
  };
  zet("t-totaal", posten.length ? geld(totaal, hoofdvaluta) : "—",
      valutas.length > 1
        ? "meerdere valuta: " + valutas.map(v => geld(perValuta.get(v), v)).join(" · ")
        : (opgehaaldOp ? "stand van " + escapeHtml(opgehaaldOp) : ""));
  // Bij meerdere valuta geen samengeteld cijfer en geen percentage — dat zou appels en peren zijn.
  zet("t-vervallen",
      !posten.length ? "—"
        : valutas.length > 1 ? `${vervallenLijst.length} posten`
        : geld(vervallen, hoofdvaluta),
      valutas.length > 1
        ? "vervallen: " + [...vervallenPerValuta.keys()].map(v => geld(vervallenPerValuta.get(v), v)).join(" · ")
        : (totaal > 0 ? Math.round(vervallen / totaal * 100) + "% van het openstaande bedrag" : ""));
  zet("t-posten", posten.length ? String(posten.length) : "—",
      posten.filter(p => p.open < 0).length ? posten.filter(p => p.open < 0).length + " daarvan zijn ontvangsten" : "");
  zet("t-debiteuren", posten.length ? String(groepen.length) : "—",
      groepen.filter(g => g.vervallen > 0).length + " met een vervallen post");

  // ouderdom
  const rijen = TERMIJNEN.map(t => {
    const lijst = posten.filter(p => t.test(p.dagen));
    return { naam: t.naam, laat: t.laat, aantal: lijst.length, bedrag: lijst.reduce((s, p) => s + p.open, 0) };
  });
  const grootste = Math.max(1, ...rijen.map(r => Math.abs(r.bedrag)));
  const somAbs = rijen.reduce((s, r) => s + Math.abs(r.bedrag), 0) || 1;

  document.getElementById("ouderdom-staven").innerHTML = rijen.map(r => `
    <div class="staaf-rij ${r.laat ? "laat" : ""}">
      <div>${escapeHtml(r.naam)}</div>
      <div class="staaf-baan"><div class="staaf-vul" style="width:${Math.abs(r.bedrag) / grootste * 100}%"></div></div>
      <div class="num">${geld(r.bedrag, hoofdvaluta)}</div>
    </div>`).join("");

  document.querySelector("#tabel-ouderdom tbody").innerHTML = rijen.map(r => `
    <tr>
      <td>${escapeHtml(r.naam)}</td>
      <td class="num">${r.aantal}</td>
      <td class="num">${geld(r.bedrag, hoofdvaluta)}</td>
      <td class="num">${Math.round(Math.abs(r.bedrag) / somAbs * 100)}%</td>
    </tr>`).join("") || `<tr><td colspan="4" class="zacht">Nog niets opgehaald.</td></tr>`;

  const top = groepen.slice().sort((a, b) => b.open - a.open).slice(0, 15);
  document.querySelector("#tabel-top tbody").innerHTML = top.map(g => `
    <tr>
      <td class="naam"><b>${escapeHtml(g.naam || g.klant)}</b> <span class="zacht klein">${escapeHtml(g.klant)}</span></td>
      <td class="num">${g.posten.length}</td>
      <td class="num">${geld(g.open, [...g.valutas][0] || hoofdvaluta)}</td>
      <td class="num ${g.vervallen ? "dagen-laat" : "dagen-ok"}">${g.vervallen ? geld(g.vervallen, "") : "—"}</td>
      <td class="num ${g.oudste > 0 ? "dagen-laat" : "dagen-ok"}">${g.oudste == null ? "—" : g.oudste}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="zacht">Nog niets opgehaald.</td></tr>`;
}

/* ============================ debiteurenlijst ============================= */

function gefilterdeGroepen() {
  const zoek = document.getElementById("zoek").value.trim().toLowerCase();
  const alleenVervallen = document.getElementById("alleen-vervallen").checked;
  const sortering = document.getElementById("sorteer").value;

  let lijst = posten;
  if (alleenVervallen) lijst = lijst.filter(p => p.dagen != null && p.dagen > 0 && p.open > 0);
  let groepen = groepeer(lijst);
  if (zoek) {
    groepen = groepen.filter(g =>
      (g.naam + " " + g.klant).toLowerCase().includes(zoek) ||
      g.posten.some(p => (p.factuur + " " + p.boekstukcode + " " + p.boekstuknr + " " + p.omschrijving).toLowerCase().includes(zoek)));
  }
  const sorteer = {
    dagen:  (a, b) => (b.oudste == null ? -1 : b.oudste) - (a.oudste == null ? -1 : a.oudste),
    bedrag: (a, b) => b.open - a.open,
    naam:   (a, b) => (a.naam || a.klant).localeCompare(b.naam || b.klant, "nl"),
    nummer: (a, b) => a.klant.localeCompare(b.klant, "nl", { numeric: true })
  }[sortering];
  return groepen.sort(sorteer);
}

function vernieuwDebiteuren() {
  const doel = document.getElementById("lijst-debiteuren");
  if (!posten.length) {
    doel.innerHTML = `<p class="zacht">Nog niets opgehaald. Klik rechtsboven op <b>Ophalen uit Twinfield</b>.</p>`;
    return;
  }
  const groepen = gefilterdeGroepen();
  if (!groepen.length) { doel.innerHTML = `<p class="zacht">Geen debiteuren die aan de filters voldoen.</p>`; return; }

  doel.innerHTML = groepen.map(g => {
    const valuta = [...g.valutas][0] || "";
    const open = g.posten.slice().sort((a, b) => (b.dagen ?? -9999) - (a.dagen ?? -9999));
    return `
    <div class="groep ${openGroepen.has(g.klant) ? "open" : ""}" data-klant="${escapeHtml(g.klant)}">
      <div class="groep-kop">
        <span class="pijl">${openGroepen.has(g.klant) ? "▼" : "▶"}</span>
        <span class="groep-naam">${escapeHtml(g.naam || g.klant)}<small>${escapeHtml(g.klant)} · ${g.posten.length} ${g.posten.length === 1 ? "post" : "posten"}</small></span>
        <span class="groep-merk ${g.oudste > 0 ? "laat" : ""}">${g.oudste == null ? "geen vervaldatum" : g.oudste > 0 ? g.oudste + " dagen te laat" : "binnen termijn"}</span>
        <span class="groep-bedrag">${geld(g.open, valuta)}</span>
      </div>
      <div class="groep-inhoud">
        <div class="tabel-omhulsel">
          <table>
            <thead><tr><th>Factuur</th><th>Boekstuk</th><th>Datum</th><th>Vervalt</th><th class="num">Dagen</th><th class="num">Openstaand</th><th>Omschrijving</th></tr></thead>
            <tbody>${open.map(p => `
              <tr>
                <td>${escapeHtml(p.factuur || "—")}</td>
                <td>${escapeHtml((p.boekstukcode + " " + p.boekstuknr).trim())}</td>
                <td>${datumTekst(p.datum)}</td>
                <td>${datumTekst(p.vervalt)}</td>
                <td class="num ${p.dagen > 0 ? "dagen-laat" : "dagen-ok"}">${p.dagen == null ? "—" : p.dagen > 0 ? p.dagen : "—"}</td>
                <td class="num">${geld(p.open, "")}</td>
                <td class="naam">${escapeHtml(p.omschrijving)}</td>
              </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>
    </div>`;
  }).join("");

  doel.querySelectorAll(".groep-kop").forEach(kop => kop.addEventListener("click", () => {
    const groep = kop.parentElement, klant = groep.dataset.klant;
    if (openGroepen.has(klant)) openGroepen.delete(klant); else openGroepen.add(klant);
    groep.classList.toggle("open");
    kop.querySelector(".pijl").textContent = groep.classList.contains("open") ? "▼" : "▶";
  }));
}

/* ================================ Excel ================================== */

function downloadBlob(blob, naam) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = naam;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function excelPerPost() {
  const rijen = [["Administratie", "Debiteurnr", "Debiteur", "Factuurnummer", "Boekstuk", "Datum", "Vervaldatum", "Valuta", "Openstaand", "Dagen te laat", "Omschrijving"]];
  for (const p of posten.slice().sort((a, b) => (b.dagen ?? -9999) - (a.dagen ?? -9999))) {
    rijen.push([inst.office, p.klant, p.klantnaam, p.factuur, (p.boekstukcode + " " + p.boekstuknr).trim(),
                datumIso(p.datum), datumIso(p.vervalt), p.valuta, p.open.toFixed(2),
                p.dagen != null && p.dagen > 0 ? p.dagen : "", p.omschrijving]);
  }
  downloadBlob(maakXlsx(rijen), `debiteuren-${inst.office}-per-post-${datumIso(new Date())}.xlsx`);
}

function excelPerDebiteur() {
  const rijen = [["Debiteurnr", "Debiteur", "Posten", "Openstaand", "Waarvan vervallen", "Oudste post (dagen)", "Valuta"]];
  for (const g of groepeer(posten).sort((a, b) => b.open - a.open)) {
    rijen.push([g.klant, g.naam, g.posten.length, g.open.toFixed(2), g.vervallen.toFixed(2),
                g.oudste == null ? "" : g.oudste, [...g.valutas].join("/")]);
  }
  downloadBlob(maakXlsx(rijen), `debiteuren-${inst.office}-per-debiteur-${datumIso(new Date())}.xlsx`);
}

/* xlsx schrijven: minimale maar volwaardige OOXML-structuur, zip zonder compressie. */
function maakXlsx(rijen) {
  const enc = new TextEncoder();
  const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const kolLetter = n => { let s = ""; n++; while (n) { s = String.fromCharCode(65 + (n - 1) % 26) + s; n = Math.floor((n - 1) / 26); } return s; };
  let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  rijen.forEach((r, ri) => {
    sheet += `<row r="${ri + 1}">`;
    r.forEach((v, ci) => {
      if (v === "" || v == null) return;
      const ref = kolLetter(ci) + (ri + 1);
      if (ri > 0 && /^-?\d+(\.\d+)?$/.test(String(v).trim()))
        sheet += `<c r="${ref}"><v>${String(v).trim()}</v></c>`;
      else
        sheet += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
    });
    sheet += "</row>";
  });
  sheet += "</sheetData></worksheet>";
  const bestanden = [
    ["[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'],
    ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Debiteuren" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'],
    ["xl/worksheets/sheet1.xml", sheet]
  ].map(([naam, inhoud]) => [naam, enc.encode(inhoud)]);
  return zipStored(bestanden);
}
function zipStored(bestanden) {
  const enc = new TextEncoder();
  const delen = [], cd = [];
  let offset = 0;
  for (const [naam, data] of bestanden) {
    const naamB = enc.encode(naam);
    const crc = crc32(data);
    const lokaal = new Uint8Array(30 + naamB.length);
    const dv = new DataView(lokaal.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, naamB.length, true);
    lokaal.set(naamB, 30);
    delen.push(lokaal, data);
    const centraal = new Uint8Array(46 + naamB.length);
    const cdv = new DataView(centraal.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint32(16, crc, true); cdv.setUint32(20, data.length, true); cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, naamB.length, true); cdv.setUint32(42, offset, true);
    centraal.set(naamB, 46);
    cd.push(centraal);
    offset += lokaal.length + data.length;
  }
  let cdLen = 0; for (const c of cd) cdLen += c.length;
  const einde = new Uint8Array(22);
  const edv = new DataView(einde.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, bestanden.length, true); edv.setUint16(10, bestanden.length, true);
  edv.setUint32(12, cdLen, true); edv.setUint32(16, offset, true);
  return new Blob([...delen, ...cd, einde], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
let CRC_TABEL = null;
function crc32(data) {
  if (!CRC_TABEL) {
    CRC_TABEL = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_TABEL[i] = c; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = CRC_TABEL[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ============================== aanmaningen ============================== */

function aanmaningGroepen() {
  const alleenVervallen = document.getElementById("aanm-alleen-vervallen").checked;
  let lijst = posten.filter(p => p.open > 0);
  if (alleenVervallen) lijst = lijst.filter(p => p.dagen != null && p.dagen > 0);
  return groepeer(lijst).sort((a, b) => b.open - a.open);
}

function vernieuwAanmaningKeuze() {
  const doel = document.getElementById("aanmaning-keuze");
  const groepen = aanmaningGroepen();
  if (!groepen.length) {
    doel.innerHTML = `<p class="zacht">${posten.length ? "Geen debiteuren met openstaande posten die aan de keuze voldoen." : "Nog niets opgehaald."}</p>`;
    return;
  }
  doel.innerHTML = groepen.map(g => `
    <label class="keuzeregel">
      <input type="checkbox" class="aanm-vink" value="${escapeHtml(g.klant)}" checked>
      <span>${escapeHtml(g.naam || g.klant)}<br><span class="zacht klein">${escapeHtml(g.klant)} · ${g.posten.length} ${g.posten.length === 1 ? "factuur" : "facturen"}</span></span>
      <span class="bedrag">${geld(g.open, [...g.valutas][0] || "")}</span>
    </label>`).join("");
}

const TEKSTEN = {
  nl: {
    herinnering: {
      onderwerp: g => `Herinnering openstaande facturen — ${g.naam || g.klant}`,
      opening: "Geachte heer, mevrouw,\n\nBij het doorlopen van onze administratie zagen wij dat onderstaande factuur/facturen nog niet is/zijn voldaan. Mogelijk is dit aan uw aandacht ontsnapt.",
      slot: "Is de betaling inmiddels onderweg, dan kunt u deze mail als niet verzonden beschouwen. Klopt er iets niet aan een van de facturen, laat het ons dan weten — dan zoeken wij het samen uit."
    },
    tweede: {
      onderwerp: g => `Tweede herinnering — ${g.naam || g.klant}`,
      opening: "Geachte heer, mevrouw,\n\nEerder wezen wij u op onderstaande openstaande facturen. Tot op vandaag hebben wij daarvan nog geen betaling ontvangen.",
      slot: "Wij verzoeken u het openstaande bedrag binnen 14 dagen over te maken. Lukt dat niet in één keer, neem dan contact met ons op over een betalingsregeling."
    },
    aanmaning: {
      onderwerp: g => `Aanmaning — ${g.naam || g.klant}`,
      opening: "Geachte heer, mevrouw,\n\nOndanks eerdere herinneringen staan onderstaande facturen nog altijd open.",
      slot: "Wij verzoeken u het volledige bedrag binnen 7 dagen te voldoen. Blijft betaling uit, dan zijn wij genoodzaakt de vordering ter verdere behandeling uit handen te geven; de kosten daarvan komen voor uw rekening."
    },
    kop: ["Factuur", "Datum", "Vervallen op", "Dagen te laat", "Openstaand"],
    totaal: "Totaal openstaand",
    afsluiting: "Met vriendelijke groet,"
  },
  en: {
    herinnering: {
      onderwerp: g => `Reminder — outstanding invoices — ${g.naam || g.klant}`,
      opening: "Dear Sir or Madam,\n\nWhile reviewing our accounts we noticed that the invoice(s) below have not yet been paid. This may simply have escaped your attention.",
      slot: "If payment is already on its way, please disregard this message. If anything about an invoice is unclear, let us know and we will look into it with you."
    },
    tweede: {
      onderwerp: g => `Second reminder — ${g.naam || g.klant}`,
      opening: "Dear Sir or Madam,\n\nWe previously drew your attention to the outstanding invoices below. To date we have not received payment.",
      slot: "We kindly ask you to transfer the outstanding amount within 14 days. If paying in one go is not possible, please contact us to arrange a payment schedule."
    },
    aanmaning: {
      onderwerp: g => `Final notice — ${g.naam || g.klant}`,
      opening: "Dear Sir or Madam,\n\nDespite earlier reminders, the invoices below remain unpaid.",
      slot: "We request full payment within 7 days. Should payment not be received, we will be obliged to hand the claim over for further collection, the costs of which will be for your account."
    },
    kop: ["Invoice", "Date", "Due date", "Days overdue", "Outstanding"],
    totaal: "Total outstanding",
    afsluiting: "Kind regards,"
  }
};

function maakBrief(g, soort, taal) {
  const t = TEKSTEN[taal], s = t[soort];
  const valuta = [...g.valutas][0] || "";
  const kolommen = [
    p => p.factuur || (p.boekstukcode + " " + p.boekstuknr).trim(),
    p => datumTekst(p.datum),
    p => datumTekst(p.vervalt),
    p => (p.dagen != null && p.dagen > 0 ? String(p.dagen) : "-"),
    p => geld(p.open, "")
  ];
  const regels = g.posten.slice().sort((a, b) => (b.dagen ?? -9999) - (a.dagen ?? -9999)).map(p => kolommen.map(f => f(p)));
  const alles = [t.kop, ...regels];
  const breed = t.kop.map((_, i) => Math.max(...alles.map(r => String(r[i]).length)));
  const regelTekst = r => r.map((c, i) => i >= 3 ? String(c).padStart(breed[i]) : String(c).padEnd(breed[i])).join("  ");

  const tabel = [regelTekst(t.kop), breed.map(b => "-".repeat(b)).join("  "), ...regels.map(regelTekst)].join("\n");
  const totaal = g.posten.reduce((s2, p) => s2 + p.open, 0);

  const body = [
    s.opening, "",
    tabel, "",
    `${t.totaal}: ${geld(totaal, valuta)}`, "",
    s.slot, "",
    t.afsluiting,
    inst.afzender || "",
    inst.antwoord || ""
  ].filter(r => r !== null).join("\n");

  return { onderwerp: s.onderwerp(g), body };
}

/* Bij "automatisch" kiest de app het niveau per debiteur op basis van de
   oudste vervallen post: t/m 30 dagen een herinnering, 31 t/m 60 een tweede
   herinnering, daarboven een aanmaning. */
function autoNiveau(g) {
  const d = g.oudste == null ? 0 : g.oudste;
  return d > 60 ? "aanmaning" : d > 30 ? "tweede" : "herinnering";
}

const NIVEAU_NAAM = { herinnering: "herinnering", tweede: "tweede herinnering", aanmaning: "aanmaning" };

function maakAanmaningen() {
  const keuze = document.getElementById("toon-soort").value;
  const taal = document.getElementById("toon-taal").value;
  const gekozen = new Set([...document.querySelectorAll(".aanm-vink:checked")].map(v => v.value));
  const groepen = aanmaningGroepen().filter(g => gekozen.has(g.klant));
  const doel = document.getElementById("aanmaning-uitkomst");

  if (!groepen.length) { doel.innerHTML = `<p class="zacht">Kies eerst minstens één debiteur.</p>`; return; }

  doel.innerHTML = groepen.map((g, i) => {
    const soort = keuze === "auto" ? autoNiveau(g) : keuze;
    const brief = maakBrief(g, soort, taal);
    return `
    <div class="brief" data-i="${i}" data-klant="${escapeHtml(g.klant)}">
      <div class="brief-kop">
        <label class="vink"><input type="checkbox" class="verstuur-vink" checked> versturen</label>
        <b>${escapeHtml(g.naam || g.klant)}</b>
        <span class="zacht klein">${escapeHtml(g.klant)} · ${geld(g.open, [...g.valutas][0] || "")}${keuze === "auto" ? ` · <span class="goud-tekst">${NIVEAU_NAAM[soort]}</span> (oudste ${g.oudste ?? 0} dagen)` : ""}</span>
        <input class="email" type="email" placeholder="e-mailadres van de debiteur" value="${escapeHtml(emails[g.klant] || "")}" data-klant="${escapeHtml(g.klant)}">
        <span class="rek"></span>
        <button class="knop stil klein btn-kopie">Kopieer tekst</button>
        <button class="knop stil klein btn-mail">Open in mail</button>
      </div>
      <input class="onderwerp" type="text" value="${escapeHtml(brief.onderwerp)}" style="width:100%;border:0;border-top:1px solid var(--rand-zacht);border-radius:0">
      <textarea>${escapeHtml(brief.body)}</textarea>
    </div>`;
  }).join("");

  doel.querySelectorAll(".brief").forEach(kaart => {
    const tekstveld = kaart.querySelector("textarea");
    const onderwerp = kaart.querySelector(".onderwerp");
    const emailveld = kaart.querySelector(".email");
    emailveld.addEventListener("change", () => {
      emails[emailveld.dataset.klant] = emailveld.value.trim();
      localStorage.setItem(OPSLAG_EMAILS, JSON.stringify(emails));
    });
    kaart.querySelector(".btn-kopie").addEventListener("click", async (e) => {
      await navigator.clipboard.writeText(onderwerp.value + "\n\n" + tekstveld.value);
      e.target.textContent = "Gekopieerd";
      setTimeout(() => { e.target.textContent = "Kopieer tekst"; }, 1800);
    });
    kaart.querySelector(".btn-mail").addEventListener("click", () => {
      const adres = emailveld.value.trim();
      const link = `mailto:${encodeURIComponent(adres)}?subject=${encodeURIComponent(onderwerp.value)}&body=${encodeURIComponent(tekstveld.value)}`;
      if (link.length > 1900) {
        alert("Deze tekst is te lang om via de mailknop mee te geven (het mailprogramma kapt hem af).\n\nGebruik 'Kopieer tekst' en plak hem in een nieuwe mail.");
        return;
      }
      location.href = link;
    });
    kaart.querySelector(".verstuur-vink").addEventListener("change", vernieuwVerstuurbalk);
    emailveld.addEventListener("input", vernieuwVerstuurbalk);
  });
  document.getElementById("verstuurbalk").style.display = "";
  wisMelding("melding-verstuur");
  vernieuwVerstuurbalk();
}

/* --------------------- versturen via Microsoft 365 ---------------------- */

/* De brieven die daadwerkelijk de deur uit zouden gaan: vinkje aan én een
   ingevuld e-mailadres. */
function teVersturen() {
  return [...document.querySelectorAll("#aanmaning-uitkomst .brief")]
    .filter(k => k.querySelector(".verstuur-vink").checked)
    .map(k => ({
      klant: k.dataset.klant,
      naam: k.querySelector(".brief-kop b").textContent,
      aan: k.querySelector(".email").value.trim(),
      onderwerp: k.querySelector(".onderwerp").value.trim(),
      tekst: k.querySelector("textarea").value
    }));
}

function vernieuwVerstuurbalk() {
  const alle = teVersturen();
  const met = alle.filter(b => b.aan);
  const zonder = alle.length - met.length;
  document.getElementById("verstuur-telling").innerHTML =
    `<b>${met.length}</b> aanmaning${met.length === 1 ? "" : "en"} klaar om te versturen` +
    (zonder ? ` · <span class="goud-tekst">${zonder} zonder e-mailadres (die gaan niet mee)</span>` : "");
  document.getElementById("btn-verstuur-alles").disabled = !met.length;
}

async function verstuurAlles() {
  const berichten = teVersturen().filter(b => b.aan);
  if (!berichten.length) return;

  const lijst = berichten.slice(0, 12).map(b => `• ${b.naam} → ${b.aan}`).join("\n") +
                (berichten.length > 12 ? `\n… en nog ${berichten.length - 12}` : "");
  if (!confirm(`${berichten.length} aanmaning${berichten.length === 1 ? "" : "en"} versturen via Microsoft 365?\n\n${lijst}\n\nDe mails gaan daarna echt de deur uit.`)) return;

  const knop = document.getElementById("btn-verstuur-alles");
  knop.disabled = true; knop.textContent = "Bezig met versturen…";
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) throw new Error("Je bent niet meer ingelogd — ververs de pagina en log opnieuw in.");
    const resp = await fetch(`${CFG.FUNCTIES_URL || CFG.SUPABASE_URL}/functions/v1/aanmaningen-mail`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + session.access_token, "Content-Type": "application/json" },
      body: JSON.stringify({ berichten: berichten.map(b => ({ aan: b.aan, onderwerp: b.onderwerp, tekst: b.tekst })) })
    });
    const raw = await resp.text();
    logBij("aanmaningen versturen", JSON.stringify({ aantal: berichten.length }), raw, resp.ok, 0);
    let j = null;
    try { j = JSON.parse(raw); } catch (e) { /* geen JSON */ }
    if (resp.status === 404) throw new Error("De verstuurfunctie staat nog niet bij Supabase — zie AZURE-MAIL-INSTRUCTIES.md voor de eenmalige inrichting.");
    if (!resp.ok) throw new Error((j && j.fout) || `HTTP ${resp.status}: ${raw.slice(0, 200)}`);

    const uitkomsten = (j && j.uitkomsten) || [];
    const gelukt = uitkomsten.filter(u => u.gelukt);
    const mislukt = uitkomsten.filter(u => !u.gelukt);
    toonMelding("melding-verstuur", mislukt.length ? "fout" : "ok",
      `<b>${gelukt.length} van de ${uitkomsten.length}</b> aanmaningen verstuurd.` +
      (mislukt.length ? `<br>Mislukt: ${mislukt.map(u => `${escapeHtml(u.aan)} (${escapeHtml(u.fout || "?")})`).join(", ")}` : "") +
      `<br><span class="klein">Ze staan in Verzonden items van de verzendmailbox.</span>`);
    // Verstuurde brieven het vinkje uitzetten, zodat een tweede klik ze niet nóg eens verstuurt.
    for (const kaart of document.querySelectorAll("#aanmaning-uitkomst .brief")) {
      const aan = kaart.querySelector(".email").value.trim();
      if (gelukt.some(u => u.aan === aan)) kaart.querySelector(".verstuur-vink").checked = false;
    }
    vernieuwVerstuurbalk();
  } catch (e) {
    toonMelding("melding-verstuur", "fout", "Versturen mislukt: " + escapeHtml(e.message));
  }
  knop.disabled = false; knop.textContent = "Versturen via Microsoft 365";
}

async function haalEmails() {
  const groepen = aanmaningGroepen();
  const knop = document.getElementById("btn-emails");
  knop.disabled = true;
  let gevonden = 0, mislukt = 0;
  for (let i = 0; i < groepen.length; i++) {
    const g = groepen[i];
    knop.textContent = `Bezig… ${i + 1} van ${groepen.length}`;
    if (emails[g.klant]) { gevonden++; continue; }
    try {
      const adres = await haalDebiteurEmail(inst.office, g.klant);
      if (adres) { emails[g.klant] = adres; gevonden++; }
    } catch (e) { mislukt++; }
  }
  localStorage.setItem(OPSLAG_EMAILS, JSON.stringify(emails));
  knop.disabled = false;
  knop.textContent = "E-mailadressen ophalen uit Twinfield";
  toonMelding("melding-top", mislukt ? "fout" : "ok",
    `${gevonden} van de ${groepen.length} debiteuren heeft nu een e-mailadres.` +
    (mislukt ? ` Bij ${mislukt} mislukte het opvragen — vul die zelf in bij de brief.` : "") +
    ` Adressen die je zelf invult worden bewaard in deze browser.`);
  const uitkomst = document.getElementById("aanmaning-uitkomst");
  if (uitkomst.children.length) maakAanmaningen();
}

/* =============================== afletteren ============================== */

function vernieuwAfletteren() {
  const ontvangsten = posten.filter(p => p.open < 0);
  const tb = document.querySelector("#tabel-ontvangsten tbody");
  if (!ontvangsten.length) {
    tb.innerHTML = `<tr><td colspan="5" class="zacht">${posten.length ? "Geen openstaande ontvangsten gevonden — er is niets af te letteren." : "Nog niets opgehaald."}</td></tr>`;
    document.getElementById("paneel-match").style.display = "none";
    return;
  }
  tb.innerHTML = ontvangsten.map((p, i) => `
    <tr>
      <td><input type="radio" name="ontvangst" value="${i}" ${matchKeuze.ontvangst === p ? "checked" : ""}></td>
      <td class="naam">${escapeHtml(p.klantnaam || p.klant)} <span class="zacht klein">${escapeHtml(p.klant)}</span></td>
      <td>${escapeHtml((p.boekstukcode + " " + p.boekstuknr).trim())}</td>
      <td>${datumTekst(p.datum)}</td>
      <td class="num">${geld(p.open, p.valuta)}</td>
    </tr>`).join("");

  tb.querySelectorAll('input[name="ontvangst"]').forEach(radio => radio.addEventListener("change", () => {
    matchKeuze = { ontvangst: ontvangsten[+radio.value], facturen: new Set() };
    toonMatchFacturen();
  }));
  if (matchKeuze.ontvangst) toonMatchFacturen();
}

function toonMatchFacturen() {
  const o = matchKeuze.ontvangst;
  const paneel = document.getElementById("paneel-match");
  if (!o) { paneel.style.display = "none"; return; }
  paneel.style.display = "";
  document.getElementById("match-debiteur").textContent = (o.klantnaam || o.klant) + " (" + o.klant + ")";
  document.getElementById("match-xml").style.display = "none";
  wisMelding("melding-match");

  const facturen = posten.filter(p => p.klant === o.klant && p.open > 0)
                         .sort((a, b) => (b.dagen ?? -9999) - (a.dagen ?? -9999));
  const tb = document.querySelector("#tabel-match-facturen tbody");
  tb.innerHTML = facturen.length ? facturen.map((p, i) => `
    <tr>
      <td><input type="checkbox" class="match-vink" value="${i}" ${matchKeuze.facturen.has(p) ? "checked" : ""}></td>
      <td>${escapeHtml(p.factuur || "—")}</td>
      <td>${escapeHtml((p.boekstukcode + " " + p.boekstuknr).trim())}</td>
      <td>${datumTekst(p.datum)}</td>
      <td>${datumTekst(p.vervalt)}</td>
      <td class="num">${geld(p.open, p.valuta)}</td>
    </tr>`).join("")
    : `<tr><td colspan="6" class="zacht">Deze debiteur heeft geen openstaande facturen — de ontvangst hoort dan bij iets anders.</td></tr>`;

  tb.querySelectorAll(".match-vink").forEach(v => v.addEventListener("change", () => {
    const p = facturen[+v.value];
    if (v.checked) matchKeuze.facturen.add(p); else matchKeuze.facturen.delete(p);
    vernieuwMatchVoet();
  }));
  vernieuwMatchVoet();
}

function vernieuwMatchVoet() {
  const o = matchKeuze.ontvangst;
  const somFacturen = [...matchKeuze.facturen].reduce((s, p) => s + p.open, 0);
  const verschil = (o ? o.open : 0) + somFacturen;
  document.getElementById("match-ontvangst").textContent = geld(o ? o.open : 0, o ? o.valuta : "");
  document.getElementById("match-facturen").textContent = geld(somFacturen, "");
  const el = document.getElementById("match-verschil");
  el.textContent = geld(verschil, "");
  el.className = Math.abs(verschil) < 0.005 ? "groen-tekst" : "goud-tekst";
  document.getElementById("btn-match-door").disabled = !matchKeuze.facturen.size;
}

function matchRegels() {
  const o = matchKeuze.ontvangst;
  // Twinfield wil per regel het bedrag dat op díe regel afgeletterd wordt.
  // De ontvangst neemt het volledige openstaande bedrag; elke factuur de hare.
  return [
    { boekstukcode: o.boekstukcode, boekstuknr: o.boekstuknr, regelnr: o.regelnr, bedrag: o.open },
    ...[...matchKeuze.facturen].map(p => ({ boekstukcode: p.boekstukcode, boekstuknr: p.boekstuknr, regelnr: p.regelnr, bedrag: p.open }))
  ];
}

/* =============================== instellingen ============================ */

function laadInstellingen() {
  try {
    const bewaard = JSON.parse(localStorage.getItem(OPSLAG_INST));
    if (bewaard) inst = { ...inst, ...bewaard };
  } catch (e) { /* eerste keer */ }
  try { emails = JSON.parse(localStorage.getItem(OPSLAG_EMAILS)) || {}; } catch (e) { emails = {}; }
  document.getElementById("in-office").value = inst.office || "";
  document.getElementById("in-dagen").value = inst.dagen ?? 30;
  document.getElementById("in-afzender").value = inst.afzender || "";
  document.getElementById("in-antwoord").value = inst.antwoord || "";
  document.getElementById("in-endpoint").textContent = (CFG.SUPABASE_URL || "—") + "/functions/v1/directlink";
  document.getElementById("in-dl-endpoint").value = inst.dlEndpoint || "";
  document.getElementById("in-dl-token").value = inst.dlToken || "";
  (inst.verbinding === "luik"
    ? document.getElementById("vb-luik")
    : document.getElementById("vb-direct")).checked = true;
  toonVerbindingsblok();
}

function toonVerbindingsblok() {
  document.getElementById("blok-direct").style.display =
    document.getElementById("vb-luik").checked ? "none" : "";
}

function bewaarInstellingen() {
  inst.office   = document.getElementById("in-office").value.trim().toUpperCase() || "ENDURA";
  inst.dagen    = Number(document.getElementById("in-dagen").value) || 0;
  inst.afzender = document.getElementById("in-afzender").value.trim();
  inst.antwoord = document.getElementById("in-antwoord").value.trim();
  inst.verbinding = document.getElementById("vb-luik").checked ? "luik" : "direct";
  inst.dlEndpoint = document.getElementById("in-dl-endpoint").value.trim();
  inst.dlToken    = document.getElementById("in-dl-token").value.trim();
  localStorage.setItem(OPSLAG_INST, JSON.stringify(inst));
  document.getElementById("paginahint").textContent = `Openstaande debiteurenposten van administratie ${inst.office}.`;
}

function bewaarPosten() {
  try {
    localStorage.setItem(OPSLAG_POSTEN, JSON.stringify({
      opgehaaldOp,
      office: inst.office,
      posten: posten.map(p => ({ ...p, datum: datumIso(p.datum), vervalt: datumIso(p.vervalt) }))
    }));
  } catch (e) { /* te groot voor localStorage: dan gewoon niet bewaren */ }
}

function laadPosten() {
  try {
    const b = JSON.parse(localStorage.getItem(OPSLAG_POSTEN));
    if (!b || !Array.isArray(b.posten)) return;
    const nu = vandaag();
    posten = b.posten.map(p => {
      const datum = parseDatum(p.datum), vervalt = parseDatum(p.vervalt);
      return { ...p, datum, vervalt, dagen: vervalt ? dagenTussen(vervalt, nu) : null };
    });
    opgehaaldOp = b.opgehaaldOp || null;
  } catch (e) { /* niets bewaard */ }
}

/* ================================ ophalen ================================ */

async function ophalen() {
  const knop = document.getElementById("btn-ophalen");
  knop.disabled = true;
  const oud = knop.textContent;
  knop.textContent = "Bezig met ophalen…";
  toonMelding("melding-top", "bezig", `Openstaande posten van <b>${escapeHtml(inst.office)}</b> ophalen uit Twinfield. Dit duurt meestal 5 tot 30 seconden.`);
  try {
    const { rijen, velden } = await haalOpenPosten(inst.office);
    const nieuw = normaliseer(rijen, velden);
    posten = nieuw;
    opgehaaldOp = new Date().toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });
    matchKeuze = { ontvangst: null, facturen: new Set() };
    bewaarPosten();
    vernieuwAlles();
    if (!rijen.length) {
      toonMelding("melding-top", "fout",
        `Twinfield gaf geen enkele regel terug voor administratie <b>${escapeHtml(inst.office)}</b>. ` +
        `Klopt de administratiecode (tabblad Instellingen)? En heeft het DirectLink-token toegang tot deze administratie?`);
    } else if (!nieuw.length) {
      toonMelding("melding-top", "ok",
        `Niets openstaand: van de ${rijen.length} regels die Twinfield teruggaf, staat er geen enkele meer open.`);
    } else {
      const vervallen = nieuw.filter(p => p.dagen != null && p.dagen > 0 && p.open > 0).length;
      toonMelding("melding-top", "ok",
        `${nieuw.length} openstaande posten opgehaald uit ${escapeHtml(inst.office)} (${rijen.length} regels bekeken). ` +
        `${vervallen} daarvan ${vervallen === 1 ? "is" : "zijn"} vervallen.`);
    }
  } catch (e) {
    toonMelding("melding-top", "fout",
      "Ophalen mislukt: " + escapeHtml(e.message) +
      ` <br><span class="klein">Kijk op het tabblad <b>Logboek</b> wat er precies heen en terug ging.</span>`);
  }
  knop.disabled = false;
  knop.textContent = oud;
}

/* ============================== tabbladen ================================ */

const TAB_TITELS = {
  overzicht:    ["Overzicht", () => `Openstaande debiteurenposten van administratie ${inst.office}.`],
  debiteuren:   ["Debiteuren", () => "Alle openstaande posten, gegroepeerd per debiteur."],
  aanmaningen:  ["Aanmaningen", () => "Conceptteksten per debiteur. Versturen doe je zelf."],
  afletteren:   ["Afletteren", () => "Ontvangsten aan facturen hangen. Dit schrijft in Twinfield."],
  instellingen: ["Instellingen", () => "Administratie, verbinding en aanmaningsteksten."],
  logboek:      ["Logboek", () => "Wat er heen en terug ging naar Twinfield."]
};

function naarTab(naam) {
  document.querySelectorAll(".nav-knop").forEach(k => k.classList.toggle("actief", k.dataset.tab === naam));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("actief", t.id === "tab-" + naam));
  const [titel, hint] = TAB_TITELS[naam];
  document.getElementById("paginatitel").textContent = titel;
  document.getElementById("paginahint").textContent = hint();
  if (naam === "logboek") toonLogboek();
  location.hash = naam;
}

/* ================================= start ================================= */

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const knop = document.getElementById("btn-login");
  knop.disabled = true; knop.textContent = "Bezig…";
  const { error } = await sb.auth.signInWithPassword({
    email: document.getElementById("login-email").value.trim(),
    password: document.getElementById("login-wachtwoord").value
  });
  knop.disabled = false; knop.textContent = "Inloggen";
  if (error) {
    toonMelding("melding-login", "fout", /invalid login credentials/i.test(error.message)
      ? "E-mailadres of wachtwoord klopt niet."
      : "Inloggen mislukt: " + escapeHtml(error.message));
  }
});

document.querySelectorAll(".nav-knop").forEach(k => k.addEventListener("click", () => naarTab(k.dataset.tab)));
document.getElementById("btn-ophalen").addEventListener("click", ophalen);
document.getElementById("btn-uitloggen").addEventListener("click", () => sb.auth.signOut());

document.getElementById("zoek").addEventListener("input", vernieuwDebiteuren);
document.getElementById("sorteer").addEventListener("change", vernieuwDebiteuren);
document.getElementById("alleen-vervallen").addEventListener("change", vernieuwDebiteuren);
document.getElementById("btn-excel-post").addEventListener("click", excelPerPost);
document.getElementById("btn-excel-deb").addEventListener("click", excelPerDebiteur);

document.getElementById("aanm-alleen-vervallen").addEventListener("change", vernieuwAanmaningKeuze);
document.getElementById("btn-maak-aanmaningen").addEventListener("click", maakAanmaningen);
document.getElementById("btn-emails").addEventListener("click", haalEmails);
document.getElementById("btn-verstuur-alles").addEventListener("click", verstuurAlles);

document.getElementById("btn-match-xml").addEventListener("click", () => {
  const pre = document.getElementById("match-xml");
  pre.textContent = bouwMatchXml(inst.office, matchRegels());
  pre.style.display = "";
  toonMelding("melding-match", "ok", "Dit is het bericht dat naar Twinfield zou gaan. Er is nog niets verstuurd.");
});

document.getElementById("btn-match-door").addEventListener("click", async () => {
  const o = matchKeuze.ontvangst;
  const somFacturen = [...matchKeuze.facturen].reduce((s, p) => s + p.open, 0);
  const verschil = o.open + somFacturen;
  const vraag = `Afletteren doorvoeren in Twinfield, administratie ${inst.office}?\n\n` +
    `Ontvangst ${o.boekstukcode} ${o.boekstuknr}: ${geld(o.open, o.valuta)}\n` +
    `${matchKeuze.facturen.size} factuur/facturen: ${geld(somFacturen, "")}\n` +
    `Verschil: ${geld(verschil, "")}\n\n` +
    (Math.abs(verschil) >= 0.005 ? "Let op: het verschil is niet nul. Twinfield weigert dit waarschijnlijk.\n\n" : "") +
    `Dit wijzigt gegevens in Twinfield.`;
  if (!confirm(vraag)) return;

  const knop = document.getElementById("btn-match-door");
  knop.disabled = true; knop.textContent = "Bezig…";
  try {
    const uitkomst = await voerMatchUit(inst.office, matchRegels());
    if (uitkomst.goed) {
      toonMelding("melding-match", "ok", "Twinfield heeft het afletteren aangenomen. Haal de posten opnieuw op om de nieuwe stand te zien, en kijk in Twinfield of het klopt.");
    } else {
      toonMelding("melding-match", "fout",
        "Twinfield nam het niet aan: " + escapeHtml(uitkomst.fout) +
        `<br><span class="klein">Het volledige antwoord staat op het tabblad Logboek. Dit onderdeel is nog niet beproefd — de opbouw van het match-bericht moet mogelijk nog bijgesteld worden.</span>`);
    }
  } catch (e) {
    toonMelding("melding-match", "fout", "Doorvoeren mislukt: " + escapeHtml(e.message));
  }
  knop.disabled = false; knop.textContent = "Doorvoeren in Twinfield";
});

["in-office", "in-dagen", "in-afzender", "in-antwoord", "in-dl-endpoint", "in-dl-token"].forEach(id =>
  document.getElementById(id).addEventListener("change", bewaarInstellingen));
["vb-direct", "vb-luik"].forEach(id =>
  document.getElementById(id).addEventListener("change", () => { bewaarInstellingen(); toonVerbindingsblok(); }));
document.getElementById("in-dl-toon").addEventListener("change", (e) =>
  document.getElementById("in-dl-token").type = e.target.checked ? "text" : "password");

document.getElementById("btn-toets").addEventListener("click", async () => {
  const knop = document.getElementById("btn-toets");
  knop.disabled = true;
  toonMelding("melding-toets", "bezig", "Administraties ophalen…");
  try {
    const lijst = await haalAdministraties();
    const heeftOnze = lijst.some(o => o.code.toUpperCase() === inst.office.toUpperCase());
    toonMelding("melding-toets", heeftOnze ? "ok" : "fout",
      `De verbinding werkt: ${lijst.length} administraties gevonden. ` +
      (heeftOnze
        ? `<b>${escapeHtml(inst.office)}</b> zit erbij.`
        : `Maar <b>${escapeHtml(inst.office)}</b> zit er <b>niet</b> bij. Beschikbaar: ` +
          lijst.slice(0, 25).map(o => escapeHtml(o.code)).join(", ") + (lijst.length > 25 ? " …" : "")));
  } catch (e) {
    toonMelding("melding-toets", "fout", "Toetsen mislukt: " + escapeHtml(e.message));
  }
  knop.disabled = false;
});

document.getElementById("btn-velden").addEventListener("click", async () => {
  const knop = document.getElementById("btn-velden");
  knop.disabled = true;
  toonMelding("melding-toets", "bezig", "Rapportdefinitie 130_3 opvragen…");
  try {
    const def = await haalVelddefinitie(true);
    const gebruikt = {};
    for (const soort of Object.keys(VELDKEUZE)) gebruikt[soort] = kiesVeld(soort, def);
    document.getElementById("veldenlijst").innerHTML = `
      <table>
        <thead><tr><th>Kolom in de app</th><th>Veld in Twinfield</th><th>Filterbaar met</th></tr></thead>
        <tbody>${Object.entries(gebruikt).map(([soort, veld]) => `
          <tr>
            <td>${escapeHtml(soort)}</td>
            <td class="mono klein">${veld ? escapeHtml(veld) : '<span class="zacht">niet beschikbaar</span>'}</td>
            <td class="klein">${veld ? escapeHtml(def.operators.get(veld) || "—") : ""}</td>
          </tr>`).join("")}
        </tbody>
      </table>
      <p class="zacht klein" style="margin-top:10px">Twinfield kent voor rapport 130_3 in totaal ${def.velden.size} velden. Het volledige antwoord staat op het tabblad Logboek.</p>`;
    toonMelding("melding-toets", "ok", "Velden opgehaald en bewaard. De app gebruikt vanaf nu deze namen.");
  } catch (e) {
    toonMelding("melding-toets", "fout", "Velden ophalen mislukt: " + escapeHtml(e.message));
  }
  knop.disabled = false;
});

document.getElementById("btn-wis").addEventListener("click", () => {
  if (!confirm("Alle opgeslagen posten, instellingen en e-mailadressen in deze browser wissen?")) return;
  [OPSLAG_INST, OPSLAG_POSTEN, OPSLAG_EMAILS, "debiteuren.velddefinitie.v1"].forEach(k => localStorage.removeItem(k));
  location.reload();
});

document.getElementById("btn-log-kopie").addEventListener("click", async () => {
  await navigator.clipboard.writeText(logregels.map(r =>
    `[${r.tijd}] ${r.watVoor} — ${r.gelukt ? "goed" : "mislukt"} (${r.duur} ms)\nVERSTUURD:\n${r.xml}\nANTWOORD:\n${r.antwoord}\n`).join("\n----\n"));
  toonMelding("melding-top", "ok", "Het logboek staat op je klembord.");
});
document.getElementById("btn-log-wis").addEventListener("click", () => { logregels = []; toonLogboek(); });

(async function start() {
  const binnen = await initAuth();
  if (!binnen) return;
  document.getElementById("login-overlay").style.display = "none";
  document.getElementById("app").style.display = "";
  document.getElementById("kop-gebruiker").textContent = gebruiker.email;
  document.getElementById("in-gebruiker").textContent = gebruiker.email;
  laadInstellingen();
  laadPosten();
  vernieuwAlles();
  const start = (location.hash || "").replace("#", "");
  naarTab(TAB_TITELS[start] ? start : "overzicht");
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
