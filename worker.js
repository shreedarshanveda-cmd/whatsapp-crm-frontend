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
        const data = await request.json();

        const entry = data?.entry?.[0];
        const change = entry?.changes?.[0];
        const value = change?.value;

        let message = null;
        let contact = null;

        if (value?.messages && value.messages.length > 0) {
          message = value.messages[0];
          contact = value?.contacts?.[0];
        } else if (data?.messages && data.messages.length > 0) {
          message = data.messages[0];
          contact = data?.contacts?.[0];
        }

        if (message && message.type === "text") {
          // Normalize phone: sirf digits rakhein (+ nikal kar)
          let rawPhone = String(message.from || "").replace(/[^0-9]/g, "");
          const textBody = message.text?.body || "";
          const customerName = contact?.profile?.name || rawPhone;
          const timestamp = new Date().toISOString();

          // Leads table insert / update
          await env.whatsapp_crm_db.prepare(`
            INSERT INTO leads (phone, name, last_message, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
              name = CASE WHEN leads.name IS NULL OR leads.name = '' OR leads.name = 'Customer' THEN excluded.name ELSE leads.name END,
              last_message = excluded.last_message,
              updated_at = excluded.updated_at
          `).bind(rawPhone, customerName, textBody, timestamp).run();

          // Messages table me insert (dono fields fill taaki frontend koi bhi key padhe, message dikhe)
          await env.whatsapp_crm_db.prepare(`
            INSERT INTO messages (phone, text, direction, timestamp)
            VALUES (?, ?, 'inbound', ?)
          `).bind(rawPhone, textBody, timestamp).run();
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        return new Response("OK", { status: 200 });
      }
    }

    // 3. API: Get Leads List
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
        const { results } = await env.whatsapp_crm_db.prepare(`
          SELECT * FROM leads ORDER BY updated_at DESC
        `).all();
        return new Response(JSON.stringify(results || []), {
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 4. API: Get Chat Messages for a Phone Number (Cleaned Phone matching)
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const rawParam = url.searchParams.get("phone") || "";
      const cleanPhone = rawParam.replace(/[^0-9]/g, "");

      if (!cleanPhone) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const { results } = await env.whatsapp_crm_db.prepare(`
          SELECT 
            id, 
            phone, 
            text, 
            text AS body, 
            text AS message, 
            direction, 
            direction AS type, 
            timestamp, 
            timestamp AS created_at
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
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 5. API: Send Outbound Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        const { phone, text } = await request.json();
        const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
        const timestamp = new Date().toISOString();

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

        await env.whatsapp_crm_db.prepare(`
          INSERT INTO messages (phone, text, direction, timestamp)
          VALUES (?, ?, 'outbound', ?)
        `).bind(cleanPhone, text, timestamp).run();

        await env.whatsapp_crm_db.prepare(`
          INSERT INTO leads (phone, name, last_message, updated_at)
          VALUES (?, 'Customer', ?, ?)
          ON CONFLICT(phone) DO UPDATE SET
            last_message = excluded.last_message,
            updated_at = excluded.updated_at
        `).bind(cleanPhone, text, timestamp).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 6. Serve Original VEDASHREE PRO UI from index.html
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
