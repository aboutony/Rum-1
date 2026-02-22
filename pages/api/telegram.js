import pdf from "pdf-parse";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";
import { Redis } from "@upstash/redis";

const TELEGRAM_API = "https://api.telegram.org";

// Upstash Redis (Vercel KV / Upstash integration variables you already have)
const redis = Redis.fromEnv();

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
  // Telegram limit is ~4096 chars; we keep safe at 3500
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

// Your translation engine (kept simple; we can tighten it again after the flow works perfectly)
async function translate(text, direction, tone) {
  const apiKey = mustGetEnv("OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      input: [
        {
          role: "system",
          content:
            "You are a Greek Orthodox Religious Translation Specialist. Translate only. If the input is not Greek Orthodox religious text, output exactly: Error: Input falls outside the scope of Greek Orthodox religious texts."
        },
        {
          role: "user",
          content: `Direction: ${direction}\nTone: ${tone}\n\n${text}`
        }
      ],
      temperature: 0.2
    })
  });

  const data = await response.json();

  const out = (data.output || [])
    .flatMap(o => o.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();

  return out || "Error: Empty output.";
}

function parseDirTone(messageText) {
  const lines = String(messageText || "").split("\n").map(l => l.trim());
  const dirLine = lines.find(l => l.startsWith("DIR="));
  const toneLine = lines.find(l => l.startsWith("TONE="));

  const direction = dirLine ? dirLine.replace("DIR=", "").trim() : "";
  const tone = toneLine ? toneLine.replace("TONE=", "").trim() : "";

  // Everything after a blank line (or after TONE line) counts as optional inline text
  // If user provides text inline, we translate that instead of Redis-stored text
  let inlineText = "";
  const blankIndex = lines.findIndex(l => l === "");
  if (blankIndex >= 0) {
    inlineText = lines.slice(blankIndex + 1).join("\n").trim();
  } else {
    // fallback: try after the TONE line position
    const toneIdx = lines.findIndex(l => l.startsWith("TONE="));
    if (toneIdx >= 0) inlineText = lines.slice(toneIdx + 1).join("\n").trim();
  }

  return { direction, tone, inlineText };
}

export default async function handler(req, res) {
  try {
    const token = mustGetEnv("TELEGRAM_BOT_TOKEN");
    if (req.method !== "POST") return res.status(200).send("OK");

    const update = req.body;

    if (!update?.message) return res.status(200).json({ ok: true });

    const chatId = update.message.chat.id;

    // 1) DIR/TONE command (translate NOW)
    if (update.message.text && update.message.text.trim().startsWith("DIR=")) {
      const { direction, tone, inlineText } = parseDirTone(update.message.text);

      if (!direction) {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "Error: Translation direction not specified."
        });
        return res.status(200).json({ ok: true });
      }

      // If user provided inline text, translate it.
      // Otherwise translate the last extracted file text from Redis.
      let textToTranslate = inlineText;

      if (!textToTranslate) {
        const key = `rum1:lastText:${chatId}`;
        textToTranslate = (await redis.get(key)) || "";
      }

      if (!textToTranslate) {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "Please upload a PDF/DOCX/image OR paste the text first."
        });
        return res.status(200).json({ ok: true });
      }

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: "Translating..."
      });

      const result = await translate(textToTranslate, direction, tone || "AUTO");

      await sendLongMessage(token, chatId, result);

      return res.status(200).json({ ok: true });
    }

    // 2) FILE upload (PDF/DOCX/Image)
    if (update.message.document || update.message.photo) {
      let fileId = "";
      let mimeType = "";

      if (update.message.document) {
        fileId = update.message.document.file_id;
        mimeType = update.message.document.mime_type || "";
      } else if (update.message.photo) {
        // take best quality photo
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
        return res.status(200).json({ ok: true });
      }

      // Save in Redis for 2 hours (persistent across serverless invocations)
      const key = `rum1:lastText:${chatId}`;
      await redis.set(key, cleaned);
      await redis.expire(key, 60 * 60 * 2);

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text:
          "Text extracted and saved.\n\nNow send ONLY:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD"
      });

      return res.status(200).json({ ok: true });
    }

    // 3) Plain text (user pastes text) — store it, then ask for DIR/TONE
    if (update.message.text) {
      const text = update.message.text.trim();

      // Save pasted text so next DIR/TONE translates it
      const key = `rum1:lastText:${chatId}`;
      await redis.set(key, text);
      await redis.expire(key, 60 * 60 * 2);

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text:
          "Text received and saved.\n\nNow send ONLY:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD"
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
