(function () {
  "use strict";
  const CFG = window.LAVADERO_CONFIG || {};
  const TZ = "America/Bogota";
  const VEHICULOS = ["Carro", "Moto", "Mototaxi", "Turbo", "Motocarguero"];
  const PLURAL = { Carro: "carros", Moto: "motos", Mototaxi: "mototaxis", Turbo: "turbos", Motocarguero: "motocargueros" };
  const PAGOS = ["Efectivo", "Nequi", "Daviplata", "Transferencia"];
  const GASTOS = ["Jabón/insumos", "Almuerzo", "Agua/luz", "Pago trabajador", "Otro"];
  const APP_VERSION = "2026-10-02 10:59";
  const REFRESCO_MS = 20000;
  const ERRORES = {
    x_pin: "PIN incorrecto.",
    x_bloqueado: "Demasiados intentos. Espera 10 minutos.",
    SOLO_DUENO: "Solo el dueño puede hacer eso.",
    NO_PERMITIDO: "Solo puedes corregir tus lavados de hoy. Para otros días, pídeselo al dueño.",
    NO_EXISTE: "Ese registro ya no existe.",
    VALOR_INVALIDO: "Escribe un valor mayor a cero.",
    PIN_4_A_6_DIGITOS: "El PIN debe tener entre 4 y 6 dígitos.",
    PIN_REPETIDO: "Ese PIN ya lo usa la otra persona. Elige otro.",
    RED: "Sin conexión. Revisa los datos o el wifi e intenta de nuevo."
  };

  const fmt = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
  const money = n => fmt.format(Math.round(n || 0)).replace(/ /g, " ");
  // Valores en miles: "12" = $12.000, "12,5" = $12.500. Si escriben 1000 o más, se toma como pesos completos.
  function milesAPesos(txt) {
    txt = String(txt || "").trim().replace(/\s|\$/g, "");
    if (!txt) return 0;
    if (/^\d{1,3}(\.\d{3})+$/.test(txt)) return Number(txt.replace(/\./g, ""));   // "12.000" escrito completo
    const n = Number(txt.replace(",", "."));
    if (!isFinite(n) || n <= 0) return 0;
    return n >= 1000 ? Math.round(n) : Math.round(n * 1000);
  }
  function pesosAMiles(n) {
    n = Math.round(n || 0);
    if (!n) return "";
    return n % 1000 === 0 ? String(n / 1000) : String(n / 1000).replace(".", ",");
  }
  // Muestra debajo de cada campo de valor cuánto queda en pesos
  document.addEventListener("input", ev => {
    const el = ev.target;
    if (!el.classList || !el.classList.contains("money")) return;
    el.value = el.value.replace(/[^\d.,]/g, "");
    let prev = el.parentNode.querySelector(".miles-prev");
    if (!prev) { prev = document.createElement("small"); prev.className = "miles-prev"; el.after(prev); }
    const v = milesAPesos(el.value);
    prev.textContent = v ? "= " + money(v) : "";
  });
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
      lsSet("lav_pin", pin); lsSet("lav_rol", r.rol); lsSet("lav_cfg", JSON.stringify(S.cfg));
      mostrarApp();
    } catch (e) {
      pinBuf = ""; drawDots();
      if (e.code === "x_pin") { S.pin = null; lsSet("lav_pin", null); }
      $("loginErr").textContent = e.message;
      if (e.code === "RED" && S.pin && pin === lsGet("lav_pin") && lsGet("lav_rol")) {
        // Sin señal: entra con lo guardado en el celular
        S.rol = lsGet("lav_rol"); S.hoy = todayStr(); S.fecha = S.hoy;
        try { S.cfg = normCfg(JSON.parse(lsGet("lav_cfg") || "{}")); } catch (_) {}
        const c = leerCacheDia(); if (c && c.fecha === S.hoy) S.registrosServidor = c.registros;
        mostrarApp();
      }
    }
  }
  function mostrarLogin() {
    $("app").hidden = true; $("login").hidden = false;
    pinBuf = ""; drawDots(); drawPad();
    $("loginName").textContent = lsGet("lav_nombre") || "Caja del Lavadero";
  }
  // Avisos en segundo plano (solo en la app instalada, solo para el dueño)
  function pluginAvisos() {
    const C = window.Capacitor;
    return C && C.Plugins && C.Plugins.Avisos && C.isNativePlatform && C.isNativePlatform() ? C.Plugins.Avisos : null;
  }
  function activarAvisos() {
    const A = pluginAvisos(); if (!A) return;
    if (esDueno()) {
      A.configurar({ url: CFG.SUPABASE_URL, key: CFG.SUPABASE_KEY, pin: S.pin })
        .then(() => { if (!lsGet("lav_avisos_ok")) { lsSet("lav_avisos_ok", "1"); A.probar().catch(() => {}); } })
        .catch(() => {});
    } else {
      A.desactivar().catch(() => {});
    }
  }
  function salir(silencioso) {
    const A = pluginAvisos(); if (A) A.desactivar().catch(() => {});
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
    document.querySelectorAll(".solo-trab").forEach(el => (el.hidden = esDueno()));
    $("tabs").hidden = !esDueno();
    $("whoRol").textContent = esDueno() ? "Dueño" : "Trabajador";
    $("fecha").value = S.fecha;
    setTab(esDueno() ? (lsGet("lav_tab") || "dia") : "dia");
    renderBrand(); renderForm(); renderDia(); cerrarPrest(); activarAvisos(); renderCola(); subirCola();
    cargarDia();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refrescar(); }, REFRESCO_MS);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.rol) refrescar(); });
  function refrescar() { subirCola(); cargarDia(true); if (S.tab === "hist") cargarHist(); }

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

  // ---------- Sin señal: fila de espera ----------
  const nuevoId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === "x" ? r : (r & 3 | 8)).toString(16); });
  const horaAhora = () => new Date().toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
  function leerCola() { try { return JSON.parse(lsGet("lav_cola") || "[]"); } catch (e) { return []; } }
  function guardarCola(c) { lsSet("lav_cola", c.length ? JSON.stringify(c) : null); }
  function leerCacheDia() { try { return JSON.parse(lsGet("lav_dia") || "null"); } catch (e) { return null; } }
  // Guarda un registro: primero en el celular, luego intenta subirlo. Devuelve true si ya quedó en el servidor.
  async function guardarRegistro(p) {
    p = Object.assign({ id: nuevoId(), fecha: S.fecha || todayStr(), hora: horaAhora(), offline: true }, p);
    const cola = leerCola(); cola.push({ pin: S.pin, rol: S.rol, p }); guardarCola(cola);
    try {
      await rpc("agregar", { p_pin: S.pin, p });
      guardarCola(leerCola().filter(x => x.p.id !== p.id));
      return true;
    } catch (e) {
      if (e.code !== "RED") { guardarCola(leerCola().filter(x => x.p.id !== p.id)); throw e; }
      return false;
    } finally { renderCola(); }
  }
  let subiendo = false;
  async function subirCola() {
    if (subiendo) return;
    const cola = leerCola(); if (!cola.length) { renderCola(); return; }
    subiendo = true;
    try {
      for (const it of cola) {
        try {
          await rpc("agregar", { p_pin: it.pin || S.pin, p: it.p });
          guardarCola(leerCola().filter(x => x.p.id !== it.p.id));
        } catch (e) {
          if (e.code === "RED") break;                                   // sigue sin señal
          guardarCola(leerCola().filter(x => x.p.id !== it.p.id));       // rechazado por el servidor: se descarta
        }
      }
    } finally { subiendo = false; renderCola(); }
    if (!leerCola().length && S.rol) cargarDia(true);
  }
  function renderCola() {
    const n = leerCola().length;
    const el = $("colaAviso"); if (!el) return;
    el.hidden = !n;
    el.textContent = n ? `Sin señal · ${n} ${n === 1 ? "registro esperando" : "registros esperando"} conexión. Se suben solos.` : "";
  }
  window.addEventListener("online", () => subirCola());
  // Registros propios que aún no llegan al servidor (para mostrarlos y sumarlos ya)
  function pendientesDe(fecha) {
    return leerCola().filter(x => x.p.fecha === fecha).map(x => Object.assign({ creado: new Date().toISOString(), rol: x.rol, pendiente: true }, x.p));
  }

  // ---------- Día ----------
  let cargando = 0;
  async function cargarDia(silencioso) {
    const f = S.fecha, my = ++cargando;
    if (!silencioso) $("syncState").textContent = "Cargando…";
    try {
      const [r, sal] = await Promise.all([
        rpc("ver_dia", { p_pin: S.pin, p_fecha: f }),
        rpc("saldo_prestamos", { p_pin: S.pin, p_fecha: S.hoy }).catch(() => null)
      ]);
      if (my !== cargando) return;
      S.saldo = sal && typeof sal.saldo === "number" ? sal.saldo : null;
      renderSaldo();
      const nuevos = r.registros || [];
      if (esDueno() && S.vistos && S.vistosFecha === f && f === r.hoy) {
        const delTrab = nuevos.filter(x => !S.vistos.has(x.id) && x.rol === "trabajador");
        if (delTrab.length) {
          campanita();
          const x = delTrab[0];
          toast(x.tipo === "gasto"
            ? `El trabajador registró ${esAbono(x) ? "un abono" : "un préstamo"} de ${money(x.valor)}`
            : `El trabajador agregó ${ARTICULO[x.vehiculo] || x.vehiculo} de ${money(x.valor)}${delTrab.length > 1 ? ` (+${delTrab.length - 1} más)` : ""}`);
        }
      }
      S.vistos = new Set(nuevos.map(x => x.id)); S.vistosFecha = f;
      S.registrosServidor = nuevos; S.hoy = r.hoy;
      if (f === r.hoy) lsSet("lav_dia", JSON.stringify({ fecha: f, registros: nuevos }));
      subirCola();
      if (!esDueno()) S.fecha = r.fecha;
      const nuevoCfg = normCfg(r.config);
      if (JSON.stringify(nuevoCfg) !== JSON.stringify(S.cfg)) { S.cfg = nuevoCfg; renderBrand(); renderForm(); }
      banner("");
      $("syncState").textContent = "Actualizado " + new Date().toLocaleTimeString("es-CO", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      if (S.edit && silencioso) return; // no interrumpir mientras se edita
      if (!silencioso || !S.cuentasT || Date.now() - S.cuentasT > 60000) { S.cuentasT = Date.now(); cargarCuentas(); }
      if (silencioso && document.activeElement && /^(movValor|ajusteValor|alDiaFecha)$/.test(document.activeElement.id)) return;
      renderDia();
    } catch (e) {
      if (my !== cargando) return;
      $("syncState").textContent = "Sin conexión";
      if (e.code === "RED") {
        const c = leerCacheDia();
        if (!S.registrosServidor && c && c.fecha === f) S.registrosServidor = c.registros;
        renderDia();
      } else if (!silencioso) banner(e.message);
    }
  }

  const esAbono = r => /^abono/i.test(r.concepto || "");
  function totals(regs) {
    let total = 0, carros = 0, motos = 0, efectivo = 0, transf = 0, prest = 0, abonos = 0; const porTipo = {};
    (regs || []).forEach(r => {
      if (r.tipo === "gasto") { if (esAbono(r)) abonos += r.valor || 0; else prest += r.valor || 0; return; }
      const v = r.valor || 0;
      total += v;
      if (r.vehiculo === "Moto") motos++; else carros++;
      const tipo = r.vehiculo || "Carro"; porTipo[tipo] = (porTipo[tipo] || 0) + 1;
      if (r.pago === "Transferencia") transf += v; else efectivo += v;
    });
    return { total, carros, motos, efectivo, transf, prest, abonos, porTipo, vehiculos: carros + motos };
  }

  // ---------- Reparto mitad y mitad ----------
  // Ajustes guardados dentro de config.servicios como {tipo:"ajuste", transf:"dueno"|"trabajador"}
  function ajustes() { return (S.cfg.servicios || []).find(x => x && x.tipo === "ajuste") || {}; }
  function transfDestino() { return ajustes().transf === "trabajador" ? "trabajador" : "dueno"; }
  // Reparto: mitad y mitad. Los préstamos son una cuenta aparte y no entran aquí.
  function calcReparto(t) {
    const mitad = t.total / 2;
    const dest = transfDestino();
    const entregar = dest === "dueno" ? mitad - t.transf : mitad;
    return { mitad, entregar, dest };
  }
  // ---------- Cuentas al día ----------
  const alDia = () => ajustes().alDia || null;
  async function guardarAjuste(cambios) {
    const servicios = (S.cfg.servicios || []).filter(x => !(x && x.tipo === "ajuste")).concat([Object.assign({}, ajustes(), cambios, { tipo: "ajuste" })]);
    await rpc("guardar_config", { p_pin: S.pin, p_nombre: S.cfg.nombre, p_servicios: servicios });
    S.cfg.servicios = servicios;
  }
  let cuentasArmado = false;
  async function cargarCuentas() {
    const box = $("cuentasBox");
    const desdeFijo = alDia();
    if (!esDueno()) {
      // Mauricio: solo lectura, con los totales que entrega el servidor
      try {
        const r = await rpc("cuentas_pendientes", { p_pin: S.pin });
        const dias = (r.dias || []).map(d => {
          const t = { total: Number(d.total) || 0, transf: Number(d.transf) || 0, prest: 0, vehiculos: Number(d.vehiculos) || 0 };
          return { f: d.fecha, t };
        });
        S.cuentas = { desde: r.al_dia || null, dias, debe: dias.reduce((a, d) => a + calcReparto(d.t).entregar, 0), soloVer: true };
      } catch (e) {
        // Si aún no está el código en Supabase, muestra solo la fecha
        box.hidden = !desdeFijo;
        if (desdeFijo) box.innerHTML = `<div class="cta-linea">Cuentas al día hasta <b>${esc(prettyDate(desdeFijo, { weekday: "short", day: "numeric", month: "short" }))}</b></div>`;
        return;
      }
      renderCuentas();
      return;
    }
    const desde = desdeFijo ? shiftDate(desdeFijo, 1) : shiftDate(S.hoy, -30);
    try {
      const r = desde <= S.hoy ? await rpc("exportar", { p_pin: S.pin, p_desde: desde, p_hasta: S.hoy }) : { registros: [] };
      const map = {};
      (r.registros || []).forEach(x => { (map[x.fecha] = map[x.fecha] || []).push(x); });
      const dias = Object.keys(map).sort().map(f => ({ f, t: totals(map[f]) })).filter(d => d.t.total > 0);
      S.cuentas = { desde: desdeFijo, dias, debe: dias.reduce((a, d) => a + calcReparto(d.t).entregar, 0) };
    } catch (e) { S.cuentas = null; }
    renderCuentas();
  }
  function renderCuentas() {
    const box = $("cuentasBox"), c = S.cuentas;
    if (!c) return;
    const soloVer = !esDueno();
    box.hidden = false;
    const corto = f => prettyDate(f, { weekday: "short", day: "numeric", month: "short" });
    // Quién le debe a quién, sin números negativos
    const quien = v => v >= 0
      ? (soloVer ? "Debes " : "Te debe ") + money(v)
      : (soloVer ? "El dueño te debe " : "Le debes ") + money(-v);
    const lista = c.dias.map(d => { const v = Math.round(calcReparto(d.t).entregar); return `<div><dt>${esc(corto(d.f))}</dt><dd class="${v < 0 ? "pos" : ""}">${quien(v)}</dd></div>`; }).join("");
    const total = Math.round(c.debe);
    const textoTotal = total >= 0
      ? (soloVer ? "le debes entregar al dueño" : "te debe entregar")
      : (soloVer ? "el dueño te debe" : "tú le debes al trabajador");
    box.innerHTML = `<h2>Cuentas pendientes</h2>
      <div class="cta-linea">${c.desde ? `Al día hasta <b>${esc(prettyDate(c.desde, { weekday: "long", day: "numeric", month: "long" }))}</b>` : (soloVer ? "El dueño aún no ha marcado hasta qué día están al día." : "Aún no has marcado hasta qué día están al día.")}</div>
      ${c.dias.length ? `<dl>${lista}</dl>
        <div class="debe"><span>${c.dias.length} ${c.dias.length === 1 ? "día" : "días"} sin cuadrar · ${textoTotal}</span><b>${money(Math.abs(total))}</b></div>
        ${total < 0 ? `<p class="hint">Es porque las transferencias que llegaron a la cuenta del dueño superan su mitad.</p>` : ""}`
        : `<p class="hint">${c.desde ? "No hay días pendientes: están al día." : "No hay lavados en los últimos 30 días."}</p>`}
      ${soloVer ? '<p class="hint">Solo el dueño puede marcar las cuentas al día.</p>' : `<div class="cta-acciones">
        <button type="button" class="primary ${cuentasArmado ? "armado" : ""}" id="alDiaHoy">${cuentasArmado ? "¿Seguro? Toca otra vez" : "Marcar al día hasta hoy"}</button>
        <label class="field"><span>O hasta otra fecha</span>
          <div class="cta-fecha"><input type="date" id="alDiaFecha" max="${S.hoy}" value="${c.desde || ""}"><button type="button" class="ghost" id="alDiaOtra">Marcar</button></div>
        </label>
      </div>`}`;
    if (soloVer) return;
    $("alDiaHoy").onclick = async () => {
      if (!cuentasArmado) { cuentasArmado = true; renderCuentas(); setTimeout(() => { cuentasArmado = false; renderCuentas(); }, 4000); return; }
      cuentasArmado = false; await marcarAlDia(S.hoy);
    };
    $("alDiaOtra").onclick = () => { const f = $("alDiaFecha").value; if (f) marcarAlDia(f); };
  }
  async function marcarAlDia(f) {
    try { await guardarAjuste({ alDia: f }); toast("Cuentas al día hasta " + prettyDate(f, { day: "numeric", month: "long" })); await cargarCuentas(); if (S.tab === "hist") renderHist(); }
    catch (e) { toast(e.message); }
  }

  function renderReparto(t) {
    const r = calcReparto(t);
    const filas = [["Mitad del dueño", money(r.mitad)], ["Mitad del trabajador", money(r.mitad)]];
    if (r.dest === "dueno" && t.transf > 0)
      filas.push([esDueno() ? "Transferencias que ya te llegaron" : "Transferencias que ya le llegaron al dueño", "−" + money(t.transf)]);
    $("rLista").innerHTML = filas.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
    const debe = Math.round(r.entregar);
    if (debe >= 0) {
      $("rDebeLbl").textContent = esDueno() ? "El trabajador te debe entregar" : "Le debes entregar al dueño";
      $("rDebe").textContent = money(debe); $("rDebe").className = "";
    } else {
      $("rDebeLbl").textContent = esDueno() ? "Tú le debes al trabajador" : "El dueño te debe";
      $("rDebe").textContent = money(-debe); $("rDebe").className = "neg";
    }
    $("rNota").textContent = r.dest === "dueno"
      ? "Las transferencias ya están en la cuenta del dueño, por eso se restan. Los préstamos van aparte."
      : "Las transferencias llegan a la cuenta del trabajador; entrega la parte del dueño en efectivo o por transferencia. Los préstamos van aparte.";
  }
  function renderSaldo() {
    const s = S.saldo;
    const txt = s == null ? "—" : money(s);
    $("saldoPrest").textContent = txt;
    $("saldoPrest").className = s > 0 ? "neg" : "";
    $("saldoMini").textContent = s == null ? "" : (s > 0 ? `· debe ${money(s)}` : "· al día");
  }

  function puedeBorrar(r) {
    if (r.pendiente) return false;   // aún no llega al servidor
    if (esDueno()) return true;
    // Mauricio: sus lavados de hoy, mientras el día no esté marcado como al día
    return r.rol === "trabajador" && r.tipo === "venta" && r.fecha === S.hoy && !(alDia() && r.fecha <= alDia());
  }


  function renderDia() {
    const serv = S.registrosServidor || [];
    const ids = new Set(serv.map(x => x.id));
    S.registros = pendientesDe(S.fecha).filter(x => !ids.has(x.id)).concat(serv);
    const regs = S.registros;
    const t = totals(regs);
    const esHoy = S.fecha === S.hoy;
    $("ticketFecha").textContent = (esHoy ? "Hoy · " : "") + prettyDate(S.fecha);
    $("totVentas").textContent = money(t.total);
    $("totCarros").textContent = t.vehiculos;
    const orden = VEHICULOS.concat(Object.keys(t.porTipo).filter(k => !VEHICULOS.includes(k)));
    $("totMotos").textContent = orden.filter(k => t.porTipo[k]).map(k => `${t.porTipo[k]} ${t.porTipo[k] === 1 ? k.toLowerCase() : (PLURAL[k] || k.toLowerCase() + "s")}`).join(" · ") || "—";
    $("totEfectivo").textContent = money(t.efectivo);
    $("totTransf").textContent = money(t.transf);
    renderReparto(t);
    const nLav = t.carros + t.motos;
    $("listSub").textContent = regs.length ? `${nLav} ${nLav === 1 ? "lavado" : "lavados"}${(t.prest || t.abonos) ? " · préstamos" : ""} · más reciente arriba` : "";
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
        ? `<b>${esAbono(r) ? "Abono a préstamo" : "Préstamo al trabajador"}</b><span>${esc(r.nota || "")}</span>`
        : `<b>${esc(r.vehiculo || "Carro")}</b><span>${tr ? '<span class="tag tr">Transferencia</span>' : '<span class="tag">Efectivo</span>'}${r.pendiente ? ' <span class="tag espera">Sin subir</span>' : ""}</span>`;
      const editando = S.edit && S.edit.id === r.id;
      return `<div class="item ${g ? (esAbono(r) ? "abono" : "gasto") : ""} ${editando ? "editing" : ""}">
        <div class="hora num">${esc(r.hora || "")}</div>
        <div class="what">${what}</div>
        <div><div class="val num">${g ? (esAbono(r) ? "+" : "−") : ""}${money(r.valor)}</div>
          ${puedeBorrar(r) && !editando ? `<button class="edit-btn" data-act="open" data-id="${esc(r.id)}">Editar</button>` : ""}
        </div></div>${editando ? editorHtml(r) : ""}`;
    }).join("");
  }

  function editorHtml(r) {
    const e = S.edit, g = r.tipo === "gasto";
    const btn = (attr, val, cur, label) => `<button type="button" class="opt" data-${attr}="${val}" aria-pressed="${val === cur}">${label}</button>`;
    return `<div class="editor">
      ${g ? "" : `<div class="opts">${VEHICULOS.map(v => btn("ev", v, e.vehiculo, v)).join("")}</div>`}
      <label class="field"><span>Valor (en miles)</span><input id="edValor" class="money num" inputmode="decimal" value="${pesosAMiles(e.valor)}"><small class="miles-prev">${e.valor ? "= " + money(e.valor) : ""}</small></label>
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

    leerEditor();
  });
  function leerEditor() {
    if (!S.edit) return;
    const v = $("edValor"); if (v) S.edit.valor = milesAPesos(v.value);
    const n = $("edNota"); if (n) S.edit.nota = n.value.trim();
  }

  function setFecha(f) {
    if (!f || !esDueno()) return;
    S.fecha = f; $("fecha").value = f; S.edit = null; S.registros = []; S.registrosServidor = null;
    renderDia(); cargarDia();
  }
  $("fecha").addEventListener("change", () => setFecha($("fecha").value));
  $("prevDay").addEventListener("click", () => setFecha(shiftDate(S.fecha, -1)));
  $("nextDay").addEventListener("click", () => setFecha(shiftDate(S.fecha, 1)));
  $("goToday").addEventListener("click", () => setFecha(S.hoy));

  // ---------- Voz ----------
  const ARTICULO = { Carro: "un carro", Moto: "una moto", Mototaxi: "un mototaxi", Turbo: "un turbo", Motocarguero: "un motocarguero" };
  function valorHablado(n) {
    n = Math.round(n);
    if (n >= 1000000 && n % 1000 === 0) return (n / 1000000).toLocaleString("es-CO") + (n === 1000000 ? " millón" : " millones") + " de pesos";
    if (n % 1000 === 0) return (n / 1000) + " mil pesos";
    return n + " pesos";
  }
  async function hablar(texto) {
    try {
      const TTS = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.TextToSpeech;
      if (TTS && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
        await TTS.stop().catch(() => {});
        await TTS.speak({ text: texto, lang: "es-CO", rate: 1.0, pitch: 1.0, volume: 1.0, category: "playback" });
        return;
      }
      if ("speechSynthesis" in window) {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(texto); u.lang = "es-CO"; speechSynthesis.speak(u);
      }
    } catch (e) { /* sin voz disponible: no pasa nada */ }
  }

  // Sonido de aviso para el dueño (sin voz)
  let audioCtx = null;
  function prepararAudio() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) {}
  }
  document.addEventListener("pointerdown", prepararAudio, { passive: true });
  function campanita() {
    try {
      prepararAudio(); if (!audioCtx) return;
      const t0 = audioCtx.currentTime;
      [[880, 0], [1320, 0.16]].forEach(([f, d]) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = "sine"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + d);
        g.gain.exponentialRampToValueAtTime(0.5, t0 + d + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.45);
        o.connect(g).connect(audioCtx.destination); o.start(t0 + d); o.stop(t0 + d + 0.5);
      });
      if (navigator.vibrate) navigator.vibrate([80, 60, 80]);
    } catch (e) {}
  }
  // Voz para el trabajador; campanita para el dueño
  const nombreTrab = () => (ajustes().trabajador || "Mauricio").trim();

  // Voz natural de mujer (frases grabadas con Piper, en voz/). Si no hay grabación, usa la voz del celular.
  const vozCache = {};
  function clipVoz(url) {
    if (!vozCache[url]) {
      vozCache[url] = fetch(url).then(r => { if (!r.ok) throw new Error("sin audio"); return r.arrayBuffer(); })
        .then(b => new Promise((res, rej) => audioCtx.decodeAudioData(b, res, rej)))
        .catch(e => { delete vozCache[url]; throw e; });
    }
    return vozCache[url];
  }
  function archivoMonto(valor) {
    const k = valor / 1000;
    if (Number.isInteger(k) && k >= 1 && k <= 300) return `voz/m${k}.mp3`;
    if (valor % 1000 === 500 && Math.floor(valor / 1000) <= 100) return `voz/m${Math.floor(valor / 1000)}_5.mp3`;
    return null;
  }
  async function vozNatural(veh, valor, transf) {
    if (nombreTrab().toLowerCase() !== "mauricio") return false;   // las grabaciones dicen "Mauricio"
    prepararAudio(); if (!audioCtx) return false;
    const monto = archivoMonto(valor); if (!monto) return false;
    const urls = [`voz/intro_${String(veh).toLowerCase()}.mp3`, monto].concat(transf ? ["voz/transferencia.mp3"] : []);
    try {
      const bufs = await Promise.all(urls.map(clipVoz));
      if (audioCtx.state === "suspended") await audioCtx.resume();
      let t = audioCtx.currentTime + 0.05;
      bufs.forEach((b, i) => {
        const src = audioCtx.createBufferSource(); src.buffer = b; src.connect(audioCtx.destination);
        src.start(t); t += b.duration + (i === 0 ? 0.06 : 0.1);
      });
      return true;
    } catch (e) { return false; }
  }
  function precargarVoz() {
    if (esDueno() || !audioCtx) return;
    VEHICULOS.forEach(v => clipVoz(`voz/intro_${v.toLowerCase()}.mp3`).catch(() => {}));
  }
  document.addEventListener("pointerdown", () => { if (S.rol && !esDueno()) precargarVoz(); }, { once: true, passive: true });
  async function avisarVenta(veh, valor, transf, frase) {
    if (esDueno()) { campanita(); return; }
    if (await vozNatural(veh, valor, transf)) return;
    avisarGuardado(frase);
  }
  function avisarGuardado(frase) {
    if (esDueno()) { campanita(); return; }
    const n = nombreTrab();
    hablar(n ? `${n}, ${frase.charAt(0).toLowerCase()}${frase.slice(1)}` : frase);
  }

  // ---------- Formulario ----------
  function renderForm() {
    document.querySelectorAll(".vehbtn").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.veh === S.veh)));
    $("transf").setAttribute("aria-pressed", String(S.pago === "Transferencia"));
  }
  document.querySelectorAll(".vehbtn").forEach(b => b.addEventListener("click", () => { S.veh = b.dataset.veh; renderForm(); }));
  $("transf").addEventListener("click", () => { S.pago = S.pago === "Transferencia" ? "Efectivo" : "Transferencia"; renderForm(); });
  const parseValor = () => milesAPesos($("valor").value);
  const setValor = n => { $("valor").value = pesosAMiles(n); const pv = $("valor").parentNode.querySelector(".miles-prev"); if (pv) pv.textContent = n ? "= " + money(n) : ""; };

  // Préstamos al trabajador
  $("abrirPrest").addEventListener("click", () => {
    const f = $("prestForm"), open = f.hidden;
    f.hidden = !open; $("abrirPrest").setAttribute("aria-expanded", String(open));
    $("abrirPrest").querySelector(".chev").textContent = open ? "−" : "+";
    if (open) { cargarMovs(); }
  });

  function cerrarPrest() { $("prestForm").hidden = true; $("abrirPrest").setAttribute("aria-expanded", "false"); $("abrirPrest").querySelector(".chev").textContent = "+"; }
  // Movimientos de préstamos (solo dueño): ver, corregir o borrar cualquier préstamo o abono
  let movEdit = null, movArmed = false;
  async function cargarMovs() {
    if (!esDueno()) return;
    try {
      const r = await rpc("exportar", { p_pin: S.pin, p_desde: "2020-01-01", p_hasta: S.hoy });
      S.movs = (r.registros || []).filter(x => x.tipo === "gasto").reverse().slice(0, 40);
      renderMovs();
    } catch (e) { $("movs").innerHTML = `<p class="hint">${esc(e.message)}</p>`; }
  }
  function renderMovs() {
    const box = $("movs"); if (!box || !S.movs) return;
    if (!S.movs.length) { box.innerHTML = '<h3>Movimientos</h3><p class="hint">No hay préstamos ni abonos registrados.</p>'; return; }
    box.innerHTML = '<h3>Movimientos</h3>' + S.movs.map(m => {
      const ab = esAbono(m), ed = movEdit === m.id;
      return `<div class="mov ${ab ? "ab" : "pr"}">
        <div class="mov-l"><b>${ab ? "Abono" : "Préstamo"}</b><span>${esc(prettyDate(m.fecha, { weekday: "short", day: "numeric", month: "short", year: "numeric" }))}${m.nota ? " · " + esc(m.nota) : ""}</span></div>
        <div class="mov-r"><b>${ab ? "+" : "−"}${money(m.valor)}</b>${ed ? "" : `<button type="button" class="edit-btn" data-mov="${esc(m.id)}">Editar</button>`}</div>
        ${ed ? `<div class="mov-ed">
          <label class="field"><span>Valor (en miles)</span><input id="movValor" class="money num" inputmode="decimal" value="${pesosAMiles(m.valor)}"><small class="miles-prev">= ${money(m.valor)}</small></label>
          <label class="field"><span>Nota</span><input id="movNota" maxlength="80" value="${esc(m.nota || "")}"></label>
          <div class="edit-actions">
            <button type="button" class="primary" data-mact="save">Guardar</button>
            <button type="button" class="danger-o ${movArmed ? "arm" : ""}" data-mact="del">${movArmed ? "¿Seguro? Toca otra vez" : "Borrar"}</button>
            <button type="button" class="linkbtn" data-mact="cancel">Cancelar</button>
          </div></div>` : ""}
      </div>`;
    }).join("");
  }
  $("movs").addEventListener("click", async ev => {
    const b = ev.target.closest("button"); if (!b) return;
    ev.preventDefault();
    if (b.dataset.mov) { movEdit = b.dataset.mov; movArmed = false; renderMovs(); return; }
    const act = b.dataset.mact; if (!act) return;
    if (act === "cancel") { movEdit = null; renderMovs(); return; }
    if (act === "del" && !movArmed) { movArmed = true; renderMovs(); return; }
    b.disabled = true;
    try {
      if (act === "del") { await rpc("borrar", { p_pin: S.pin, p_id: movEdit }); toast("Movimiento borrado"); }
      else {
        const v = milesAPesos($("movValor").value);
        if (!v) { toast("Escribe el valor"); b.disabled = false; return; }
        await rpc("editar", { p_pin: S.pin, p_id: movEdit, p: { valor: v, nota: $("movNota").value.trim() } });
        toast("Movimiento corregido");
      }
      movEdit = null; movArmed = false;
      await cargarDia(true); await cargarMovs();
    } catch (e) { toast(e.message); b.disabled = false; }
  });

  let prestTipo = "prestamo";
  function drawPrestTipo() {
    document.querySelectorAll("#prestTipo .opt").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.pt === prestTipo)));
    const aj = prestTipo === "ajuste";
    $("prestValorLbl").textContent = aj ? "Nuevo saldo que debe (en miles, 0 si ya no debe)" : prestTipo === "abono" ? "Valor que pagó" : "Valor que se llevó";
    $("guardarPrest").textContent = aj ? "Guardar nuevo saldo" : prestTipo === "abono" ? "Registrar abono" : "Registrar préstamo";
    $("guardarPrest").className = prestTipo === "prestamo" ? "danger" : "primary";
  }
  document.querySelectorAll("#prestTipo .opt").forEach(b => b.addEventListener("click", () => { prestTipo = b.dataset.pt; drawPrestTipo(); }));
  $("prestForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    if (!esDueno()) return;
    let valor = milesAPesos($("prestValor").value);
    let nota = $("prestNota").value.trim();
    let abono = prestTipo === "abono" && esDueno();
    if (prestTipo === "ajuste" && esDueno()) {
      if (S.saldo == null) { $("prestHint").textContent = "Aún no se pudo leer el saldo actual. Intenta de nuevo."; return; }
      const txt = $("prestValor").value.trim();
      if (txt === "") { $("prestHint").textContent = "Escribe el nuevo saldo (0 si ya no debe)."; return; }
      const nuevo = /^0+([.,]0*)?$/.test(txt) ? 0 : milesAPesos(txt);
      const dif = nuevo - S.saldo;
      if (!dif) { $("prestHint").textContent = "El saldo ya es " + money(nuevo) + "."; return; }
      abono = dif < 0; valor = Math.abs(dif);
      nota = ("Ajuste de saldo a " + money(nuevo) + (nota ? " · " + nota : "")).slice(0, 80);
    }
    if (!valor) { $("prestHint").textContent = "Escribe el valor."; $("prestValor").focus(); return; }
    const p = { tipo: "gasto", concepto: abono ? "Abono préstamo" : "Préstamo trabajador", nota, valor, pago: "Efectivo" };
    if (esDueno() && S.fecha !== S.hoy && prestTipo !== "ajuste") p.fecha = S.fecha;
    $("guardarPrest").disabled = true;
    try {
      await guardarRegistro(p);
      toast(prestTipo === "ajuste" ? "Saldo ajustado" : abono ? `Abono de ${money(valor)} registrado` : `Préstamo de ${money(valor)} registrado`);
      avisarGuardado(abono ? `Registraste un abono de ${valorHablado(valor)}.` : `Registraste un préstamo de ${valorHablado(valor)}.`);
      $("prestValor").value = ""; $("prestNota").value = "";
      $("prestHint").textContent = "Es una cuenta aparte: no se mezcla con la caja ni con el reparto del día.";
      prestTipo = "prestamo"; drawPrestTipo(); cerrarPrest();
      await cargarDia(true); S.movs = null;
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
      const subido = await guardarRegistro(p);
      toast(subido ? `${S.veh} ${money(valor)} guardado` : `Sin señal: ${S.veh} ${money(valor)} guardado en el celular, se sube solo`);
      avisarVenta(S.veh, valor, S.pago === "Transferencia", `Agregaste ${ARTICULO[S.veh] || S.veh} por valor de ${valorHablado(valor)}${S.pago === "Transferencia" ? ", por transferencia" : ""}.`);
      setValor(0); S.pago = "Efectivo"; renderForm();
      renderDia();
      if (subido) await cargarDia(true);
    } catch (e) {
      hint.textContent = "No se guardó. " + e.message;
    } finally { guardando = false; $("guardar").disabled = false; }
  });

  // ---------- Historial ----------
  async function cargarHist() {
    if (!esDueno()) return;
    try {
      const desde = shiftDate(S.hoy, -90);
      const [r, sal] = await Promise.all([
        rpc("exportar", { p_pin: S.pin, p_desde: desde, p_hasta: S.hoy }),
        rpc("saldo_prestamos", { p_pin: S.pin, p_fecha: S.hoy }).catch(() => null)
      ]);
      const map = {};
      (r.registros || []).forEach(x => { (map[x.fecha] = map[x.fecha] || []).push(x); });
      S.saldoActual = sal && typeof sal.saldo === "number" ? sal.saldo : null;
      S.dias = Object.keys(map).sort().reverse().map(f => {
        const t = totals(map[f]); const rp = calcReparto(t);
        return { fecha: f, ventas: t.total, prest: t.prest, abonos: t.abonos, carros: t.vehiculos, transf: t.transf, entregar: rp.entregar, mitad: rp.mitad };
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
    $("sPrest").textContent = S.saldoActual == null ? "—" : money(S.saldoActual);
    $("sPrestc").textContent = S.saldoActual == null ? "activa el saldo en Supabase" : (S.saldoActual > 0 ? "préstamos menos abonos" : "no debe nada");
    const days = []; for (let i = 13; i >= 0; i--) days.push(shiftDate(hoy, -i));
    const max = Math.max(1, ...days.map(v));
    $("bars").innerHTML = days.map(f => `<div class="b ${f === hoy ? "hoy" : ""}" title="${esc(prettyDate(f))}: ${money(v(f))}"><i style="height:${(v(f) / max * 100).toFixed(1)}%"></i></div>`).join("");
    $("axis").innerHTML = days.map(f => `<span>${Number(f.slice(8))}</span>`).join("");
    $("histBody").innerHTML = S.dias.length ? S.dias.map(d => {
      const ok = alDia() && d.fecha <= alDia();
      const prest = d.prest || d.abonos ? [d.prest ? "préstamo " + money(d.prest) : "", d.abonos ? "abono " + money(d.abonos) : ""].filter(Boolean).join(" · ") : "";
      return `<button type="button" class="hdia" data-f="${d.fecha}">
        <span class="hdia-top"><b>${esc(prettyDate(d.fecha, { weekday: "short", day: "numeric", month: "short" }))}</b><b class="hdia-total">${money(Number(d.ventas))}</b></span>
        <span class="hdia-sub">${d.carros} ${d.carros === 1 ? "vehículo" : "vehículos"} · ${d.entregar < 0 ? "le debes " : "te debe "}${money(Math.abs(d.entregar))}${prest ? " · " + prest : ""}</span>
        <span class="hdia-est ${ok ? "pos" : "neg"}">${ok ? "✓ Al día" : "Pendiente"}</span>
      </button>`;
    }).join("") : `<p class="hint" style="padding:0 16px">Aún no hay días registrados.</p>`;
    $("histBody").querySelectorAll(".hdia").forEach(b => b.addEventListener("click", () => { setTab("dia"); setFecha(b.dataset.f); window.scrollTo(0, 0); }));
  }

  // ---------- Ajustes ----------
  let tdDraft = "dueno";
  function renderCfgEditor() {
    $("cfgNombre").value = S.cfg.nombre;
    $("cfgTrab").value = nombreTrab();
    tdDraft = transfDestino(); drawTd();
    if (!$("expDesde").value) { $("expDesde").value = S.hoy.slice(0, 8) + "01"; $("expHasta").value = S.hoy; }
  }
  function drawTd() { document.querySelectorAll("#transfDest .opt").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.td === tdDraft))); }
  document.querySelectorAll("#transfDest .opt").forEach(b => b.addEventListener("click", () => { tdDraft = b.dataset.td; drawTd(); }));
  $("saveCfg").addEventListener("click", async () => {
    const nombre = $("cfgNombre").value.trim();
    try {
      const servicios = (S.cfg.servicios || []).filter(x => !(x && x.tipo === "ajuste")).concat([Object.assign({}, ajustes(), { tipo: "ajuste", transf: tdDraft, trabajador: $("cfgTrab").value.trim() || "Mauricio" })]);
      await rpc("guardar_config", { p_pin: S.pin, p_nombre: nombre, p_servicios: servicios });
      S.cfg.nombre = nombre; S.cfg.servicios = servicios; renderBrand(); renderDia(); toast("Guardado");
    } catch (e) { toast(e.message); }
  });

  $("pinNuevo").addEventListener("input", e => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); });
  $("cambiarPin").addEventListener("click", async () => {
    const rol = $("pinRol").value, nuevo = $("pinNuevo").value;
    try {
      await rpc("cambiar_pin", { p_pin: S.pin, p_rol: rol, p_nuevo: nuevo });
      if (rol === "dueno") { S.pin = nuevo; lsSet("lav_pin", nuevo); activarAvisos(); }
      $("pinNuevo").value = "";
      toast(rol === "dueno" ? "Tu PIN cambió" : "PIN del trabajador cambiado. Dáselo en persona.");
    } catch (e) { toast(e.message); }
  });

  // ---------- Compartir la app ----------
  const URL_APK = "https://franyer98.github.io/lavadero-web/CajaLavadero.apk";
  const URL_WEB = "https://franyer98.github.io/lavadero-web/";
  $("compartirApp").addEventListener("click", async () => {
    const nombre = nombreTrab() || "";
    const negocio = S.cfg.nombre || "el lavadero";
    const texto = `Hola${nombre ? " " + nombre : ""}, esta es la app de la caja de ${negocio}.\n\n` +
      `1. Descárgala aquí: ${URL_APK}\n` +
      `2. Ábrela e instálala (si el celular pregunta, permite instalar apps de este origen).\n` +
      `3. Entra con el PIN que te doy en persona.\n\n` +
      `Si no la puedes instalar, también funciona desde el navegador: ${URL_WEB}`;
    const C = window.Capacitor, P = C && C.Plugins;
    try {
      if (P && P.Share && C.isNativePlatform && C.isNativePlatform()) {
        await P.Share.share({ title: "App de la caja", text: texto, dialogTitle: "Compartir la app" });
      } else if (navigator.share) {
        await navigator.share({ title: "App de la caja", text: texto });
      } else {
        await navigator.clipboard.writeText(texto);
        $("compartirHint").textContent = "Mensaje copiado. Pégalo en WhatsApp para enviárselo.";
      }
    } catch (e) {
      try { await navigator.clipboard.writeText(texto); $("compartirHint").textContent = "Mensaje copiado. Pégalo en WhatsApp para enviárselo."; }
      catch (_) { $("compartirHint").textContent = "Envíale este enlace: " + URL_APK; }
    }
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
      const lines = [head.join(";")].concat(rows.map(x => x.tipo === "gasto" ? [x.fecha, x.hora, (esAbono(x) ? "Abono préstamo" : "Préstamo trabajador") + (x.nota ? " (" + x.nota + ")" : ""), esAbono(x) ? x.valor : -x.valor, "Préstamos (aparte)"] : [x.fecha, x.hora, x.vehiculo, x.valor, x.pago]).map(r => r.map(csvCell).join(";")));
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
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  $("appVer").textContent = "Versión " + APP_VERSION;
  $("appVer2").textContent = "Versión " + APP_VERSION;
  if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY || CFG.SUPABASE_KEY.startsWith("PEGAR")) {
    mostrarLogin(); $("loginErr").textContent = "Falta configurar la conexión (config.js).";
  } else if (S.pin) {
    mostrarLogin(); $("loginErr").textContent = "Entrando…"; entrar(S.pin);
  } else {
    mostrarLogin();
  }
})();
