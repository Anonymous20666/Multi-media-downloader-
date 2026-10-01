# PAPPY / OMEGA — Master Plan (Planning Stage, No Code)
**Status: PLANNING ONLY. This document is the build contract. Code that contradicts it is wrong until the doc is amended via ADR.**
**Date:** 2026-10-01 · **Telegram baseline:** Bot API 10.3 (2026-08-24) · MTProto layer ~158 · ntgcalls 2.x

Related: `docs/PHASE-1-TECHNOLOGY-AUDIT.md` (research base — read first).

---

## 0. Repository audit (current state)

| Item | State |
|---|---|
| Code | **Greenfield.** Only `README.md` + Phase-1 audit exist. No framework, DB, or infra yet. |
| Implication | We choose the stack freely, but must resist scaffolding everything at once (§99). Foundation first. |
| Planning docs | `docs/PHASE-1-TECHNOLOGY-AUDIT.md` (Verified research) + this file (architecture + roadmap). |

### How to read this document
- Sections **A–T** are the deliverable requested in §100, in order.
- **X** = technical contradictions in the requirements (challenge duty, §12/§96). Read before anything else.
- **Y** = missing requirements I added. **Z** = decision records + version registry + re-check process (§102/§103).
- Confidence tags: **Verified / Likely / Needs testing** (§14). Anything load-bearing marked otherwise must be proven on test DCs before depending on it.

---

## X. Technical contradictions & corrections (READ FIRST)

These are places where the requirements as written conflict with verified Telegram/provider reality. Each one changes the design.

| # | Requirement as written | Reality (verified) | Design consequence |
|---|---|---|---|
| **X1. Movie/series FILES have no legal provider** | §10/11/38 assume a provider manager serving movies/episodes like music. | **Verified:** TMDB/Jikan = metadata + artwork only, zero video bytes. No licensed API streams movie files. "File providers" = YouTube-embed scrapers / piracy APIs: unstable, illegal in most jurisdictions, VPS-ToS-bannable, DMCA exposure. | **Decision Q1 (blocking for movie scope):** (a) legal: metadata + "where to watch" deep links + user-supplied files; (b) gray-zone file resolvers with jurisdiction + takedown ops. The architecture supports both (provider interface), but V1 scope and legal risk differ completely. Do not promise "Netflix in Telegram" until Q1 is answered. |
| **X2. No Netflix controls inside group calls** | §37/§39: seek, playback speed, dynamic subtitle/audio switching, per-viewer volume/quality. | **Verified:** viewers consume a live program; Telegram exposes no per-viewer media controls to bots. Our engine publishes ONE program per call. Seek/speed/subtitle-switch = restart transcode at offset / reburn subtitles = audible/visible glitch for everyone. Playback speed is effectively unmappable. Volume per listener is client-local; global loudness = our FFmpeg gain filter. | Honest control model: **global program controls** (pause-all, skip, restart-from-offset, variant-switch-with-gap) + **DM personal delivery** for per-user needs. Subtitles = pre-burned variants (pick variant before/at start; switching = brief re-publish). Never render fake seek bars. |
| **X3. Bot buttons can't drive Telegram's native player** | §9 "▶ Play / ⏭ Next" next to audio attachments. | **Verified:** no API drives the native audio/video player. | Buttons control OUR systems: stream queue, playlist, re-delivery. Label honestly ("Stream it", "Queue", "Download"). |
| **X4. No buttons inside the call player** | §35/§75 imply controls near/in the video-call UI. | **Verified:** call UI is Telegram-owned. Our live control message lives in CHAT. `messages_enabled` in-call messages exist but are text/reactions via user session, not bot buttons. | Live status card in chat (+ optional topic/thread) is the control surface. In-call messaging = Experimental (§75), user-session only. |
| **X5. 50 MB bot upload ceiling** | Movie delivery via bot assumed frictionless. | **Verified:** hosted Bot API: 50 MB multipart / 20 MB URL-fetch / 20 MB getFile. `file_id` re-send = unlimited. Local Bot API server = 2,000 MB. | **Local Bot API server is mandatory infra from V1** if we deliver files >50 MB. Upload-once → cache `file_id` → re-send free forever. This single fact shapes the delivery pipeline (§55). |
| **X6. YouTube is a hostile provider in 2026** | yt-dlp assumed as a utility. | **Verified (Sep 2026):** works, but needs PoToken sidecar (`bgutil-ytdlp-pot-provider`) + fresh cookies + near-daily updates; SABR breaks naive flows. | YouTube gets a dedicated provider maintainer slice: version-pinned yt-dlp + PoToken sidecar + cookie rotation + health scoring + fast fallback. Budget ops time, not just code. |
| **X7. Spotify/Pinterest have no usable media APIs** | §8 discovery + §14 Pinterest resolution. | **Verified:** Spotify = 30s previews/metadata only, no full-track audio API. Pinterest = no official pin-media API (business/board APIs only). | Spotify/Apple = metadata + resolve-to-audio-source (YouTube/SoundCloud/user file). Pinterest = best-effort unofficial extraction, Experimental tier, expect breakage. Say so in-UX ("source didn't expose media"). |
| **X8. Recognition APIs are narrow + paid** | §7: audio/video/image "identify". | **Verified market:** audio fingerprint = ACRCloud/AudD (paid, real). Anime stills = SauceNAO (real, rate-limited). General image = best-effort web lens (unofficial, fragile). Video-file identification ≈ doesn't exist. | Scope V1: audio fingerprint (paid) + SauceNAO anime + SHA/metadata match for re-uploads. Everything else = "not supported yet", not fake results. |
| **X9. Long streams fight URL expiry** | §32: hours/days/weeks. | **Likely/Verified practice:** YouTube URLs ~6h, signed HLS shorter; datacenter IP + 24/7 = throttling/bans. | Long-lived = playlist rotation + proactive URL refresh (re-resolve T-minus-30min) + watchdog (§40). "Set for weeks" stays Experimental until proven. Cap V1 durations (e.g., ≤12h) and validate. |
| **X10. Rich Messages need new clients** | §3: rich-first everywhere. | **Verified:** 10.1–10.3 features (Jun–Aug 2026) need updated apps; framework support still landing (PTB v23 in progress at audit time). | **Degradation-first design:** every rich component ships with a plain-text+keyboard fallback. Version-gate by feature detection where possible; never strand old-client users. |
| **X11. Ephemeral is too young to be load-bearing** | §26/§60: group UX on ephemeral. | **Verified:** 10.2/10.3 (Jul–Aug 2026). Correct use, but bleeding edge. | Use for enhancement (private results/settings), not for core flows, until client+framework support matures. Core flows must work without it. |
| **X12. RTMP needs the OWNER, bots can't self-serve** | §30 bootstrap assumes automation. | **Verified:** only owner sets `rtmp_stream=true`; only user session fetches keys; key fetch ≠ bot-callable even via business connection. | Bootstrap flow includes an explicit human/owner-session step with exact instructions (§30/§31). Design the checklist UI, not silent failure. |
| **X13. One program per call, one call per account** | §41 pool assumed; §33/§78 multi-user expectations. | **Verified practice (Likely-official):** 1 account : 1 active call; 1 program per call. All group viewers share pause/skip/seek. | Pool abstraction from day one (§97); per-user personalization happens in DM delivery, never in the shared call program. |
| **X14. 10k simultaneous ≠ just resolution** | §17/§18 focus on provider dedup. | **Verified limits:** 30 msg/s global, ~1 msg/s per chat, 20/min per group. Fan-out delivery is as binding as resolution. | Single-flight (§18) + `file_id` reuse + throttled sender queue (§57) + interactive-first UX (pull > push). One bot token cannot push-notify 10k users at once — design accordingly. |
| **X15. No age-verification primitive** | §50 18+ separation. | **Verified:** Telegram has no age API; iOS clients additionally filter sensitive content. | Enforcement = self-declared preference + separate 18+ providers/chats + disabled-by-default. Don't overpromise; log consent state. |
| **X16. SIMs are the pool ceiling, not code** | §41/§97 pool. | **Verified practice:** each streaming account = real phone number + warm-up + ban risk. | Capacity planning counts SIMs, warming time, and revocation rate — not just CPU. Start with 1–3 accounts; pool interface ready for N. |

---

## A. Product definition

**Pappy/Omega is a Telegram-native media operating system fronted by a bot.**
User mental model: *Search → Choose → Play / Download / Stream → control naturally, in chat.*
System reality (§104): Bot API + MTProto + user sessions + providers + queues + workers + AI + streaming engine + persistent state + observability.

**Non-goals (explicit):** replacing Telegram clients; per-viewer call controls (X2/X4); promising sources we don't have (X1/X7/X8); literal zero-downtime (§84 graceful degradation instead).

**Product lanes** (from Phase-1 audit; both live under one controller):
- **Lane A — Interactive:** voice-chat DJ (assistant joins call, shared program, queue/skip/pause). 1 account : 1 call.
- **Lane B — Broadcast:** RTMP ingest to channels/RTMP-enabled chats (scheduled shows, 24/7 radio). Scales with CPU; accounts only provision keys.

---

## B. Capability map

| Domain | Capabilities (eventual) | Primary surface |
|---|---|---|
| Music | NL + structured search (artist/track/album/genre/mood/year/lang), rich results, audio delivery + metadata, playlists, favorites, recognition (audio fingerprint) | DM + Group + Guest |
| Movies/Series/Anime | Metadata discovery (TMDB/Jikan), season→episode→source→quality→audio→subtitle flow, continue-watching, watchlist; FILE delivery gated by Q1 | DM (+ group browse) |
| Shorts/Images/Pinterest/URL | Generic URL→media manifest (§15/§16), galleries/carousels fully enumerated, image delivery | DM + Group |
| Download manager | Format/quality choice (only real options), progress states, history, `file_id` instant re-delivery | DM (+ group w/ anti-spam) |
| Streaming A (interactive) | Bootstrap wizard, duration/playlist, live control card, pause/skip/queue/shuffle/repeat, recovery, multi-group pool | Group (admin-gated) |
| Streaming B (broadcast) | RTMP provision/rotate, scheduled shows, persistent radio, health monitoring | Channel/Group (owner) |
| AI Pappy | Intent→tool execution, context ("second one", "it"), owner admin AI (audited, confirmed) | Everywhere; degrades to commands |
| Platform | Force-join, settings/i18n, admin center, audit, status vocabulary (§65), error recovery paths (§69) | DM/Owner/Group |

---

## C. Telegram technology map

**Rule: name the layer for every feature. "Telegram supports it" is not an answer.**

| Capability | Bot API (token) | MTProto / User session | Mini App | External | Notes + version |
|---|---|---|---|---|---|
| Commands, keyboards, deep links | ✅ primary | — | — | — | Bot API 10.3 |
| Rich Messages (blocks/tables/quotes/media/buttons/docs) + drafts + rich edit | ✅ `sendRichMessage*`, `editMessageText.rich_message` | — | — | — | 10.1–10.3; needs new clients (X10) + fallback |
| Ephemeral (user-only-visible group msgs) | ✅ `EphemeralMessageParameters`, edit/delete | — | — | — | 10.2–10.3; enhancement-only for now (X11) |
| Guest mode (summon without membership) | ✅ + BotFather opt-in | — | — | — | 10.0; max 3 guest bots/msg; minimal context |
| Bot-to-bot | ✅ mutual opt-in | MTProto equivalent exists | — | — | 10.0; loop-prevention mandatory |
| Managed bots / Business bots | ✅ tokens, rights, `postStory`, read/delete-as-business | — | — | — | 9.x–10.0; Premium no longer required for business bots |
| Stars payments + subscriptions | ✅ `sendInvoice` XTR | — | ✅ sell digital goods in TMA | Fragment withdraw | No approval needed; ~30% mobile-store cut on purchase |
| Forums/topics, reactions, polls, stories-view, custom emoji, attachment menu | ✅ | — | — | — | Mature |
| Post stories | ✅ only as business/managed account | ✅ as user | — | — | Token alone cannot |
| File upload ≤50 MB / download ≤20 MB | ✅ hosted limits | — | — | **Local Bot API server → 2 GB** | X5: local server mandatory for movies |
| `file_id` re-send (any size) | ✅ unlimited | — | — | cache (Redis/PG) | X5: the delivery scaling trick |
| Group-call create/join/publish/screen-share/record-schedule/admin | ❌ rejected | ✅ `phone.*` + WebRTC engine + user session | — | ntgcalls + FFmpeg | Users-only, Verified; §I |
| RTMP key provision/rotate | ❌ even via business conn. | ✅ owner session `getGroupCallStreamRtmpUrl` | — | FFmpeg/OBS ingest | X12: owner step in bootstrap |
| RTMP publish (media in) | — | — | — | ✅ FFmpeg → `rtmp://` | No call participation needed (Lane B) |
| Stream-mode consumption at scale | — | ✅ chunk download (`inputGroupCallStream`) | — | — | Telegram fans out; we publish once |
| Force-join verify | ✅ `getChatMember` + invite/join-request APIs | — | — | membership cache (Redis) | Bot needs admin for join-request approval flows |
| In-call text/messages | ❌ | ✅ (`messages_enabled` calls) user session | — | — | Experimental only |
| Full consoles/dashboards | — | — | ✅ Web app in chat | Hono API backend | Owner console + queue mgmt = TMA in V2 |
| Age verification | ❌ doesn't exist | ❌ | self-declare UI | — | X15 |

---

## D. UX architecture

### Design principles (binding)
- **Rich-first, fallback-always** (X10): component renders rich → degrades to text+keyboard on old clients/errors.
- **Dense, not cluttered:** max ~6 primary actions per surface; overflow into `⋯ More` / nested menus; no 20-button keyboards.
- **State honesty:** every async op shows received→…→done/failed (§21) using the §65 vocabulary; drafts (`send*Draft`) for streaming AI/long ops.
- **Context preservation:** force-join verify, pagination, wizards never lose the originating request (§6: stash `originCtx`, resume after verify).
- **Group hygiene:** group shows shared state; personal stuff goes ephemeral/DM (§26/§60).

### D1. /start concepts (3–5 as requested) — recommendation: **Concept C**, with A as fallback for old clients
- **A. Classic menu card** (works everywhere): greeting + 2×4 button grid (Music/Movies/Series/Anime/Shorts/URL/Ask/Stream) + settings row. Zero risk, zero wow.
- **B. Search-first** (like a launcher): "Send me anything — a name, link, photo, voice note…" + recent/favorites below. Best for retention, weak at discovery.
- **C. (RECOMMENDED) Rich hub:** Rich Message with hero media, identity line ("Pappy — your Telegram media assistant"), 4 capability sections with 1-line examples each, inline buttons inside the message (10.3 `RichBlockButtons`), plus persistent bottom keyboard (🔎 Search · 📋 Playlists · ⚙️ Settings). Discovery + power in one screen.
- **D. Onboarding wizard:** 3-step (language → quality default → 18+ pref) then hub. Use once for new users, skippable, resumable.
- **E. Owner variant:** hub + `🛠 Control Center` entry (audited; §47 tree below).

### D2. DM menu tree
```text
/start → Hub (C)
├── 🔎 Search (free text / voice / image / URL / file)
│   ├── Disambiguate: Music · Video · Movie · Series · Anime · Image  (only when ambiguous)
│   └── Result → Detail → [Play/Stream/Download/Playlist/Details/Source/Quality/Subs]
├── 🎵 Music → search · charts/moods · recognition (send audio) · my playlists
├── 🎬 Movies / 📺 Series / 🍥 Anime → search · browse genre/year · detail → S→E→source→quality→audio→subs
├── 🔗 URL → paste link → manifest → all-items gallery → per-item actions
├── 📋 Library → playlists · favorites · history · downloads
├── 🤖 Ask Pappy → NL (tools §H) + "commands" hint
└── ⚙️ Settings → language · quality · audio/subs · format · notifications · 18+ pref · storage
```

### D3. Group menu tree (shared-state first, §25)
```text
Group Home (pinned/shortcut, admin-configurable modules)
├── 🎵 Music → group search (results ephemeral-or-thread) → request/add-to-stream-queue
├── 📡 Stream → status card (if live) · start wizard (admin) · queue view · vote/request (non-admin)
├── 🔎 Search → ephemeral personal results w/ "send to group" action
├── 🤖 Ask Pappy → guest-mode compatible; group-safe tools only (no admin ops)
└── ⚙️ Settings (admin) → modules on/off · permissions (who can request/stream) · anti-spam · stream defaults
```
Rules: stream control actions = admin-only by default (configurable: admins / all / voted); downloads in group = rate-limited + deduped (§26); race protection = action locks + state version (§58).

### D4. Owner menu tree (§46/§47, nested rich menus — never 200 buttons)
```text
🛠 Control Center (/admin, owner-ID authed §89 + optional 2nd factor)
├── 📊 Dashboard → health · active streams/downloads · queues · FloodWaits · provider status
├── 👥 Users → search · ban/unban · tiers · broadcast (queued, throttled)
├── 🔒 Force Join → targets CRUD · enable/reorder · join-msg editor · live preview · verify-test
├── 📡 Streams → active (per-stream card) · stop/takeover · accounts pool · keys (rotate; values NEVER shown §63)
├── 🌐 Providers → health/latency/success · enable/disable · priority · rate-limit state
├── 🤖 AI → model · tools allowlist · owner-AI confirm policy · usage/cost
├── 📋 Queues → depths · pause/drain per queue · DLQ inspect/retry
├── 💾 Storage/Cache → usage · TTLs · purge · orphan sweep
├── ⚙️ System → feature flags · limits · i18n · 18+ policy · backup/restore · logs/errors
└── 🧪 Diagnostics → self-test (provider ping · sender probe · stream dry-run) · chaos drills (§93)
```

---

## E. Rich Message component system (§3–§4)

**Library, not pages:** every surface composes from versioned components, each with `rich` + `fallback` renderers and a `minClientHint`.

| Component | Rich blocks used | Fallback | Used by |
|---|---|---|---|
| `HeroCard` (title/meta/media/actions) | heading + photo/video + table(meta) + `RichBlockButtons` | text + inline keyboard | Hub, media detail, now-playing |
| `MetaTable` (rating/year/runtime/lang/quality) | `Table` (compact on mobile) | key: value lines | Movies/series/anime/music detail |
| `ResultList` (paginated) | list + per-item buttons | numbered text + keyboard | Search, episodes, queue |
| `Quote` / `ExpandableQuote` (synopsis, lyrics-snippet, help) | blockquote / expandable (10.3) | truncated text + "More" btn | Detail, help, AI answers |
| `Details` (collapsible: subs, sources, advanced) | `Details` block | sub-menu message | Quality/subs/source pickers |
| `MediaGallery` (mixed post) | collage/slideshow + per-item caption | media group + keyboard | URL manifest, Pinterest |
| `Thinking` (AI/working state) | `Thinking` block + drafts | "⏳ …" + edits | AI, long resolve/download |
| `ProgressOp` (received→done pipeline) | draft updates + final rich card | edited text message | §21 all async ops |
| `LiveCard` (stream control) | media + table(status/queue) + buttons; edited in place | same as text+keyboard | §35; keyed by (chat,message,stream) §36 |
| `FormSheet` (duration, settings) | buttons + details | stepped keyboards | §32 duration, wizards |
| `DocAttach` (subs files, logs export) | `Document` block + `tg://document?id=` reuse | sendDocument | Subs, diagnostics |

Rules: no component reads providers directly (props = normalized manifest/entities only); every component logs `renderMode` for fragmentation telemetry (X10); buttons carry `(action, targetId, stateVersion, nonce)` for race protection (§58).

---

## F. Core architecture

### Services & boundaries (§83: split where it protects reliability, not for aesthetics)
```text
                    ┌──────────────┐  MTProto   ┌───────────────┐
                    │ Stream Worker│◄──────────►│ Telegram Call │
                    │ (Python) × N │  WebRTC/   │  DCs (media)  │
                    └──────┬───────┘  RTMP      └───────────────┘
                           │ publish/control
┌──────────┐  updates  ┌───▼────────────┐  jobs   ┌────────────┐  RPC   ┌──────────┐
│ Telegram │◄─────────►│ Controller/GW  │◄───────►│   Redis    │◄──────►│ Workers  │
│ Bot API  │  sends    │ (TypeScript)   │ bullmq  │ Q+cache+   │        │ (TS/_py) │
└──────────┘           └───────┬────────┘         │ locks      │        └────┬─────┘
  (local Bot API               │                  └────────────┘             │ read/write
   server, §L)             PG (state)                              PG / S3-compat / providers
```
- **Controller/Gateway (TS):** update ingress (webhook w/ secret + long-poll fallback), router, guards (auth/force-join/rate), AI orchestrator, sender (THE throttled Telegram egress), TMA backend (Hono), owner API.
- **Workers:** `search`, `resolve`, `download`, `transcode` (CPU pool), `sender` (dedicated), `stream-control`, `ai`, `maintenance`. TS except **stream workers = Python** (ADR-02).
- **Redis:** queues + single-flight (§18) + locks + rate windows + ephemeral state. PG = source of truth; Redis loss = degraded, not dead (§87: bounded local fallback + backpressure).
- **Local Bot API server** in compose from V1 (X5).

### Queues (§19–§20: why separate)
| Queue | Workload | Concurrency | Why separate |
|---|---|---|---|
| `updates.ingress` | Telegram updates → router | high, IO | isolate Telegram spikes from everything |
| `search.fast` | interactive search/disambiguate | high | must never wait behind downloads |
| `resolve.media` | provider resolution (single-flight) | per-provider bounded | expensive, deduped (§18) |
| `download.fetch` | fetch bytes (yt-dlp/HTTP/HLS) | low, bounded | heavy, backpressured |
| `transcode.media` | FFmpeg (burn-subs, re-encode, thumb) | = CPU pool | CPU-bound; never on interactive path |
| `telegram.send` | ALL Bot API sends, global+per-chat throttle | 1 logical sender (scaled shards) | FloodWait containment (§57); priority lanes inside |
| `stream.control` | play/pause/skip/stop + watchdog ticks | immediate lane | stream UX can't queue behind downloads |
| `ai.tasks` | LLM calls w/ timeouts | bounded + budget | failure-isolated; commands work without it (§66) |
| `maintenance` | warm/refresh/cleanup/rotate | cron-ish | never competes with interactive |

**Priority (§20):** separate queues + weighted consumers (stream.control > telegram.send/interactive > search.fast > resolve > download > transcode > maintenance). DLQ per queue + owner-visible retry (§69/§70 UX stays "Searching another source…", never tracebacks §65).

---

## G. Media architecture

### G1. Provider system (§17)
```text
Resolver → ProviderManager → [MusicMeta, MusicFile, VideoMeta(TMDB/Jikan), VideoFile(Q1!), URL(yt-dlp-generic),
                                Lyrics?, Subs(OpenSubs), Recognition(ACR/AudD, SauceNAO), Pinterest(best-effort)]
```
Provider record: `priority · capabilities[] · qualityCeiling · health · latencyP95 · successRate · rateLimitState · costPerCall · legalClass`.
Fallback: scored selection (not first-answer-wins §52) → try → on fail: mark, next, user sees "another source…" (§70). Circuit breakers per provider + global kill flag (owner-AI can disable §24, audited §90).

### G2. Manifest (§16, binding contract)
All providers normalize to `MediaManifest` (platform/contentType/title/author/thumbnail/caption/media[] with per-item type/url/quality/codec/duration/size/subs[]/audioTracks[]). Provider formats never leak past the provider adapter. Manifest v1 schema frozen at Foundation; changes via ADR.

### G3. Search + ranking (§51/§52)
`normalize → fan-out (bounded) → merge → dedupe (ISRC/title-artist hash/ TMDB-ID) → score → present`.
Score = relevance·w1 + quality·w2 + providerHealth·w3 + availability·w4 + langMatch·w5 + userPref·w6 (weights in config, logged per result for tuning). Never rank by arrival order.

### G4. Quality resolver (§12: never fake)
Probed facts only (ffprobe / provider stream map): resolution/bitrate/codec/fps/container/audio/HDR/size. UI exposes exactly the available ladder; "Best" = argmax(score) with ties → smaller size; upscale detection (e.g., 720p-in-1080p-container) flagged when detectable, else don't claim.

### G5. Subtitles/audio (§13/§44)
Dynamic language discovery from source + OpenSubs fallback; user pref (default EN; region pack incl. YO/HA/IG as *preferences*, availability-dependent per X4-table). Delivery: mux when Telegram-compatible (MKV→MP4 constraints) else sidecar `.srt` document + burned-in streaming variants (X2). Streaming track switch = variant switch w/ gap — disclosed in UI.

### G6. Cache/storage (§53–§55)
- L1 memory (hot manifests, tiny TTL) → L2 Redis (search/meta/manifest/single-flight, typed TTLs) → L3 PG (entities, `file_id` index — the crown jewel: re-send unlimited size) → L4 S3-compat (cached media w/ LRU+quotas+orphan sweep; never unbounded disk §54).
- Media bytes cached ONLY after cost/benefit (size × re-request probability); temp downloads always TTL-cleaned.

---

## H. AI architecture (Pappy brain, §22–§24)

```text
message → NLU (intent+entities+refs) → context merge (conv-state + prefs + stream/download state)
        → planner (tool calls, validated schemas) → policy gate (user vs owner perms §88/§89)
        → execute (idempotent tools) → rich result (Thinking→card) → audit (owner ops §90)
```
- **Tools** = explicit allowlisted functions (§22 list + `get_*` readers); no shell, no raw HTTP, no secrets in context (§63: keys never in LLM context).
- **Context (§23):** short-lived conv state (results buffer w/ ordinals, "it" pointer, pending wizard) in Redis TTL; LLM never the memory of record.
- **Owner AI (§24):** same pipeline + elevated toolset + **confirmation for destructive** (disable provider, stop stream, revoke session) + full audit log.
- **Fallback (§66):** AI down/slow → commands + menus fully work; NLU timeout → "try /music <name>" path, never dead air. Model interchangeable (config: provider/model/budget); PII minimized in prompts.

---

## I. Streaming architecture (separate subsystem, §27–§45)

### I1. Identity separation (§28, binding)
- **Bot identity:** ALL chat UX, permissions, queues, AI, admin. Never holds sessions/keys.
- **Streaming identity(ies):** user session(s) in pool; ONLY stream workers ever decrypt/use them (in-memory, §29). Controller talks to workers via signed control queue messages, never sees secrets.

### I2. Lanes (§A)
| | Lane A: Interactive (VC DJ) | Lane B: Broadcast (RTMP) |
|---|---|---|
| Join | assistant user session + ntgcalls WebRTC (`phone.joinGroupCall`) | nobody joins; FFmpeg publishes to ingest |
| Setup needs | assistant in group + speak rights; call exists/created | owner-enabled RTMP + key (owner session provisions) |
| Program | ONE shared A/V program; pause/skip = global | ONE shared program; schedule-driven |
| Scale unit | 1 account + 1 worker per live call | 1 worker per live ingest; accounts only for keys |
| State machine | §N | §N (CONNECTING = RTMP handshake) |

### I3. Bootstrap (§30/§31 — with the honest human steps)
```text
Start wizard → target validate (bot present+rights? assistant present+rights? call state? RTMP owner-step?)
  → missing-auto-fixable? do it : show exact human checklist (who must do what, where to tap)
  → media resolve → pipeline prepare (variant/transcode if needed) → join/publish → LIVE card → watchdog
```
Validation matrix recorded per chat (botAdminRights, assistantId/rights, callId/mode, rtmpKeyRef-not-value, pinPerms).

### I4. Playlist engine (§34) + duration (§32)
Real playlist object (add/remove/reorder/shuffle/repeat/save/restore, live-add §78); duration presets + custom parser (validated caps: V1 ≤12h, §X9); movies: duration=runtime, episode progression = playlist of episodes (§38/§79); scheduler persistent + restart-safe (§45/§80).

### I5. Live card (§35/§36) + controls (§37 honest set)
Global controls: pause/resume-all, next/prev, stop, queue view/add, shuffle/repeat, restart-from-offset ("seek", disclosed gap), variant switch quality/subs (disclosed re-publish gap), loudness (engine gain). Card keyed `(streamId,chatId,messageId)`; pin mgmt w/ anti-loop (re-pin max N/hour, admin toggle).

### I6. Recovery (§40/§84)
Watchdog: engine heartbeat + Telegram liveness + source-URL TTL + queue depth → `RECOVERING` (re-resolve URL, re-join, resume playlist position) with backoff; state in PG+Redis so process/VPS restart resumes (§45); alerts to owner (audited). Chaos drills prove it (§93).

### I7. Pool + planner (§41/§42)
`StreamingAccount{id, status, health, assignedStreamId?, capacity=1, rights-cache, lastHeartbeat}` (§97). Scheduler assigns idle-healthy account + worker w/ CPU/RAM/BW headroom check; else queue position + ETA ("all lines busy, #2"). Capacity math in §P; SIM count is the ceiling (X16).

---

## J. Multi-group scaling strategy (§41/§56)

1. **Share nothing per-stream:** `streamId`-scoped state only (§81); no globals.
2. **Dedup before work:** single-flight resolution + `file_id` reuse (X14) — 200 identical requests = 1 resolve + 200 cheap sends (still throttled through `telegram.send`).
3. **Isolate failure:** worker-per-stream-process (Lane A) / container-per-ingest (Lane B); one FFmpeg SIGKILL can't touch neighbors (§83).
4. **Throttle at the true bottlenecks:** Telegram egress (global+per-chat), provider RPM, CPU transcode slots. Backpressure propagates (queue → "high demand, ETA" UX, never silent drop).
5. **Scale order:** sender shards → resolve/download workers → transcode pool → stream workers+accounts(SIMs) → read replicas. Load tests prove each step (§92/§P).

---

## K. Security architecture (§61–§63)

- **Secrets:** bot token, api_id/hash, sessions, RTMP keys, provider/AI/DB/storage creds → env-injected from a secrets manager (V1: sops/age or Vault-lite; NEVER Git/logs/messages/AI-context/frontend). Encryption at rest (KMS envelope) for sessions+keys; rotation runbooks (RTMP `revoke=true`, session revoke/re-login).
- **AuthZ:** owner by Telegram user-ID (§89), admin roles per-chat + global; AI tools permissioned (§88); destructive = confirm + audit (§90).
- **Input/egress:** URL allowlist-per-provider + SSRF guard (no private/metadata IPs, redirect validation, size/time caps) for the resolver (§61); upload validation (magic bytes, size caps); callback authenticity (signed payloads + stateVersion + nonce §58).
- **Account safety (§62):** session health monitor, anomaly alerts (new DC login, rights change), least-privilege assistant accounts, kill-switch per account, no session ever traverses Telegram/Git/logs.
- **Data:** retention policy + user data export/delete (Y), backup encryption (restic/kopia, secrets excluded or sealed §91).

---

## L. Deployment architecture (§85)

```text
VPS → Docker Compose: controller · workers (profiles: interactive/transcode/stream-py) · postgres · redis
                      · local-bot-api-server · ffmpeg sidecars (yt-dlp+PoToken for YT provider)
                      · caddy (TLS, webhook) · otel-collector? (V2) · watchtower OFF (pinned deploys)
Volumes: pgdata · redis-aof · media-cache(quota) · botapi-data · backups · logs
```
- `.env` from sealed secrets; healthchecks per service; `restart: unless-stopped` + graceful SIGTERM drain (finish send, park streams → RECOVERING).
- Portable: fresh VPS = clone + secrets + `compose up` + bootstrap checklist (webhook, owner-ID, first session pairing runbook).
- Environments: `test` (Telegram test DCs + sandbox chats) → `prod`. No prod-experiments (§92 chaos only in test + game-day in prod-maintenance window).

---

## M. Data model (essentials; PG + Redis roles noted)

```text
users{id, tg_id UNIQUE, role, prefs(jsonb: lang, quality, audio, subs, format, notify, adult), tier, created..}
chats{id, tg_id, type, settings(jsonb: modules, perms, stream_defaults, locale), forcejoin_snapshot}
forcejoin_targets{id, chat_ref?, target_tg_id, kind, priority, enabled, join_msg_key, custom_msg, created_by}
providers{id, key UNIQUE, enabled, priority, caps[], ceiling, health, latency_p95, success_rate, limits, legal_class}
media_cache{id, dedupe_key UNIQUE (isrc/tmdbid/urlhash), manifest(jsonb), file_ids(jsonb: variant→file_id), ttl_at}
download_jobs{id, user_id, chat_id, dedupe_key→coalesced, state, progress, attempts, error_code, request_id}
playlists{id, owner_id/chat_id, title, items(jsonb[] manifest refs), state, version}
stream_accounts{id, label, status, health, session_ref(sealed), assigned_stream, rights_cache, heartbeat}
streams{id, chat_id, account_id?, worker_id, playlist_id, mode(A/B), state, variant, started_at, expires_at, live_msg(chat,msg), version}
schedules{id, stream_ref/playlist_ref, cron_or_at, duration, repeat, next_run, last_status}
audit_events{id, actor, action, target, meta(jsonb, REDACTED), at}  (append-only)
ai_context{conv_key, results_buffer, it_pointer, wizard_state, ttl} (Redis only)
rate_windows / singleflight / locks (Redis only)
```

---

## N. State machines (§82 + downloads)

```text
DOWNLOAD: QUEUED → RESOLVING → FETCHING → PROCESSING(transcode/mux) → UPLOADING → READY
          ↘ FAILED(retryable?→QUEUED w/ backoff : → terminal + recovery UX §69) ; CANCELED (user) anytime.
STREAM:   IDLE → PREPARING → RESOLVING → CONNECTING → LIVE ⇄ PAUSED
          LIVE/PAUSED → RECOVERING → (LIVE | FAILED-terminal) ; any → STOPPING → ENDED ; EXPIRED (duration/schedule).
```
Rules: transitions validated (invalid rejected + logged); every transition emits event (→ live card edit, audit for admin ops); `version` increments per mutation (race guard §58); terminal states keep receipt (what/why/next-actions).

---

## O. Failure/recovery architecture (§40/§65/§69/§70/§92/§93)

| Failure | Detection | Response | User sees |
|---|---|---|---|
| Provider down/slow | health score + timeouts | circuit-break → next provider | "Searching another source…" |
| Source URL expired | TTL watcher / fetch 403 | re-resolve in place; stream → RECOVERING | brief "Reconnecting…" on live card |
| FloodWait X | sender error parse | sleep exactly X (that shard/chat), no retry storm (§57) | nothing (queued) or ETA |
| Redis down | heartbeat | local bounded fallback + backpressure; PG still authoritative for durable state | "High load, retrying…" |
| PG timeout | pool metrics | retry w/ backoff; read-only degrade for non-critical | degraded notice, core search continues if cache warm |
| FFmpeg crash | process monitor | restart w/ same playlist position → RECOVERING | "Reconnecting…" |
| Worker/VPS crash | supervisor + startup replay | replay durable state (jobs/streams/schedules) → resume | "Recovered" receipt on live cards |
| Session revoked/banned | MTProto auth errors + monitor | park account, alert owner, failover stream if spare | "Stream interrupted — switching…" or honest stop |
| AI down | timeout/budget | commands+menus path (§66) | full functionality, no NL |
| Disk pressure | quota monitor | LRU evict + pause caching (fetch-through) | slower first-delivery, no failure |

All mapped to §65 vocabulary + §69 recovery actions; internals stay in logs/admin.

---

## P. Load model (§56/§94 — measure, then commit)

**Known Telegram ceilings (Verified):** ~30 sends/s per bot, ~1/s per chat, 20/min per group; file caps §C.
**Capacity math (planning starters — validate in load tests):**
- Interactive search P95 target ≤3s warm / ≤8s cold (provider-bound); resolve single-flight hit rate target >60% at 1k concurrent same-item.
- Sender: 1 bot ≈ 30 msg/s ≈ 108k/hour theoretical; real plan = priority lanes + batching (media groups) + pull-first UX; broadcast to 10k = queued job with ETA, not instant.
- Transcode: ~0.5–1 vCPU per 720p live + headroom; audio-only ≈ negligible; rule: transcode slots = floor(cores × 0.7); overflow → queue, never OOM.
- Stream publish uplink ≈ 2–4 Mbps (720p) / ~128 kbps (audio); VPS BW ÷ per-stream = max concurrent (plus 30% headroom).
- Accounts: max Lane-A streams = healthy pool size (X16); Lane-B = CPU/BW bound.
**Process (§94):** benchmark test env → set P50/P95/P99 per op → alert thresholds → re-benchmark per release. No invented SLOs.

---

## Q. Open questions (genuinely unresolved)

| # | Question | Blocks | How we resolve |
|---|---|---|---|
| Q1 | Movie/series FILE sourcing: legal-only (metadata+links+user files) vs gray-zone resolvers? | Movie scope, legal risk, provider build | Owner decision + jurisdiction review (X1) |
| Q2 | One-account-one-call: prove on test DCs + document exact error/behavior on double-join | Pool sizing truth | Test-DC experiment |
| Q3 | RTMP group-chat (non-channel) semantics: provisioning-account presence, codec acceptance, key lifetime | Lane-B group support | Test-DC experiment |
| Q4 | Rich Message client fragmentation: what % of real users render 10.1–10.3? fallback trigger strategy | UX rollout | Telemetry from V1 (`renderMode` logging) |
| Q5 | Framework readiness per 10.3 method (grammY vs PTB vs raw) | Stack choice detail | Spike at Foundation (ADR-02) |
| Q6 | Monetization/pricing (Stars tiers? premium lanes?) | Business model, queue priority design | Owner decision (Y) |
| Q7 | In-call messaging UX value (`messages_enabled`) | Experimental backlog | Spike in V2 |
| Q8 | Recording/VOD retrieval chain | V2 scope | Spike in V1.5 |

---

## R. Research findings (verified base)

Full detail: `docs/PHASE-1-TECHNOLOGY-AUDIT.md`. New verifications this round:
- **Bot file limits (Verified):** 50 MB multipart / 20 MB URL / 20 MB getFile / `file_id` unlimited / local server 2 GB ([conferbot limits 2026](https://www.conferbot.com/limits/telegram), [ffmpeg-micro](https://www.ffmpeg-micro.com/blog/the-telegram-bot-video-size-limit-isn-t-50-mb-it-s-three-caps)).
- **TMDB video void (Verified):** "TMDb is not a Service or Stream Server… not possible to play/watch/download" ([TMDB forum](https://www.themoviedb.org/talk/61f6a9afbb105700a0af9377)); watch-provider data = daily JustWatch export, attribution-required, no deep media URLs.
- **yt-dlp 2026 (Verified):** actively maintained, works on most public YouTube — but requires PoToken sidecar + fresh cookies + constant updates ([plisio 2026 guide](https://plisio.net/cybersecurity/yt-dlp)).
- Prior Verified: Bot API 10.3 changelog; `phone.*` users-only (MadelineProto/Telethon TL); RTMP owner+key flow; ntgcalls 2.x active; Pyrogram archived→forks; Telethon→Codeberg maintenance.

---

## S. Risks (top, honest)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Copyright/DMCA over movie files (X1/Q1) | High if gray-zone | Account/VPS loss, legal | Q1 decision; jurisdiction; takedown flow; legal-only default |
| Assistant account bans (spam heuristics) | Medium | Stream outage | Warming, human cadence, pool spares, failover, kill-switch |
| Provider breakage (YT/Pinterest/scrapers) | High (ongoing) | Feature outage | Multi-provider + health + fast-disable + owner-AI ops |
| Rich/ephemeral fragmentation (X10/X11) | Medium | Broken UX on old clients | Fallback-first components + telemetry |
| Scope explosion (100-section spec) | Certain | Never ships | §T phasing + feature flags; V1 ruthlessly small |
| Secret/session leak | Low w/ discipline | Total compromise | §K; audit; no-secrets-in-context; rotation drills |
| Cost overrun (LLM/recognition/VPS) | Medium | Burnout | Budgets per queue; caching; metered owner dashboard |

---

## T. Recommended implementation order (dependency-aware)

### Foundation (ship nothing user-facing except /start hub + health)
Repo skeleton (TS controller + Python stream-worker stub) · config/secrets/i18n/observability skeletons · PG+Redis+compose+local Bot API server+Caddy · update ingress + guards + throttled sender + FloodWait · component lib (`HeroCard`,`ProgressOp`,fallback) · manifest schema v1 + provider interface · CI + test-DC env · ADR-01..04 + version registry.
**Exit:** `/start` renders (rich+fallback), `ping` self-test green, load harness skeleton runs.

### V1 — Core identity: personal media assistant (DM-first)
Music search→detail→download (YT audio + metadata) · URL→manifest→gallery delivery · playlists/favorites/history · `file_id` reuse cache · force-join + settings + owner basics (dashboard/users/providers/queues) · single-flight + DLQs · commands + menus (AI off) · load tests 100→1k.
**Exit:** 1k-user load green; P95s baselined; owner can operate everything from DM.

### V1.5 — Streaming ALPHA (one group, flagged) + movies metadata
Lane-A single-group: wizard→validate→publish→live card→pause/skip/stop→recovery · pool interface w/ 1–2 accounts · movies/series/anime metadata + S→E→quality→audio→subs flow (files per Q1) · subs delivery (mux/sidecar) · duration presets ≤12h · scheduler persistent.
**Exit:** 24h stable single-group stream incl. induced failures; movie flow UX-complete.

### V2 — Multi-group + AI + broadcast
Pool scheduler + multi-group Lane A · Lane-B RTMP (provisionschedule, radio) · AI NLU + tools + owner-AI (audited) · ephemeral/group-hygiene rollout · recognition (ACR/SauceNAO) · Pinterest best-effort · TMA owner console · Stars monetization (per Q6) · load tests 10k ops.
**Exit:** concurrent multi-group streams proven; AI handles top-20 intents; unit economics visible.

### Experimental (proof-gated, never promised)
Weeks-long streams · recording/VOD · in-call messaging · autoplay TV · communities features · pure-Go engine watch · advanced 18+ flows.

---

## Y. Missing requirements (added)

1. **Legal/compliance:** jurisdiction, DMCA/takedown flow, provider ToS review, 18+ consent logging, privacy (export/delete my data), data retention.
2. **Monetization (Q6):** Stars pricing/tiers, premium lanes, cost-per-stream/download visibility, budget guards.
3. **Abuse/moderation:** group anti-spam policy, NSFW handling, user/ban appeals, rate abuse, complaint intake.
4. **Group permission model:** per-chat matrix (who: request/stream/control/configure), defaults + overrides.
5. **Ops runbooks:** session pairing, account warming, RTMP bootstrap checklist, rotation, game-days.
6. **Degradation matrix:** per-feature client-version fallback table + telemetry (X10/Q4).
7. **Cost model:** VPS sizing ladder, LLM/recognition budgets, SIM inventory cost.
8. **Staging/test-DC strategy** + prod game-day policy.
9. **Analytics:** search→delivery funnel, stream stability, provider SLAs, AI containment rate.

---

## Z. Decisions, versions, process

### ADR-01 — Bot framework + controller runtime: TypeScript (grammY + Hono)
Reason: modern typed Bot API DX, fast 10.x adoption, TMA backend synergy. Alternatives: Python/PTB (mature, slower 10.x), raw HTTP (max control, max toil). Tradeoff: two runtimes (see ADR-02). Confidence: Likely — confirm per-method support in Foundation spike (Q5).

### ADR-02 — Stream workers: Python (Pyrofork + pytgcalls/ntgcalls), TS talks via Redis control queue
Reason: most battle-tested call stack in 2026; isolates LGPL native core in its own process. Alternatives: all-TS via tgcalls-js (uniform, smaller-maintainer risk), all-Python (simpler ops, weaker TMA DX). Tradeoff: two toolchains + contract versioning. Confidence: Likely — spike both bridges in V1.5 planning.

### ADR-03 — Queues: Redis + BullMQ (TS) with a Python-compatible control envelope (JSON schema, not pickle)
Reason: priority lanes, DLQs, observability; language-neutral contract. Alternatives: NATS/RabbitMQ (better at scale, heavier for V1). Confidence: Verified-fit for V1–V2 scale.

### ADR-04 — Delivery: local Bot API server + `file_id` cache as primary scaling mechanism
Reason: only path past 50 MB + free infinite re-send (X5). Alternatives: MTProto user-upload (account risk), external links (poor UX). Confidence: Verified.

### Version registry (pin + re-check)
| Dependency | Pinned at plan time | Re-check |
|---|---|---|
| Telegram Bot API | 10.3 (2026-08-24) | Monthly changelog watch |
| MTProto layer | ~158 | Quarterly + on library bump |
| ntgcalls / pytgcalls | 2.x (active Sep 2026) | Monthly |
| yt-dlp + PoToken sidecar | latest + pinned | Weekly (hostile provider) |
| grammY / PTB / Pyrofork | spike in Foundation | Per Bot API release |
| TMDB / Jikan / OpenSubs / ACR / SauceNAO | adopt in V1–V2 | Quarterly ToS/caps review |

**Re-check process (§103):** monthly "Telegram diff" review (changelog → component/queue impact) · quarterly dependency audit · version bump = ADR entry + migration note. Codebase stores `telegram-versions.json` as the single source of truth.
