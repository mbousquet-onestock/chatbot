// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: "2026-10-01",
  // Application chargée dans une iframe OneStock : rendu côté client uniquement.
  ssr: false,
  devtools: { enabled: false },
  css: ["~/assets/css/onestock.css"],
  app: {
    head: {
      title: "Assistant commandes",
      meta: [{ name: "viewport", content: "width=device-width, initial-scale=1" }],
      link: [
        { rel: "preconnect", href: "https://fonts.googleapis.com" },
        { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" },
      ],
    },
  },
  components: [{ path: "~/components", pathPrefix: false }],
  nitro: {
    // Vercel (preset détecté automatiquement) : une réponse du chat enchaîne plusieurs appels au modèle et à l'API.
    vercel: { functions: { maxDuration: 300 } },
  },
  typescript: { strict: true },
});
