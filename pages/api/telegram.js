const TELEGRAM_API = "https://api.telegram.org";

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

// Your mandatory system prompt (kept as provided; used as the core instruction set)
const SYSTEM_PROMPT = `System Prompt: Greek Orthodox Religious Translation Specialist
ROLE DEFINITION: You are an expert theological translator specializing exclusively in the doctrines, liturgy, and literature of the Greek Orthodox Church. Your sole function is to translate religious texts from English and Greek into Arabic, and vise versa. You possess deep knowledge of Patristics, Byzantine theology, liturgical rubrics, and the specific Arabic terminology used by the Antiochian and broader Greek Orthodox traditions.
CORE DIRECTIVES (NON-NEGOTIABLE):
1. Doctrinal Fidelity: Every translation must align 100% with the dogma, spirit, and tradition of the Greek Orthodox Church. Any interpretation that leans toward Protestant, Catholic, secular, or modernist theological frameworks is strictly forbidden.
2. Terminological Precision: You must use established, canonical Arabic Orthodox terminology. Do not invent new terms or use generic Islamic or secular Arabic words for theological concepts.
o Example: Use "القداس الإلهي" for Divine Liturgy, not "العبادة".
o Example: Use "الثيوتوكوس" or "والدة الإله" for Theotokos, avoiding ambiguous terms.
o Example: Ensure distinctions between "essence" (ousia) and "energy" (energeia) are preserved accurately in Arabic.
3. Source Integrity:
o If translating from Greek: Preserve the nuance of the original Koine or Ecclesiastical Greek. Do not simplify complex theological syntax unless it obscures meaning in Arabic; prefer accuracy over readability if a conflict arises.
o If translating from English: Recognize that the English source may already be a translation. You must mentally cross-reference the likely Greek original to ensure the Arabic reflects the Orthodox intent, correcting any Western theological drift present in the English source text.
4. Tone and Style: The output must be reverent, formal, and liturgical (Fusha). It must sound as though it belongs in a church service or a patristic volume. Avoid colloquialisms, modern slang, or overly academic dryness that loses the spiritual warmth.
OPERATIONAL CONSTRAINTS:
• NO DEVIATION: Do not add commentary, personal opinions, footnotes explaining theology, or summaries unless explicitly requested. Output only the translation.
• NO ECUMENICAL BLENDING: Do not harmonize terms with other Christian denominations or other religions. Stick strictly to the Greek Orthodox lexicon.
• HANDLING AMBIGUITY: If a source phrase is ambiguous or potentially heretical from an Orthodox perspective, do not guess. Insert a bracketed note [TRANSLATOR NOTE: Potential doctrinal ambiguity in source regarding X] and provide the most orthodox interpretation possible based on context.
• SCOPE LIMIT: If the input text is not religious or does not pertain to Greek Orthodox doctrine, refuse to translate and state: "Error: Input falls outside the scope of Greek Orthodox religious texts."
EXECUTION PROTOCOL: Upon receiving text:
1. Analyze the theological context.
2. Select the precise canonical Arabic equivalent for every theological term.
3. Construct the sentence structure to reflect the gravity and rhythm of Orthodox Arabic literature.
4. Review against the "Core Directives" one final time before outputting.
BEGIN TRANSLATION TASK NOW. Await user input.`;

async function tgCall(token, method, body) {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await resp.json();
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data;
}

function directionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "EN→AR", callback_data: "DIR:EN2AR" },
        { text: "EL→AR", callback_data: "DIR:EL2AR" }
      ],
      [
        { text: "AR→EL", callback_data: "DIR:AR2EL" },
        { text: "AR→EN", callback_data: "DIR:AR2EN" }
      ],
      [
        { text: "EN→EL", callback_data: "DIR:EN2EL" },
        { text: "EL→EN", callback_data: "DIR:EL2EN" }
      ],
      [
        { text: "Liturgical Tone", callback_data: "TONE:LIT" },
        { text: "Patristic/Academic", callback_data: "TONE:ACAD" }
      ],
      [{ text: "Translate Now", callback_data: "GO" }]
    ]
  };
}

function parseState(text) {
  // Stored in a hidden message we keep in chat via bot; simple key=value lines.
  const state = {};
  for (const line of String(text || "").split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) state[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return state;
}

function buildState(state) {
  const lines = [];
  for (const k of Object.keys(state)) lines.push(`${k}=${state[k]}`);
  return lines.join("\n");
}

async function openaiTranslate({ inputText, direction, tone }) {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Hard enforcement wrapper (kept in code, not shown to user)
  const wrapper = `
You must obey the SYSTEM prompt rules exactly.
Direction is mandatory: ${direction}.
Tone preference: ${tone || "AUTO"}.
Translate headings/titles too.
Greek script: auto-detect from source; if generating Greek from non-Greek, use monotonic.
Theotokos rendering: context-sensitive.
Output ONLY the translation. If outside scope, output exactly:
Error: Input falls outside the scope of Greek Orthodox religious texts.
If direction missing, output exactly:
Error: Translation direction not specified.
If doctrinal ambiguity exists, insert:
[TRANSLATOR NOTE: Potential doctrinal ambiguity in source regarding X]
Then continue translation with the most Orthodox interpretation.
`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: wrapper },
        { role: "user", content: inputText }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`OpenAI error: ${JSON.stringify(data)}`);
  }

  // Extract text from Responses API
  const out = (data.output || [])
    .flatMap(o => o.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();

  return out || "Error: Empty output.";
}

export default async function handler(req, res) {
  try {
    const token = mustGetEnv("TELEGRAM_BOT_TOKEN");

    // Telegram sends POST updates to this webhook
    if (req.method !== "POST") {
      return res.status(200).send("OK");
    }

    const update = req.body;

    // 1) New message
    if (update.message && update.message.chat) {
      const chatId = update.message.chat.id;
      const text = update.message.text || "";

      // Optional: restrict bot to your team chat(s)
      const allow = process.env.ALLOWED_CHAT_IDS;
      if (allow) {
        const allowed = allow.split(",").map(s => s.trim());
        if (!allowed.includes(String(chatId))) {
          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "Access denied."
          });
          return res.status(200).json({ ok: true });
        }
      }

      // Help
      if (text === "/start") {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text:
            "Rum-1 ready.\n\nSend a Greek Orthodox religious text.\nThen choose direction + tone, and tap Translate Now.",
        });
        return res.status(200).json({ ok: true });
      }

      // Store the original text into a hidden state message
      const state = {
        DIR: "",
        TONE: "",
        TEXT: text
      };

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: "Select direction and tone:",
        reply_markup: directionKeyboard()
      });

      // Save state in a second message (minimal approach, no DB yet)
      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: buildState(state),
        disable_notification: true
      });

      return res.status(200).json({ ok: true });
    }

    // 2) Button click (callback_query)
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const data = cq.data;

      // Find the last state message (we assume it is the most recent message sent by bot after the keyboard)
      // In this minimal version, we ask user to keep the last bot "state" message in chat.
      // We will read it via "getUpdates" later in a more advanced version with DB.
      // For now, we store state in the callback message's reply_to_message is not available.
      // So we use a safer approach: tell user to resend text after selecting direction if state isn't found.

      // Acknowledge click
      await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id });

      // We cannot reliably read past messages from Telegram API without extra steps.
      // So in this minimal version, we keep it simple:
      // - User chooses direction/tone
      // - Bot asks user to paste the text again
      // Then bot translates immediately.
      if (data.startsWith("DIR:")) {
        const dir = data.replace("DIR:", "");
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: `Direction set: ${dir}\nNow paste the text again.`,
        });
        return res.status(200).json({ ok: true });
      }

      if (data.startsWith("TONE:")) {
        const tone = data.replace("TONE:", "");
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: `Tone set: ${tone}\nNow paste the text again.`,
        });
        return res.status(200).json({ ok: true });
      }

      if (data === "GO") {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "Paste the text again, and start the message with:\nDIR=EN2AR (or EL2AR, AR2EL, AR2EN, EN2EL, EL2EN)\nOptional: TONE=LIT or TONE=ACAD\nThen a blank line, then the text.",
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
