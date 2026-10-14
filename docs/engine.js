/* Shared data-driven rules: same order and patterns as the Python server. */
(function (root) {
  function classify(message, rules) {
    for (const group of ['guards', 'issues', 'faq']) for (const [key, pattern] of rules[group]) {
      if (new RegExp(pattern, 'iu').test(message)) return {group, key};
    }
    return {group: '', key: ''};
  }
  function language(message, fallback) {
    if (/[іїєґ]|кімнат|будь ласка/iu.test(message)) return 'uk';
    if (/[а-яё]/iu.test(message)) return 'ru';
    if (/\b(wann|zimmer|bitte|ich|nicht|heizung|frühstück|mittagessen|auschecken|kalt|wlan|wasser|handtücher)\b/iu.test(message)) return 'de';
    if (/\b(when|what|room|cold|please|help|breakfast|lunch|checkout|broken|water|towels)\b/iu.test(message)) return 'en';
    return fallback;
  }
  function roomNumber(message) {
    const match = String(message ?? '').normalize('NFKC').match(/^\s*(?:(?:комната|комнате|номер|кімната|кімнаті|room|zimmer)\s*)?(?:№|No\.?)?\s*([\p{L}\d_-]{1,10})\s*[.!]?\s*$/iu);
    return match && /\d/.test(match[1]) ? match[1] : '';
  }
  function shortId(id) { return String(id).replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase(); }
  const api = {classify, language, roomNumber, shortId};
  if (typeof module !== 'undefined') module.exports = api;
  else root.HotelEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
