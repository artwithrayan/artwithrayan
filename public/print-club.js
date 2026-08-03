const notice = document.getElementById("clubCheckoutNotice");
const joinButtons = [document.getElementById("joinPrintClub"), document.getElementById("joinPrintClubBottom")].filter(Boolean);

document.getElementById("year").textContent = new Date().getFullYear();

async function startPrintClubCheckout() {
  joinButtons.forEach((button) => {
    button.disabled = true;
    button.textContent = "Opening Stripe…";
  });
  notice.className = "notice";
  notice.textContent = "Opening secure subscription checkout…";

  try {
    const response = await fetch("/api/print-club/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Checkout is temporarily unavailable.");
    window.location.href = data.checkoutUrl;
  } catch (error) {
    notice.className = "notice error";
    notice.textContent = error.message;
    joinButtons.forEach((button, index) => {
      button.disabled = false;
      button.textContent = index === 0 ? "Join the club" : "Join for $9 a month";
    });
  }
}

joinButtons.forEach((button) => button.addEventListener("click", startPrintClubCheckout));
