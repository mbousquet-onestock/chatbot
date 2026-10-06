/** L'extension est affichée dans une iframe du back-office / de la Store App OneStock : on n'autorise que ces origines. */
export default defineEventHandler((event) => {
  const ancestors =
    process.env.FRAME_ANCESTORS?.trim() ||
    "'self' https://*.onestock-retail.com https://*.onestock-retail.dev";
  setResponseHeader(event, "Content-Security-Policy", `frame-ancestors ${ancestors}`);
});
