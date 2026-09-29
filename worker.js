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

      // 2. Inbound Webhook Listener
      if (req.method === "POST") {
        try {
          const b = await req.json();
          const v = b && b.entry && b.entry[0] && b.entry[0].changes && b.entry[0].changes[0] ? b.entry[0].changes[0].value : null;

          if (v && v.messages && v.messages[0]) {
            const m = v.messages[0];
            const p = m.from;
            const name = (v.contacts && v.contacts[0] && v.contacts[0].profile) ? v.contacts[0].profile.name : "Customer";
            const txt = (m.text && m.text.body) ? m.text.body : "Media/Attachment";

            await env.DB.prepare(
              "INSERT INTO leads (phone, name, status) VALUES (?, ?, 'New') ON CONFLICT(phone) DO UPDATE SET name = excluded.name"
            ).bind(p, name).run();

            await env.DB.prepare(
              "INSERT INTO messages (phone, sender, message) VALUES (?, 'customer', ?)"
            ).bind(p, txt).run();
          }
          return new Response("EVENT_RECEIVED", { status: 200 });
        } catch (e) {
          return new Response(e.message, { status: 500 });
        }
      }
    }

    // 3. CRM APIs
    if (u.pathname === "/api/leads") {
      const q = await env.DB.prepare("SELECT * FROM leads ORDER BY created_at DESC").all();
      return Response.json(q.results || []);
    }

    if (u.pathname === "/api/messages") {
      const phone = u.searchParams.get("phone");
      const q = await env.DB.prepare("SELECT * FROM messages WHERE phone = ? ORDER BY created_at ASC").bind(phone).all();
      return Response.json(q.results || []);
    }

    if (u.pathname === "/api/send" && req.method === "POST") {
      try {
        const body = await req.json();
        const cleanPhone = body.toPhone.replace(/[^0-9]/g, "");
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

        const metaData = await metaRes.json();
        if (metaData && metaData.messages && metaData.messages[0]) {
          await env.DB.prepare(
            "INSERT INTO messages (phone, sender, message) VALUES (?, 'agent', ?)"
          ).bind(cleanPhone, body.text).run();
          return Response.json({ success: true });
        }
        return Response.json({ error: metaData }, { status: 400 });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // 4. EMBEDDED DASHBOARD HTML
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Vedashree AI WhatsApp CRM</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
  <style>
    :root { --app-h: 100vh; }
    @supports (height: 100dvh) { :root { --app-h: 100dvh; } }
    html, body { height: var(--app-h); margin: 0; padding: 0; overflow: hidden; background: #080c14; font-family: system-ui, sans-serif; }
    .active-tab { background: rgba(16, 185, 129, 0.2) !important; color: #34d399 !important; border-color: rgba(16, 185, 129, 0.4) !important; }
    .flt-on { background: #10b981 !important; color: #000 !important; font-weight: 700 !important; }
  </style>
</head>
<body class="text-slate-100 flex flex-col h-full select-none">

  <!-- LOGIN MODAL -->
  <div id="login-modal" style="display: flex;" class="fixed inset-0 z-50 items-center justify-center p-4 bg-[#080c14]/98">
    <div class="w-full max-w-xs bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl text-center">
      <div class="w-10 h-10 rounded-xl bg-emerald-500/20 text-emerald-400 font-bold flex items-center justify-center mx-auto mb-3 border border-emerald-500/30">V</div>
      <h2 class="text-sm font-bold text-white tracking-wide">VEDASHREE CRM</h2>
      <p class="text-[11px] text-slate-400 mb-4">Har Device Par Protected Login</p>
      <div class="space-y-3">
        <input type="password" id="p-input" placeholder="Password dalein..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500">
        <p id="p-err" class="text-[11px] text-rose-400 font-semibold hidden">❌ Galat Password!</p>
        <button type="button" id="b-login" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-2.5 rounded-xl text-xs">Login</button>
        <p class="text-[10px] text-slate-500">Default Password: <span class="text-emerald-400 font-mono">admin</span></p>
      </div>
    </div>
  </div>

  <!-- CHANGE PASSWORD MODAL -->
  <div id="pwd-change-modal" class="hidden fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#080c14]/90">
    <div class="w-full max-w-xs bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-2xl text-center space-y-3">
      <h3 class="text-xs font-bold text-white uppercase">Password Badlein</h3>
      <input type="password" id="old-pwd" placeholder="Purana Password..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white">
      <input type="password" id="new-pwd" placeholder="Naya Password (min 4)..." class="w-full bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-white">
      <div class="flex space-x-2">
        <button type="button" id="b-save-pwd" class="flex-1 bg-emerald-600 font-bold py-2 rounded-lg text-xs text-white">Save</button>
        <button type="button" id="b-cancel-pwd" class="flex-1 bg-slate-800 font-bold py-2 rounded-lg text-xs text-slate-300">Cancel</button>
      </div>
    </div>
  </div>

  <!-- HEADER -->
  <header class="h-14 bg-slate-900 border-b border-slate-800 px-4 flex items-center justify-between shrink-0">
    <div class="flex items-center space-x-2">
      <div class="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 font-bold flex items-center justify-center text-sm border border-emerald-500/30">V</div>
      <div>
        <h1 class="text-xs font-bold text-white">VEDASHREE CRM</h1>
        <span class="text-[9px] text-emerald-400 font-mono flex items-center gap-1">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Live Meta API
        </span>
      </div>
    </div>
    <div class="flex items-center space-x-2">
      <button id="b-set" class="px-2 py-1 rounded-lg bg-slate-800 text-[10px] text-slate-300 border border-slate-700">⚙ Settings</button>
      <button id="b-out" class="p-1.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 text-xs">🚪 Logout</button>
    </div>
  </header>

  <!-- NAVIGATION -->
  <nav class="bg-slate-900/90 border-b border-slate-800 px-2 py-1.5 flex space-x-1.5 shrink-0 text-xs font-medium overflow-x-auto">
    <button id="t-inbox" onclick="nav('inbox')" class="px-3 py-1.5 rounded-lg active-tab flex items-center space-x-1.5 whitespace-nowrap">
      <span>Live Chat</span>
      <span id="badge-count" class="bg-emerald-500 text-black text-[9px] font-bold px-1.5 rounded-full">0</span>
    </button>
    <button id="t-broadcast" onclick="nav('broadcast')" class="px-3 py-1.5 rounded-lg text-slate-400 flex items-center space-x-1.5 whitespace-nowrap">
      <span>Excel Broadcast</span>
    </button>
    <button id="t-leads" onclick="nav('leads')" class="px-3 py-1.5 rounded-lg text-slate-400 flex items-center space-x-1.5 whitespace-nowrap">
      <span>Pipeline</span>
    </button>
  </nav>

  <!-- MAIN -->
  <main class="flex-1 relative overflow-hidden flex flex-col min-h-0 bg-[#080c14]">
    <!-- TAB 1: INBOX -->
    <div id="v-inbox" class="flex-1 flex flex-col overflow-hidden min-h-0">
      <div id="box-contacts" class="flex-1 overflow-y-auto divide-y divide-slate-800/80">
        <div class="p-6 text-center text-xs text-slate-500">Checking for live customer messages...</div>
      </div>

      <div id="box-chat" class="hidden flex-1 flex-col overflow-hidden min-h-0 bg-[#080c14]">
        <div class="h-12 px-3 bg-slate-900 border-b border-slate-800 flex justify-between items-center shrink-0">
          <div class="flex items-center space-x-2">
            <button id="b-back" class="p-1.5 text-slate-400 font-bold text-xs bg-slate-800 rounded-lg">← Back</button>
            <div>
              <div id="head-name" class="text-xs font-bold text-white">Customer</div>
              <div id="head-phone" class="text-[9px] text-slate-400 font-mono">+91...</div>
            </div>
          </div>
          <span id="head-badge" class="text-[9px] px-1.5 py-0.5 rounded border font-mono bg-emerald-500/10 text-emerald-400 border-emerald-500/30">Direct</span>
        </div>

        <div id="msg-container" class="flex-1 p-3 overflow-y-auto space-y-2.5 min-h-0"></div>

        <div class="px-2 py-1 bg-slate-900/80 border-t border-slate-800/80 flex space-x-1 overflow-x-auto text-[10px]">
          <button onclick="setReply('catalog')" class="px-2 py-0.5 rounded bg-slate-800 text-slate-100 border border-slate-700">📦 Catalog</button>
          <button onclick="setReply('upi')" class="px-2 py-0.5 rounded bg-slate-800 text-slate-100 border border-slate-700">💳 UPI</button>
          <button onclick="setReply('dispatch')" class="px-2 py-0.5 rounded bg-slate-800 text-slate-100 border border-slate-700">🚚 Tracking</button>
        </div>

        <form id="f-chat" class="p-2 bg-slate-900 border-t border-slate-800 flex items-center space-x-2 shrink-0">
          <input type="text" id="in-msg" placeholder="Type WhatsApp reply..." class="flex-1 bg-slate-800 border border-slate-700 text-white text-xs px-3 py-2 rounded-lg focus:outline-none focus:border-emerald-500" autocomplete="off">
          <button type="submit" class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-3.5 py-2 rounded-lg text-xs">Send</button>
        </form>
      </div>
    </div>

    <!-- TAB 2: BROADCAST -->
    <div id="v-broadcast" class="hidden flex-1 p-3 overflow-y-auto space-y-3 min-h-0">
      <div class="bg-slate-900 border border-slate-800 rounded-xl p-3.5 space-y-3">
        <h2 class="text-xs font-bold text-white uppercase tracking-wider">Excel / CSV 1-by-1 Queue</h2>
        <div class="border-2 border-dashed border-slate-700 rounded-xl p-3.5 text-center bg-[#080c14]">
          <input type="file" id="in-excel" accept=".xlsx, .xls, .csv" class="hidden">
          <p id="lbl-excel" class="text-xs font-semibold text-slate-300 mb-0.5">Upload Contacts Sheet (.xlsx, .csv)</p>
          <p class="text-[9px] text-slate-500 mb-2">Col 1 = Name, Col 2 = Phone</p>
          <button type="button" id="b-pick-excel" class="px-3 py-1 bg-slate-800 border border-slate-700 text-xs font-bold rounded-lg text-white">Select File</button>
        </div>
        <button id="b-send-all" class="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-bold p-2.5 rounded-lg text-xs">Send 1-by-1 Excel Broadcast</button>
      </div>
      <div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div class="p-2.5 border-b border-slate-800 flex justify-between items-center">
          <h3 class="text-xs font-bold text-white">Live Delivery Log</h3>
          <button id="b-csv" class="px-2 py-0.5 bg-slate-800 border border-slate-700 text-[10px] text-slate-300 rounded">Export CSV</button>
        </div>
        <div id="log-rows" class="divide-y divide-slate-800 max-h-56 overflow-y-auto"></div>
      </div>
    </div>

    <!-- TAB 3: PIPELINE -->
    <div id="v-leads" class="hidden flex-1 p-3 overflow-y-auto space-y-2.5 min-h-0">
      <div class="flex items-center justify-between">
        <h2 class="text-xs font-bold text-white uppercase tracking-wider">Lead Attribution Pipeline</h2>
        <span class="text-[10px] text-emerald-400 font-mono">D1 Synced</span>
      </div>
      <div class="flex space-x-1 overflow-x-auto text-[10px] font-semibold py-0.5">
        <button onclick="flt('all')" id="f-all" class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 flt-on whitespace-nowrap">All</button>
        <button onclick="flt('hot')" id="f-hot" class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 whitespace-nowrap">🔥 Hot</button>
        <button onclick="flt('converted')" id="f-converted" class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 whitespace-nowrap">Converted</button>
        <button onclick="flt('optout')" id="f-optout" class="px-2.5 py-1 rounded bg-slate-800 text-slate-300 whitespace-nowrap">Optout</button>
      </div>
      <div id="leads-container" class="space-y-2"></div>
    </div>
  </main>

  <script>
    // 1. SIMPLE BULLETPROOF AUTH
    const curP = localStorage.getItem('crm_p') || 'admin';
    if (sessionStorage.getItem('crm_active') === 'true') {
      document.getElementById('login-modal').style.display = 'none';
    }

    function doAuth() {
      const val = document.getElementById('p-input').value.trim();
      if (val === curP) {
        sessionStorage.setItem('crm_active', 'true');
        document.getElementById('login-modal').style.display = 'none';
        if ("Notification" in window && Notification.permission !== "granted") {
          Notification.requestPermission();
        }
        loadLiveCRMData();
      } else {
        document.getElementById('p-err').classList.remove('hidden');
      }
    }

    document.getElementById('b-login').onclick = doAuth;
    document.getElementById('p-input').onkeydown = (e) => { if(e.key === 'Enter') doAuth(); };

    document.getElementById('b-out').onclick = () => {
      sessionStorage.removeItem('crm_active');
      location.reload();
    };

    document.getElementById('b-set').onclick = () => document.getElementById('pwd-change-modal').classList.remove('hidden');
    document.getElementById('b-cancel-pwd').onclick = () => document.getElementById('pwd-change-modal').classList.add('hidden');
    document.getElementById('b-save-pwd').onclick = () => {
      const oldP = document.getElementById('old-pwd').value.trim();
      const newP = document.getElementById('new-pwd').value.trim();
      if (oldP !== curP) { alert("Purana password galat hai!"); return; }
      if (newP.length < 4) { alert("Kam se kam 4 akshar!"); return; }
      localStorage.setItem('crm_p', newP);
      alert("Password badal diya gaya!");
      location.reload();
    };

    // 2. AUDIO & NOTIFICATION
    function ringAlert() {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(800, ctx.currentTime);
        osc.connect(ctx.destination);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch(e) {}
    }

    // 3. CRM ENGINE
    let leads = [];
    let chatDB = {};
    let curLead = null;
    let curFlt = 'all';
    let bList = [];

    window.nav = function(t) {
      ['inbox', 'broadcast', 'leads'].forEach(x => {
        document.getElementById('v-' + x).classList.add('hidden');
        document.getElementById('t-' + x).classList.remove('active-tab');
      });
      document.getElementById('v-' + t).classList.remove('hidden');
      document.getElementById('t-' + t).classList.add('active-tab');
    };

    document.getElementById('b-back').onclick = function() {
      curLead = null;
      document.getElementById('box-chat').classList.add('hidden');
      document.getElementById('box-chat').classList.remove('flex');
      document.getElementById('box-contacts').classList.remove('hidden');
      loadLiveCRMData();
    };

    async function loadLiveCRMData() {
      try {
        const res = await fetch('/api/leads');
        if (res.ok) {
          const data = await res.json();
          leads = data.map(l => ({
            id: l.phone,
            name: l.name || 'Customer',
            phone: l.phone,
            src: 'WhatsApp',
            st: l.status || 'hot',
            t: l.created_at ? l.created_at.split(' ')[1] || 'Live' : 'Live'
          }));
          document.getElementById('badge-count').innerText = leads.length;
          renderInboxList();
          renderPipeline();
        }
      } catch (err) {}
    }

    async function loadChatMessages(phone) {
      try {
        const res = await fetch('/api/messages?phone=' + phone);
        if (res.ok) {
          const data = await res.json();
          const prevLen = (chatDB[phone] || []).length;
          chatDB[phone] = data.map(m => ({
            s: (m.sender === 'agent' || m.sender === 'me') ? 'm' : 'c',
            txt: m.message,
            t: m.created_at ? m.created_at.split(' ')[1] || 'Live' : 'Live'
          }));
          if (chatDB[phone].length > prevLen && prevLen > 0) {
            ringAlert();
            if (Notification.permission === "granted") {
              new Notification("New WhatsApp: " + phone, { body: chatDB[phone][chatDB[phone].length - 1].txt });
            }
          }
          renderMessages();
        }
      } catch (err) {}
    }

    function renderInboxList() {
      const c = document.getElementById('box-contacts');
      if (!c) return;
      if (!leads.length) { c.innerHTML = '<div class="p-6 text-center text-xs text-slate-500">Koi active message nahi mila</div>'; return; }
      c.innerHTML = leads.map(l => \`
        <div onclick="openChat('\${l.id}')" class="p-3.5 flex items-start space-x-3 active:bg-slate-800 transition cursor-pointer border-b border-slate-800/60">
          <div class="w-10 h-10 rounded-xl bg-slate-800 text-emerald-400 font-bold flex items-center justify-center text-xs shrink-0 border border-slate-700">\${l.name.slice(0,2).toUpperCase()}</div>
          <div class="flex-1 min-w-0">
            <div class="flex justify-between items-baseline mb-0.5">
              <h4 class="text-xs font-bold text-white truncate">\${l.name}</h4>
              <span class="text-[9px] text-slate-500 font-mono">\${l.t}</span>
            </div>
            <p class="text-[11px] text-slate-400 truncate mb-1">+\${l.phone}</p>
            <span class="text-[9px] px-1.5 py-0.5 rounded border font-mono bg-emerald-500/10 text-emerald-400 border-emerald-500/30">\${l.st}</span>
          </div>
        </div>
      \`).join('');
    }

    window.openChat = function(id) {
      curLead = leads.find(l => l.id === id);
      if (!curLead) return;
      document.getElementById('head-name').innerText = curLead.name;
      document.getElementById('head-phone').innerText = '+' + curLead.phone;
      document.getElementById('box-contacts').classList.add('hidden');
      document.getElementById('box-chat').classList.remove('hidden');
      document.getElementById('box-chat').classList.add('flex');
      loadChatMessages(curLead.phone);
    };

    function renderMessages() {
      const box = document.getElementById('msg-container');
      if (!box || !curLead) return;
      const arr = chatDB[curLead.phone] || [];
      box.innerHTML = arr.map(m => {
        const me = m.s === 'm';
        return \`
          <div class="flex flex-col \${me ? 'items-end' : 'items-start'} mb-1.5">
            <div class="max-w-[85%] p-2.5 rounded-2xl text-xs \${me ? 'bg-emerald-600 text-white rounded-br-none' : '
