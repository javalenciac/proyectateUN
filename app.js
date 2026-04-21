(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- Estado global ----------
  let DATA = null;
  let STATE = {
    student: { name:"", school:"", phone:"", email:"" },
    asked: [],               // ids en orden
    answers: {},             // id -> {interest:boolean, area:string}
    stop_reason: "",
    finished: false,
    results: null,           // {topProfiles:[...], areaStats:[...]}
    ui: {
      pageIndex: 0,
      pageSize: 5,
      pageIds: []
    }
  };

  // ---------- Carga JSON robusta (root, con cache-buster) ----------
  async function fetchJsonTry(url){
    const res = await fetch(url, { cache:"no-store" });
    const txt = await res.text();
    // proteger: si devuelve HTML (404 pages)
    if (txt.trim().startsWith("<")) throw new Error("html_instead_of_json");
    return JSON.parse(txt);
  }

  async function autoLoadData(){
    // rutas posibles (root)
    const base = document.baseURI.replace(/#.*$/, "");
    const candidates = [
      new URL("./proyectate.json?v=" + Date.now(), base).toString(),
      new URL("./proyectate_con_cuoc_map_y_recomendador_v2.json?v=" + Date.now(), base).toString(),
      new URL("./proyectate_con_cuoc_map.json?v=" + Date.now(), base).toString(),
      new URL("./data.json?v=" + Date.now(), base).toString()
    ];

    let lastErr = "";
    for (const u of candidates){
      try{
        const d = await fetchJsonTry(u);
        return d;
      }catch(e){
        lastErr = String(e && e.message ? e.message : e);
      }
    }
    throw new Error(lastErr || "load_failed");
  }

  function show(el){ el.classList.remove("is-hidden"); }
  function hide(el){ el.classList.add("is-hidden"); }

  // ---------- UI navegación ----------
  function goIntro(){
    show($("screenIntro"));
    hide($("screenLoadFail"));
    hide($("screenStudent"));
    hide($("screenTest"));
    hide($("screenResults"));
  }

  function goStudent(){
    hide($("screenIntro"));
    hide($("screenLoadFail"));
    show($("screenStudent"));
    hide($("screenTest"));
    hide($("screenResults"));
    $("studentMsg").textContent = "";
  }

  function goTest(){
    hide($("screenIntro"));
    hide($("screenLoadFail"));
    hide($("screenStudent"));
    show($("screenTest"));
    hide($("screenResults"));
    $("testMsg").textContent = "";
  }

  function goResults(){
    hide($("screenIntro"));
    hide($("screenLoadFail"));
    hide($("screenStudent"));
    hide($("screenTest"));
    show($("screenResults"));
  }

  // ---------- Adaptativo ----------
  function getAreas(){
    return (DATA && DATA.test && DATA.test.areas) ? DATA.test.areas : [];
  }
  function getQuestions(){
    return (DATA && DATA.test && DATA.test.questions) ? DATA.test.questions : [];
  }

  function areaPosterior(areaCode){
    // Beta(1,1) prior
    let yes = 0, n = 0;
    for (const qid of STATE.asked){
      const a = STATE.answers[qid];
      if (!a) continue;
      if (a.area !== areaCode) continue;
      n++;
      if (a.interest) yes++;
    }
    const mean = (1 + yes) / (2 + n);
    return { area: areaCode, yes, n, mean };
  }

  function rankAreas(){
    const areas = getAreas().map(a => a.code);
    const stats = areas.map(areaPosterior);
    stats.sort((x,y) => y.mean - x.mean);
    return stats;
  }

  function isConfident(topStats){
    // margen sobre el tercero (si existe)
    if (topStats.length < 2) return false;
    const a = topStats[0], b = topStats[1];
    const c = topStats[2];
    const answered = STATE.asked.length;

    if (answered < 10) return false;

    const margin2 = c ? (b.mean - c.mean) : b.mean;
    const margin1 = c ? (a.mean - c.mean) : a.mean;

    return (margin1 >= 0.10 && margin2 >= 0.06);
  }

  function nextQuestionId(){
    const qs = getQuestions();
    const askedSet = new Set(STATE.asked);

    // balance inicial: 10 preguntas distribuidas
    if (STATE.asked.length < 10){
      const areas = getAreas().map(a => a.code);
      // elegir área por ciclo (0..4)
      const targetArea = areas[STATE.asked.length % Math.max(areas.length,1)];
      const candidate = qs.find(q => q.area === targetArea && !askedSet.has(q.id))
        || qs.find(q => !askedSet.has(q.id));
      return candidate ? candidate.id : null;
    }

    // Luego: enfocar en top2
    const ranked = rankAreas();
    const top2 = ranked.slice(0,2).map(x => x.area);

    // alternar por menor n
    const byN = ranked.filter(x => top2.includes(x.area)).sort((x,y)=> x.n - y.n);
    const targetArea = byN[0] ? byN[0].area : top2[0];

    let candidate = qs.find(q => q.area === targetArea && !askedSet.has(q.id));
    if (!candidate){
      const other = top2.find(a => a !== targetArea);
      candidate = qs.find(q => q.area === other && !askedSet.has(q.id));
    }
    if (!candidate){
      // fallback
      candidate = qs.find(q => !askedSet.has(q.id));
    }
    return candidate ? candidate.id : null;
  }

  function shouldStop(){
    const ranked = rankAreas();
    const answered = STATE.asked.length;

    if (answered >= 15 && isConfident(ranked)){
      STATE.stop_reason = "top2_confident";
      return true;
    }
    if (answered >= 35){
      STATE.stop_reason = "max_questions";
      return true;
    }
    if (answered >= getQuestions().length){
      STATE.stop_reason = "no_more_questions";
      return true;
    }
    return false;
  }

  function computeResults(){
    const ranked = rankAreas();
    const areasMap = new Map(getAreas().map(a => [a.code, a.name]));

    const topProfiles = ranked.slice(0,2).map((x, idx) => ({
      code: x.area,
      name: areasMap.get(x.area) || x.area,
      score: Number((x.mean * 100).toFixed(1))
    }));

    return {
      topProfiles,
      areaStats: ranked.map(x => ({
        code: x.area,
        name: areasMap.get(x.area) || x.area,
        yes: x.yes,
        n: x.n,
        score: Number((x.mean * 100).toFixed(1))
      }))
    };
  }

  // ---------- Render test por páginas ----------
  function ensurePageIds(){
    // construir lista lineal en asked order; si aún no hay suficientes, "pre-ask" para llenar páginas
    while (!STATE.finished){
      const needed = (STATE.ui.pageIndex + 1) * STATE.ui.pageSize;
      if (STATE.asked.length >= needed) break;

      const id = nextQuestionId();
      if (!id) break;

      STATE.asked.push(id);
      // placeholder answer until user responds
      if (!STATE.answers[id]){
        const q = getQuestions().find(x => x.id === id);
        STATE.answers[id] = { interest: null, area: q ? q.area : "" };
      }
      if (shouldStop()){
        // aun se requiere responder lo que esté en pantalla para terminar, pero marcamos finished al completar
        break;
      }
    }
  }

  function getPageQuestionIds(){
    ensurePageIds();
    const start = STATE.ui.pageIndex * STATE.ui.pageSize;
    const end = start + STATE.ui.pageSize;
    return STATE.asked.slice(start, end);
  }

  function renderTestPage(){
    const wrap = $("qBlock");
    wrap.innerHTML = "";

    const ids = getPageQuestionIds();
    if (!ids.length){
      $("testMsg").textContent = "No hay preguntas disponibles.";
      return;
    }

    const qs = getQuestions();
    for (const id of ids){
      const q = qs.find(x => x.id === id);
      if (!q) continue;

      const ans = STATE.answers[id] || { interest: null, area: q.area };

      const item = document.createElement("div");
      item.className = "qitem";

      const row = document.createElement("div");
      row.className = "qitem__row";

      const txt = document.createElement("div");
      txt.className = "qitem__text";
      txt.textContent = q.text;

      const btns = document.createElement("div");
      btns.className = "qitem__btns";

      const yesBtn = document.createElement("button");
      yesBtn.className = "qbtn qbtn--yes";
      yesBtn.textContent = "Me interesa";
      const noBtn = document.createElement("button");
      noBtn.className = "qbtn qbtn--no";
      noBtn.textContent = "No me interesa";

      // estado visual
      if (ans.interest === true){
        yesBtn.style.fontWeight = "700";
      } else if (ans.interest === false){
        noBtn.style.fontWeight = "700";
      }

      yesBtn.addEventListener("click", () => {
        STATE.answers[id] = { interest:true, area:q.area };
        renderTestPage();
      });
      noBtn.addEventListener("click", () => {
        STATE.answers[id] = { interest:false, area:q.area };
        renderTestPage();
      });

      btns.appendChild(yesBtn);
      btns.appendChild(noBtn);

      row.appendChild(txt);
      row.appendChild(btns);
      item.appendChild(row);

      wrap.appendChild(item);
    }

    // botones
    $("btnPrev").disabled = (STATE.ui.pageIndex === 0);
    $("btnNext").textContent = isLastPage() ? "Finalizar" : "Siguiente";
  }

  function currentPageAnswered(){
    const ids = getPageQuestionIds();
    return ids.every(id => STATE.answers[id] && (STATE.answers[id].interest === true || STATE.answers[id].interest === false));
  }

  function isLastPage(){
    // una página es última si: al completar esa página se debe detener
    // aproximación: si ya stop_reason definido y estamos en última página de asked
    const answered = STATE.asked.length;
    const end = (STATE.ui.pageIndex + 1) * STATE.ui.pageSize;
    // si al llegar al final de esta pagina y se cumple shouldStop() con los respondidos, es fin.
    // aquí: si ya se definió stop_reason y no hay más ids pre-cargados después.
    if (STATE.stop_reason && end >= answered) return true;
    // o si ya no hay más preguntas
    return false;
  }

  function advance(){
    if (!currentPageAnswered()){
      $("testMsg").textContent = "Responde todas las preguntas de esta página para continuar.";
      return;
    }
    $("testMsg").textContent = "";

    // si estamos en última página, terminamos
    // aplicar regla de stop (ya con respuestas)
    if (shouldStop()){
      STATE.finished = true;
      finish();
      return;
    }

    STATE.ui.pageIndex++;
    renderTestPage();
  }

  function back(){
    if (STATE.ui.pageIndex > 0){
      STATE.ui.pageIndex--;
      renderTestPage();
    }
  }

  // ---------- Resultados + ocupaciones ----------
  function renderResults(){
    const res = STATE.results;
    const badges = $("profilesBadges");
    badges.innerHTML = "";

    for (const p of res.topProfiles){
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = `${p.name} — ${p.score}%`;
      badges.appendChild(b);
    }

    // cargar selects
    const cuocAreas = (DATA && DATA.cuoc && DATA.cuoc.areas) ? DATA.cuoc.areas : [];
    const sel = $("selCuocArea");
    sel.innerHTML = "";
    sel.appendChild(new Option("Selecciona…", ""));
    for (const a of cuocAreas){
      sel.appendChild(new Option(`${a.sigla} — ${a.name}`, a.sigla));
    }

    $("occWrap").classList.add("is-hidden");
    $("recordStatus").textContent = "";
  }

  function getOccupationMatches(){
    const occs = (DATA && DATA.cuoc && DATA.cuoc.occupations) ? DATA.cuoc.occupations : [];
    const top = new Set(STATE.results.topProfiles.map(p => p.code));

    // Heurística: ocupa "profile" == código de área del test
    let filtered = occs.filter(o => top.has(o.profile));

    const selSigla = $("selCuocArea").value;
    const selLevel = $("selLevel").value;

    if (selSigla){
      filtered = filtered.filter(o => o.cuocAreaSigla === selSigla);
    }
    if (selLevel !== "all"){
      filtered = filtered.filter(o => String(o.competenceLevel) === selLevel);
    }

    // ordenar por nivel de competencia 1..4
    filtered.sort((a,b) => (a.competenceLevel - b.competenceLevel) || a.occupation.localeCompare(b.occupation));
    return filtered;
  }

  function renderOccupations(){
    const list = $("occList");
    list.innerHTML = "";

    const selSigla = $("selCuocArea").value;
    if (!selSigla){
      alert("Selecciona un Área de cualificación principal (CUOC).");
      return;
    }

    const occs = getOccupationMatches();
    if (!occs.length){
      list.innerHTML = `<p class="muted">No hay ocupaciones para ese filtro.</p>`;
      return;
    }

    // Agrupar por nivel 1..4
    const groups = new Map();
    for (const o of occs){
      const k = String(o.competenceLevel || "");
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const order = ["1","2","3","4"].filter(k => groups.has(k));

    for (const level of order){
      const header = document.createElement("div");
      header.className = "panel";
      header.style.marginTop = "10px";
      header.innerHTML = `<strong>Nivel ${level}</strong>`;
      list.appendChild(header);

      for (const o of groups.get(level)){
        const card = document.createElement("div");
        card.className = "panel";
        card.style.marginTop = "10px";

        const head = document.createElement("div");
        head.innerHTML = `<strong>${o.code} — ${escapeHtml(o.occupation)}</strong><div class="muted">${escapeHtml(o.cuocAreaSigla)} — ${escapeHtml(o.cuocAreaName || "")}</div>`;

        const details = document.createElement("details");
        const sum = document.createElement("summary");
        sum.textContent = "Ver detalles";
        details.appendChild(sum);

        const body = document.createElement("div");
        body.style.marginTop = "10px";
        body.innerHTML = `
          <p><span class="muted">Perfil:</span> ${escapeHtml(profileName(o.profile))}</p>
          <p><span class="muted">Funciones:</span><br>${listLines(o.functions)}</p>
          <p><span class="muted">Conocimientos:</span><br>${listLines(o.knowledge)}</p>
          <p><span class="muted">Destrezas:</span><br>${listLines(o.skills)}</p>
          <p><span class="muted">Ocupaciones afines:</span> ${escapeHtml((o.related||[]).join(", "))}</p>
        `;
        details.appendChild(body);

        card.appendChild(head);
        card.appendChild(details);
        list.appendChild(card);
      }
    }
  }

  function profileName(code){
    const a = getAreas().find(x => x.code === code);
    return a ? a.name : code;
  }

  function listLines(arr){
    if (!arr || !arr.length) return "<span class='muted'>—</span>";
    return arr.map(x => `• ${escapeHtml(String(x))}`).join("<br>");
  }

  function escapeHtml(s){
    return String(s)
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;");
  }

  // ---------- Registro + envío ----------
  function buildRecord(){
    const now = new Date().toISOString();
    return {
      _ts: now,
      student: { ...STATE.student },
      answers_count: Object.values(STATE.answers).filter(a => a && (a.interest === true || a.interest === false)).length,
      stop_reason: STATE.stop_reason || "",
      answers: STATE.asked.map(id => ({
        id,
        area: STATE.answers[id] ? STATE.answers[id].area : "",
        interest: STATE.answers[id] ? STATE.answers[id].interest : null
      })),
      results: STATE.results
    };
  }

  function autoSend(record){
    // envío automático (si está configurado). Si falla, el usuario puede reintentar con ENVIAR.
    if (typeof sendRecordToGoogleSheet !== "function") return;
    sendRecordToGoogleSheet(record).then(r => {
      const st = $("recordStatus");
      if (!st) return;
      if (r && r.ok){
        st.textContent = "Enviado ✅";
      } else {
        const msg = (r && (r.error || r.msg)) ? (r.error || r.msg) : "Pendiente";
        st.textContent = "Envío pendiente: " + msg;
      }
    });
  }

  function finish(){
    STATE.results = computeResults();
    goResults();
    renderResults();

    const record = buildRecord();
    autoSend(record);
  }

  // ---------- PDF ----------
  function downloadPdf(){
    document.body.classList.add("pdf-mode");
    // imprimir
    setTimeout(() => {
      window.print();
      setTimeout(() => document.body.classList.remove("pdf-mode"), 400);
    }, 80);
  }

  // ---------- Eventos ----------
  function bind(){
    $("btnStart").addEventListener("click", async () => {
      $("btnStart").disabled = true;

      try{
        DATA = await autoLoadData();
        goStudent();
      }catch(e){
        // mostrar carga manual
        hide($("screenIntro"));
        show($("screenLoadFail"));
        $("loadMsg").textContent = "No se encontró el JSON en el root. Cárgalo manualmente.";
      } finally {
        $("btnStart").disabled = false;
      }
    });

    $("btnLoadFile").addEventListener("click", () => {
      const f = $("fileInput").files && $("fileInput").files[0];
      if (!f){
        $("loadMsg").textContent = "Selecciona un archivo JSON.";
        return;
      }
      const r = new FileReader();
      r.onload = () => {
        try{
          DATA = JSON.parse(String(r.result || ""));
          $("loadMsg").textContent = "Cargado ✅";
          goStudent();
        }catch(err){
          $("loadMsg").textContent = "JSON inválido.";
        }
      };
      r.readAsText(f, "utf-8");
    });

    $("btnStartTest").addEventListener("click", () => {
      const name = $("inName").value.trim();
      const school = $("inSchool").value.trim();

      if (!name || !school){
        $("studentMsg").textContent = "Completa nombre e institución educativa.";
        return;
      }
      STATE.student = {
        name,
        school,
        phone: $("inPhone").value.trim(),
        email: $("inEmail").value.trim()
      };

      // reset test state
      STATE.asked = [];
      STATE.answers = {};
      STATE.stop_reason = "";
      STATE.finished = false;
      STATE.results = null;
      STATE.ui.pageIndex = 0;

      goTest();
      renderTestPage();
    });

    $("btnPrev").addEventListener("click", back);
    $("btnNext").addEventListener("click", advance);

    $("btnShowOcc").addEventListener("click", () => {
      $("occWrap").classList.remove("is-hidden");
      renderOccupations();
    });

    $("btnPdf").addEventListener("click", downloadPdf);

    $("btnSendSheets").addEventListener("click", () => {
      const record = buildRecord();
      const st = $("recordStatus");
      if (st) st.textContent = "Enviando…";
      if (typeof sendRecordToGoogleSheet !== "function"){
        if (st) st.textContent = "No disponible.";
        return;
      }
      sendRecordToGoogleSheet(record).then(r => {
        if (!st) return;
        if (r && r.ok) st.textContent = "Enviado ✅";
        else st.textContent = "Envío pendiente.";
      });
    });
  }

  // ---------- Init ----------
  window.addEventListener("DOMContentLoaded", () => {
    goIntro();
    bind();
  });
})();
