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

    // 4. Incoming WhatsApp Message & Delivery Status Webhook (POST)
    if (request.method === "POST" && url.pathname === "/webhook") {
      let bodyText = "";
      try {
        bodyText = await request.text();
        if (!bodyText) return new Response("OK", { status: 200 });

        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);

        // Always save raw packet for debugging audit
        await env.DB.prepare("INSERT INTO raw_logs (payload, created_at) VALUES (?, ?)")
          .bind(bodyText, now)
          .run();

        const data = JSON.parse(bodyText);

        let root = Array.isArray(data) ? data[0] : data;
        let entry = Array.isArray(root?.entry) ? root.entry[0] : root?.entry;
        let change = Array.isArray(entry?.changes) ? entry.changes[0] : entry?.changes;
        let val = change?.value || root?.value || root;

        // A. Handle Delivery / Read / Failed Receipts from Meta
        const statuses = val?.statuses;
        if (statuses && Array.isArray(statuses) && statuses.length > 0) {
          for (const s of statuses) {
            const metaMsgId = s.id;
            const newStatus = s.status; // 'sent', 'delivered', 'read', 'failed'
            if (metaMsgId && newStatus) {
              await env.DB.prepare(`
                UPDATE messages 
                SET status = ? 
                WHERE id = ?
              `).bind(newStatus, metaMsgId).run();
            }
          }
        }

        // B. Handle Incoming Messages from Customers
        const messages = val?.messages;
        if (messages && Array.isArray(messages) && messages.length > 0) {
          const msg = messages[0];
          const rawPhone = String(msg.from || "").replace(/[^0-9]/g, "");
          let textBody = "";
        let mediaUrl = null;
        let mediaType = msg.type || "text";
        let mediaName = null;

        if (msg.type === "text") {
          textBody = msg.text?.body || "";
        } else if (msg.type === "image") {
          textBody = msg.image?.caption || "";
          mediaName = "image_" + (msg.image?.id || Date.now()) + ".jpg";
          mediaUrl = `/api/media?id=${encodeURIComponent(msg.image?.id || "")}`;
        } else if (msg.type === "video") {
          textBody = msg.video?.caption || "";
          mediaName = "video_" + (msg.video?.id || Date.now()) + ".mp4";
          mediaUrl = `/api/media?id=${encodeURIComponent(msg.video?.id || "")}`;
        } else if (msg.type === "audio" || msg.type === "voice") {
          textBody = "[Voice Message]";
          mediaName = "audio_" + (msg.audio?.id || msg.voice?.id || Date.now()) + ".ogg";
          mediaUrl = `/api/media?id=${encodeURIComponent(msg.audio?.id || msg.voice?.id || "")}`;
        } else if (msg.type === "document") {
          textBody = msg.document?.caption || "";
          mediaName = msg.document?.filename || ("document_" + (msg.document?.id || Date.now()));
          mediaUrl = `/api/media?id=${encodeURIComponent(msg.document?.id || "")}`;
        } else if (msg.type === "location") {
          const lat = msg.location?.latitude;
          const lng = msg.location?.longitude;
          const locName = msg.location?.name || "";
          const locAddr = msg.location?.address || "";
          textBody = locName ? `${locName} (${locAddr})` : (locAddr || "Shared Location");
          mediaName = "Google Maps Location";
          mediaUrl = `https://www.google.com/maps?q=${lat},${lng}`;
        } else {
          textBody = msg.type ? `[${msg.type.toUpperCase()}]` : "Message";
            }
          const msgId = msg.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          
          let customerName = "";
          if (Array.isArray(val?.contacts) && val.contacts.length > 0) {
            customerName = val.contacts[0]?.profile?.name || "";
          }

          if (rawPhone) {
            const leadId = `lead_${rawPhone}`;

            await env.DB.prepare(`
              INSERT OR REPLACE INTO messages (id, lead_id, sender, text, media_url, media_type, media_name, status, timestamp)
              VALUES (?, ?, 'customer', ?, ?, ?, ?, 'delivered', ?)
            ).bind(msgId, leadId, textBody, mediaUrl, mediaType, mediaName, now).run();

            await env.DB.prepare(`
              INSERT INTO leads (id, name, phone, source, ad_title, stage, created_at)
              VALUES (?, ?, ?, 'Direct WhatsApp', NULL, 'hot', ?)
              ON CONFLICT(id) DO UPDATE SET
                name = CASE WHEN excluded.name != '' THEN excluded.name ELSE leads.name END,
                created_at = excluded.created_at,
                  unread_count = COALESCE(leads.unread_count, 0) + 1
            `).bind(leadId, customerName, rawPhone, now).run();
          }
          lastWebhookError = "None";
        }

        return new Response("EVENT_RECEIVED", { status: 200 });
      } catch (err) {
        lastWebhookError = `Error: ${err.message}`;
        return new Response("OK", { status: 200 });
      }
    }
    // Service Worker Endpoint for Push Notifications
  if (request.method === "GET" && url.pathname === "/sw.js") {
    const swCode = `
      self.addEventListener('install', function(e) { self.skipWaiting(); });
      self.addEventListener('activate', function(e) { e.waitUntil(self.clients.claim()); });
      self.addEventListener('notificationclick', function(e) {
        e.notification.close();
        e.waitUntil(
          clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
            for (let i = 0; i < clientList.length; i++) {
              let client = clientList[i];
              if (client.url && 'focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
          })
        );
      });
    `;
    return new Response(swCode, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }

    // 5. API: Fetch Leads List
    if (request.method === "GET" && url.pathname === "/api/leads") {
      try {
        const { results } = await env.DB.prepare(`
          SELECT
            id,
            COALESCE(name, '') AS name,
            phone,
            COALESCE(source, 'Direct WhatsApp') AS source,
            COALESCE(stage, 'hot') AS status,
            COALESCE(unread_count, 0) AS unread_count,
            created_at,
            (SELECT text FROM messages WHERE lead_id = leads.id ORDER BY timestamp DESC LIMIT 1) AS last_message
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
      const rawParam = url.searchParams.get("phone") || url.searchParams.get("lead_id") || "";
      const cleanPhone = rawParam.replace(/[^0-9]/g, "");
      const leadId = rawParam.startsWith("lead_") ? rawParam : `lead_${cleanPhone}`;

      try {
        await env.DB.prepare("UPDATE leads SET unread_count = 0 WHERE id = ? OR phone = ?").bind(leadId, cleanPhone).run();
        const { results } = await env.DB.prepare(`
          SELECT 
            id,
            lead_id,
            text,
            text AS message,
            media_url,
            media_type,
            media_name,
            CASE WHEN sender = 'agent' THEN 'agent' ELSE 'customer' END AS sender,
            COALESCE(timestamp, datetime('now')) AS created_at
          FROM messages 
          WHERE lead_id = ? OR lead_id = ?
          ORDER BY timestamp ASC
        `).bind(leadId, cleanPhone).all();

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
    // 6.1 API: Fetch WhatsApp Media from Meta Cloud API
  if (request.method === "GET" && url.pathname === "/api/media") {
    try {
      const mediaId = url.searchParams.get("id");
      if (!mediaId) return new Response("Missing media id", { status: 400 });

      const metaToken = env.WHATSAPP_TOKEN || env.META_ACCESS_TOKEN || env.ACCESS_TOKEN;
      if (!metaToken) return new Response("WhatsApp token not configured in worker env", { status: 500 });

      const metaRes = await fetch(`https://graph.facebook.com/v19.0/${mediaId}`, {
        headers: { "Authorization": `Bearer ${metaToken}` }
      });
      if (!metaRes.ok) return new Response("Failed to retrieve media meta", { status: metaRes.status });

      const metaData = await metaRes.json();
      if (!metaData.url) return new Response("Media download URL missing", { status: 404 });

      const fileRes = await fetch(metaData.url, {
        headers: { "Authorization": `Bearer ${metaToken}` }
      });

      return new Response(fileRes.body, {
        status: 200,
        headers: {
          "Content-Type": fileRes.headers.get("Content-Type") || metaData.mime_type || "application/octet-stream",
          "Cache-Control": "public, max-age=86400"
        }
      });
    } catch (err) {
      return new Response("Media Error: " + err.message, { status: 500 });
    }
        }
   // API: Delete Single Message
    if (request.method === "POST" && url.pathname === "/api/delete-message") {
      try {
        const body = await request.json();
        const msgId = body.id;
        if (!msgId) {
          return new Response(JSON.stringify({ error: "Missing message id" }), {
            headers: { "Content-Type": "application/json" },
            status: 400
          });
        }
        await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(msgId).run();
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }

    // API: Delete Entire Lead & Conversation
    if (request.method === "POST" && url.pathname === "/api/delete-lead") {
      try {
        const body = await request.json();
        const rawPhone = body.phone || "";
        const cleanPhone = String(rawPhone).replace(/[^0-9]/g, "");
        const leadId = `lead_${cleanPhone}`;
        
        if (!cleanPhone) {
          return new Response(JSON.stringify({ error: "Missing phone number" }), {
            headers: { "Content-Type": "application/json" },
            status: 400
          });
        }

        // Delete all messages belonging to this lead
        await env.DB.prepare("DELETE FROM messages WHERE lead_id = ? OR lead_id = ?").bind(leadId, cleanPhone).run();
        // Delete lead from leads table
        await env.DB.prepare("DELETE FROM leads WHERE phone = ? OR id = ?").bind(cleanPhone, leadId).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }
    // 7. API: Send Outbound 1-to-1 Message
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        const body = await request.json();
        const rawPhone = body.toPhone || body.phone || body.lead_id || "";
        const cleanPhone = String(rawPhone).replace(/[^0-9]/g, "");
        const messageText = body.text || body.message || "";
        const leadId = `lead_${cleanPhone}`;
        const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const outMsgId = `out_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

        if (env.WHATSAPP_TOKEN && cleanPhone && messageText) {
          const metaRes = await fetch("https://graph.facebook.com/v20.0/1196276640235299/messages", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: cleanPhone,
              type: "text",
              text: { body: messageText }
            })
          });

          if (!metaRes.ok) {
            const metaErrText = await metaRes.text();
            lastWebhookError = `Meta Send Error: ${metaErrText}`;
            return new Response(JSON.stringify({ error: metaErrText }), {
              headers: { "Content-Type": "application/json" },
              status: 400
            });
          }
        }

        await env.DB.prepare(`
          INSERT INTO messages (id, lead_id, sender, text, media_url, media_type, media_name, status, timestamp)
          VALUES (?, ?, 'agent', ?, NULL, NULL, NULL, 'sent', ?)
        `).bind(outMsgId, leadId, messageText, now).run();

        await env.DB.prepare(`
          INSERT INTO leads (id, name, phone, source, ad_title, stage, created_at)
          VALUES (?, '', ?, 'Direct WhatsApp', NULL, 'hot', ?)
          ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at
        `).bind(leadId, cleanPhone, now).run();

        return new Response(JSON.stringify({ success: true, id: outMsgId }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        lastWebhookError = `Send Catch Error: ${err.message}`;
        return new Response(JSON.stringify({ error: err.message }), { 
          headers: { "Content-Type": "application/json" },
          status: 500 
        });
      }
    }

    // 8. API: Automatically Fetch Approved Templates from Meta
    if (request.method === "GET" && url.pathname === "/api/templates") {
      try {
        let templates = [
          { name: "vedashree_vitality_consult_v1", language: "en", status: "APPROVED" }
        ];

        if (env.WHATSAPP_TOKEN) {
          const wabaRes = await fetch("https://graph.facebook.com/v20.0/1196276640235299?fields=whatsapp_business_account", {
            headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
          });
          if (wabaRes.ok) {
            const wabaData = await wabaRes.json();
            const wabaId = wabaData.whatsapp_business_account?.id;
            if (wabaId) {
              const tmplRes = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates?status=APPROVED&limit=50`, {
                headers: { "Authorization": `Bearer ${env.WHATSAPP_TOKEN}` }
              });
              if (tmplRes.ok) {
                const tmplData = await tmplRes.json();
                if (Array.isArray(tmplData.data) && tmplData.data.length > 0) {
                  templates = tmplData.data.map(t => ({
                    name: t.name,
                    language: t.language,
                    status: t.status,
                    has_param: JSON.stringify(t.components || []).includes("{{1}}")
                  }));
                }
              }
            }
          }
        }

        return new Response(JSON.stringify(templates), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify([
          { name: "vedashree_vitality_consult_v1", language: "en", status: "APPROVED" }
        ]), { headers: { "Content-Type": "application/json" } });
      }
    }

    // 9. API: Send Broadcast Template Message
    if (request.method === "POST" && url.pathname === "/api/broadcast-send") {
      try {
        const body = await request.json();
        const rawPhone = String(body.phone || "").replace(/[^0-9]/g, "");
        const tName = body.templateName || "vedashree_vitality_consult_v1";
        const tLang = body.languageCode || "en";
        const trimmedName = String(body.name || "").trim();
        const cName = trimmedName.length > 0 ? trimmedName : "Sir / Ma'am";

        if (!rawPhone || !env.WHATSAPP_TOKEN) {
          return new Response(JSON.stringify({ success: false, error: "Missing phone or WhatsApp token" }), { status: 400 });
        }

        const tPayload = {
          messaging_product: "whatsapp",
          to: rawPhone,
          type: "template",
          template: {
            name: tName,
            language: { code: tLang },
            components: [
              {
                type: "header",
                parameters: [
                  {
                    type: "image",
                    image: {
                      link: "https://vedashree.gt.tc/wp-content/uploads/2026/09/55b8913a-06a0-4517-936c-6be74887079b.png"
                    }
                  }
                ]
              },
              {
                type: "body",
                parameters: [
                  {
                    type: "text",
                    text: cName
                  }
                ]
              }
            ]
          }
        };

        const metaRes = await fetch("https://graph.facebook.com/v20.0/1196276640235299/messages", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(tPayload)
        });

        const metaData = await metaRes.json();

        if (metaRes.ok && metaData.messages) {
          const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
          const leadId = `lead_${rawPhone}`;
          
          await env.DB.prepare(`
            INSERT INTO messages (id, lead_id, sender, text, media_url, media_type, media_name, status, timestamp)
            VALUES (?, ?, 'agent', ?, NULL, NULL, NULL, 'sent', ?)
          `).bind(metaData.messages[0].id, leadId, `[Template: ${tName}]`, now).run();

          return new Response(JSON.stringify({ success: true, id: metaData.messages[0].id }), {
            headers: { "Content-Type": "application/json" }
          });
        } else {
          const errMsg = metaData.error?.error_user_msg || metaData.error?.error_data?.details || metaData.error?.message || "Meta API Rejected";
          lastWebhookError = JSON.stringify(metaData);
          return new Response(JSON.stringify({ success: false, error: errMsg }), {
            headers: { "Content-Type": "application/json" },
            status: 400
          });
        }
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }

    // 10. NEW: API: Broadcast Analytics & Delivery / Seen Tracking with Date Filter
    if (request.method === "GET" && url.pathname === "/api/broadcast-analytics") {
      try {
        const queryDate = url.searchParams.get("date") || new Date().toISOString().substring(0, 10);
        
        // Fetch all broadcast template messages sent on that date
        const { results } = await env.DB.prepare(`
          SELECT 
            m.id,
            m.lead_id,
            REPLACE(m.lead_id, 'lead_', '') AS phone,
            COALESCE(l.name, 'Sir / Ma' || '''' || 'am') AS name,
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

        let total = list.length;
        let delivered = 0;
        let read = 0;
        let failed = 0;
        let unread = 0;

        const seenList = [];
        const unseenList = [];

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
            // 'sent' status
            unread++;
            unseenList.push(item);
          }
        }

        return new Response(JSON.stringify({
          date: queryDate,
          summary: {
            total,
            delivered,
            seen: read,
            unseen: unread,
            failed
          },
          seenList,
          unseenList
        }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          headers: { "Content-Type": "application/json" },
          status: 500
        });
      }
    }

    // 11. Serve Frontend UI
    return new Response(HTML_CONTENT, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
