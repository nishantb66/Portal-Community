document.addEventListener("DOMContentLoaded", () => {
  const emailForm = document.getElementById("email-form");
  const otpForm = document.getElementById("otp-form");
  const resetForm = document.getElementById("reset-form");
  const successMsg = document.getElementById("success-msg");

  const emailInput = document.getElementById("fp-email");
  const otpInput = document.getElementById("fp-otp");
  const userSpan = document.getElementById("fp-username");
  const countdownEl = document.getElementById("countdown");
  const newPass = document.getElementById("fp-newpass");
  const confPass = document.getElementById("fp-confpass");

  let expiresAt = null;
  let timerId = null;

  function startCountdown(iso) {
    expiresAt = new Date(iso).getTime();
    if (timerId) clearInterval(timerId);
    timerId = setInterval(() => {
      const diff = expiresAt - Date.now();
      if (diff <= 0) {
        clearInterval(timerId);
        alert("Code expired. Redirecting to chat.");
        return (window.location.href = "/privateDM.html");
      }
      const mins = Math.floor(diff / 60000);
      const secs = Math.floor((diff % 60000) / 1000);
      countdownEl.textContent = `${String(mins).padStart(2, "0")}:${String(
        secs
      ).padStart(2, "0")}`;
    }, 500);
  }

  // 1) Send OTP
  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim();
    document.getElementById("email-error").classList.add("hidden");

    try {
      const res = await fetch("/password/forgot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      // show OTP form
      userSpan.textContent = j.username;
      emailForm.classList.add("hidden");
      otpForm.classList.remove("hidden");
      startCountdown(j.expires);
    } catch (err) {
      const p = document.getElementById("email-error");
      p.textContent = err.message;
      p.classList.remove("hidden");
    }
  });

  // 2) Verify OTP
  otpForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      email: emailInput.value.trim(),
      otp: otpInput.value.trim(),
    };
    document.getElementById("otp-error").classList.add("hidden");

    try {
      const res = await fetch("/password/verify-reset-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      // show Reset form
      otpForm.classList.add("hidden");
      resetForm.classList.remove("hidden");
    } catch (err) {
      const p = document.getElementById("otp-error");
      p.textContent = err.message;
      p.classList.remove("hidden");
    }
  });

  // 3) Reset password
  resetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const p1 = newPass.value,
      p2 = confPass.value;
    const errP = document.getElementById("reset-error");
    errP.classList.add("hidden");

    if (p1 !== p2) {
      errP.textContent = "Passwords do not match";
      return errP.classList.remove("hidden");
    }

    try {
      const res = await fetch("/password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailInput.value.trim(),
          otp: otpInput.value.trim(),
          password: p1,
        }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.message);

      // success → notify + redirect
      resetForm.classList.add("hidden");
      successMsg.classList.remove("hidden");
      setTimeout(() => (window.location.href = "/privateDM.html"), 2000);
    } catch (err) {
      errP.textContent = err.message;
      errP.classList.remove("hidden");
    }
  });
});
