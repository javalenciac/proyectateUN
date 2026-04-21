// Envío de registros a Google Sheets via Google Apps Script Web App
// Anti-spam SIN proveedores externos:
// - Proof-of-Work (PoW) en el cliente (FNV-1a 32-bit)
// - "Challenge" generado por el cliente (timestamp + random) y marcado como usado en el servidor (CacheService)
// - Fallback a mode:"no-cors" para que funcione en GitHub Pages

function getGSheetsPublic(){
  const c = window.GSHEETS_PUBLIC || {};
  return {
    enabled: !!c.enabled,
    endpoint: String(c.endpoint || "").trim(),
    powBits: Number.isFinite(Number(c.powBits)) ? Number(c.powBits) : 16,
  };
}

function fnv1a32(str){
  let h = 0x811c9dc5;
  for (let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = (h + ((h<<1) + (h<<4) + (h<<7) + (h<<8) + (h<<24))) >>> 0;
  }
  return h >>> 0;
}

function hasLeadingZeroBits(hash32, bits){
  if (bits <= 0) return true;
  if (bits >= 32) return hash32 === 0;
  return (hash32 >>> (32 - bits)) === 0;
}

function makeClientChallenge(){
  const rnd = Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2);
  return String(Date.now()) + "-" + rnd.slice(0, 24);
}

// PoW con chunks para no congelar UI
async function solvePow(challenge, bits, onProgress){
  const start = Date.now();
  let nonce = 0;
  const chunk = 8000;

  while (true){
    for (let i=0;i<chunk;i++){
      const candidate = nonce++;
      const h = fnv1a32(challenge + "|" + candidate);
      if (hasLeadingZeroBits(h, bits)){
        const ms = Date.now() - start;
        return { nonce: candidate, powHash: h, ms };
      }
    }
    if (typeof onProgress === "function"){
      onProgress({ tried: nonce, seconds: (Date.now()-start)/1000 });
    }
    await new Promise(r => setTimeout(r, 0));
  }
}

async function postPayload(endpoint, payload, useNoCors){
  const opts = {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(payload),
  };
  if (useNoCors) opts.mode = "no-cors";
  return fetch(endpoint, opts);
}

// API principal: devuelve {ok:true} si se envió (aunque la respuesta sea opaca por CORS)
async function sendRecordToGoogleSheet(record){
  const cfg = getGSheetsPublic();
  if (!cfg.enabled) return { ok:false, msg:"Envío desactivado" };
  if (!cfg.endpoint || cfg.endpoint.includes("REEMPLAZA_AQUI")) return { ok:false, msg:"Configura el endpoint en gsheets_public_config.js." };

  const statusEl = document.getElementById("recordStatus");
  try{
    const bits = Math.max(10, Math.min(22, cfg.powBits));
    const challenge = makeClientChallenge();

    if (statusEl) statusEl.textContent = "Preparando envío…";
    const sol = await solvePow(challenge, bits, (p) => {
      if (statusEl) statusEl.textContent = `Preparando envío… intentos: ${p.tried}`;
    });

    if (statusEl) statusEl.textContent = "Enviando…";

    const payload = {
      challenge,
      nonce: sol.nonce,
      powBits: bits,
      hp: "", // honeypot (debe ir vacío)
      record
    };

    // 1) intento normal (puede fallar por CORS)
    try{
      const res = await postPayload(cfg.endpoint, payload, false);
      const text = await res.text().catch(()=> "");
      try{
        const data = JSON.parse(text);
        if (data && data.ok === false) return { ok:false, error: data.error || data.msg || "Error servidor", detail: data };
        return data || { ok: res.ok };
      }catch(e){
        return { ok: res.ok, msg: res.ok ? "Enviado" : ("HTTP " + res.status) };
      }
    }catch(e){
      // 2) fallback no-cors: request se envía, respuesta opaca
      await postPayload(cfg.endpoint, payload, true);
      return { ok:true, msg:"Enviado" };
    }
  }catch(e){
    return { ok:false, msg:"No se pudo preparar/enviar." };
  }
}
