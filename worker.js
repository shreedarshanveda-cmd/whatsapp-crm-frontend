import HTML_CONTENT from "./index.html";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Meta Webhook Verification (GET)
    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");

      if (mode === "subscribe" && token === "vedashree_crm_secret_2026") {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }

    // 2. Incoming WhatsApp Message Webhook (POST)
    if (request.method === "POST" && url.pathname === "/webhook") {
      try {
        const bodyText = await request.text();
        if (!bodyText) return new Response("OK", { status: 200 });

        const data = JSON.parse(bodyText);

        // Teeno Meta payload structures ko handle karne ka solid check:
        let val = null;
        if (data?.entry?.[0]?.changes?.[0]?.value) {
          val = data.entry[0].changes[0].value;
        } else if (data?.value) {
          val = data.value;
        } else {
          val = data;
        }

        const msgObj = val?.messages?.[0] || null;
        let customerName = val?.contacts?.[0]?.profile?.name || "Customer";

        if (msgObj) {
          const rawPhone = String(msgObj.from || "").replace(/[^0-9]/g, "");
          const textBody = msgObj.text?.body || msgObj.body || (msgObj.type ? `[${msgObj.type}]` : "Message");
          const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

          if (customerName === "Customer" && rawPhone) {
            customerName = "+" + rawPhone;
          }

          if (rawPhone) {
            // Messages table
            await env.DB.prepare(`
              INSERT INTO messages (phone, text, direction, timestamp)
              VALUES (?, ?, 'inbound', ?)
            `).bind(rawPhone, textBody, now).run();

            // Leads table
            const existing = await env.DB.prepare(`
              SELECT phone FROM leads WHERE phone = ?
            `).bind(rawPhone).first();

            if (existing) {
              await env.DB.prepare(`
                UPDATE leads 
                SET last_message = ?, updated_at = ?, name = CASE WHEN name IS NULL OR name = 'Customer' OR name LIKE '+%' THEN ? ELSE name END
                WHERE phone = ?
              `).bind(textBody, now, customerName, rawPhone).run();
            } else {
              await env.DB.prepare(`
                INSERT INTO leads (phone, name, last_message, updated_at)
                VALUES (?, ?, ?, ?)
              `).bind(rawPhone, customerName, textBody, now).run();
            }
          }
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        return new Response("OK", { status: 200 });
      }
    }

    // 3. API: Get Leads List
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
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

    // 4. API: Get Chat Messages
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const rawParam = url.searchParams.get("phone") || "";
      const cleanPhone = rawParam.replace(/[^0-9]/g, "");

      if (!cleanPhone) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
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

    // 5. API: Send Outbound Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
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

        const existing = await env.DB.prepare(`SELECT phone FROM leads WHERE phone = ?`).bind(cleanPhone).first();
        if (existing) {
          await env.DB.prepare(`UPDATE leads SET last_message = ?, updated_at = ? WHERE phone = ?`).bind(text, now, cleanPhone).run();
        } else {
          await env.DB.prepare(`INSERT INTO leads (phone, name, last_message, updated_at) VALUES (?, 'Customer', ?, ?)`).bind(cleanPhone, text, now).run();
        }

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 6. Serve Original VEDASHREE PRO UI
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
