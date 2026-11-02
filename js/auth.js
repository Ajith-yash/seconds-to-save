/**
 * Smart Ambulance Alert and Traffic Clearance System
 * Authentication Controller (Receiver Registration/Verification/Login & Authorised Driver Login)
 */

(function () {
  const $ = id => document.getElementById(id);
  const SA = window.SmartAmbulance;

  let currentRole = "receiver"; // 'receiver' | 'driver'
  let receiverMode = "login";   // 'login' | 'register' | 'verify'
  let pendingVerificationEmail = "";
  let pendingAccountToken = "";

  function setFeedback(message, type = "error") {
    const box = $("authFeedback");
    if (!box) return;
    if (!message) {
      box.className = "auth-feedback";
      box.textContent = "";
      box.style.display = "none";
      return;
    }
    box.className = `auth-feedback ${type}`;
    box.textContent = message;
    box.style.display = "block";
  }

  function updateAuthUI() {
    setFeedback("");
    const tabReceiver = $("tabReceiver");
    const tabDriver = $("tabDriver");
    const receiverSection = $("receiverAuthSection");
    const driverSection = $("driverAuthSection");
    const cardTitle = $("authCardTitle");
    const cardSubtitle = $("authCardSubtitle");

    if (currentRole === "receiver") {
      tabReceiver?.classList.add("active");
      tabDriver?.classList.remove("active");
      if (receiverSection) receiverSection.style.display = "block";
      if (driverSection) driverSection.style.display = "none";

      const loginForm = $("receiverLoginForm");
      const registerForm = $("receiverRegisterForm");
      const verifyForm = $("receiverVerifyForm");

      if (receiverMode === "login") {
        if (cardTitle) cardTitle.textContent = "Welcome Back";
        if (cardSubtitle) cardSubtitle.textContent = "Sign in to your Receiver account to receive live ambulance alerts";
        if (loginForm) loginForm.style.display = "grid";
        if (registerForm) registerForm.style.display = "none";
        if (verifyForm) verifyForm.style.display = "none";
      } else if (receiverMode === "register") {
        if (cardTitle) cardTitle.textContent = "Create Receiver Account";
        if (cardSubtitle) cardSubtitle.textContent = "Register with email verification for route-based proximity alerts";
        if (loginForm) loginForm.style.display = "none";
        if (registerForm) registerForm.style.display = "grid";
        if (verifyForm) verifyForm.style.display = "none";
      } else if (receiverMode === "verify") {
        if (cardTitle) cardTitle.textContent = "Verify Your Email";
        if (cardSubtitle) cardSubtitle.textContent = `Enter the 6-digit verification code for ${pendingVerificationEmail}`;
        if (loginForm) loginForm.style.display = "none";
        if (registerForm) registerForm.style.display = "none";
        if (verifyForm) verifyForm.style.display = "grid";
      }
    } else {
      tabDriver?.classList.add("active");
      tabReceiver?.classList.remove("active");
      if (receiverSection) receiverSection.style.display = "none";
      if (driverSection) driverSection.style.display = "block";
      if (cardTitle) cardTitle.textContent = "Ambulance Driver Sign In";
      if (cardSubtitle) cardSubtitle.textContent = "Sign in with your authorized driver account";
    }
  }

  document.addEventListener("DOMContentLoaded", async () => {
    // Check if user already has an active verified session
    const activeUser = SA.getCurrentUser();
    if (activeUser && SA.getSessionToken()) {
      const verified = await SA.verifyAuthenticatedRole(activeUser.role);
      if (verified) {
        const banner = $("activeSessionBanner");
        if (banner) {
          banner.style.display = "flex";
          const nameSpan = $("activeSessionName");
          if (nameSpan) {
            nameSpan.textContent = verified.role === "driver"
              ? `${verified.driverName} (${verified.ambulanceId})`
              : `${verified.fullName} (${verified.email})`;
          }
          const dashLink = $("activeSessionLink");
          if (dashLink) {
            dashLink.href = verified.role === "driver" ? "driver.html" : "receiver.html";
          }
        }
      }
    }

    // Pre-fill remembered emails (never passwords)
    const remReceiverEmail = SA.getRememberedEmail("receiver");
    if (remReceiverEmail && $("rcvLoginEmail")) {
      $("rcvLoginEmail").value = remReceiverEmail;
      if ($("rcvRememberEmail")) $("rcvRememberEmail").checked = true;
    }

    const remDriverEmail = SA.getRememberedEmail("driver");
    if (remDriverEmail && $("drvLoginEmail")) {
      $("drvLoginEmail").value = remDriverEmail;
    }

    // Role Tabs
    $("tabReceiver")?.addEventListener("click", () => {
      currentRole = "receiver";
      updateAuthUI();
    });

    $("tabDriver")?.addEventListener("click", () => {
      currentRole = "driver";
      updateAuthUI();
    });

    // Receiver Mode Switches
    $("switchToRegisterBtn")?.addEventListener("click", () => {
      receiverMode = "register";
      updateAuthUI();
    });

    $("switchToLoginBtn")?.addEventListener("click", () => {
      receiverMode = "login";
      updateAuthUI();
    });

    $("backToRegisterBtn")?.addEventListener("click", () => {
      receiverMode = "register";
      updateAuthUI();
    });

    // 1. Receiver Registration Submit
    $("receiverRegisterForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      setFeedback("");
      const fullName = $("rcvRegName")?.value.trim();
      const email = $("rcvRegEmail")?.value.trim().toLowerCase();
      const phone = $("rcvRegPhone")?.value.trim();
      const password = $("rcvRegPassword")?.value;

      const submitBtn = $("rcvRegSubmitBtn");
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await SA.callApi("register-receiver", { fullName, email, phone, password }, "POST");
        pendingVerificationEmail = res.email;
        pendingAccountToken = res.pendingAccountToken;
        if ($("verifyEmailDisplay")) $("verifyEmailDisplay").value = pendingVerificationEmail;
        receiverMode = "verify";
        updateAuthUI();

        if (res.verificationCodePreview) {
          setFeedback(
            `Email verification code generated: ${res.verificationCodePreview}. Enter this 6-digit code below to activate your Receiver account.`,
            "info"
          );
        } else {
          setFeedback(res.message || "Verification code sent to your email.", "info");
        }
      } catch (err) {
        setFeedback(err.message || "Registration failed.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // 2. Receiver Email Verification Submit
    $("receiverVerifyForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      setFeedback("");
      const code = $("rcvVerifyCode")?.value.trim();
      const submitBtn = $("rcvVerifySubmitBtn");
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await SA.callApi("verify-email", {
          email: pendingVerificationEmail,
          code,
          pendingAccountToken
        }, "POST");

        // Save encrypted server-signed account certificate (never stores password)
        SA.saveVerifiedAccountCert(res.user.email, res.verifiedAccountToken);
        SA.setRememberedEmail("receiver", res.user.email);
        SA.setSession(res.sessionToken, res.user);

        setFeedback("Email verified! Redirecting to Receiver Dashboard…", "success");
        setTimeout(() => {
          window.location.href = "receiver.html";
        }, 600);
      } catch (err) {
        setFeedback(err.message || "Verification failed.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // 3. Receiver Login Submit
    $("receiverLoginForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      setFeedback("");
      const email = $("rcvLoginEmail")?.value.trim().toLowerCase();
      const password = $("rcvLoginPassword")?.value;
      const remember = $("rcvRememberEmail")?.checked;

      const verifiedAccountToken = SA.getVerifiedAccountCert(email);
      const submitBtn = $("rcvLoginSubmitBtn");
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await SA.callApi("login-receiver", {
          email,
          password,
          verifiedAccountToken
        }, "POST");

        if (remember) {
          SA.setRememberedEmail("receiver", email);
        } else {
          SA.setRememberedEmail("receiver", "");
        }

        SA.setSession(res.sessionToken, res.user);
        setFeedback("Signed in! Redirecting to Receiver Dashboard…", "success");
        setTimeout(() => {
          window.location.href = "receiver.html";
        }, 500);
      } catch (err) {
        setFeedback(err.message || "Receiver sign-in failed.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    // 4. Ambulance Driver Login Submit
    $("driverLoginForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      setFeedback("");
      const email = $("drvLoginEmail")?.value.trim().toLowerCase();
      const password = $("drvLoginPassword")?.value;
      const driverName = $("drvName")?.value.trim();


      const submitBtn = $("drvLoginSubmitBtn");
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await SA.callApi("login-driver", {
          email,
          password,
          driverName
        }, "POST");

        SA.setRememberedEmail("driver", email);
        SA.setSession(res.sessionToken, res.user);
        setFeedback("Driver authorised! Launching Ambulance Driver Console…", "success");
        setTimeout(() => {
          window.location.href = "driver.html";
        }, 500);
      } catch (err) {
        setFeedback(err.message || "Driver authentication failed.", "error");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });

    updateAuthUI();
  });
})();
