import HTML_CONTENT from "./index.html";

// Table initialization with clean individual queries
async function initDB(db) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS leads (
      phone TEXT PRIMARY KEY,
      name TEXT,
      last_message TEXT,
      updated_at TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT,
      text TEXT,
      direction TEXT,
      timestamp TEXT
    )
  `).run();

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS raw_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT,
      created_at TEXT
    )
  `).run();
}

let lastWebhookError = "None";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Error Tracking Endpoint
    if (url.pathname === "/api/last-error") {
      return new Response(JSON.stringify({ error: lastWebhookError }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
      });
    }

    // 2. Raw Logs Inspect Endpoint
    if (url.pathname === "/api/raw-logs") {
      try {
        await initDB(env.DB);
        const { results } = await env.DB.prepare("SELECT * FROM raw_logs ORDER BY id DESC LIMIT 10").all();
        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
    }

    // 3. Meta Webhook Verification (GET)
    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === "vedashree_crm_secret_2026") {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // 4. Incoming WhatsApp Message Webhook (POST)
    if (request.method === "POST" && url.pathname === "/webhook") {
      let bodyText = "";
      try {
        await initDB(env.DB);
        bodyText = await request.text();
        if (!bodyText) return new Response("OK", { status: 200 });

        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        // Save raw packet for proof
        await env.DB.prepare("INSERT INTO raw_logs (payload, created_at) VALUES (?, ?)")
          .bind(bodyText, now)
          .run();

        const data = JSON.parse(bodyText);

        // Extract value
        let val = data?.entry?.[0]?.changes?.[0]?.value || data?.value || data;
        const msgList = val?.messages;

        if (Array.isArray(msgList) && msgList.length > 0) {
          const msgObj = msgList[0];
          const rawPhone = String(msgObj.from || "").replace(/[^0-9]/g, "");
          
          let textBody = "[Media/Attachment]";
          if (msgObj.text?.body) {
            textBody = msgObj.text.body;
          } else if (msgObj.body) {
            textBody = msgObj.body;
          } else if (msgObj.type) {
            textBody = `[${msgObj.type.toUpperCase()}]`;
          }

          let customerName = val?.contacts?.[0]?.profile?.name || ("+" + rawPhone);

          if (rawPhone) {
            // Insert Message
            await env.DB.prepare(`
              INSERT INTO messages (phone, text, direction, timestamp)
              VALUES (?, ?, 'inbound', ?)
            `).bind(rawPhone, textBody, now).run();

            // Insert / Update Lead
            await env.DB.prepare(`
              INSERT INTO leads (phone, name, last_message, updated_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(phone) DO UPDATE SET
                last_message = excluded.last_message,
                updated_at = excluded.updated_at,
                name = CASE 
                  WHEN leads.name IS NULL OR leads.name = 'Customer' OR leads.name LIKE '+%' 
                  THEN excluded.name 
                  ELSE leads.name 
                END
            `).bind(rawPhone, customerName, textBody, now).run();
          }
        }

        lastWebhookError = "None";
        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        lastWebhookError = `Error: ${err.message}`;
        return new Response("OK", { status: 200 });
      }
    }

    // 5. API: Fetch Leads List
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
        await initDB(env.DB);
        const { results } = await env.DB.prepare(`
          SELECT 
            phone AS id,
            name,
            phone,
            'Direct WhatsApp' AS source,
            'hot' AS status,
            COALESCE(updated_at, datetime('now')) AS created_at,
            last_message
          FROM leads 
          ORDER BY updated_at DESC
        `).all();

        return new Response(JSON.stringify(results || []), {
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 6. API: Fetch Chat Messages
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const rawParam = url.searchParams.get("phone") || "";
      const cleanPhone = rawParam.replace(/[^0-9]/g, "");

      if (!cleanPhone) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        await initDB(env.DB);
        const { results } = await env.DB.prepare(`
          SELECT 
            id, 
            phone, 
            text, 
            text AS message, 
            CASE WHEN direction = 'outbound' THEN 'agent' ELSE 'customer' END AS sender,
            direction, 
            COALESCE(timestamp, datetime('now')) AS created_at
          FROM messages 
          WHERE REPLACE(REPLACE(phone, '+', ''), ' ', '') = ?
          ORDER BY id ASC
        `).bind(cleanPhone).all();

        return new Response(JSON.stringify(results || []), {
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 7. API: Send Outbound Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        await initDB(env.DB);
        const { phone, text } = await request.json();
        const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        if (env.WHATSAPP_TOKEN) {
          await fetch("https://graph.facebook.com/v20.0/119627664023608/messages", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: cleanPhone,
              type: "text",
              text: { body: text }
            })
          });
        }

        await env.DB.prepare(`
          INSERT INTO messages (phone, text, direction, timestamp)
          VALUES (?, ?, 'outbound', ?)
        `).bind(cleanPhone, text, now).run();

        await env.DB.prepare(`
          INSERT INTO leads (phone, name, last_message, updated_at)
          VALUES (?, 'Customer', ?, ?)
          ON CONFLICT(phone) DO UPDATE SET
            last_message = excluded.last_message,
            updated_at = excluded.updated_at
        `).bind(cleanPhone, text, now).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 8. Serve Frontend UI
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
