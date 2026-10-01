# OMEGA — The Ultimate Build Prompt (v1)

> Copy everything below the line into any elite builder (human or AI).
> It contains the full vision, the platform truth, every flow, and the 10x gaps
> the owner didn't mention — already designed.

---

You are the principal engineer + product designer for **OMEGA** (a.k.a. Pappy),
a Telegram-native multi-functional media OS. One bot, three arenas: **DM** (personal
assistant), **Groups** (smart shared menu + downloads + listening/watch parties),
**Voice/Video calls** (a real DJ + cinema engine). It must feel effortless to a
first-time user and survive thousands of concurrent users without silently dropping
a single request.

## 0. How you work (non-negotiable)

1. **Verify, never guess.** Every Telegram capability, SDK method, and limit must be
   checked against current docs/source before you build on it. Label claims:
   `Verified` (docs/source seen), `Likely` (strong evidence), `Unknown`, `Needs-testing`
   (only provable live — must ship with a game-day plan, never silently).
2. **Never conflate the four Telegram APIs.** State which one each feature uses:
   **Bot API** (HTTPS bot, messaging/media/inline/keyboards — CANNOT join calls),
   **MTProto client API** (`phone.*`, raw methods — users only), **user sessions**
   (assistant accounts — the ONLY thing that can publish audio/video into a call),
   **Mini Apps** (web UI surface). Bot-in-call publishing does not exist; any design
   pretending otherwise is rejected.
3. **Rich Message-first, fallback-always.** Every surface renders a Bot API 10.x rich
   message AND a text+keyboard fallback that works on every client. Any rich failure
   degrades instantly and is logged (which renderer won, for telemetry).
4. **No dead ends, no silence, no stress.** Every user action ends in exactly one of:
   success receipt, honest progress, or an honest failure card with a next step.
   Long operations ALWAYS show a "processing" state first. Users never wonder
   "is it working?".
5. **Slice it, prove it.** Ship in thin vertical slices, each with automated tests and
   a live verification step. Load gates: 100 → 1k concurrent before claiming scale.

## 1. Platform truth table (build ONLY inside this)

| Capability | API | Truth |
|---|---|---|
| Menus, buttons, inline options, file delivery, albums, reactions, chat actions | Bot API | ✅ Full power — use to the max |
| Inline mode (`@bot query` anywhere) | Bot API | ✅ Requires BotFather inline toggle |
| Group-call audio/video publishing | User session + WebRTC engine (`phone.joinGroupCall`) | ✅ But: ONE account = ONE call at a time (pool for multi-group) |
| Bot joining/speaking in a call | — | ❌ Does not exist |
| Per-viewer seek/speed/subs/dub inside a live call | — | ❌ Impossible: viewers consume ONE live program. Map to **Global Program Controls** (pause-all, skip, restart-from-offset, variant-switch-with-brief-gap — every control labeled "affects everyone") PLUS **"Send me my copy"** → personal DM delivery where the user gets full Netflix-style control. Never render fake per-viewer seek bars. |
| Assistant joining a group | Invite link minted by the bot (admin + invite rights) → account joins via link | Bots cannot add users directly. Promoting the account needs `can_promote_members`. |
| Speaking without interruption | Account as admin with Manage Calls (avoids mute/kick) | Enforced by pre-flight audit (see §5). |

## 2. Entry: `/start` + menus (Bot API 10.x rich)

- `/start` renders the **hub**: Music · Movies · Series · Shorts · Search · Paste-a-link ·
  Ask Omega · Stream · Settings — rich blocks + buttons, fallback twin, one-tap each.
- First-run onboarding (3 steps max, skippable): what I do → try a song → done. No manuals.
- Persistent command menu + menu button auto-registered on boot (owner gets the
  owner scope with `/admin`).
- **Group smart menu** (rich, pinned optionally): `▶ Play` · `🎬 Movie` · `📡 Stream` ·
  `⚡ Shorts` · `🔎 Search` — same download brain as DM, group-aware replies.

## 3. Owner console (everything operable from owner DM)

- Dashboard: users, bans, providers (live enable/disable), queues, worker heartbeats,
  stream pool status, today's funnel (search→delivery, stream stability).
- **Force-join allocator:** add/remove/toggle MULTIPLE channels/groups (id, invite, title,
  priority). Join card preserves the user's request across Verify and resumes it after.
- Ban/unban, broadcast controls (rate-guarded), pool management (add/retire assistant
  accounts), provider toggles, feature flags (alpha groups, AI on/off), budget guards
  (LLM + recognition spend caps with alerts).
- Every owner action is audited (who, what, when).

## 4. DM flows (zero-stress personal assistant)

1. **Text in** → disambiguation buttons: `🎵 Music` `🎬 Video` `🍿 Movie` (remember last
   choice per user; one-tap to change). Then an **inline-style option list**: numbered
   `title — artist + duration + source` rows as buttons (paginated, ≤8 visible).
   Tap → options message is DELETED → file arrives with **full metadata attachment**
   (title, artist, duration, source, quality badge, cover) + attached buttons:
   `▶ Stream it` `➕ Playlist` `🔗 Share`.
2. **Audio/voice in** → recognition (ACR provider + fallback chain) → same option list.
   Unidentifiable → honest card ("couldn't ID this — try a longer/cleaner clip") + tips.
3. **Link in** → manifest gallery: numbered per-item buttons + capped batch (cap disclosed
   ON the card) delivered as **albums**, named-failure finale, back-to-gallery.
4. **Subtitles:** `/subs <title> <lang>` + "get subtitles" on any video: embedded-track
   extraction first, then subtitle providers, then clearly-labeled machine generation.
   Any language; failures name which step failed.
5. **Language setting** (default `en`): drives search locale, UI strings, subtitle default.
   Full i18n framework — no hardcoded strings in flows.
6. **Pinterest + images:** visual search surface with grid-style option cards → download.

## 5. Group streaming (the crown jewel) — exact choreography

**Pre-flight (runs before EVERYTHING, admin-only entry):** bot audits itself —
am I admin? `can_invite_users`? `can_promote_members`? Is an assistant account free in
the pool? Is the worker alive? Each check renders ✅/❌ with a one-tap fix path.
Streaming never starts half-ready; failures explain the exact missing piece.

**Music stream wizard:**
1. `📡 Stream` → `🎵 Music` / `🎬 Videos`.
2. **Duration picker (interactive buttons):** `Minutes` `Hours` `Days` →
   Minutes: 1–60 grid · Hours: 1–24 grid + **custom typed input** (accepts e.g. `30`,
   deletes the user's message after reading) · Days: 1–30 · Always: `‹ Prev` `Cancel ✕`.
3. **Content picker:** artist(s), genre/mood, or vibe words ("juice wrld", "hiphop",
   "trap", "sad", "workout") — multi-select, confirmable, "surprise me" option.
   AI-assisted matching (see §7).
4. **Processing card** ("setting up your stream…": inviting assistant → promoting →
   joining call → loading first track — each step ticks live).
5. **LIVE pinned show card:** now-playing art (video preview if the track HAS one,
   else cover image, else animated speaker state), full metadata, progress line, and
   attached transport: `⏸ ⏭ ⏮ ⬇(download this song) ➕(playlist)`. Card is **pinned**;
   worker notices unpin and re-pins. Track changes edit the card in place.

**Movie stream wizard:** title FIRST (never duration first) → rich metadata list
(poster, year, rating, duration, quality badge) → series expand to seasons/episodes
(multi-select; plays in order) → random/genre/anime/action browsers for discovery →
HD policy: probe actual resolution, badge it honestly, refuse-and-say-so below 720p
unless user overrides → LIVE card + **Global Program Controls, Netflix-mapped**:
pause-all, restart-from-offset ("jump to 12:30"), speed via re-transcode (labeled
"brief gap, affects everyone"), subtitle track + dub/sub audio reselect (gap-labeled),
and `📩 Send me my copy` for full personal control in DM.

**Shorts:** vertical short-video queue from configured sources, length-capped, same
transport minus seek.

**Fairness:** per-user request quotas in groups, admin override, optional vote-skip
(configurable threshold). One user can never flood the party.

## 6. The AI assistant (Omega) — chatable, tooled, capped

- Name: Omega. Trigger: reply/mention/`ask` mode + natural DM chat.
- Tools (audited): `search_media`, `play_now`, `queue_add`, `stream_control
  (pause/resume/skip/stop)`, `playlist_add`, `faq_answer`. AI proposes; **destructive
  or group-affecting actions render confirm buttons** — AI never silently acts on a crowd.
- Understands: "pappy play Lithe", "I want sad movies", "stream afrobeats for 2 hours",
  "skip this", "download that song". Every AI reply ends with actionable buttons
  (fallback when confidence is low — never a shrug).
- Guardrails: spend caps + alerts, containment metric (did buttons finish it?),
  jailbreak-resistant system prompt, full audit log, instant owner kill-switch.

## 7. Scale: thousands, zero silent drops

- Ingress → dedupe (single-flight identical requests) → priority lanes
  (control > interactive > background) → provider fan-out with breakers → delivery.
- Backpressure WITH a face: when loaded, users see "you're #N, ~Xs" — never spinning void.
- SLOs (prove on harness + staging): p95 first-response < 2s at 1k concurrent DM
  requests; every request terminates in receipt or honest failure (zero silent drops
  is THE invariant — test it with fault injection: kill workers mid-flight).
- 24/7 ops: supervision + auto-restart, zero-downtime deploys (drain-then-ship for
  streams), Redis persistence, Postgres state, health/readiness/metrics endpoints,
  owner alerts (worker down, pool exhausted, budget 80%).

## 8. Media + legal policy (the unsexy part that keeps us alive)

- Source tiers: licensed → public → UGC-platform → gray(listed, flagged, owner-toggled)
  → blocked. Nothing gray is silent — badges everywhere.
- Quality honesty: probe and badge real resolution/bitrate; never upscale-and-label.
- Takedown flow: rights-holder intake → block hash → audit. 18+ gating where applicable.
  Privacy: export/delete-my-data commands, retention windows. Jurisdiction noted in ops docs.

## 9. The 10x gaps (designed for you — build them too)

1. Account pool + scheduler (1 account = 1 call; months-long + multi-group math).
2. Request-vs-control permission matrix per group (defaults + overrides).
3. Abuse: group anti-spam, NSFW policy, ban appeals, rate-abuse handling.
4. Monetization hooks (Stars/premium lanes) — architect now, price later.
5. Analytics: funnels, provider SLAs, stream-stability telemetry, AI containment.
6. Recording/VOD: experimental, proof-gated — never promised until proven.
7. Full i18n incl. RTL-ready strings; subtitle language matrix.
8. Chaos suite: worker-kill, Redis-flap, provider-outage, 24h soak — all green before "stable".
9. Onboarding, empty states, and error-copy review (every failure card must pass the
   "grandma test": what happened, why, what to do next).
10. Staging environment mirroring prod + prod game-day policy before EVERY release.

## 10. Milestones + acceptance

- **M1 DM core:** §4 flows green + load 1k + zero silent drops proven by fault injection.
- **M2 Groups + menus:** §2 group menu + downloads at parity with DM + fairness live.
- **M3 Streaming alpha:** ONE flagged group, §5 wizards + live cards + pre-flight green,
  24h soak incl. induced failures.
- **M4 AI + cinema:** §6 Omega tooled + §5 movie controls + subs/dub mapping.
- **M5 Hardening:** §7 SLOs + §8 policy + §9 suite — then multi-group pool.

## 11. Definition of done (every slice)

Builds clean · tests green (unit + contract + load where touched) · fallback renderer
proven by forced-rich-failure · docs updated (README + runbook) · live-verified on
staging with logs attached · no secret in code/logs · owner can operate it from DM.

Now: restate the slice plan in your own words, then build M1-slice-1.
