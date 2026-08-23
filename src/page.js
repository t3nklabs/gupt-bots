const PROFILE_BASE = "https://gupt.app/#/profile";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function botCard(bot) {
  const name = escapeHtml(bot.name);
  const description = escapeHtml(bot.description);
  const pubkey = escapeHtml(bot.pubkey);
  const profile = escapeHtml(`${PROFILE_BASE}/${bot.pubkey}`);

  return `
    <article class="card">
      <div class="card-head">
        <h2>${name}</h2>
        <span class="id">${escapeHtml(bot.id)}</span>
      </div>
      <p class="desc">${description}</p>
      <label>Public key</label>
      <code class="pubkey" data-pubkey="${pubkey}">${pubkey}</code>
      <div class="actions">
        <button type="button" data-copy="${pubkey}">Copy key</button>
        <a href="${profile}" target="_blank" rel="noreferrer">Open on gupt.app</a>
      </div>
    </article>
  `;
}

export function renderPage(bots) {
  const cards = bots.map(botCard).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GUPT Bots</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #09090b;
      --card: #18181b;
      --line: #27272a;
      --text: #fafafa;
      --muted: #a1a1aa;
      --accent: #facc15;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(1200px 500px at 10% -10%, #1c1917 0%, var(--bg) 55%);
      color: var(--text);
    }
    main {
      max-width: 920px;
      margin: 0 auto;
      padding: 48px 20px 80px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 2rem;
      letter-spacing: -0.03em;
    }
    .lede {
      margin: 0 0 32px;
      color: var(--muted);
      max-width: 52ch;
    }
    .grid {
      display: grid;
      gap: 16px;
    }
    .card {
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 20px;
    }
    .card-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }
    h2 { margin: 0; font-size: 1.25rem; }
    .id {
      color: var(--accent);
      font-size: 0.8rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .desc { margin: 10px 0 18px; color: var(--muted); }
    label {
      display: block;
      font-size: 0.75rem;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      margin-bottom: 6px;
    }
    .pubkey {
      display: block;
      overflow-wrap: anywhere;
      background: #09090b;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 12px;
      font-size: 0.82rem;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 14px;
      align-items: center;
    }
    button, a {
      font: inherit;
      color: var(--bg);
      background: var(--accent);
      border: 0;
      border-radius: 999px;
      padding: 8px 14px;
      text-decoration: none;
      cursor: pointer;
    }
    a { background: transparent; color: var(--accent); padding: 8px 0; }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--accent);
      color: var(--bg);
      padding: 8px 12px;
      border-radius: 999px;
      opacity: 0;
      transform: translateY(8px);
      transition: 0.2s ease;
      pointer-events: none;
    }
    .toast.show { opacity: 1; transform: none; }
  </style>
</head>
<body>
  <main>
    <h1>GUPT Bots</h1>
    <p class="lede">Each bot has its own identity derived from the host secret and its folder name. Message them from GUPT using the public key below.</p>
    <div class="grid">
      ${cards}
    </div>
  </main>
  <div class="toast" id="toast">Copied</div>
  <script>
    const toast = document.getElementById("toast");
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(button.dataset.copy);
        toast.classList.add("show");
        setTimeout(() => toast.classList.remove("show"), 1200);
      });
    });
  </script>
</body>
</html>`;
}
