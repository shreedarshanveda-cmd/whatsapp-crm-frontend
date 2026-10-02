import HTML_CONTENT from "./index.html";

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
        bodyText = await request.text();
        if (!bodyText) return new Response("OK", { status: 200 });

        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        // Always save raw packet for verification
        await env.DB.prepare("INSERT INTO raw_logs (payload, created_at) VALUES (?, ?)")
          .bind(bodyText, now)
          .run();

        const data = JSON.parse(bodyText);

        let root = Array.isArray(data) ? data[0] : data;
        let entry = Array.isArray(root?.entry) ? root.entry[0] : root?.entry;
        let change = Array.isArray(entry?.changes) ? entry.changes[0] : entry?.changes;
        let val = change?.value || root?.value || root;

        const messages = val?.messages;

        if (messages && Array.isArray(messages) && messages.length > 0) {
          const msg = messages[0];
          const rawPhone = String(msg.from || "").replace(/[^0-9]/g, "");
          const textBody = msg.text?.body || (msg.type ? `[${msg.type.toUpperCase()}]` : "Message");
          
          let customerName = "Dr";
          if (Array.isArray(val?.contacts) && val.contacts.length > 0) {
            customerName = val.contacts[0]?.profile?.name || customerName;
          }

          if (rawPhone) {
            // Write to messages table
            await env.DB.prepare(`
              INSERT INTO messages (phone, text, direction, timestamp)
              VALUES (?, ?, 'inbound', ?)
            `).bind(rawPhone, textBody, now).run();

            // Match actual leads schema: (id, name, phone, source, ad_title, stage, created_at)
            const leadId = `lead_${rawPhone}`;
            await env.DB.prepare(`
              INSERT OR REPLACE INTO leads (id, name, phone, source, ad_title, stage, created_at)
              VALUES (?, ?, ?, 'Direct WhatsApp', NULL, 'hot', ?)
            `).bind(leadId, customerName, rawPhone, now).run();
          }
          lastWebhookError = "None";
        } else {
          lastWebhookError = "Payload received but no messages array found in value";
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        lastWebhookError = `Error: ${err.message}`;
        return new Response("OK", { status: 200 });
      }
    }

    // 5. API: Fetch Leads List (Exact Schema Alignment)
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
        const { results } = await env.DB.prepare(`
          SELECT 
            id,
            name,
            phone,
            COALESCE(source, 'Direct WhatsApp') AS source,
            COALESCE(stage, 'hot') AS status,
            created_at,
            (SELECT text FROM messages WHERE REPLACE(REPLACE(phone, '+', ''), ' ', '') = leads.phone ORDER BY id DESC LIMIT 1) AS last_message
          FROM leads 
          ORDER BY created_at DESC
        `).all();

        return new Response(JSON.stringify(results || []), {
          headers: { 
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
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
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }

    // 7. API: Send Outbound Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        const { phone, text } = await request.json();
        const cleanPhone = String(phone || "").replace(/[^0-9]/g, "");
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        if (env.WHATSAPP_TOKEN) {
          await fetch("https://graph.facebook.com/v20.0/1196276640235299/messages", {
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

        const leadId = `lead_${cleanPhone}`;
        await env.DB.prepare(`
          INSERT OR REPLACE INTO leads (id, name, phone, source, ad_title, stage, created_at)
          VALUES (?, 'Customer', ?, 'Direct WhatsApp', NULL, 'hot', ?)
        `).bind(leadId, cleanPhone, now).run();

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
