// Ekte stemmetall, brukstall og dueller for RatherBattle.
//
// Endepunkter:
//   POST /api/vote                  { q, side, lang, kind, ny }  → { a, b }
//   GET  /api/pulse                                              → aggregerte brukstall
//   POST /api/duel  { op:"ny",   k, lang, mid }                  → { id }
//   POST /api/duel  { op:"svar", id, sider, mid }                → { ok }
//   GET  /api/duel?id=<id>                                       → { id, k, lang }
//   GET  /api/duel?tilfeldig=1                                   → { kandidater: [...] }
//   GET  /api/duel?mine=<mid>                                    → { mine: [...] }
//
// /api/pulse er med vilje åpent og inneholder bare summer — ingen personer,
// ingen id-er, ingenting som kan spores tilbake til noen. Det gjør at et
// overvåkingsverktøy (eller Claude) kan lese det uten å få tilgang til kontoen
// din.
//
// «mid» er en tilfeldig streng telefonen lager til seg selv. Den er ikke en
// konto: ingen e-post, ingen navn, ingenting å logge inn på. Den finnes bare
// for at en utfordring skal finne veien tilbake til den som la den ut.
//
// OPPSETT (ca. 10 minutter, gratis):
//   1. Lag en database på https://upstash.com → Redis → Create Database.
//   2. Kopier "UPSTASH_REDIS_REST_URL" og "UPSTASH_REDIS_REST_TOKEN".
//   3. Netlify → Site settings → Environment variables → legg inn begge.
//   4. Legg denne fila i  netlify/functions/vote.mjs  i utrullingsmappa.
//   5. I bygg.js: sett  VOTE_API = "/api/vote"  og bygg på nytt.

// Nøkler limt inn fra en .env-fil får ofte med seg anførselstegn, mellomrom
// eller hele «NAVN=»-biten. Vask dem, så det virker uansett hvordan de kom inn.
function vask(verdi) {
  let v = String(verdi || "").trim();
  v = v.replace(/^[A-Z_]+\s*=\s*/, "");          // UPSTASH_..._URL=...
  v = v.replace(/^["'`]+|["'`]+$/g, "").trim();  // "..." eller '...'
  return v;
}
// Leter fram adresse og nøkkel uansett hva som ble limt inn rundt dem — en
// hel .env-blokk i ett felt, begge linjer i begge felt, anførselstegn, osv.
const RAA_URL = String(process.env.UPSTASH_REDIS_REST_URL || "");
const RAA_TOKEN = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
const ALT = RAA_URL + "\n" + RAA_TOKEN;

// Adressen er ikke hemmelig (den gir ingen tilgang uten nøkkelen), så den
// kjente adressen står her som reserve hvis feltet i Netlify er rotete.
const KJENT_URL = "https://quiet-crappie-286891.upstash.io";

function finnUrl() {
  const treff = ALT.match(/https:\/\/[A-Za-z0-9.-]+\.upstash\.io/);
  return treff ? treff[0] : KJENT_URL;
}
function finnToken() {
  // 1) Står det «UPSTASH_REDIS_REST_TOKEN=…» noe sted, bruk det.
  const merket = ALT.match(/UPSTASH_REDIS_REST_TOKEN\s*=\s*["'`]?([A-Za-z0-9_=+\/-]{20,})/);
  if (merket) return merket[1];
  // 2) Ellers: det vaskede token-feltet, hvis det ser ut som en nøkkel.
  const v = vask(RAA_TOKEN);
  if (/^[A-Za-z0-9_=+\/-]{20,}$/.test(v)) return v;
  // 3) Siste utvei: en lang nøkkel-lignende streng i noen av feltene.
  const los = ALT.replace(/https:\/\/\S+/g, " ").match(/[A-Za-z0-9_=+\/-]{40,}/);
  return los ? los[0] : "";
}
const URL_BASE = finnUrl();
const TOKEN = finnToken();

// Forteller hva som er galt uten å avsløre selve nøkkelen.
function diagnose(feil) {
  const m = String((feil && feil.message) || feil || "");
  if (!TOKEN) return `fant ingen nøkkel i UPSTASH_REDIS_REST_TOKEN (feltet har ${RAA_TOKEN.length} tegn)`;
  if (/401|403/.test(m)) return `databasen avviste nøkkelen (${TOKEN.length} tegn) — lim inn tokenet på nytt`;
  if (/Redis svarte/.test(m)) return m;
  return "fikk ikke kontakt med databasen";
}

// Må stemme med antallet dilemmaer i bygget. Hindrer at noen fyller databasen
// med tilfeldige nøkler.
const MAX_SPORSMAL = 3041;
const SPRAK = ["no", "en", "es", "de", "fr", "pt-BR", "it", "sv"];
const MODUS = ["solo", "daily", "duel"];

// Duellgrenser. En utfordring er ti dilemmaer; resten er slingringsmonn.
const MAKS_KODE = 200;      // tegn i den kodede utfordringen
const MAKS_SIDER = 30;      // antall svar i én duell
const POTT_TAK = 800;       // åpne utfordringer vi holder i omløp
const KANDIDATER = 8;       // hvor mange vi tilbyr klienten å velge blant
const LEVETID = 60 * 24 * 3600; // to måneder, så databasen ikke gror igjen

async function redis(kommandoer) {
  const svar = await fetch(`${URL_BASE}/pipeline`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(kommandoer)
  });
  if (!svar.ok) throw new Error(`Redis svarte ${svar.status}`);
  return svar.json();
}

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const idag = () => new Date().toISOString().slice(0, 10);

function svarMed(data, status = 200, ekstra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...HEADERS, ...ekstra } });
}

// Upstash gir hasher som flat liste: [nøkkel, verdi, nøkkel, verdi, ...]
function tilHash(flat) {
  const ut = {};
  const liste = flat ?? [];
  for (let i = 0; i < liste.length; i += 2) ut[liste[i]] = liste[i + 1];
  return ut;
}

// ---------- POST /api/vote ----------
async function stem(request) {
  let kropp;
  try {
    kropp = await request.json();
  } catch {
    return svarMed({ feil: "ugyldig json" }, 400);
  }

  const q = Number(kropp?.q);
  const side = kropp?.side;
  if (!Number.isInteger(q) || q < 0 || q >= MAX_SPORSMAL || (side !== "a" && side !== "b")) {
    return svarMed({ feil: "ugyldig svar" }, 400);
  }

  // Alt annet er valgfritt og valideres mot kjente verdier, så et forsøk på å
  // sprøyte inn egne nøkler ikke havner i tallene.
  const lang = SPRAK.includes(kropp?.lang) ? kropp.lang : "ukjent";
  const kind = MODUS.includes(kropp?.kind) ? kropp.kind : "solo";
  const ny = kropp?.ny === true;
  const dag = idag();

  const kommandoer = [
    ["HINCRBY", `q:${q}`, side, 1],
    ["HMGET", `q:${q}`, "a", "b"],
    ["INCR", "stats:svar"],
    ["HINCRBY", "stats:sprak", lang, 1],
    ["HINCRBY", "stats:modus", kind, 1],
    ["HINCRBY", "stats:dag", dag, 1]
  ];
  // Første svar noensinne på denne enheten = én ny spiller.
  if (ny) {
    kommandoer.push(["INCR", "stats:spillere"]);
    kommandoer.push(["HINCRBY", "stats:nye", dag, 1]);
  }

  try {
    const resultat = await redis(kommandoer);
    const felt = resultat[1]?.result ?? [];
    return svarMed({ a: Number(felt[0]) || 0, b: Number(felt[1]) || 0 });
  } catch (e) {
    // Databasen nede er ikke en grunn til å ødelegge spillet.
    return svarMed({ feil: "utilgjengelig", grunn: diagnose(e) }, 503);
  }
}

// ---------- duell ----------
const gyldigKode = (k) => typeof k === "string" && /^[0-9a-z]{4,}$/.test(k) && k.length <= MAKS_KODE;
const gyldigSider = (s) => typeof s === "string" && /^[ab]{1,30}$/.test(s) && s.length <= MAKS_SIDER;
const gyldigMid = (m) => typeof m === "string" && /^[0-9a-f]{8,32}$/.test(m);
const gyldigId = (i) => typeof i === "string" && /^[0-9a-f]{8,16}$/.test(i);

function nyId() {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

// POST { op: "ny", k, lang, mid } → legg en utfordring i potten
async function duellNy(kropp) {
  const k = kropp?.k;
  const mid = kropp?.mid;
  if (!gyldigKode(k) || !gyldigMid(mid)) return svarMed({ feil: "ugyldig utfordring" }, 400);
  const lang = SPRAK.includes(kropp?.lang) ? kropp.lang : "ukjent";

  const id = nyId();
  const r = await redis([
    ["HSET", `d:${id}`, "k", k, "lang", lang, "mid", mid, "t", String(Date.now())],
    ["EXPIRE", `d:${id}`, String(LEVETID)],
    ["SADD", "dp", id],
    ["LPUSH", `dm:${mid}`, id],
    ["LTRIM", `dm:${mid}`, "0", "19"],
    ["EXPIRE", `dm:${mid}`, String(LEVETID)],
    ["INCR", "stats:duell_lagt"],
    ["SCARD", "dp"]
  ]);

  // Hold potten i sjakk. Eldste utfordringer forsvinner uansett av seg selv.
  const antall = Number(r[7]?.result) || 0;
  if (antall > POTT_TAK) {
    try { await redis([["SPOP", "dp", String(antall - POTT_TAK)]]); } catch { /* ikke kritisk */ }
  }
  return svarMed({ id: id });
}

// POST { op: "svar", id, sider, mid } → registrer at noen tok utfordringen
async function duellSvar(kropp) {
  const id = kropp?.id;
  const sider = kropp?.sider;
  if (!gyldigId(id) || !gyldigSider(sider)) return svarMed({ feil: "ugyldig svar" }, 400);
  const mid = gyldigMid(kropp?.mid) ? kropp.mid : "";

  const finnes = await redis([["EXISTS", `d:${id}`]]);
  if (!Number(finnes[0]?.result)) return svarMed({ feil: "finnes ikke" }, 404);

  await redis([
    ["LPUSH", `ds:${id}`, JSON.stringify({ s: sider, m: mid.slice(0, 8), t: Date.now() })],
    ["LTRIM", `ds:${id}`, "0", "49"],
    ["EXPIRE", `ds:${id}`, String(LEVETID)],
    ["INCR", "stats:duell_tatt"]
  ]);
  return svarMed({ ok: true });
}

// GET ?id=<id> → hent én bestemt utfordring
async function duellHent(id) {
  if (!gyldigId(id)) return svarMed({ feil: "ugyldig id" }, 400);
  const r = await redis([["HGETALL", `d:${id}`]]);
  const h = tilHash(r[0]?.result);
  if (!h.k) return svarMed({ feil: "finnes ikke" }, 404);
  return svarMed({ id: id, k: h.k, lang: h.lang || "ukjent" });
}

// GET ?tilfeldig=1 → noen åpne utfordringer klienten kan velge blant.
// Klienten hopper selv over dem den allerede har spilt, så serveren slipper
// å vite hvem som har gjort hva.
async function duellTilfeldig(ikkeMid) {
  const r = await redis([["SRANDMEMBER", "dp", String(KANDIDATER)]]);
  const ider = (r[0]?.result ?? []).filter(gyldigId);
  if (!ider.length) return svarMed({ kandidater: [] });

  const hentet = await redis(ider.map((i) => ["HGETALL", `d:${i}`]));
  const kandidater = [];
  const doede = [];
  for (let n = 0; n < ider.length; n++) {
    const h = tilHash(hentet[n]?.result);
    if (!h.k) { doede.push(ider[n]); continue; }   // utløpt, men fortsatt i potten
    if (ikkeMid && h.mid === ikkeMid) continue;    // ingen skal duellere mot seg selv
    kandidater.push({ id: ider[n], k: h.k, lang: h.lang || "ukjent" });
  }
  if (doede.length) {
    try { await redis([["SREM", "dp", ...doede]]); } catch { /* rydding kan vente */ }
  }
  return svarMed({ kandidater: kandidater });
}

// GET ?mine=<mid> → hva som har skjedd med utfordringene mine
async function duellMine(mid) {
  if (!gyldigMid(mid)) return svarMed({ feil: "ugyldig id" }, 400);
  const r = await redis([["LRANGE", `dm:${mid}`, "0", "9"]]);
  const ider = (r[0]?.result ?? []).filter(gyldigId);
  if (!ider.length) return svarMed({ mine: [] });

  const kommandoer = [];
  for (const i of ider) { kommandoer.push(["HGET", `d:${i}`, "k"]); kommandoer.push(["LRANGE", `ds:${i}`, "0", "19"]); }
  const ut = await redis(kommandoer);

  const mine = [];
  for (let n = 0; n < ider.length; n++) {
    const k = ut[n * 2]?.result;
    if (!k) continue;
    const rader = ut[n * 2 + 1]?.result ?? [];
    const svar = [];
    for (const rad of rader) {
      try {
        const o = typeof rad === "string" ? JSON.parse(rad) : rad;
        if (o && typeof o.s === "string") svar.push({ s: o.s, t: Number(o.t) || 0 });
      } catch { /* hopp over en ødelagt rad */ }
    }
    mine.push({ id: ider[n], k: k, svar: svar });
  }
  return svarMed({ mine: mine });
}

async function duell(request) {
  try {
    if (request.method === "POST") {
      let kropp;
      try { kropp = await request.json(); } catch { return svarMed({ feil: "ugyldig json" }, 400); }
      if (kropp?.op === "ny") return await duellNy(kropp);
      if (kropp?.op === "svar") return await duellSvar(kropp);
      return svarMed({ feil: "ukjent op" }, 400);
    }
    if (request.method === "GET") {
      const p = new URL(request.url).searchParams;
      if (p.get("id")) return await duellHent(p.get("id"));
      if (p.get("mine")) return await duellMine(p.get("mine"));
      if (p.get("tilfeldig")) return await duellTilfeldig(p.get("mid") || "");
      return svarMed({ feil: "mangler parameter" }, 400);
    }
    return svarMed({ feil: "kun GET og POST" }, 405);
  } catch (e) {
    return svarMed({ feil: "utilgjengelig", grunn: diagnose(e) }, 503);
  }
}

// ---------- GET /api/pulse ----------
async function puls() {
  try {
    const r = await redis([
      ["GET", "stats:svar"],
      ["GET", "stats:spillere"],
      ["HGETALL", "stats:sprak"],
      ["HGETALL", "stats:modus"],
      ["HGETALL", "stats:dag"],
      ["HGETALL", "stats:nye"],
      ["GET", "stats:duell_lagt"],
      ["GET", "stats:duell_tatt"],
      ["SCARD", "dp"]
    ]);

    const tall = (i) => Number(r[i]?.result) || 0;
    const hash = (i) => {
      const flat = tilHash(r[i]?.result);
      const ut = {};
      for (const n in flat) ut[n] = Number(flat[n]) || 0;
      return ut;
    };

    const perDag = hash(4);
    const nyePerDag = hash(5);
    const modus = hash(3);

    // 21 dager: nok til å sammenligne forrige uke med uka før, med litt luft.
    const dager = Object.keys(perDag).sort().slice(-21);
    const siste = {};
    for (const d of dager) siste[d] = { svar: perDag[d] || 0, nye: nyePerDag[d] || 0 };

    const spillere = tall(1);
    const duellLagt = tall(6);

    return svarMed({
      svar_totalt: tall(0),
      spillere_totalt: spillere,
      duell_startet: modus.duel || 0,
      duell_lagt_ut: duellLagt,
      duell_tatt: tall(7),
      duell_i_potten: tall(8),
      dagens_besvart: modus.daily || 0,
      // Tallet som avgjør om appen sprer seg av seg selv.
      k_faktor: spillere > 0 ? Math.round((duellLagt / spillere) * 100) / 100 : null,
      per_sprak: hash(2),
      per_modus: modus,
      siste_21_dager: siste,
      oppdatert: new Date().toISOString()
    }, 200, { "Cache-Control": "public, max-age=60" });
  } catch (e) {
    return svarMed({ feil: "utilgjengelig", grunn: diagnose(e) }, 503);
  }
}

export default async (request) => {
  // Uten database svarer vi pent i stedet for å feile — appen faller da
  // tilbake til den utregnede fordelingen helt av seg selv.
  if (!RAA_URL && !RAA_TOKEN) return svarMed({ feil: "ingen database satt opp" }, 503);
  if (!TOKEN) return svarMed({ feil: "utilgjengelig", grunn: diagnose() }, 503);

  const sti = new URL(request.url).pathname;
  if (sti.endsWith("/pulse")) {
    return request.method === "GET" ? puls() : svarMed({ feil: "kun GET" }, 405);
  }
  if (sti.endsWith("/duel")) return duell(request);
  return request.method === "POST" ? stem(request) : svarMed({ feil: "kun POST" }, 405);
};

export const config = {
  path: ["/api/vote", "/api/pulse", "/api/duel"]
};
