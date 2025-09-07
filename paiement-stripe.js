const stripe = Stripe("pk_live_xxxxxxpk_live_51RgYd9IWRH02GJbeI26kTmFzkNFPUc9asYk3qTVT2NrOqCUB3Y9DkhSOV6GP50tWbBcJscjYDSRiIT3DDC3MRtkC00gtwbJ9U4"); // ta clé publique live

document.getElementById('checkout').addEventListener('click', async () => {
  const body = {
    date: "2025-09-10",
    logement: "BLŌM",
    nuits: 2,
    prix: 150
  };

  try {
    const res = await fetch('livablom-stripe-production.up.railway.app', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    window.location.href = data.url; // Redirection vers Stripe
  } catch (err) {
    console.error(err);
    alert('Erreur création session Stripe');
  }
});
