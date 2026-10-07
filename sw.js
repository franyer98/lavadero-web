// Guarda la app en el celular para que abra sin internet.
// Pantallas y código: primero internet (para recibir cambios), si no hay, la copia guardada.
// Fotos y voz: primero la copia guardada (no cambian).
const VERSION = "2026-10-07 18:48";
const CACHE = "caja-" + VERSION;
const BASE = new URL("./", self.location).pathname;
const NUCLEO = ["", "index.html", "app.js", "app.css", "config.js", "logo.png", "icon-192.png",
  "fotos/carro.jpg", "fotos/moto.jpg", "fotos/mototaxi.jpg", "fotos/turbo.jpg", "fotos/motocarguero.jpg",
  "voz/intro_carro.mp3", "voz/intro_moto.mp3", "voz/intro_mototaxi.mp3", "voz/intro_turbo.mp3", "voz/intro_motocarguero.mp3",
  "voz/transferencia.mp3"].map(p => BASE + p);
for (let n = 1; n <= 60; n++) NUCLEO.push(BASE + "voz/m" + n + ".mp3");

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(NUCLEO.map(u => c.add(new Request(u, { cache: "reload" })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith("caja-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return;   // Supabase y otros: directo
  if (url.pathname.endsWith(".apk")) return;
  const estatico = /\/(fotos|voz)\/|\.(png|jpg|mp3)$/.test(url.pathname);
  if (estatico) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then(r => r || fetch(req).then(res => {
      if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(req, copia)); }
      return res;
    })));
    return;
  }
  // Primero internet, pero si la señal está lenta (más de 3 s) abre con la copia guardada
  // para no dejar la pantalla en negro. La app se actualiza sola cuando mejora la señal.
  const nav = req.mode === "navigate";
  const copiaGuardada = () => caches.match(req, { ignoreSearch: true }).then(r => r || (nav ? caches.match(BASE + "index.html") : undefined));
  const red = fetch(req, { cache: "no-store" }).then(res => {
    if (res.ok) { const copia = res.clone(); caches.open(CACHE).then(c => c.put(url.pathname === BASE ? BASE + "index.html" : req, copia)); }
    return res;
  });
  e.respondWith((async () => {
    try {
      const r = await Promise.race([red, new Promise(ok => setTimeout(() => ok(null), 3000))]);
      if (r) return r;
      const c = await copiaGuardada();
      return c || await red;
    } catch (err) {
      const c = await copiaGuardada();
      if (c) return c;
      throw err;
    }
  })());
});
