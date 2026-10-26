// Public `url` builtin. Node's real lib/url.js carries the whole legacy parser
// bound to native IDNA/ada. The browser already ships a spec-compliant global
// URL, so we forward the WHATWG surface and implement the legacy
// parse/format/resolve API that userland (parseurl, express, send, …) still
// relies on, in terms of URL where possible plus a manual fast path for the
// origin-relative request targets ("/foo?bar=1") HTTP servers actually see.

export default function (exports, require, module) {
  const internalUrl = require("internal/url");
  const URL = globalThis.URL;
  const URLSearchParams = globalThis.URLSearchParams;

  function parseQueryToObject(search) {
    const obj = {};
    if (!search) return obj;
    const sp = new URLSearchParams(search[0] === "?" ? search.slice(1) : search);
    for (const key of sp.keys()) {
      const all = sp.getAll(key);
      obj[key] = all.length > 1 ? all : all[0];
    }
    return obj;
  }

  function parseProtocolRelative(str, parseQueryString) {
    let u;
    let legacyFallback = false;
    try {
      u = new URL(str, "http://localhost");
    } catch {
      legacyFallback = true;
      // Node's legacy parser is intentionally more forgiving than WHATWG URL.
      // Keep enough of that behavior for Host-header consumers: take the valid
      // host prefix and leave malformed suffix bytes as a path instead of
      // throwing (for example `//bad host` and `//host:bad`).
      let authorityEnd = str.length;
      for (const delimiter of ["/", "?", "#"]) {
        const at = str.indexOf(delimiter, 2);
        if (at !== -1 && at < authorityEnd) authorityEnd = at;
      }
      let authority = str.slice(2, authorityEnd);
      let tail = str.slice(authorityEnd);
      let auth = null;
      const authAt = authority.lastIndexOf("@");
      if (authAt !== -1) {
        auth = authority.slice(0, authAt);
        authority = authority.slice(authAt + 1);
      }
      let hostname = "";
      let port = null;
      let malformed = "";
      if (authority.startsWith("[")) {
        const close = authority.indexOf("]");
        if (close === -1) {
          hostname = authority.slice(1);
        } else {
          hostname = authority.slice(1, close);
          const suffix = authority.slice(close + 1);
          if (/^:\d*$/.test(suffix)) port = suffix.slice(1) || null;
          else malformed = suffix;
        }
      } else {
        const match = authority.match(/^[^:\s%<>"`{}|\\^]*/);
        hostname = (match && match[0]) || "";
        const suffix = authority.slice(hostname.length);
        if (/^:\d*$/.test(suffix)) port = suffix.slice(1) || null;
        else malformed = suffix;
      }
      if (malformed) {
        tail = (malformed.startsWith(":") ? "/" : "") + malformed + tail;
      }
      const host = hostname ? (authority.startsWith("[") ? `[${hostname}]` : hostname) + (port ? `:${port}` : "") : "";
      const escapedTail = tail.replace(/ /g, "%20");
      const hashAt = escapedTail.indexOf("#");
      const withoutHash = hashAt === -1 ? escapedTail : escapedTail.slice(0, hashAt);
      const queryAt = withoutHash.indexOf("?");
      u = {
        username: auth ? auth.split(":")[0] : "",
        password: auth && auth.includes(":") ? auth.slice(auth.indexOf(":") + 1) : "",
        host,
        port: port || "",
        hostname,
        hash: hashAt === -1 ? "" : escapedTail.slice(hashAt),
        search: queryAt === -1 ? "" : withoutHash.slice(queryAt),
        pathname: queryAt === -1 ? withoutHash : withoutHash.slice(0, queryAt),
      };
    }

    const rawAfterAuthority = str.slice(2).replace(/^[^/?#]*/, "");
    const hashIdx = rawAfterAuthority.indexOf("#");
    const beforeHash = hashIdx === -1 ? rawAfterAuthority : rawAfterAuthority.slice(0, hashIdx);
    const hash = hashIdx === -1 ? (u.hash || null) : rawAfterAuthority.slice(hashIdx);
    const qIdx = beforeHash.indexOf("?");
    const rawPathname = legacyFallback ? u.pathname : qIdx === -1 ? beforeHash : beforeHash.slice(0, qIdx);
    const search = qIdx === -1 ? (u.search || null) : beforeHash.slice(qIdx);
    // A WHATWG URL invents "/" for a host-only URL; legacy url.parse does not.
    const pathname = rawPathname ? (u.pathname || rawPathname) : null;
    const query = parseQueryString ? parseQueryToObject(search) : search ? search.slice(1) : null;
    const hostname = String(u.hostname || "").replace(/^\[|\]$/g, "");
    return {
      protocol: null,
      slashes: true,
      auth: u.username ? `${u.username}${u.password ? ":" + u.password : ""}` : null,
      host: u.host || null,
      port: u.port || null,
      hostname: hostname || null,
      hash,
      search,
      query,
      pathname,
      path: `${pathname || ""}${search || ""}` || null,
      href: str,
    };
  }

  // Legacy url.parse — returns the Node "Url" shape. Handles origin-relative
  // targets manually (WHATWG URL rejects them without a base) and delegates
  // absolute URLs to the platform parser.
  function parse(urlStr, parseQueryString = false, slashesDenoteHost = false) {
    if (urlStr && typeof urlStr === "object") return urlStr;
    const str = String(urlStr);

    // Origin-relative (starts with '/') or bare path: no host/protocol.
    const isAbsolute = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(str) || (slashesDenoteHost && str.startsWith("//"));
    if (!isAbsolute) {
      let pathname = str;
      let search = null;
      let hash = null;
      const hashIdx = str.indexOf("#");
      if (hashIdx !== -1) { hash = str.slice(hashIdx); pathname = str.slice(0, hashIdx); }
      const qIdx = pathname.indexOf("?");
      if (qIdx !== -1) { search = pathname.slice(qIdx); pathname = pathname.slice(0, qIdx); }
      const query = parseQueryString ? parseQueryToObject(search) : search ? search.slice(1) : null;
      return {
        protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null,
        hash, search, query, pathname: pathname || null,
        path: `${pathname || ""}${search || ""}` || null,
        href: str,
      };
    }

    const protocolRelative = slashesDenoteHost && str.startsWith("//");
    // webpack-dev-server uses this exact shape to validate every Host header.
    if (protocolRelative) return parseProtocolRelative(str, parseQueryString);

    const u = new URL(str);
    const search = u.search || null;
    const query = parseQueryString ? parseQueryToObject(search) : search ? search.slice(1) : null;
    return {
      protocol: u.protocol,
      slashes: str.includes("//"),
      auth: u.username ? `${u.username}${u.password ? ":" + u.password : ""}` : null,
      host: u.host || null,
      port: u.port || null,
      hostname: u.hostname || null,
      hash: u.hash || null,
      search,
      query,
      pathname: u.pathname || null,
      path: `${u.pathname || ""}${search || ""}` || null,
      href: u.href,
    };
  }

  function format(urlObj) {
    if (typeof urlObj === "string") return urlObj;
    if (urlObj instanceof URL) return urlObj.href;
    if (urlObj && typeof urlObj.href === "string" && urlObj.protocol) return urlObj.href;

    let out = "";
    if (urlObj.protocol) out += urlObj.protocol.endsWith(":") ? urlObj.protocol : urlObj.protocol + ":";
    if (urlObj.slashes || urlObj.host || urlObj.hostname) out += "//";
    if (urlObj.auth) out += urlObj.auth + "@";
    if (urlObj.host) out += urlObj.host;
    else if (urlObj.hostname) out += urlObj.hostname + (urlObj.port ? ":" + urlObj.port : "");
    if (urlObj.pathname) out += urlObj.pathname;
    let search = urlObj.search;
    if (!search && urlObj.query) {
      search = typeof urlObj.query === "string" ? "?" + urlObj.query : "?" + new URLSearchParams(urlObj.query).toString();
    }
    if (search) out += search[0] === "?" ? search : "?" + search;
    if (urlObj.hash) out += urlObj.hash[0] === "#" ? urlObj.hash : "#" + urlObj.hash;
    return out;
  }

  function resolve(from, to) {
    try {
      return new URL(to, from).href;
    } catch {
      return to;
    }
  }

  module.exports = {
    parse,
    format,
    resolve,
    URL,
    URLSearchParams,
    domainToASCII: (d) => { try { return new URL("http://" + d).hostname; } catch { return ""; } },
    domainToUnicode: (d) => d,
    fileURLToPath: internalUrl.fileURLToPath,
    pathToFileURL: internalUrl.pathToFileURL,
    urlToHttpOptions: internalUrl.urlToHttpOptions,
    // Url/Url.prototype are intentionally omitted: parseurl treats an absent
    // `url.Url` as "use a plain object", which is exactly what we want.
  };
}
