# Busca fotos con licencia libre en Wikimedia Commons y guarda candidatas en cand/<tipo>/
import json, os, re, urllib.parse, urllib.request
UA = {"User-Agent": "CajaLavadero/1.0 (https://github.com/franyer98/lavadero-web)"}
BUSQUEDAS = {
  "carro": ["Chevrolet Spark GT Colombia", "Renault Logan sedan", "Chevrolet Sail sedan", "Kia Picanto"],
  "moto": ["AKT motorcycle", "Yamaha FZ motorcycle", "Honda CB125F", "Bajaj Pulsar"],
  "mototaxi": ["Bajaj RE auto rickshaw", "mototaxi Colombia", "motocarro Colombia", "Bajaj RE 205"],
  "turbo": ["Chevrolet NPR truck", "Chevrolet NHR truck", "Isuzu NPR box truck", "Hino 300 truck"],
  "motocarguero": ["motocarro de carga", "Bajaj RE cargo", "cargo tricycle motorcycle", "three wheeler cargo truck India"],
}
def api(params):
    url = "https://commons.wikimedia.org/w/api.php?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        return json.load(r)
meta = {}
for tipo, qs in BUSQUEDAS.items():
    os.makedirs(f"cand/{tipo}", exist_ok=True)
    n = 0
    for q in qs:
        d = api({"action": "query", "generator": "search", "gsrsearch": q + " filetype:bitmap", "gsrnamespace": 6,
                 "gsrlimit": 4, "prop": "imageinfo", "iiprop": "url|extmetadata|mime", "iiurlwidth": 480, "format": "json"})
        for p in (d.get("query", {}).get("pages", {}) or {}).values():
            ii = (p.get("imageinfo") or [{}])[0]
            if ii.get("mime") not in ("image/jpeg", "image/png"): continue
            em = ii.get("extmetadata", {})
            lic = em.get("LicenseShortName", {}).get("value", "")
            if not re.search(r"CC|Public domain|PD", lic, re.I): continue
            n += 1
            fn = f"cand/{tipo}/{n:02d}.jpg"
            with urllib.request.urlopen(urllib.request.Request(ii["thumburl"], headers=UA), timeout=60) as r, open(fn, "wb") as f:
                f.write(r.read())
            artist = re.sub(r"<[^>]+>", "", em.get("Artist", {}).get("value", "")).strip()
            meta[fn] = {"q": q, "title": p["title"], "license": lic, "artist": artist, "page": ii.get("descriptionurl"), "thumb": ii["thumburl"]}
            if n >= 12: break
        if n >= 12: break
json.dump(meta, open("cand/meta.json", "w"), ensure_ascii=False, indent=1)
print(len(meta), "fotos")
