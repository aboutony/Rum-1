import pdf from "pdf-parse";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import { Redis } from "@upstash/redis";

const TELEGRAM_API = "https://api.telegram.org";
const redis = Redis.fromEnv();

const SCOPE_ERROR =
  "Error: Input falls outside the scope of Greek Orthodox religious texts.";

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
  if (!filePath) throw new Error("Could not get file_path.");

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

async function openaiTranslate({ text, direction, tone, allowOverride }) {
  const apiKey = mustGetEnv("OPENAI_API_KEY");
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  const enforcement = allowOverride
    ? `Direction: ${direction}\nTone: ${tone || "AUTO"}\n\nTranslate anyway.`
    : `Direction: ${direction}\nTone: ${tone || "AUTO"}\n\nIf content is NOT Greek Orthodox religious text, output exactly:\n${SCOPE_ERROR}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: "You are a strict Orthodox theological translator." },
        { role: "system", content: enforcement },
        { role: "user", content: text }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(data));

  const out = (data.output || [])
    .flatMap(o => o.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();

  return out || "Error: Empty output.";
}

async function translateWithProceedFlow({ chatId, token, direction, tone }) {
  const textKey = `rum1:lastText:${chatId}`;
  const lastText = await redis.get(textKey);

  if (!lastText) {
    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text: "Please upload a file or paste text first."
    });
    return;
  }

  await tgCall(token, "sendMessage", { chat_id: chatId, text: "Translating..." });

  const result = await openaiTranslate({
    text: lastText,
    direction,
    tone,
    allowOverride: false
  });

  if (result.trim() === SCOPE_ERROR) {
    const pendingKey = `rum1:pending:${chatId}`;
    await redis.set(
      pendingKey,
      JSON.stringify({ direction, tone, text: lastText })
    );
    await redis.expire(pendingKey, 1800);

    await tgCall(token, "sendMessage", {
      chat_id: chatId,
      text:
        "Rum-1 flagged a possible scope mismatch.\n\nProceed = translate anyway.\nOverwrite = discard content.",
      reply_markup: overrideKeyboard()
    });
    return;
  }

  await sendLongMessage(token, chatId, result);
}

export default async function handler(req, res) {
  try {
    const token = mustGetEnv("TELEGRAM_BOT_TOKEN");

    if (req.body.callback_query) {
      const cq = req.body.callback_query;
      const chatId = cq.message.chat.id;
      const pendingKey = `rum1:pending:${chatId}`;

      const raw = await redis.get(pendingKey);
      const pending =
        typeof raw === "string" ? JSON.parse(raw) : raw;

      if (!pending) {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "No pending translation found."
        });
        return res.status(200).json({ ok: true });
      }

      if (cq.data === "OVR:PROCEED") {
        const result = await openaiTranslate({
          text: pending.text,
          direction: pending.direction,
          tone: pending.tone,
          allowOverride: true
        });

        await redis.del(pendingKey);
        await sendLongMessage(token, chatId, result);
      }

      if (cq.data === "OVR:OVERWRITE") {
        await redis.del(pendingKey);
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "Content discarded. Upload or paste new text."
        });
      }

      return res.status(200).json({ ok: true });
    }

    const message = req.body.message;
    if (!message) return res.status(200).json({ ok: true });

    const chatId = message.chat.id;

    if (message.document) {
      const fileBuffer = await downloadFile(
        message.document.file_id,
        token
      );

      const text = await extractText(
        fileBuffer,
        message.document.mime_type
      );

      await redis.set(`rum1:lastText:${chatId}`, text);

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text:
          "File received.\n\nNow send:\nDIR=EN2AR\nTONE=LIT or TONE=ACAD"
      });

      return res.status(200).json({ ok: true });
    }

    if (message.text) {
      const { direction, tone } = parseDirTone(message.text);

      if (direction) {
        await translateWithProceedFlow({
          chatId,
          token,
          direction,
          tone
        });
      } else {
        await redis.set(`rum1:lastText:${chatId}`, message.text);
      }
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(200).json({ ok: true });
  }
}
