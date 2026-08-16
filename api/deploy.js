const { formidable } = require("formidable");
const fs = require("fs/promises");

module.exports.config = {
  api: {
    bodyParser: false,
  },
};

const MAX_FILE_SIZE = 1024 * 1024;
const NAME_REGEX = /^[a-z0-9-]{1,50}$/;

function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = formidable({
      multiples: false,
      maxFiles: 1,
      maxFileSize: MAX_FILE_SIZE,
      keepExtensions: true,
    });

    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function getOne(value) {
  return Array.isArray(value) ? value[0] : value;
}

async function createVercelProject(token, name) {
  const response = await fetch("https://api.vercel.com/v10/projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      framework: null,
    }),
  });

  const data = await response.json();

  if (response.ok) return data;

  // Project already exists: continue to deployment.
  if (response.status === 409 || data?.error?.code === "conflict") {
    return null;
  }

  throw new Error(data?.error?.message || "Gagal membuat project Vercel.");
}

async function deployToVercel(token, name, html) {
  const response = await fetch("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      project: name,
      target: "production",
      files: [
        {
          file: "index.html",
          data: html,
        },
      ],
      projectSettings: {
        framework: null,
        buildCommand: null,
        devCommand: null,
        outputDirectory: null,
      },
    }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || "Gagal melakukan deployment ke Vercel."
    );
  }

  return data;
}

async function notifyTelegram(botToken, chatId, siteName, url) {
  if (!botToken || !chatId) return;

  const message =
    `🚀 Deployment baru\n\n` +
    `📦 Project: ${siteName}\n` +
    `🌐 URL: ${url}`;

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: true,
      }),
    }
  );

  if (!response.ok) {
    console.error("Telegram notification failed.");
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      message: "Method tidak diizinkan.",
    });
  }

  const token = process.env.VERCEL_TOKEN;

  if (!token) {
    return res.status(500).json({
      message: "VERCEL_TOKEN belum dikonfigurasi di Environment Variables.",
    });
  }

  try {
    const { fields, files } = await parseForm(req);

    const siteName = String(getOne(fields.siteName) || "")
      .trim()
      .toLowerCase();

    const uploaded = getOne(files.file);

    if (!NAME_REGEX.test(siteName)) {
      return res.status(400).json({
        message:
          "Nama website hanya boleh berisi huruf kecil, angka, dan tanda -.",
      });
    }

    if (!uploaded) {
      return res.status(400).json({
        message: "File HTML belum dipilih.",
      });
    }

    const originalName = uploaded.originalFilename || "";

    if (originalName.toLowerCase() !== "index.html") {
      return res.status(400).json({
        message: "File wajib bernama index.html.",
      });
    }

    if (uploaded.size > MAX_FILE_SIZE) {
      return res.status(400).json({
        message: "Ukuran file maksimal 1 MB.",
      });
    }

    const html = await fs.readFile(uploaded.filepath, "utf8");

    if (!html.trim()) {
      return res.status(400).json({
        message: "File index.html kosong.",
      });
    }

    await createVercelProject(token, siteName);

    const deployment = await deployToVercel(
      token,
      siteName,
      html
    );

    const url = deployment.url
      ? `https://${deployment.url}`
      : `https://${siteName}.vercel.app`;

    await notifyTelegram(
      process.env.TELEGRAM_BOT_TOKEN,
      process.env.TELEGRAM_CHAT_ID,
      siteName,
      url
    );

    return res.status(200).json({
      success: true,
      url,
      deploymentId: deployment.id || null,
    });
  } catch (error) {
    console.error("DEPLOY ERROR:", error);

    const message =
      error?.message || "Terjadi kesalahan saat deployment.";

    if (
      message.toLowerCase().includes("maxfilesize") ||
      message.toLowerCase().includes("max file size")
    ) {
      return res.status(400).json({
        message: "Ukuran file maksimal 1 MB.",
      });
    }

    return res.status(500).json({
      message,
    });
  }
};
