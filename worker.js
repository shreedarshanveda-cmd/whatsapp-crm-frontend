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
          let fromPhone = String(message.from || "").trim();
          const textBody = message.text?.body || "";
          const customerName = contact?.profile?.name || fromPhone || "Customer";
          const timestamp = new Date().toISOString();

          // 1. Leads table me update/insert
          await env.whatsapp_crm_db.prepare(`
            INSERT INTO leads (phone, name, last_message, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(phone) DO UPDATE SET
              name = CASE WHEN excluded.name != excluded.phone THEN excluded.name ELSE leads.name END,
              last_message = excluded.last_message,
              updated_at = excluded.updated_at
          `).bind(fromPhone, customerName, textBody, timestamp).run();

          // 2. Messages table me insert
          await env.whatsapp_crm_db.prepare(`
            INSERT INTO messages (phone, text, direction, timestamp)
            VALUES (?, ?, 'inbound', ?)
          `).bind(fromPhone, textBody, timestamp).run();
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

    // 4. API: Get Chat Messages for a Phone Number
    if (request.method === "GET" && url.pathname === "/api/messages") {
      const phone = url.searchParams.get("phone");
      if (!phone) {
        return new Response(JSON.stringify([]), {
          headers: { "Content-Type": "application/json" }
        });
      }

      try {
        const { results } = await env.whatsapp_crm_db.prepare(`
          SELECT * FROM messages WHERE phone = ? ORDER BY id ASC
        `).bind(phone).all();
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

    // 5. API: Send Outbound Message (Meta Cloud API + D1 Save)
    if (request.method === "POST" && url.pathname === "/api/send") {
      try {
        const { phone, text } = await request.json();
        const timestamp = new Date().toISOString();

        // Meta WhatsApp Cloud API call
        await fetch("https://graph.facebook.com/v20.0/119627664023608/messages", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.WHATSAPP_TOKEN || ""}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: phone,
            type: "text",
            text: { body: text }
          })
        });

        // Outbound record D1 me insert karein
        await env.whatsapp_crm_db.prepare(`
          INSERT INTO messages (phone, text, direction, timestamp)
          VALUES (?, ?, 'outbound', ?)
        `).bind(phone, text, timestamp).run();

        // Leads table update karein
        await env.whatsapp_crm_db.prepare(`
          INSERT INTO leads (phone, name, last_message, updated_at)
          VALUES (?, 'Customer', ?, ?)
          ON CONFLICT(phone) DO UPDATE SET
            last_message = excluded.last_message,
            updated_at = excluded.updated_at
        `).bind(phone, text, timestamp).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // 6. Frontend CRM Dashboard UI (HTML / CSS / JS)
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Vedashree WhatsApp CRM</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    html, body { height: 100%; width: 100%; overflow: hidden; background: #0b141a; color: #e9edef; }
    body { display: flex; flex-direction: row; }
    #sidebar { width: 340px; min-width: 280px; max-width: 380px; border-right: 1px solid #202c33; display: flex; flex-direction: column; background: #111b21; height: 100vh; flex-shrink: 0; }
    .header { padding: 14px 16px; background: #202c33; font-weight: 600; font-size: 16px; display: flex; align-items: center; justify-content: space-between; height: 60px; min-height: 60px; }
    #lead-list { flex: 1; overflow-y: auto; overflow-x: hidden; }
    .lead-item { padding: 12px 16px; border-bottom: 1px solid #202c33; cursor: pointer; transition: background 0.2s; }
    .lead-item:hover, .lead-item.active { background: #2a3942; }
    .lead-name { font-weight: 600; font-size: 15px; color: #e9edef; }
    .lead-msg { font-size: 13px; color: #8696a0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 4px; }
    #chat-area { flex: 1; display: flex; flex-direction: column; background: #0b141a; height: 100vh; overflow: hidden; }
    #chat-messages { flex: 1; padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
    .msg { max-width: 75%; padding: 8px 12px; border-radius: 8px; font-size: 14px; line-height: 1.4; word-wrap: break-word; }
    .inbound { align-self: flex-start; background: #202c33; color: #e9edef; border-bottom-left-radius: 2px; }
    .outbound { align-self: flex-end; background: #005c4b; color: #e9edef; border-bottom-right-radius: 2px; }
    #input-box { padding: 10px 14px; background: #202c33; display: flex; gap: 10px; align-items: center; min-height: 60px; }
    #message-input { flex: 1; padding: 10px 14px; border-radius: 8px; border: none; outline: none; background: #2a3942; color: #fff; font-size: 14px; }
    #message-input:disabled { opacity: 0.5; }
    #send-btn { padding: 10px 18px; border-radius: 8px; border: none; background: #00a884; color: #fff; font-weight: 600; cursor: pointer; }
    #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div id="sidebar">
    <div class="header">Chats</div>
    <div id="lead-list"></div>
  </div>
  <div id="chat-area">
    <div class="header" id="active-contact">Select a conversation</div>
    <div id="chat-messages"></div>
    <div id="input-box">
      <input type="text" id="message-input" placeholder="Type a message..." disabled>
      <button id="send-btn" disabled onclick="sendMessage()">Send</button>
    </div>
  </div>

  <script>
    let activePhone = null;

    async function fetchLeads() {
      try {
        const res = await fetch('/api/leads');
        const leads = await res.json();
        const list = document.getElementById('lead-list');
        list.innerHTML = '';
        if (!leads || leads.length === 0) {
          list.innerHTML = '<div style="padding:16px;color:#8696a0;font-size:13px;">No conversations yet</div>';
          return;
        }
        leads.forEach(lead => {
          const div = document.createElement('div');
          div.className = 'lead-item' + (activePhone === lead.phone ? ' active' : '');
          div.onclick = () => selectLead(lead.phone, lead.name);
          const title = lead.name && lead.name !== 'Customer' ? lead.name : lead.phone;
          div.innerHTML = '<div class="lead-name">' + title + '</div><div class="lead-msg">' + (lead.last_message || '') + '</div>';
          list.appendChild(div);
        });
      } catch(e) {}
    }

    async function selectLead(phone, name) {
      activePhone = phone;
      document.getElementById('active-contact').innerText = name || phone;
      document.getElementById('message-input').disabled = false;
      document.getElementById('send-btn').disabled = false;
      fetchMessages();
      fetchLeads();
    }

    async function fetchMessages() {
      if (!activePhone) return;
      try {
        const res = await fetch('/api/messages?phone=' + encodeURIComponent(activePhone));
        const msgs = await res.json();
        const container = document.getElementById('chat-messages');
        container.innerHTML = '';
        msgs.forEach(m => {
          const div = document.createElement('div');
          div.className = 'msg ' + (m.direction === 'outbound' ? 'outbound' : 'inbound');
          div.innerText = m.text;
          container.appendChild(div);
        });
        container.scrollTop = container.scrollHeight;
      } catch(e) {}
    }

    async function sendMessage() {
      const input = document.getElementById('message-input');
      const text = input.value.trim();
      if (!text || !activePhone) return;
      input.value = '';
      try {
        await fetch('/api/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: activePhone, text: text })
        });
        fetchMessages();
        fetchLeads();
      } catch(e) {}
    }

    document.getElementById('message-input').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') sendMessage();
    });

    fetchLeads();
    setInterval(() => {
      fetchLeads();
      if (activePhone) fetchMessages();
    }, 3000);
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};
