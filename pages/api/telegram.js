import pdf from "pdf-parse";
import mammoth from "mammoth";
import Tesseract from "tesseract.js";

const TELEGRAM_API = "https://api.telegram.org";

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

async function downloadFile(fileId, token) {
  const fileInfo = await fetch(
    `${TELEGRAM_API}/bot${token}/getFile?file_id=${fileId}`
  ).then(r => r.json());

  const filePath = fileInfo.result.file_path;
  const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
  const fileBuffer = await fetch(fileUrl).then(r => r.arrayBuffer());
  return Buffer.from(fileBuffer);
}

async function extractText(buffer, mimeType) {
  if (mimeType.includes("pdf")) {
    const data = await pdf(buffer);
    return data.text;
  }

  if (mimeType.includes("word")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  if (mimeType.includes("image")) {
    const { data } = await Tesseract.recognize(buffer, "eng+ell+ara+fra");
    return data.text;
  }

  return null;
}

async function translate(text, direction, tone) {
  const apiKey = mustGetEnv("OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      input: `
System: Greek Orthodox Religious Translation Specialist.

Direction: ${direction}
Tone: ${tone}

Translate strictly according to Orthodox doctrine.
Output only translation.

Text:
${text}
`
    })
  });

  const data = await response.json();
  return (data.output || [])
    .flatMap(o => o.content || [])
    .filter(c => c.type === "output_text")
    .map(c => c.text)
    .join("\n")
    .trim();
}

export default async function handler(req, res) {
  try {
    const token = mustGetEnv("TELEGRAM_BOT_TOKEN");

    if (req.method !== "POST") return res.status(200).send("OK");

    const update = req.body;

    if (update.message) {
      const chatId = update.message.chat.id;

      // TEXT
      if (update.message.text) {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text:
            "Reply with:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD\n\nThen paste your text again."
        });
        return res.status(200).json({ ok: true });
      }

      // FILE
      if (update.message.document || update.message.photo) {
        let fileId;
        let mimeType;

        if (update.message.document) {
          fileId = update.message.document.file_id;
          mimeType = update.message.document.mime_type;
        }

        if (update.message.photo) {
          fileId = update.message.photo.pop().file_id;
          mimeType = "image/jpeg";
        }

        const buffer = await downloadFile(fileId, token);
        const extractedText = await extractText(buffer, mimeType);

        if (!extractedText) {
          await tgCall(token, "sendMessage", {
            chat_id: chatId,
            text: "Unsupported file type."
          });
          return res.status(200).json({ ok: true });
        }

        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text:
            "File received.\n\nNow reply with:\nDIR=EN2AR (or EL2AR, AR2EL, etc)\nTONE=LIT or TONE=ACAD\n\nThen I will translate it."
        });

        // Store extracted text temporarily in memory (simple approach)
        global.lastExtractedText = extractedText;

        return res.status(200).json({ ok: true });
      }
    }

    // HANDLE TRANSLATION COMMAND
    if (update.message?.text?.includes("DIR=")) {
      const chatId = update.message.chat.id;
      const lines = update.message.text.split("\n");

      const dir = lines.find(l => l.startsWith("DIR="))?.replace("DIR=", "").trim();
      const tone = lines.find(l => l.startsWith("TONE="))?.replace("TONE=", "").trim();

      const text = global.lastExtractedText || lines.slice(2).join("\n");

      const result = await translate(text, dir, tone);

      await tgCall(token, "sendMessage", {
        chat_id: chatId,
        text: result.substring(0, 4000)
      });

      return res.status(200).json({ ok: true });
    }

    return res.status(200).json({ ok: true });

  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
