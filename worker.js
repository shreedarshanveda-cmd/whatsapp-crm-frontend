// ==========================================
// VEDASHREE PRO CRM - UNIFIED PRODUCTION ENGINE
// File: worker.js (Backend + Frontend)
// ==========================================

let IS_AI_ACTIVE_GLOBAL = true;

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

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    // 1. AI Manual ON/OFF Toggle API
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

    // 2. PWA Web App Manifest Endpoint
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

    // 3. PWA Service Worker (Push Notifications)
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
              if (clientList.length > 0) return clientList[0].focus();
              return clients.openWindow(event.notification.data.url || '/');
            })
          );
        });
      `;
      return new Response(swCode, {
        headers: { "Content-Type": "application/javascript", "Cache-Control": "public, max-age=3600" }
      });
    }

    // 4. API: Save Push Subscription Token to D1
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

    // 5. API: Send Gallery Media to WhatsApp
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
          image: { link: mediaUrl, caption: caption || "" }
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
        }
        return new Response(JSON.stringify({ success: false, error: metaData }), { status: 400 });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
          }
    // 6. API: Leads List
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

    // 7. API: Messages for a Specific Lead
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

    // 8. API: Direct 1-to-1 Send Message
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

    // 9. API: Broadcast Send (Template Messages)
    if (request.method === "POST" && url.pathname === "/api/broadcast-send") {
      try {
        const { phone, name, templateName, languageCode } = await request.json();
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
            type: "template",
            template: {
              name: templateName,
              language: { code: languageCode || "en" }
            }
          })
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

    // 10. API: Broadcast Analytics & Seen/Unseen Tracking
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

    // 11. API: WhatsApp Cloud Approved Templates List
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

    // 12. Meta Webhook & Verification + Gemini Auto-Reply
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

          if (value?.statuses && value.statuses[0]) {
            const statusObj = value.statuses[0];
            await env.DB.prepare(
              `UPDATE messages SET status = ? WHERE id = ?`
            ).bind(statusObj.status, statusObj.id).run();
          }

          if (value?.messages && value.messages[0]) {
            const msg = value.messages[0];
            const fromPhone = msg.from;
            const senderName = value.contacts?.[0]?.profile?.name || "Customer";
            const textBody = msg.text?.body || (msg.type === "image" ? "[Image received]" : "[Unsupported message]");
            const leadId = `lead_${fromPhone}`;

            await env.DB.prepare(
              `INSERT OR IGNORE INTO leads (id, name, status, created_at) VALUES (?, ?, 'hot', datetime('now'))`
            ).bind(leadId, senderName).run();

            await env.DB.prepare(
              `UPDATE leads SET last_message = ? WHERE id = ?`
            ).bind(textBody, leadId).run();

            await env.DB.prepare(
              `INSERT INTO messages (id, lead_id, sender, text, status, timestamp) VALUES (?, ?, 'customer', ?, 'read', datetime('now'))`
            ).bind(msg.id, leadId, textBody).run();

            // Gemini Auto-Reply
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
                console.error("Gemini Error:", aiErr);
              }
            }
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        } catch (e) {
          return new Response("Webhook error: " + e.message, { status: 500 });
        }
      }
    }
    // 13. Serve Frontend UI
    return new Response(INDEX_HTML, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};

const INDEX_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>VEDASHREE PRO CRM</title>
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0b1120">
  <script src="https://cdn.tailwindcss.com"><\/script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  <style>
    body { background-color: #0b1120; color: #f1f5f9; font-family: ui-sans-serif, system-ui, sans-serif; }
    .custom-scroll::-webkit-scrollbar { width: 4px; height: 4px; }
    .custom-scroll::-webkit-scrollbar-track { background: #0f172a; }
    .custom-scroll::-webkit-scrollbar-thumb { background: #334155; border-radius: 4px; }
  </style>
</head>
<body class="h-[100dvh] flex flex-col overflow-hidden">
  <header class="bg-[#0f172a] border-b border-slate-800 px-3 py-2 flex items-center justify-between shrink-0">
    <div class="flex items-center gap-2">
      <div class="w-8 h-8 rounded-lg bg-emerald-600/20 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-bold">V</div>
      <h1 class="text-xs sm:text-sm font-semibold text-slate-100">VEDASHREE PRO CRM</h1>
    </div>
    <div class="flex items-center gap-2">
      <button id="btnAiToggle" onclick="toggleGeminiAiState()" class="text-[11px] bg-emerald-950/60 text-emerald-400 px-2.5 py-1.5 rounded border border-emerald-800/50 flex items-center gap-1.5">
        <i class="fa-solid fa-robot"></i> <span id="txtAiStatus">AI: ON</span>
      </button>
      <button onclick="window.location.reload()" class="text-[11px] bg-slate-800 text-slate-300 px-2.5 py-1.5 rounded border border-slate-700">Refresh</button>
    </div>
  </header>

  <nav class="bg-[#0b1329] border-b border-slate-800 px-3 flex gap-1 shrink-0">
    <button id="tab-livechat" onclick="switchMainTab('livechat')" class="px-3 py-2 text-xs font-medium text-emerald-400 border-b-2 border-emerald-500">Live Chat</button>
    <button id="tab-broadcast" onclick="switchMainTab('broadcast')" class="px-3 py-2 text-xs font-medium text-slate-400 border-b-2 border-transparent">Broadcast</button>
  </nav>

  <main class="flex-1 overflow-hidden relative">
    <div id="view-livechat" class="h-full flex flex-col md:flex-row overflow-hidden">
      <aside id="leadsSidebar" class="w-full md:w-80 border-r border-slate-800 flex flex-col bg-[#0b1120] h-full">
        <div class="p-2 border-b border-slate-800">
          <input type="text" id="leadSearch" onkeyup="filterLeads()" placeholder="Search..." class="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-slate-200">
        </div>
        <div id="leadsList" class="flex-1 overflow-y-auto custom-scroll p-2 space-y-1"></div>
      </aside>

      <section id="chatSection" class="hidden md:flex flex-1 flex-col bg-[#070b14] h-full">
        <div class="p-2.5 border-b border-slate-800 bg-[#0b1120] flex items-center justify-between">
          <button onclick="mobileBack()" class="md:hidden text-xs bg-slate-800 px-2 py-1 rounded">Back</button>
          <span id="activeName" class="text-xs font-bold text-slate-200">Select Lead</span>
          <span id="activePhone" class="text-[10px] text-slate-400 font-mono">--</span>
        </div>
        <div id="chatBox" class="flex-1 overflow-y-auto custom-scroll p-3 space-y-2">
          <p class="text-xs text-slate-500 text-center mt-10">Select a conversation to view chat.</p>
        </div>
        <div class="p-2 bg-[#0b1120] border-t border-slate-800 flex items-center gap-1.5">
          <input type="file" id="mediaInput" accept="image/*" onchange="uploadImage(event)" class="hidden">
          <button onclick="document.getElementById('mediaInput').click()" class="bg-slate-800 text-slate-300 p-2 rounded text-xs">
            <i class="fa-solid fa-paperclip"></i>
          </button>
          <input type="text" id="msgText" onkeydown="if(event.key==='Enter') sendMsg()" placeholder="Type a message..." class="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-1.5 text-xs text-slate-200">
          <button onclick="sendMsg()" class="bg-emerald-600 font-bold px-3 py-1.5 rounded text-xs text-slate-950">Send</button>
        </div>
      </section>
    </div>

    <div id="view-broadcast" class="hidden h-full overflow-y-auto custom-scroll p-4 space-y-4">
      <div class="bg-[#0f172a] border border-slate-800 rounded-xl p-4">
        <h2 class="text-xs font-bold text-slate-200 uppercase mb-3">WhatsApp Broadcast</h2>
        <p class="text-xs text-slate-400">Broadcast dashboard ready.</p>
      </div>
    </div>
  </main>

  <script>
    var leads = [], curPhone = null, aiOn = true;

    window.addEventListener("DOMContentLoaded", function() {
      loadLeads();
      setInterval(loadLeads, 8000);
      if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(function(e){});
    });

    function toggleGeminiAiState() {
      aiOn = !aiOn;
      fetch('/api/toggle-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: aiOn })
      });
      document.getElementById('txtAiStatus').innerText = aiOn ? 'AI: ON' : 'AI: OFF';
      document.getElementById('btnAiToggle').className = aiOn 
        ? 'text-[11px] bg-emerald-950/60 text-emerald-400 px-2.5 py-1.5 rounded border border-emerald-800/50 flex items-center gap-1.5' 
        : 'text-[11px] bg-red-950/60 text-red-400 px-2.5 py-1.5 rounded border border-red-800/50 flex items-center gap-1.5';
    }

    function loadLeads() {
      fetch('/api/leads').then(function(r){ return r.json(); }).then(function(data){
        leads = data;
        renderLeads();
      }).catch(function(e){});
    }

    function renderLeads() {
      var html = '';
      for (var i = 0; i < leads.length; i++) {
        var l = leads[i];
        html += '<div onclick="openChat(\\'' + l.phone + '\\', \\'' + (l.name || 'Customer') + '\\')" class="p-2 rounded bg-slate-900/60 border border-slate-800 cursor-pointer mb-1">' +
          '<div class="text-xs font-semibold text-slate-200">' + (l.name || 'Customer') + '</div>' +
          '<div class="text-[10px] text-emerald-400 font-mono">+' + l.phone + '</div>' +
          '<div class="text-[10px] text-slate-400 truncate">' + (l.last_message || '') + '</div>' +
        '</div>';
      }
      document.getElementById('leadsList').innerHTML = html || '<p class="text-xs text-slate-500 text-center p-3">No leads yet</p>';
    }

    function filterLeads() {
      var q = document.getElementById('leadSearch').value.toLowerCase();
      var filtered = leads.filter(function(l){ return (l.name || '').toLowerCase().indexOf(q) !== -1 || (l.phone || '').indexOf(q) !== -1; });
      var html = '';
      for (var i = 0; i < filtered.length; i++) {
        var l = filtered[i];
        html += '<div onclick="openChat(\\'' + l.phone + '\\', \\'' + (l.name || 'Customer') + '\\')" class="p-2 rounded bg-slate-900/60 border border-slate-800 cursor-pointer mb-1">' +
          '<div class="text-xs font-semibold text-slate-200">' + (l.name || 'Customer') + '</div>' +
          '<div class="text-[10px] text-emerald-400 font-mono">+' + l.phone + '</div>' +
        '</div>';
      }
      document.getElementById('leadsList').innerHTML = html;
    }

    function openChat(ph, nm) {
      curPhone = ph;
      document.getElementById('activeName').innerText = nm || 'Customer';
      document.getElementById('activePhone').innerText = '+' + ph;
      document.getElementById('chatSection').classList.remove('hidden');
      if (window.innerWidth < 768) document.getElementById('leadsSidebar').classList.add('hidden');
      loadMessages();
    }

    function mobileBack() {
      document.getElementById('leadsSidebar').classList.remove('hidden');
      document.getElementById('chatSection').classList.add('hidden');
    }

    function loadMessages() {
      if (!curPhone) return;
      fetch('/api/messages?phone=' + curPhone).then(function(r){ return r.json(); }).then(function(msgs){
        var html = '';
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          var isAgent = m.sender === 'agent';
          html += '<div class="flex ' + (isAgent ? 'justify-end' : 'justify-start') + ' mb-2">' +
            '<div class="max-w-[80%] rounded px-3 py-1.5 text-xs ' + (isAgent ? 'bg-emerald-700 text-white' : 'bg-slate-800 text-slate-200') + '">' +
              m.text +
            '</div>' +
          '</div>';
        }
        var box = document.getElementById('chatBox');
        box.innerHTML = html || '<p class="text-xs text-slate-500 text-center mt-10">No messages yet.</p>';
        box.scrollTop = box.scrollHeight;
      }).catch(function(e){});
    }

    function sendMsg() {
      var input = document.getElementById('msgText');
      var val = input.value.trim();
      if (!val || !curPhone) return;
      input.value = '';
      fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: curPhone, text: val })
      }).then(function(){
        loadMessages();
        loadLeads();
      });
    }

    function uploadImage(e) {
      var file = e.target.files[0];
      if (!file || !curPhone) return alert("Pehle lead select karein.");
      var caption = prompt("Caption (optional):") || "";
      var reader = new FileReader();
      reader.onload = function() {
        fetch('/api/send-media', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: curPhone, mediaUrl: reader.result, caption: caption })
        }).then(function(r){ return r.json(); }).then(function(d){
          if (d.success) { alert("Sent!"); loadMessages(); }
          else { alert("Error: " + JSON.stringify(d)); }
        });
      };
      reader.readAsDataURL(file);
    }

    function switchMainTab(t) {
      document.getElementById('view-livechat').classList.toggle('hidden', t !== 'livechat');
      document.getElementById('view-broadcast').classList.toggle('hidden', t !== 'broadcast');
      document.getElementById('tab-livechat').className = t === 'livechat' ? 'px-3 py-2 text-xs font-medium text-emerald-400 border-b-2 border-emerald-500' : 'px-3 py-2 text-xs font-medium text-slate-400 border-b-2 border-transparent';
      document.getElementById('tab-broadcast').className = t === 'broadcast' ? 'px-3 py-2 text-xs font-medium text-emerald-400 border-b-2 border-emerald-500' : 'px-3 py-2 text-xs font-medium text-slate-400 border-b-2 border-transparent';
    }
  <\/script>
</body>
</html>\`;
