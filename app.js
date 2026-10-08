(function () {
  "use strict";
  const CFG = window.LAVADERO_CONFIG || {};
  const TZ = "America/Bogota";
  const VEHICULOS = ["Carro", "Moto", "Mototaxi", "Turbo", "Motocarguero"];
  const PLURAL = { Carro: "carros", Moto: "motos", Mototaxi: "mototaxis", Turbo: "turbos", Motocarguero: "motocargueros" };
  const PAGOS = ["Efectivo", "Nequi", "Daviplata", "Transferencia"];
  const GASTOS = ["Jabón/insumos", "Almuerzo", "Agua/luz", "Pago trabajador", "Otro"];
  const APP_VERSION = "2026-10-07 19:30";
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
    $("tabs").hidden = false;
    $("tab-dia").textContent = esDueno() ? "Caja" : "Registrar";
    $("whoRol").textContent = esDueno() ? "Dueño" : "Trabajador";
    $("fecha").value = S.fecha;
    setTab(esDueno() ? (["dia", "hist", "aj"].includes(lsGet("lav_tab")) ? lsGet("lav_tab") : "dia") : "dia");
    renderBrand(); renderForm(); renderDia(); cerrarPrest(); activarAvisos(); renderCola(); subirCola();
    S.deudas = null; renderDeudas(); cargarDeudas();
    cargarDia();
    clearInterval(timer);
    timer = setInterval(() => { if (!document.hidden) refrescar(); }, REFRESCO_MS);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.rol) refrescar(); });
  function refrescar() { subirCola(); cargarDia(true); if (S.tab === "hist") cargarHist(); }

  function setTab(t) {
    S.tab = t;
    document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    $("view-dia").hidden = t !== "dia" && t !== "cta";
    document.body.classList.toggle("trab-reg", !esDueno() && t === "dia");
    document.body.classList.toggle("trab-cta", !esDueno() && t === "cta"); $("view-hist").hidden = t !== "hist"; $("view-aj").hidden = t !== "aj"; $("view-gan").hidden = t !== "gan";
    lsSet("lav_tab", t);
    if (t === "hist") cargarHist();
    if (t === "aj") { renderCfgEditor(); verEstadoSql(); }
    if (t === "gan") { renderGanancias(); cargarGanancias(); }
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
          const x = delTrab[0];
          toast(x.tipo === "gasto"
            ? `El trabajador registró ${esAbono(x) ? "un abono" : "un préstamo"} de ${money(x.valor)}`
            : `El trabajador agregó ${ARTICULO[x.vehiculo] || x.vehiculo} de ${money(x.valor)}${delTrab.length > 1 ? ` (+${delTrab.length - 1} más)` : ""}`);
        }
      }
      S.vistos = new Set(nuevos.map(x => x.id)); S.vistosFecha = f;
      if (esDueno()) cargarCambios(f, r.hoy);
      S.registrosServidor = nuevos; S.hoy = r.hoy;
      if (f === r.hoy) lsSet("lav_dia", JSON.stringify({ fecha: f, registros: nuevos }));
      subirCola();
      if (!esDueno()) S.fecha = r.fecha;
      const nuevoCfg = normCfg(r.config);
      if (JSON.stringify(nuevoCfg) !== JSON.stringify(S.cfg)) { S.cfg = nuevoCfg; renderBrand(); renderForm(); }
      banner("");
      $("syncState").textContent = "Actualizado " + new Date().toLocaleTimeString("es-CO", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
      if (S.edit && silencioso) return; // no interrumpir mientras se edita
      if (!silencioso || !S.cuentasT || Date.now() - S.cuentasT > 60000) { S.cuentasT = Date.now(); cargarCuentas(); cargarDeudas(); if (!esDueno()) cargarGanancias(); }
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

  // ---------- Confirmar transferencias (el dueño, a mano) ----------
  const confirmadaManual = r => !!r.confirmada && Number(r.confirmada_valor) === Number(r.valor);
  const transfConfirmada = confirmadaManual;
  function etiquetaConf(r) {
    if (r.pendiente) return "";
    return confirmadaManual(r) ? ' <span class="tag nq-ok">✓ Confirmada</span>' : ' <span class="tag nq-esp">Por confirmar</span>';
  }
  function renderNequiRes(regs) {
    const el = $("nequiRes");
    const trs = (regs || []).filter(r => r.tipo !== "gasto" && r.pago === "Transferencia");
    if (!trs.length) { el.hidden = true; return; }
    const ok = trs.filter(transfConfirmada).length;
    el.hidden = false;
    el.className = "nequi-res " + (ok === trs.length ? "todo" : "falta");
    el.textContent = ok === trs.length ? `✓ ${ok === 1 ? "Confirmada" : "Todas confirmadas"}` : `${ok} de ${trs.length} confirmadas`;
  }

  async function verEstadoSql() {
    const el = $("sqlEstado");
    try {
      const r = await rpc("estado_sql", { p_pin: S.pin });
      el.innerHTML = `<span class="nq-activo">✓ Funcionando</span> Último cambio aplicado solo: <b>${esc(String(r.ultima || "").replace(/\.sql$/, "").replace(/^\d+_/, "").replace(/_/g, " "))}</b> (${esc(r.cuando || "")}).`;
    } catch (e) { el.textContent = "Aún no hay cambios aplicados automáticamente."; }
  }

  // ---------- Registro de cambios (solo el dueño) ----------
  function textoCambio(c) {
    const a = c.antes || {}, d = c.despues || {};
    const pago = p => (p || "").toLowerCase();
    if (c.accion === "borrar") return `Borró ${a.vehiculo || "un lavado"} de ${money(a.valor)} (${pago(a.pago)})`;
    const partes = [];
    if (a.vehiculo !== d.vehiculo) partes.push(`${a.vehiculo} → ${d.vehiculo}`);
    if (a.valor !== d.valor) partes.push(`${money(a.valor)} → ${money(d.valor)}`);
    if (a.pago !== d.pago) partes.push(`${a.pago} → ${d.pago}`);
    return `Corrigió ${a.vehiculo || "un lavado"}: ${partes.join(" · ") || "sin cambios"}`;
  }
  async function cargarCambios(f, hoy) {
    try {
      const r = await rpc("ver_cambios", { p_pin: S.pin, p_fecha: f });
      if (f !== S.fecha) return;
      const lista = r.cambios || [];
      if (f === hoy) {
        const maxId = lista.reduce((m, c) => Math.max(m, c.id), 0);
        const visto = Number(lsGet("lav_cambio_visto") || 0);
        const nuevos = lista.filter(c => c.id > visto);
        if (lsGet("lav_cambio_visto") != null && nuevos.length) {
          campanita();
          toast(`${nombreTrab() || "El trabajador"} ${textoCambio(nuevos[0]).replace(/^./, m => m.toLowerCase())}${nuevos.length > 1 ? ` (+${nuevos.length - 1} más)` : ""}`);
        }
        if (maxId > visto || lsGet("lav_cambio_visto") == null) lsSet("lav_cambio_visto", String(Math.max(maxId, visto)));
      }
      S.cambios = lista;
    } catch (e) { S.cambios = []; }   // si aún no se activó en Supabase, no se muestra nada
    renderCambios();
  }
  function renderCambios() {
    const box = $("cambiosBox"), lista = esDueno() ? (S.cambios || []) : [];
    box.hidden = !lista.length;
    if (!lista.length) return;
    $("cambiosBox").querySelector("h2").firstChild.textContent = `Cambios de ${nombreTrab() || "el trabajador"} `;
    $("cambiosSub").textContent = `${lista.length} ${lista.length === 1 ? "cambio" : "cambios"} este día`;
    $("cambiosLista").innerHTML = lista.map(c => {
      const reg = (c.antes && c.antes.hora) ? ` · lavado de las ${esc(String(c.antes.hora).slice(0, 5))}` : "";
      return `<div class="cambio cambio-${c.accion === "borrar" ? "borrar" : "editar"}">
        <span class="cambio-hora">${esc(c.hora)}</span>
        <span class="cambio-txt"><b>${c.accion === "borrar" ? "Borrado" : "Corrección"}</b>${reg}<br>${esc(textoCambio(c))}</span>
      </div>`;
    }).join("");
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
  // ---------- Mis ganancias (solo el trabajador, solo vista) ----------
  async function cargarGanancias() {
    try {
      const r = await rpc("mis_ganancias", { p_pin: S.pin, p_desde: shiftDate(S.hoy, -370), p_hasta: S.hoy });
      S.ganDias = r.dias || [];
    } catch (e) { if (!S.ganDias) S.ganDias = null; }   // si aún no se activó en Supabase, no se muestra
    renderGanancias();
  }
  // Número que sube contando, para que se sienta el aumento
  function contarHasta(el, valor) {
    const desde = Number(el.dataset.v || 0);
    el.dataset.v = String(valor);
    if (!desde || desde === valor || matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = money(valor); return; }
    const t0 = performance.now(), dur = 1200;
    const paso = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = money(Math.round(desde + (valor - desde) * e)); if (k < 1) requestAnimationFrame(paso); };
    requestAnimationFrame(paso);
  }
  function renderGanancias() {
    const box = $("ganBox");
    if (esDueno() || !S.ganDias) { box.hidden = true; return; }
    box.hidden = false;
    const hoy = S.hoy;
    const ventas = {}; S.ganDias.forEach(d => { ventas[d.fecha] = { v: Number(d.ventas) || 0, n: Number(d.carros) || 0 }; });
    if (typeof S.totHoy === "number") ventas[hoy] = { v: S.totHoy, n: (ventas[hoy] || {}).n || 0 };
    const mitad = f => (ventas[f] ? ventas[f].v / 2 : 0);
    const dow = new Date(hoy + "T12:00:00Z").getUTCDay();
    const lunes = shiftDate(hoy, -((dow + 6) % 7));
    const mes = hoy.slice(0, 7);
    const [y, m] = mes.split("-").map(Number);
    const mesAnt = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
    let sem = 0, mesT = 0, antT = 0, antHastaHoy = 0;
    const diaHoy = Number(hoy.slice(8));
    Object.keys(ventas).forEach(f => {
      const g = mitad(f);
      if (f >= lunes && f <= hoy) sem += g;
      if (f.startsWith(mes)) mesT += g;
      if (f.startsWith(mesAnt)) { antT += g; if (Number(f.slice(8)) <= diaHoy) antHastaHoy += g; }
    });
    const nomMes = k => { const [a, b] = k.split("-").map(Number); const n = new Date(Date.UTC(a, b - 1, 15)).toLocaleDateString("es-CO", { month: "long", timeZone: "UTC" }); return n.charAt(0).toUpperCase() + n.slice(1) + (a !== y ? " " + a : ""); };
    $("gMesL").textContent = "Tu ganancia de " + nomMes(mes).toLowerCase();
    contarHasta($("gMes"), mesT);
    const gHoy = mitad(hoy);
    $("gHoyChip").hidden = !gHoy;
    $("gHoyChip").textContent = `▲ +${money(gHoy)} hoy`;
    if (S.ganUltHoy != null && gHoy > S.ganUltHoy) {   // acaba de sumar: que se note
      const chip = $("gHoyChip"); chip.classList.remove("salta"); void chip.offsetWidth; chip.classList.add("salta");
    }
    S.ganUltHoy = gHoy;
    // Curva acumulada del mes (y la del mes pasado, punteada, para comparar)
    const diasMes = (a, b) => new Date(Date.UTC(a, b, 0)).getUTCDate();
    const [ya, ma] = mesAnt.split("-").map(Number);
    const nAct = diasMes(y, m), nAnt = diasMes(ya, ma);
    const acum = (k, n, hasta) => { const out = []; let t = 0; for (let d = 1; d <= hasta; d++) { t += mitad(`${k}-${String(d).padStart(2, "0")}`); out.push(t); } return out; };
    // El gráfico muestra solo lo que va del mes (se llena a medida que avanza)
    const n = Math.max(diaHoy, 7);
    const cur = acum(mes, nAct, diaHoy), ant = acum(mesAnt, nAnt, Math.min(diaHoy, nAnt));
    const W = 320, H = 150, pl = 8, pr = 8, pt = 16, pb = 22;
    const max = Math.max(1, ...cur, ...ant.slice(0, diaHoy)) * 1.12;
    const X = d => pl + (d - 1) / (n - 1) * (W - pl - pr), Y = v => pt + (1 - v / max) * (H - pt - pb);
    const linea = arr => arr.map((v, i) => `${i ? "L" : "M"}${X(i + 1).toFixed(1)},${Y(v).toFixed(1)}`).join("");
    const area = cur.length ? `${linea(cur)}L${X(cur.length).toFixed(1)},${Y(0)}L${X(1).toFixed(1)},${Y(0)}Z` : "";
    const barras = cur.map((v, i) => { const g = v - (i ? cur[i - 1] : 0); if (!g) return ""; const hgt = Math.max(2, g / max * (H - pt - pb)); return `<rect class="gb" x="${(X(i + 1) - 2.5).toFixed(1)}" y="${(Y(0) - hgt).toFixed(1)}" width="5" height="${hgt.toFixed(1)}" rx="1.5"/>`; }).join("");
    const ux = X(cur.length || 1), uy = Y(cur[cur.length - 1] || 0);
    $("gGraf").innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Ganancia acumulada de ${esc(nomMes(mes))}">
      <defs><linearGradient id="gGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2EAA6E" stop-opacity=".45"/><stop offset="1" stop-color="#2EAA6E" stop-opacity=".05"/></linearGradient></defs>
      <line class="ge" x1="${pl}" x2="${W - pr}" y1="${Y(0)}" y2="${Y(0)}"/>
      ${ant.some(v => v) ? `<path class="ga" d="${linea(ant)}"/>` : ""}
      ${barras}
      ${area ? `<path d="${area}" fill="url(#gGrad)"/><path class="gl" d="${linea(cur)}"/>` : ""}
      <circle class="gp" cx="${ux}" cy="${uy}" r="5"/>
      ${Array.from({ length: diaHoy }, (_, i) => i + 1).filter(d => d === diaHoy || diaHoy <= 12 || d === 1 || d % 5 === 0 && diaHoy - d > 2).map(d =>
        `<text class="gx ${d === diaHoy ? "ghoy" : ""}" x="${X(d)}" y="${H - 6}" text-anchor="${d === 1 && d !== diaHoy ? "start" : (d === diaHoy && X(d) > W * 0.85 ? "end" : "middle")}">${d === diaHoy ? "hoy " + d : d}</text>`).join("")}
      <text class="gv" x="${Math.min(ux + 9, W - pr)}" y="${Math.max(12, uy - 8)}" text-anchor="${ux > W * 0.6 ? "end" : "start"}">${esc(money(cur[cur.length - 1] || 0))}</text>
    </svg>
    <div class="gan-ley"><span class="lc"></span> ${esc(nomMes(mes))} &nbsp; ${ant.some(v => v) ? `<span class="la"></span> ${esc(nomMes(mesAnt))}` : ""} &nbsp; <span class="lb"></span> lo de cada día</div>`;
    if (antT > 0) {
      const dif = mesT - antHastaHoy;
      $("gComp").innerHTML = dif > 0 ? `<b class="gan-up">▲ ${esc(money(dif))}</b> más que a esta misma fecha de ${esc(nomMes(mesAnt).toLowerCase())}. ¡Sigue así!`
        : dif < 0 ? `Te faltan <b>${esc(money(-dif))}</b> para alcanzar lo que llevabas a esta fecha de ${esc(nomMes(mesAnt).toLowerCase())}. ¡Tú puedes!`
        : `Vas igual que a esta misma fecha de ${esc(nomMes(mesAnt).toLowerCase())}.`;
    } else $("gComp").textContent = "Tu ganancia es la mitad de lo que se lava cada día. Cada lavado la hace crecer.";
    // Lista día a día del mes (más reciente arriba) con barra proporcional
    const diasConV = [];
    for (let d = diaHoy; d >= 1; d--) { const f = `${mes}-${String(d).padStart(2, "0")}`; if (mitad(f) > 0 || f === hoy) diasConV.push(f); }
    const maxDia = Math.max(1, ...diasConV.map(mitad));
    $("gDdT").textContent = "Día a día de " + nomMes(mes).toLowerCase();
    $("gDd").innerHTML = diasConV.map(f => {
      const g = mitad(f), n = (ventas[f] || {}).n || 0;
      const fecha = f === hoy ? "Hoy" : new Date(f + "T12:00:00Z").toLocaleDateString("es-CO", { weekday: "short", timeZone: "UTC" }).replace(".", "") + " " + Number(f.slice(8));
      return `<div class="gdd ${f === hoy ? "hoy" : ""}"><span class="gdd-f">${esc(fecha)}<small>${n ? `${n} ${n === 1 ? "lavado" : "lavados"}` : "sin lavados aún"}</small></span>
        <span class="gdd-b"><i style="width:${(g / maxDia * 100).toFixed(1)}%"></i></span><b>+${esc(money(g))}</b></div>`;
    }).join("") || `<p class="hint">Aún no hay lavados este mes.</p>`;
    const porMes = {};
    Object.keys(ventas).forEach(f => { const k = f.slice(0, 7); if (k !== mes) porMes[k] = (porMes[k] || 0) + mitad(f); });
    const meses = Object.keys(porMes).filter(k => porMes[k] > 0).sort().reverse();
    $("gDias").innerHTML = meses.map(k => `<div><dt>${esc(nomMes(k))}</dt><dd>${money(porMes[k])}</dd></div>`).join("") || `<p class="hint">Aún no hay meses anteriores.</p>`;
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
    const lista = c.dias.map(d => { const v = Math.round(calcReparto(d.t).entregar); return `<div class="fila fila-${claseFavor(v) || "cero"}"><dt>${esc(corto(d.f))}</dt><dd class="txt-${claseFavor(v)}">${quien(v)}</dd></div>`; }).join("");
    const total = Math.round(c.debe);
    const textoTotal = total >= 0
      ? (soloVer ? "le debes entregar al dueño" : "te debe entregar")
      : (soloVer ? "el dueño te debe" : "tú le debes al trabajador");
    box.innerHTML = `<h2>Cuentas pendientes</h2>
      <div class="cta-linea">${c.desde ? `Al día hasta <b>${esc(prettyDate(c.desde, { weekday: "long", day: "numeric", month: "long" }))}</b>` : (soloVer ? "El dueño aún no ha marcado hasta qué día están al día." : "Aún no has marcado hasta qué día están al día.")}</div>
      ${c.dias.length ? `<dl>${lista}</dl>
        <div class="debe ${claseFavor(total)}"><span>${c.dias.length} ${c.dias.length === 1 ? "día" : "días"} sin cuadrar · ${textoTotal}</span><b>${money(Math.abs(total))}</b></div>
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
    try { await guardarAjuste({ alDia: f, alDiaCuando: new Date().toISOString() }); toast("Cuentas al día hasta " + prettyDate(f, { day: "numeric", month: "long" })); await cargarCuentas(); if (S.tab === "hist") renderHist(); }
    catch (e) { toast(e.message); }
  }

  // v = lo que el trabajador le entrega al dueño. Verde si favorece a quien mira, rojo si debe.
  function claseFavor(v) {
    v = Math.round(v || 0);
    if (!v) return "";
    return (esDueno() ? v > 0 : v < 0) ? "favor" : "contra";
  }

  // ---------- Celebración (globos, confeti y fanfarria) ----------
  function fanfarria() {
    try {
      prepararAudio(); if (!audioCtx) return;
      const t0 = audioCtx.currentTime + 0.05;
      const nota = (f, t, d, tipo = "triangle", vol = 0.25) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.type = tipo; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + t);
        g.gain.exponentialRampToValueAtTime(vol, t0 + t + 0.03);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + t + d);
        o.connect(g).connect(audioCtx.destination); o.start(t0 + t); o.stop(t0 + t + d + 0.05);
      };
      // ta-ta-ta-taaa (Do Mi Sol Do') y acorde final
      [[523, 0, .16], [659, .16, .16], [784, .32, .16], [1047, .48, .5]].forEach(([f, t, d]) => nota(f, t, d, "square", 0.12));
      [523, 659, 784, 1047].forEach(f => nota(f, 1.0, 1.4, "triangle", 0.14));
      // chispitas
      for (let i = 0; i < 8; i++) nota(1500 + Math.random() * 1500, 1.1 + i * 0.12, 0.12, "sine", 0.05);
      if (navigator.vibrate) navigator.vibrate([120, 80, 120, 80, 300]);
    } catch (e) {}
  }
  function celebrar(titulo, sub) {
    if (document.getElementById("fiesta")) return;
    const ok = document.getElementById("okLavado"); if (ok) ok.remove();
    fanfarria();
    const capa = document.createElement("div");
    capa.id = "fiesta";
    capa.innerHTML = `<canvas></canvas><div class="fiesta-msg"><div class="fiesta-t">${esc(titulo)}</div><div class="fiesta-s">${esc(sub)}</div><div class="fiesta-x">Toca para cerrar</div></div>`;
    document.body.appendChild(capa);
    const cv = capa.querySelector("canvas"), cx = cv.getContext("2d");
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = () => cv.width / dpr, H = () => cv.height / dpr;
    const ajustar = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    ajustar(); addEventListener("resize", ajustar);
    const colores = ["#F2B705", "#E63946", "#2A9D8F", "#3A86FF", "#FF006E", "#8338EC", "#FB5607", "#06D6A0"];
    const quieto = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const globos = Array.from({ length: 14 }, (_, i) => ({
      x: Math.random() * W(), y: H() + 40 + Math.random() * H() * 0.6, r: 22 + Math.random() * 16,
      v: 1.2 + Math.random() * 1.6, f: Math.random() * 6.28, c: colores[i % colores.length]
    }));
    const confeti = Array.from({ length: 160 }, () => ({
      x: Math.random() * W(), y: -20 - Math.random() * H(), w: 6 + Math.random() * 6, h: 8 + Math.random() * 8,
      v: 2 + Math.random() * 3, rot: Math.random() * 6.28, vr: (Math.random() - .5) * .3, dx: (Math.random() - .5) * 1.5,
      c: colores[Math.floor(Math.random() * colores.length)]
    }));
    let fin = false, t = 0;
    const cerrar = () => { if (fin) return; fin = true; capa.classList.add("sale"); removeEventListener("resize", ajustar); setTimeout(() => capa.remove(), 400); };
    capa.addEventListener("click", cerrar);
    setTimeout(cerrar, 7000);
    function globo(g) {
      const x = g.x + Math.sin(g.f + t / 30) * 12;
      cx.strokeStyle = "rgba(255,255,255,.7)"; cx.lineWidth = 1.2;
      cx.beginPath(); cx.moveTo(x, g.y + g.r * 1.2);
      cx.quadraticCurveTo(x + 8, g.y + g.r * 2, x - 4, g.y + g.r * 3); cx.stroke();
      cx.fillStyle = g.c; cx.beginPath(); cx.ellipse(x, g.y, g.r * .85, g.r * 1.1, 0, 0, 6.29); cx.fill();
      cx.beginPath(); cx.moveTo(x - 5, g.y + g.r * 1.1); cx.lineTo(x + 5, g.y + g.r * 1.1); cx.lineTo(x, g.y + g.r * 1.3); cx.fill();
      cx.fillStyle = "rgba(255,255,255,.45)"; cx.beginPath(); cx.ellipse(x - g.r * .3, g.y - g.r * .4, g.r * .18, g.r * .3, -.4, 0, 6.29); cx.fill();
    }
    function cuadro() {
      if (fin) return;
      t++;
      cx.clearRect(0, 0, W(), H());
      confeti.forEach(p => {
        if (!quieto) { p.y += p.v; p.x += p.dx + Math.sin((t + p.y) / 40); p.rot += p.vr; if (p.y > H() + 20) { p.y = -20; p.x = Math.random() * W(); } }
        cx.save(); cx.translate(p.x, p.y); cx.rotate(p.rot); cx.fillStyle = p.c; cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); cx.restore();
      });
      globos.forEach(g => { if (!quieto) { g.y -= g.v; if (g.y < -g.r * 4) { g.y = H() + g.r * 2; g.x = Math.random() * W(); } } globo(g); });
      requestAnimationFrame(cuadro);
    }
    requestAnimationFrame(cuadro);
  }

  // ---------- Meta diaria ----------
  const metaDiaria = () => Number(ajustes().meta) || 100000;
  function renderMeta(total) {
    const meta = metaDiaria(), pct = Math.min(100, Math.round(total / meta * 100));
    const lograda = total >= meta;
    $("metaRelleno").style.width = pct + "%";
    $("metaBarra").setAttribute("aria-valuenow", String(pct));
    $("metaBox").classList.toggle("lograda", lograda);
    $("metaTxt").textContent = lograda
      ? (total > meta ? `¡Meta cumplida! Van ${money(total - meta)} por encima` : "¡Meta cumplida!")
      : `Meta del día: faltan ${money(meta - total)} de ${money(meta)}`;
    $("metaPct").textContent = lograda ? "✓" : pct + "%";
    // Celebrar una sola vez por día cuando se cruza la meta
    const k = "lav_meta_" + S.fecha;
    if (lograda && S.fecha === S.hoy && S.metaPrevia === false && !lsGet(k)) {
      lsSet(k, "1");
      // fiesta y felicitación
      setTimeout(() => {
        celebrar("¡FELICITACIONES!", `Llegaron a la meta del día\n${money(total).replace(/ /g, "\u00a0")} de ${money(meta).replace(/ /g, "\u00a0")}`);
        if (!esDueno()) setTimeout(() => hablar(`${nombreTrab() || ""}, ¡felicitaciones! Llegaron a la meta del día.`), 2600);
      }, 700);
    }
    if (S.fecha === S.hoy) S.metaPrevia = lograda;
  }

  function renderReparto(t) {
    const r = calcReparto(t);
    const filas = [["Mitad del dueño", money(r.mitad)], ["Mitad del trabajador", money(r.mitad)]];
    if (r.dest === "dueno" && t.transf > 0)
      filas.push([esDueno() ? "Transferencias que ya te llegaron" : "Transferencias que ya le llegaron al dueño", "−" + money(t.transf)]);
    $("rLista").innerHTML = filas.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
    const debe = Math.round(r.entregar);
    const caja = document.querySelector("#reparto .debe");
    const nuevosTras = (S.fecha === alDia()) ? (S.registros || []).filter(x => x.tipo !== "gasto" && despuesDeCuadrar(x)) : [];
    if (nuevosTras.length) {
      const rn = calcReparto(totals(nuevosTras)), dn = Math.round(rn.entregar);
      if (caja) { caja.classList.remove("favor", "contra", "saldado"); const cl = claseFavor(dn); if (cl) caja.classList.add(cl); }
      const nl = `${nuevosTras.length} ${nuevosTras.length === 1 ? "lavado" : "lavados"} después de cuadrar`;
      $("rDebeLbl").textContent = dn >= 0 ? (esDueno() ? `${nl} · te debe` : `${nl} · le debes al dueño`) : (esDueno() ? `${nl} · le debes` : `${nl} · el dueño te debe`);
      $("rDebe").textContent = money(Math.abs(dn)); $("rDebe").className = "";
      $("rNota").textContent = "Lo que se hizo antes de marcar al día ya quedó cuadrado; aquí va solo lo nuevo.";
      return;
    }
    const cuadrado = !!alDia() && S.fecha <= alDia();
    if (caja) { caja.classList.remove("favor", "contra", "saldado"); const cl = cuadrado ? (debe ? "saldado" : "") : claseFavor(debe); if (cl) caja.classList.add(cl); }
    if (cuadrado) {
      $("rDebeLbl").textContent = !debe ? "✓ Día cuadrado" : debe > 0
        ? (esDueno() ? "✓ Día cuadrado · ya te entregó" : "✓ Día cuadrado · ya le entregaste")
        : (esDueno() ? "✓ Día cuadrado · ya le pagaste" : "✓ Día cuadrado · ya te pagó");
      $("rDebe").textContent = money(Math.abs(debe)); $("rDebe").className = "";
    } else if (debe >= 0) {
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
    $("saldoMini").textContent = s == null ? "" : (s > 0 ? `debe ${money(s)}` : "al día");
    $("saldoMini").className = s == null ? "saldo-mini" : (s > 0 ? "saldo-mini chip-mini contra" : "saldo-mini chip-mini favor");
  }

  // ¿Se registró después de que el dueño marcó ese día al día?
  function despuesDeCuadrar(r) {
    const c = ajustes().alDiaCuando, t = r && r.creado ? Date.parse(r.creado) : NaN;
    return !!c && r.fecha === alDia() && (r.pendiente || (!isNaN(t) && t > Date.parse(c)));
  }
  function puedeBorrar(r) {
    if (r.pendiente) return false;   // aún no llega al servidor
    if (esDueno()) return true;
    // Mauricio: sus lavados de hoy, mientras el día no esté marcado como al día
    return r.rol === "trabajador" && r.tipo === "venta" && r.fecha === S.hoy && (!(alDia() && r.fecha <= alDia()) || despuesDeCuadrar(r));
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
    renderMeta(t.total);
    if (!esDueno() && S.fecha === S.hoy) { S.totHoy = t.total; renderGanancias(); }
    $("totCarros").textContent = t.vehiculos;
    const orden = VEHICULOS.concat(Object.keys(t.porTipo).filter(k => !VEHICULOS.includes(k)));
    $("totMotos").textContent = orden.filter(k => t.porTipo[k]).map(k => `${t.porTipo[k]} ${t.porTipo[k] === 1 ? k.toLowerCase() : (PLURAL[k] || k.toLowerCase() + "s")}`).join(" · ") || "—";
    $("totEfectivo").textContent = money(t.efectivo);
    $("totTransf").textContent = money(t.transf);
    renderReparto(t);
    const nLav = t.carros + t.motos;
    $("listSub").textContent = regs.length ? `${nLav} ${nLav === 1 ? "lavado" : "lavados"}${(t.prest || t.abonos) ? " · préstamos" : ""} · más reciente arriba` : "";
    $("form").hidden = esDueno() || S.fecha > S.hoy;   // solo el trabajador registra lavados
    const box = $("items");
    if (!regs.length) {
      box.innerHTML = `<div class="empty">${esHoy ? "Todavía no hay lavados hoy." : "No hay registros este día."}</div>`;
      return;
    }
    renderNequiRes(regs);
    box.innerHTML = regs.map(r => {
      const g = r.tipo === "gasto";
      const tr = r.pago === "Transferencia";
      const editando = S.edit && S.edit.id === r.id;
      const what = g
        ? `<b>${esAbono(r) ? "Abono a préstamo" : "Préstamo al trabajador"}</b><span>${esc(r.nota || "")}</span>`
        : `<b>${esc(r.vehiculo || "Carro")}</b><span>${tr ? '<span class="tag tr">Transferencia</span>' : '<span class="tag">Efectivo</span>'}${tr ? etiquetaConf(r) : ""}${r.pendiente ? ' <span class="tag espera">Sin subir</span>' : ""}</span>${esDueno() && tr && !r.pendiente && !editando ? (confirmadaManual(r)
            ? `<button class="conf-btn deshacer" data-act="desconf" data-id="${esc(r.id)}">Quitar confirmación</button>`
            : (transfConfirmada(r) ? "" : `<button class="conf-btn" data-act="conf" data-id="${esc(r.id)}">✓ Confirmar que llegó</button>`)) : ""}`;
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
    if (b.dataset.act === "conf" || b.dataset.act === "desconf") {
      const ok = b.dataset.act === "conf";
      b.disabled = true;
      try {
        const x = await rpc("confirmar_transf", { p_pin: S.pin, p_id: b.dataset.id, p_ok: ok });
        (S.registrosServidor || []).forEach(r => { if (r.id === x.id) Object.assign(r, x); });
        toast(ok ? `Transferencia de ${money(x.valor)} confirmada` : "Confirmación quitada");
        renderDia(); cargarDia(true);
      } catch (e) { toast(e.code === "x_pin" || /function|404/i.test(e.message) ? "Falta activar en Supabase (confirmar.sql)" : e.message); b.disabled = false; }
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
    S.cambios = []; renderCambios();
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

  // ---------- Lo que el dueño le debe al trabajador ----------
  let deuArmado = null, deuEdit = null;
  async function cargarDeudas() {
    try { const r = await rpc("deudas_ver", { p_pin: S.pin }); S.deudas = r.deudas || []; S.deudaPend = Number(r.pendiente) || 0; }
    catch (e) { if (!S.deudas) S.deudas = null; }   // si aún no existe en Supabase, no se muestra
    renderDeudas();
  }
  function renderDeudas() {
    const box = $("deuBox");
    if (!Array.isArray(S.deudas)) { box.hidden = true; return; }
    box.hidden = false;
    const trab = nombreTrab() || "el trabajador", pend = S.deudaPend || 0;
    $("deuTitulo").textContent = esDueno() ? `Lo que le debo a ${trab}` : "Lo que el dueño me debe";
    const mini = $("deuMini");
    mini.textContent = pend ? (esDueno() ? `le debes ${money(pend)}` : `te debe ${money(pend)}`) : "nada pendiente";
    mini.className = "saldo-mini " + (pend ? "chip-mini " + (esDueno() ? "contra" : "favor") : "");
    $("deuTotLbl").textContent = esDueno() ? `Le debes a ${trab}` : "El dueño te debe";
    $("deuTotal").textContent = money(pend);
    $("deuTotal").className = pend ? "deu-tot " + (esDueno() ? "contra" : "favor") : "";
    const fecha = f => new Date(String(f).slice(0, 10) + "T12:00:00Z").toLocaleDateString("es-CO", { day: "numeric", month: "short", timeZone: "UTC" }).replace(".", "");
    $("deuLista").innerHTML = S.deudas.length ? S.deudas.map(d => {
      const pagada = !!d.pagado;
      if (esDueno() && deuEdit === d.id) return `<div class="deu-item deu-edit">
        <label class="field"><span>¿Por qué le debes?</span><input id="deuEdC" maxlength="120" value="${esc(d.concepto)}"></label>
        <label class="field"><span>Valor (en miles)</span><input id="deuEdV" class="money num" inputmode="decimal" value="${pesosAMiles(d.valor)}"></label>
        <div class="deu-acc"><button type="button" class="primary" data-deu="guardar" data-id="${esc(d.id)}">Guardar</button>
          <button type="button" class="linkbtn" data-deu="cancelar" data-id="${esc(d.id)}">Cancelar</button></div>
      </div>`;
      const acciones = !esDueno() ? "" : pagada
        ? `<button type="button" class="linkbtn" data-deu="deshacer" data-id="${esc(d.id)}">Deshacer</button>`
        : `<button type="button" class="conf-btn" data-deu="pagar" data-id="${esc(d.id)}">✓ Pagado</button>
           <button type="button" class="linkbtn" data-deu="editar" data-id="${esc(d.id)}">Editar</button>
           <button type="button" class="linkbtn ${deuArmado === d.id ? "armado" : ""}" data-deu="borrar" data-id="${esc(d.id)}">${deuArmado === d.id ? "¿Borrar? Toca otra vez" : "Borrar"}</button>`;
      return `<div class="deu-item ${pagada ? "pagada" : ""}">
        <div class="deu-txt"><b>${esc(d.concepto)}</b><small>${esc(fecha(d.fecha))}${pagada ? " · pagado el " + esc(fecha(String(d.pagado).slice(0, 10))) : ""}</small></div>
        <div class="deu-der"><span class="deu-val">${money(d.valor)}</span><div class="deu-acc">${acciones}</div></div>
      </div>`;
    }).join("") : `<p class="hint">${esDueno() ? "No le debes nada." : "El dueño no te debe nada."}</p>`;
  }
  $("abrirDeu").addEventListener("click", () => {
    const c = $("deuCuerpo"), open = c.hidden;
    c.hidden = !open; $("abrirDeu").setAttribute("aria-expanded", String(open));
    $("abrirDeu").querySelector(".chev").textContent = open ? "−" : "+";
    if (open) cargarDeudas();
  });
  $("deuForm").addEventListener("submit", async ev => {
    ev.preventDefault();
    const valor = milesAPesos($("deuValor").value), concepto = $("deuConcepto").value.trim();
    if (!valor) { toast("Escribe el valor"); return; }
    if (!concepto) { toast("Escribe por qué le debes"); return; }
    $("deuGuardar").disabled = true;
    try {
      await rpc("deuda_guardar", { p_pin: S.pin, p: { concepto, valor } });
      $("deuValor").value = ""; $("deuConcepto").value = ""; $("deuValor").dispatchEvent(new Event("input", { bubbles: true }));
      toast(`Anotado: le debes ${money(valor)}`); await cargarDeudas();
    } catch (e) { toast(e.message); }
    $("deuGuardar").disabled = false;
  });
  $("deuLista").addEventListener("click", async ev => {
    const b = ev.target.closest("button[data-deu]"); if (!b || !esDueno()) return;
    const id = b.dataset.id, act = b.dataset.deu;
    if (act === "editar") { deuEdit = id; deuArmado = null; renderDeudas(); const i = $("deuEdV"); if (i) i.focus(); return; }
    if (act === "cancelar") { deuEdit = null; renderDeudas(); return; }
    if (act === "guardar") {
      const valor = milesAPesos($("deuEdV").value), concepto = $("deuEdC").value.trim();
      if (!valor) { toast("Escribe el valor"); return; }
      b.disabled = true;
      try { await rpc("deuda_guardar", { p_pin: S.pin, p: { id, concepto: concepto || "Sin concepto", valor } }); deuEdit = null; toast(`Actualizado: ${money(valor)}`); await cargarDeudas(); }
      catch (e) { toast(e.message); b.disabled = false; }
      return;
    }
    if (act === "borrar" && deuArmado !== id) { deuArmado = id; renderDeudas(); setTimeout(() => { if (deuArmado === id) { deuArmado = null; renderDeudas(); } }, 4000); return; }
    b.disabled = true;
    try {
      if (act === "borrar") { await rpc("deuda_borrar", { p_pin: S.pin, p_id: id }); deuArmado = null; toast("Borrado"); }
      else { const x = await rpc("deuda_pagar", { p_pin: S.pin, p_id: id, p_ok: act === "pagar" }); toast(act === "pagar" ? `Pagado: ${money(x.valor)}` : "Vuelve a quedar pendiente"); }
      await cargarDeudas();
    } catch (e) { toast(e.message); b.disabled = false; }
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

  // Ventana de confirmación al guardar un lavado, con frases de ánimo
  const FRASES = [
    "¡Vamos bien, {n}!", "¡Eso es, {n}! Uno más", "¡Buen trabajo, {n}!", "¡Así se hace, {n}!",
    "¡Imparable, {n}!", "¡Dejándolos brillando, {n}!", "¡Otro más a la cuenta, {n}!", "¡Sigue así, {n}!",
    "¡Qué berraquera, {n}!", "¡Con toda, {n}!", "¡Ese es el ritmo, {n}!", "¡Excelente, {n}!",
    "¡Vas volando, {n}!", "¡Brillante como el carro, {n}!", "¡Así se trabaja, {n}!"
  ];
  let fraseAnt = -1;
  function fraseAnimo() {
    let i; do { i = Math.floor(Math.random() * FRASES.length); } while (i === fraseAnt && FRASES.length > 1);
    fraseAnt = i;
    const n = nombreTrab();
    return n ? FRASES[i].replace("{n}", n) : FRASES[i].replace(/,? ?\{n\}/, "");
  }
  function ventanaGuardado(veh, valor, pago, subido, totalDia) {
    const vieja = document.getElementById("okLavado"); if (vieja) vieja.remove();
    const t = { total: totalDia }, meta = metaDiaria();
    const progreso = t.total >= meta ? `¡Meta del día cumplida! Llevan ${money(t.total)}`
      : `Llevan ${money(t.total)} hoy · faltan ${money(meta - t.total)} para la meta`;
    const el = document.createElement("div");
    el.id = "okLavado";
    el.innerHTML = `<div class="ok-card" role="status">
      <div class="ok-foto"><img src="fotos/${esc(String(veh).toLowerCase())}.jpg" alt=""><span class="ok-check">✓</span></div>
      <div class="ok-frase">${esc(fraseAnimo())}</div>
      <div class="ok-det">${esc(veh)} · ${esc(money(valor))} · ${esc(pago)}</div>
      ${subido ? "" : '<div class="ok-sin">Sin señal: quedó guardado en el celular y se sube solo</div>'}
      <div class="ok-prog">${esc(progreso)}</div>
      <div class="ok-bar"><i style="width:${Math.min(100, Math.round(t.total / meta * 100))}%"></i></div>
    </div>`;
    document.body.appendChild(el);
    const cerrar = () => { el.classList.add("sale"); setTimeout(() => el.remove(), 300); };
    el.addEventListener("click", cerrar);
    setTimeout(cerrar, 2600);
  }

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
      const totalAntes = totals(S.registros).total;
      const subido = await guardarRegistro(p);
      const veh = S.veh, pago = S.pago;
      setValor(0); S.pago = "Efectivo"; renderForm();
      renderDia();
      ventanaGuardado(veh, valor, pago, subido, totalAntes + valor);   // sin sonido: ventana de confirmación con ánimo
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
      return `<button type="button" class="hdia hdia-${ok ? "saldado" : (claseFavor(d.entregar) || "cero")}" data-f="${d.fecha}">
        <span class="hdia-top"><b>${esc(prettyDate(d.fecha, { weekday: "short", day: "numeric", month: "short" }))}</b><b class="hdia-total">${money(Number(d.ventas))}</b></span>
        <span class="hdia-sub">${d.carros} ${d.carros === 1 ? "vehículo" : "vehículos"} · <span class="${ok ? "txt-saldado" : "txt-" + claseFavor(d.entregar)}">${ok ? (d.entregar < 0 ? "le debías " : "te debía ") : (d.entregar < 0 ? "le debes " : "te debe ")}${money(Math.abs(d.entregar))}</span>${prest ? " · " + prest : ""}</span>
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
    $("cfgMeta").value = pesosAMiles(metaDiaria());
    tdDraft = transfDestino(); drawTd();
    if (!$("expDesde").value) { $("expDesde").value = S.hoy.slice(0, 8) + "01"; $("expHasta").value = S.hoy; }
  }
  function drawTd() { document.querySelectorAll("#transfDest .opt").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.td === tdDraft))); }
  document.querySelectorAll("#transfDest .opt").forEach(b => b.addEventListener("click", () => { tdDraft = b.dataset.td; drawTd(); }));
  $("saveCfg").addEventListener("click", async () => {
    const nombre = $("cfgNombre").value.trim();
    try {
      const servicios = (S.cfg.servicios || []).filter(x => !(x && x.tipo === "ajuste")).concat([Object.assign({}, ajustes(), { tipo: "ajuste", transf: tdDraft, trabajador: $("cfgTrab").value.trim() || "Mauricio", meta: milesAPesos($("cfgMeta").value) || 100000 })]);
      await rpc("guardar_config", { p_pin: S.pin, p_nombre: nombre, p_servicios: servicios });
      S.cfg.nombre = nombre; S.cfg.servicios = servicios; renderBrand(); renderDia(); toast("Guardado"); activarAvisos();
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

  // ---------- Animación de entrada ----------
  (function intro() {
    const el = document.getElementById("intro"); if (!el) return;
    const quitar = () => { el.classList.add("sale"); setTimeout(() => el.remove(), 500); };
    if (/[?&]v=/.test(location.search)) { el.remove(); return; }   // recarga por actualización: sin animación
    el.addEventListener("click", quitar);
    setTimeout(quitar, 2800);
  })();

  // ---------- Arranque ----------
  if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  // Actualización automática: si hay versión nueva publicada, recarga sola
  // (al volver a la app y cada minuto), sin interrumpir si están escribiendo un valor.
  async function revisarVersion() {
    try {
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(APP_VERSION)) return;   // en pruebas no aplica
      const r = await fetch("version.txt?t=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return;
      const v = (await r.text()).trim();
      const ocupado = $("valor") && $("valor").value.trim() !== "" || document.getElementById("fiesta");
      if (v && v !== APP_VERSION && !ocupado && lsGet("lav_recarga") !== v) {
        lsSet("lav_recarga", v);   // evita recargar en bucle si algo falla
        // dirección única para saltarse la copia vieja que guardan los servidores de GitHub
        location.replace(location.pathname.replace(/index\.html$/, "") + "index.html?v=" + encodeURIComponent(v.replace(" ", "_")));
      }
    } catch (e) {}
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) revisarVersion(); });
  setInterval(revisarVersion, 60 * 1000);
  setTimeout(revisarVersion, 3000);
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
