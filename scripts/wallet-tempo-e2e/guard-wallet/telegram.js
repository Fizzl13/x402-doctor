// Approve over-limit signatures from your phone, with a Telegram bot.
//
//   import { telegramApprover } from "presign-guard-wallet/telegram";
//   guardWallet(walletClient, { pay, limits, onOverLimit: telegramApprover({ token, chatId }) });
//
// When a signature would cross a limit, the bot sends you a message with what
// the agent wants to sign, why it is over the limit and presign-guard's verdict,
// with Approve and Deny buttons. The agent waits for your tap (default 10
// minutes); no answer in time counts as Deny. Only the people you allow
// (default: the chat itself, i.e. you in a private chat) can answer.
//
// No server needed: the wallet asks Telegram for button taps itself (long
// polling, getUpdates). So the bot must not have a webhook, and only one
// process at a time can poll one bot: give each agent process its own bot.
// The bot token is a secret: keep it in an environment variable.

const API = "https://api.telegram.org";
const escape = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const nonce = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

function client(token, fetchImpl, api) {
  if (typeof token !== "string" || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) throw new TypeError("token must be a Telegram bot token (123456:ABC…), from @BotFather");
  return async (method, body, signal) => {
    const res = await fetchImpl(`${api}/bot${token}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal });
    const data = await res.json().catch(() => null);
    if (!data?.ok) {
      const err = new Error(`Telegram ${method} failed: ${data?.description ?? `HTTP ${res.status}`}`);
      err.status = data?.error_code ?? res.status;
      throw err;
    }
    return data.result;
  };
}

// One poller per bot token in this process, shared by every waiting request.
const pollers = new Map();
function poller(token, call) {
  let p = pollers.get(token);
  if (p) return p;
  p = { waiters: new Map(), offset: undefined, running: false, abort: null };
  pollers.set(token, p);
  p.start = () => {
    if (p.running) return;
    p.running = true;
    (async () => {
      while (p.waiters.size) {
        p.abort = new AbortController();
        let updates;
        try {
          updates = await call("getUpdates", { offset: p.offset, timeout: 25, allowed_updates: ["callback_query"] }, p.abort.signal);
        } catch (err) {
          if (!p.waiters.size) break; // aborted because nobody waits any more
          if (err.status === 409 || err.status === 401 || err.status === 404) {
            // A webhook, another process polling this bot, or a bad token: nobody can answer.
            for (const w of p.waiters.values()) w.fail(err);
            p.waiters.clear();
            break;
          }
          await new Promise((ok) => setTimeout(ok, 2000)); // network hiccup: try again
          continue;
        }
        for (const u of updates) {
          p.offset = u.update_id + 1;
          const q = u.callback_query;
          const m = /^pgw:([a-z0-9]+):(y|n)$/.exec(q?.data ?? "");
          const w = m && p.waiters.get(m[1]);
          if (!w) { if (q?.id && m) call("answerCallbackQuery", { callback_query_id: q.id, text: "This request has already been decided or expired." }).catch(() => {}); continue; }
          if (!w.allowed(q)) { call("answerCallbackQuery", { callback_query_id: q.id, text: "You are not allowed to answer this." }).catch(() => {}); continue; }
          w.decide(m[2] === "y", q);
        }
      }
      p.running = false;
      if (p.waiters.size) p.start(); // someone started waiting while this loop was ending
    })();
  };
  p.stopIfIdle = () => { if (!p.waiters.size) p.abort?.abort(); };
  return p;
}

function messageFor(info, label) {
  const lines = [`<b>${escape(label)} wants to sign something over your limit</b>`, ""];
  lines.push(escape(info.summary));
  if (info.purchase?.description || info.purchase?.url) {
    lines.push("");
    if (info.purchase.description) lines.push(`for: ${escape(info.purchase.description)}`);
    if (info.purchase.url) lines.push(`<code>${escape(info.purchase.url)}</code>`);
  }
  const r = info.request ?? {};
  lines.push("", `<code>${escape(info.method)}</code> · chain ${escape(r.chainId)}${r.to ? ` · to <code>${escape(r.to)}</code>` : ""}`);
  const v = info.verdict?.verdict;
  if (v) {
    const codes = (info.verdict.reasons ?? []).filter((x) => x.severity !== "info").map((x) => x.code).join(", ");
    lines.push(`presign-guard: <b>${escape(v)}</b>${codes ? ` (${escape(codes)})` : ""}`);
  } else lines.push("presign-guard: no verdict for this one");
  const spent = (info.spending ?? []).map((s) => `${escape(s.token)} ${escape(s.used)}${s.perDay ? ` / ${escape(s.perDay)}` : ""}`).join(" · ");
  if (spent) lines.push(`spent this window: ${spent}`);
  return lines.join("\n");
}

/**
 * An onOverLimit for guardWallet that asks you on Telegram.
 * @param {object} o
 * @param {string} o.token  bot token from @BotFather (keep it in an env var)
 * @param {string|number} o.chatId  your chat with the bot (see findTelegramChats)
 * @param {Array<string|number>} [o.allowedUserIds]  who may answer (default: chatId)
 * @param {number} [o.timeoutMs]  how long the agent waits (default 10 minutes); no answer = deny
 * @param {string} [o.label]  name of the agent in the message (default "Your agent")
 * @param {typeof fetch} [o.fetch]
 * @param {string} [o.api]
 */
export function telegramApprover({ token, chatId, allowedUserIds, timeoutMs = 600_000, label = "Your agent", fetch: fetchImpl = globalThis.fetch, api = API } = {}) {
  const call = client(token, fetchImpl, api);
  if (chatId === undefined || chatId === null || chatId === "") throw new TypeError("chatId is required (send /start to your bot, then findTelegramChats({ token }))");
  if (!(timeoutMs > 0)) throw new TypeError("timeoutMs must be a positive number of milliseconds");
  const allowedIds = new Set((allowedUserIds ?? [chatId]).map(String));

  return async function onOverLimit(info) {
    const id = nonce();
    const sent = await call("sendMessage", {
      chat_id: chatId,
      text: messageFor(info, label),
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{ text: "Approve", callback_data: `pgw:${id}:y` }, { text: "Deny", callback_data: `pgw:${id}:n` }]] },
    });
    const p = poller(token, call);
    const answer = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { p.waiters.delete(id); p.stopIfIdle(); resolve({ ok: false, timeout: true }); }, timeoutMs);
      p.waiters.set(id, {
        allowed: (q) => allowedIds.has(String(q.from?.id)) && String(q.message?.chat?.id) === String(chatId),
        decide: (ok, q) => { clearTimeout(timer); p.waiters.delete(id); p.stopIfIdle(); resolve({ ok, q }); },
        fail: (err) => { clearTimeout(timer); reject(err); },
      });
      p.start();
    });
    const who = answer.q?.from?.username ? `@${answer.q.from.username}` : answer.q?.from?.first_name ?? "you";
    const outcome = answer.timeout ? `<b>No answer in ${Math.round(timeoutMs / 60_000) || 1} min: not signed.</b>` : answer.ok ? `<b>Approved by ${escape(who)}: signing.</b>` : `<b>Denied by ${escape(who)}: not signed.</b>`;
    if (answer.q?.id) call("answerCallbackQuery", { callback_query_id: answer.q.id, text: answer.ok ? "Approved" : "Denied" }).catch(() => {});
    call("editMessageText", { chat_id: chatId, message_id: sent.message_id, text: `${messageFor(info, label)}\n\n${outcome}`, parse_mode: "HTML", disable_web_page_preview: true }).catch(() => {});
    return answer.ok === true;
  };
}

/**
 * The chats that sent your bot a message (send it /start first). Use the chatId of yours.
 * @returns {Promise<Array<{chatId: number, type: string, name: string, username: string|null}>>}
 */
export async function findTelegramChats({ token, fetch: fetchImpl = globalThis.fetch, api = API } = {}) {
  const call = client(token, fetchImpl, api);
  const updates = await call("getUpdates", { timeout: 0, allowed_updates: ["message"] });
  const chats = new Map();
  for (const u of updates) {
    const c = u.message?.chat;
    if (c) chats.set(c.id, { chatId: c.id, type: c.type, name: [c.first_name, c.last_name].filter(Boolean).join(" ") || c.title || "", username: c.username ?? null });
  }
  return [...chats.values()];
}
