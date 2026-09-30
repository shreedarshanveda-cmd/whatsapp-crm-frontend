export default {
  async fetch(req, env) {
    const u = new URL(req.url);

    // 1. Meta Webhook Verification
    if (u.pathname === "/webhook") {
      if (req.method === "GET") {
        return u.searchParams.get("hub.verify_token") === (env.VERIFY_TOKEN || "vedashree_crm_secret_2026")
          ? new Response(u.searchParams.get("hub.challenge"), { status: 200 })
          : new Response("Forbidden", { status: 403 });
      }

      // 2. Inbound Webhook Listener (Incoming Message Fix)
      if (req.method === "POST") {
        try {
          const b = await req.json();
          const v = b && b.entry && b.entry[0] && b.entry[0].changes && b.entry[0].changes[0] ? b.entry[0].changes[0].value : null;

          if (v && v.messages && v.messages[0]) {
            const m = v.messages[0];
            const p = m.from;
            const name = (v.contacts && v.contacts[0] && v.contacts[0].profile) ? v.contacts[0].profile.name : "Customer";
            const txt = (m.text && m.text.body) ? m.text.body : "Media/Attachment";

            // Pehle message save karein bina kisi condition ke
            await env.DB.prepare(
              "INSERT INTO messages (phone, sender, message) VALUES (?, 'customer', ?)"
            ).bind(p, txt).run();

            // Fir lead ko save/update karein
            try {
              await env.DB.prepare(
                "INSERT INTO leads (phone, name, stage) VALUES (?, ?, 'hot') ON CONFLICT(phone) DO UPDATE SET name = excluded.name"
              ).bind(p, name).run();
            } catch (errLeads) {
              await env.DB.prepare(
                "INSERT INTO leads (phone, name) VALUES (?, ?)"
              ).bind(p, name).run();
            }
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        } catch (e) {
          return new Response("EVENT_RECEIVED", { status: 200 });
        }
      }
    }

    // 3. CRM APIs
    if (u.pathname === "/api/leads") {
      const q = await env.DB.prepare("SELECT * FROM leads ORDER BY rowid DESC").all();
      return Response.json(q.results || []);
    }

    if (u.pathname === "/api/messages") {
      const phone = u.searchParams.get("phone");
      const q = await env.DB.prepare("SELECT * FROM messages WHERE phone = ? ORDER BY rowid ASC").bind(phone).all();
      return Response.json(q.results || []);
    }

    // 4. Send Message API (Refresh Par Gayab Hone Ka Fix)
    if (u.pathname === "/api/send" && req.method === "POST") {
      try {
        const body = await req.json();
        const cleanPhone = body.toPhone.replace(/[^0-9]/g, "");

        // WhatsApp Meta API ko bhejte hain
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

        // Seedha D1 database me save karein taaki refresh par kabhi gayab na ho
        await env.DB.prepare(
          "INSERT INTO messages (phone, sender, message) VALUES (?, 'agent', ?)"
        ).bind(cleanPhone, body.text).run();

        return Response.json({ success: true });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // 5. Frontend index.html load
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
