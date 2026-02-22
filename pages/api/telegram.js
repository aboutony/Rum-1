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

export default async function handler(req, res) {
  try {
    const token = mustGetEnv("TELEGRAM_BOT_TOKEN");

    if (req.method !== "POST") {
      return res.status(200).send("OK");
    }

    const update = req.body;

    if (update.message) {
      const chatId = update.message.chat.id;

      // TEXT MESSAGE
      if (update.message.text) {
        await tgCall(token, "sendMessage", {
          chat_id: chatId,
          text: "Text received.\nUse direction buttons to translate."
        });
        return res.status(200).json({ ok: true });
      }

      // DOCUMENT OR IMAGE
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
            "File processed successfully.\n\nExtracted text preview:\n\n" +
            extractedText.substring(0, 1000)
        });

        return res.status(200).json({ ok: true });
      }
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(200).json({ ok: true });
  }
}
