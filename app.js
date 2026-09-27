(function () {
  "use strict";
  const CFG = window.LAVADERO_CONFIG || {};
  const TZ = "America/Bogota";
  const VEHICULOS = ["Carro", "Camioneta", "Moto", "Buseta/Van", "Otro"];
  const PAGOS = ["Efectivo", "Nequi", "Daviplata", "Transferencia"];
  const GASTOS = ["Jabón/insumos", "Almuerzo", "Agua/luz", "Pago trabajador", "Otro"];
  const APP_VERSION = "2026-09-27 11:14";
  const REFRESCO_MS = 20000;
  const ERRORES = {
    x_pin: "PIN incorrecto.",
    x_bloqueado: "Demasiados intentos. Espera 10 minutos.",
    SOLO_DUENO: "Solo el dueño puede hacer eso.",
    NO_PERMITIDO: "Solo puedes cambiar o borrar tus registros de los últimos 15 minutos. Pídeselo al dueño.",
    NO_EXISTE: "Ese registro ya no existe.",
    VALOR_INVALIDO: "Escribe un valor mayor a cero.",
    PIN_4_A_6_DIGITOS: "El PIN debe tener entre 4 y 6 dígitos.",
    PIN_REPETIDO: "Ese PIN ya lo usa la otra persona. Elige otro.",
    RED: "Sin conexión. Revisa los datos o el wifi e intenta de nuevo."
  };

  const fmt = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  const money = n => fmt.format(Math.round(n || 0)).replace(/ /g, " ");
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const todayStr = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
  function shiftDate(s, d) { const [y, m, dd] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd + d)).toISOString().slice(0, 10); }
  function prettyDate(s, opts) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString("es-CO",
      Object.assign({ timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }, opts || {}));
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) {} }
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 2600); }
  function banner(msg) { const b = $("banner"); b.textContent = msg || ""; b.hidden = !msg; }

  // ---------- API ----------
  class ApiError extends Error { constructor(code) { super(ERRORES[code] || code); this.code = code; } }
  async function rpc(fn, body) {
    let res;
    try {
      res = await fetch(`${CFG.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_KEY },
        body: JSON.stringify(body)
      });
    } catch (e) { throw new ApiError("RED"); }
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError((data && (data.message || data.hint)) || ("HTTP " + res.status));
    if (data && data.error) {
      if (data.error === "x_pin" && S.rol && fn !== "entrar") salir(true);
      throw new ApiError(data.error);
    }
    return data;
  }

  // ---------- Estado ----------
  const S = {
    pin: lsGet("lav_pin"), rol: null, hoy: todayStr(), fecha: todayStr(),
    registros: [], cfg: { nombre: "", servicios: [] }, dias: [],
    mode: "venta", svc: null, veh: "Carro", pago: "Efectivo", gastoTag: null, edit: null, tab: "dia"
  };
  const esDueno = () => S.rol === "dueno";

  // ---------- Login ----------
  let pinBuf = "";
  function drawDots() { $("dots").innerHTML = Array.from({ length: Math.max(4, pinBuf.length) }, (_, i) => `<i class="${i < pinBuf.length ? "on" : ""}"></i>`).join(""); }
  function drawPad() {
    const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "OK"];
    $("pad").innerHTML = keys.map(k => k ? `<button type="button" data-k="${k}" class="${k === "⌫" ? "muted" : k === "OK" ? "ok" : ""}" aria-label="${k === "⌫" ? "Borrar" : k === "OK" ? "Entrar" : k}">${k === "OK" ? "Entrar" : k}</button>` : "<span></span>").join("");
    $("pad").querySelectorAll("button").forEach(b => b.addEventListener("click", () => tecla(b.dataset.k)));
  }
  function tecla(k) {
    if (k === "OK") {
      if (pinBuf.length >= 4) entrar(pinBuf); else $("loginErr").textContent = "El PIN tiene de 4 a 6 dígitos.";
      return;
    }
    if (k === "⌫") pinBuf = pinBuf.slice(0, -1);
    else if (pinBuf.length < 6) pinBuf += k;
    $("loginErr").textContent = "";
    drawDots();
    if (pinBuf.length === 6) entrar(pinBuf);
  }
  document.addEventListener("keydown", e => {
    if ($("login").hidden) return;
    if (/^\d$/.test(e.key)) tecla(e.key); else if (e.key === "Backspace") tecla("⌫"); else if (e.key === "Enter") tecla("OK");
  });

  async function entrar(pin) {
    try {
      const r = await rpc("entrar", { p_pin: pin });
      S.pin = pin; S.rol = r.rol; S.hoy = r.hoy; S.fecha = r.hoy;
      S.cfg = normCfg(r.config);
      lsSet("lav_pin", pin);
      mostrarApp();
    } catch (e) {
      pinBuf = ""; drawDots();
      if (e.code === "x_pin") { S.pin = null; lsSet("lav_pin", null); }
      $("loginErr").textContent = e.message;
      if (e.code === "RED" && S.pin && S.rol) mostrarApp();
    }
  }
  function mostrarLogin() {
    $("app").hidden = true; $("login").hidden = false;
    pinBuf = ""; drawDots(); drawPad();
    $("loginName").textContent = lsGet("lav_nombre") || "Caja del Lavadero";
  }
  function salir(silencioso) {
    S.pin = null; S.rol = null; lsSet("lav_pin", null);
    clearInterval(timer);
    mostrarLogin();
    if (silencioso) $("loginErr").textContent = "Tu PIN cambió. Escribe el nuevo.";
  }
  $("salir").addEventListener("click", () => salir(false));

  // ---------- App shell ----------
  let timer = null;
  function mostrarApp() {
    $("login").hidden = true; $("app").hidden = false;
    document.querySelectorAll(".solo-dueno").forEach(el => (el.hidden = !esDueno()));
    $("tabs").hidden = !esDueno();
    $("whoRol").textContent = esDueno() ? "Dueño" : "Trabajador";
    $("fecha").value = S.fecha;
    setTab(esDueno() ? (lsGet("lav_tab") || "dia") : "dia");
    renderBrand(); renderForm(); renderDia();
    cargarDia();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refrescar(); }, REFRESCO_MS);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.rol) refrescar(); });
  function refrescar() { cargarDia(true); if (S.tab === "hist") cargarHist(); }

  function setTab(t) {
    S.tab = t;
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    $("view-dia").hidden = t !== "dia"; $("view-hist").hidden = t !== "hist"; $("view-aj").hidden = t !== "aj";
    lsSet("lav_tab", t);
    if (t === "hist") cargarHist();
    if (t === "aj") renderCfgEditor();
  }
  document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

  function normCfg(c) { c = c || {}; return { nombre: c.nombre || "", servicios: Array.isArray(c.servicios) ? c.servicios : [] }; }
  function renderBrand() {
    $("brandName").textContent = S.cfg.nombre || "Lavadero";
    if (S.cfg.nombre) lsSet("lav_nombre", S.cfg.nombre);
  }

  // ---------- Día ----------
  let cargando = 0;
  async function cargarDia(silencioso) {
    const f = S.fecha, my = ++cargando;
    if (!silencioso) $("syncState").textContent = "Cargando…";
    try {
      const r = await rpc("ver_dia", { p_pin: S.pin, p_fecha: f });
      if (my !== cargando) return;
      S.registros = r.registros || []; S.hoy = r.hoy;
      if (!esDueno()) S.fecha = r.fecha;
      const nuevoCfg = normCfg(r.config);
      if (JSON.stringify(nuevoCfg) !== JSON.stringify(S.cfg)) { S.cfg = nuevoCfg; renderBrand(); renderForm(); }
      banner("");
      $("syncState").textContent = "Actualizado " + new Date().toLocaleTimeString("es-CO", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      if (S.edit && silencioso) return; // no interrumpir mientras se edita
      renderDia();
    } catch (e) {
      if (my !== cargando) return;
      $("syncState").textContent = "Sin conexión";
      if (!silencioso) banner(e.message);
    }
  }

  function totals(regs) {
    let total = 0, carros = 0, motos = 0, efectivo = 0, transf = 0, prest = 0;
    (regs || []).forEach(r => {
      if (r.tipo === "gasto") { prest += r.valor || 0; return; }
      const v = r.valor || 0;
      total += v;
      if (r.vehiculo === "Moto") motos++; else carros++;
      if (r.pago === "Transferencia") transf += v; else efectivo += v;
    });
    return { total, carros, motos, efectivo, transf, prest };
  }

  // ---------- Reparto mitad y mitad ----------
  // Ajustes guardados dentro de config.servicios como {tipo:"ajuste", transf:"dueno"|"trabajador"}
  function ajustes() { return (S.cfg.servicios || []).find(x => x && x.tipo === "ajuste") || {}; }
  function transfDestino() { return ajustes().transf === "trabajador" ? "trabajador" : "dueno"; }
  function calcReparto(t) {
    const mitad = t.total / 2;
    const paraDueno = mitad + t.prest;               // su mitad + lo que se le descuenta al trabajador
    const dest = transfDestino();
    const entregar = dest === "dueno" ? paraDueno - t.transf : paraDueno;
    return { mitad, paraDueno, entregar, dest };
  }
  function renderReparto(t) {
    const r = calcReparto(t);
    $("rDueno").textContent = money(r.mitad);
    $("rTrab").textContent = money(r.mitad);
    $("rPrestRow").hidden = $("rPrestRow2").hidden = !t.prest;
    $("rPrest").textContent = "−" + money(t.prest);
    $("rTrabNeto").textContent = money(r.mitad - t.prest);
    const muestraTransf = r.dest === "dueno" && t.transf > 0;
    $("rTransfRow").hidden = !muestraTransf;
    $("rTransf").textContent = "−" + money(t.transf);
    $("rTransfLbl").textContent = esDueno() ? "Transferencias que ya te llegaron" : "Transferencias que ya le llegaron al dueño";
    const debe = Math.round(r.entregar);
    if (debe >= 0) {
      $("rDebeLbl").textContent = esDueno() ? "El trabajador te debe entregar" : "Le debes entregar al dueño";
      $("rDebe").textContent = money(debe);
      $("rDebe").className = "";
    } else {
      $("rDebeLbl").textContent = esDueno() ? "Tú le debes al trabajador" : "El dueño te debe";
      $("rDebe").textContent = money(-debe);
      $("rDebe").className = "neg";
    }
    $("rNota").textContent = r.dest === "dueno"
      ? "Las transferencias ya están en la cuenta del dueño, por eso se restan."
      : "Las transferencias llegan a la cuenta del trabajador, así que entrega la parte del dueño en efectivo o por transferencia.";
  }

  function puedeBorrar(r) {
    if (esDueno()) return true;
    return r.rol === "trabajador" && (Date.now() - new Date(r.creado).getTime()) < 15 * 60 * 1000;
  }

  function renderDia() {
    const regs = S.registros;
    const t = totals(regs);
    const esHoy = S.fecha === S.hoy;
    $("ticketFecha").textContent = (esHoy ? "Hoy · " : "") + prettyDate(S.fecha);
    $("totVentas").textContent = money(t.total);
    $("totCarros").textContent = t.carros;
    $("totMotos").textContent = t.motos;
    $("totEfectivo").textContent = money(t.efectivo);
    $("totTransf").textContent = money(t.transf);
    renderReparto(t);
    const nLav = t.carros + t.motos;
    $("listSub").textContent = regs.length ? `${nLav} ${nLav === 1 ? "lavado" : "lavados"}${t.prest ? " · préstamos" : ""} · más reciente arriba` : "";
    $("form").hidden = esDueno() && S.fecha > S.hoy;
    const box = $("items");
    if (!regs.length) {
      box.innerHTML = `<div class="empty">${esHoy ? "Todavía no hay lavados hoy." : "No hay registros este día."}</div>`;
      return;
    }
    box.innerHTML = regs.map(r => {
      const g = r.tipo === "gasto";
      const tr = r.pago === "Transferencia";
      const what = g
        ? `<b>Préstamo al trabajador</b><span>${esc(r.nota || "")}</span>`
        : `<b>${esc(r.vehiculo || "Carro")}</b><span>${tr ? '<span class="tag tr">Transferencia</span>' : '<span class="tag">Efectivo</span>'}</span>`;
      const editando = S.edit && S.edit.id === r.id;
      return `<div class="item ${g ? "gasto" : ""} ${editando ? "editing" : ""}">
        <div class="hora num">${esc(r.hora || "")}</div>
        <div class="what">${what}</div>
        <div><div class="val num">${g ? "−" : ""}${money(r.valor)}</div>
          ${puedeBorrar(r) && !editando ? `<button class="edit-btn" data-act="open" data-id="${esc(r.id)}">Editar</button>` : ""}
        </div></div>${editando ? editorHtml(r) : ""}`;
    }).join("");
  }

  function editorHtml(r) {
    const e = S.edit, g = r.tipo === "gasto";
    const btn = (attr, val, cur, label) => `<button type="button" class="opt" data-${attr}="${val}" aria-pressed="${val === cur}">${label}</button>`;
    return `<div class="editor">
      ${g ? "" : `<div class="opts">${btn("ev", "Carro", e.vehiculo, "Carro")}${btn("ev", "Moto", e.vehiculo, "Moto")}</div>`}
      <label class="field"><span>Valor</span><input id="edValor" class="money num" inputmode="numeric" value="${money(e.valor)}"></label>
      ${g ? `<label class="field"><span>Motivo</span><input id="edNota" maxlength="80" value="${esc(e.nota || "")}"></label>`
          : `<div class="opts">${btn("ep", "Efectivo", e.pago, "Efectivo")}${btn("ep", "Transferencia", e.pago, "Transferencia")}</div>`}
      <div class="edit-actions">
        <button type="button" class="primary" data-act="save">Guardar</button>
        <button type="button" class="danger-o ${e.armed ? "arm" : ""}" data-act="del">${e.armed ? "¿Seguro? Toca otra vez" : "Borrar registro"}</button>
        <button type="button" class="linkbtn" data-act="cancel">Cancelar</button>
      </div>
      <div class="hint" id="edHint"></div>
    </div>`;
  }

  // Un solo manejador para toda la lista
  $("items").addEventListener("click", async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    if (b.dataset.act === "open") {
      const r = S.registros.find(x => x.id === b.dataset.id); if (!r) return;
      S.edit = { id: r.id, vehiculo: r.vehiculo || "Carro", pago: r.pago || "Efectivo", valor: r.valor, nota: r.nota || "", armed: false };
      renderDia();
      const el = document.querySelector(".editor"); if (el) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    if (!S.edit) return;
    leerEditor();
    if (b.dataset.ev) { S.edit.vehiculo = b.dataset.ev; renderDia(); return; }
    if (b.dataset.ep) { S.edit.pago = b.dataset.ep; renderDia(); return; }
    if (b.dataset.act === "cancel") { S.edit = null; renderDia(); return; }
    if (b.dataset.act === "del") {
      if (!S.edit.armed) { S.edit.armed = true; renderDia(); return; }
      b.disabled = true;
      try { await rpc("borrar", { p_pin: S.pin, p_id: S.edit.id }); S.edit = null; toast("Registro borrado"); await cargarDia(true); }
      catch (e) { $("edHint").textContent = e.message; b.disabled = false; }
      return;
    }
    if (b.dataset.act === "save") {
      if (!S.edit.valor) { $("edHint").textContent = "Escribe el valor."; return; }
      const p = { valor: S.edit.valor, vehiculo: S.edit.vehiculo, pago: S.edit.pago, nota: S.edit.nota };
      b.disabled = true;
      try { await rpc("editar", { p_pin: S.pin, p_id: S.edit.id, p }); S.edit = null; toast("Cambios guardados"); await cargarDia(true); }
      catch (e) { $("edHint").textContent = "No se guardó. " + e.message; b.disabled = false; }
    }
  });
  $("items").addEventListener("input", ev => {
    if (ev.target.id === "edValor") { const n = Number(ev.target.value.replace(/[^\d]/g, "")) || 0; ev.target.value = n ? money(n) : ""; }
    leerEditor();
  });
  function leerEditor() {
    if (!S.edit) return;
    const v = $("edValor"); if (v) S.edit.valor = Number(v.value.replace(/[^\d]/g, "")) || 0;
    const n = $("edNota"); if (n) S.edit.nota = n.value.trim();
  }

  function setFecha(f) {
    if (!f || !esDueno()) return;
    S.fecha = f; $("fecha").value = f; S.edit = null; S.registros = [];
    renderDia(); cargarDia();
  }
  $("fecha").addEventListener("change", () => setFecha($("fecha").value));
  $("prevDay").addEventListener("click", () => setFecha(shiftDate(S.fecha, -1)));
  $("nextDay").addEventListener("click", () => setFecha(shiftDate(S.fecha, 1)));
  $("goToday").addEventListener("click", () => setFecha(S.hoy));

  // ---------- Formulario ----------
  function renderForm() {
    document.querySelectorAll(".vehbtn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.veh === S.veh)));
    $("transf").setAttribute("aria-pressed", String(S.pago === "Transferencia"));
  }
  document.querySelectorAll(".vehbtn").forEach(b => b.addEventListener("click", () => { S.veh = b.dataset.veh; renderForm(); }));
  $("transf").addEventListener("click", () => { S.pago = S.pago === "Transferencia" ? "Efectivo" : "Transferencia"; renderForm(); });
  const parseValor = () => Number(($("valor").value || "").replace(/[^\d]/g, "")) || 0;
  const setValor = n => { $("valor").value = n ? money(n) : ""; };
  $("valor").addEventListener("input", () => setValor(parseValor()));

  // Préstamos al trabajador
  $("abrirPrest").addEventListener("click", () => {
    const f = $("prestForm"), open = f.hidden;
    f.hidden = !open; $("abrirPrest").setAttribute("aria-expanded", String(open));
    $("abrirPrest").querySelector(".chev").textContent = open ? "−" : "+";
    if (open) $("prestValor").focus();
  });
  $("prestValor").addEventListener("input", e => { const n = Number(e.target.value.replace(/[^\d]/g, "")) || 0; e.target.value = n ? money(n) : ""; });
  $("prestForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const valor = Number(($("prestValor").value || "").replace(/[^\d]/g, "")) || 0;
    if (!valor) { $("prestHint").textContent = "Escribe cuánto se llevó."; $("prestValor").focus(); return; }
    const nota = $("prestNota").value.trim();
    const p = { tipo: "gasto", concepto: "Préstamo trabajador", nota, valor, pago: "Efectivo" };
    if (esDueno() && S.fecha !== S.hoy) p.fecha = S.fecha;
    $("guardarPrest").disabled = true;
    try {
      await rpc("agregar", { p_pin: S.pin, p });
      toast(`Préstamo de ${money(valor)} registrado`);
      $("prestValor").value = ""; $("prestNota").value = "";
      $("prestHint").textContent = "No sale del efectivo del negocio: se descuenta de la mitad del trabajador ese día.";
      $("prestForm").hidden = true; $("abrirPrest").setAttribute("aria-expanded", "false"); $("abrirPrest").querySelector(".chev").textContent = "+";
      await cargarDia(true);
    } catch (e) { $("prestHint").textContent = "No se guardó. " + e.message; }
    finally { $("guardarPrest").disabled = false; }
  });

  let guardando = false;
  $("form").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (guardando) return;
    const valor = parseValor();
    const hint = $("formHint");
    if (!valor) { hint.textContent = "Escribe el valor."; $("valor").focus(); return; }
    const p = { tipo: "venta", servicio: "Lavado", vehiculo: S.veh, valor, pago: S.pago };
    if (esDueno() && S.fecha !== S.hoy) p.fecha = S.fecha;
    hint.textContent = "";
    guardando = true; $("guardar").disabled = true;
    try {
      await rpc("agregar", { p_pin: S.pin, p });
      toast(`${S.veh} ${money(valor)} guardado`);
      setValor(0); S.pago = "Efectivo"; renderForm();
      await cargarDia(true);
    } catch (e) {
      hint.textContent = "No se guardó. " + e.message;
    } finally { guardando = false; $("guardar").disabled = false; }
  });

  // ---------- Historial ----------
  async function cargarHist() {
    if (!esDueno()) return;
    try {
      const r = await rpc("exportar", { p_pin: S.pin, p_desde: shiftDate(S.hoy, -90), p_hasta: S.hoy });
      const map = {};
      (r.registros || []).forEach(x => { (map[x.fecha] = map[x.fecha] || []).push(x); });
      S.dias = Object.keys(map).sort().reverse().map(f => {
        const t = totals(map[f]);
        return { fecha: f, ventas: t.total, gastos: t.prest, carros: t.carros + t.motos, transf: t.transf, entregar: calcReparto(t).entregar, mitad: t.total / 2 };
      });
      renderHist();
    } catch (e) { banner(e.message); }
  }
  function renderHist() {
    const map = {}; S.dias.forEach(d => (map[d.fecha] = d));
    const hoy = S.hoy, v = f => (map[f] ? Number(map[f].ventas) : 0);
    let s7 = 0, c7 = 0;
    for (let i = 0; i < 7; i++) { const f = shiftDate(hoy, -i); if (map[f]) { s7 += Number(map[f].ventas); c7 += Number(map[f].carros); } }
    $("s7").textContent = money(s7); $("s7c").textContent = c7 + " vehículos";
    const mes = hoy.slice(0, 7); let sm = 0, cm = 0, dm = 0, gm = 0;
    S.dias.forEach(d => { if (d.fecha.slice(0, 7) === mes) { sm += Number(d.ventas); cm += Number(d.carros); gm += Number(d.gastos); if (Number(d.ventas) > 0) dm++; } });
    $("sMes").textContent = money(sm); $("sMesc").textContent = `${cm} vehículos`;
    const pm = S.dias.filter(d => d.fecha.slice(0, 7) === mes).reduce((a, d) => a + d.mitad + d.gastos, 0);
    $("sPrest").textContent = money(pm); $("sPrestc").textContent = gm ? `mitad + ${money(gm)} de descuentos` : "tu mitad del mes";
    const days = []; for (let i = 13; i >= 0; i--) days.push(shiftDate(hoy, -i));
    const max = Math.max(1, ...days.map(v));
    $("bars").innerHTML = days.map(f => `<div class="b ${f === hoy ? "hoy" : ""}" title="${esc(prettyDate(f))}: ${money(v(f))}"><i style="height:${(v(f) / max * 100).toFixed(1)}%"></i></div>`).join("");
    $("axis").innerHTML = days.map(f => `<span>${Number(f.slice(8))}</span>`).join("");
    $("histBody").innerHTML = S.dias.length ? S.dias.map(d => {
      return `<tr class="click" data-f="${d.fecha}"><td>${esc(prettyDate(d.fecha, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}</td><td>${d.carros}</td><td><b>${money(Number(d.ventas))}</b></td><td>${Number(d.gastos) ? money(Number(d.gastos)) : "—"}</td><td class="${d.entregar < 0 ? "neg" : ""}"><b>${d.entregar < 0 ? "−" : ""}${money(Math.abs(d.entregar))}</b></td></tr>`;
    }).join("") : `<tr><td colspan="5" style="text-align:left;color:var(--ink-2)">Aún no hay días registrados.</td></tr>`;
    $("histBody").querySelectorAll("tr.click").forEach(tr => tr.addEventListener("click", () => { setTab("dia"); setFecha(tr.dataset.f); window.scrollTo(0, 0); }));
  }

  // ---------- Ajustes ----------
  let tdDraft = "dueno";
  function renderCfgEditor() {
    $("cfgNombre").value = S.cfg.nombre;
    tdDraft = transfDestino(); drawTd();
    if (!$("expDesde").value) { $("expDesde").value = S.hoy.slice(0, 8) + "01"; $("expHasta").value = S.hoy; }
  }
  function drawTd() { document.querySelectorAll("#transfDest .opt").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.td === tdDraft))); }
  document.querySelectorAll("#transfDest .opt").forEach(b => b.addEventListener("click", () => { tdDraft = b.dataset.td; drawTd(); }));
  $("saveCfg").addEventListener("click", async () => {
    const nombre = $("cfgNombre").value.trim();
    try {
      const servicios = (S.cfg.servicios || []).filter(x => !(x && x.tipo === "ajuste")).concat([{ tipo: "ajuste", transf: tdDraft }]);
      await rpc("guardar_config", { p_pin: S.pin, p_nombre: nombre, p_servicios: servicios });
      S.cfg.nombre = nombre; S.cfg.servicios = servicios; renderBrand(); renderDia(); toast("Guardado");
    } catch (e) { toast(e.message); }
  });

  $("pinNuevo").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
  $("cambiarPin").addEventListener("click", async () => {
    const rol = $("pinRol").value, nuevo = $("pinNuevo").value;
    try {
      await rpc("cambiar_pin", { p_pin: S.pin, p_rol: rol, p_nuevo: nuevo });
      if (rol === "dueno") { S.pin = nuevo; lsSet("lav_pin", nuevo); }
      $("pinNuevo").value = "";
      toast(rol === "dueno" ? "Tu PIN cambió" : "PIN del trabajador cambiado. Dáselo en persona.");
    } catch (e) { toast(e.message); }
  });

  // ---------- Exportar CSV ----------
  function csvCell(v) { v = v == null ? "" : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  $("exportar").addEventListener("click", async () => {
    const desde = $("expDesde").value, hasta = $("expHasta").value;
    if (!desde || !hasta || desde > hasta) return toast("Revisa las fechas");
    try {
      const r = await rpc("exportar", { p_pin: S.pin, p_desde: desde, p_hasta: hasta });
      const rows = r.registros || [];
      if (!rows.length) return toast("No hay registros en esas fechas");
      const head = ["Fecha", "Hora", "Concepto", "Valor", "Pago"];
      const lines = [head.join(";")].concat(rows.map(x => x.tipo === "gasto" ? [x.fecha, x.hora, "Préstamo trabajador" + (x.nota ? " (" + x.nota + ")" : ""), -x.valor, "Efectivo"] : [x.fecha, x.hora, x.vehiculo, x.valor, x.pago]).map(r => r.map(csvCell).join(";")));
      const csv = "﻿" + lines.join("\r\n");
      const nombre = `lavadero_${desde}_a_${hasta}.csv`;
      await compartirArchivo(nombre, csv);
    } catch (e) { toast(e.message || "No se pudo exportar"); }
  });

  async function compartirArchivo(nombre, texto) {
    const P = window.Capacitor && window.Capacitor.Plugins;
    if (P && P.Filesystem && P.Share && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
      const w = await P.Filesystem.writeFile({ path: nombre, data: texto, directory: "CACHE", encoding: "utf8" });
      await P.Share.share({ title: nombre, files: [w.uri], dialogTitle: "Enviar o guardar el archivo" });
      return;
    }
    const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = nombre; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---------- Arranque ----------
  $("appVer").textContent = "Versión " + APP_VERSION;
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY || CFG.SUPABASE_KEY.startsWith("PEGAR")) {
    mostrarLogin(); $("loginErr").textContent = "Falta configurar la conexión (config.js).";
  } else if (S.pin) {
    mostrarLogin(); $("loginErr").textContent = "Entrando…"; entrar(S.pin);
  } else {
    mostrarLogin();
  }
})();
