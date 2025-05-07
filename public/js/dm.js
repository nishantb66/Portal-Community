document.addEventListener("DOMContentLoaded", () => {
  const loginForm = document.getElementById("login-form");
  const signupForm = document.getElementById("signup-form");
  const otpForm = document.getElementById("otp-form");
  const authContainer = document.getElementById("auth-container");
  const chatContainer = document.getElementById("chat-container");
  let tempSignup = {};

  // toggle views
  document.getElementById("show-signup").onclick = (e) => {
    e.preventDefault();
    loginForm.classList.add("hidden");
    signupForm.classList.remove("hidden");
  };
  document.getElementById("show-login").onclick = (e) => {
    e.preventDefault();
    signupForm.classList.add("hidden");
    loginForm.classList.remove("hidden");
  };

  // SIGNUP → send OTP
  document.getElementById("signup-btn").onclick = async () => {
    const email = document.getElementById("signup-email").value;
    const user = document.getElementById("signup-username").value;
    const pass = document.getElementById("signup-password").value;
    const err = document.getElementById("signup-error");
    err.textContent = "";
    try {
      const res = await fetch("/dm/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, username: user, password: pass }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.message);
      tempSignup = { email, username: user, password: pass };
      signupForm.classList.add("hidden");
      otpForm.classList.remove("hidden");
    } catch (e) {
      err.textContent = e.message;
    }
  };

  // VERIFY OTP → create user + JWT
  document.getElementById("verify-otp-btn").onclick = async () => {
    const otp = document.getElementById("otp-input").value;
    const err = document.getElementById("otp-error");
    err.textContent = "";
    try {
      const res = await fetch("/dm/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...tempSignup, otp }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.message);
      onLoginSuccess(j.token, j.username, j.email);
    } catch (e) {
      err.textContent = e.message;
    }
  };

  // LOGIN
  document.getElementById("login-btn").onclick = async () => {
    const user = document.getElementById("login-username").value;
    const pass = document.getElementById("login-password").value;
    const err = document.getElementById("login-error");
    err.textContent = "";
    try {
      const res = await fetch("/dm/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      const j = await res.json();
      if (!res.ok) throw Error(j.message);
      onLoginSuccess(j.token, j.username, j.email);
    } catch (e) {
      err.textContent = e.message;
    }
  };

  function onLoginSuccess(token, username, email) {
    // 1) store the whole payload
    localStorage.setItem("dmToken", token);
    localStorage.setItem("dmUsername", username);
    localStorage.setItem("dmEmail", email);

    // 2) swap views
    authContainer.classList.add("hidden");
    chatContainer.classList.remove("hidden");

    // 3) show name
    document.getElementById("user-display").textContent = username;

    // 4) init the chat
    initChat(token);
  }

  async function initChat(token) {
    // fetch user list
    const res = await fetch("/dm/users", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { users } = await res.json();
    const ul = document.getElementById("user-list");
    users.forEach((u) => {
      const li = document.createElement("li");
      li.textContent = u;
      li.className = "cursor-pointer p-2 rounded hover:bg-gray-100";
      li.onclick = () => loadHistory(u, token);
      ul.appendChild(li);
    });

    // connect Socket.io
    const socket = io("/dm", { auth: { token } });
    socket.on("connect_error", (e) => alert(e.message));
    socket.on("dm message", (msg) => {
      const current = document.getElementById("chat-with").textContent;
      if (msg.from === current || msg.to === current) appendMsg(msg);
    });
    window.dmSocket = socket;
  }

  let currentPeer = null;
  async function loadHistory(peer, token) {
    currentPeer = peer;
    document.getElementById("chat-with").textContent = peer;
    const res = await fetch(`/dm/history/${peer}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { messages } = await res.json();
    const msgEl = document.getElementById("dm-messages");
    msgEl.innerHTML = "";
    messages.forEach(appendMsg);
    document.getElementById("dm-send-btn").onclick = sendMsg;
  }

  function appendMsg(msg) {
    const li = document.createElement("li");
    const me = localStorage.getItem("dmUsername");
    li.textContent = `${msg.from}: ${msg.message}`;
    li.className = me === msg.from ? "text-right" : "";
    document.getElementById("dm-messages").appendChild(li);
  }

  function sendMsg() {
    const txt = document.getElementById("dm-input").value.trim();
    if (!txt || !currentPeer) return;
    window.dmSocket.emit("dm message", { to: currentPeer, message: txt });
    document.getElementById("dm-input").value = "";
  }

  // LOGOUT button
  document.getElementById("logout-btn").onclick = () => {
    // 1) clear storage
    localStorage.removeItem("dmToken");
    localStorage.removeItem("dmUsername");
    localStorage.removeItem("dmEmail");

    // 2) reset UI
    chatContainer.classList.add("hidden");
    authContainer.classList.remove("hidden");

    // show login form (hide others)
    loginForm.classList.remove("hidden");
    signupForm.classList.add("hidden");
    otpForm.classList.add("hidden");

    // 3) clear inputs & errors
    document.getElementById("login-username").value = "";
    document.getElementById("login-password").value = "";
    document.getElementById("login-error").textContent = "";
  };
});
