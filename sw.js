// Service worker of สมุดรายชื่อ MT5 — keeps the app shell available offline. Hand-written, no libraries.
//
// The app shares its origin with the team's older app (/Mitra-quote/), whose worker deletes every cache that is
// not its own whenever it activates. So this worker assumes its cache can vanish at any moment and puts it back
// (see heal), and it never deletes or reads a cache whose name does not start with 'mt5-names-'.
//
// What it does:
//   install   precache the files of this build (index.html last), then take over without waiting
//   activate  delete older 'mt5-names-' caches — and nothing else — then claim the open pages
//   fetch     non-GET and cross-origin requests (the hub API) are never touched
//             opening the app  → network first; the cached index.html when offline or slow, or when the server
//                                already has a newer build (that one is installed in the background)
//             same-origin files → cache first, else network, and the answer goes back into the cache
//   message   { type: 'mt5-names:heal' } from the page → put back whatever is missing
//
// The block below is replaced at build time (vite.config.ts) with the build id and the list of built files.
/* build:start */
const BUILD = {
  "id": "0.1.0-24sx8wrligp",
  "index": "./index.html",
  "files": [
    "./assets/index-B6v12TwY.js",
    "./assets/mittare-logo-4h5rVKNz.png",
    "./assets/prompt-latin-500-normal-CxzxEHZc.woff2",
    "./assets/prompt-latin-600-normal-hKZWXsc1.woff2",
    "./assets/prompt-latin-700-normal-I2gc831J.woff2",
    "./assets/prompt-thai-500-normal-C18pDUoL.woff2",
    "./assets/prompt-thai-600-normal-MrdfU7zR.woff2",
    "./assets/prompt-thai-700-normal-Cg4aQ0Nn.woff2",
    "./assets/sarabun-latin-400-normal-URPBxl-K.woff2",
    "./assets/sarabun-latin-500-normal-BjUTcdxu.woff2",
    "./assets/sarabun-latin-600-normal-DMD3TROr.woff2",
    "./assets/sarabun-latin-700-normal-DQKyWxHq.woff2",
    "./assets/sarabun-thai-400-normal-C2DaJlKK.woff2",
    "./assets/sarabun-thai-500-normal-BVssjame.woff2",
    "./assets/sarabun-thai-600-normal-3dIAQ-_s.woff2",
    "./assets/sarabun-thai-700-normal-CbuDipM3.woff2",
    "./assets/style-Djnh4ZJx.css",
    "./favicon.svg",
    "./icons/apple-touch-icon.png",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
    "./icons/icon-maskable-512.png",
    "./manifest.webmanifest"
  ],
  "shell": [
    "assets/index-B6v12TwY.js",
    "assets/style-Djnh4ZJx.css"
  ]
}
/* build:end */

// Fixed here on purpose (not taken from BUILD): a wrong prefix would delete the other app's caches.
const PREFIX = 'mt5-names-'
const CACHE = PREFIX + BUILD.id
const HEAL_MESSAGE = 'mt5-names:heal'
const NAVIGATION_TIMEOUT_MS = 2500
const HEAL_RETRY_MS = 30000

const HERE = self.location.href
const SCOPE_PATH = new URL('./', HERE).pathname
const SW_PATH = new URL(HERE).pathname
const INDEX_URL = new URL(BUILD.index, HERE).href
const INDEX_PATH = new URL(INDEX_URL).pathname
const FILE_URLS = BUILD.files.map((file) => new URL(file, HERE).href)
const KNOWN = new Set(FILE_URLS)
// Vite's content-hashed files ('assets/name-1a2B3c4D.js') never change, so a copy from an older build is still good.
const HASHED = /\/assets\/[^/]*-[\w-]{8,}\.\w+$/
// GitHub Pages answers with 'Vary: Accept-Encoding'; the URL alone identifies a file here.
const MATCH = { ignoreVary: true }

const isOwn = (name) => name.startsWith(PREFIX)
/** True when `html` is the page of this build: it names this build's script and stylesheet. */
const isThisBuild = (html) => BUILD.shell.every((mark) => html.includes(mark))
/** A reload — the app's own "โหลดแอปใหม่" or the browser's — as far as the browser tells (Safari has no flag). */
const isReload = (request) => request.isReloadNavigation === true || request.cache === 'no-cache' || request.cache === 'reload'
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fetches a file past the browser's HTTP cache (revalidated), so a stale copy never enters the offline cache. */
async function fetchFresh(url) {
  const response = await fetch(url, { cache: 'no-cache', credentials: 'same-origin' })
  if (!response.ok || response.redirected || response.type !== 'basic') {
    throw new Error('precache failed: ' + response.status + ' ' + url)
  }
  return response
}

/** A content-hashed file kept by an older build of this app, so an update does not download it again. */
async function fromOlderBuild(url) {
  if (!HASHED.test(url)) return null
  for (const name of await caches.keys()) {
    if (!isOwn(name) || name === CACHE) continue
    const hit = await (await caches.open(name)).match(url, MATCH)
    if (hit) return hit
  }
  return null
}

/**
 * Puts every file of this build that is missing into the cache. index.html goes in last and only when it really
 * is this build's page, so "index.html is cached" always means "the app can start offline".
 */
async function fill() {
  const cache = await caches.open(CACHE)
  const have = new Set((await cache.keys()).map((request) => request.url))
  const missing = FILE_URLS.filter((url) => !have.has(url))
  await Promise.all(missing.map(async (url) => cache.put(url, (await fromOlderBuild(url)) || (await fetchFresh(url)))))
  if (have.has(INDEX_URL)) return
  const response = await fetchFresh(INDEX_URL)
  const html = await response.clone().text()
  if (!isThisBuild(html)) {
    throw new Error('precache failed: index.html on the server belongs to another build')
  }
  await cache.put(INDEX_URL, response)
}

let healing = null
let healTriedAt = 0

/** Repairs the cache after it was wiped. One run at a time; unasked repairs wait 30 s between attempts. */
function heal(force) {
  if (healing) return healing
  if (!force && Date.now() - healTriedAt < HEAL_RETRY_MS) return Promise.resolve(false)
  healTriedAt = Date.now()
  healing = fill()
    .then(() => true)
    .catch(() => {
      // Most likely a newer build was published and this build's files are gone: look for the new worker.
      self.registration.update().catch(() => {})
      return false
    })
    .then((ok) => {
      healing = null
      return ok
    })
  return healing
}

self.addEventListener('install', (event) => {
  event.waitUntil(fill().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((name) => isOwn(name) && name !== CACHE).map((name) => caches.delete(name)))
      await self.clients.claim()
    })(),
  )
})

/**
 * Opening the app: the newest page from the network; the cached one when offline, on a server error, or when the
 * network has not answered within 2.5 s (a weak signal must not hold up the start — the update arrives next time).
 *
 * The page of a NEWER build is not used either. Its script is not in this cache, so the screen would stay blank
 * until the whole new bundle has come down the same weak signal, although a complete build is cached. The cached
 * build starts at once instead, and the new worker is fetched in the background: it downloads the new build and
 * serves it from the next start on (the open page follows the pending-update rules of src/pwa/register.ts).
 * A reload asks for the newest page and gets it, so "โหลดแอปใหม่" never lands on the old build while online.
 */
async function openApp(event, url) {
  const cache = await caches.open(CACHE)
  const shell = await cache.match(INDEX_URL, MATCH)
  if (!shell) {
    // The cache is gone or was never completed. Only the network can answer; a good answer starts the repair.
    const response = await fetch(event.request)
    if (response.ok) event.waitUntil(heal(false))
    return response
  }
  const reload = isReload(event.request)
  const fresh = fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok || response.redirected) return shell
      if (reload || isThisBuild(await response.clone().text())) return response
      self.registration.update().catch(() => {})
      return shell
    })
    .catch(() => shell)
  return Promise.race([fresh, wait(NAVIGATION_TIMEOUT_MS).then(() => shell)])
}

/** A file of the app: from the cache, else from the network — and then back into the cache (self-healing). */
async function file(event, url) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(event.request, MATCH)
  if (hit) return hit
  const response = await fetch(event.request)
  if (response.ok && response.status === 200 && response.type === 'basic' && !response.redirected) {
    event.waitUntil(cache.put(event.request, response.clone()).catch(() => {}))
    // A file of this build was missing, so the cache was wiped: bring back the rest as well.
    if (KNOWN.has(url.href)) event.waitUntil(heal(false))
  }
  return response
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // the hub API and every other site: not ours to touch
  if (!url.pathname.startsWith(SCOPE_PATH) || url.pathname === SW_PATH) return // another app's folder, or this script
  if (request.headers.has('range')) return
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return
  if (request.mode === 'navigate') {
    if (url.pathname === SCOPE_PATH || url.pathname === INDEX_PATH) event.respondWith(openApp(event, url))
    return
  }
  event.respondWith(file(event, url))
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === HEAL_MESSAGE) event.waitUntil(heal(true))
})
