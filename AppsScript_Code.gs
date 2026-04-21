/***** Proyéctate → Google Sheets (Apps Script Web App)
 - Anti-spam SIN proveedores externos:
   - Proof-of-Work (PoW) (FNV-1a 32-bit)
   - Challenge generado por el cliente y marcado como usado (CacheService) para evitar replays
****************************************************/

/***** CONFIG *****/
const SPREADSHEET_ID = "1SO314qTqpkCiDtIKV8GZoZA76p0B7rIZGx3QS86U6cw";
const SHEET_NAME = "Registros";

const POW_BITS_DEFAULT = 16;

// Exportación privada (opcional) para descargar JSON desde Apps Script
const ADMIN_EXPORT_KEY = "CAMBIA_ESTA_LLAVE_LARGA_Y_ALEATORIA";

// Evita re-uso del mismo challenge (segundos)
const USED_CHALLENGE_TTL = 600;

/***** RESPUESTA JSON (Apps Script no soporta setHeader en ContentService) *****/
function jsonOut_(obj) {
  const out = ContentService.createTextOutput(JSON.stringify(obj));
  out.setMimeType(ContentService.MimeType.JSON);
  return out;
}

function getSheet_() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);

  if (sh.getLastRow() === 0) {
    sh.appendRow([
      "server_timestamp",
      "student_name",
      "school",
      "phone",
      "email",
      "answers_count",
      "stop_reason",
      "top_profile_1_code", "top_profile_1_name", "top_profile_1_score",
      "top_profile_2_code", "top_profile_2_name", "top_profile_2_score",
      "raw_record_json"
    ]);
  }
  return sh;
}

function safeStr_(v) { return (v === null || v === undefined) ? "" : String(v); }
function safeNum_(v) { const n = Number(v); return Number.isFinite(n) ? n : ""; }

/***** PoW (FNV-1a 32-bit) *****/
function fnv1a32_(str) {
  var h = 0x811c9dc5;
  for (var i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24))) >>> 0;
  }
  return h >>> 0;
}

function hasLeadingZeroBits_(hash32, bits) {
  if (bits <= 0) return true;
  if (bits >= 32) return hash32 === 0;
  return (hash32 >>> (32 - bits)) === 0;
}

function verifyPow_(challenge, nonce, bits) {
  const h = fnv1a32_(challenge + "|" + String(nonce));
  return hasLeadingZeroBits_(h, bits);
}

function consumeClientChallenge_(challenge) {
  const cache = CacheService.getScriptCache();
  const key = "used:" + challenge;
  const v = cache.get(key);
  if (v) return false;
  cache.put(key, "1", USED_CHALLENGE_TTL);
  return true;
}

/***** ENDPOINTS *****/
function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) ? e.parameter.action : "health";

  if (action === "export") {
    const key = (e && e.parameter && e.parameter.adminKey) ? e.parameter.adminKey : "";
    if (key !== ADMIN_EXPORT_KEY) return jsonOut_({ ok:false, error:"Unauthorized" });

    const sh = getSheet_();
    const values = sh.getDataRange().getValues();
    const payloadColIndex = values[0].indexOf("raw_record_json");
    const out = [];

    for (let i = 1; i < values.length; i++) {
      const raw = values[i][payloadColIndex];
      try { out.push(JSON.parse(raw)); } catch(err) {}
    }
    return jsonOut_({ ok:true, count: out.length, records: out });
  }

  return jsonOut_({ ok:true, msg:"Proyectate logger online (PoW no-CORS)" });
}

function doOptions(e) {
  return jsonOut_({ ok:true });
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonOut_({ ok:false, error:"No payload" });
    }

    let payload;
    try { payload = JSON.parse(e.postData.contents); }
    catch (err) { return jsonOut_({ ok:false, error:"Invalid JSON" }); }

    // Honeypot: bots suelen llenar campos ocultos
    if (payload.hp && String(payload.hp).trim() !== "") {
      return jsonOut_({ ok:false, error:"Bot detected" });
    }

    const challenge = payload.challenge;
    const nonce = payload.nonce;
    const bitsRaw = Number(payload.powBits);
    const bits = (Number.isFinite(bitsRaw) ? bitsRaw : POW_BITS_DEFAULT);
    const record = payload.record;

    if (!challenge || nonce === undefined || nonce === null) {
      return jsonOut_({ ok:false, error:"Missing PoW fields" });
    }

    if (String(challenge).length > 80) {
      return jsonOut_({ ok:false, error:"Challenge too long" });
    }
    if (bits < 10 || bits > 22) {
      return jsonOut_({ ok:false, error:"Invalid powBits" });
    }

    if (!consumeClientChallenge_(String(challenge))) {
      return jsonOut_({ ok:false, error:"Challenge already used" });
    }

    if (!verifyPow_(String(challenge), nonce, bits)) {
      return jsonOut_({ ok:false, error:"Invalid PoW" });
    }

    if (!record || !record.student || !record.results) {
      return jsonOut_({ ok:false, error:"Malformed record" });
    }

    const student = record.student || {};
    if (!student.name || !student.school) {
      return jsonOut_({ ok:false, error:"Missing student fields" });
    }

    const results = record.results || {};
    const topProfiles = (results.topProfiles || []);
    const p1 = topProfiles[0] || {};
    const p2 = topProfiles[1] || {};

    const sh = getSheet_();
    sh.appendRow([
      new Date().toISOString(),
      safeStr_(student.name),
      safeStr_(student.school),
      safeStr_(student.phone),
      safeStr_(student.email),
      safeNum_(record.answers_count),
      safeStr_(record.stop_reason),
      safeStr_(p1.code), safeStr_(p1.name), safeNum_(p1.score),
      safeStr_(p2.code), safeStr_(p2.name), safeNum_(p2.score),
      JSON.stringify(record)
    ]);

    return jsonOut_({ ok:true });
  } finally {
    lock.releaseLock();
  }
}
