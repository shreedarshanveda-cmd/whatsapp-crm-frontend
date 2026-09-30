export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    // Auto-create messages table if missing (Fixes Error 1101 "no such table")
    const ensureMessagesTable = async () => {
      try {
        await env.DB.prepare(
          "CREATE TABLE IF NOT EXISTS messages (phone TEXT, sender TEXT, message TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
        ).run();
      } catch (e) {}
    };

    // 1. Meta Webhook Verification
    if (u.pathname === "/webhook") {
      if (req.method === "GET") {
        return u.searchParams.get("hub.verify_token") === (env.VERIFY_TOKEN || "vedashree_crm_secret_2026")
          ? new Response(u.searchParams.get("hub.challenge"), { status: 200 })
          : new Response("Forbidden", { status: 403 });
      }

      // 2. Inbound Webhook Listener (Incoming Messages)
      if (req.method === "POST") {
        try {
          await ensureMessagesTable();
          const b = await req.json();
          const v = b && b.entry && b.entry[0] && b.entry[0].changes && b.entry[0].changes[0] ? b.entry[0].changes[0].value : null;

          if (v && v.messages && v.messages[0]) {
            const m = v.messages[0];
            const p = String(m.from || "").replace(/[^0-9]/g, "");
            const name = (v.contacts && v.contacts[0] && v.contacts[0].profile) ? v.contacts[0].profile.name : "Customer";
            const txt = (m.text && m.text.body) ? m.text.body : "Media/Attachment";

            if (p) {
              try {
                await env.DB.prepare(
                  "INSERT INTO messages (phone, sender, message) VALUES (?, 'customer', ?)"
                ).bind(p, txt).run();
              } catch (eMsg) {}

              try {
                await env.DB.prepare(
                  "INSERT INTO leads (phone, name, stage) VALUES (?, ?, 'hot') ON CONFLICT(phone) DO UPDATE SET name = excluded.name"
                ).bind(p, name).run();
              } catch (errLeads) {
                try {
                  await env.DB.prepare(
                    "INSERT INTO leads (phone, name) VALUES (?, ?)"
                  ).bind(p, name).run();
                } catch (eL) {}
              }
            }
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        } catch (e) {
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
      }
    }

    // 3. CRM Leads API
    if (u.pathname === "/api/leads") {
      try {
        const q = await env.DB.prepare("SELECT * FROM leads ORDER BY rowid DESC").all();
        return Response.json(q.results || []);
      } catch (err) {
        return Response.json([]);
      }
    }

    // 4. CRM Messages API (Auto-init & Safe Query)
    if (u.pathname === "/api/messages") {
      try {
        await ensureMessagesTable();
        const rawPhone = u.searchParams.get("phone") || "";
        const cleanPhone = String(rawPhone).replace(/[^0-9]/g, "");

        if (!cleanPhone) {
          return Response.json([]);
        }

        const q = await env.DB.prepare(
          "SELECT * FROM messages WHERE phone = ? OR phone LIKE ? ORDER BY rowid ASC"
        ).bind(cleanPhone, "%" + cleanPhone.slice(-10)).all();

        return Response.json(q.results || []);
      } catch (err) {
        return Response.json([]);
      }
    }

    // 5. Send Message API (Outgoing Message Save)
    if (u.pathname === "/api/send" && req.method === "POST") {
      try {
        await ensureMessagesTable();
        const body = await req.json();
        const cleanPhone = String(body.toPhone || "").replace(/[^0-9]/g, "");

        const metaRes = await fetch("https://graph.facebook.com/v20.0/" + env.PHONE_NUMBER_ID + "/messages", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.WHATSAPP_TOKEN,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: cleanPhone,
            type: "text",
            text: { body: body.text }
          })
        });

        try {
          await env.DB.prepare(
            "INSERT INTO messages (phone, sender, message) VALUES (?, 'agent', ?)"
          ).bind(cleanPhone, body.text).run();
        } catch (eSave) {}

        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // 6. Fetch frontend index.html
    const r = await fetch("https://raw.githubusercontent.com/shreedarshanveda-cmd/whatsapp-crm-frontend/main/index.html?t=" + Date.now(), {
      cf: { cacheTtl: 0, cacheEverything: false }
    });
    const h = await r.text();
    return new Response(h, {
      headers: {
        "content-type": "text/html;charset=UTF-8",
        "cache-control": "no-store, no-cache, must-revalidate, max-age=0"
      }
    });
  }
};
