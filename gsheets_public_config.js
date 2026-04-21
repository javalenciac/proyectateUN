// Configuración PUBLICA (repo público) — envío a Google Sheets via Apps Script (PoW + no-cors)
//
// - enabled: activa/desactiva el envío en línea
// - endpoint: URL del Web App (termina en /exec)
// - powBits: dificultad del Proof-of-Work (16 recomendado; 18 más fuerte pero más lento)
//
// Importante: Apps Script Web App no entrega CORS headers; por eso el frontend usa fallback a fetch(..., {mode:"no-cors"}).

window.GSHEETS_PUBLIC = {
  enabled: true,
  endpoint: "REEMPLAZA_AQUI_TU_URL_EXEC",
  powBits: 16
};
