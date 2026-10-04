// ==========================================
// VEDASHREE CRM BACKEND & ENGINE (worker.js)
// ==========================================

// 1. GEMINI AI ASSISTANT CONFIGURATION
let IS_AI_ACTIVE_GLOBAL = true; // Default State (Can be toggled via CRM UI)

const GEMINI_CONFIG = {
  API_KEY: "AIzaSy_YOUR_DUMMY_GEMINI_KEY",
  SYSTEM_PROMPT: `Aap Vedashree Wellness ke Senior Ayurveda Health Consultant hain.
Aapka vyavahar vinamra, shant aur aadarpoorna hona chahiye.
Aapko customer ke sawalon ka satik ayurvedic aur health-oriented samadhan dena hai.
Company ke Men's Wellness products (Oil, Capsules, Prash) ke benefits naturally explain karein bina galat fake daave kiye.
Har message me namaste aur sammanjanak tone ka upyog karein.`
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS Headers setup
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 2. AI MANUAL ON/OFF TOGGLE API
    if (url.pathname === "/api/toggle-ai") {
      if (request.method === "GET") {
        return new Response(JSON.stringify({ active: IS_AI_ACTIVE_GLOBAL }), {
          headers: { "Content-Type": "application/json" }
        });
      }
      if (request.method === "POST") {
        try {
          const { active } = await request.json();
          IS_AI_ACTIVE_GLOBAL = Boolean(active);
          return new Response(JSON.stringify({ success: true, active: IS_AI_ACTIVE_GLOBAL }), {
            headers: { "Content-Type": "application/json" }
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 400 });
        }
      }
    }

    // 3. PWA MANIFEST ENDPOINT
    if (url.pathname === "/manifest.json") {
      const manifest = {
        name: "VEDASHREE PRO CRM",
        short_name: "Vedashree",
        start_url: "/",
        display: "standalone",
        background_color: "#0b1120",
        theme_color: "#0b1120",
        icons: [
          {
            src: "https://vedashree.gt.tc/wp-content/uploads/2026/09/55b8913a-06a0-4517-936c-6be74887079b.png",
            sizes: "192x192",
            type: "image/png"
          },
          {
            src: "https://vedashree.gt.tc/wp-content/uploads/2026/09/55b8913a-06a0-4517-936c-6be74887079b.png",
            sizes: "512x512",
            type: "image/png"
          }
        ]
      };
      return new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" }
      });
    }

    // 4. PWA SERVICE WORKER (Background Push Notification Handler)
    if (url.pathname === "/sw.js") {
      const swCode = `
        self.addEventListener('install', (e) => { self.skipWaiting(); });
        self.addEventListener('activate', (e) => { e.waitUntil(clients.claim()); });
        self.addEventListener('fetch', (e) => { e.respondWith(fetch(e.request)); });

        self.addEventListener('push', (event) => {
          let data = { title: 'New Customer Message', body: 'You received a new inquiry on WhatsApp.', phone: '' };
          if (event.data) {
            try { data = event.data.json(); } catch(e) { data.body = event.data.text(); }
          }
          const options = {
            body: data.body,
            icon: 'https://vedashree.gt.tc/wp-content/uploads/2026/09/55b8913a-06a0-4517-936c-6be74887079b.png',
            badge: 'https://vedashree.gt.tc/wp-content/uploads/2026/09/55b8913a-06a0-4517-936c-6be74887079b.png',
            vibrate: [200, 100, 200],
            data: { url: '/?phone=' + (data.phone || '') }
          };
          event.waitUntil(self.registration.showNotification(data.title, options));
        });

        self.addEventListener('notificationclick', (event) => {
          event.notification.close();
          event.waitUntil(
            clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
              if (clientList.length > 0) {
                return clientList[0].focus();
              }
              return clients.openWindow(event.notification.data.url || '/');
            })
          );
        });
      `;
      return new Response(swCode, {
        headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" }
      });
    }

    // 5. API: Save Push Subscription Token to D1
    if (request.method === "POST" && url.pathname === "/api/push-subscribe") {
      try {
        const sub = await request.json();
        if (sub && sub.endpoint) {
          const p256dh = sub.keys ? sub.keys.p256dh : "";
          const auth = sub.keys ? sub.keys.auth : "";
          await env.DB.prepare(
            `INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth) VALUES (?, ?, ?)`
          ).bind(sub.endpoint, p256dh, auth).run();
        }
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 6. API: Send Image / Gallery Media File via Meta Cloud API
    if (request.method === "POST" && url.pathname === "/api/send-media") {
      try {
        const { phone, mediaUrl, caption } = await request.json();
        const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || "1196276640235299";
        const metaToken = env.WHATSAPP_ACCESS_TOKEN;

        const payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "image",
          image: {
            link: mediaUrl,
            caption: caption || ""
          }
        };

        const metaRes = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${metaToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const metaData = await metaRes.json();
        if (metaData.messages && metaData.messages[0]) {
          const wamid = metaData.messages[0].id;
          const leadId = `lead_${phone}`;
          await env.DB.prepare(
            `INSERT INTO messages (id, lead_id, sender, text, status, timestamp) VALUES (?, ?, 'agent', ?, 'sent', datetime('now'))`
          ).bind(wamid, leadId, `[Image: ${caption || 'Attachment'}]`).run();

          return new Response(JSON.stringify({ success: true, id: wamid }), {
            headers: { "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ success: false, error: metaData }), { status: 400 });
        }
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
                    }
    // 7. API: Leads List
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
        const { results } = await env.DB.prepare(
          `SELECT id, REPLACE(id, 'lead_', '') as phone, name, status, last_message, created_at FROM leads ORDER BY created_at DESC LIMIT 50`
        ).all();
        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      }
    }

    // 8. API: Messages for a Specific Lead
    if (request.method === "GET" && url.pathname === "/api/messages") {
      try {
        const phone = url.searchParams.get("phone");
        const leadId = `lead_${phone}`;
        const { results } = await env.DB.prepare(
          `SELECT id, lead_id, sender, text, status, timestamp as created_at FROM messages WHERE lead_id = ? ORDER BY timestamp ASC`
        ).bind(leadId).all();
        return new Response(JSON.stringify(results || []), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      }
    }

    // 9. API: Direct 1-to-1 Send Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        const { phone, text } = await request.json();
        const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || "1196276640235299";
        const metaToken = env.WHATSAPP_ACCESS_TOKEN;

        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${metaToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: phone,
            type: "text",
            text: { body: text }
          })
        });

        const respData = await res.json();
        if (respData.messages && respData.messages[0]) {
          const wamid = respData.messages[0].id;
          const leadId = `lead_${phone}`;
          await env.DB.prepare(
            `INSERT INTO messages (id, lead_id, sender, text, status, timestamp) VALUES (?, ?, 'agent', ?, 'sent', datetime('now'))`
          ).bind(wamid, leadId, text).run();

          await env.DB.prepare(
            `UPDATE leads SET last_message = ? WHERE id = ?`
          ).bind(text, leadId).run();

          return new Response(JSON.stringify({ success: true, id: wamid }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ success: false, error: respData }), { status: 400 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 10. API: Broadcast Send (Template Messages)
    if (request.method === "POST" && url.pathname === "/api/broadcast-send") {
      try {
        const { phone, name, templateName, languageCode } = await request.json();
        const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || "1196276640235299";
        const metaToken = env.WHATSAPP_ACCESS_TOKEN;

        const payload = {
          messaging_product: "whatsapp",
          recipient_type: "individual",
          to: phone,
          type: "template",
          template: {
            name: templateName,
            language: { code: languageCode || "en" }
          }
        };

        const res = await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${metaToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(payload)
        });

        const respData = await res.json();
        if (respData.messages && respData.messages[0]) {
          const wamid = respData.messages[0].id;
          const leadId = `lead_${phone}`;

          await env.DB.prepare(
            `INSERT OR IGNORE INTO leads (id, name, status, created_at) VALUES (?, ?, 'hot', datetime('now'))`
          ).bind(leadId, name || "Sir / Ma'am").run();

          await env.DB.prepare(
            `INSERT INTO messages (id, lead_id, sender, text, status, timestamp) VALUES (?, ?, 'agent', ?, 'sent', datetime('now'))`
          ).bind(wamid, leadId, `[Template: ${templateName}]`).run();

          return new Response(JSON.stringify({ success: true, id: wamid }), {
            headers: { "Content-Type": "application/json" }
          });
        }
        return new Response(JSON.stringify({ success: false, error: respData }), { status: 400 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 11. API: Broadcast Analytics & Delivery / Seen Tracking
    if (request.method === "GET" && url.pathname === "/api/broadcast-analytics") {
      try {
        const queryDate = url.searchParams.get("date") || new Date().toISOString().substring(0, 10);
        const { results } = await env.DB.prepare(`
          SELECT 
            m.id,
            m.lead_id,
            REPLACE(m.lead_id, 'lead_', '') AS phone,
            COALESCE(l.name, 'Sir / Ma''am') AS name,
            m.text,
            m.status,
            m.timestamp
          FROM messages m
          LEFT JOIN leads l ON l.id = m.lead_id
          WHERE m.sender = 'agent'
            AND m.text LIKE '[Template:%'
            AND m.timestamp LIKE ?
          ORDER BY m.timestamp DESC
        `).bind(`${queryDate}%`).all();

        const list = results || [];
        let delivered = 0, read = 0, failed = 0, unread = 0;
        const seenList = [], unseenList = [];

        for (const item of list) {
          if (item.status === "read") {
            read++;
            delivered++;
            seenList.push(item);
          } else if (item.status === "delivered") {
            delivered++;
            unread++;
            unseenList.push(item);
          } else if (item.status === "failed") {
            failed++;
            unseenList.push(item);
          } else {
            unread++;
            unseenList.push(item);
          }
        }

        return new Response(JSON.stringify({
          date: queryDate,
          summary: { total: list.length, delivered, seen: read, unseen: unread, failed },
          seenList,
          unseenList
        }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 12. API: Fetch WhatsApp Cloud Templates
    if (request.method === "GET" && url.pathname === "/api/templates") {
      try {
        const wabaId = env.WHATSAPP_BUSINESS_ACCOUNT_ID || "1214041777209148";
        const metaToken = env.WHATSAPP_ACCESS_TOKEN;
        const res = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates?fields=name,status,language`, {
          headers: { "Authorization": `Bearer ${metaToken}` }
        });
        const data = await res.json();
        const approved = (data.data || []).filter(t => t.status === "APPROVED");
        return new Response(JSON.stringify(approved), { headers: { "Content-Type": "application/json" } });
      } catch (err) {
        return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
      }
    }

    // 13. WEBHOOK: Meta WhatsApp Webhook + Gemini AI Auto-Reply (Controlled by IS_AI_ACTIVE_GLOBAL)
    if (url.pathname === "/webhook") {
      if (request.method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expectedToken = env.WEBHOOK_VERIFY_TOKEN || "vedashree_crm_secret_2026";
        if (mode === "subscribe" && token === expectedToken) {
          return new Response(challenge, { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      }

      if (request.method === "POST") {
        try {
          const body = await request.json();
          const entry = body.entry?.[0];
          const changes = entry?.changes?.[0];
          const value = changes?.value;

          // Message Status Update (Sent -> Delivered -> Read Blue Tick)
          if (value?.statuses && value.statuses[0]) {
            const statusObj = value.statuses[0];
            const wamid = statusObj.id;
            const newStatus = statusObj.status;
            await env.DB.prepare(
              `UPDATE messages SET status = ? WHERE id = ?`
            ).bind(newStatus, wamid).run();
          }

          // Incoming Customer Message
          if (value?.messages && value.messages[0]) {
            const msg = value.messages[0];
            const fromPhone = msg.from;
            const senderName = value.contacts?.[0]?.profile?.name || "Customer";
            const textBody = msg.text?.body || (msg.type === "image" ? "[Image received]" : "[Unsupported message]");
            const leadId = `lead_${fromPhone}`;

            // Save Lead & Message in D1
            await env.DB.prepare(
              `INSERT OR IGNORE INTO leads (id, name, status, created_at) VALUES (?, ?, 'hot', datetime('now'))`
            ).bind(leadId, senderName).run();

            await env.DB.prepare(
              `UPDATE leads SET last_message = ? WHERE id = ?`
            ).bind(textBody, leadId).run();

            await env.DB.prepare(
              `INSERT INTO messages (id, lead_id, sender, text, status, timestamp) VALUES (?, ?, 'customer', ?, 'read', datetime('now'))`
            ).bind(msg.id, leadId, textBody).run();

            // Background Web Push Notification to Admin Devices
            try {
              const { results: subs } = await env.DB.prepare(`SELECT * FROM push_subscriptions`).all();
            } catch (pushErr) {
              console.error("Push notification dispatch error:", pushErr);
            }

            // GEMINI AUTO-REPLY ONLY IF TOGGLE IS "ON"
            const geminiKey = env.GEMINI_API_KEY || GEMINI_CONFIG.API_KEY;
            if (IS_AI_ACTIVE_GLOBAL && textBody && !textBody.startsWith("[") && geminiKey && !geminiKey.includes("YOUR_DUMMY")) {
              try {
                const aiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    contents: [{
                      parts: [
                        { text: GEMINI_CONFIG.SYSTEM_PROMPT },
                        { text: `Customer Message: "${textBody}". Jawab dijiye:` }
                      ]
                    }]
                  })
                });
                const aiData = await aiRes.json();
                const replyText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (replyText) {
                  const phoneId = env.WHATSAPP_PHONE_NUMBER_ID || "1196276640235299";
                  const metaToken = env.WHATSAPP_ACCESS_TOKEN;
                  await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
                    method: "POST",
                    headers: { "Authorization": `Bearer ${metaToken}`, "Content-Type": "application/json" },
                    body: JSON.stringify({
                      messaging_product: "whatsapp",
                      recipient_type: "individual",
                      to: fromPhone,
                      type: "text",
                      text: { body: replyText }
                    })
                  });
                }
              } catch (aiErr) {
                console.error("Gemini Auto-Reply Error:", aiErr);
              }
            }
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        } catch (e) {
          return new Response("Webhook processing error: " + e.message, { status: 500 });
        }
      }
    }

    // 14. Fallback Handler
    return new Response("Not Found", { status: 404 });
  }
};
