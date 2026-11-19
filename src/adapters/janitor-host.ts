// janitorai.com went on registrar hold on 2026-11-19 and stopped resolving;
// jani.com serves the same site and API paths. Links to either still import.
export const JANITOR_ORIGIN = "https://jani.com";
export const JANITOR_AVATARS = "https://janitorsunite.b-cdn.net/bot-avatars/";
export const isJanitorHost = (host: string) =>
  /(^|\.)(janitorai\.com|janitor\.ai|jani\.com)$/i.test(host);
