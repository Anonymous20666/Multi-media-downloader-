import assert from "node:assert/strict";
import test from "node:test";
import {
  StreamWizardRegistry,
  renderWizardMode,
  renderWizardDurationType,
  renderWizardMinutes,
  renderWizardHours,
  renderWizardCustomHoursPrompt,
  renderWizardVibe,
  renderWizardCustomVibePrompt,
  renderWizardMovieCategories,
  renderWizardCustomMoviePrompt,
  renderWizardConnecting,
} from "./stream-wizard.js";

test("StreamWizardRegistry manages lifecycle, indexes by user, and handles expiry", () => {
  const reg = new StreamWizardRegistry();
  const session = reg.create(-100123, 42, 999);
  assert.ok(session.id.startsWith("sw"), "session id should start with sw prefix");
  assert.equal(session.chatId, -100123);
  assert.equal(session.userId, 42);
  assert.equal(session.messageId, 999);
  assert.equal(session.step, "mode");

  // Lookup by ID
  const found = reg.get(session.id);
  assert.equal(found?.id, session.id);

  // Lookup by chat+user
  const byUser = reg.findByUser(-100123, 42);
  assert.equal(byUser?.id, session.id);

  // Deletion
  reg.delete(session.id);
  assert.equal(reg.get(session.id), undefined);
  assert.equal(reg.findByUser(-100123, 42), undefined);

  // Expiration
  const expiredSession = reg.create(-100123, 99, 1000);
  expiredSession.expiresAt = Date.now() - 1000; // in the past
  assert.equal(reg.get(expiredSession.id), undefined, "expired session should return undefined");
});

test("Stream wizard steps render compliant rich payloads and valid callback data", () => {
  const sid = "sw1_test";

  // Step 1: Mode
  const mode = renderWizardMode(sid);
  assert.ok(mode.rich_message.includes("SELECT MEDIUM"));
  const modeCallbacks = mode.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(modeCallbacks.some((cb) => cb.includes(`v1.swm.${sid}:music.`)));
  assert.ok(modeCallbacks.some((cb) => cb.includes(`v1.swm.${sid}:video.`)));
  assert.ok(modeCallbacks.some((cb) => cb.includes(`v1.swx.${sid}.`)));

  // Step 2: Duration Type
  const durType = renderWizardDurationType(sid);
  assert.ok(durType.rich_message.includes("TIME SCALE"));
  const durTypeCallbacks = durType.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(durTypeCallbacks.some((cb) => cb.includes(`v1.swd.${sid}:min.`)));
  assert.ok(durTypeCallbacks.some((cb) => cb.includes(`v1.swd.${sid}:hr.`)));
  assert.ok(durTypeCallbacks.some((cb) => cb.includes(`v1.swb.${sid}.`)));

  // Step 3A: Minutes Grid
  const mins = renderWizardMinutes(sid);
  assert.ok(mins.rich_message.includes("SELECT MINUTES"));
  const minCallbacks = mins.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(minCallbacks.some((cb) => cb.includes(`v1.swv.${sid}:15m.`)));
  assert.ok(minCallbacks.some((cb) => cb.includes(`v1.swv.${sid}:60m.`)));
  assert.ok(minCallbacks.some((cb) => cb.includes(`v1.swdb.${sid}.`)));

  // Step 3B: Hours Grid + Custom
  const hours = renderWizardHours(sid);
  assert.ok(hours.rich_message.includes("SELECT HOURS"));
  const hourCallbacks = hours.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(hourCallbacks.some((cb) => cb.includes(`v1.swv.${sid}:1h.`)));
  assert.ok(hourCallbacks.some((cb) => cb.includes(`v1.swv.${sid}:24h.`)));
  assert.ok(hourCallbacks.some((cb) => cb.includes(`v1.swc.${sid}.`)));

  // Step 3C: Custom Hours Prompt
  const customPrompt = renderWizardCustomHoursPrompt(sid);
  assert.ok(customPrompt.rich_message.includes("CUSTOM DURATION"));

  // Step 4: Vibe Picker
  const vibe = renderWizardVibe(sid, "2 hrs");
  assert.ok(vibe.rich_message.includes("2 hrs"));
  const vibeCallbacks = vibe.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(vibeCallbacks.some((cb) => cb.includes(`v1.swq.${sid}:Afrobeats.`)));
  assert.ok(vibeCallbacks.some((cb) => cb.includes(`v1.swq.${sid}:Trap.`)));
  assert.ok(vibeCallbacks.some((cb) => cb.includes(`v1.swq.${sid}:Juice_WRLD.`)));
  assert.ok(vibeCallbacks.some((cb) => cb.includes(`v1.swcv.${sid}.`)));
  assert.ok(vibeCallbacks.some((cb) => cb.includes(`v1.swvb.${sid}.`)));

  // Step 4B: Custom Vibe Prompt
  const customVibe = renderWizardCustomVibePrompt(sid);
  assert.ok(customVibe.rich_message.includes("SEARCH ARTIST"));

  // Movie categories
  const movieCat = renderWizardMovieCategories(sid);
  assert.ok(movieCat.rich_message.includes("SELECT CINEMA"));
  const movieCallbacks = movieCat.reply_markup.inline_keyboard.flat().map((b) => b.callback_data ?? "");
  assert.ok(movieCallbacks.some((cb) => cb.includes(`v1.swmc.${sid}:Anime.`)));
  assert.ok(movieCallbacks.some((cb) => cb.includes(`v1.swmc.${sid}:Action.`)));
  assert.ok(movieCallbacks.some((cb) => cb.includes(`v1.swcm.${sid}.`)));

  // Custom movie prompt
  const customMovie = renderWizardCustomMoviePrompt(sid);
  assert.ok(customMovie.rich_message.includes("SEARCH FILM"));

  // Connecting Card
  const connecting = renderWizardConnecting("Juice WRLD", "4 hrs");
  assert.ok(connecting.rich_message.includes("CONNECTING VOICE CHAT"));
  assert.ok(connecting.rich_message.includes("Juice WRLD"));
  assert.ok(connecting.rich_message.includes("4 hrs"));
});
