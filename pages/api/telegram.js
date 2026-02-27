const pdf = require("pdf-parse");
const mammoth = require("mammoth");
const Tesseract = require("tesseract.js");
const { Redis } = require("@upstash/redis");

const TELEGRAM_API = "https://api.telegram.org";
const redis = Redis.fromEnv();

// Allow bigger payloads safely
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "8mb"
    }
  }
};

function mustGetEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

async function tgCall(token, method, body) {
  const url = `${TELEGRAM_API}/bot${token}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return await resp.json();
}

async function sendLongMessage(token, chatId, text) {
  const chunkSize = 3500;
  const safe = String(text || "");
  for (let i = 0; i < safe.length; i += chunkSize) {
    const part = safe.slice(i, i + chunkSize);
    await tgCall(token, "sendMessage", { chat_id: chatId, text: part });
  }
}

async function downloadFile(fileId, token) {
  const fileInfo = await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${fileId}`
  ).then(r => r.json());

  const filePath = fileInfo?.result?.file_path;
  if (!filePath) throw new Error("Could not get file_path from Telegram.");

  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const fileBuffer = await fetch(fileUrl).then(r => r.arrayBuffer());
  return Buffer.from(fileBuffer);
}

async function extractText(buffer, mimeType) {
  const mt = String(mimeType || "").toLowerCase();

  if (mt.includes("pdf")) {
    const data = await pdf(buffer);
    return data.text || "";
  }

  if (mt.includes("word") || mt.includes("docx")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (mt.includes("image")) {
    const { data } = await Tesseract.recognize(buffer, "eng+ell+ara+fra");
    return data.text || "";
  }

  return "";
}

function parseDirTone(messageText) {
  const lines = String(messageText || "").split("\n").map(l => l.trim());
  const dirLine = lines.find(l => l.startsWith("DIR="));
  const toneLine = lines.find(l => l.startsWith("TONE="));

  const direction = dirLine ? dirLine.replace("DIR=", "").trim() : "";
  const tone = toneLine ? toneLine.replace("TONE=", "").trim() : "";

  return { direction, tone };
}

function overrideKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Proceed", callback_data: "OVR:PROCEED" },
        { text: "Overwrite", callback_data: "OVR:OVERWRITE" }
      ]
    ]
  };
}

const SCOPE_ERROR =
  "Error: Input falls outside the scope of Greek Orthodox religious texts.";

function buildSystemPrompt() {
  return `System Prompt: Greek Orthodox Religious Translation Specialist
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
}

async function openaiResponses({ text, direction, tone, allowOverride }) {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const enforcement = allowOverride
    ? `Direction is mandatory: ${direction}
Tone preference: ${tone || "AUTO"}

MANDATORY:
- Translate headings/titles too.
- Output ONLY the translation. No explanations.
- Do NOT refuse with scope error. Translate anyway, but keep the Orthodox lexicon and tone.
`
    : `Direction is mandatory: ${direction}
Tone preference: ${tone || "AUTO"}

MANDATORY:
- Translate headings/titles too.
- Output ONLY the translation. No explanations.
- If content is not Greek Orthodox religious text, output exactly:
${SCOPE_ERROR}
- If direction is missing, output exactly:
Error: Translation direction not specified.
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
        { role: "system", content: buildSystemPrompt() },
        { role: "system", content: enforcement },
        { role: "user", content: text }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(`OpenAI error: ${JSON.stringify(data)}`);

  const out = (data.output || [])
    .flatMap(o => o.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();

  return out || "Error: Empty output.";
}

async function translateWithFallback({ chatId, token, direction, tone }) {
  const textKey = `rum1:lastText:${chatId}`;
  const lastText = (await redis.get(textKey)) || "";

  if (!lastText) {
    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text: "Please upload a PDF/DOCX/image OR paste the text first."
    });
    return;
  }

  await tgCall(token, "sendMessage", { chat_id: chatId, text: "Translating..." });

  const result = await openaiResponses({
    text: lastText,
    direction,
    tone,
    allowOverride: false
  });

  // If scope error happens, ask user Proceed/Overwrite, and keep pending state
  if (result.trim() === SCOPE_ERROR) {
    const pendingKey = `rum1:pending:${chatId}`;
    await redis.set(
      pendingKey,
      JSON.stringify({
        direction: direction || "",
        tone: tone || "AUTO",
        // store the text snapshot used for that request
        text: lastText
      })
    );
    await redis.expire(pendingKey, 60 * 30); // 30 minutes

    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text:
        "Rum-1 detected that the content may fall outside the strict Greek Orthodox scope.\n\nChoose one:\nProceed = translate anyway.\nOverwrite = discard and upload/paste a new text.",
      reply_markup: overrideKeyboard()
    });
    return;
  }

  await sendLongMessage(token, chatId, result);
}

export default async function handler(req, res) {
  // Always return quickly to avoid Telegram timeout retries
  if (req.method !== "POST") return res.status(200).send("OK");

  const token = process.env.TELEGRAM_BOT_TOKEN;

  try {
    const update = req.body || {};
    res.status(200).json({ ok: true }); // respond immediately

    (async () => {
      // --- Handle button clicks (callback_query) ---
      if (update.callback_query) {
        const cq = update.callback_query;
        const chatId = cq?.message?.chat?.id;
        if (!chatId) return;

        // Acknowledge click
        await tgCall(token, "answerCallbackQuery", { callback_query_id: cq.id });

        const data = String(cq.data || "");

        if (data === "OVR:OVERWRITE") {
          await redis.del(`rum1:lastText:${chatId}`);
          await redis.del(`rum1:pending:${chatId}`);

          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "Overwritten. Upload a new PDF/DOCX/image or paste new text."
          });
          return;
        }

        if (data === "OVR:PROCEED") {
          const pendingKey = `rum1:pending:${chatId}`;
          const raw = await redis.get(pendingKey);
          if (!raw) {
            await tgCall(token, "sendMessage", {
              chat_id: chatId,
              text: "No pending text found. Please upload/paste the text again."
            });
            return;
          }

          const pending = JSON.parse(raw);
          const direction = pending.direction || "EN2AR";
          const tone = pending.tone || "AUTO";
          const text = pending.text || "";

          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "Proceeding. Translating anyway..."
          });

          const result = await openaiResponses({
            text,
            direction,
            tone,
            allowOverride: true
          });

          await sendLongMessage(token, chatId, result);

          await redis.del(pendingKey);
          return;
        }

        return;
      }

      // --- Handle normal messages ---
      const chatId = update?.message?.chat?.id;
      if (!chatId) return;

      // Dedup retries per chat
      const updateId = update.update_id;
      const dedupeKey = `rum1:lastUpdate:${chatId}`;
      const lastUpdateId = await redis.get(dedupeKey);
      if (lastUpdateId && String(lastUpdateId) === String(updateId)) return;
      await redis.set(dedupeKey, String(updateId));
      await redis.expire(dedupeKey, 60 * 10);

      // DIR/TONE message
      if (update.message?.text?.trim()?.startsWith("DIR=")) {
        const { direction, tone } = parseDirTone(update.message.text);

        if (!direction) {
          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "Error: Translation direction not specified."
          });
          return;
        }

        await translateWithFallback({ chatId, token, direction, tone });
        return;
      }

      // File upload (PDF/DOCX/Image)
      if (update.message?.document || update.message?.photo) {
        let fileId = "";
        let mimeType = "";

        if (update.message.document) {
          fileId = update.message.document.file_id;
          mimeType = update.message.document.mime_type || "";
        } else {
          fileId = update.message.photo[update.message.photo.length - 1].file_id;
          mimeType = "image/jpeg";
        }

        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "File received. Extracting text..."
        });

        const buffer = await downloadFile(fileId, token);
        const extractedText = await extractText(buffer, mimeType);
        const cleaned = String(extractedText || "").trim();

        if (!cleaned) {
          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "I could not extract readable text from this file."
          });
          return;
        }

        const key = `rum1:lastText:${chatId}`;
        await redis.set(key, cleaned);
        await redis.expire(key, 60 * 60 * 2);

        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text:
            "Text extracted and saved.\n\nNow send ONLY:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD"
        });
        return;
      }

      // Plain text paste (store it)
      if (update.message?.text) {
        const text = update.message.text.trim();
        const key = `rum1:lastText:${chatId}`;
        await redis.set(key, text);
        await redis.expire(key, 60 * 60 * 2);

        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text:
            "Text received and saved.\n\nNow send ONLY:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD"
        });
      }
    })().catch(err => console.error("Worker error:", err));
  } catch (e) {
    console.error("Webhook error:", e);
    try {
      return res.status(200).json({ ok: true });
    } catch {
      return;
    }
  }
}
