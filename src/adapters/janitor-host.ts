// janitorai.com was on registrar hold from 2026-11-19 and jani.com served the
// site meanwhile; by 2026-11-26 jani.com redirects every page back here.
// Links to any of these hosts still import.
export const JANITOR_ORIGIN = "https://janitorai.com";
export const JANITOR_AVATARS = "https://janitorsunite.b-cdn.net/bot-avatars/";
export const isJanitorHost = (host: string) =>
  /(^|\.)(janitorai\.com|janitor\.ai|jani\.com)$/i.test(host);
