// Telegram -> агент на Claude -> Google Таблица.
// Один файл для Cloudflare Workers, без зависимостей.
//
// Нужные настройки (Settings -> Variables and Secrets), подробности в setup.md:
//   TELEGRAM_TOKEN, ANTHROPIC_API_KEY, GOOGLE_SERVICE_ACCOUNT_JSON,
//   SPREADSHEET_ID, WEBHOOK_SECRET, ALLOWED_USER_ID
// Необязательно: MODEL (по умолчанию claude-haiku-5-5), TZ_OFFSET_HOURS (по умолчанию 3)
// Привязка KV с именем MEMORY хранит короткую память диалога (необязательно).

const TELEGRAM_API = "https://api.telegram.org";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MAX_STEPS = 8; // максимум обращений к модели на одно сообщение
const HISTORY_LIMIT = 12; // сколько последних сообщений помнить
const RULES_SHEET = "Правила";
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Вход: вебхук Telegram
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Подключение бота одним переходом по ссылке:
    // https://<адрес воркера>/setup?key=<WEBHOOK_SECRET>
    if (request.method === "GET" && url.pathname === "/setup") {
      if (!env.WEBHOOK_SECRET || url.searchParams.get("key") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message"],
        }),
      });
      return new Response(await r.text(), { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("ok");
    }
    if (
      !env.WEBHOOK_SECRET ||
      request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET
    ) {
      return new Response("forbidden", { status: 403 });
    }
    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("bad request", { status: 400 });
    }
    // Сразу отвечаем Telegram, а работу делаем в фоне.
    ctx.waitUntil(handleUpdate(update, env).catch((e) => console.error("handleUpdate", e)));
    return new Response("ok");
  },
};

async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg || !msg.chat) return;
  const chatId = msg.chat.id;
  const userId = msg.from && msg.from.id;
  const allowed = String(env.ALLOWED_USER_ID || "").trim();

  // Первый запуск: подсказываем ID, чтобы закрыть бота от посторонних.
  if (!allowed) {
    await sendTelegram(
      env,
      chatId,
      `Ваш Telegram ID: ${userId}\nДобавьте его в переменную ALLOWED_USER_ID в Cloudflare и нажмите Deploy.`
    );
    return;
  }
  if (String(userId) !== allowed) return; // чужих игнорируем

  const text = (msg.text || "").trim();
  if (!text) {
    await sendTelegram(env, chatId, "Пока я понимаю только текст.");
    return;
  }
  if (text === "/start") {
    await sendTelegram(
      env,
      chatId,
      "Привет! Пишите расходы и доходы как удобно: «кофе 350», «такси 780», «взял в долг 5000 под 5% в месяц». Для отчёта: «отчёт за октябрь», «сколько ушло на еду». /reset очищает память диалога."
    );
    return;
  }
  if (text === "/reset") {
    await saveHistory(env, chatId, []);
    await sendTelegram(env, chatId, "Память диалога очищена.");
    return;
  }

  await tg(env, "sendChatAction", { chat_id: chatId, action: "typing" });
  try {
    const reply = await runAgent(env, chatId, text, msg.date);
    await sendTelegram(env, chatId, reply);
  } catch (e) {
    console.error(e);
    await sendTelegram(env, chatId, "Не получилось: " + shortError(e) + "\nПопробуйте ещё раз.");
  }
}

// ---------------------------------------------------------------------------
// Агент
// ---------------------------------------------------------------------------

async function runAgent(env, chatId, userText, msgDate) {
  const history = await loadHistory(env, chatId);
  const when = localNow(env, msgDate);
  let context;
  try {
    context = await buildSheetContext(env);
  } catch (e) {
    context = { rules: "(не удалось прочитать)", sheets: "(не удалось прочитать таблицу: " + shortError(e) + ")" };
  }
  const system = buildSystemPrompt(when, context);
  const messages = [...history, { role: "user", content: userText }];

  let finalText = "";
  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await callClaude(env, system, messages);
    messages.push({ role: "assistant", content: resp.content });
    const text = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const toolUses = resp.content.filter((b) => b.type === "tool_use");

    if (resp.stop_reason !== "tool_use" || !toolUses.length) {
      finalText = text;
      break;
    }
    if (step === MAX_STEPS - 1) {
      finalText = "Не успел закончить за отведённое число шагов. Проверьте таблицу и повторите запрос.";
      break;
    }

    const results = [];
    for (const tu of toolUses) {
      let out;
      let isError = false;
      try {
        out = await runTool(env, tu.name, tu.input || {});
      } catch (e) {
        out = "Ошибка: " + shortError(e);
        isError = true;
      }
      const content = typeof out === "string" ? out : JSON.stringify(out);
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: truncate(content, 20000),
        is_error: isError,
      });
    }
    messages.push({ role: "user", content: results });
  }

  if (!finalText) finalText = "Готово.";
  await saveHistory(env, chatId, [
    ...history,
    { role: "user", content: userText },
    { role: "assistant", content: finalText },
  ]);
  return finalText;
}

async function callClaude(env, system, messages) {
  const r = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-haiku-5-5",
      max_tokens: 2048,
      system,
      tools: TOOLS,
      messages,
    }),
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

function buildSystemPrompt(when, context) {
  return `Ты — личный финансовый агент владельца. Ты ведёшь его учёт расходов в Google Таблице и делаешь отчёты. Он пишет тебе из Telegram, часто на ходу, коротко и в свободной форме («500 р кофе», «взял в долг 5000 под 5%»).

Сейчас: ${when.date} (${when.weekday}), ${when.time}. Валюта по умолчанию — рубли.

Как работать
- Сначала пойми, что нужно: записать трату или доход, исправить запись, сделать отчёт или просто ответить.
- Структуру таблицы определяй сам по снимку ниже и по листу «Правила». Новые категории и листы создавай, когда это нужно, но сначала проверь, нет ли подходящей существующей категории. Не плодить дубли.
- Чтобы что-то записать, вызови инструмент. Не говори, что записал, пока инструмент не вернул успех.
- Перед добавлением строки в журнал посмотри последние строки (read_last_rows), чтобы повторить формат: колонки, знаки сумм, нумерацию, названия счетов.
- Задавай уточняющий вопрос, только если без ответа нельзя записать верно (например, ставка и срок займа). Если можно разумно предположить, предположи и скажи об этом одной фразой.
- Суммы, итоги и сравнения считай инструментом aggregate, а не в уме. Даты в инструментах пиши как ГГГГ-ММ-ДД.
- Исправления: найди нужную строку (read_last_rows или read_sheet) и поправь через update_cells. Строки не удаляй. Если просят удалить, предложи пометить запись как отменённую (сумма 0) и уточни.
- Если владелец просит запомнить правило или предпочтение, допиши строку в лист «Правила» (append_rows).
- Ничего не выдумывай. Если данных нет, так и скажи.

Формат ответа
- Обычный текст без Markdown, коротко.
- После записи одной строкой подтверди, что внёс: дата, сумма, категория, описание.
- Отчёт: сначала итог, затем главные категории списком. Если в данных есть старые названия категорий, которые правила велят объединять, объединяй их при подсчёте.

Лист «Правила» (при расхождении в деталях учёта он важнее общих указаний выше):
${context.rules}

Снимок таблицы (листы и первая строка каждого):
${context.sheets}`;
}

// ---------------------------------------------------------------------------
// Инструменты агента
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "read_last_rows",
    description:
      "Последние N строк листа с номерами строк и строкой заголовков. Нужно, чтобы увидеть формат журнала, узнать следующий номер или найти недавнюю запись. Колонки A–Z.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string", description: "Название листа" },
        n: { type: "integer", description: "Сколько строк (по умолчанию 10, максимум 50)" },
      },
      required: ["sheet"],
    },
  },
  {
    name: "read_sheet",
    description:
      "Читает строки листа с from_row по to_row (колонки A–Z, не больше 150 строк за раз). Даты в колонках с «дат» в заголовке возвращаются как ГГГГ-ММ-ДД.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        from_row: { type: "integer", description: "С какой строки (по умолчанию 1)" },
        to_row: { type: "integer", description: "По какую строку (по умолчанию from_row+49)" },
      },
      required: ["sheet"],
    },
  },
  {
    name: "append_rows",
    description:
      "Добавляет строки в конец листа. Каждая строка — массив значений по колонкам слева направо. Даты пиши как ГГГГ-ММ-ДД, суммы — числами.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        rows: {
          type: "array",
          items: { type: "array", items: { type: ["string", "number"] } },
        },
      },
      required: ["sheet", "rows"],
    },
  },
  {
    name: "update_cells",
    description:
      "Перезаписывает ячейки. range в нотации A1 без имени листа, например «E597» или «A597:G597». values — массив строк массивов.",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        range: { type: "string" },
        values: {
          type: "array",
          items: { type: "array", items: { type: ["string", "number"] } },
        },
      },
      required: ["sheet", "range", "values"],
    },
  },
  {
    name: "create_sheet",
    description: "Создаёт новый лист и записывает в первую строку заголовки колонок.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        headers: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
  },
  {
    name: "aggregate",
    description:
      "Точно считает сумму числовой колонки по всему листу с фильтрами и группировкой. Используй для любых итогов и отчётов. group_by: название колонки или «month» (по месяцам). Даты периода включительно, формат ГГГГ-ММ-ДД. filters: точное совпадение значения колонки (без учёта регистра).",
    input_schema: {
      type: "object",
      properties: {
        sheet: { type: "string" },
        sum_column: { type: "string", description: "Заголовок колонки с суммой" },
        group_by: { type: "string" },
        date_column: { type: "string", description: "По умолчанию первая колонка с «дат» в заголовке" },
        date_from: { type: "string" },
        date_to: { type: "string" },
        filters: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["sheet", "sum_column"],
    },
  },
];

async function runTool(env, name, input) {
  switch (name) {
    case "read_last_rows":
      return readLastRows(env, input);
    case "read_sheet":
      return readSheet(env, input);
    case "append_rows":
      return appendRows(env, input);
    case "update_cells":
      return updateCells(env, input);
    case "create_sheet":
      return createSheet(env, input);
    case "aggregate":
      return aggregate(env, input);
    default:
      throw new Error("Неизвестный инструмент " + name);
  }
}

async function readSheet(env, a) {
  const from = Math.max(1, Math.floor(a.from_row || 1));
  const to = Math.min(Math.floor(a.to_row || from + 49), from + 149);
  const headerRows = await getValues(env, a.sheet, "1:1");
  const header = headerRows[0] || [];
  const rows = await getValues(env, a.sheet, `A${from}:Z${to}`);
  const dc = dateColsOf(header);
  return {
    header,
    from_row: from,
    rows: rows.map((r, i) => ({ row: from + i, values: humanizeRow(r, dc) })),
  };
}

async function readLastRows(env, a) {
  const n = Math.min(Math.max(Math.floor(a.n || 10), 1), 50);
  const colA = await getValues(env, a.sheet, "A:A");
  const last = colA.length;
  const from = Math.max(2, last - n + 1);
  if (last < from) {
    const headerRows = await getValues(env, a.sheet, "1:1");
    return { header: headerRows[0] || [], last_row: last, rows: [] };
  }
  const res = await readSheet(env, { sheet: a.sheet, from_row: from, to_row: last });
  return { ...res, last_row: last };
}

async function appendRows(env, a) {
  if (!Array.isArray(a.rows) || !a.rows.length) throw new Error("rows пуст");
  const j = await sheets(
    env,
    `/values/${q(a.sheet, "A1")}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: a.rows } }
  );
  return {
    ok: true,
    updated_range: j.updates && j.updates.updatedRange,
    rows_added: j.updates && j.updates.updatedRows,
  };
}

async function updateCells(env, a) {
  if (!Array.isArray(a.values) || !a.values.length) throw new Error("values пуст");
  const j = await sheets(env, `/values/${q(a.sheet, a.range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: { values: a.values },
  });
  return { ok: true, updated_range: j.updatedRange, cells: j.updatedCells };
}

async function createSheet(env, a) {
  await sheets(env, ":batchUpdate", {
    method: "POST",
    body: { requests: [{ addSheet: { properties: { title: a.title } } }] },
  });
  if (Array.isArray(a.headers) && a.headers.length) {
    await sheets(env, `/values/${q(a.title, "A1")}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: { values: [a.headers] },
    });
  }
  return { ok: true, created: a.title };
}

async function aggregate(env, a) {
  const rows = await getValues(env, a.sheet);
  if (!rows.length) return { error: "лист пуст" };
  const header = rows[0].map((h) => String(h ?? "").trim());
  const col = (name) => {
    const i = header.findIndex((h) => h.toLowerCase() === String(name).trim().toLowerCase());
    if (i < 0) throw new Error(`Нет колонки «${name}». Есть: ${header.join(", ")}`);
    return i;
  };
  const sumI = col(a.sum_column);
  const dateI = a.date_column ? col(a.date_column) : header.findIndex(isDateHeader);
  const groupMonth = a.group_by === "month";
  const groupI = a.group_by && !groupMonth ? col(a.group_by) : -1;
  const filters = Object.entries(a.filters || {}).map(([k, v]) => [
    col(k),
    String(v).trim().toLowerCase(),
  ]);
  const needDate = Boolean(a.date_from || a.date_to || groupMonth);
  if (needDate && dateI < 0) throw new Error("Не нашёл колонку с датой");

  let total = 0;
  let count = 0;
  const groups = new Map();
  for (const r of rows.slice(1)) {
    const v = r[sumI];
    if (typeof v !== "number") continue;
    let iso = null;
    if (dateI >= 0) {
      const d = r[dateI];
      if (typeof d === "number") iso = serialToIso(d);
      else if (typeof d === "string" && ISO_RE.test(d)) iso = d;
    }
    if (needDate && !iso) continue;
    if (a.date_from && iso < a.date_from) continue;
    if (a.date_to && iso > a.date_to) continue;
    if (!filters.every(([i, val]) => String(r[i] ?? "").trim().toLowerCase() === val)) continue;
    total += v;
    count++;
    if (groupMonth || groupI >= 0) {
      const key = groupMonth ? iso.slice(0, 7) : String(r[groupI] ?? "(пусто)").trim();
      const g = groups.get(key) || { sum: 0, rows: 0 };
      g.sum += v;
      g.rows++;
      groups.set(key, g);
    }
  }
  const out = {
    sheet: a.sheet,
    sum_column: header[sumI],
    date_from: a.date_from || null,
    date_to: a.date_to || null,
    total: round2(total),
    rows: count,
  };
  if (groups.size) {
    out.groups = [...groups]
      .map(([key, g]) => ({ key, sum: round2(g.sum), rows: g.rows }))
      .sort(groupMonth ? (x, y) => x.key.localeCompare(y.key) : (x, y) => y.sum - x.sum);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

let tokenCache = { token: null, exp: 0 };

async function getAccessToken(env) {
  const now = Math.floor(Date.now() / 1000);
  if (tokenCache.token && tokenCache.exp - 60 > now) return tokenCache.token;

  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned =
    enc({ alg: "RS256", typ: "JWT" }) +
    "." +
    enc({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/spreadsheets",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    });
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBuf(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  const jwt = unsigned + "." + b64url(new Uint8Array(sig));

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!r.ok) throw new Error(`Google auth ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return tokenCache.token;
}

async function sheets(env, path, { method = "GET", body } = {}) {
  const token = await getAccessToken(env);
  const headers = { authorization: `Bearer ${token}` };
  if (body) headers["content-type"] = "application/json";
  const r = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}${path}`,
    { method, headers, body: body ? JSON.stringify(body) : undefined }
  );
  if (!r.ok) throw new Error(`Google Sheets ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// Имя листа (+ диапазон) в виде, пригодном для URL.
function q(sheet, range) {
  return encodeURIComponent(`'${String(sheet).replace(/'/g, "''")}'${range ? "!" + range : ""}`);
}

async function getValues(env, sheet, range) {
  const j = await sheets(
    env,
    `/values/${q(sheet, range)}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`
  );
  return j.values || [];
}

// Правила и заголовки листов подставляем в промпт сразу, чтобы агент не тратил шаги.
async function buildSheetContext(env) {
  const meta = await sheets(env, "?fields=sheets.properties.title");
  const titles = meta.sheets.map((s) => s.properties.title);
  const ranges = titles.map((t) => {
    const name = `'${t.replace(/'/g, "''")}'`;
    return t === RULES_SHEET ? `${name}!A1:C300` : `${name}!1:1`;
  });
  const qs = ranges.map((r) => "ranges=" + encodeURIComponent(r)).join("&");
  const j = await sheets(env, `/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`);

  let rules =
    "(листа «Правила» нет: действуй по здравому смыслу и спрашивай владельца, если неясно)";
  const lines = [];
  (j.valueRanges || []).forEach((vr, i) => {
    const t = titles[i];
    const vals = vr.values || [];
    if (t === RULES_SHEET) {
      rules =
        vals
          .map((r) => r.join(" ").trim())
          .filter(Boolean)
          .join("\n") || "(лист «Правила» пуст)";
    } else {
      lines.push(`- «${t}»: ${(vals[0] || []).join(" | ") || "(пусто)"}`);
    }
  });
  return { rules, sheets: lines.join("\n") };
}

// ---------------------------------------------------------------------------
// Память диалога (Cloudflare KV, необязательно)
// ---------------------------------------------------------------------------

async function loadHistory(env, chatId) {
  if (!env.MEMORY) return [];
  try {
    const raw = await env.MEMORY.get(`hist:${chatId}`);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error("kv read", e);
    return [];
  }
}

async function saveHistory(env, chatId, hist) {
  if (!env.MEMORY) return;
  try {
    await env.MEMORY.put(`hist:${chatId}`, JSON.stringify(hist.slice(-HISTORY_LIMIT)), {
      expirationTtl: 60 * 60 * 24 * 3,
    });
  } catch (e) {
    console.error("kv write", e);
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

async function tg(env, method, body) {
  const r = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) console.error("telegram", method, r.status, await r.text());
}

async function sendTelegram(env, chatId, text) {
  const t = String(text || "").trim() || "(пустой ответ)";
  for (let i = 0; i < t.length; i += 4000) {
    await tg(env, "sendMessage", { chat_id: chatId, text: t.slice(i, i + 4000) });
  }
}

// ---------------------------------------------------------------------------
// Вспомогательное
// ---------------------------------------------------------------------------

function localNow(env, unixSec) {
  const offset = Number(env.TZ_OFFSET_HOURS ?? 3);
  const d = new Date((unixSec ? unixSec * 1000 : Date.now()) + offset * 3600e3);
  const iso = d.toISOString();
  const days = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: days[d.getUTCDay()] };
}

const isDateHeader = (h) => /дат/i.test(String(h ?? ""));

function dateColsOf(headerRow) {
  const s = new Set();
  (headerRow || []).forEach((h, i) => {
    if (isDateHeader(h)) s.add(i);
  });
  return s;
}

function serialToIso(n) {
  return new Date(Math.round((n - 25569) * 86400000)).toISOString().slice(0, 10);
}

function humanizeRow(row, dateCols) {
  return row.map((v, i) =>
    dateCols.has(i) && typeof v === "number" && v > 20000 && v < 80000 ? serialToIso(v) : v
  );
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToBuf(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

const round2 = (x) => Math.round(x * 100) / 100;
const truncate = (s, n) => (s.length > n ? s.slice(0, n) + "…(обрезано)" : s);
const shortError = (e) => String((e && e.message) || e).slice(0, 300);
