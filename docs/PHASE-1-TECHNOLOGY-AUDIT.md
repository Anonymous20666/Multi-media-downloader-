# PHASE 1 — Current Technology Audit
**Telegram ecosystem as of October 2026. Planning first. Coding later.**

> Confidence legend used throughout: **Verified** (official docs / changelog / repo observed) ·
> **Likely** (strong ecosystem consensus, not in official docs) · **Needs testing** (must prove on test server before architecture depends on it).

---

## A. Current Telegram Bot API — what bots can do right now

**Current version: Bot API 10.3, released August 24, 2026.** ([changelog](https://core.telegram.org/bots/api-changelog))
The last 6 months were the biggest bot-platform shift in years. Anything designed against a 2024-era Bot API is outdated.

| Version / date | What changed (relevant to us) |
|---|---|
| **10.3** — Aug 24, 2026 | Buttons *inside* Rich Messages (`RichMessageButton`, `RichBlockButtons`), expandable quotations, compact tables, document attachments in rich messages, `tg://document?id=` links, disabled inline buttons, ephemeral-message overlays replacing callback messages, `can_stop` / `keep_on_stop` generation-stop controls for AI streaming (`sendMessageDraft` / `sendRichMessageDraft` + `MessageGenerationStopped` update), `CommunityChatJoined` service message |
| **10.2** — Jul 14, 2026 | **Ephemeral Messages** (group messages visible only to one user + bot; `edit/deleteEphemeralMessage*`), outgoing rich-block system (`InputRichBlock*`, `InputRichMessage.blocks/media`), **initial Communities support** (linked supergroups/channels/bots; `Community`, `community_chat_added/removed`), `BotSubscriptionUpdated` |
| **10.1** — Jun 11, 2026 | **Rich Messages** (`sendRichMessage`, `sendRichMessageDraft` streaming, `editMessageText.rich_message`): headings, lists, tables, quotes, details/collapse, math (LaTeX), maps, collages, slideshows, media blocks, thinking blocks. **Join Request Queries** (`answerChatJoinRequestQuery`, guard bots) |
| **10.0** — May 8, 2026 | **Guest Mode** (bots summoned via @mention into chats they never joined, up to 3 per message, minimal context), **bot-to-bot communication** (mutual opt-in via BotFather; groups via mention/reply, private via username), business bots without Premium requirement, `sendMessageDraft` for all bots |
| **9.6** — Apr 3, 2026 | **Managed Bots** (`getManagedBotToken`, `replaceManagedBotToken`, `requestChat` from Mini Apps incl. managed bots) |
| **9.5 / 9.4 / 9.0** | `date_time` entities, member tags, profile audios, expanded **Business Bot rights** (`read/deleteBusinessMessage`, rename, `postStory` on behalf of managed accounts) |

Other Verified bot capabilities (pre-existing, still current): inline keyboards/menus, Mini Apps (Bot API 8.0 gave fullscreen, home-screen shortcuts, subscriptions, sensors, gyroscope/accelerometer), Stars payments (`sendInvoice` with `currency: "XTR"`, subscriptions), polls/checklists/dice, stories posting (business/managed), reactions, custom emoji, forum topics, deep links, attachment menus, scheduled messages, paid media.

### What the Bot API canNOT do (Verified)
- **Join, publish to, or administer group calls / video chats / livestreams.** `phone.joinGroupCall`, `phone.joinGroupCallPresentation`, `phone.getGroupCallStreamRtmpUrl`, `phone.createGroupCall` are all **users-only** methods — "Can bots use this method: NO" ([MadelineProto API docs](https://docs.madelineproto.xyz/API_docs/methods/phone.joinGroupCall.html), [Telethon TL docs](https://tl.telethon.dev/methods/phone/join_group_call.html)). There is no Bot API endpoint for VoIP/WebRTC.
- **Obtain RTMP URLs/keys**, even via a business connection (`businessConnectionId`: NO for `getGroupCallStreamRtmpUrl`).
- Read full chat history by default (privacy mode), message other bots unless both opt in, or bypass FloodWait-style rate limits.

---

## B. Current MTProto API — what the client protocol adds

MTProto is the protocol official apps speak. Anything an official client can do is, in principle, automatable with a **user session** + the right TL methods. The authoritative reference is [core.telegram.org/api](https://core.telegram.org/api); the most complete searchable mirrors are [MadelineProto API docs](https://docs.madelineproto.xyz/) and [tl.telethon.dev](https://tl.telethon.dev/).

MTProto-only capabilities relevant to us (Verified):
- Full group-call lifecycle: `phone.createGroupCall`, `phone.joinGroupCall`, `phone.leaveGroupCall`, `phone.joinGroupCallPresentation` (screen share), `phone.editGroupCallParticipant`, `phone.toggleGroupCallSettings`, `phone.getGroupParticipants`, `phone.discardGroupCall`
- RTMP credentials: `phone.getGroupCallStreamRtmpUrl` (revocable key)
- Live stories: `stories.startLive` (incl. RTMP mode)
- Stream-mode consumption: `phone.getGroupCallStreamChannels` + `upload.getFile` with `inputGroupCallStream`
- Conference calls (E2E): `phone.createConferenceCall`, chain blocks, encrypted in-call messages
- Everything else clients do: full history, participants, admin ops, stories, reactions-as-user, etc.

---

## C. User account sessions — what a logged-in account can do that a bot cannot

| Capability | Bot token | User session (MTProto) |
|---|---|---|
| Send/edit messages, keyboards, Mini Apps, Stars invoices | ✅ | ✅ |
| Join voice/video chats, publish A/V, screen-share | ❌ | ✅ |
| Create/manage calls, fetch RTMP URL+key | ❌ | ✅ (admin/owner rights apply) |
| Appear as a real participant (needed for "assistant in call") | ❌ | ✅ |
| Be rate-limited / banned for spam patterns | FloodWait only | FloodWait + `PEER_FLOOD` + account bans + session revocation |

**Auth/session architecture (Verified, standard MTProto):** `api_id` + `api_hash` (from my.telegram.org) → phone number → OTP (`phone_code_hash` flow) → optional 2FA password → persistent session (auth key + DC state). Sessions serialize as **string sessions** (Pyrogram/Telethon/GramJS formats differ) and must be:
- encrypted at rest (KMS/envelope encryption, never plaintext in DB),
- never logged (redact `api_hash`, phone, OTP, session strings),
- revocable (user can terminate sessions from any client → our worker must detect `AUTH_KEY_UNREGISTERED` / `SESSION_REVOKED` and park the assistant),
- one identity per account; creating many accounts needs many phone numbers (real SIMs/eSIMs — this is the binding constraint on pool size, plus Telegram's anti-spam heuristics).

---

## D. Group calls — how they technically work (MTProto, Verified)

Four distinct call types exist on one shared primitive (`GroupCall` object, [group-calls docs](https://core.telegram.org/api/group-calls)):

1. **Video chat** — a group call attached to a basic group/supergroup (`phone.createGroupCall` with `peer` = group; needs `manage_call` admin right). One active call per chat.
2. **Livestream** — same primitive attached to a **channel**. Unlimited viewers; viewers pull media, speakers publish.
3. **Conference call** — E2E-encrypted multiparty call (`conference` flag, chain-block consensus). Not our target.
4. **Live story** — `stories.startLive`, can also run in RTMP mode.

**Join/publish flow (the part our worker must implement):**
```text
channels.getFullChannel / messages.getFullChat  →  full_chat.call (InputGroupCall)
local WebRTC engine (ntgcalls) generates join payload (ufrag/pwd/fingerprint/SSRC)
phone.joinGroupCall(call, join_as, params=DataJSON)  →  updateGroupCallConnection.params
feed connect params into WebRTC engine  →  SRTP media flows to Telegram call DC
phone.leaveGroupCall(call, source=our_ssrc)  →  clean exit
```
- `params` is a **WebRTC SDP-ish JSON blob** — you cannot hand-craft it; a call engine (ntgcalls/tgcalls) generates and consumes it. **Verified** via pytgcalls bridge source (`join_group_call` passes engine-generated `params` verbatim).
- **Screen share / presentation** is a *separate* join: `phone.joinGroupCallPresentation` + `phone.leaveGroupCallPresentation`. **Verified.**
- **Recording, scheduling** (`schedule_date`), **in-call messages/reactions** (`messages_enabled`, paid-stars messages), **raise-hand**, **volume/mute per participant** are all first-class MTProto features. **Verified.**
- Bots can't do any of the above. A **user session is mandatory** for every step. **Verified.**

---

## E. Livestreams — how they technically work

Same `GroupCall` primitive as D, attached to a channel. Two publish paths:

| Path | Publisher | How media gets in |
|---|---|---|
| **WebRTC participant** | A user account joins and publishes camera/mic/screen (same as video chat) | ntgcalls engine + `phone.joinGroupCall` |
| **RTMP ingest** | *Nobody joins* — external software pushes to Telegram's RTMP endpoint | FFmpeg/OBS → `rtmp://…` URL + stream key from `phone.getGroupCallStreamRtmpUrl` |

RTMP details (**Verified** via group-calls docs + MadelineProto):
- Only the **owner** can set `rtmp_stream=true` on `phone.createGroupCall`.
- Credentials are fetched with `phone.getGroupCallStreamRtmpUrl(peer, revoke)` — callable *before* creating the call; same key returned until revoked.
- An RTMP-mode call is flagged `groupCall.rtmp_stream=true`; **all** clients then play by downloading chunks (see H).
- Key = publish capability. Treat like a password: encrypt, scope per chat, rotate (`revoke=true`) on worker recycle or leak suspicion.

---

## F. RTMP — the architecture-changing detail

> RTMP ingest removes the "user must sit in the call" requirement for **one-to-many broadcast**.

Concretely: for channel livestreams and RTMP-enabled group video chats, the media path is just
`FFmpeg → RTMP → Telegram`. No WebRTC engine, no call participation, no per-stream user session needed
**at publish time**. (A user session is still needed to *create* the call and *fetch/rotate* the key — but
that identity does not have to stay in the call, so one admin account can provision keys for many chats.)

**Needs testing:** whether group (non-channel) RTMP requires the provisioning account to remain present,
exact codec/container constraints Telegram's RTMP ingest accepts (H.264+AAC is the safe baseline used by
every guide), and key lifetime/idempotency semantics across `revoke=false` calls.

---

## G. WebRTC / tgcalls — where it fits

Telegram group-call media is **custom-signaled WebRTC** (SRTP to Telegram call DCs). The signaling goes over
MTProto (`phone.joinGroupCall` params / `updateGroupCallConnection`), the media goes over UDP to the call DC.
You need a native engine that speaks Telegram's dialect. The ecosystem, current state (Verified via repos/PyPI, Sep 2026):

| Engine | Status | Notes |
|---|---|---|
| **[ntgcalls](https://github.com/pytgcalls/ntgcalls)** (C++ core, pytgcalls org) | ✅ Active — commits days ago, v2.x on PyPI/npm/crates, prebuilt binaries (Linux x64/arm64, macOS arm64, Windows, Android) | The current standard. Bindings: Python, **Node.js (`npm i ntgcalls`)**, Rust, Go, C, Android. Codecs: H.264/HEVC/VP8/VP9/AV1, AAC/MP3/Opus. Screen share supported. LGPL-3.0 ⚠ (license implication for static linking/distribution — dynamic-link or isolate in worker process). |
| [pytgcalls](https://github.com/pytgcalls/pytgcalls) (async Python API over ntgcalls) | ✅ Active | Pairs with Pyrogram-forks/Telethon/Hydrogram. Historically the most stable music-bot stack. |
| [tgcalls-js](https://github.com/kotakbiasa/tgcalls-js) (Node wrapper: ntgcalls + GramJS/teleproto) | ✅ Active, v0.2.x, audio+video+presentation | Proves the Node path works; small-maintainer risk — vendor or fork, don't depend blindly. |
| MarshalX `tgcalls` (original C++ binding) | ❌ Archived (last update Jan 2023) | Do not build on this. |
| `gotgcall` (pure-Go, no libwebrtc) | 🆕 Experimental (Jun 2026) | Interesting (no native chain) but immature — watch, don't bet on yet. |

**MTProto client libraries (Verified, Aug–Sep 2026):**
- **Python:** original **Pyrogram archived Dec 2024** → use maintained forks (**Pyrofork**, Kurigram, Hydrogram). **Telethon moved GitHub→Codeberg Feb 2026**, maintainer calls it "maintenance mode" (bug fixes + layer updates, no big features). Both still work with pytgcalls.
- **Node/TypeScript:** GramJS (`telegram` package) + **teleproto** (GramJS-family fork) are what `tgcalls-js` is tested against. For Bot API: **grammY** (modern standard) or Telegraf.
- **PHP:** MadelineProto is alive and is the best *documentation* of every TL method (explicit "Can bots use this" flags) regardless of our stack choice.

**Implication:** the reliable 2026 stacks are **Python (Pyrofork + pytgcalls/ntgcalls)** for maximum battle-testing,
or **Node (GramJS/teleproto + ntgcalls via tgcalls-js-style wrapper)** for stack uniformity. Both need FFmpeg on PATH and UDP egress to Telegram DCs.

---

## H. Stream mode — how Telegram scales large audiences

**Verified** (group-calls docs, "Stream mode" section): when a call's audience grows past a threshold, Telegram flips
clients from WebRTC participation to **chunked playback** — media segments fetched over HTTPS-ish MTProto
(`phone.getGroupCallStreamChannels` → `inputGroupCallStream{time_ms, scale, video_channel, video_quality}` →
`upload.getFile`). RTMP-mode calls are *always* in this mode.

Why it matters to us:
- We never fan out to viewers ourselves — Telegram does. Our bandwidth is **one uplink per stream** (publish leg only).
- Publishing still happens over WebRTC (normal calls) or RTMP (RTMP calls) — stream mode changes *consumption*, not our publish path.
- Downloading our own stream's chunks is a possible (if clunky) health-check/relay mechanism. Needs testing.

---

## I. Multiple groups — what is realistically possible concurrently

The hard question. Honest answers:

| Question | Answer | Confidence |
|---|---|---|
| Can one user account be in 2+ group calls at once? | **No.** One active call participation per account — the join binds the account's SSRC/connection to one `InputGroupCall`; ecosystem-wide practice (every multi-group music bot runs an assistant pool) confirms it. | **Likely** (not stated in one official sentence; universally observed — **Needs testing** on test DCs to be rigorous) |
| Can one account *provision* many RTMP streams? | **Yes** — creating calls + fetching keys are plain MTProto RPCs, no call membership required at publish time. This is the scaling unlock for broadcast-style streaming. | **Likely / Needs testing** (rate limits + owner-rights per chat still apply) |
| Do WebRTC (music-bot-style, interactive) multi-group streams need N accounts? | **Yes — one assistant account per concurrent interactive call**, each in its own worker with its own FFmpeg + ntgcalls engine. Pool + Redis lock + queue overflow ("all lines busy, queue #2"). | **Verified practice** (standard architecture across all open music-bot fleets) |
| Can bots be in unlimited groups? | Bots have no group-count problem (large bots serve thousands of chats). Limits that bite are **rate limits** (~30 msg/s broadcast, 1 msg/s per chat, FloodWait) and admin-rights requirements. | **Verified** |
| CPU/bandwidth per stream | FFmpeg transcode ≈ fractional-to-1 vCPU per live A/V stream (audio-only is cheap; H.264 720p is the real cost); network ≈ single uplink (2–4 Mbps for 720p, ~64–128 kbps audio-only). Telegram fans out to viewers. | **Likely** (standard transcoding math; measure in load test) |
| Session/account risks at scale | Fresh accounts + datacenter IPs + join spam = bans. Pool accounts need warm-up, human-like behavior, no phone/OTP in logs, revocation handling, per-account FloodWait backoff. | **Verified practice** |

**Architecture consequence:** two lanes —
- 🅰 **Interactive lane** (voice-chat DJ: pause/skip/queue, in-call presence) = assistant pool, 1 account : 1 call.
- 🅱 **Broadcast lane** (channels, scheduled shows, 24/7 radio) = RTMP ingest workers, no per-call account, scales with CPU only.

---

## J. Security — how sessions and stream credentials must be protected

Non-negotiables (design constraints, not suggestions):
1. **Secrets inventory:** `api_id`/`api_hash`, phone numbers, OTP codes, 2FA passwords, string sessions, RTMP keys, bot tokens. Every one is a full account/bot takeover primitive.
2. **Never** in source, logs, error messages, or client-visible payloads. Structured logger with redaction; OTP/2FA handled in a short-lived provisioning flow, never persisted.
3. **At rest:** envelope encryption (KMS) for sessions + RTMP keys; per-chat scoping; `revoke=true` rotation on worker recycle.
4. **In transit / at runtime:** workers receive decrypted sessions only in memory; provisioning service separate from streaming workers; mTLS or sealed secrets between controller → queue → workers.
5. **Revocation-driven design:** expect `AUTH_KEY_UNREGISTERED`/`SESSION_REVOKED`; worker must self-park, alert, and release the chat lock so another assistant can take over.
6. **Abuse containment:** per-account rate limiters, warmed-up accounts, residential/non-flagged egress where possible, human-like join cadence, instant kill-switch per assistant.
7. **Supply chain:** ntgcalls is LGPL-3.0 (keep it dynamically linked / in its own process); pin `t(Level)` layers; verify session-string formats per library (they are NOT interchangeable).

---

## K. Modern Telegram UX — what we can build on Bot API 10.x

With Rich Messages + Ephemeral + Guest + Mini Apps + Stars, the 2026 UX palette is:
- **Now-playing cards** as Rich Messages (cover art, progress, queue table, inline buttons) streamed/edited live via `sendRichMessageDraft` + `editMessageText.rich_message`.
- **Private controls in public groups** via Ephemeral messages (volume, queue mgmt visible only to requester).
- **Zero-install DJ summoning** via Guest Mode (`@OurBot play …` in any chat, no invite needed).
- **Full console** as a Mini App (queue management, scheduling, analytics, Stars subscriptions) launched from bot profile, deep link, or attachment menu.
- **Monetization** via Stars invoices + subscriptions (`XTR`), paid in-call messages, premium assistant priority lanes.
- **Multi-bot orchestration** via bot-to-bot (e.g., separate Search bot ↔ Player bot ↔ Moderation bot cooperating in one group).

---

## 🗺️ "WHAT WE CAN BUILD" MAP

```text
🟢 Easily possible (Bot API only)
  • Controller bot: commands, inline buttons, search, queues, per-chat settings, admin rights mgmt — WHY: pure Bot API 10.3.
  • Rich now-playing / queue UIs, streaming AI replies, ephemeral private controls — WHY: Rich Messages + drafts + ephemeral are first-class 10.1–10.3.
  • Guest-mode summoning (@bot play X anywhere) — WHY: Guest Mode 10.0, no membership needed.
  • Stars monetization (invoices, subscriptions, pay-per-skip) — WHY: Bot Payments API, currency XTR, no approval needed.
  • Mini App console (dashboard, scheduler, analytics) — WHY: mature Mini Apps platform + 8.0 capabilities.
  • Scheduled posts/reminders, polls, stories (via business/managed), welcome flows, guard-bot join questions — WHY: all Bot API.

🟡 Possible with MTProto / user session (the assistant layer)
  • Music-bot-style interactive voice-chat streaming (join, play, pause/skip, leave) — WHY: phone.* + ntgcalls + user session; standard, proven pattern.
  • Video + screen-share publishing into calls — WHY: same stack, presentation join is a separate documented method.
  • Multi-group interactive streaming — WHY: assistant pool, 1 account : 1 call; scales with accounts + workers.
  • RTMP key provisioning + call creation automation — WHY: plain MTProto RPCs on an admin user session.
  • In-call moderation (mute/kick-by-admin-rights, volume, raise-hand flow) — WHY: editGroupCallParticipant etc. are user-session RPCs.

🟠 Possible but technically complex (needs real engineering + testing)
  • 24/7 multi-channel RTMP broadcast network (radio stations, scheduled shows) — WHY: RTMP removes per-call accounts, but needs ingest fleet, key rotation, health monitoring, codec discipline. No official "publish API" — it's FFmpeg-to-ingest + automation around it.
  • Seamless assistant failover / call migration — WHY: no "move call" primitive; must leave+rejoin, audible gap, SSRC bookkeeping.
  • Recording + VOD pipeline (capture → store → replay) — WHY: record flags exist, but retrieval/storage/transcode chain is ours to build; test-DC verification needed.
  • Large-fleet account warming + ban-avoidance ops — WHY: undocumented heuristics, learned empirically, ongoing ops cost.

🔴 Not currently possible / restricted
  • Bot token joining or publishing to any call — WHY: VoIP/WebRTC endpoints don't exist in Bot API; phone.* methods reject bots. Verified.
  • Bot fetching RTMP keys (even via business connection) — WHY: explicitly disallowed server-side. Verified.
  • One account in two calls at once — WHY: single active call participation per account (Likely/Needs-test, but architect as fact).
  • True P2P personal-call automation at scale — WHY: handshake/crypto/rate-limit friction, spam-triggering, no legitimate automation surface.
  • Reading other bots' messages without opt-in, or joining chats uninvited (except guest-mode scoped replies) — WHY: platform spam/privacy guards.

⚠️ Requires external infrastructure (Telegram won't do it for us)
  • Media sourcing + transcode (yt-dlp/YouTube, HLS, Spotify*, local files → FFmpeg → PCM/H.264) — WHY: Telegram ingests streams; it doesn't fetch or transcode them.
  • Queue/state/pool orchestration (Redis/BullMQ, Postgres) — WHY: Telegram holds no queue state for us.
  • Observability (call health, SSRC liveness, chunk checks, FloodWait telemetry) — WHY: no dashboard; we build it.
  • Worker fleet (CPU for transcode, UDP egress to call DCs, graceful SIGINT/SIGTERM drain) — WHY: real-time media needs real servers.
```

\* Spotify/Apple: no audio API for full tracks — metadata + resolve to YouTube/audio-source, or user-uploaded files. Don't promise direct Spotify streaming.

---

## Recommended next step (not implementation yet)

Per §18, the pipeline is `Product idea → Requirements → Architecture → …`.
The single highest-leverage decision is **Lane 🅰 (interactive assistants) vs Lane 🅱 (RTMP broadcast)** vs both —
it determines accounts, workers, cost, and UX. Once you pick the product shape, we do requirements + architecture.

## Sources (authoritative-first)
- Bot API changelog (10.0–10.3): core.telegram.org/bots/api-changelog
- Bot API reference / bot-to-bot / guest bots: core.telegram.org/bots/api, /api/bots/bot-to-bot
- Group calls / RTMP / stream mode: core.telegram.org/api/group-calls
- TL method mirada (bot-vs-user flags): docs.madelineproto.xyz, tl.telethon.dev, docs.pyrogram.org
- Engines: github.com/pytgcalls/ntgcalls, github.com/pytgcalls/pytgcalls, github.com/kotakbiasa/tgcalls-js
- MTProto libs: Pyrogram archived Dec 2024 (github.com/pyrogram/pyrogram), Telethon→Codeberg Feb 2026, GramJS/teleproto, grammY
- BotNews announcements (10.0/10.1/10.3): t.me/s/botnews
